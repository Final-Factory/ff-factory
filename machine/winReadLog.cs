// The worker read log's Windows helper (w6599, machine/readLog.ts; lothsahn: "Keep today's fence and add read logging only"):
// a real-time ETW session on Windows' own Kernel-Process and Kernel-File providers. It follows the processes the daemon's agent
// hosts start, and says which files those processes open outside the allowed folders: the path and the opening program,
// nothing else (never a file's contents). It blocks nothing and changes no file, label or ACL.
//
//   ffreadlog.exe <session name>          run: stdin and stdout below
//   ffreadlog.exe <session name> stop     stop a session of that name a helper before this one left behind, then exit
//
// stdin: "allow <folder>" (one per line, before or after "roots": a path at or under it is not reported), "exact <path>" (that
// path alone, such as a drive's root), "work <folder>", "roots <pid>:<started ms>..." (the agent hosts now, each with the start
// time its host record gives: the whole set each time; their descendants are followed, the hosts' own opens are not reported).
// "--selftest" instead of a session name runs the pid rules against a made-up process table. EOF (the
// daemon is gone) stops the session and ends the helper.
// stdout, one JSON object a line: {"event":"ready"}, {"event":"error","why":"..."} (then it exits 1),
// {"event":"read","root":R,"rootAt":MS,"pid":P,"image":"C:\\...\\x.exe","path":"C:\\..."} (each root, program and path once an hour, at most
// MAX_PER_MINUTE a minute), {"event":"root-refused","root":"R","why":"..."} (once an hour) and each minute {"event":"stat","fileEvents":N,"procEvents":N,"tracked":N,"reported":N,"dropped":N,
// "lost":N}.
//
// Starting a session needs Administrators or Performance Log Users (the daemon runs at Medium, as a member of one of them), never
// a Low worker. 64-bit only.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class FfReadLog
{
    const uint WNODE_FLAG_TRACED_GUID = 0x00020000;
    const uint EVENT_TRACE_REAL_TIME_MODE = 0x00000100;
    const uint PROCESS_TRACE_MODE_REAL_TIME = 0x00000100;
    const uint PROCESS_TRACE_MODE_EVENT_RECORD = 0x10000000;
    const uint EVENT_TRACE_CONTROL_QUERY = 0;
    const uint EVENT_TRACE_CONTROL_STOP = 1;
    const uint EVENT_CONTROL_CODE_ENABLE_PROVIDER = 1;
    const uint ERROR_ALREADY_EXISTS = 183;
    const ulong INVALID_TRACE = 0xFFFFFFFFFFFFFFFF;
    const int MAX_PER_MINUTE = 600;
    const int MAX_WAITING = 64; // events one gone process may hold waiting for its stop
    const int SEEN_CAP = 200000;

    static readonly Guid KernelProcess = new Guid("22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716");
    static readonly Guid KernelFile = new Guid("edd08927-9cc4-4e65-b970-c2560fb5c289");

    [StructLayout(LayoutKind.Sequential)]
    struct Properties
    {
        public uint WnodeBufferSize; public uint WnodeProviderId; public ulong WnodeHistoricalContext; public long WnodeTimeStamp;
        public Guid WnodeGuid; public uint WnodeClientContext; public uint WnodeFlags;
        public uint BufferSize, MinimumBuffers, MaximumBuffers, MaximumFileSize, LogFileMode, FlushTimer, EnableFlags;
        public int AgeLimit;
        public uint NumberOfBuffers, FreeBuffers, EventsLost, BuffersWritten, LogBuffersLost, RealTimeBuffersLost;
        public IntPtr LoggerThreadId; public uint LogFileNameOffset, LoggerNameOffset;
    }

    delegate void RecordCallback(IntPtr record);

    // EVENT_TRACE_LOGFILEW on x64: EVENT_TRACE is 88 bytes and TRACE_LOGFILE_HEADER 280, so the callback sits at 424 (448 in all).
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Logfile
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string LogFileName;
        [MarshalAs(UnmanagedType.LPWStr)] public string LoggerName;
        public long CurrentTime; public uint BuffersRead; public uint ProcessTraceMode;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 88)] public byte[] CurrentEvent;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 280)] public byte[] LogfileHeader;
        public IntPtr BufferCallback; public uint BufferSize, Filled, EventsLost;
        public RecordCallback EventRecordCallback;
        public uint IsKernelTrace; public IntPtr Context;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyDescriptor { public IntPtr PropertyName; public uint ArrayIndex; public uint Reserved; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint StartTraceW(out ulong handle, string name, IntPtr props);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint ControlTraceW(ulong handle, string name, IntPtr props, uint code);
    [DllImport("advapi32.dll")] static extern uint EnableTraceEx2(ulong handle, ref Guid provider, uint code, byte level, ulong any, ulong all, uint timeout, IntPtr parameters);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ulong OpenTraceW(ref Logfile logfile);
    [DllImport("advapi32.dll")] static extern uint ProcessTrace(ulong[] handles, uint count, IntPtr start, IntPtr end);
    [DllImport("advapi32.dll")] static extern uint CloseTrace(ulong handle);
    [DllImport("tdh.dll")] static extern uint TdhGetPropertySize(IntPtr record, uint contexts, IntPtr context, uint count, ref PropertyDescriptor desc, out uint size);
    [DllImport("tdh.dll")] static extern uint TdhGetProperty(IntPtr record, uint contexts, IntPtr context, uint count, ref PropertyDescriptor desc, uint size, IntPtr buffer);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint QueryDosDeviceW(string device, StringBuilder target, int max);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr proc, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int ret);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint n);

    // A followed process, known by its pid AND its creation time (w6723, w6728): Windows hands a dead process's pid out again,
    // and a process keeps naming its dead parent's pid, so a pid alone never says whose a process is.
    sealed class Entry
    {
        public uint Root;    // its agent host's pid (a root's own entry: itself), or 0 for a worker's orphan
        public long RootAt;  // the start time (Unix ms) the daemon gave with that root, so the daemon names the right session
        public long Start;   // its creation time (FILETIME ticks), never 0: a process whose start cannot be read is not followed
        public string Image;
        // The span of the session's clock (event timestamps) in which an event with its pid is its own: From its start event (or
        // the moment it was found running), to Exit, its stop event's timestamp (0 until its own stop is seen).
        public long From, Exit;
        // events seen after its process had gone but before its stop: each runs only if stamped before that stop (w6599 CI: the
        // session delivers about a second late, so a short tool has always gone by the time its opens are handled)
        public readonly List<KeyValuePair<long, Action>> Waiting = new List<KeyValuePair<long, Action>>();
        public bool Swept;   // the minute check found it gone once already
    }

    static readonly object Gate = new object();
    static readonly object OutGate = new object();
    static readonly Dictionary<uint, Entry> Tracked = new Dictionary<uint, Entry>();
    static readonly HashSet<uint> Roots = new HashSet<uint>();
    static readonly List<string> Allow = new List<string>();
    static readonly HashSet<string> AllowExact = new HashSet<string>();
    static readonly HashSet<string> Seen = new HashSet<string>();
    // the work folder (`work <folder>`): an orphaned Low process running a program from it is a worker's
    static string Work = "";
    // Low processes found to be no worker's (a person's browser, chat or game launcher), by pid and creation time, so their
    // memory is not read again; a later process given the pid is looked at afresh
    static readonly Dictionary<uint, long> NotWorker = new Dictionary<uint, long>();
    static readonly HashSet<string> RefusedRoots = new HashSet<string>();
    static List<KeyValuePair<string, string>> devices = new List<KeyValuePair<string, string>>();
    static long fileEvents, procEvents, reported, dropped;
    static int thisMinute;
    static RecordCallback keep; // the delegate ProcessTrace calls, kept from the collector
    static readonly IntPtr NameFileName = Marshal.StringToHGlobalUni("FileName");
    static readonly IntPtr NameProcessId = Marshal.StringToHGlobalUni("ProcessID");
    static readonly IntPtr NameParentId = Marshal.StringToHGlobalUni("ParentProcessID");
    static readonly IntPtr NameCreateTime = Marshal.StringToHGlobalUni("CreateTime");
    static readonly IntPtr NameImage = Marshal.StringToHGlobalUni("ImageName");

    // What the helper asks Windows, as functions the self-test (--selftest) replaces with a made-up process table.
    static Func<uint, long> StartOfFn = StartOf;
    static Func<uint, bool> IsLowFn = IsLow;
    static Func<uint, string> ImageOfFn = ImageOf;
    static Func<uint, string, bool> IsWorkersFn = IsWorkers;
    static Func<List<KeyValuePair<uint, uint>>> SnapshotFn = Snapshot;
    static Func<long> LostFn = () => 0;
    // the session's clock now: ProcessTrace gives event timestamps as system time (FILETIME ticks), no RAW_TIMESTAMP asked
    static Func<long> NowFn = () => DateTime.UtcNow.ToFileTimeUtc();
    // the self-test's hook between a process's last check outside the lock and its insert (a stop event handled meanwhile)
    static Action<uint> GapFn;
    static List<string> Captured; // the self-test's stdout

    static int Main(string[] args)
    {
        if (args.Length < 1) { Say("{\"event\":\"error\",\"why\":\"usage: ffreadlog <session name> [stop] | --selftest\"}"); return 1; }
        if (args[0] == "--selftest") return SelfTest();
        string name = args[0];
        if (args.Length > 1 && args[1] == "stop") { Stop(name); return 0; }
        if (IntPtr.Size != 8) { Say("{\"event\":\"error\",\"why\":\"64-bit only\"}"); return 1; }
        Devices();

        ulong session;
        IntPtr props = NewProperties(name);
        uint rc = StartTraceW(out session, name, props);
        if (rc == ERROR_ALREADY_EXISTS)
        {
            // a helper before this one died and left its session: stopped, then started again
            Stop(name);
            Marshal.FreeHGlobal(props);
            props = NewProperties(name);
            rc = StartTraceW(out session, name, props);
        }
        if (rc != 0) { Say("{\"event\":\"error\",\"why\":\"StartTrace failed: " + Why(rc) + "\"}"); return 1; }
        Guid kp = KernelProcess, kf = KernelFile;
        // Kernel-Process WINEVENT_KEYWORD_PROCESS (0x10): process start and stop. Kernel-File KERNEL_FILE_KEYWORD_CREATE (0x80):
        // event 12, Create, with the path opened. Both at level 4 (Informational), as the providers' manifests give them.
        rc = EnableTraceEx2(session, ref kp, EVENT_CONTROL_CODE_ENABLE_PROVIDER, 4, 0x10, 0, 0, IntPtr.Zero);
        if (rc == 0) rc = EnableTraceEx2(session, ref kf, EVENT_CONTROL_CODE_ENABLE_PROVIDER, 4, 0x80, 0, 0, IntPtr.Zero);
        if (rc != 0) { ControlTraceW(session, null, props, EVENT_TRACE_CONTROL_STOP); Say("{\"event\":\"error\",\"why\":\"EnableTraceEx2 failed: " + Why(rc) + "\"}"); return 1; }

        // the session's lost events and buffers so far, for the minute's stat line
        IntPtr query = NewProperties(name);
        object queryGate = new object();
        LostFn = () =>
        {
            lock (queryGate)
            {
                if (ControlTraceW(session, null, query, EVENT_TRACE_CONTROL_QUERY) != 0) return -1;
                Properties q = (Properties)Marshal.PtrToStructure(query, typeof(Properties));
                return (long)q.EventsLost + q.RealTimeBuffersLost;
            }
        };

        keep = OnRecord;
        Logfile lf = new Logfile { LoggerName = name, ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD, CurrentEvent = new byte[88], LogfileHeader = new byte[280], EventRecordCallback = keep };
        ulong trace = OpenTraceW(ref lf);
        if (trace == INVALID_TRACE) { int e = Marshal.GetLastWin32Error(); ControlTraceW(session, null, props, EVENT_TRACE_CONTROL_STOP); Say("{\"event\":\"error\",\"why\":\"OpenTrace failed: " + e + "\"}"); return 1; }
        Thread collector = new Thread(() => ProcessTrace(new[] { trace }, 1, IntPtr.Zero, IntPtr.Zero)) { IsBackground = true };
        collector.Start();
        Say("{\"event\":\"ready\"}");

        long lostBefore = 0;
        Timer minute = new Timer(_ =>
        {
            long lost = Math.Max(0, LostFn());
            // w6728: every minute, each followed pid is checked against its process (one OpenProcess each), so an entry whose
            // stop event ETW lost is gone within a minute, before its pid can be taken for a person's process for long
            DropStale();
            int tracked;
            lock (Gate) { tracked = Tracked.Count; thisMinute = 0; }
            Say("{\"event\":\"stat\",\"fileEvents\":" + Interlocked.Exchange(ref fileEvents, 0) + ",\"procEvents\":" + Interlocked.Exchange(ref procEvents, 0) + ",\"tracked\":" + tracked + ",\"reported\":" + Interlocked.Exchange(ref reported, 0) + ",\"dropped\":" + Interlocked.Exchange(ref dropped, 0) + ",\"lost\":" + (lost - lostBefore) + "}");
            lostBefore = lost;
        }, null, 60000, 60000);
        // what was reported is reported again an hour later, so a long run still shows its reads
        Timer hourly = new Timer(_ => { lock (Gate) { Seen.Clear(); NotWorker.Clear(); RefusedRoots.Clear(); } Devices(); }, null, 3600000, 3600000);

        string line;
        while ((line = Console.In.ReadLine()) != null) Command(line);
        minute.Dispose();
        hourly.Dispose();
        ControlTraceW(session, null, props, EVENT_TRACE_CONTROL_STOP);
        CloseTrace(trace);
        return 0;
    }

    static void Command(string line)
    {
        line = line.Trim();
        if (line.StartsWith("allow "))
        {
            string p = Norm(line.Substring(6).Trim());
            if (p.Length > 0) lock (Gate) Allow.Add(p.TrimEnd('\\'));
        }
        else if (line.StartsWith("work "))
        {
            string p = Norm(line.Substring(5).Trim()).TrimEnd('\\');
            lock (Gate) Work = p;
        }
        else if (line.StartsWith("exact "))
        {
            string p = Norm(line.Substring(6).Trim());
            if (p.Length > 0) lock (Gate) AllowExact.Add(p);
        }
        else if (line.StartsWith("roots")) SetRoots(line.Substring(5));
    }

    static IntPtr NewProperties(string name)
    {
        int size = Marshal.SizeOf(typeof(Properties));
        int total = size + (name.Length + 1) * 2 + 2;
        IntPtr p = Marshal.AllocHGlobal(total);
        for (int i = 0; i < total; i++) Marshal.WriteByte(p, i, 0);
        Properties v = new Properties
        {
            WnodeBufferSize = (uint)total, WnodeClientContext = 1, WnodeFlags = WNODE_FLAG_TRACED_GUID,
            // 64 KB buffers, 8 to 64 of them (at most 4 MB of the kernel's memory), flushed each second
            BufferSize = 64, MinimumBuffers = 8, MaximumBuffers = 64, LogFileMode = EVENT_TRACE_REAL_TIME_MODE, FlushTimer = 1,
            LoggerNameOffset = (uint)size,
        };
        Marshal.StructureToPtr(v, p, false);
        return p;
    }

    static void Stop(string name)
    {
        IntPtr p = NewProperties(name);
        ControlTraceW(0, name, p, EVENT_TRACE_CONTROL_STOP);
        Marshal.FreeHGlobal(p);
    }

    static string Why(uint rc)
    {
        return rc == 5 ? "access denied (5): the daemon's account is in neither Administrators nor Performance Log Users, or runs below Medium" : rc.ToString();
    }

    // EVENT_RECORD: EVENT_HEADER (80 bytes: ProcessId at 12, TimeStamp at 16, ProviderId at 24, EventDescriptor.Id at 40), then
    // UserData at 96.
    // FFREADLOG_TRACE=<text>: each decision about a followed pid, and opens by other pids of paths containing <text>, as trace
    // lines (the real-ETW CI test's evidence when it sees nothing). Unset in the daemon.
    static readonly string TraceFilter = Environment.GetEnvironmentVariable("FFREADLOG_TRACE");
    static void Tr(string s) { if (!string.IsNullOrEmpty(TraceFilter)) Say("{\"event\":\"trace\",\"msg\":\"" + Esc(s) + "\"}"); }

    static void OnRecord(IntPtr rec)
    {
        try
        {
            uint pid = (uint)Marshal.ReadInt32(rec, 12);
            long ts = Marshal.ReadInt64(rec, 16);
            int id = (ushort)Marshal.ReadInt16(rec, 40);
            byte[] g = new byte[16];
            Marshal.Copy(rec + 24, g, 0, 16);
            Guid provider = new Guid(g);
            if (provider == KernelFile)
            {
                if (id != 12) return;
                Interlocked.Increment(ref fileEvents);
                lock (Gate)
                {
                    Entry e;
                    if (!Tracked.TryGetValue(pid, out e) || e.Root == pid)
                    {
                        if (!string.IsNullOrEmpty(TraceFilter) && e == null) { string p = Text(rec, NameFileName); if (p != null && p.Contains(TraceFilter)) Tr("open by unfollowed pid " + pid + " ts " + ts + ": " + p); }
                        return;
                    }
                }
                string path = Dos(Text(rec, NameFileName));
                if (path != null) OnOpen(pid, path, ts);
            }
            else if (provider == KernelProcess)
            {
                Interlocked.Increment(ref procEvents);
                if (id == 1)
                {
                    uint parent = Number(rec, NameParentId);
                    lock (Gate) if (!Tracked.ContainsKey(parent)) return;
                    Tr("start of " + Number(rec, NameProcessId) + " by " + parent + " created " + Long(rec, NameCreateTime) + " ts " + ts);
                    OnStart(Number(rec, NameProcessId), parent, Long(rec, NameCreateTime), Dos(Text(rec, NameImage)) ?? Text(rec, NameImage) ?? "", ts);
                }
                else if (id == 2)
                {
                    uint gone = Number(rec, NameProcessId);
                    lock (Gate) if (!Tracked.ContainsKey(gone)) return;
                    Tr("stop of " + gone + " created " + Long(rec, NameCreateTime) + " ts " + ts);
                    OnStop(gone, Long(rec, NameCreateTime), ts);
                }
            }
        }
        catch
        {
            // one event the helper cannot read is skipped, never the session
        }
    }

    // Run act for an event of pid stamped ts only if that event is e's own (w6723, w6728, w6734: Windows hands a dead process's
    // pid out again, ETW may lose a stop event, count a loss late, or deliver its per-CPU buffers out of order). Its own means
    // stamped within e's span: after From, and before Exit once e's own stop is seen. Before that stop, a running process that
    // started when e says holds the pid now, so the event is e's. A pid with no running process (or another one) is never
    // trusted on its own: the event waits for e's stop and runs only if stamped before it; with no such stop (lost, or the pid's
    // later holder's stop came instead) it never runs.
    static void When(uint pid, Entry e, long ts, Action act)
    {
        bool live = StartOfFn(pid) == e.Start;
        Tr("when pid " + pid + " ts " + ts + " from " + e.From + " exit " + e.Exit + " start " + e.Start + " live " + live + " waiting " + e.Waiting.Count);
        lock (Gate)
        {
            if (ts < e.From) return;
            if (e.Exit != 0) { if (ts > e.Exit) return; }
            else if (!live)
            {
                Entry t;
                if (Tracked.TryGetValue(pid, out t) && t == e && e.Waiting.Count < MAX_WAITING) e.Waiting.Add(new KeyValuePair<long, Action>(ts, act));
                return;
            }
        }
        act();
    }

    // A followed process started a child: followed too, if its start event is its parent's own (When) and the child started at
    // or after the parent. w6734 B4: the child's creation time comes from the event only; the live process on its pid may be a
    // later holder's, so a start event without one is not followed.
    static void OnStart(uint child, uint parent, long created, string image, long ts)
    {
        Entry p;
        lock (Gate) if (!Tracked.TryGetValue(parent, out p)) return;
        if (created == 0 || created < p.Start) return;
        When(parent, p, ts, () =>
        {
            Entry c = new Entry { Root = p.Root, RootAt = p.RootAt, Start = created, Image = image, From = ts };
            // a start that waited for its parent's stop does not replace a later holder of the child's pid
            lock (Gate) { Entry old; if (!Tracked.TryGetValue(child, out old) || old.From <= ts) Tracked[child] = c; }
        });
    }

    // A followed pid's stop. Its creation time says whose: the followed process's own stop closes its span, and the events that
    // waited run if stamped before it; a stop of another process on the pid (its stop lost, the pid given out again) drops the
    // entry and what waited. A root that exits is dropped from the roots at once, and is taken back only for a process that
    // started when its host did.
    static void OnStop(uint gone, long created, long ts)
    {
        List<KeyValuePair<long, Action>> run = new List<KeyValuePair<long, Action>>();
        lock (Gate)
        {
            Entry e;
            Roots.Remove(gone);
            if (!Tracked.TryGetValue(gone, out e)) return;
            Tr("stop: entry start " + e.Start + " from " + e.From + " waiting " + e.Waiting.Count);
            if (created == 0 || created != e.Start || ts < e.From) { Tracked.Remove(gone); e.Waiting.Clear(); return; }
            e.Exit = ts;
            foreach (KeyValuePair<long, Action> w in e.Waiting) if (w.Key <= ts) run.Add(w);
            e.Waiting.Clear();
        }
        foreach (KeyValuePair<long, Action> w in run) w.Value();
    }

    static void OnOpen(uint pid, string path, long ts)
    {
        string norm = Norm(path);
        Entry e;
        string key;
        lock (Gate)
        {
            if (!Tracked.TryGetValue(pid, out e) || e.Root == pid) return;
            if (AllowExact.Contains(norm) || AllowExact.Contains(norm.TrimEnd('\\'))) return;
            foreach (string a in Allow)
                if (norm == a || (norm.Length > a.Length && norm.StartsWith(a) && norm[a.Length] == '\\')) return;
            key = e.Root + "|" + e.Image + "|" + norm;
            if (Seen.Contains(key)) return;
            if (thisMinute >= MAX_PER_MINUTE) { Interlocked.Increment(ref dropped); return; }
        }
        // checked to be its process's own before anything is said (w6728): at most a few hundred opens a minute get this far
        When(pid, e, ts, () =>
        {
            lock (Gate)
            {
                if (Seen.Contains(key)) return;
                if (thisMinute >= MAX_PER_MINUTE) { Interlocked.Increment(ref dropped); return; }
                if (Seen.Count >= SEEN_CAP) Seen.Clear();
                Seen.Add(key);
                thisMinute++;
            }
            Interlocked.Increment(ref reported);
            Say("{\"event\":\"read\",\"root\":" + e.Root + ",\"rootAt\":" + e.RootAt + ",\"pid\":" + pid + ",\"image\":\"" + Esc(e.Image) + "\",\"path\":\"" + Esc(path) + "\"}");
        });
    }

    // FILETIME ticks to Unix milliseconds.
    static long UnixMs(long filetime) { return (filetime - 116444736000000000L) / 10000; }

    // `roots <pid>:<started ms> ...`: the agent hosts now, each with the time its host record says it started (w6728 N1). A pid
    // is taken as a host only when its process started within the daemon's own window of that time (machine/hostWatch.ts
    // sameHost: 90 s before to 5 s after), so a host that died, its pid since given to a person's program, is never named. A
    // root the daemon no longer names is dropped; its descendants stay followed (workers' orphans are what the log is for, and
    // each is checked by its own creation time), until they exit.
    static void SetRoots(string list)
    {
        Dictionary<uint, long> now = new Dictionary<uint, long>();
        foreach (string s in list.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string[] kv = s.Split(':');
            uint pid; long at;
            if (kv.Length == 2 && uint.TryParse(kv[0], out pid) && long.TryParse(kv[1], out at)) now[pid] = at;
            else if (RefusedRoots.Add(s)) Say("{\"event\":\"root-refused\",\"root\":\"" + Esc(s) + "\",\"why\":\"no start time given\"}");
        }
        List<uint> fresh = new List<uint>();
        Dictionary<uint, long> starts = new Dictionary<uint, long>();
        Dictionary<uint, long> given = new Dictionary<uint, long>();
        foreach (KeyValuePair<uint, long> r in now)
        {
            long st = StartOfFn(r.Key);
            long ms = UnixMs(st);
            if (st != 0 && ms <= r.Value + 5000 && ms >= r.Value - 90000) { starts[r.Key] = st; given[r.Key] = r.Value; }
            else if (RefusedRoots.Add(r.Key + ":" + r.Value)) Say("{\"event\":\"root-refused\",\"root\":\"" + r.Key + "\",\"why\":\"" + (st == 0 ? "no such process" : "its process started at another time than its host") + "\"}");
        }
        if (GapFn != null) foreach (uint r in starts.Keys) GapFn(r);
        lock (Gate)
        {
            foreach (uint r in new List<uint>(Roots))
            {
                Entry e;
                if (starts.ContainsKey(r) && Tracked.TryGetValue(r, out e) && e.Start == starts[r]) continue;
                Roots.Remove(r);
                if (Tracked.TryGetValue(r, out e) && e.Root == r) Tracked.Remove(r);
            }
            foreach (KeyValuePair<uint, long> r in starts)
            {
                // checked again under the lock (w6734 B2): a host whose stop was handled since its check above is not inserted,
                // where no stop event would ever remove it
                if (Roots.Contains(r.Key) || StartOfFn(r.Key) != r.Value) continue;
                Roots.Add(r.Key);
                Tracked[r.Key] = new Entry { Root = r.Key, RootAt = given[r.Key], Start = r.Value, Image = "", From = NowFn() };
                fresh.Add(r.Key);
                Tr("root " + r.Key + " start " + r.Value + " from " + Tracked[r.Key].From);
            }
        }
        if (fresh.Count > 0) Seed(fresh);
    }

    static List<KeyValuePair<uint, uint>> Snapshot()
    {
        List<KeyValuePair<uint, uint>> l = new List<KeyValuePair<uint, uint>>();
        IntPtr snap = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if (snap == new IntPtr(-1)) return l;
        ProcessEntry e = new ProcessEntry { dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
        for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
            if (e.th32ProcessID != e.th32ParentProcessID) l.Add(new KeyValuePair<uint, uint>(e.th32ProcessID, e.th32ParentProcessID));
        CloseHandle(snap);
        return l;
    }

    // A root's descendants that already run when it is named (those it starts later come from Kernel-Process). Then each other
    // Low process that is a worker's (root 0, "a Low worker process"): a worker's tool whose shell exited has no living parent to
    // be found by, as after a daemon restart, when the hosts and their agents run on. Low alone is not a worker: a person's
    // Firefox, Slack, Discord, Spotify and Steam run Low processes too (w6715's review, on BEAST). So one counts only when its
    // environment carries FF_SESSION_ID (every process a worker starts inherits it; machine/leftovers.ts reads it the same way)
    // or it runs a program from the work folder (a Git Bash tool under <root>/tools shows no environment, w1575).
    static void Seed(List<uint> roots)
    {
        Dictionary<uint, List<uint>> children = new Dictionary<uint, List<uint>>();
        HashSet<uint> all = new HashSet<uint>();
        foreach (KeyValuePair<uint, uint> pc in SnapshotFn())
        {
            List<uint> l;
            if (!children.TryGetValue(pc.Value, out l)) children[pc.Value] = l = new List<uint>();
            l.Add(pc.Key);
            all.Add(pc.Key);
        }
        foreach (uint root in roots)
        {
            Queue<uint> q = new Queue<uint>();
            q.Enqueue(root);
            int guard = 0;
            while (q.Count > 0 && guard++ < 10000)
            {
                uint p = q.Dequeue();
                List<uint> l;
                Entry pe;
                if (!children.TryGetValue(p, out l)) continue;
                lock (Gate) if (!Tracked.TryGetValue(p, out pe)) continue;
                // the parent must still be the process followed: a child that names a pid whose holder changed is no child of it
                if (StartOfFn(p) != pe.Start) continue;
                foreach (uint c in l)
                {
                    // w6723: toolhelp keeps a dead parent's pid, and Windows hands that pid out again: a process that started
                    // before its named parent is an orphan of an earlier holder of the pid (a person's Slack, Discord or
                    // Firefox whose updater exited), never this root's
                    long cs = StartOfFn(c);
                    if (cs == 0 || cs < pe.Start) continue;
                    string image = ImageOfFn(c);
                    if (GapFn != null) GapFn(c);
                    lock (Gate)
                    {
                        // checked again under the lock (w6734 B2), as each insert below
                        if (Tracked.ContainsKey(c) || StartOfFn(c) != cs) continue;
                        Tracked[c] = new Entry { Root = pe.Root, RootAt = pe.RootAt, Start = cs, Image = image, From = NowFn() };
                    }
                    q.Enqueue(c);
                }
            }
        }
        foreach (uint pid in all)
        {
            long ns;
            lock (Gate) if (Tracked.ContainsKey(pid)) continue;
            // w6728 N4: the creation time first, and again after the checks, so a pid given out again between them is not taken
            long s1 = StartOfFn(pid);
            if (s1 == 0) continue;
            lock (Gate) if (NotWorker.TryGetValue(pid, out ns) && ns == s1) continue;
            if (!IsLowFn(pid)) continue;
            string image = ImageOfFn(pid);
            bool worker = IsWorkersFn(pid, image);
            if (GapFn != null) GapFn(pid);
            if (!worker)
            {
                if (StartOfFn(pid) == s1) lock (Gate) NotWorker[pid] = s1;
                continue;
            }
            lock (Gate)
            {
                if (Tracked.ContainsKey(pid) || StartOfFn(pid) != s1) continue;
                Tracked[pid] = new Entry { Root = 0, Start = s1, Image = image, From = NowFn() };
            }
        }
    }

    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    // A running process's creation time (FILETIME ticks), or 0 when it is gone, has exited (a process another program still
    // holds a handle to opens after its exit) or cannot be opened.
    static long StartOf(uint pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return 0;
        try
        {
            long c, x, k, u;
            uint code;
            if (!GetExitCodeProcess(h, out code) || code != 259) return 0; // STILL_ACTIVE
            return GetProcessTimes(h, out c, out x, out k, out u) ? c : 0;
        }
        finally { CloseHandle(h); }
    }

    // Each minute: a followed pid whose process is gone, or whose pid now names another process (a stop event ETW lost), is
    // dropped with what waited for its stop, at the second check that finds it so (its stop and late events may still be on
    // their way at the first).
    static void DropStale()
    {
        List<KeyValuePair<uint, Entry>> all;
        lock (Gate) all = new List<KeyValuePair<uint, Entry>>(Tracked);
        foreach (KeyValuePair<uint, Entry> t in all)
        {
            if (t.Value.Exit == 0 && StartOfFn(t.Key) == t.Value.Start) continue;
            lock (Gate)
            {
                Entry e;
                if (!Tracked.TryGetValue(t.Key, out e) || e != t.Value) continue;
                if (!e.Swept) { e.Swept = true; continue; }
                Tracked.Remove(t.Key);
                Roots.Remove(t.Key);
                e.Waiting.Clear();
            }
        }
    }

    static long Long(IntPtr rec, IntPtr name)
    {
        PropertyDescriptor d = new PropertyDescriptor { PropertyName = name, ArrayIndex = 0xFFFFFFFF };
        uint size;
        if (TdhGetPropertySize(rec, 0, IntPtr.Zero, 1, ref d, out size) != 0 || size < 8) return 0;
        IntPtr buf = Marshal.AllocHGlobal((int)size);
        try { return TdhGetProperty(rec, 0, IntPtr.Zero, 1, ref d, size, buf) == 0 ? Marshal.ReadInt64(buf) : 0; }
        finally { Marshal.FreeHGlobal(buf); }
    }

    // --selftest: the pid rules above against a made-up process table, with no ETW session (any account may run it; the Windows
    // CI job does, server/readLog.test.ts). Prints "selftest: N passed" or each failure, and exits 0 or 1.
    static int SelfTest()
    {
        Dictionary<uint, long> start = new Dictionary<uint, long>();   // pid -> creation time of its process now
        Dictionary<uint, uint> parent = new Dictionary<uint, uint>();  // pid -> the parent pid it names
        HashSet<uint> low = new HashSet<uint>();
        HashSet<uint> marked = new HashSet<uint>();                     // FF_SESSION_ID in its environment
        const long T = 133000000000000000L;                             // a FILETIME in 2022
        long clock = T;                                                 // the session's clock: entries found running start at it
        StartOfFn = p => { long s; return start.TryGetValue(p, out s) ? s : 0; };
        IsLowFn = p => low.Contains(p);
        ImageOfFn = p => "C:\\apps\\p" + p + ".exe";
        IsWorkersFn = (p, image) => marked.Contains(p);
        SnapshotFn = () => { List<KeyValuePair<uint, uint>> l = new List<KeyValuePair<uint, uint>>(); foreach (KeyValuePair<uint, uint> x in parent) if (start.ContainsKey(x.Key)) l.Add(x); return l; };
        NowFn = () => clock;
        Func<long> tick = () => clock += 10;                            // the next event's timestamp
        Captured = new List<string>();
        Action<uint, uint, long> run = (p, par, s) => { start[p] = s; parent[p] = par; };
        Action<uint> exit = p => { start.Remove(p); };
        Func<long, long> ms = ft => UnixMs(ft);
        List<string> fails = new List<string>();
        int passed = 0;
        Action<bool, string> check = (ok, what) => { if (ok) passed++; else fails.Add(what); };
        Func<string, bool> said = s => Captured.Exists(l => l.Contains(s));
        Command("allow c:\\ffw");
        Command("work c:\\ffw");

        // a host (100) and its worker child (200): the child's read outside the allowlist is reported, its read inside is not
        run(100, 4, T);
        run(200, 100, T + 10);
        Command("roots 100:" + ms(T));
        check(Tracked.ContainsKey(200), "a host's running child is followed at seed");
        OnOpen(200, "C:\\Users\\me\\a.txt", tick());
        OnOpen(200, "C:\\ffw\\x\\b.txt", tick());
        check(said("C:\\\\Users\\\\me\\\\a.txt") && !said("b.txt"), "a worker's read outside is reported, inside is not");
        check(said("\"root\":100,\"rootAt\":" + ms(T) + ","), "a read names its host by pid and start time");

        // B1: 200's stop event is lost, and Windows gives pid 200 to a person's app (started later, Low, no FF_SESSION_ID)
        exit(200);
        run(200, 4, T + 500);
        low.Add(200);
        OnOpen(200, "C:\\Users\\me\\secret.txt", tick());
        check(!said("secret.txt"), "a person's process holding a lost worker's pid is not reported");
        // and the app's child is not followed through the old entry either
        OnStart(201, 200, T + 600, "C:\\apps\\child.exe", tick());
        check(!Tracked.ContainsKey(201), "a person's child, started under a reused pid, is not followed");
        // the app's own stop (another creation time) drops the stale entry and what waited for a stop
        exit(200);
        OnStop(200, T + 500, tick());
        check(!said("secret.txt") && !Tracked.ContainsKey(201) && !Tracked.ContainsKey(200), "a reused pid's stop drops the stale entry and vouches for nothing");
        // and the minute check drops a stale entry nobody touched, at its second look
        run(200, 4, T + 550);
        Tracked[200] = new Entry { Root = 100, Start = T + 10, Image = "x", From = clock };
        DropStale();
        check(Tracked.ContainsKey(200), "the minute check keeps a gone entry at its first look (its stop may be on its way)");
        DropStale();
        check(!Tracked.ContainsKey(200), "the minute check drops an entry whose pid holds another process");
        exit(200);

        // w6599 CI: a worker's short tool (210) opens a file and exits before the open is handled (the session delivers about a
        // second late); its own stop, stamped after the open, lets the open through
        run(210, 100, T + 650);
        OnStart(210, 100, T + 650, "C:\\Windows\\System32\\cmd.exe", tick());
        long open210 = tick();
        exit(210);
        OnOpen(210, "C:\\Users\\me\\short.txt", open210);
        check(!said("short.txt"), "an exited tool's open waits for its stop");
        OnStop(210, T + 650, tick());
        check(said("short.txt"), "an exited tool's open is reported at its own stop, stamped after it");
        // B3: the buffers out of order, the stop handled before a late open: an open stamped before the stop is the tool's...
        OnOpen(210, "C:\\Users\\me\\late.txt", open210);
        check(said("late.txt"), "B3: an open handled after its process's stop but stamped before it is reported");
        // ...and one stamped after it is the pid's next holder's
        OnOpen(210, "C:\\Users\\me\\next.txt", tick());
        check(!said("next.txt"), "B3: an open stamped after the followed process's stop is not reported");
        // w6736 G4: a person's open, stamped before a worker's tool took its pid, is handled after the tool's start (another
        // CPU's buffer): not the tool's
        long personOpen = tick();
        run(230, 100, T + 665);
        OnStart(230, 100, T + 665, "C:\\Windows\\System32\\cmd.exe", tick());
        OnOpen(230, "C:\\Users\\me\\person.txt", personOpen);
        check(Tracked.ContainsKey(230) && !said("person.txt"), "G4: an open stamped before the followed process's start is not reported");
        exit(230);
        // a tool (220) whose stop is late: the pid's next holder opens a file before the tool's own stop is handled
        run(220, 100, T + 660);
        OnStart(220, 100, T + 660, "C:\\Windows\\System32\\cmd.exe", tick());
        long stop220 = tick();
        exit(220);
        run(220, 4, T + 670);
        OnOpen(220, "C:\\Users\\me\\holder.txt", tick());
        OnStop(220, T + 660, stop220);
        check(!said("holder.txt"), "an open that waited, stamped after the tool's own stop, is not reported");
        exit(220);

        // w6734 B1': a worker's short tool (300) starts and exits, its stop lost; a person's launcher takes pid 300, opens a file,
        // starts the person's app and exits, and the launcher's stop comes in place of the tool's
        run(300, 100, T + 700);
        OnStart(300, 100, T + 700, "C:\\ffw\\tools\\git\\usr\\bin\\git.exe", tick());
        check(Tracked.ContainsKey(300), "a host's new child is followed at its start event");
        exit(300);
        run(300, 4, T + 750);
        OnOpen(300, "C:\\Users\\me\\launcher.txt", tick());
        run(302, 300, T + 800);
        OnStart(302, 300, T + 800, "C:\\apps\\app.exe", tick());
        exit(300);
        OnOpen(300, "C:\\Users\\me\\launcher2.txt", tick());
        OnStop(300, T + 750, tick());
        check(!said("launcher"), "B1': a later holder's opens are not reported, and its stop vouches for nothing");
        check(!Tracked.ContainsKey(302), "B1': a later holder's child is not followed");

        // a short-lived parent (310) had exited when its child's start event was handled: the parent's own stop lets the child in
        run(310, 100, T + 850);
        OnStart(310, 100, T + 850, "C:\\ffw\\tools\\bash.exe", tick());
        run(311, 310, T + 860);
        long start311 = tick();
        exit(310);
        OnStart(311, 310, T + 860, "C:\\apps\\tool.exe", start311);
        check(!Tracked.ContainsKey(311), "a child of an exited parent waits for the parent's stop");
        OnStop(310, T + 850, tick());
        check(Tracked.ContainsKey(311), "it is followed once the parent's own stop, stamped after the start, is seen");

        // w6734 B4: a start event without a creation time is not followed, even when a process now holds the child's pid
        run(301, 100, T + 900);
        OnStart(301, 100, 0, "x", tick());
        check(!Tracked.ContainsKey(301), "B4: a child whose start event has no creation time is not followed");

        // Seed: an orphan that names the host's pid but started before the host (a person's app whose updater held the pid)
        Command("roots");
        run(110, 4, T + 1000);
        run(400, 110, T + 900);
        low.Add(400);
        run(401, 110, T + 1100);
        Command("roots 110:" + ms(T + 1000));
        check(!Tracked.ContainsKey(400), "seed: a process older than the host it names is not its child");
        check(Tracked.ContainsKey(401), "seed: a process younger than its host is");

        // N1: a root whose process started at another time than its host record says is refused
        run(120, 4, T + 999999999);
        Command("roots 110:" + ms(T + 1000) + " 120:" + ms(T));
        check(!Roots.Contains(120) && said("root-refused"), "a pid whose process is not the host's is refused");
        check(Roots.Contains(110), "a pid whose process is its host's stays a root");
        // a host that exits is dropped at its stop, and its pid given to another process is not taken back
        OnStop(110, T + 1000, tick());
        exit(110);
        run(110, 4, T + 5000000000);
        Command("roots 110:" + ms(T + 1000));
        check(!Roots.Contains(110), "a host's reused pid is not taken back as a root");
        run(402, 110, T + 5000000100);
        OnStart(402, 110, T + 5000000100, "C:\\apps\\app.exe", tick());
        check(!Tracked.ContainsKey(402), "a child of the reused host pid is not followed (stamped after the host's stop)");
        check(Tracked.ContainsKey(401), "the dead host's worker child stays followed (an orphaned tool)");

        // orphans: a Low process with FF_SESSION_ID is a worker's; one without is a person's and is cached by its start
        Command("roots");
        run(500, 9999, T + 2000); low.Add(500); marked.Add(500);
        run(501, 9999, T + 2000); low.Add(501);
        run(130, 4, T + 3000);
        Command("roots 130:" + ms(T + 3000));
        check(Tracked.ContainsKey(500) && Tracked[500].Root == 0, "a Low orphan with FF_SESSION_ID is followed as a worker's");
        check(!Tracked.ContainsKey(501), "a Low orphan without it is not");
        // 501's pid goes to a worker's tool: the cache, keyed by creation time, does not hide it
        exit(501); run(501, 9999, T + 4000); marked.Add(501);
        Command("roots"); Command("roots 130:" + ms(T + 3000));
        run(131, 4, T + 3001);
        Command("roots 130:" + ms(T + 3000) + " 131:" + ms(T + 3001));
        check(Tracked.ContainsKey(501), "a worker's process given a person's old pid is not hidden by the cache");

        // w6734 B2: a process that exits, its stop handled, between Seed's check and its insert is not inserted
        Command("roots");
        run(140, 4, T + 6000);
        run(600, 140, T + 6100);
        run(601, 9999, T + 6200); low.Add(601); marked.Add(601);
        GapFn = p => { if (p == 600 || p == 601) { long s = start[p]; exit(p); OnStop(p, s, tick()); } };
        Command("roots 140:" + ms(T + 6000));
        GapFn = null;
        check(Tracked.ContainsKey(140), "B2: the host itself is a root");
        check(!Tracked.ContainsKey(600), "B2: a child that exited in Seed's gap is not inserted");
        check(!Tracked.ContainsKey(601), "B2: an orphan that exited in Seed's gap is not inserted");
        // and a root whose host exits in SetRoots' gap
        run(150, 4, T + 7000);
        GapFn = p => { if (p == 150) { long s = start[p]; exit(p); OnStop(p, s, tick()); } };
        Command("roots 140:" + ms(T + 6000) + " 150:" + ms(T + 7000));
        GapFn = null;
        check(!Roots.Contains(150) && !Tracked.ContainsKey(150), "B2: a host that exited in SetRoots' gap is not a root");

        Captured = null;
        foreach (string f in fails) Console.Out.WriteLine("selftest FAIL: " + f);
        Console.Out.WriteLine("selftest: " + passed + " passed, " + fails.Count + " failed");
        return fails.Count == 0 ? 0 : 1;
    }

    static bool IsWorkers(uint pid, string image)
    {
        string work;
        lock (Gate) work = Work;
        if (work.Length > 0 && image.Length > work.Length && image.StartsWith(work + "\\", StringComparison.OrdinalIgnoreCase)) return true;
        string env = EnvBlock(pid);
        return env != null && (env.StartsWith("FF_SESSION_ID=", StringComparison.Ordinal) || env.Contains("\0FF_SESSION_ID="));
    }

    // A process's environment block, read from its PEB (64-bit only): machine/leftovers.ts WIN_ENV_CS, the same offsets.
    [StructLayout(LayoutKind.Sequential)]
    struct Pbi { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref Pbi p, int l, out int r);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr s, out IntPtr r);
    [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool w);
    static long Read8(IntPtr h, long a) { byte[] b = new byte[8]; IntPtr n; if (!ReadProcessMemory(h, new IntPtr(a), b, new IntPtr(8), out n)) return 0; return BitConverter.ToInt64(b, 0); }
    static string EnvBlock(uint pid)
    {
        IntPtr h = OpenProcess(0x0410, false, pid); // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
        if (h == IntPtr.Zero) return null;
        try
        {
            bool wow;
            if (IsWow64Process(h, out wow) && wow) return null;
            Pbi p = new Pbi(); int r;
            if (NtQueryInformationProcess(h, 0, ref p, Marshal.SizeOf(typeof(Pbi)), out r) != 0) return null;
            long pp = Read8(h, p.Peb.ToInt64() + 0x20);
            if (pp == 0) return null;
            long env = Read8(h, pp + 0x80);
            if (env == 0) return null;
            long size = Read8(h, pp + 0x3F0);
            if (size <= 0 || size > (1 << 22)) size = 65536;
            for (; size >= 4096; size /= 2)
            {
                byte[] buf = new byte[size]; IntPtr n;
                bool ok = ReadProcessMemory(h, new IntPtr(env), buf, new IntPtr(size), out n);
                if (ok || n.ToInt64() >= 4096) return Encoding.Unicode.GetString(buf, 0, (int)(n.ToInt64() & ~1L));
            }
            return null;
        }
        finally { CloseHandle(h); }
    }

    // TokenIntegrityLevel (25): a TOKEN_MANDATORY_LABEL whose SID's last sub-authority is the level, 0x1000 for Low.
    static bool IsLow(uint pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) return false;
        IntPtr token;
        bool low = false;
        if (OpenProcessToken(h, 0x0008, out token)) // TOKEN_QUERY
        {
            IntPtr buf = Marshal.AllocHGlobal(256);
            int ret;
            if (GetTokenInformation(token, 25, buf, 256, out ret))
            {
                IntPtr sid = Marshal.ReadIntPtr(buf);
                int n = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (n > 0) low = (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(n - 1))) < 0x2000;
            }
            Marshal.FreeHGlobal(buf);
            CloseHandle(token);
        }
        CloseHandle(h);
        return low;
    }

    static string ImageOf(uint pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(1024);
        int n = sb.Capacity;
        string r = QueryFullProcessImageNameW(h, 0, sb, ref n) ? sb.ToString(0, n) : "";
        CloseHandle(h);
        return r;
    }

    static uint Number(IntPtr rec, IntPtr name)
    {
        PropertyDescriptor d = new PropertyDescriptor { PropertyName = name, ArrayIndex = 0xFFFFFFFF };
        uint size;
        if (TdhGetPropertySize(rec, 0, IntPtr.Zero, 1, ref d, out size) != 0 || size < 4) return 0;
        IntPtr buf = Marshal.AllocHGlobal((int)size);
        try { return TdhGetProperty(rec, 0, IntPtr.Zero, 1, ref d, size, buf) == 0 ? (uint)Marshal.ReadInt32(buf) : 0; }
        finally { Marshal.FreeHGlobal(buf); }
    }

    static string Text(IntPtr rec, IntPtr name)
    {
        PropertyDescriptor d = new PropertyDescriptor { PropertyName = name, ArrayIndex = 0xFFFFFFFF };
        uint size;
        if (TdhGetPropertySize(rec, 0, IntPtr.Zero, 1, ref d, out size) != 0 || size < 2) return null;
        IntPtr buf = Marshal.AllocHGlobal((int)size + 2);
        try
        {
            Marshal.WriteInt16(buf, (int)size, 0);
            return TdhGetProperty(rec, 0, IntPtr.Zero, 1, ref d, size, buf) == 0 ? Marshal.PtrToStringUni(buf) : null;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    // \Device\HarddiskVolume3 -> C:, the drive letters the machine has now (again each hour, for a drive added since)
    static void Devices()
    {
        List<KeyValuePair<string, string>> l = new List<KeyValuePair<string, string>>();
        StringBuilder sb = new StringBuilder(1024);
        for (char c = 'A'; c <= 'Z'; c++)
        {
            string drive = c + ":";
            if (QueryDosDeviceW(drive, sb, sb.Capacity) == 0) continue;
            l.Add(new KeyValuePair<string, string>(sb.ToString() + "\\", drive + "\\"));
        }
        // longest device first: \Device\HarddiskVolume1 must not take \Device\HarddiskVolume12's paths
        l.Sort((a, b) => b.Key.Length - a.Key.Length);
        devices = l;
    }

    // A path on a drive letter or a share; null for anything else (pipes, the console, sockets, a device with no letter).
    static string Dos(string nt)
    {
        if (string.IsNullOrEmpty(nt)) return null;
        foreach (KeyValuePair<string, string> d in devices)
            if (nt.StartsWith(d.Key, StringComparison.OrdinalIgnoreCase)) return d.Value + nt.Substring(d.Key.Length);
        if (nt.StartsWith("\\Device\\Mup\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + nt.Substring(12);
        if (nt.Length >= 3 && nt[1] == ':' && nt[2] == '\\') return nt;
        return null;
    }

    static string Norm(string p)
    {
        return p.Replace('/', '\\').ToLowerInvariant();
    }

    static string Esc(string s)
    {
        StringBuilder b = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.ToString();
    }

    static void Say(string json)
    {
        lock (OutGate)
        {
            if (Captured != null) { Captured.Add(json); return; }
            try
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
            catch
            {
                // the daemon closed our stdout: nothing to say to
            }
        }
    }
}

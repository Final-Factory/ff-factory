// The worker read log's Windows helper (w6599, machine/readLog.ts; lothsahn: "Keep today's fence and add read logging only"):
// a real-time ETW session on Windows' own Kernel-Process and Kernel-File providers. It follows the processes the daemon's agent
// hosts start, and says which files those processes open outside the allowed folders: the path and the opening program,
// nothing else (never a file's contents). It blocks nothing and changes no file, label or ACL.
//
//   ffreadlog.exe <session name>          run: stdin and stdout below
//   ffreadlog.exe <session name> stop     stop a session of that name a helper before this one left behind, then exit
//
// stdin: "allow <folder>" (one per line, before or after "roots": a path at or under it is not reported), "exact <path>" (that
// path alone, such as a drive's root), "roots <pid>..." (the
// agent hosts now: the whole set each time; their descendants are followed, the hosts' own opens are not reported). EOF (the
// daemon is gone) stops the session and ends the helper.
// stdout, one JSON object a line: {"event":"ready"}, {"event":"error","why":"..."} (then it exits 1),
// {"event":"read","root":R,"pid":P,"image":"C:\\...\\x.exe","path":"C:\\..."} (each root, program and path once an hour, at most
// MAX_PER_MINUTE a minute) and each minute {"event":"stat","fileEvents":N,"procEvents":N,"tracked":N,"reported":N,"dropped":N,
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

    static readonly object Gate = new object();
    static readonly object OutGate = new object();
    // pid -> its root (an agent host's pid); a root maps to itself, and its own opens are not reported
    static readonly Dictionary<uint, uint> Tracked = new Dictionary<uint, uint>();
    static readonly Dictionary<uint, string> Images = new Dictionary<uint, string>();
    static readonly HashSet<uint> Roots = new HashSet<uint>();
    static readonly List<string> Allow = new List<string>();
    static readonly HashSet<string> AllowExact = new HashSet<string>();
    static readonly HashSet<string> Seen = new HashSet<string>();
    // the work folder (`work <folder>`): an orphaned Low process running a program from it is a worker's
    static string Work = "";
    // Low processes found to be no worker's (a person's browser, chat or game launcher), so their memory is not read again
    static readonly HashSet<uint> NotWorker = new HashSet<uint>();
    static List<KeyValuePair<string, string>> devices = new List<KeyValuePair<string, string>>();
    static long fileEvents, procEvents, reported, dropped;
    static int thisMinute;
    static RecordCallback keep; // the delegate ProcessTrace calls, kept from the collector
    static readonly IntPtr NameFileName = Marshal.StringToHGlobalUni("FileName");
    static readonly IntPtr NameProcessId = Marshal.StringToHGlobalUni("ProcessID");
    static readonly IntPtr NameParentId = Marshal.StringToHGlobalUni("ParentProcessID");
    static readonly IntPtr NameImage = Marshal.StringToHGlobalUni("ImageName");

    static int Main(string[] args)
    {
        if (args.Length < 1) { Say("{\"event\":\"error\",\"why\":\"usage: ffreadlog <session name> [stop]\"}"); return 1; }
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

        keep = OnRecord;
        Logfile lf = new Logfile { LoggerName = name, ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD, CurrentEvent = new byte[88], LogfileHeader = new byte[280], EventRecordCallback = keep };
        ulong trace = OpenTraceW(ref lf);
        if (trace == INVALID_TRACE) { int e = Marshal.GetLastWin32Error(); ControlTraceW(session, null, props, EVENT_TRACE_CONTROL_STOP); Say("{\"event\":\"error\",\"why\":\"OpenTrace failed: " + e + "\"}"); return 1; }
        Thread collector = new Thread(() => ProcessTrace(new[] { trace }, 1, IntPtr.Zero, IntPtr.Zero)) { IsBackground = true };
        collector.Start();
        Say("{\"event\":\"ready\"}");

        IntPtr query = NewProperties(name);
        Timer minute = new Timer(_ =>
        {
            uint lost = 0;
            if (ControlTraceW(session, null, query, EVENT_TRACE_CONTROL_QUERY) == 0)
            {
                Properties q = (Properties)Marshal.PtrToStructure(query, typeof(Properties));
                lost = q.EventsLost + q.RealTimeBuffersLost;
            }
            int tracked;
            lock (Gate) { tracked = Tracked.Count; thisMinute = 0; }
            Say("{\"event\":\"stat\",\"fileEvents\":" + Interlocked.Exchange(ref fileEvents, 0) + ",\"procEvents\":" + Interlocked.Exchange(ref procEvents, 0) + ",\"tracked\":" + tracked + ",\"reported\":" + Interlocked.Exchange(ref reported, 0) + ",\"dropped\":" + Interlocked.Exchange(ref dropped, 0) + ",\"lost\":" + lost + "}");
        }, null, 60000, 60000);
        // what was reported is reported again an hour later, so a long run still shows its reads
        Timer hourly = new Timer(_ => { lock (Gate) { Seen.Clear(); NotWorker.Clear(); } Devices(); }, null, 3600000, 3600000);

        string line;
        while ((line = Console.In.ReadLine()) != null)
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
        minute.Dispose();
        hourly.Dispose();
        ControlTraceW(session, null, props, EVENT_TRACE_CONTROL_STOP);
        CloseTrace(trace);
        return 0;
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

    // EVENT_RECORD: EVENT_HEADER (80 bytes: ProcessId at 12, ProviderId at 24, EventDescriptor.Id at 40), then UserData at 96.
    static void OnRecord(IntPtr rec)
    {
        try
        {
            uint pid = (uint)Marshal.ReadInt32(rec, 12);
            int id = (ushort)Marshal.ReadInt16(rec, 40);
            byte[] g = new byte[16];
            Marshal.Copy(rec + 24, g, 0, 16);
            Guid provider = new Guid(g);
            if (provider == KernelFile)
            {
                if (id != 12) return;
                Interlocked.Increment(ref fileEvents);
                uint root;
                string image;
                lock (Gate)
                {
                    if (!Tracked.TryGetValue(pid, out root) || root == pid) return;
                    Images.TryGetValue(pid, out image);
                }
                string path = Dos(Text(rec, NameFileName));
                if (path == null) return;
                OnOpen(root, pid, image ?? "", path);
            }
            else if (provider == KernelProcess)
            {
                Interlocked.Increment(ref procEvents);
                if (id == 1)
                {
                    uint child = Number(rec, NameProcessId), parent = Number(rec, NameParentId);
                    lock (Gate)
                    {
                        uint root;
                        if (!Tracked.TryGetValue(parent, out root)) return;
                        Tracked[child] = root;
                    }
                    string image = Dos(Text(rec, NameImage)) ?? Text(rec, NameImage) ?? "";
                    lock (Gate) Images[child] = image;
                }
                else if (id == 2)
                {
                    uint gone = Number(rec, NameProcessId);
                    lock (Gate)
                    {
                        if (Roots.Contains(gone)) return;
                        Tracked.Remove(gone);
                        Images.Remove(gone);
                    }
                }
            }
        }
        catch
        {
            // one event the helper cannot read is skipped, never the session
        }
    }

    static void OnOpen(uint root, uint pid, string image, string path)
    {
        string norm = Norm(path);
        lock (Gate)
        {
            if (AllowExact.Contains(norm) || AllowExact.Contains(norm.TrimEnd('\\'))) return;
            foreach (string a in Allow)
                if (norm == a || (norm.Length > a.Length && norm.StartsWith(a) && norm[a.Length] == '\\')) return;
            string key = root + "|" + image + "|" + norm;
            if (Seen.Contains(key)) return;
            if (thisMinute >= MAX_PER_MINUTE) { Interlocked.Increment(ref dropped); return; }
            if (Seen.Count >= SEEN_CAP) Seen.Clear();
            Seen.Add(key);
            thisMinute++;
        }
        Interlocked.Increment(ref reported);
        Say("{\"event\":\"read\",\"root\":" + root + ",\"pid\":" + pid + ",\"image\":\"" + Esc(image) + "\",\"path\":\"" + Esc(path) + "\"}");
    }

    static void SetRoots(string list)
    {
        HashSet<uint> now = new HashSet<uint>();
        foreach (string s in list.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
        {
            uint v;
            if (uint.TryParse(s, out v)) now.Add(v);
        }
        List<uint> fresh = new List<uint>();
        lock (Gate)
        {
            foreach (uint r in new List<uint>(Roots))
            {
                if (now.Contains(r)) continue;
                Roots.Remove(r);
                List<uint> drop = new List<uint>();
                foreach (KeyValuePair<uint, uint> t in Tracked) if (t.Value == r) drop.Add(t.Key);
                foreach (uint d in drop) { Tracked.Remove(d); Images.Remove(d); }
            }
            foreach (uint r in now) if (Roots.Add(r)) { Tracked[r] = r; fresh.Add(r); }
        }
        if (fresh.Count > 0) Seed(fresh);
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
        IntPtr snap = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if (snap == new IntPtr(-1)) return;
        ProcessEntry e = new ProcessEntry { dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
        for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
        {
            List<uint> l;
            if (!children.TryGetValue(e.th32ParentProcessID, out l)) children[e.th32ParentProcessID] = l = new List<uint>();
            if (e.th32ProcessID != e.th32ParentProcessID) l.Add(e.th32ProcessID);
        }
        CloseHandle(snap);
        HashSet<uint> all = new HashSet<uint>();
        foreach (List<uint> l in children.Values) foreach (uint c in l) all.Add(c);
        foreach (uint root in roots)
        {
            Queue<uint> q = new Queue<uint>();
            q.Enqueue(root);
            int guard = 0;
            while (q.Count > 0 && guard++ < 10000)
            {
                uint p = q.Dequeue();
                List<uint> l;
                if (!children.TryGetValue(p, out l)) continue;
                foreach (uint c in l)
                {
                    string image = ImageOf(c);
                    lock (Gate)
                    {
                        if (Tracked.ContainsKey(c)) continue;
                        Tracked[c] = root;
                        Images[c] = image;
                    }
                    q.Enqueue(c);
                }
            }
        }
        foreach (uint pid in all)
        {
            lock (Gate) if (Tracked.ContainsKey(pid)) continue;
            lock (Gate) if (NotWorker.Contains(pid)) continue;
            if (!IsLow(pid)) continue;
            string image = ImageOf(pid);
            if (!IsWorkers(pid, image))
            {
                lock (Gate) NotWorker.Add(pid);
                continue;
            }
            lock (Gate)
            {
                if (Tracked.ContainsKey(pid)) continue;
                Tracked[pid] = 0;
                Images[pid] = image;
            }
        }
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

// The worker caps' Windows job (w5554, machine/workerCaps.ts): puts one process (an agent host) in a new job object, then
// reports what the job's completion port says, one JSON object a line on stdout. Everything the process starts afterwards is
// in the job, whatever integrity it runs at, and a process may not break away (no JOB_OBJECT_LIMIT_BREAKAWAY_OK).
//
//   ffjob.exe <pid> <job memory bytes> <active processes> <mode>
//
// mode "enforce": the job gets a commit limit for the whole job and an active-process limit. They are the kernel's: they hold
// after this helper exits, as long as one process of the job runs. Any other mode (warn, which the host passes by default,
// and anything this does not know) sets NO limit flags: the job only counts, and `stat` reads the counts.
//
// stdout: {"event":"ready"}, then {"event":"memory","pid":N}, {"event":"processes","active":N} (enforce only),
// {"event":"killed","n":N[,"why":"..."]} and {"event":"stat","active":N,"peak":B}.
// stdin: "kill-tools <host pid>" ends every process of the job but the host and its own children (its claude): the tools its
// agent ran, a runaway among them. It ends nothing when the process snapshot is empty or lacks the host (then the host's own
// children cannot be told from the tools), and skips a pid that is no longer in the job (a reused pid). "count" says how many
// processes the job holds; "stat" says the active count and the job's peak commit (PeakJobMemoryUsed). EOF (its host is gone)
// ends the helper.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

static class FfJob
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong a, b, c, d, e, f;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct CompletionPort
    {
        public IntPtr Key;
        public IntPtr Port;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimit info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref CompletionPort info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out Accounting info, int len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out ExtendedLimit info, int len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr proc, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr proc, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr port, IntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint msg, out IntPtr key, out IntPtr data, uint ms);

    const int ExtendedLimitInformation = 9;
    const int AssociateCompletionPortInformation = 7;
    const int BasicProcessIdList = 3;
    const int BasicAccountingInformation = 1;
    const uint LimitActiveProcess = 0x8;
    const uint LimitJobMemory = 0x200;
    const uint LimitBreakawayOk = 0x800;
    const uint SetQuota = 0x0100, Terminate = 0x0001, QueryLimited = 0x1000;
    const uint MsgActiveProcessLimit = 3, MsgJobMemoryLimit = 10;

    static readonly object Gate = new object();
    static void Say(string json)
    {
        lock (Gate)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    static int Fail(string what)
    {
        Say("{\"event\":\"error\",\"what\":\"" + what + "\",\"code\":" + Marshal.GetLastWin32Error() + "}");
        return 1;
    }

    static List<uint> Pids(IntPtr job)
    {
        const int max = 8192;
        int len = 8 + IntPtr.Size * max;
        IntPtr buf = Marshal.AllocHGlobal(len);
        var pids = new List<uint>();
        try
        {
            if (!QueryInformationJobObject(job, BasicProcessIdList, buf, len, IntPtr.Zero)) return pids;
            int n = Marshal.ReadInt32(buf, 4);
            for (int i = 0; i < n && i < max; i++) pids.Add((uint)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64());
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
        return pids;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snap, ref ProcessEntry e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snap, ref ProcessEntry e);

    // Each running process's parent, from one snapshot.
    static Dictionary<uint, uint> Parents()
    {
        var map = new Dictionary<uint, uint>();
        IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
        if (snap == new IntPtr(-1)) return map;
        try
        {
            var e = new ProcessEntry { dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) map[e.th32ProcessID] = e.th32ParentProcessID;
        }
        finally
        {
            CloseHandle(snap);
        }
        return map;
    }

    static int Main(string[] a)
    {
        if (a.Length < 3) return Fail("usage");
        uint pid = uint.Parse(a[0]);
        ulong memory = ulong.Parse(a[1]);
        uint processes = uint.Parse(a[2]);
        // Limits only when asked for by name: a missing or unknown mode counts, and never limits (a lockout is worse than a miss).
        bool enforce = a.Length > 3 && a[3] == "enforce";
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return Fail("CreateJobObject");
        var lim = new ExtendedLimit();
        if (enforce)
        {
            lim.Basic.LimitFlags = LimitJobMemory | LimitActiveProcess;
            lim.Basic.ActiveProcessLimit = processes;
            lim.JobMemoryLimit = new UIntPtr(memory);
        }
        else
        {
            // Warn: a child started with CREATE_BREAKAWAY_FROM_JOB may leave the job, so the job never refuses a start (w5554 review).
            lim.Basic.LimitFlags = LimitBreakawayOk;
        }
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref lim, Marshal.SizeOf(typeof(ExtendedLimit)))) return Fail("SetInformationJobObject");
        IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1);
        if (port == IntPtr.Zero) return Fail("CreateIoCompletionPort");
        var cp = new CompletionPort { Key = job, Port = port };
        if (!SetInformationJobObject(job, AssociateCompletionPortInformation, ref cp, Marshal.SizeOf(typeof(CompletionPort)))) return Fail("AssociateCompletionPort");
        IntPtr proc = OpenProcess(SetQuota | Terminate, false, pid);
        if (proc == IntPtr.Zero) return Fail("OpenProcess");
        if (!AssignProcessToJobObject(job, proc)) return Fail("AssignProcessToJobObject");
        CloseHandle(proc);
        Say("{\"event\":\"ready\"}");

        var reader = new Thread(() =>
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (line == "count")
                {
                    Say("{\"event\":\"count\",\"n\":" + Pids(job).Count + "}");
                    continue;
                }
                if (line == "stat")
                {
                    Accounting a2;
                    ExtendedLimit ext;
                    uint active = QueryInformationJobObject(job, BasicAccountingInformation, out a2, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) ? a2.ActiveProcesses : 0;
                    ulong peak = QueryInformationJobObject(job, ExtendedLimitInformation, out ext, Marshal.SizeOf(typeof(ExtendedLimit)), IntPtr.Zero) ? ext.PeakJobMemoryUsed.ToUInt64() : 0;
                    Say("{\"event\":\"stat\",\"active\":" + active + ",\"peak\":" + peak + "}");
                    continue;
                }
                if (!line.StartsWith("kill-tools ")) continue;
                uint host = uint.Parse(line.Substring(11).Trim());
                var parents = Parents();
                // With no snapshot, or none of the host, the host's own children (its claude) cannot be told from the tools.
                if (parents.Count == 0 || !parents.ContainsKey(host))
                {
                    Say("{\"event\":\"killed\",\"n\":0,\"why\":\"" + (parents.Count == 0 ? "the process snapshot was empty" : "the host is not in the process snapshot") + "\"}");
                    continue;
                }
                int n = 0;
                foreach (var p in Pids(job))
                {
                    uint parent;
                    // A pid missing from the snapshot started after it (it may be the host's new claude): spared, as toolsToEnd does.
                    if (p == host || !parents.TryGetValue(p, out parent) || parent == host) continue;
                    IntPtr h = OpenProcess(Terminate | QueryLimited, false, p);
                    if (h == IntPtr.Zero) continue;
                    // The pid may have been reused by a process outside the job since the list was read.
                    bool inJob;
                    if (IsProcessInJob(h, job, out inJob) && inJob && TerminateProcess(h, 1)) n++;
                    CloseHandle(h);
                }
                Say("{\"event\":\"killed\",\"n\":" + n + "}");
            }
            Environment.Exit(0);
        });
        reader.IsBackground = true;
        reader.Start();

        // The port's limit message is not enough alone: a Git Bash (msys) fork that the limit refuses retries quietly, and
        // was seen posting none (beast, w5554). So the job's own count is read too, every few seconds.
        long saidFull = 0;
        while (true)
        {
            uint msg;
            IntPtr key, data;
            if (GetQueuedCompletionStatus(port, out msg, out key, out data, 3000))
            {
                if (!enforce) continue;
                if (msg == MsgJobMemoryLimit) Say("{\"event\":\"memory\",\"pid\":" + data.ToInt64() + "}");
                else if (msg == MsgActiveProcessLimit) Full(ref saidFull, processes);
            }
            Accounting acc;
            if (enforce && QueryInformationJobObject(job, BasicAccountingInformation, out acc, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) && acc.ActiveProcesses >= processes) Full(ref saidFull, acc.ActiveProcesses);
        }
    }

    // At most one "processes" line in 10 s: a fork bomb at the limit asks thousands of times.
    static void Full(ref long saidAt, uint active)
    {
        long now = Environment.TickCount;
        if (saidAt != 0 && now - saidAt < 10000) return;
        saidAt = now;
        Say("{\"event\":\"processes\",\"active\":" + active + "}");
    }
}

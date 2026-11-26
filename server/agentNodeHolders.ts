/**
 * Which Low processes hold the agents' node open (w5839, w5882's review). A handle outlives a relabel: a Low worker that
 * opened a file of `tools\node` for writing while an old daemon had `tools` Low keeps that handle after a newer daemon
 * labels the folder Medium again, so labels, hashes and the folder's identity can all be right while a Low process can
 * still write node.exe. And a handle Windows will not let a rename pass (a file or a folder held open) keeps a planted
 * node in place. So before the node is trusted, and again before a swap that failed is tried again, the daemon lists every
 * process below Medium integrity that holds a file, a folder or a file section under the node's folder or its record's
 * folder, or has one mapped, and ends them.
 *
 * Read with one PowerShell (Windows PowerShell 5.1's C#, no administrator rights): for each process below Medium, its own
 * handles (NtQueryInformationProcess, ProcessHandleInformation; the system-wide table needs SeDebugPrivilege on Windows 11
 * and was refused, measured on BEAST), each File handle's path
 * (GetFileType first, so a pipe never hangs GetFinalPathNameByHandle), each file Section's file (a read-only view mapped
 * here, GetMappedFileName on it) and each mapped view in its memory (VirtualQueryEx, MEM_MAPPED). A process below
 * Medium whose handles or memory cannot be read counts as a holder.
 */

export interface Holder {
  pid: number;
  name: string;
  path: string;
}

const CS = String.raw`
using System; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices; using System.Text;
public static class FfHolders {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p, int c, IntPtr b, int l, out int r);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p, out int c);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, int a, bool i, int o);
  [DllImport("kernel32.dll")] static extern int GetFileType(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetFinalPathNameByHandleW(IntPtr h, StringBuilder b, int n, int f);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, int a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr b, int l, out int r);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr s);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr s, int i);
  [DllImport("kernel32.dll")] static extern int VirtualQueryEx(IntPtr p, IntPtr a, out MBI m, int l);
  [DllImport("psapi.dll", CharSet=CharSet.Unicode)] static extern int GetMappedFileNameW(IntPtr p, IntPtr a, StringBuilder b, int n);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string n, int a, int s, IntPtr sa, int d, int f, IntPtr t);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileMappingW(IntPtr f, IntPtr sa, int p, int hi, int lo, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr MapViewOfFile(IntPtr h, int a, int hi, int lo, IntPtr n);
  [DllImport("kernel32.dll")] static extern bool UnmapViewOfFile(IntPtr a);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int QueryDosDeviceW(string d, StringBuilder b, int n);
  [StructLayout(LayoutKind.Sequential)] struct MBI { public IntPtr Base, AllocBase; public int AllocProtect; public IntPtr Size; public int State, Protect, Type; }

  static int Rid(int pid) {
    IntPtr p = OpenProcess(0x1000, false, pid); if (p == IntPtr.Zero) return -1;
    try {
      IntPtr t; if (!OpenProcessToken(p, 8, out t)) return -1;
      try {
        int n; GetTokenInformation(t, 25, IntPtr.Zero, 0, out n); if (n <= 0) return -1;
        IntPtr b = Marshal.AllocHGlobal(n);
        try {
          if (!GetTokenInformation(t, 25, b, n, out n)) return -1;
          IntPtr sid = Marshal.ReadIntPtr(b);
          int c = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
          return Marshal.ReadInt32(GetSidSubAuthority(sid, c - 1));
        } finally { Marshal.FreeHGlobal(b); }
      } finally { CloseHandle(t); }
    } finally { CloseHandle(p); }
  }

  // A process's own handles (ProcessHandleInformation, Windows 8 on): each entry's handle and object type index
  // (PROCESS_HANDLE_TABLE_ENTRY_INFO, 40 bytes on x64). The system-wide table is refused below SeDebugPrivilege.
  static List<long[]> Handles(IntPtr ph) {
    int len = 1 << 16; IntPtr b;
    while (true) {
      b = Marshal.AllocHGlobal(len); int r; int s = NtQueryInformationProcess(ph, 51, b, len, out r);
      if (s == unchecked((int)0xC0000004)) { Marshal.FreeHGlobal(b); len = Math.Max(len * 2, r + 4096); continue; }
      if (s != 0) { Marshal.FreeHGlobal(b); return null; }
      break;
    }
    try {
      long n = Marshal.ReadInt64(b); var l = new List<long[]>((int)n); IntPtr e = b + 16;
      for (long i = 0; i < n; i++, e += 40) l.Add(new long[] { Marshal.ReadInt64(e, 0), Marshal.ReadInt32(e, 28) });
      return l;
    } finally { Marshal.FreeHGlobal(b); }
  }

  // A process that ended since the list was taken: it holds nothing.
  static bool Gone(long pid) {
    IntPtr p = OpenProcess(0x1000, false, (int)pid); if (p == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87;
    try { int c; return GetExitCodeProcess(p, out c) && c != 259; } finally { CloseHandle(p); }
  }

  static bool Under(string p, List<string> roots) {
    p = p.ToLowerInvariant();
    foreach (var r in roots) if (p == r || p.StartsWith(r + "\\")) return true;
    return false;
  }

  public static string[] Find(string[] dirs, int[] skip) {
    if (IntPtr.Size != 8) throw new Exception("needs a 64-bit PowerShell");
    var dos = new List<string>(); var dev = new List<string>();
    foreach (var d0 in dirs) {
      string d = d0.TrimEnd('\\'); dos.Add(d.ToLowerInvariant());
      var sb = new StringBuilder(1024);
      if (QueryDosDeviceW(d.Substring(0, 2), sb, 1024) == 0) throw new Exception("QueryDosDevice " + d.Substring(0, 2));
      dev.Add((sb.ToString() + d.Substring(2)).ToLowerInvariant());
    }
    int me = Process.GetCurrentProcess().Id; IntPtr self = GetCurrentProcess();
    // Our own folder handle and section say which type index is File and which is Section on this Windows.
    IntPtr fh = CreateFileW(dirs[0], 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (fh == new IntPtr(-1)) throw new Exception("could not open " + dirs[0] + ": error " + Marshal.GetLastWin32Error());
    IntPtr sh = CreateFileMappingW(new IntPtr(-1), IntPtr.Zero, 4, 0, 4096, null);
    var mine = Handles(self); int fileT = -1, secT = -1;
    if (mine != null) foreach (var e in mine) { if (e[0] == fh.ToInt64()) fileT = (int)e[1]; if (e[0] == sh.ToInt64()) secT = (int)e[1]; }
    CloseHandle(fh); CloseHandle(sh);
    if (fileT < 0 || secT < 0) throw new Exception("could not tell the File and Section types in this process's handles");
    var low = new HashSet<long>();
    foreach (var p in Process.GetProcesses()) {
      int id = p.Id; if (id == me || Array.IndexOf(skip, id) >= 0) continue;
      int rid = Rid(id); if (rid >= 0 && rid < 0x2000) low.Add(id);
    }
    var hit = new Dictionary<long, string>(); var procs = new Dictionary<long, IntPtr>(); long handles = 0;
    Func<long, IntPtr> open = pid => { IntPtr h; if (!procs.TryGetValue(pid, out h)) { h = OpenProcess(0x40 | 0x400 | 0x10, false, (int)pid); procs[pid] = h; } return h; };
    foreach (var pid in low) {
      IntPtr ph = open(pid); var hs = ph == IntPtr.Zero ? null : Handles(ph);
      if (hs == null) { if (!Gone(pid)) hit[pid] = "(its handles could not be read)"; continue; }
      handles += hs.Count;
      foreach (var e in hs) {
        int t = (int)e[1]; if (t != fileT && t != secT) continue;
        IntPtr dup; if (!DuplicateHandle(ph, new IntPtr(e[0]), self, out dup, 0, false, 2)) continue;
        try {
          var sb = new StringBuilder(32768);
          if (t == fileT) {
            if (GetFileType(dup) != 1) continue;
            int n = GetFinalPathNameByHandleW(dup, sb, 32768, 0); if (n <= 0 || n >= 32768) continue;
            string p = sb.ToString(); if (p.StartsWith("\\\\?\\")) p = p.Substring(4);
            if (Under(p, dos)) { hit[pid] = p; break; }
          } else {
            IntPtr v = MapViewOfFile(dup, 4, 0, 0, new IntPtr(1)); if (v == IntPtr.Zero) continue;
            try { if (GetMappedFileNameW(self, v, sb, 32768) > 0 && Under(sb.ToString(), dev)) { hit[pid] = sb.ToString(); break; } }
            finally { UnmapViewOfFile(v); }
          }
        } finally { CloseHandle(dup); }
      }
    }
    int ms = Marshal.SizeOf(typeof(MBI));
    foreach (var pid in low) {
      if (hit.ContainsKey(pid)) continue;
      IntPtr ph = open(pid); if (ph == IntPtr.Zero) { if (!Gone(pid)) hit[pid] = "(its memory could not be read)"; continue; }
      long a = 0; MBI m;
      while (VirtualQueryEx(ph, new IntPtr(a), out m, ms) == ms) {
        if (m.Type == 0x40000 && m.State == 0x1000) {
          var sb = new StringBuilder(32768);
          if (GetMappedFileNameW(ph, m.Base, sb, 32768) > 0 && Under(sb.ToString(), dev)) { hit[pid] = sb.ToString(); break; }
        }
        long nx = m.Base.ToInt64() + m.Size.ToInt64(); if (nx <= a) break; a = nx;
      }
    }
    foreach (var h in procs.Values) if (h != IntPtr.Zero) CloseHandle(h);
    var o = new List<string>();
    o.Add("read low=" + low.Count + " handles=" + handles);
    foreach (var kv in hit) {
      string name = "?"; try { name = Process.GetProcessById((int)kv.Key).ProcessName; } catch { }
      o.Add("holder " + kv.Key + " " + name.Replace(' ', '_') + " " + kv.Value);
    }
    return o.ToArray();
  }
}
`;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The PowerShell that prints "read low=<n> handles=<n>", then "holder <pid> <name> <path>" for each process below Medium that holds anything under `dirs`, leaving out `skip`. */
export function holdersScript(dirs: string[], skip: number[]): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CS}
'@
foreach ($l in [FfHolders]::Find([string[]]@(${dirs.map(q).join(', ')}), [int[]]@(${[...skip, '$PID'].join(', ')}))) { $l }
`;
}

/** The holders the script printed; undefined when it did not finish its read (no "read" line). */
export function parseHolders(out: string): Holder[] | undefined {
  const lines = out.split(/\r?\n/);
  if (!lines.some((l) => /^read low=\d+ handles=\d+$/.test(l.trim()))) return undefined;
  return lines.flatMap((l) => {
    const m = /^holder (\d+) (\S+) (.+)$/.exec(l.trim());
    return m ? [{ pid: Number(m[1]), name: m[2], path: m[3] }] : [];
  });
}

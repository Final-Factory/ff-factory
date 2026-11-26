/**
 * Which Low processes hold the agents' node open (w5839, w5882's review). A handle outlives a relabel: a Low worker that
 * opened a file of `tools\node` for writing while an old daemon had `tools` Low keeps that handle after a newer daemon
 * labels the folder Medium again, so labels, hashes and the folder's identity can all be right while a Low process can
 * still write node.exe. And a handle Windows will not let a rename pass (a file or a folder held open) keeps a planted
 * node in place. So before the node is trusted, and again before a swap that failed is tried again, the daemon lists every
 * process below Medium integrity that holds a file, a folder or a file section under the node's folder or its record's
 * folder, or has one mapped, and names them (nothing is ended: the warn-only stage, w5926's review).
 *
 * Which handles count (w5886's review): before the node is trusted, only access that can change the files (a File handle
 * with write, append, attribute, extended-attribute, delete, DACL or owner rights, a Section with map-write, a view mapped
 * writable). A Low worker running the node from `tools\node`, or with its working folder there, holds read handles only,
 * since the Medium label refuses Low any other open, and it is never ended on a node that verifies. Once a swap was refused
 * (the node there is already untrusted), any handle or view counts, since any open file or folder blocks the rename.
 *
 * How a handle is matched (w5951's review, B1): a File handle by its file's identity (volume serial and 128-bit file id),
 * compared with the ids of every file and folder under the folders read first, and only then by its path, for a file made
 * there since. A path is not enough: a handle opened through a second hard link that was deleted since has no name Windows
 * will give, while the file is back to one link. A handle that can change a file and cannot be identified on the node's
 * volume (not copied, or no file id) is a holder, never skipped, and so is a writable file view whose name there no
 * longer opens. A file view is still matched by the name it was mapped by: one mapped through a deleted second link whose
 * name was then made again for another file is outside this read.
 *
 * Read with one PowerShell (Windows PowerShell 5.1's C#, no administrator rights): for each process below Medium, its own
 * handles (NtQueryInformationProcess, ProcessHandleInformation; the system-wide table needs SeDebugPrivilege on Windows 11
 * and was refused, measured on BEAST), each File handle's path
 * (GetFileType first, so a pipe never hangs GetFinalPathNameByHandle), each file Section's file (a read-only view mapped
 * here, GetMappedFileName on it) and each mapped view in its memory (VirtualQueryEx, MEM_MAPPED). A process below
 * Medium whose handles or memory cannot be read is counted (`unread=`) and never ended: Windows' own sandboxed services
 * are such (DefenderAiPlatformHost on the CI runner, w5839), and one that hides this way is outside what this defends.
 */

import { gzipSync } from 'node:zlib';

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
  [StructLayout(LayoutKind.Sequential)] struct MBI { public IntPtr Base, AllocBase; public int AllocProtect; public IntPtr Size; public int State, Protect, Type; }
  [StructLayout(LayoutKind.Sequential)] struct FID { public ulong Vol, Lo, Hi; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr h, int c, out FID f, int n);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandleW(IntPtr h, StringBuilder n, int nl, out uint s, out uint m, out uint f, StringBuilder fs, int fl);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WFD {
    public uint Attr, C1, C2, A1, A2, W1, W2, SizeHi, SizeLo, R0, R1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=14)] public string Alt;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr FindFirstFileW(string n, out WFD d);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool FindNextFileW(IntPtr h, out WFD d);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr h);

  // A file's identity (w5951's review, B1): its volume's serial number and its 128-bit file id (FILE_ID_INFO, ReFS's
  // too), the same through every name it has had: a second hard link deleted since, a junction, an 8.3 name, a subst
  // drive. Null when Windows will not say.
  static string Key(IntPtr h) {
    FID f; return GetFileInformationByHandleEx(h, 0x12, out f, 24) ? f.Vol.ToString("x") + ":" + f.Hi.ToString("x16") + f.Lo.ToString("x16") : null;
  }
  static long Vol(IntPtr h) { uint s, m, fl; return GetVolumeInformationByHandleW(h, null, 0, out s, out m, out fl, null, 0) ? (long)s : -1; }

  // The ids of a folder and everything in it, a reparse point taken as itself and never followed.
  static void Ids(string p, HashSet<string> ids, HashSet<long> vols) {
    IntPtr h = CreateFileW("\\\\?\\" + p, 0x80, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new Exception("could not open " + p + ": error " + Marshal.GetLastWin32Error());
    try {
      string k = Key(h); if (k == null) throw new Exception("could not read the file id of " + p + ": error " + Marshal.GetLastWin32Error());
      ids.Add(k); long v = Vol(h); if (v < 0) throw new Exception("could not read the volume of " + p); vols.Add(v);
    } finally { CloseHandle(h); }
    WFD d; IntPtr fh = FindFirstFileW("\\\\?\\" + p + "\\*", out d);
    if (fh == new IntPtr(-1)) {
      int er = Marshal.GetLastWin32Error(); if (er == 267) return; // a file, not a folder
      throw new Exception("could not list " + p + ": error " + er);
    }
    var subs = new List<string>(); var files = new List<string>();
    try {
      do {
        if (d.Name == "." || d.Name == "..") continue;
        string c = p + "\\" + d.Name;
        if ((d.Attr & 0x10) != 0 && (d.Attr & 0x400) == 0) subs.Add(c); else files.Add(c);
      } while (FindNextFileW(fh, out d));
      int er = Marshal.GetLastWin32Error(); if (er != 18) throw new Exception("could not list " + p + ": error " + er);
    } finally { FindClose(fh); }
    foreach (var c in files) {
      IntPtr g = CreateFileW("\\\\?\\" + c, 0x80, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
      if (g == new IntPtr(-1)) throw new Exception("could not open " + c + ": error " + Marshal.GetLastWin32Error());
      try { string k = Key(g); if (k == null) throw new Exception("could not read the file id of " + c); ids.Add(k); } finally { CloseHandle(g); }
    }
    foreach (var c in subs) Ids(c, ids, vols);
  }

  // A file-backed view or section that can write (w5951's review): named under the folders, or a file there by its id
  // under the name it was mapped by. A name on the folders' volume that no longer opens (a second hard link deleted
  // since, a file renamed) cannot be ruled out, and counts.
  static string ViewHit(string nm, bool writable, List<string> dev, List<string> vdev, HashSet<string> ids) {
    if (Under(nm, dev)) return nm;
    if (!writable) return null;
    string l = nm.ToLowerInvariant(); bool same = false;
    foreach (var v in vdev) if (l.StartsWith(v + "\\")) same = true;
    if (!same) return null;
    IntPtr h = CreateFileW("\\\\?\\GLOBALROOT" + nm, 0x80, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return "a writable view of " + nm + ", a name that no longer opens (error " + Marshal.GetLastWin32Error() + ")";
    try { string k = Key(h); if (k == null) return "a writable view of " + nm + ", whose file id cannot be read"; return ids.Contains(k) ? nm : null; }
    finally { CloseHandle(h); }
  }

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
  // and granted access (PROCESS_HANDLE_TABLE_ENTRY_INFO, 40 bytes on x64: handle 0, access 24, type 28). The system-wide table is refused below SeDebugPrivilege.
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
      for (long i = 0; i < n; i++, e += 40) l.Add(new long[] { Marshal.ReadInt64(e, 0), Marshal.ReadInt32(e, 28), (uint)Marshal.ReadInt32(e, 24) });
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

  // File rights that change a file or folder: write, append, write EA, delete child, write attributes, delete, DACL, owner.
  const long FileWrite = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000;
  static bool WritableView(int prot) { return (prot & (0x04 | 0x40)) != 0; }

  public static string[] Find(string[] dirs, int[] skip, bool writesOnly) {
    if (IntPtr.Size != 8) throw new Exception("needs a 64-bit PowerShell");
    // Each folder in the final form Windows names an open file by, the DOS one and the device one (w5926's review): a short
    // 8.3 name, a junction, a symlink or a subst drive in the path as given would otherwise match no handle, and the read
    // would name nobody with no error. A folder that cannot be resolved fails the read, which is never "nobody".
    var dos = new List<string>(); var dev = new List<string>();
    foreach (var d0 in dirs) {
      IntPtr dh = CreateFileW(d0, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
      if (dh == new IntPtr(-1)) throw new Exception("could not open " + d0 + ": error " + Marshal.GetLastWin32Error());
      try {
        var sb = new StringBuilder(32768);
        int n = GetFinalPathNameByHandleW(dh, sb, 32768, 0); if (n <= 0 || n >= 32768) throw new Exception("could not resolve " + d0);
        string p = sb.ToString(); if (p.StartsWith("\\\\?\\")) p = p.Substring(4);
        dos.Add(p.TrimEnd('\\').ToLowerInvariant());
        sb = new StringBuilder(32768);
        n = GetFinalPathNameByHandleW(dh, sb, 32768, 2); if (n <= 0 || n >= 32768) throw new Exception("could not resolve " + d0 + " to its device");
        dev.Add(sb.ToString().TrimEnd('\\').ToLowerInvariant());
      } finally { CloseHandle(dh); }
    }
    // Every file and folder under them by identity (w5951's review, B1): a handle's path can be one Windows cannot name
    // any more (opened through a second hard link deleted since), so a File handle is matched by its file id, not by its
    // path. Any file or folder that cannot be identified fails the read.
    var ids = new HashSet<string>(); var vols = new HashSet<long>();
    foreach (var p in dos) Ids(p, ids, vols);
    var vdev = new List<string>();
    foreach (var p in dev) { var s = p.Split('\\'); if (s.Length >= 3) vdev.Add(string.Join("\\", s, 0, 3)); }
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
    var hit = new Dictionary<long, string>(); var procs = new Dictionary<long, IntPtr>(); long handles = 0; var unread = new HashSet<long>();
    Func<long, IntPtr> open = pid => { IntPtr h; if (!procs.TryGetValue(pid, out h)) { h = OpenProcess(0x40 | 0x400 | 0x10, false, (int)pid); procs[pid] = h; } return h; };
    foreach (var pid in low) {
      IntPtr ph = open(pid); var hs = ph == IntPtr.Zero ? null : Handles(ph);
      if (hs == null) { if (!Gone(pid)) unread.Add(pid); continue; }
      handles += hs.Count;
      foreach (var e in hs) {
        int t = (int)e[1]; if (t != fileT && t != secT) continue;
        bool writable = t == fileT ? (e[2] & FileWrite) != 0 : (e[2] & 0x2) != 0;
        if (writesOnly && !writable) continue;
        // A handle that can change a file and cannot be read here is never skipped (w5951's review, B1): it could be one
        // on the node.
        IntPtr dup;
        if (!DuplicateHandle(ph, new IntPtr(e[0]), self, out dup, 0, false, 2)) {
          // ERROR_INVALID_HANDLE: closed since the list was taken, so nothing writes through it (measured: a busy node's own).
          int er = Marshal.GetLastWin32Error();
          if (writable && er != 6 && !Gone(pid)) { hit[pid] = "a write handle this read could not copy (error " + er + ")"; break; }
          continue;
        }
        try {
          var sb = new StringBuilder(32768);
          if (t == fileT) {
            if (GetFileType(dup) != 1) continue;
            string k = Key(dup);
            if (k != null && ids.Contains(k)) {
              int m = GetFinalPathNameByHandleW(dup, sb, 32768, 0);
              hit[pid] = m > 0 && m < 32768 ? sb.ToString().Replace("\\\\?\\", "") : "a file of the node by its id " + k + ", under a name Windows no longer gives";
              break;
            }
            if (k == null && writable) {
              long v = Vol(dup);
              if (v < 0 || vols.Contains(v)) { hit[pid] = "a write handle on the node's volume whose file cannot be identified (error " + Marshal.GetLastWin32Error() + ")"; break; }
            }
            // A file made under the folders since their ids were read: by its path.
            int n = GetFinalPathNameByHandleW(dup, sb, 32768, 0); if (n <= 0 || n >= 32768) continue;
            string p = sb.ToString(); if (p.StartsWith("\\\\?\\")) p = p.Substring(4);
            if (Under(p, dos)) { hit[pid] = p; break; }
          } else {
            IntPtr v = MapViewOfFile(dup, 4, 0, 0, new IntPtr(1)); if (v == IntPtr.Zero) continue;
            try {
              if (GetMappedFileNameW(self, v, sb, 32768) > 0) { string h = ViewHit(sb.ToString(), writable, dev, vdev, ids); if (h != null) { hit[pid] = h; break; } }
            } finally { UnmapViewOfFile(v); }
          }
        } finally { CloseHandle(dup); }
      }
    }
    int ms = Marshal.SizeOf(typeof(MBI));
    foreach (var pid in low) {
      if (hit.ContainsKey(pid)) continue;
      if (unread.Contains(pid)) continue;
      IntPtr ph = open(pid); if (ph == IntPtr.Zero) { if (!Gone(pid)) unread.Add(pid); continue; }
      long a = 0; MBI m;
      while (VirtualQueryEx(ph, new IntPtr(a), out m, ms) == ms) {
        bool wv = WritableView(m.Protect) || WritableView(m.AllocProtect);
        if (m.Type == 0x40000 && m.State == 0x1000 && (!writesOnly || wv)) {
          var sb = new StringBuilder(32768);
          if (GetMappedFileNameW(ph, m.Base, sb, 32768) > 0) { string h = ViewHit(sb.ToString(), wv, dev, vdev, ids); if (h != null) { hit[pid] = h; break; } }
        }
        long nx = m.Base.ToInt64() + m.Size.ToInt64(); if (nx <= a) break; a = nx;
      }
    }
    foreach (var h in procs.Values) if (h != IntPtr.Zero) CloseHandle(h);
    var o = new List<string>();
    o.Add("read low=" + low.Count + " handles=" + handles + " unread=" + unread.Count);
    foreach (var kv in hit) {
      string name = "?"; try { name = Process.GetProcessById((int)kv.Key).ProcessName; } catch { }
      o.Add("holder " + kv.Key + " " + name.Replace(' ', '_') + " " + kv.Value);
    }
    return o.ToArray();
  }
}
`;

const CS_GZ = gzipSync(Buffer.from(CS, 'utf8'), { level: 9 }).toString('base64');

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The PowerShell that prints "read low=<n> handles=<n> unread=<n>", then "holder <pid> <name> <path>" for each process
 * below Medium that holds anything under `dirs` (with `writesOnly`, only access that can change it), leaving out `skip`.
 */
export function holdersScript(dirs: string[], skip: number[], writesOnly = true): string {
  // The C# goes gzipped: as plain text the -EncodedCommand (UTF-16, then base64) passed Windows' 32,767-character command
  // line once the file-id match was added (w5951's review: spawn ENAMETOOLONG at 44,508).
  return `$ErrorActionPreference = 'Stop'
$z = New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String('${CS_GZ}'))), [IO.Compression.CompressionMode]::Decompress)
Add-Type -TypeDefinition (New-Object IO.StreamReader($z, [Text.Encoding]::UTF8)).ReadToEnd()
foreach ($l in [FfHolders]::Find([string[]]@(${dirs.map(q).join(', ')}), [int[]]@(${[...skip, '$PID'].join(', ')}), $${writesOnly})) { $l }
`;
}

/** The holders the script printed; undefined when it did not finish its read (no "read" line). */
export function parseHolders(out: string): Holder[] | undefined {
  const lines = out.split(/\r?\n/);
  if (!lines.some((l) => /^read low=\d+ handles=\d+ unread=\d+$/.test(l.trim()))) return undefined;
  return lines.flatMap((l) => {
    const m = /^holder (\d+) (\S+) (.+)$/.exec(l.trim());
    return m ? [{ pid: Number(m[1]), name: m[2], path: m[3] }] : [];
  });
}

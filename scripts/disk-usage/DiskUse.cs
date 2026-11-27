using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Logical and physical (unique clusters) size of folders on ReFS / Dev Drive, where block clones make
// du count shared clusters once per file. Physical = the union of each file's cluster runs
// (FSCTL_GET_RETRIEVAL_POINTERS), so a cluster shared by clones or hard links counts once.
// Reparse points (junctions, symlinks) are never followed.
public static class DiskUse
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle h, uint code, ref long inBuf, int inSize, byte[] outBuf, int outSize, out int returned, IntPtr ov);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetDiskFreeSpaceW(string root, out uint spc, out uint bps, out uint free, out uint total);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WIN32_FIND_DATA { public uint attr; public uint c0, c1, a0, a1, w0, w1; public uint sizeHigh, sizeLow, r0, r1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string alt; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr FindFirstFileExW(string name, int level, out WIN32_FIND_DATA data, int op, IntPtr filter, int flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool FindNextFileW(IntPtr h, out WIN32_FIND_DATA data);
    [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr h);

    const uint FSCTL_GET_RETRIEVAL_POINTERS = 0x00090073;

    public class Result { public string Folder; public long Files, Dirs, Logical, Physical, Exclusive, NoExtentBytes, Skipped, Reparse, Errors; public double Seconds; }

    static long cluster;
    static byte[] buf = new byte[1 << 16];

    static void Extents(string file, List<long> runs, Result r, long len)
    {
        using (var h = CreateFileW(@"\\?\" + file, 0x80, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero))
        {
            if (h.IsInvalid) { r.Errors++; r.NoExtentBytes += len; return; }
            long vcn = 0; bool any = false;
            while (true)
            {
                int got;
                bool ok = DeviceIoControl(h, FSCTL_GET_RETRIEVAL_POINTERS, ref vcn, 8, buf, buf.Length, out got, IntPtr.Zero);
                int err = ok ? 0 : Marshal.GetLastWin32Error();
                if (!ok && err != 234) { if (!any) r.NoExtentBytes += len; return; }
                int count = BitConverter.ToInt32(buf, 0);
                long prev = BitConverter.ToInt64(buf, 8);
                for (int i = 0; i < count; i++)
                {
                    long next = BitConverter.ToInt64(buf, 16 + i * 16), lcn = BitConverter.ToInt64(buf, 24 + i * 16);
                    if (lcn >= 0) { runs.Add(lcn); runs.Add(next - prev); any = true; }
                    prev = next;
                }
                if (ok || count == 0) break;
                vcn = prev;
            }
            if (!any) r.NoExtentBytes += len;
        }
    }

    static void Walk(string dir, List<long> runs, Result r, bool physical, HashSet<string> skip)
    {
        var stack = new Stack<string>(); stack.Push(dir);
        while (stack.Count > 0)
        {
            var d = stack.Pop();
            if (skip.Contains(d.ToLowerInvariant())) { r.Skipped++; continue; }
            WIN32_FIND_DATA f;
            IntPtr h = FindFirstFileExW(@"\\?\" + d + @"\*", 1, out f, 0, IntPtr.Zero, 2);
            if (h == new IntPtr(-1)) { r.Skipped++; continue; }
            r.Dirs++;
            do
            {
                if (f.name == "." || f.name == "..") continue;
                string p = d + "\\" + f.name;
                if ((f.attr & 0x400) != 0) { r.Reparse++; continue; }
                if ((f.attr & 0x10) != 0) { stack.Push(p); continue; }
                long len = ((long)f.sizeHigh << 32) | f.sizeLow;
                r.Files++; r.Logical += len;
                if (physical) Extents(p, runs, r, len);
            } while (FindNextFileW(h, out f));
            FindClose(h);
        }
    }

    static long Union(List<long> runs)
    {
        int n = runs.Count / 2; var s = new long[n]; var e = new long[n];
        for (int i = 0; i < n; i++) { s[i] = runs[2 * i]; e[i] = runs[2 * i] + runs[2 * i + 1]; }
        Array.Sort(s, e);
        long total = 0, cs = -1, ce = -1;
        for (int i = 0; i < n; i++)
        {
            if (s[i] > ce) { if (ce > cs) total += ce - cs; cs = s[i]; ce = e[i]; }
            else if (e[i] > ce) ce = e[i];
        }
        if (ce > cs) total += ce - cs;
        return total * cluster;
    }

    // Each folder measured alone, then "ALL" = the union across them (clusters shared between folders once).
    public static List<Result> Measure(string[] folders, bool physical, string[] skipDirs)
    {
        uint spc, bps, fr, tot; GetDiskFreeSpaceW(Path.GetPathRoot(folders[0]), out spc, out bps, out fr, out tot);
        cluster = (long)spc * bps;
        var skip = new HashSet<string>(); foreach (var s in skipDirs) skip.Add(s.TrimEnd('\\').ToLowerInvariant());
        var all = new List<long>(); var each = new List<List<long>>(); var outp = new List<Result>(); var sum = new Result { Folder = "ALL" };
        foreach (var folder in folders)
        {
            var t = DateTime.UtcNow; var runs = new List<long>();
            var r = new Result { Folder = folder };
            Walk(folder.TrimEnd('\\'), runs, r, physical, skip);
            if (physical) { r.Physical = Union(runs) + r.NoExtentBytes; all.AddRange(runs); each.Add(runs); }
            r.Seconds = (DateTime.UtcNow - t).TotalSeconds; outp.Add(r);
            sum.Files += r.Files; sum.Dirs += r.Dirs; sum.Logical += r.Logical; sum.NoExtentBytes += r.NoExtentBytes; sum.Errors += r.Errors; sum.Seconds += r.Seconds;
            Console.Error.WriteLine(string.Format("{0}: {1:F1} GB logical, {2:F1} GB physical, {3} files, {4:F0} s", folder, r.Logical / 1e9, r.Physical / 1e9, r.Files, r.Seconds));
        }
        if (physical) {
            sum.Physical = Union(all) + sum.NoExtentBytes;
            // Exclusive: the clusters no other measured folder points at, what deleting this folder alone would free.
            for (int i = 0; i < each.Count && folders.Length > 1; i++) {
                var rest = new List<long>(all.Count);
                for (int j = 0; j < each.Count; j++) if (j != i) rest.AddRange(each[j]);
                outp[i].Exclusive = sum.Physical - sum.NoExtentBytes - Union(rest) + outp[i].NoExtentBytes;
            }
            if (folders.Length == 1) outp[0].Exclusive = outp[0].Physical;
        }
        outp.Add(sum);
        return outp;
    }
}

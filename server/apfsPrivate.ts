import { spawn } from 'node:child_process';

/**
 * What deleting each path would free on an APFS volume, by the file system's own count (w5319): the sum of every file's
 * ATTR_CMNEXT_PRIVATESIZE (getattrlist(2) with FSOPT_ATTR_CMN_EXTENDED), the bytes of it no other file shares. A `cp -c`
 * clone and its source both read 0 until one goes; stat sizes cannot see that (w5310).
 *
 * Why it is needed: on m5 on 2026-11-23 `ff-leftovers folders` promised 34.9 GB for 465 seed Library rows, and removing 379
 * of them (19,054 MB in their files) moved df by -17 MB. The seed (made 2026-10-07 00:58 in about 20 s, a clone) shares its
 * blocks with copies outside every folder a worker reads (an F_LOG2PHYS scan of sandboxes, player-cache, players, tmp and the
 * rest of ffw found none of them), so a same-path check of sandbox Libraries (clonedInSandboxes) saw 10 of 365 entries.
 * Measured then: seed Library/Artifacts 15,571 MB in files, 52 MB private; BurstCache 30,872 MB, 4,532 MB private; a fresh
 * 32 MB file and its `cp -c` clone 0 MB private each, an 8 MB file alone 8 MB.
 *
 * Node has no getattrlist, so macOS's own /usr/bin/python3 reads it through ctypes (shipped with macOS; the read is
 * metadata only). Answers undefined when that cannot run (not macOS, no python3, a timeout); a path any of whose files
 * could not be read answers null for that path: the caller keeps its own count and says it is unknown.
 */
export async function apfsPrivateBytes(paths: string[], o: { python?: string; timeoutMs?: number } = {}): Promise<(number | null)[] | undefined> {
  if (!paths.length) return [];
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: (number | null)[] | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(o.python ?? '/usr/bin/python3', ['-I', '-c', PRIVATE_PY], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return resolve(undefined);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, o.timeoutMs ?? 10 * 60_000);
    child.on('error', () => finish(undefined));
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => {
      if (code !== 0) return finish(undefined);
      try {
        const v = JSON.parse(out) as unknown;
        finish(Array.isArray(v) && v.length === paths.length && v.every((x) => x === null || typeof x === 'number') ? (v as (number | null)[]) : undefined);
      } catch {
        finish(undefined);
      }
    });
    child.stdin!.on('error', () => finish(undefined));
    child.stdin!.end(JSON.stringify(paths));
  });
}

/** Reads a JSON list of paths on stdin, prints a JSON list: each path's summed private bytes, or null when a file of it could not be read. */
const PRIVATE_PY = `
import ctypes, json, os, struct, sys
if sys.platform != 'darwin':
    sys.exit(2)
libc = ctypes.CDLL('/usr/lib/libc.dylib', use_errno=True)
class A(ctypes.Structure):
    _fields_ = [('n', ctypes.c_ushort), ('r', ctypes.c_uint16), ('c', ctypes.c_uint32), ('v', ctypes.c_uint32),
                ('d', ctypes.c_uint32), ('f', ctypes.c_uint32), ('k', ctypes.c_uint32)]
al = A(5, 0, 0, 0, 0, 0, 0x8)  # ATTR_CMNEXT_PRIVATESIZE
buf = ctypes.create_string_buffer(64)
def priv(p):
    if libc.getattrlist(os.fsencode(p), ctypes.byref(al), buf, 64, 0x1 | 0x20) != 0:  # FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED
        return None
    return struct.unpack_from('=Iq', buf.raw)[1]
def total(root):
    s = 0
    if os.path.islink(root):
        return 0
    if os.path.isfile(root):
        return priv(root)
    for d, _, fs in os.walk(root):
        for f in fs:
            q = os.path.join(d, f)
            if os.path.islink(q) or not os.path.isfile(q):
                continue
            v = priv(q)
            if v is None:
                if os.path.exists(q):
                    return None
                continue
            s += v
    return s
print(json.dumps([total(p) if os.path.lexists(p) else 0 for p in json.load(sys.stdin)]))
`;

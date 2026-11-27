/**
 * w5615, review w6212 B1/B2: the daemon copies and writes for the players broker and the slot caches without lending a
 * worker its own rights. Every copy whose source a worker can change (its build, its cache clone, under "warn" the shared
 * seeds too) runs with a worker's rights on this machine, never the daemon's:
 * - macOS: inside the workers' Seatbelt profile (server/workerFence.ts) with its read rules on, the target's folder writable;
 * - Linux: under ff-landlock.py with the workers' write lock and its read half (machine/writeLock.ts);
 * - Windows: in the Low node copy (machine/lowIntegrity.ts LowCopies), so it reads only what a Low worker reads.
 * A link or junction in the source then reaches only what the worker could read anyway, and so does a folder swapped for
 * one while the copy runs (the check-then-copy race of a copy made with the daemon's rights). Where this machine has no
 * worker fence the workers' reads are not fenced either, so the plain copy adds nothing they could not read; it still
 * never follows a link inside the tree (cp -R copies a link as a link; the Windows walk below never enters one).
 * A built player holds no link (measured: none in m5's players/slot1-0, a Mac .app): with `links: "refuse"` a copy that
 * holds one is removed and refused, so nothing the daemon later writes or deletes inside it goes through a link.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fencedArgv, type WorkerFence } from '../server/workerFence.ts';
import { FF_LANDLOCK } from './writeLock.ts';

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * The first link in a tree (its relative path; '.' for the top itself), or undefined. Node's lstat and readdir report a
 * Windows junction or symbolic link as a symbolic link, so this finds both.
 */
export function linkIn(tree: string): string | undefined {
  const st = fs.lstatSync(tree);
  if (st.isSymbolicLink()) return '.';
  if (!st.isDirectory()) return undefined;
  const walk = (rel: string): string | undefined => {
    for (const e of fs.readdirSync(path.join(tree, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) return r;
      if (e.isDirectory()) {
        const x = walk(r);
        if (x) return x;
      }
    }
    return undefined;
  };
  return walk('');
}

/**
 * A plain folder (not a link or junction, nor below one) at `base/rel`: `dir` itself is no link, and its real path is
 * `rel` under the real `base`. The daemon checks this before it writes or deletes in a folder a worker can change.
 */
export function plainDirAt(dir: string, base: string, rel: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  } catch {
    return false;
  }
  const want = path.join(real(base), rel);
  const got = real(dir);
  return process.platform === 'win32' ? got.toLowerCase() === want.toLowerCase() : got === want;
}

/**
 * Write a file without following a link at its name: a link (or file) there is removed first, then the file is made new
 * (`wx`: O_CREAT|O_EXCL never follows a link, and fails if one was planted in between).
 */
export function writeNew(file: string, data: string): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, data, { flag: 'wx' });
}

/** writeNew beside it under a fresh name, then renamed over `file` (a rename replaces a link at `file`, never follows it). */
export function writeFileSafe(file: string, data: string): void {
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeNew(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The Windows copy, run by the Low node (`node -e LOW_COPY_SCRIPT <src> <dst> <keep|refuse>`). A folder walk that never
 * enters a link: with `keep` a junction or link is made again as one (the same target; a worker reads through it with its
 * own rights), with `refuse` the first one ends it with exit 3. Files go through CopyFileW (copyFileSync), which
 * block-clones on a ReFS Dev Drive as Copy-Item did. The target must not exist yet.
 */
export const LOW_COPY_SCRIPT =
  "const fs=require('node:fs'),path=require('node:path');const[,src,dst,mode]=process.argv;let skipped=0;" +
  "function cp(s,d){const st=fs.lstatSync(s);if(st.isSymbolicLink()){if(mode!=='keep'){console.error('a link: '+s);process.exit(3)}" +
  "const t=fs.readlinkSync(s);let dir=false;try{dir=fs.statSync(s).isDirectory()}catch{}try{fs.symlinkSync(t,d,dir?'junction':'file')}catch{skipped++}return}" +
  "if(st.isDirectory()){fs.mkdirSync(d);for(const e of fs.readdirSync(s))cp(path.join(s,e),path.join(d,e));return}" +
  "if(st.isFile()){fs.copyFileSync(s,d,fs.constants.COPYFILE_EXCL);return}skipped++}" +
  "cp(src,dst);console.log('skipped '+skipped)";

export type Ran = { code: number; stdout: string; stderr: string };

export interface WorkerCopyDeps {
  platform?: NodeJS.Platform;
  /** macOS: the workers' Seatbelt fence on this machine (its read rules are switched on for the copy), or undefined. */
  macFence?: () => WorkerFence | undefined;
  /** Linux: ff-landlock.py's arguments for a worker, its write lock and read half, or undefined with no lock. */
  linuxLock?: () => string[] | undefined;
  /** Windows: the Low node copy, or undefined when none can be made. */
  lowNode?: () => string | undefined;
  run: (cmd: string, argv: string[]) => Promise<Ran>;
  removeTree: (dir: string) => Promise<void>;
}

export type WorkerCopy = (src: string, dst: string, o: { links: 'keep' | 'refuse' }) => Promise<void>;

/** The copy with a worker's rights (see the top of this file). `dst` must not exist; its folder must. */
export function workerCopier(d: WorkerCopyDeps): WorkerCopy {
  const platform = d.platform ?? process.platform;
  return async (src, dst, o) => {
    const s = real(src);
    if (o.links === 'refuse') {
      const l = linkIn(s);
      if (l) throw new Error(`${s} holds a link or junction (${l}); a build to copy holds none`);
    }
    const parent = real(path.dirname(dst));
    let cmd: string;
    let argv: string[];
    if (platform === 'win32') {
      const node = d.lowNode?.();
      if (!node) throw new Error("no Low node copy to copy with; a worker's files are never copied with the daemon's rights");
      [cmd, argv] = [node, ['-e', LOW_COPY_SCRIPT, s, dst, o.links]];
    } else {
      const cp = platform === 'darwin' ? ['/bin/cp', '-cR', s, dst] : ['cp', '-a', '--reflink=auto', s, dst];
      const fence = platform === 'darwin' ? d.macFence?.() : undefined;
      const lock = platform === 'linux' ? d.linuxLock?.() : undefined;
      if (fence) {
        const [c, ...a] = fencedArgv({ ...fence, readOff: false, extraWritable: [...(fence.extraWritable ?? []), parent] }, cp[0], cp.slice(1));
        [cmd, argv] = [c, a];
      } else if (lock) [cmd, argv] = ['python3', [FF_LANDLOCK, ...lock, '--rw', parent, '--', ...cp]];
      else [cmd, argv] = [cp[0], cp.slice(1)];
    }
    const r = await d.run(cmd, argv);
    if (r.code !== 0) {
      await d.removeTree(dst).catch(() => undefined);
      throw new Error(`copying ${s} failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
    }
    if (o.links === 'refuse' && fs.existsSync(dst)) {
      const l = linkIn(dst);
      if (l) {
        await d.removeTree(dst).catch(() => undefined);
        throw new Error(`the copy of ${s} held a link or junction (${l}); removed`);
      }
    }
  };
}

/**
 * The Windows worker fence (w5377, the design in docs/worker-root.md 4.1): sandbox agents run at Low integrity, so
 * Windows' no-write-up rule refuses their writes to anything not labelled Low. The daemon labels the worker root's
 * folders that workers write (WORKER_CHILDREN) Low (each with (OI)(CI), so what is made in them later is Low too), keeps
 * every other root folder Medium (w5539), and starts each sandbox agent's claude from
 * a Low-labelled copy of the claude executable; a process started from a Low-labelled file runs at Low, and everything
 * it starts (Bash, git, gh, batch Unity, players) inherits Low (both measured on LothDesktop, w5333 and w5377).
 *
 * Off by default: daemon.json `workerIntegrity: "low"` turns it on, on Windows only. The root itself stays Medium: a Low
 * label on it would give Low processes delete-child over `secrets`. `daemon`, `secrets` and the daemon's own folder stay
 * Medium (a worker cannot rewrite the daemon's code or its tokens), and `repo`, the bare git store every sandbox is a
 * worktree of, is labelled whole (sandbox worktrees commit there); a `repo` with a working tree gets only its `.git`.
 *
 * Not a boundary against a malicious worker: the sandbox editor the daemon starts is Medium and compiles what workers
 * write. It stops accidental writes outside the root, which is lothsahn's rule ("under no circumstances should workers
 * write outside of ffw").
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_ONLY_CHILDREN, MEDIUM_ONLY_CHILDREN, STEAM_CHILD, STEAM_SECRET_FILES } from '../server/claudeHome.ts';

export const LOW_LABEL = '(OI)(CI)low';
/** An explicit Medium label, which overrides the Low one a folder inherits (measured, w5377). */
export const MEDIUM_LABEL = '(OI)(CI)medium';
/**
 * Root children that stay Medium (writeLock.ts LOCKED_CHILDREN, plus the root's own record), the Medium agents' Claude Code
 * folder among them (w5543): a Low worker must not plant a hook or plugin that a Medium agent loads.
 */
export const MEDIUM_CHILDREN = ['daemon', 'secrets', ...MEDIUM_ONLY_CHILDREN];
/**
 * Root children that hold CI runners, which are not worker agents (w5440): they stay Medium, explicitly where an earlier
 * rollout labelled them Low. A runner's Runner.Worker.exe is started per job from its bin folder, and a process started
 * from a Low-labelled exe runs at Low, so a Low runner folder ran every job at Low, where Git Bash's msys dies at start
 * (NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...): 0xC0000022; BEAST's ffu runners, 2026-11-24 from 12:34Z).
 * Medium also keeps Low workers off the runners' .credentials.
 */
export const CI_CHILDREN = ['ffu-runners'];
/**
 * The root children workers write, the only ones labelled Low (w5539). Every other folder in the root stays Medium, so a
 * folder added there later is out of the workers' reach until it is listed here: before, every child but daemon and
 * secrets was labelled Low, and on BEAST that reached `instances` (update-all.ts, which a scheduled task runs at Medium
 * every 5 minutes), `demos` and the instance portals `ben-factory` and `lens-factory`, whose config holds vault, ledger
 * and Claude keys (w5451 audit, measured: Low labels and mkdir probes from a Low worker). Each name is one some worker
 * tool writes: docs/worker-root.md 2.1 and 4.1 say which.
 */
// Not `steam` (w5551): steamcmd's folder, its config and cached login are the daemon's alone (machine/steamUpload.ts);
// a worker uploads through steam_upload. `gamedata-home` (w5579): FF_PLAYER_HOME, the home every player a worker starts
// gets on Linux and macOS (gameData.ts workerPlayerHomeDir); left out, a fenced worker's player could not write its prefs.
export const WORKER_CHILDREN = [
  'agents', 'cache', 'claude', 'ffu-sandboxes', 'gamedata', 'gamedata-home', 'home', 'logs', 'nightly', 'nightly-history',
  'player-cache', 'players', 'release-records', 'repo', 'sandboxes', 'scratch', 'seed', 'steam-lobby-gate',
  'test-history', 'tmp', 'tools', 'unity-slots', 'voice',
];

/**
 * The root children the Linux Landlock lock and the Mac Seatbelt fence open to workers (w5569): WORKER_CHILDREN, plus the
 * root child that holds each `extra` the config puts in the root (its temp or sandboxes folder elsewhere than tmp and
 * sandboxes), less `closed` (daemon, secrets, the daemon's own folder). Names as written: these file systems match case.
 */
export function openChildren(root: string, extra: (string | undefined)[] = [], closed: Iterable<string> = MEDIUM_CHILDREN): string[] {
  const shut = new Set(closed);
  const open = new Set(WORKER_CHILDREN);
  for (const e of extra) if (e && inside(path.resolve(e), path.resolve(root)) && !same(e, root)) open.add(path.relative(path.resolve(root), path.resolve(e)).split(/[\\/]/)[0]);
  return [...open].filter((c) => !shut.has(c)).sort();
}

export interface LowTargetsInput {
  root: string;
  /** The daemon's folder: kept Medium where it sits inside the root. */
  appDir: string;
  /** The root's children (names), as listed now. */
  children: { name: string; dir: boolean }[];
  /** Folders of the install outside the root, and the sandboxes' and temp folders where they are elsewhere. */
  extra?: (string | undefined)[];
  /**
   * The children of `<root>/tools` (w5717), as listed now. Given, `tools` itself turns Medium and each child folder but
   * `node` is labelled Low on its own, so a Low worker keeps writing cargo, rustup, git and the rest but can no longer
   * rename or delete `tools/node` (a Low parent's FILE_DELETE_CHILD let it). Left out: the old layout, `tools` Low.
   */
  toolsChildren?: { name: string; dir: boolean }[];
  /** Single files outside the Low folders a worker must write (the Max events file). */
  files?: (string | undefined)[];
  /** Extras the daemon owns that a worker must write although they sit in the daemon's folder (the Unity slots mailbox). */
  allowInAppDir?: (string | undefined)[];
  exists?: (p: string) => boolean;
  /**
   * w5614: the store lock holds (machine/storeLock.ts): the main clone's git folder is labelled Medium (No-Write-Up), so Low
   * workers read it (the slot repos' borrowed objects) and cannot write it. Off, it is labelled Low as before.
   */
  lockStore?: boolean;
}

const inside = (child: string, parent: string) => {
  const r = path.relative(parent, child);
  return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r));
};
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The folders and files to label Low. Exported for tests. */
export function lowTargets(i: LowTargetsInput): { dirs: string[]; files: string[]; medium: string[] } {
  const exists = i.exists ?? fs.existsSync;
  // The daemon's and the secrets' folders, and the daemon's own where it sits in the root: never labelled, either way.
  const keep = new Set(MEDIUM_CHILDREN.map((c) => c.toLowerCase()));
  if (inside(i.appDir, i.root) && !same(i.appDir, i.root)) keep.add(path.relative(i.root, i.appDir).split(/[\\/]/)[0].toLowerCase());
  const write = new Set(WORKER_CHILDREN.filter((c) => !keep.has(c)));
  // An extra the config puts inside the root (its temp or sandboxes folder elsewhere than tmp and sandboxes) makes its root
  // child a worker one too.
  for (const e of i.extra ?? []) if (e && inside(e, i.root) && !same(e, i.root)) write.add(path.relative(i.root, e).split(/[\\/]/)[0].toLowerCase());
  for (const k of keep) write.delete(k);
  const dirs: string[] = [];
  // Root children no worker writes (the instances, demos and instance portals on BEAST, CI runners, anything new): kept
  // Medium where an earlier rollout labelled them Low (labelLow touches only those that inherited Low).
  const fenced: string[] = [];
  const lockedStore: string[] = [];
  for (const c of i.children) {
    if (!c.dir) continue;
    if (!write.has(c.name.toLowerCase())) {
      if (!keep.has(c.name.toLowerCase())) fenced.push(path.join(i.root, c.name));
      continue;
    }
    if (c.name.toLowerCase() === 'repo') {
      // A worker install's repo is one bare store every sandbox is a worktree of (worker.ts cloneRepo): label all of it,
      // as Landlock and Seatbelt already let workers write it. A clone with a working tree: only its .git.
      const repo = path.join(i.root, c.name);
      const git = path.join(repo, '.git');
      const store = exists(git) ? git : exists(path.join(repo, 'HEAD')) ? repo : undefined;
      if (store) (i.lockStore ? lockedStore : dirs).push(store);
      continue;
    }
    dirs.push(path.join(i.root, c.name));
  }
  // lowEnv's APPDATA and LOCALAPPDATA live here; labelLow makes it when it is missing.
  if (!i.children.some((c) => c.name.toLowerCase() === 'home')) dirs.push(path.join(i.root, 'home'));
  for (const e of i.extra ?? []) {
    if (!e || inside(e, i.root) || dirs.some((d) => same(d, e))) continue;
    if (inside(e, i.appDir) && !(i.allowInAppDir ?? []).some((a) => !!a && same(a, e))) continue;
    dirs.push(e);
  }
  const files = (i.files ?? []).filter((f): f is string => !!f && !dirs.some((d) => inside(f, d)));
  // The agents' node (server/agentNode.ts, first on every agent's PATH) keeps Medium inside a Low tools folder: a process
  // started from a Low-labelled exe runs at Low, so a Medium agent's node would be Low and the machine's Git it starts
  // would crash (0xC0000022 on msys' shared object directory; measured w5377). A Low agent's node is Low anyway (a Low
  // parent starts Low children), and a worker cannot rewrite the shared node.
  //
  // w5717: inside a Low tools folder a Low worker could still rename `tools/node` away (the parent's
  // FILE_DELETE_CHILD grants DELETE whatever the child's label; measured on LothDesktop) and put its own node.exe there, which every
  // Medium agent, BEAST's instance portals and the elevated `worker.ts tools` run next. So, given the tools folder's
  // children, `tools` itself is kept Medium and each child folder but node is labelled Low on its own first (labelLow
  // labels `dirs` before `medium`, and asks a child of a Medium folder for its own Low label, not an inherited one).
  // The path of node stays, so the firewall rule "Final Factory agent node" still names it. Files right in tools stay
  // Medium: only the daemon and `worker.ts tools` write there (the agent Git's stamp, server/agentGit.ts).
  //
  // w5838: `low` (the Low copies of claude, node and gh the daemon runs, lowCopy), `unity-low` (the junctions Low editors
  // start Unity through) and `shims` (unity-slot, ff-pr, ff-leftovers and ffu-slot, first on every agent's PATH, Medium
  // ones included) are the daemon's alone too: Low, a worker could plant a DLL beside a copy, swap a junction for its own
  // Unity.exe, or rewrite a shim a Medium agent then runs. Kept Medium, a Low worker reads and runs them and writes none.
  const tools = path.join(i.root, 'tools');
  const medium: string[] = [];
  const at = dirs.findIndex((d) => same(d, tools));
  if (at >= 0) {
    if (i.toolsChildren) {
      dirs.splice(at, 1, ...i.toolsChildren.filter((c) => c.dir && !MEDIUM_TOOLS.includes(c.name.toLowerCase())).map((c) => path.join(tools, c.name)));
      medium.push(tools, ...MEDIUM_TOOLS.map((c) => path.join(tools, c)));
    } else medium.push(path.join(tools, 'node'));
  }
  medium.push(...fenced, ...lockedStore);
  return { dirs, files, medium };
}

/** The children of `<root>/tools` only the daemon and `worker.ts tools` write, kept Medium (w5717 node; w5838 the rest). */
export const MEDIUM_TOOLS = ['node', 'low', 'unity-low', 'shims'];

/** Where the daemon writes the workers' shims on Windows with a root (w5838): a Medium folder, not the Low slots mailbox. */
export const toolsShimsDir = (root: string) => path.join(root, 'tools', 'shims');

type Ran = { code: number | null; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[], o?: { timeoutMs?: number }) => Promise<Ran>;

/** Whether icacls says this path carries an explicit or inherited Low mandatory label. Exported for tests. */
export const isLabelledLow = (icaclsOut: string) => /Mandatory Label\\Low Mandatory Level/i.test(icaclsOut);
/** Whether icacls says this path carries a Low label of its own, not an inherited one (`(I)`). Exported for tests. */
export const isExplicitLow = (icaclsOut: string) => /Mandatory Label\\Low Mandatory Level:(?!\(I\))/i.test(icaclsOut);

/**
 * Labels each target Low unless it is already, and says what it did. icacls' label on a folder with (OI)(CI) reaches
 * the files already in it (measured, w5333). Never throws: a target it cannot label is reported, and the caller runs its
 * agents unfenced when any failed.
 *
 * Setting a mandatory label needs WRITE_OWNER on the path. An owner has only READ_CONTROL and WRITE_DAC by right, so where
 * the account's write comes from a group ACE (BEAST's F:\ffw inherits Authenticated Users:(M) from the drive, and the
 * daemon's token is not elevated, so Administrators:(F) does not count) icacls answers "Access is denied". The owner may
 * still change the DACL, so labelLow then grants the account Full on the path and labels it again (measured on BEAST,
 * w5402: denied, then the grant, then the label succeeds and reaches the files inside).
 */
export async function labelLow(t: { dirs: string[]; files: string[]; medium?: string[] }, exec: Exec, say: (line: string) => void, account = currentAccount()): Promise<boolean> {
  let ok = true;
  const setLabel = async (p: string, label: string) => {
    let r = await exec('icacls', [p, '/setintegritylevel', label], { timeoutMs: 30 * 60_000 });
    if (r.code !== 0 && account && /access is denied/i.test(r.stderr + r.stdout)) {
      const g = await exec('icacls', [p, '/grant', `${account}:${label.startsWith('(OI)') ? '(OI)(CI)' : ''}F`], { timeoutMs: 30 * 60_000 });
      if (g.code === 0) {
        say(`worker integrity: gave ${account} Full on ${p}, which setting its label needs (WRITE_OWNER)`);
        r = await exec('icacls', [p, '/setintegritylevel', label], { timeoutMs: 30 * 60_000 });
      }
    }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300));
  };
  // A target right inside a folder kept Medium (w5717: `tools`) needs a Low label of its own: an inherited one turns
  // Medium with its parent.
  const own = (p: string) => (t.medium ?? []).some((m) => same(path.dirname(p), m));
  const failed: string[] = [];
  const one = async (p: string, label: string) => {
    try {
      if (!fs.existsSync(p)) {
        if (label === LOW_LABEL) fs.mkdirSync(p, { recursive: true });
        else fs.writeFileSync(p, '', { flag: 'a' });
      }
      const now = await exec('icacls', [p], { timeoutMs: 60_000 });
      if (now.code === 0 && (own(p) ? isExplicitLow(now.stdout) : isLabelledLow(now.stdout))) return;
      await setLabel(p, label);
      say(`worker integrity: labelled ${p} Low`);
    } catch (e) {
      ok = false;
      failed.push(p);
      say(`worker integrity: could not label ${p} Low: ${(e as Error).message}`);
    }
  };
  for (const d of t.dirs) await one(d, LOW_LABEL);
  for (const f of t.files) await one(f, 'low');
  // Folders kept Medium inside a Low one (lowTargets' medium): only those that exist and inherited Low. A failure here
  // leaves the fence whole (only a Medium agent's node is affected), so it is said and not counted.
  for (const p of t.medium ?? []) {
    try {
      if (!fs.existsSync(p)) continue;
      const now = await exec('icacls', [p], { timeoutMs: 60_000 });
      if (now.code !== 0 || !isLabelledLow(now.stdout)) continue;
      // A child that could not get its own Low label would turn Medium with its parent, and workers could no longer write it.
      const stuck = failed.filter((f) => same(path.dirname(f), p));
      if (stuck.length) {
        say(`worker integrity: left ${p} Low: ${stuck.join(', ')} could not be labelled Low on its own`);
        continue;
      }
      await setLabel(p, MEDIUM_LABEL);
      say(`worker integrity: kept ${p} Medium`);
    } catch (e) {
      say(`worker integrity: could not keep ${p} Medium: ${(e as Error).message}`);
    }
  }
  // w5717: once their parent is Medium, the children it holds are read again; one that lost its Low label is labelled again.
  for (const d of t.dirs.filter(own)) await one(d, LOW_LABEL);
  for (const f of t.files.filter(own)) await one(f, 'low');
  return ok;
}

/**
 * The CI runners whose job process would start at Low (w5440): each `<root>/<CI child>/<runner>/bin/Runner.Worker.exe`
 * that icacls says is labelled Low. The daemon checks this after labelling and says it loudly, since such a runner fails
 * every Windows job before its first step. Exported for tests.
 */
export async function lowRunners(root: string, exec: Exec, o: { list?: (dir: string) => string[]; exists?: (p: string) => boolean } = {}): Promise<string[]> {
  const list = o.list ?? ((d: string) => { try { return fs.readdirSync(d); } catch { return []; } });
  const exists = o.exists ?? fs.existsSync;
  const low: string[] = [];
  for (const c of CI_CHILDREN) {
    for (const r of list(path.join(root, c))) {
      const exe = path.join(root, c, r, 'bin', 'Runner.Worker.exe');
      if (!exists(exe)) continue;
      const now = await exec('icacls', [exe], { timeoutMs: 60_000 });
      if (now.code === 0 && isLabelledLow(now.stdout)) low.push(exe);
    }
  }
  return low;
}

/** The account the daemon runs as, as icacls names it (DOMAIN\\user), or undefined off Windows. */
export const currentAccount = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.USERNAME ? (env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME) : undefined;

export const lowToolsDir = (root: string) => path.join(root, 'tools', 'low');

/** A run that waits for its answer: the Low copies' checks happen in runSpec, which is synchronous (w5838). */
export type ExecSync = (cmd: string, args: string[]) => Ran;

export const execSync: ExecSync = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr || (r.error ? r.error.message : '') };
};

/** A file's SHA-256, read in 1 MB pieces: about 250 ms for claude.exe's 300 MB (measured on BEAST, w5838). */
export function fileHash(p: string): string {
  const h = createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * What a file's stat shows of a change: any write moves its change time, and setting that back needs
 * FILE_WRITE_ATTRIBUTES, which a read-only copy refuses a Low process; a new file has a new file id (ino).
 */
const statKey = (st: fs.Stats) => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;

/**
 * icacls' arguments that leave a copy read-only to the account (w5838): no inherited entries, read and run for the account
 * and for OWNER RIGHTS (which takes away the owner's implicit WRITE_DAC), Full for SYSTEM and Administrators. Measured on
 * BEAST from a Low process: the copy still runs; a write, an append, a new grant and a new label are refused. The daemon
 * still removes or replaces it through the folder's delete-child right (measured: Node's rmSync and renameSync).
 */
export const readOnlyGrants = (account: string) => ['/inheritance:r', '/grant:r', '*S-1-3-4:(RX)', `${account}:(RX)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'];

/** Whether icacls shows the read-only entries readOnlyGrants sets, and none inherited. Exported for tests. */
export const isReadOnlyCopy = (icaclsOut: string) => /OWNER RIGHTS:\(RX\)/i.test(icaclsOut) && !/\(I\)/.test(icaclsOut);

/**
 * The Low-labelled copies of claude, node and gh in `<root>\tools\low` the daemon runs (w5333, w5540, w5430): a process
 * started from a Low-labelled file runs at Low. Each is named by its source's size and mtime, so a new claude gets a new
 * copy; copies of older builds are removed when nothing runs them.
 *
 * w5838: a Low worker can write a Low-labelled file, so before this one could replace a copy and have the next agent, editor
 * or probe run its program with what the daemon passes in (another person's vault tokens, for an agent). Now:
 * - the folder is Medium (lowTargets, MEDIUM_TOOLS): a worker cannot add, rename or delete a file there, nor plant a DLL;
 * - each copy is read-only (readOnlyGrants), so a worker cannot rewrite it either; where icacls cannot do that, it says
 *   so and the copy is hashed in full before every run instead;
 * - `check` before every run: the copy still has its source's bytes (a full hash, or the stat seen at the last hash for a
 *   read-only copy), else it is made again from the source, with a WARNING in the log.
 */
export class LowCopies {
  private copies = new Map<string, { source: string; key: string; readOnly: boolean }>();
  private sources = new Map<string, { key: string; hash: string }>();

  private root: string;
  private say: (line: string) => void;
  private exec: ExecSync;
  private account: string | undefined;
  private hash: (p: string) => string;

  constructor(root: string, say: (line: string) => void, exec: ExecSync = execSync, account: string | undefined = currentAccount(), hash: (p: string) => string = fileHash) {
    this.root = root;
    this.say = say;
    this.exec = exec;
    this.account = account;
    this.hash = hash;
  }

  private sourceHash(exe: string): string {
    const key = statKey(fs.statSync(exe));
    const had = this.sources.get(exe);
    if (had?.key === key) return had.hash;
    const hash = this.hash(exe);
    this.sources.set(exe, { key, hash });
    return hash;
  }

  /** The Low copy of `exe`, made or checked now; undefined (and says why) when it cannot be made: the caller decides. */
  make(exe: string): string | undefined {
    try {
      const st = fs.statSync(exe);
      const dir = lowToolsDir(this.root);
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(exe, path.extname(exe));
      const name = `${base}-${st.size}-${Math.floor(st.mtimeMs)}${path.extname(exe)}`;
      const copy = path.join(dir, name);
      const want = this.sourceHash(exe);
      if (fs.existsSync(copy) && this.hash(copy) !== want) {
        this.say(`worker integrity: WARNING: the Low copy ${copy} is not ${exe} (its bytes differ); made again (w5838)`);
        fs.rmSync(copy, { force: true });
      }
      if (fs.existsSync(copy)) {
        // An earlier copy inherited Low from a Low folder; with the folder Medium (w5838) it needs a label of its own. A
        // read-only copy cannot be labelled again (no WRITE_OWNER): it is made again instead.
        const now = this.exec('icacls', [copy]);
        if (!(now.code === 0 && isLabelledLow(now.stdout)) && this.exec('icacls', [copy, '/setintegritylevel', 'low']).code !== 0) fs.rmSync(copy, { force: true });
      }
      if (!fs.existsSync(copy)) {
        const part = `${copy}.part`;
        fs.rmSync(part, { force: true });
        fs.copyFileSync(exe, part);
        fs.renameSync(part, copy);
        const r = this.exec('icacls', [copy, '/setintegritylevel', 'low']);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300));
      }
      let readOnly = isReadOnlyCopy(this.exec('icacls', [copy]).stdout);
      if (!readOnly) {
        const r = this.account ? this.exec('icacls', [copy, ...readOnlyGrants(this.account)]) : undefined;
        readOnly = r?.code === 0;
        if (!readOnly) this.say(`worker integrity: WARNING: could not make the Low copy ${copy} read-only (${r ? (r.stderr || r.stdout).trim().slice(-200) : 'no account name'}); it is hashed in full before every run instead (w5838)`);
      }
      // Checked once it is labelled and read-only, so nothing written before that is run.
      if (this.hash(copy) !== want) throw new Error(`its bytes differ from ${exe} after copying`);
      this.copies.set(copy, { source: exe, key: statKey(fs.statSync(copy)), readOnly });
      for (const old of fs.readdirSync(dir)) {
        if (old !== name && old.startsWith(`${base}-`)) {
          try {
            fs.rmSync(path.join(dir, old), { force: true });
            this.copies.delete(path.join(dir, old));
          } catch {
            /* still running: the next start removes it */
          }
        }
      }
      return copy;
    } catch (e) {
      this.say(`worker integrity: could not make a Low copy of ${exe}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Before each run of `copy` (w5838): the path to run, which is `copy` while it still has its source's bytes, else a copy
   * made again from the source (a new path when the source changed). Undefined when `copy` is not one of this daemon's or
   * cannot be made again: the caller does not run it.
   */
  check(copy: string): string | undefined {
    const c = this.copies.get(copy);
    if (!c) return undefined;
    try {
      const st = fs.statSync(copy);
      const sourceSame = this.sources.get(c.source)?.key === statKey(fs.statSync(c.source));
      if (c.readOnly && sourceSame && c.key === statKey(st)) return copy;
      if (sourceSame && this.hash(copy) === this.sourceHash(c.source)) {
        c.key = statKey(st);
        return copy;
      }
      if (sourceSame) this.say(`worker integrity: WARNING: the Low copy ${copy} was changed since it was made from ${c.source}; made again before this run (w5838)`);
    } catch (e) {
      this.say(`worker integrity: WARNING: the Low copy ${copy} could not be checked (${(e as Error).message}); made again before this run (w5838)`);
    }
    return this.make(c.source);
  }
}

/**
 * What a Low agent's environment changes: the per-user folders programs write without asking (APPDATA, LOCALAPPDATA)
 * move into the root, since a Low process cannot write the person's own. TEMP and TMP are already the session's folder in
 * the root (daemon sessionTempEnv). The Git for Low workers (server/agentGit.ts) goes first on PATH and is Claude Code's
 * Git Bash: the machine's Git, at its own path, crashes at Low (0xC0000022 opening msys' shared object directory, which a
 * Medium msys made first; measured w5333), and a copy at another path gets its own.
 *
 * w5430: gh keeps its login in `%APPDATA%\GitHub CLI` unless GH_CONFIG_DIR names a folder, so the APPDATA move hid the
 * machine's gh login from every Low worker ("You are not logged into any GitHub hosts"; `ff-pr push` and `gh pr create`
 * failed on LothDesktop and BEAST). `ghConfigDir` (ghConfigDirFor, the daemon user's own login) puts it back as
 * GH_CONFIG_DIR: gh reads that folder and the Windows keyring at Low (measured w5427, "Logged in to github.com account
 * Lothsahn (keyring)"), and no token is copied anywhere. server/launch.ts gives git gh as its github.com helper for it.
 */
export function lowEnv(root: string, gitDir: string | undefined, pathKey: string, pathNow: string | undefined, ghConfigDir?: string): Record<string, string> {
  const home = path.join(root, 'home');
  return {
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ...(ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {}),
    ...(gitDir
      ? {
          CLAUDE_CODE_GIT_BASH_PATH: path.join(gitDir, 'bin', 'bash.exe'),
          [pathKey]: [path.join(gitDir, 'cmd'), path.join(gitDir, 'usr', 'bin'), pathNow].filter(Boolean).join(path.delimiter),
        }
      : {}),
  };
}

/**
 * The daemon user's own gh login folder, for a Low worker's GH_CONFIG_DIR (w5430, lowEnv): the daemon's GH_CONFIG_DIR when
 * set, else `%APPDATA%\GitHub CLI` when gh has logged in there (its hosts.yml). Undefined when gh has no login here.
 */
export function ghConfigDirFor(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (!env.APPDATA) return undefined;
  const dir = path.join(env.APPDATA, 'GitHub CLI');
  return exists(path.join(dir, 'hosts.yml')) ? dir : undefined;
}

export const lowUnityDir = (root: string) => path.join(root, 'tools', 'unity-low');

/**
 * Junctions `<root>\tools\unity-low\<version>` to each installed editor's `Editor` folder, for FF_UNITY_EDITOR_ROOT
 * (the game repo's scripts start a Windows batch Unity from `$FF_UNITY_EDITOR_ROOT/<version>/Unity.exe` when it is set).
 * Unity's Roslyn names its compiler server's pipe from the compiler's folder, so a Low Unity started through a junction
 * gets its own Low server and no Medium editor's compile can reach it (measured, w5347; docs/worker-root.md 4.1). The
 * junctions live in the root; nothing on the install's drive is written. Returns the versions it has.
 */
export async function lowUnityJunctions(root: string, editors: { version: string; bin: string }[], exec: Exec, say: (line: string) => void): Promise<string[]> {
  const dir = lowUnityDir(root);
  const have: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    say(`worker integrity: could not make ${dir}: ${(e as Error).message}`);
    return have;
  }
  const seen = new Set<string>();
  for (const e of editors) {
    if (seen.has(e.version) || !/^[0-9][0-9A-Za-z.]*$/.test(e.version)) continue;
    seen.add(e.version);
    const target = path.dirname(e.bin); // <install>\<version>\Editor
    const link = path.join(dir, e.version);
    try {
      // w5838: and only when it still leads to the install's Editor folder: the daemon's editors start Unity through it.
      if (fs.existsSync(path.join(link, 'Unity.exe')) && junctionLeadsTo(link, target)) {
        have.push(e.version);
        continue;
      }
      fs.rmSync(link, { recursive: false, force: true });
      const r = await exec('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { timeoutMs: 60_000 });
      if (r.code !== 0 || !fs.existsSync(path.join(link, 'Unity.exe'))) throw new Error((r.stderr || r.stdout).trim().slice(-300) || 'no Unity.exe through it');
      have.push(e.version);
    } catch (err) {
      say(`worker integrity: could not junction Unity ${e.version} at ${link}: ${(err as Error).message}`);
    }
  }
  return have;
}

/** Whether the junction (or link) `link` leads to `target`. Exported for tests. */
export function junctionLeadsTo(link: string, target: string, readlink: (p: string) => string = fs.readlinkSync): boolean {
  try {
    const plain = (p: string) => path.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '').toLowerCase();
    return plain(readlink(link)) === plain(target);
  } catch {
    return false;
  }
}

/**
 * Low-integrity Roslyn compiler servers that run from an install's own path rather than a junction under the root:
 * every Medium compile on the machine would reach them and fail with CS2012 (w5347). The daemon ends them as soon as it
 * sees one; a worker that started Unity by the install's path is told why in its own failed run. Exported for tests.
 */
export function strayLowServers(servers: { pid: number; rid: number; dll: string }[], root: string): number[] {
  const under = lowUnityDir(root).toLowerCase();
  return servers.filter((s) => s.rid > 0 && s.rid < 0x2000 && s.dll && !path.resolve(s.dll).toLowerCase().startsWith(under)).map((s) => s.pid);
}

/**
 * w5546 (lothsahn: "workers can't read the secrets and daemon folders on any OS"): the read half of the Windows fence. A
 * mandatory label with No-Read-Up (NR) on a Medium path refuses reads to Low processes, as No-Write-Up (NW, icacls' only
 * policy) refuses writes. icacls cannot set NR, so the daemon sets the label's SDDL through SetNamedSecurityInfoW
 * (LABEL_SECURITY_INFORMATION), which also passes an inheritable label on to what is already inside a folder.
 *
 * Closed: the daemon's folder (its own, and `<root>\daemon` where that differs), `<root>\secrets` and `<root>\root.json`.
 * Given back with an explicit Medium No-Write-Up label (an explicit label overrides an inherited one, measured in w5377):
 * what workers read or run in the daemon's folder (daemonReads.ts FENCE_READ_ALLOW) and the runs' own GitHub App token
 * files (gh-app\sessions, w5547: every Low worker shares one Low token, so a Low worker can read every run's file there,
 * which holds only the apps runs on that machine were given; macOS and Linux give each run only its own).
 *
 * Never on the system drive (lothsahn: "Never touch C: on Windows"): a target that is, or resolves through a junction to,
 * the system drive is skipped and said (BEAST's daemon and secrets are junctions into C:\ffw-anchor).
 */
export const NO_READ_UP = { dir: 'S:(ML;OICI;NWNR;;;ME)', file: 'S:(ML;;NWNR;;;ME)' };
export const READ_BACK = { dir: 'S:(ML;OICI;NW;;;ME)', file: 'S:(ML;;NW;;;ME)' };

export interface LabelTarget {
  path: string;
  sddl: string;
}

/** The NR labels, closed paths first, then the read-backs. Paths that do not exist are left out. Exported for tests. */
export function noReadUpTargets(o: { root: string; appDir: string; allowBack: readonly string[]; extraBack?: readonly string[]; secrets?: readonly string[]; stat?: (p: string) => 'dir' | 'file' | undefined }): LabelTarget[] {
  const stat =
    o.stat ??
    ((p: string) => {
      try {
        return fs.statSync(p).isDirectory() ? 'dir' : 'file';
      } catch {
        return undefined;
      }
    });
  const out: LabelTarget[] = [];
  const add = (p: string, l: { dir: string; file: string }) => {
    const k = stat(p);
    if (k && !out.some((t) => t.path.toLowerCase() === p.toLowerCase())) out.push({ path: p, sddl: k === 'dir' ? l.dir : l.file });
  };
  // secrets: every secrets folder (readFence.ts secretsDirs), the Dev Drive host folder's too (B3 of the #1193 lockout review).
  // steam (w5639): steamcmd's cached login and the upload config; the daemon runs the uploads at Medium, which NR leaves alone.
  const daemonOnly = DAEMON_ONLY_CHILDREN.map((c) => path.join(o.root, c));
  for (const p of [o.appDir, path.join(o.root, 'daemon'), path.join(o.root, 'secrets'), ...(o.secrets ?? []), ...daemonOnly, path.join(o.root, 'root.json')]) add(p, NO_READ_UP);
  // w5731 (N2 of the #1237 review): steam's secret files by name, so one that kept an explicit Low label (BEAST's steam was
  // Low from 2026-11-24 to 2026-11-25) gets NR of its own; the folder's inherited label would not reach it.
  for (const f of STEAM_SECRET_FILES) add(path.join(o.root, STEAM_CHILD, ...f.split('/')), NO_READ_UP);
  for (const a of [...o.allowBack, ...(o.extraBack ?? [])]) add(path.isAbsolute(a) ? a : path.join(o.appDir, a), READ_BACK);
  return out;
}

/**
 * Whether icacls says the path already carries this label explicitly (not inherited): its Medium label line with NR for a
 * closed path, without NR for a read-back. Exported for tests.
 */
export function hasLabel(icaclsOut: string, sddl: string): boolean {
  const line = icaclsOut.split(/\r?\n/).find((l) => /Mandatory Label\\Medium Mandatory Level/i.test(l));
  if (!line || /\(I\)/.test(line)) return false;
  return /\bNR\b/.test(line) === sddl.includes('NWNR') && /\bNW\b/.test(line);
}

/** Whether a path is on (or, through a junction, resolves to) the system drive. Exported for tests. */
export function onSystemDrive(p: string, systemDrive = process.env.SystemDrive || 'C:', real: (p: string) => string = (x) => fs.realpathSync.native(x)): boolean {
  const drive = (x: string) => path.win32.parse(path.win32.resolve(x)).root.slice(0, 2).toLowerCase();
  const sys = systemDrive.slice(0, 2).toLowerCase();
  if (drive(p) === sys) return true;
  try {
    return drive(real(p)) === sys;
  } catch {
    return false;
  }
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The PowerShell that sets each label and prints `ok <i>` or `err <i> <win32 error>` per target. Exported for tests. */
export function labelScript(t: readonly LabelTarget[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class FfLabel {',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint rev, out IntPtr sd, IntPtr size);',
    '  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] public static extern uint SetNamedSecurityInfoW(string path, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);',
    '  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);',
    '  public static uint Set(string path, string sddl) {',
    '    IntPtr sd; if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, IntPtr.Zero)) return (uint)Marshal.GetLastWin32Error();',
    '    try { bool p, d; IntPtr sacl; if (!GetSecurityDescriptorSacl(sd, out p, out sacl, out d)) return (uint)Marshal.GetLastWin32Error();',
    '      return SetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl); } finally { LocalFree(sd); }',
    '  }',
    '}',
    '"@',
    ...t.map((x, i) => `$r = [FfLabel]::Set(${psq(x.path)}, ${psq(x.sddl)}); if ($r -eq 0) { 'ok ${i}' } else { 'err ${i} ' + $r }`),
  ].join('\n');
}

/**
 * Sets the No-Read-Up labels (w5546). A target on the system drive is skipped and said; one refused for want of
 * WRITE_OWNER gets the account's Full grant first (as labelLow, w5402) and is tried again. Returns whether every label not
 * skipped was set; never throws.
 */
export async function labelNoReadUp(t: readonly LabelTarget[], exec: Exec, say: (line: string) => void, o: { account?: string; systemDrive?: (p: string) => boolean } = {}): Promise<boolean> {
  const sys = o.systemDrive ?? ((p: string) => onSystemDrive(p));
  const todo: LabelTarget[] = [];
  for (const x of t) {
    if (sys(x.path)) {
      say(`worker integrity: left ${x.path} without a read label: it is on the system drive, which the fence does not touch`);
      continue;
    }
    // Already so: not set again (setting a folder's label walks everything inside it).
    const now = await exec('icacls', [x.path], { timeoutMs: 60_000 });
    if (now.code === 0 && hasLabel(now.stdout, x.sddl)) continue;
    todo.push(x);
  }
  if (!todo.length) return true;
  const runOnce = async (list: readonly LabelTarget[]) => {
    const script = labelScript(list);
    const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeoutMs: 10 * 60_000 });
    const failed = new Map<number, string>();
    const seen = new Set<number>();
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^(ok|err) (\d+)(?: (\d+))?$/.exec(line.trim());
      if (!m) continue;
      seen.add(Number(m[2]));
      if (m[1] === 'err') failed.set(Number(m[2]), m[3] ?? '?');
    }
    list.forEach((_, i) => !seen.has(i) && failed.set(i, `no answer (${(r.stderr || r.stdout).trim().slice(-200)})`));
    return failed;
  };
  let failed = await runOnce(todo);
  const account = o.account ?? currentAccount();
  const denied = [...failed].filter(([, c]) => c === '5').map(([i]) => todo[i]);
  if (denied.length && account) {
    for (const x of denied) {
      const g = await exec('icacls', [x.path, '/grant', `${account}:${x.sddl.includes('OICI') ? '(OI)(CI)' : ''}F`], { timeoutMs: 30 * 60_000 });
      if (g.code === 0) say(`worker integrity: gave ${account} Full on ${x.path}, which setting its label needs (WRITE_OWNER)`);
    }
    const again = await runOnce(denied);
    const rest = new Map<number, string>();
    for (const [i, c] of failed) {
      const j = denied.indexOf(todo[i]);
      if (j < 0) rest.set(i, c);
      else if (again.has(j)) rest.set(i, again.get(j)!);
    }
    failed = rest;
  }
  for (const [i, c] of failed) say(`worker integrity: could not set ${todo[i].sddl} on ${todo[i].path}: ${c}`);
  say(`worker integrity: read labels set on ${todo.length - failed.size} of ${todo.length} paths (No-Read-Up on the daemon's folder, secrets and root.json; their worker reads given back)`);
  return failed.size === 0;
}

/**
 * Takes the No-Read-Up labels off again (w5546 lockout review B1: the read fence off or warn, or a reverted build): each
 * closed path that still carries an explicit NR label gets the plain No-Write-Up one. A path without one is not touched
 * (setting a folder's label walks everything in it). Returns the paths it opened, or undefined when one could not be set.
 */
export async function openNoReadUp(t: readonly LabelTarget[], exec: Exec, say: (line: string) => void, o: { account?: string; systemDrive?: (p: string) => boolean } = {}): Promise<string[] | undefined> {
  const open: LabelTarget[] = [];
  for (const x of t.filter((x) => x.sddl.includes('NWNR'))) {
    const now = await exec('icacls', [x.path], { timeoutMs: 60_000 });
    if (now.code === 0 && hasLabel(now.stdout, x.sddl)) open.push({ path: x.path, sddl: x.sddl.replace('NWNR', 'NW') });
  }
  if (open.length && !(await labelNoReadUp(open, exec, say, o))) return undefined;
  return open.map((x) => x.path);
}

/** Whether icacls says this path carries a Medium mandatory label. Exported for tests. */
export const isLabelledMedium = (icaclsOut: string) => /Mandatory Label\\Medium Mandatory Level/i.test(icaclsOut);

/**
 * w5557: reads back the owner's game folder's label after labelLow kept it Medium (daemon.json
 * `workerIntegrityLockGameData`) and says what a Low worker meets there: a Medium label refuses its writes (no-write-up),
 * a Low one lets them through. A folder that does not exist yet is said as such; the next start labels it.
 */
export async function ownerGameDataLock(dir: string, exec: Exec, exists: (p: string) => boolean = fs.existsSync): Promise<string> {
  if (!exists(dir)) return `worker integrity: the owner's game folder ${dir} does not exist yet; it is kept Medium on the next start after it does`;
  const r = await exec('icacls', [dir], { timeoutMs: 60_000 });
  if (r.code === 0 && isLabelledMedium(r.stdout) && !isLabelledLow(r.stdout)) return `worker integrity: the owner's game folder ${dir} is Medium; a Low worker's write there is refused`;
  return `worker integrity: the owner's game folder ${dir} is NOT Medium (${r.code === 0 ? 'icacls shows no Medium label' : (r.stderr || r.stdout).trim().slice(-200)}); a Low worker could write the owner's saves`;
}

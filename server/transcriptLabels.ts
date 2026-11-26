/**
 * w5703: the Windows half of "transcripts are read-only to workers" (w5563, docs/transcript-seal.md). With the Low
 * integrity fence on (machine/lowIntegrity.ts) and daemon.json `workerTranscriptLabels: true`, `<CLAUDE_CONFIG_DIR>\projects`
 * carries an explicit Medium no-write-up label, inherited by every project folder and every transcript in it: a Low worker
 * cannot plant, edit, rename or delete a transcript there, nor make a folder. Only the conversation a claude process runs
 * is Low while that process lives: its `<id>.jsonl` and its `<id>\` folder (tool results, subagents), labelled by the agent
 * host before the process starts and labelled Medium again once it has exited.
 *
 * A new conversation's file cannot be made ahead: the CLI refuses `--session-id <id>` when `<id>.jsonl` exists ("Session ID
 * ... is already in use", a statSync at start-up). So the spawner holds back the SDK's first user message until the CLI has
 * answered the SDK's `initialize` (its start-up check is behind it then), makes the empty file, labels it Low and lets the
 * message through; the CLI appends to it (measured on BEAST, Claude Code 2.1.x against a mock API: a new conversation, a
 * resume and a /compact ran with the project folder refusing new files and folders, the transcript kept its first bytes
 * through each, and `memory\` was simply not made).
 *
 * What it does not do: another live conversation's own file is Low while its process runs, so a Low worker can write it
 * (every worker is the same user at the same level); the seal (server/transcriptSeal.ts) fails such an edit at its next
 * resume. A host that dies before its claude leaves that conversation Low until its next process ends.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { findTranscript, projectSlug } from './claudeHome.ts';
import { sessionIdOf } from './workerFence.ts';
import { currentAccount, type Exec } from '../machine/lowIntegrity.ts';
import { isLink } from './fsLink.ts';

/** The folder label (inherited by what is made inside) and the file label. */
const DIR_LOW = '(OI)(CI)low';
const DIR_MEDIUM = '(OI)(CI)medium';

/** Sets a label with icacls, synchronously; Runs icacls `args` and answers its exit code and output. */
export type IcaclsSync = (args: string[]) => { code: number; out: string };

const realIcacls: IcaclsSync = (args) => {
  try {
    return { code: 0, out: execFileSync('icacls', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string; message: string };
    return { code: x.status ?? 1, out: `${x.stdout ?? ''}${x.stderr ?? ''}` || x.message };
  }
};

/**
 * Runs icacls `/setintegritylevel label` on `target` (a path, or `<dir>\*` for every entry of a folder), never with /T.
 * Setting a label needs WRITE_OWNER; where the account has it only through a group ACE icacls answers "Access is denied",
 * and the owner may still grant itself Full first (lowIntegrity.ts labelLow, measured w5402).
 */
function* icaclsLabel(target: string, label: string, account: string | undefined): Steps<void> {
  const args = [target, '/setintegritylevel', label];
  let r = yield args;
  if (r.code !== 0 && account && /access is denied/i.test(r.out)) {
    if ((yield [target, '/grant', `${account}:${label.startsWith('(OI)') ? '(OI)(CI)' : ''}F`]).code === 0) r = yield args;
  }
  if (r.code !== 0) throw new Error(`icacls ${label} on ${target}: ${r.out.trim().slice(-300)}`);
}

/**
 * A run of icacls calls: each `yield` hands over the arguments of one call and gets its answer back, so one walk serves
 * both drivers below. The spawner labels one conversation's files and may wait (runSteps); the daemon's first lock labels
 * every transcript on the machine, hundreds of calls, and must not hold its event loop meanwhile (runStepsAsync): on BEAST
 * the synchronous first pass held heartbeats for 5.5 minutes and the portal showed it offline (w5703, 2026-11-25).
 */
type Steps<T> = Generator<string[], T, { code: number; out: string }>;

/** An icacls runner that may answer later: the daemon's Exec (icaclsOf) or a test's synchronous fake. */
export type Icacls = (args: string[]) => { code: number; out: string } | Promise<{ code: number; out: string }>;

/** Runs `steps` with a synchronous icacls. */
function runSteps<T>(steps: Steps<T>, icacls: IcaclsSync): T {
  let n = steps.next();
  while (!n.done) n = steps.next(icacls(n.value));
  return n.value;
}

/** Runs `steps` one icacls call at a time, each awaited, so timers and the heartbeat run between them. */
async function runStepsAsync<T>(steps: Steps<T>, icacls: Icacls): Promise<T> {
  let n = steps.next();
  while (!n.done) {
    const r = await icacls(n.value);
    // A synchronous fake answers at once: give the loop a turn anyway, as a real call does.
    await new Promise<void>((resolve) => setImmediate(resolve));
    n = steps.next(r);
  }
  return n.value;
}

/** icacls through the daemon's asynchronous Exec: the event loop runs while icacls does. */
export const icaclsOf =
  (exec: Exec): Icacls =>
  async (args) => {
    try {
      const r = await exec('icacls', args, { timeoutMs: 60_000 });
      return { code: r.code ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    } catch (e) {
      return { code: 1, out: (e as Error).message };
    }
  };

export { isLink } from './fsLink.ts';

function* setLabelSteps(p: string, label: string, account: string | undefined): Steps<void> {
  if (isLink(p)) throw new Error(`${p} is a junction or link; not labelled (w5703)`);
  yield* icaclsLabel(p, label, account);
}

/** Sets `label` on `p` alone. Refuses a link: icacls labels what a junction or link points at (w5774). */
export function setLabelSync(p: string, label: string, icacls: IcaclsSync = realIcacls, account = currentAccount()): void {
  runSteps(setLabelSteps(p, label, account), icacls);
}

/** setLabelSync, without holding the event loop. */
export const setLabel = (p: string, label: string, icacls: Icacls, account = currentAccount()): Promise<void> => runStepsAsync(setLabelSteps(p, label, account), icacls);

/** Whether icacls shows a Low label on `p` (its own or inherited). No label at all is Medium. */
function* labelledLow(p: string): Steps<boolean> {
  return /Mandatory Label\\Low Mandatory Level/i.test((yield [p]).out);
}

/**
 * Labels the folder `root` and everything in it `level`: files plain, folders `(OI)(CI)`. Never with icacls /T, which follows
 * junctions: a Low worker could plant one in its own Low folder and have this Medium host relabel any folder Low (w5774,
 * measured on BEAST). Junctions and links are skipped, not labelled, and counted in the answer.
 *
 * No link can be planted while the walk runs: a folder it reads is Medium for the whole time (no Low process can add an
 * entry to it): to Medium, a folder is labelled before its entries are read; to Low, after, and a folder already Low is
 * left as it is (nothing Medium is inside one, and walking it could race a worker). A folder with no link in it is labelled
 * with one `<dir>\*` call; its sub-folders get their inheritable label after that.
 */
function* labelTreeSteps(root: string, level: 'low' | 'medium', account: string | undefined): Steps<number> {
  if (isLink(root)) throw new Error(`${root} is a junction or link; not labelled (w5703)`);
  const dirLabel = `(OI)(CI)${level}`;
  let links = 0;
  /** Labels what is inside `dir` (Medium while this runs), not `dir` itself. */
  function* inside(dir: string): Steps<void> {
    // A link by its listing (every reparse point) or by lstat; never followed.
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
      const p = path.join(dir, e.name);
      const link = e.isSymbolicLink() || isLink(p);
      return { p, link, dir: !link && e.isDirectory() };
    });
    const dirs = entries.filter((e) => !e.link && e.dir).map((e) => e.p);
    const skipped = entries.filter((e) => e.link).length;
    links += skipped;
    if (level === 'medium') {
      if (!entries.length) return;
      if (skipped) for (const e of entries.filter((x) => !x.link && !x.dir)) yield* icaclsLabel(e.p, level, account);
      else yield* icaclsLabel(path.join(dir, '*'), level, account);
      for (const d of dirs) {
        yield* icaclsLabel(d, dirLabel, account);
        yield* inside(d);
      }
      return;
    }
    const todo: string[] = [];
    for (const d of dirs) if (!(yield* labelledLow(d))) todo.push(d);
    for (const d of todo) yield* inside(d);
    if (!entries.length) return;
    if (skipped) for (const e of entries.filter((x) => !x.link && !x.dir)) yield* icaclsLabel(e.p, level, account);
    else yield* icaclsLabel(path.join(dir, '*'), level, account);
    for (const d of skipped ? todo : dirs) yield* icaclsLabel(d, dirLabel, account);
  }
  if (level === 'medium') {
    yield* icaclsLabel(root, dirLabel, account);
    yield* inside(root);
  } else if (!(yield* labelledLow(root))) {
    yield* inside(root);
    yield* icaclsLabel(root, dirLabel, account);
  }
  return links;
}

/** labelTreeSteps with a synchronous icacls (the spawner: one conversation's files). Answers the links skipped. */
export function labelTreeSync(root: string, level: 'low' | 'medium', icacls: IcaclsSync = realIcacls, account = currentAccount()): number {
  return runSteps(labelTreeSteps(root, level, account), icacls);
}

/** labelTreeSync, without holding the event loop (the daemon's lock and unlock of every transcript). */
export const labelTree = (root: string, level: 'low' | 'medium', icacls: Icacls, account = currentAccount()): Promise<number> => runStepsAsync(labelTreeSteps(root, level, account), icacls);

/**
 * Takes delete-child back from the account on folder `p` (this folder only, not inherited). A Low process that has it on a
 * folder can move a Medium child aside (the measured way `projects` itself was renamed from inside the Low `claude`, w5703)
 * and put its own in its place. Its own files still delete and rename through their own DELETE right.
 */
function* denyDeleteChildSteps(p: string, account: string | undefined): Steps<void> {
  if (!account) throw new Error(`no account to deny delete-child on ${p}`);
  const r = yield [p, '/deny', `${account}:(DC)`];
  if (r.code !== 0) throw new Error(`icacls deny delete-child on ${p}: ${r.out.trim().slice(-300)}`);
}

export function denyDeleteChildSync(p: string, icacls: IcaclsSync = realIcacls, account = currentAccount()): void {
  runSteps(denyDeleteChildSteps(p, account), icacls);
}

export const denyDeleteChild = (p: string, icacls: Icacls, account = currentAccount()): Promise<void> => runStepsAsync(denyDeleteChildSteps(p, account), icacls);

/** Removes the deny entries denyDeleteChild added. */
async function undeny(p: string, icacls: Icacls, account = currentAccount()): Promise<void> {
  if (!account) return;
  const r = await icacls([p, '/remove:d', account]);
  if (r.code !== 0) throw new Error(`icacls remove deny on ${p}: ${r.out.trim().slice(-300)}`);
}

/** The conversation a claude argv runs and where its files are or go. Undefined when the argv names no safe id. */
export interface OwnFiles {
  sid: string;
  /** `<id>.jsonl`: the one that exists (a resume, from any project folder), else where the CLI makes it (the cwd's folder). */
  file: string;
  /** `<id>\` beside it. */
  dir: string;
  /** The file exists already (a resume). */
  exists: boolean;
}

export function ownFiles(o: { args: string[]; cwd?: string; env: Record<string, string | undefined> }): OwnFiles | undefined {
  const sid = sessionIdOf(o.args);
  const home = o.env.CLAUDE_CONFIG_DIR;
  if (!sid || !home || !path.isAbsolute(home) || !o.cwd) return undefined;
  const projects = path.join(home, 'projects');
  const slug = projectSlug(o.cwd);
  const found = findTranscript(projects, slug, sid);
  const file = found ?? path.join(projects, slug, `${sid}.jsonl`);
  return { sid, file, dir: file.slice(0, -'.jsonl'.length), exists: !!found };
}

/** Processes this host runs per conversation: its files go back to Medium when the last one has exited. */
const live = new Map<string, number>();

/** The top-level `type` of one stream-json line, or undefined when it is not JSON. */
const typeOf = (line: string): string | undefined => {
  try {
    const t = (JSON.parse(line) as { type?: unknown }).type;
    return typeof t === 'string' ? t : undefined;
  } catch {
    return undefined;
  }
};

export interface LabelSpawnerDeps {
  run?: typeof spawn;
  icacls?: IcaclsSync;
  log?: (line: string) => void;
  /** How long a new conversation's first message waits for the CLI's `initialize` answer before the file is made anyway. */
  gateMs?: number;
}

/**
 * Options.spawnClaudeCodeProcess for a Low sandbox agent with transcript labels on: the SDK's claude (the Low copy), its
 * own conversation's files labelled Low around the process, and a new conversation's file made once the CLI is past its
 * start-up check. A label it cannot set is logged; the process still starts (its own writes then fail and say so).
 */
export function lowTranscriptSpawner(d: LabelSpawnerDeps = {}) {
  const run = d.run ?? spawn;
  const icacls = d.icacls ?? realIcacls;
  const log = d.log ?? ((l: string) => console.warn(l));
  const label = (p: string, l: string, tree = false) => {
    try {
      if (!tree) setLabelSync(p, l, icacls);
      else if (labelTreeSync(p, l === DIR_LOW ? 'low' : 'medium', icacls)) log(`transcript labels: skipped a junction or link in ${p}; it is not labelled (w5703)`);
      return true;
    } catch (e) {
      log(`transcript labels: ${(e as Error).message}`);
      return false;
    }
  };
  return (o: SpawnOptions): SpawnedProcess => {
    const own = ownFiles(o);
    if (own) {
      const folder = path.dirname(own.file);
      const projects = path.dirname(folder);
      // The lock undone under us (`projects` moved aside and made again by a worker: it owns the Low `claude` and can take
      // the deny entry off it, measured): say so loudly; the seal still refuses a planted transcript for a sealed id.
      if (own.exists && fs.existsSync(projects) && !explicitMedium(icacls([projects]).out))
        log(`transcript labels: WARNING: ${projects} has no Medium label of its own; the transcript lock is undone, a Low worker may have replaced it (w5703)`);
      // A project folder made after the lock by a Medium process (a person's or the orchestrator's claude) has no
      // delete-child deny yet (w5774); its own folder gets one here, the daemon's start gives it to the rest.
      const made = !fs.existsSync(folder);
      if (made) fs.mkdirSync(folder, { recursive: true });
      if (made || !deniesDeleteChild(icacls([folder]).out)) {
        try {
          denyDeleteChildSync(folder, icacls);
        } catch (e) {
          log(`transcript labels: ${(e as Error).message}`);
        }
      }
      fs.mkdirSync(own.dir, { recursive: true });
      label(own.dir, DIR_LOW, true);
      if (own.exists) label(own.file, 'low');
      live.set(own.sid, (live.get(own.sid) ?? 0) + 1);
    }
    const child: ChildProcess = run(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr?.resume();
    let released = false;
    const release = () => {
      if (!own || released) return;
      released = true;
      const n = (live.get(own.sid) ?? 1) - 1;
      if (n > 0) return void live.set(own.sid, n);
      live.delete(own.sid);
      if (fs.existsSync(own.file)) label(own.file, 'medium');
      if (fs.existsSync(own.dir)) label(own.dir, DIR_MEDIUM, true);
    };
    child.on('exit', release);
    child.on('error', release);
    const stdout = new PassThrough();
    child.stdout!.pipe(stdout);
    if (!own || own.exists) return wrap(child, child.stdin!, stdout);

    // A new conversation: the SDK's lines pass until its first that is not a control message; that one and every later one
    // wait for the CLI's first control_response, then the file is made and they go through in order.
    let open = false;
    let held: Buffer[] | undefined;
    let partial = '';
    let seen = '';
    const make = (why: string) => {
      if (open) return;
      open = true;
      clearTimeout(timer);
      try {
        fs.writeFileSync(own.file, '', { flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') log(`transcript labels: could not make ${own.file}: ${(e as Error).message}`);
      }
      if (fs.existsSync(own.file) && !label(own.file, 'low')) log(`transcript labels: ${own.file} stays Medium (${why}); this conversation's transcript cannot be written`);
      for (const b of held ?? []) child.stdin!.write(b);
      held = undefined;
      if (ended) child.stdin!.end();
    };
    const timer = setTimeout(() => {
      log(`transcript labels: no initialize answer from claude in ${(d.gateMs ?? 60_000) / 1000}s; made ${own.file} anyway`);
      make('timeout');
    }, d.gateMs ?? 60_000);
    timer.unref?.();
    child.on('exit', () => clearTimeout(timer));
    child.stdout!.on('data', (c: Buffer) => {
      if (open) return;
      seen = (seen + c.toString()).slice(-4096);
      if (seen.split('\n').some((l) => typeOf(l) === 'control_response')) make('initialize answered');
    });
    let ended = false;
    const stdin = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (open) return void child.stdin!.write(chunk, cb);
        if (!held) {
          const text = partial + chunk.toString();
          const lines = text.split('\n');
          partial = lines.pop() ?? '';
          if (lines.every((l) => !l.trim() || typeOf(l)?.startsWith('control_'))) {
            if (lines.length) child.stdin!.write(lines.join('\n') + '\n');
            return cb();
          }
          // From the first other line on, everything waits (the rest of this chunk and the partial tail included).
          const at = lines.findIndex((l) => l.trim() && !typeOf(l)?.startsWith('control_'));
          if (at > 0) child.stdin!.write(lines.slice(0, at).join('\n') + '\n');
          held = [Buffer.from(lines.slice(at).join('\n') + '\n' + partial)];
          partial = '';
          return cb();
        }
        held.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        ended = true;
        if (open) child.stdin!.end();
        cb();
      },
    });
    stdin.on('error', () => {});
    child.stdin!.on('error', () => {});
    return wrap(child, stdin, stdout);
  };
}

/** The SpawnedProcess the SDK reads: the child's state and events, with our stdin and stdout in front. */
function wrap(child: ChildProcess, stdin: Writable, stdout: PassThrough): SpawnedProcess {
  return {
    stdin,
    stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    get pid() {
      return child.pid;
    },
    kill: (s: NodeJS.Signals) => child.kill(s),
    on: (e: 'exit' | 'error', l: (...a: any[]) => void) => void child.on(e, l),
    once: (e: 'exit' | 'error', l: (...a: any[]) => void) => void child.once(e, l),
    off: (e: 'exit' | 'error', l: (...a: any[]) => void) => void child.off(e, l),
  } as unknown as SpawnedProcess;
}

/** The session ids on the command lines of the processes running now (`--resume`/`--session-id`); undefined if unknown. */
export async function liveSessionIds(exec: Exec): Promise<Set<string> | undefined> {
  const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process).CommandLine'], { timeoutMs: 60_000 }).catch(() => undefined);
  if (!r || r.code !== 0) return undefined;
  return new Set([...r.stdout.matchAll(/--(?:resume|session-id)[ =]"?([A-Za-z0-9_-]{8,80})/g)].map((m) => m[1]));
}

/** The project folders in `projects`: real folders only, never a junction or link. */
const projectFolders = (projects: string) =>
  fs.readdirSync(projects, { withFileTypes: true }).map((s) => path.join(projects, s.name)).filter((p) => !isLink(p) && fs.statSync(p).isDirectory());

/** The conversation a transcript or conversation folder belongs to, or undefined for anything else (`memory\`, a stray). */
const conversationOf = (name: string, dir: boolean) => (dir ? (name === 'memory' ? undefined : name) : name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : undefined);

/** Whether icacls shows a deny entry with delete-child (denyDeleteChildSync's). */
export const deniesDeleteChild = (icaclsOut: string) => /\(DENY\)[^\r\n]*\bDC\b/.test(icaclsOut);

const readPins = (f: string | undefined): string[] => {
  try {
    const v = f ? (JSON.parse(fs.readFileSync(f, 'utf8')) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export interface LockOptions {
  now?: number;
  /** A conversation written this recently stays Low at the lock, and is not taken back to Medium after (default 1 h). */
  recentMs?: number;
  /** Session ids running now (liveSessionIds); undefined: unknown, so the lock pins what was written in 3 days, and every pin is kept. */
  live?: Set<string>;
  /** Where the pinned conversations are kept between daemon starts: a file only Medium processes can write (the daemon's folder). */
  pins?: string;
  icacls?: Icacls;
  account?: string;
}

/**
 * The daemon's step at every start while the fence and the switch are on. The first time it labels `projects` Medium,
 * which every project folder and every other transcript inherits, and pins Low the conversations running now (and those
 * written in the last `recentMs`: a conversation running when the switch went on keeps appending, and agents outlive the
 * daemon, machine/agentHost.ts). The pins are kept in `pins`; at each later start a pinned conversation no longer running
 * goes back to Medium, and a project folder made since by a Medium process gets its delete-child deny (w5774). Answers false,
 * with the reason said, when the label could not be set. Never throws.
 */
export async function lockTranscripts(projects: string, exec: Exec, say: (line: string) => void, o: LockOptions = {}): Promise<boolean> {
  const account = o.account ?? currentAccount();
  const recentMs = o.recentMs ?? 3600_000;
  const now0 = o.now ?? Date.now();
  const written = (p: string, ms: number) => fs.existsSync(p) && fs.statSync(p).mtimeMs >= now0 - ms;
  // At the lock: running now, or written lately (3 days when what runs is unknown, so a long-lived agent is not cut off).
  const pin = (p: string, sid: string) => !!o.live?.has(sid) || written(p, o.live ? recentMs : 3 * 86_400_000);
  // After: a pin goes back to Medium only when it is known not to run and was not written lately.
  const keep = (p: string, sid: string) => !o.live || o.live.has(sid) || written(p, recentMs);
  const ic = o.icacls ?? icaclsOf(exec);
  try {
    fs.mkdirSync(projects, { recursive: true });
    if (isLink(projects)) throw new Error(`${projects} is a junction or link`);
    const now = await exec('icacls', [projects], { timeoutMs: 60_000 });
    if (now.code === 0 && explicitMedium(now.stdout)) {
      let denied = 0;
      for (const f of projectFolders(projects)) {
        if (deniesDeleteChild((await ic([f])).out)) continue;
        await denyDeleteChild(f, ic, account);
        denied++;
      }
      const pins = readPins(o.pins);
      const left: string[] = [];
      let back = 0;
      for (const p of pins) {
        const dir = !p.endsWith('.jsonl');
        const sid = conversationOf(path.basename(p), dir);
        if (!sid || !fs.existsSync(p) || path.dirname(path.dirname(p)) !== projects) continue;
        if (keep(p, sid)) left.push(p);
        else if (isLink(p)) continue;
        else {
          if (dir) await labelTree(p, 'medium', ic, account);
          else await setLabel(p, 'medium', ic, account);
          back++;
        }
      }
      if (o.pins && left.length !== pins.length) fs.writeFileSync(o.pins, JSON.stringify(left));
      if (denied || back)
        say(`transcript labels: ${back} pinned conversation entr${back === 1 ? 'y' : 'ies'} no longer running labelled Medium, ${denied} new project folder${denied === 1 ? '' : 's'} given the delete-child deny; ${left.length} still pinned (w5774)`);
      return true;
    }
    let locked = 0;
    let links = 0;
    // Every entry gets its own label: what was there before carries an explicit Low (the root's labelLow /T) that a label
    // on `projects` alone does not change (measured on the Windows CI runner).
    const slugs = projectFolders(projects);
    // Delete-child first: from the Low `claude` a Low process could otherwise move `projects` aside (measured), and on the
    // Medium folders a Low process may still hold it through the account's Full grant. First, because a DACL change on a
    // folder pushes its inheritable entries down again, the label included: with the deny on `claude` added last, the
    // Windows runner's second run found every transcript writable at Low again.
    for (const p of [path.dirname(projects), projects, ...slugs]) await denyDeleteChild(p, ic, account);
    // The folders first: once one is Medium no Low process can put a junction in it, so what is read in it next stays what it
    // is (w5774). A pinned conversation's files keep their explicit Low (the root's labelLow /T) meanwhile.
    await setLabel(projects, DIR_MEDIUM, ic, account);
    for (const folder of slugs) await setLabel(folder, DIR_MEDIUM, ic, account);
    const pins: string[] = [];
    for (const folder of slugs) {
      for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
        const p = path.join(folder, e.name);
        if (isLink(p)) {
          links++;
          continue;
        }
        const dir = fs.statSync(p).isDirectory();
        const sid = conversationOf(e.name, dir);
        if (sid && pin(p, sid)) {
          await setLabel(p, dir ? DIR_LOW : 'low', ic, account);
          pins.push(p);
        } else {
          if (dir) links += await labelTree(p, 'medium', ic, account);
          else await setLabel(p, 'medium', ic, account);
          locked++;
        }
      }
    }
    if (o.pins) fs.writeFileSync(o.pins, JSON.stringify(pins));
    say(`transcript labels: labelled ${projects} Medium (w5703), with ${slugs.length} project folder${slugs.length === 1 ? '' : 's'} and ${locked} transcript${locked === 1 ? '' : 's'} and folders in them; ${pins.length} running or written in the last ${o.live ? `${Math.round(recentMs / 60_000)} min` : "3 days"} kept Low until they stop${links ? `; ${links} junction${links === 1 ? '' : 's'} or link${links === 1 ? '' : 's'} skipped` : ''}`);
    return true;
  } catch (e) {
    say(`transcript labels: could not label ${projects} Medium: ${(e as Error).message}; workers can still write every transcript there (the seal still refuses an edited one at resume)`);
    return false;
  }
}

/**
 * The way back (switch off, or the fence off): `projects` and everything in it Low again, explicitly, so every worker's
 * claude can write its transcript wherever an earlier lock left a Medium label. Runs only where `projects` carries the
 * explicit Medium label lockTranscripts set, and labels `projects` itself last, so a way back that fails half way is
 * tried again at the next start (w5774). Never throws.
 */
export async function unlockTranscripts(projects: string, exec: Exec, say: (line: string) => void, icacls?: Icacls, account = currentAccount(), pins?: string): Promise<void> {
  const ic = icacls ?? icaclsOf(exec);
  try {
    if (!fs.existsSync(projects) || isLink(projects)) return;
    const now = await exec('icacls', [projects], { timeoutMs: 60_000 });
    if (now.code !== 0 || !explicitMedium(now.stdout)) return;
    for (const p of [path.dirname(projects), projects, ...projectFolders(projects)]) await undeny(p, ic, account);
    const links = await labelTree(projects, 'low', ic, account);
    if (pins) fs.rmSync(pins, { force: true });
    say(`transcript labels: off; labelled ${projects} and everything in it Low again (w5703)${links ? `; ${links} junction${links === 1 ? '' : 's'} or link${links === 1 ? '' : 's'} skipped` : ''}`);
  } catch (e) {
    say(`transcript labels: could not label ${projects} Low again: ${(e as Error).message}; tried again at the next start`);
  }
}

/** Whether icacls shows the object's own (not inherited) label as Medium. Exported for tests. */
export const explicitMedium = (icaclsOut: string) => /Mandatory Label\\Medium Mandatory Level:(?!\(I\))/i.test(icaclsOut);

/**
 * The daemon's check after the lock: a Low process (`lowNode`, a Low-labelled copy of node) tries to make a file in
 * `projects` and in a project folder, and to append to an existing transcript there. Answers what it met, one line.
 */
export function probeTranscriptLock(lowNode: string, projects: string, runSync = execFileSync): string {
  const script = [
    "const fs=require('fs'),path=require('path');const p=process.argv[1];const out=[];",
    "const tryIt=(what,f)=>{try{f();out.push(what+' WRITTEN')}catch(e){out.push(what+' refused ('+e.code+')')}};",
    "const probe=path.join(p,'ff-lock-probe-'+process.pid+'.jsonl');tryIt('plant in projects',()=>fs.writeFileSync(probe,''));try{fs.unlinkSync(probe)}catch{}",
    "const slugs=fs.readdirSync(p,{withFileTypes:true}).filter(d=>d.isDirectory());",
    "for(const s of slugs){const f=fs.readdirSync(path.join(p,s.name)).find(n=>n.endsWith('.jsonl'));if(!f)continue;",
    "const sp=path.join(p,s.name,'ff-lock-probe-'+process.pid+'.jsonl');tryIt('plant in a project folder',()=>fs.writeFileSync(sp,''));try{fs.unlinkSync(sp)}catch{}",
    "break}",
    'console.log(out.join("; "))',
  ].join('');
  try {
    return String(runSync(lowNode, ['-e', script, projects], { encoding: 'utf8', timeout: 60_000, windowsHide: true })).trim();
  } catch (e) {
    return `probe failed: ${(e as Error).message.slice(0, 200)}`;
  }
}

/**
 * w6367: a sanctioned long run that outlives its worker's agent host. The nightly e2e worker starts the night and stops
 * between its check-ins; the night runs for hours. On LothDesktop the nights of 2026-11-26 and 11-27 died within a second
 * of the daemon replacing that worker's host for a code update (w2625), with no exit trap run (w6360). Why: Claude Code's
 * Bash tool runs each command in the kill-on-close job Node's libuv makes for its children, so a `nohup ... & disown` night
 * lives only as long as the worker's claude, unless Git Bash breaks it away; since w5554 (a1db8f04) the worker caps' job
 * allows no breakaway, so the night cannot leave, and it ends with claude however claude ends (a w2625 swap, a usage
 * limit, a stop to move the worker, a paused machine's deadline).
 *
 * The route keeps the job fence whole rather than open it (option a of w6367): the DAEMON starts the run, so it is no
 * process of the worker's host, its claude or their jobs, and so nothing that ends them ends it. The run is fenced as its
 * worker is:
 * - Windows only for now (a worker host there is the case measured). Elsewhere the route refuses and the caller starts the
 *   run itself, as before.
 * - At Low integrity, through the Low node copy (machine/lowIntegrity.ts LowCopies), as the players broker's players are:
 *   with no Low copy it is refused, never started at the daemon's Medium.
 * - Always in a job of its own (machine/workerCaps.ts, winJob.cs: no breakaway; under enforce the commit and process
 *   limits), made before the run starts anything: a keeper node waits for the job, then starts the run as its child and
 *   exits with its exit code. No job helper, no run, whatever workerCaps says.
 * - The keeper itself starts with the daemon's bare basics (no NODE_OPTIONS or any other variable the worker chose); the
 *   run's environment comes to it over stdin with "go".
 * - Carrying no FF_SESSION_ID or FF_FOR_PERSON, so the leftovers sweep (machine/leftovers.ts) does not count it as its
 *   worker's leftovers, and the worker's own `ff-leftovers end` leaves it; FF_LONG_RUN names it instead.
 * - Bounded: the keeper ends the run's whole tree after MAX_RUN_S, and `runs/stop` ends it sooner (its own sandbox's only).
 * Only one route runs (SANCTIONED): `nightly`, the game repo's scripts/nightly/nightly_run.sh in the caller's own sandbox,
 * and only for a session the portal marks exempt "nightly" (it works an open nightly-run request; the same mark the bench
 * uses, w1832). Nothing else a worker names is run. What that script does is the nightly worker's own code, as it is
 * today when it starts the night itself; the route changes only who its parent is, never its fence.
 *
 * daemon.json `longRuns` (off | warn | on; ops_worker machine_update long_runs). warn, the default (lothsahn's lockout
 * rule: warn-only first): every check is made and the daemon logs what it would start, then refuses with mode "warn", so
 * the caller starts the run itself as before. on: it starts. off: refused at once. The game's client falls back to its own
 * start on any refusal or error, so a bad switch costs a night at most what it costs today, and warn or off is the way back
 * (docs/worker-fence.md "Long runs").
 *
 * The env file (w6376 review): it holds the worker's daemon token, so the daemon removes it once read. It is accepted only
 * as `long-run-env-<digits>.json` directly in the caller's own sandbox folder, a plain file with one link, opened and
 * checked by its handle; the daemon then removes that name and nothing else (never a path a link resolved to), so no call
 * can make the daemon delete or read a file of its own. Every refusal of it says the same thing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RpcRefused, type Caller, type RpcHandler } from './daemonRpc.ts';
import { capsFor, type CapsMode } from './workerCaps.ts';

export type LongRunsSetting = 'off' | 'warn' | 'on';

/** daemon.json's `longRuns`: absent, and anything it does not name, is warn (a typo never turns the route on). */
export function longRunsSetting(v: unknown): LongRunsSetting {
  return v === 'off' || v === 'on' ? v : 'warn';
}

/** The routes a worker may ask for, and nothing else. */
export const SANCTIONED = {
  nightly: { script: 'scripts/nightly/nightly_run.sh' },
} as const;
export type LongRunName = keyof typeof SANCTIONED;

/**
 * The keeper (run by the Low node copy): `node -e KEEPER_SCRIPT <exe> <cwd> <args JSON> <limit s>`. It waits for one line
 * `go <env JSON>` on stdin (the daemon sends it once the keeper is in the run's job, so everything the run starts is in the
 * job), then starts the run as its child with that environment and exits with its code. After "go" its stdin may close
 * (the daemon restarts): it keeps running. No "go" in a minute, or stdin closed first: it exits without starting anything.
 * At the limit it ends the run's whole tree (taskkill /T /F on Windows) and exits 124.
 */
export const KEEPER_SCRIPT =
  "const{spawn}=require('node:child_process');const[,b,c,a,l]=process.argv;let go=false,buf='',cut=false;const t=setTimeout(()=>process.exit(3),60000);process.stdin.on('error',()=>{});process.stdin.on('end',()=>{if(!go)process.exit(2)});process.stdin.on('data',(d)=>{if(go)return;buf+=d;const n=buf.indexOf('\\n');if(n<0)return;go=true;clearTimeout(t);const line=buf.slice(0,n);if(!line.startsWith('go '))process.exit(2);let env;try{env=JSON.parse(line.slice(3))}catch{process.exit(2)}const p=spawn(b,JSON.parse(a),{cwd:c,env,stdio:'ignore',windowsHide:true});p.on('error',()=>process.exit(4));p.on('exit',(code)=>process.exit(cut?124:code??1));setTimeout(()=>{cut=true;if(process.platform==='win32'){const tk=(process.env.SystemRoot||'C:\\\\Windows')+'\\\\System32\\\\taskkill.exe';const k=spawn(tk,['/PID',String(p.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});k.on('exit',()=>process.exit(124));k.on('error',()=>process.exit(124))}else{try{p.kill('SIGKILL')}catch{}process.exit(124)}},Number(l)*1000).unref()});";

/** Variables a long run never carries: what ties a process to its worker for the sweep and the caps' kills. */
export const DROPPED_ENV = ['FF_SESSION_ID', 'FF_FOR_PERSON', 'FF_TIMED_RUN', 'FF_UNITY_MCP'];
export const RUN_ENV = 'FF_LONG_RUN';
/** The env file's name, directly in the caller's sandbox. */
export const ENV_FILE = /^long-run-env-\d{1,12}\.json$/;
const MAX_ARGS = 20;
const MAX_ARG = 1024;
const MAX_ENV_FILE = 256 * 1024;
/** The longest a run lives (a night's budget is under 12 h; the keeper ends it at 20). */
export const MAX_RUN_S = 20 * 3600;
/** Live runs a sandbox may have at once. */
const MAX_LIVE = 2;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** What the keeper itself starts with, from the daemon's own environment. */
const BASICS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'Path', 'PATH'];

export interface LongRun {
  id: string;
  name: LongRunName;
  session: string;
  sandbox: string;
  pid: number;
  startedAt: string;
  job: boolean;
}

/** What the run would be: said in warn, started in on. */
export interface LongRunPlan {
  name: LongRunName;
  exe: string;
  argv: string[];
  cwd: string;
  /** The run's environment (sent with "go"). */
  env: Record<string, string>;
  /** The keeper's own environment (the daemon's basics). */
  keeperEnv: Record<string, string>;
  limitS: number;
}

export interface Keeper {
  pid: number;
  go: (env: Record<string, string>) => void;
  kill: () => void;
}

export interface LongRunsDeps {
  platform?: NodeJS.Platform;
  /** The install root (FF_WORKER_ROOT). */
  root: string;
  /** Where the runs' records go (`<appDir>/long-runs`). */
  dir: string;
  mode: () => LongRunsSetting;
  /** The worker caps' mode (daemon.json workerCaps): the run's job takes it (enforce, else warn). */
  capsMode: () => CapsMode;
  sandboxPath: (id: string) => string | undefined;
  /** Whether the portal marks this session exempt "nightly" (benchMarks). */
  isNightly: (session: string) => boolean;
  /** The Low node copy, or undefined. */
  lowNode: () => string | undefined;
  /** Git Bash, the one agents run (server/agentGit.ts agentGitBash), or undefined. */
  bash: () => string | undefined;
  /** The job helper exe (workerCaps.ts jobHelper), or undefined. */
  jobHelper: () => string | undefined;
  /** The daemon's own environment, for the keeper's basics. */
  base?: NodeJS.ProcessEnv;
  alive?: (pid: number) => boolean;
  /** Tests: start the keeper. */
  startKeeper?: (node: string, plan: LongRunPlan) => Promise<Keeper>;
  /** Tests: put a pid in a job of its own; resolves true once it is in. */
  joinJob?: (helper: string, pid: number, mode: CapsMode) => Promise<boolean>;
  /** Tests: end a pid's whole tree. */
  endTree?: (pid: number) => Promise<void>;
  log: (line: string) => void;
}

const refuse = (status: number, message: string) => new RpcRefused(message, status);
const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (dir: string, p: string) => {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The sandbox's sanctioned script as a plain file of the sandbox (no link out); one answer for every refusal. */
function scriptOf(sandbox: string): string {
  const p = path.join(sandbox, SANCTIONED.nightly.script);
  const no = () => refuse(403, `nightly: ${SANCTIONED.nightly.script} must be a plain file of your sandbox`);
  try {
    const real = fs.realpathSync(p);
    if (!inside(fs.realpathSync(sandbox), real) || !fs.lstatSync(real).isFile()) throw no();
    return real;
  } catch (e) {
    if (e instanceof RpcRefused) throw e;
    throw no();
  }
}

/**
 * The env file the nightly worker wrote: `long-run-env-<digits>.json` directly in the caller's own sandbox folder, a plain
 * file with one link, read through its handle and then removed by that name (never a path a link resolves to). A JSON
 * object of strings. Every refusal says the same thing, so the route tells nobody whether a file is there.
 */
export function readEnvFile(sandbox: string, file: unknown): Record<string, string> {
  const no = () => refuse(403, 'nightly: envFile must be a plain long-run-env-<digits>.json file directly in your sandbox, holding a JSON object of strings');
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw no();
  const given = path.resolve(file);
  if (!ENV_FILE.test(path.basename(given)) || !same(path.dirname(given), path.resolve(sandbox))) throw no();
  let raw: string;
  let fd: number | undefined;
  try {
    // The sandbox folder is itself (no link or junction standing for it).
    if (!same(fs.realpathSync(sandbox), path.resolve(sandbox))) throw no();
    const st = fs.lstatSync(given);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX_ENV_FILE) throw no();
    fd = fs.openSync(given, 'r');
    const ft = fs.fstatSync(fd);
    if (!ft.isFile() || ft.nlink !== 1 || ft.ino !== st.ino || ft.dev !== st.dev) throw no();
    raw = fs.readFileSync(fd, 'utf8');
  } catch (e) {
    if (fd !== undefined) fs.closeSync(fd);
    if (e instanceof RpcRefused) throw e;
    throw no();
  }
  fs.closeSync(fd);
  // Only now, and only this name in the sandbox folder (an unlink of a name: a link there is removed, never its target).
  fs.rmSync(given, { force: true });
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw no();
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw no();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (NAME.test(k) && typeof v === 'string' && !v.includes('\0')) env[k] = v;
  return env;
}

/** The run's environment: what it was given, less what ties it to its worker, plus its own id. */
export function runEnv(given: Record<string, string>, id: string): Record<string, string> {
  const env = { ...given };
  for (const k of Object.keys(env)) if (DROPPED_ENV.includes(k.toUpperCase())) delete env[k];
  env[RUN_ENV] = id;
  return env;
}

/** What a call asks for, checked: the plan, or a refusal. Nothing runs here; nothing is read or removed before the gate. */
export function planOf(d: LongRunsDeps, c: Caller, b: Record<string, unknown>, id: string): LongRunPlan {
  const name = b.name;
  if (typeof name !== 'string' || !Object.hasOwn(SANCTIONED, name)) throw refuse(400, `runs/start: name is one of ${Object.keys(SANCTIONED).join(', ')}`);
  if (!c.sandbox) throw refuse(403, 'runs/start: only a sandbox worker starts a long run');
  const sandbox = d.sandboxPath(c.sandbox);
  if (!sandbox) throw refuse(404, `runs/start: no sandbox ${c.sandbox} on this machine`);
  if (!d.isNightly(c.session)) throw refuse(403, 'runs/start nightly: this session works no nightly-run request (the portal marks none exempt "nightly")');
  const args = b.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === 'string' && a.length <= MAX_ARG && !a.includes('\0'))) throw refuse(400, `runs/start: args is a list of at most ${MAX_ARGS} strings`);
  const script = scriptOf(sandbox);
  const env = runEnv(readEnvFile(sandbox, b.envFile), id);
  const base = d.base ?? process.env;
  const keeperEnv: Record<string, string> = {};
  for (const k of BASICS) if (typeof base[k] === 'string') keeperEnv[k] = base[k] as string;
  return { name: 'nightly', exe: d.bash() ?? 'bash.exe', argv: [script, ...(args as string[])], cwd: sandbox, env, keeperEnv, limitS: MAX_RUN_S };
}

/** What stands in the way of starting it now, or undefined. */
function blocker(d: LongRunsDeps, platform: NodeJS.Platform): { node?: string; helper?: string; why?: string } {
  if (platform !== 'win32') return { why: `not built for ${platform} yet (w6367 measured Windows); start the run yourself as before` };
  const node = d.lowNode();
  if (!node) return { why: "no Low node copy: a worker's run is never started at the daemon's Medium integrity" };
  const bash = d.bash();
  if (!bash || !fs.existsSync(bash)) return { why: `no Git Bash for agents (${bash ?? 'none'})` };
  const helper = d.jobHelper();
  if (!helper) return { why: 'no job helper to give the run a job of its own (machine/winJob.cs); a long run never runs without one' };
  return { node, helper };
}

/** The keeper, started by the daemon detached (no process of a worker's host), its stdin kept for "go". */
function startKeeperReal(node: string, plan: LongRunPlan): Promise<Keeper> {
  return new Promise((resolve, reject) => {
    const c = spawn(node, ['-e', KEEPER_SCRIPT, plan.exe, plan.cwd, JSON.stringify(plan.argv), String(plan.limitS)], { cwd: plan.cwd, env: plan.keeperEnv, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    c.once('error', reject);
    c.stdin!.on('error', () => undefined);
    c.once('spawn', () => {
      c.unref();
      if (!c.pid) return reject(new Error('no pid'));
      resolve({
        pid: c.pid,
        go: (env) => {
          c.stdin!.end(`go ${JSON.stringify(env)}\n`);
        },
        kill: () => {
          try {
            c.kill();
          } catch {
            // gone
          }
        },
      });
    });
  });
}

/** Helpers kept while they hold a run's job (warn: counts only; enforce: its limits hold after the helper too). */
const helpers = new Set<ChildProcess>();

/** ffjob.exe around `pid` (winJob.cs): resolves true once it says ready. */
function joinJobReal(helper: string, pid: number, mode: CapsMode): Promise<boolean> {
  const caps = capsFor();
  return new Promise((resolve) => {
    const h = spawn(helper, [String(pid), String(caps.memoryBytes), String(caps.processes), mode === 'enforce' ? 'enforce' : 'warn'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let done = false;
    const end = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (!ok) {
        try {
          h.kill();
        } catch {
          // gone
        }
      }
      resolve(ok);
    };
    const t = setTimeout(() => end(false), 15_000);
    h.once('error', () => end(false));
    h.once('exit', () => {
      helpers.delete(h);
      end(false);
    });
    h.stdin!.on('error', () => undefined);
    let buf = '';
    h.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('"event":"ready"')) end(true);
    });
    helpers.add(h);
    h.unref();
    (h.stdout as unknown as { unref?: () => void }).unref?.();
  });
}

/** taskkill /T /F of a keeper: it and the run it started. */
function endTreeReal(pid: number): Promise<void> {
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve) => {
    const k = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    k.once('error', () => resolve());
    k.once('exit', () => resolve());
  });
}

/** The runs this daemon started that are still alive, from their records. */
export function liveRuns(d: Pick<LongRunsDeps, 'dir' | 'alive'>): LongRun[] {
  const alive = d.alive ?? pidAlive;
  let names: string[] = [];
  try {
    names = fs.readdirSync(d.dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: LongRun[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(d.dir, n), 'utf8')) as LongRun;
      if (alive(r.pid)) out.push(r);
      else fs.rmSync(path.join(d.dir, n), { force: true });
    } catch {
      // a half-written record: the next look
    }
  }
  return out;
}

const said = (p: LongRunPlan) => `${p.exe} ${p.argv.map((a) => JSON.stringify(a)).join(' ')} in ${p.cwd} (no FF_SESSION_ID; ended after ${p.limitS / 3600} h)`;

/** The routes: `runs/start` {name, args, envFile}, `runs/stop` {id} and `runs/status`. */
export function longRunsRpcHandlers(d: LongRunsDeps): Record<string, RpcHandler> {
  const platform = d.platform ?? process.platform;
  return {
    'runs/start': async (c, b) => {
      const mode = d.mode();
      if (mode === 'off') throw refuse(409, 'runs/start: long runs are off on this machine (daemon.json longRuns); start the run yourself');
      const id = `lr-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
      const plan = planOf(d, c, b, id);
      const live = liveRuns(d).filter((r) => r.sandbox === c.sandbox);
      const k = blocker(d, platform);
      const caps = d.capsMode();
      const how = `at Low integrity, in a job of its own (caps ${caps === 'enforce' ? 'enforce' : 'warn'})`;
      if (mode === 'warn') {
        const why = k.why ?? (live.length >= MAX_LIVE ? `${live.length} long runs of this sandbox are live` : undefined);
        d.log(`long runs (warn): would start ${plan.name} for ${c.session} in ${c.sandbox}: ${said(plan)}, ${how}; ${why ? `could not now: ${why}` : 'ready'}; not started, so the caller starts it itself as before (w6367)`);
        return { mode: 'warn', started: false, ready: !why, ...(why ? { why } : {}) };
      }
      if (k.why) throw refuse(503, `runs/start: ${k.why}`);
      if (live.length >= MAX_LIVE) throw refuse(409, `runs/start: ${live.length} long runs of ${c.sandbox} are live (${live.map((r) => r.id).join(', ')})`);
      const keeper = await (d.startKeeper ?? startKeeperReal)(k.node!, plan);
      if (!(await (d.joinJob ?? joinJobReal)(k.helper!, keeper.pid, caps === 'enforce' ? 'enforce' : 'warn'))) {
        keeper.kill();
        throw refuse(503, `runs/start: could not put the run in a job of its own (pid ${keeper.pid}); not started`);
      }
      keeper.go(plan.env);
      const rec: LongRun = { id, name: plan.name, session: c.session, sandbox: c.sandbox!, pid: keeper.pid, startedAt: new Date().toISOString(), job: true };
      fs.mkdirSync(d.dir, { recursive: true });
      fs.writeFileSync(path.join(d.dir, `${id}.json`), JSON.stringify(rec));
      d.log(`long runs: started ${id} (${plan.name}) for ${c.session} in ${c.sandbox}: keeper pid ${keeper.pid}, ${said(plan)}, ${how} (w6367)`);
      return { mode: 'on', started: true, id, pid: keeper.pid, job: true };
    },
    'runs/stop': async (c, b) => {
      const run = liveRuns(d).find((r) => r.id === b.id && r.sandbox === c.sandbox);
      if (!run) throw refuse(404, `runs/stop: no live long run ${String(b.id)} of your sandbox`);
      await (d.endTree ?? endTreeReal)(run.pid);
      fs.rmSync(path.join(d.dir, `${run.id}.json`), { force: true });
      d.log(`long runs: stopped ${run.id} (${run.name}) for ${c.session} in ${c.sandbox}: keeper pid ${run.pid} and its tree ended (w6367)`);
      return { stopped: run.id };
    },
    'runs/status': (c) => ({ mode: d.mode(), runs: liveRuns(d).filter((r) => r.sandbox === c.sandbox) }),
  };
}

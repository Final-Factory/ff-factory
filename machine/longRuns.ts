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
 * - In a job of its own with the worker caps' mode and limits (machine/workerCaps.ts, winJob.cs: no breakaway, and in
 *   enforce the commit and process limits), made before the run starts anything: a keeper node waits for the job, then
 *   starts the run as its child and exits with its exit code.
 * - Carrying no FF_SESSION_ID or FF_FOR_PERSON, so the leftovers sweep (machine/leftovers.ts) does not count it as its
 *   worker's leftovers, and the worker's own `ff-leftovers end` leaves it; FF_LONG_RUN names it instead.
 * Only fixed routes run (SANCTIONED): `nightly`, the game repo's scripts/nightly/nightly_run.sh in the caller's own
 * sandbox, and only for a session the portal marks exempt "nightly" (it works an open nightly-run request; the same mark
 * the bench uses, w1832); and `probe`, the daemon's own few lines (a sleep with an exit trap) for proving the route on a
 * machine. Nothing else a worker names is run.
 *
 * daemon.json `longRuns` (off | warn | on; ops_worker machine_update long_runs). warn, the default (lothsahn's lockout
 * rule: warn-only first): every check is made and the daemon logs what it would start, then refuses with mode "warn", so
 * the caller starts the run itself as before. on: it starts. off: refused at once. The game's client falls back to its own
 * start on any refusal or error, so a bad switch costs a night at most what it costs today, and warn or off is the way back
 * (docs/worker-fence.md "Long runs").
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
  probe: {},
} as const;
export type LongRunName = keyof typeof SANCTIONED;

/** The probe's script, the daemon's own: `bash -c PROBE_SCRIPT probe <out> <seconds>`. Its exit trap writes the last line. */
export const PROBE_SCRIPT =
  'out="$1"; s="$2"; trap \'echo "exit trap $(date -u +%Y-%m-%dT%H:%M:%SZ) pid $$" >> "$out"\' EXIT; echo "started $(date -u +%Y-%m-%dT%H:%M:%SZ) pid $$ FF_LONG_RUN=$FF_LONG_RUN FF_SESSION_ID=${FF_SESSION_ID:-none}" >> "$out"; i=0; while [ "$i" -lt "$s" ]; do sleep 60; i=$((i + 60)); echo "alive $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$out"; done';

/**
 * The keeper (run by the Low node copy): `node -e KEEPER_SCRIPT <exe> <cwd> <args JSON>`. It waits for "go" on stdin (the
 * daemon sends it once the keeper is in the run's job, so everything the run starts is in the job), then starts the run as
 * its child and exits with its code. After "go" its stdin may close (the daemon restarts): it keeps running. No "go" in a
 * minute, or stdin closed first: it exits without starting anything.
 */
export const KEEPER_SCRIPT =
  "const{spawn}=require('node:child_process');const[,b,c,a]=process.argv;let go=false,buf='';const t=setTimeout(()=>process.exit(3),60000);process.stdin.on('error',()=>{});process.stdin.on('end',()=>{if(!go)process.exit(2)});process.stdin.on('data',(d)=>{if(go)return;buf+=d;if(!buf.includes('go\\n'))return;go=true;clearTimeout(t);const p=spawn(b,JSON.parse(a),{cwd:c,stdio:'ignore',windowsHide:true});p.on('error',()=>process.exit(4));p.on('exit',(code)=>process.exit(code??1))});";

/** Variables a long run never carries: what ties a process to its worker for the sweep and the caps' kills. */
export const DROPPED_ENV = ['FF_SESSION_ID', 'FF_FOR_PERSON', 'FF_TIMED_RUN', 'FF_UNITY_MCP'];
export const RUN_ENV = 'FF_LONG_RUN';
const MAX_ARGS = 20;
const MAX_ARG = 1024;
const MAX_ENV_FILE = 256 * 1024;
const MAX_PROBE_S = 6 * 3600;
/** Live runs a sandbox may have at once. */
const MAX_LIVE = 2;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

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
  env: Record<string, string>;
}

export interface LongRunsDeps {
  platform?: NodeJS.Platform;
  /** The install root (FF_WORKER_ROOT). */
  root: string;
  /** Where the runs' records go (`<appDir>/long-runs`). */
  dir: string;
  mode: () => LongRunsSetting;
  /** The worker caps' mode (daemon.json workerCaps): the run's job takes it. */
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
  /** The daemon's own environment, for the probe's few basics. */
  base?: NodeJS.ProcessEnv;
  alive?: (pid: number) => boolean;
  /** Tests: start the keeper; answer its pid and a way to send it "go". */
  startKeeper?: (node: string, plan: LongRunPlan) => Promise<{ pid: number; go: () => void; kill: () => void }>;
  /** Tests: put a pid in a job of its own; resolves true once it is in. */
  joinJob?: (helper: string, pid: number, mode: CapsMode) => Promise<boolean>;
  log: (line: string) => void;
}

const refuse = (status: number, message: string) => new RpcRefused(message, status);
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

/** A regular file at `p` whose real path lies inside `dir` (no link out of it). */
function fileInside(dir: string, p: string, what: string): string {
  let real: string;
  let realDir: string;
  try {
    real = fs.realpathSync(p);
    realDir = fs.realpathSync(dir);
  } catch {
    throw refuse(404, `${what}: ${p} is not there`);
  }
  if (!inside(realDir, real)) throw refuse(403, `${what}: ${p} lies outside ${dir}`);
  if (!fs.lstatSync(real).isFile()) throw refuse(403, `${what}: ${p} is not a plain file`);
  return real;
}

/** The env file the nightly worker wrote: a JSON object of strings, read and then removed (it may hold its tokens). */
export function readEnvFile(root: string, file: unknown): Record<string, string> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw refuse(400, 'nightly: envFile is the absolute path of a JSON file of the run\'s environment');
  const real = fileInside(root, file, 'nightly: envFile');
  let raw: string;
  try {
    if (fs.statSync(real).size > MAX_ENV_FILE) throw refuse(413, `nightly: envFile is over ${MAX_ENV_FILE} bytes`);
    raw = fs.readFileSync(real, 'utf8');
  } finally {
    fs.rmSync(real, { force: true });
  }
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw refuse(400, 'nightly: envFile is not JSON');
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw refuse(400, 'nightly: envFile is not a JSON object');
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

const BASICS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOME', 'USERNAME'];

/** What a call asks for, checked: the plan, or a refusal. Nothing runs here. */
export function planOf(d: LongRunsDeps, c: Caller, b: Record<string, unknown>, id: string): LongRunPlan {
  const name = b.name;
  if (typeof name !== 'string' || !Object.hasOwn(SANCTIONED, name)) throw refuse(400, `runs/start: name is one of ${Object.keys(SANCTIONED).join(', ')}`);
  if (!c.sandbox) throw refuse(403, 'runs/start: only a sandbox worker starts a long run');
  const sandbox = d.sandboxPath(c.sandbox);
  if (!sandbox) throw refuse(404, `runs/start: no sandbox ${c.sandbox} on this machine`);
  const bash = d.bash();
  if (name === 'nightly') {
    if (!d.isNightly(c.session)) throw refuse(403, 'runs/start nightly: this session works no nightly-run request (the portal marks none exempt "nightly")');
    const script = fileInside(sandbox, path.join(sandbox, SANCTIONED.nightly.script), 'nightly');
    const args = b.args ?? [];
    if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === 'string' && a.length <= MAX_ARG && !a.includes('\0'))) throw refuse(400, `runs/start: args is a list of at most ${MAX_ARGS} strings`);
    const env = runEnv(readEnvFile(d.root, b.envFile), id);
    return { name, exe: bash ?? 'bash.exe', argv: [script, ...(args as string[])], cwd: sandbox, env };
  }
  const seconds = Number(b.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_PROBE_S) throw refuse(400, `runs/start probe: seconds is a whole number from 1 to ${MAX_PROBE_S}`);
  const out = b.out;
  if (typeof out !== 'string' || !path.isAbsolute(out)) throw refuse(400, 'runs/start probe: out is the absolute path of the file it writes');
  const tmp = path.join(d.root, 'tmp');
  if (!(inside(tmp, path.resolve(out)) || inside(sandbox, path.resolve(out)))) throw refuse(403, `runs/start probe: out lies outside ${tmp} and the sandbox`);
  const base = d.base ?? process.env;
  const env: Record<string, string> = {};
  for (const k of BASICS) if (typeof base[k] === 'string') env[k] = base[k] as string;
  // Git Bash's own tools (date, sleep) first.
  if (bash) {
    const usr = path.join(path.dirname(path.dirname(bash)), 'usr', 'bin');
    const key = env.Path !== undefined ? 'Path' : 'PATH';
    env[key] = [usr, env[key]].filter(Boolean).join(path.delimiter);
  }
  return { name: 'probe', exe: bash ?? 'bash.exe', argv: ['-c', PROBE_SCRIPT, 'probe', path.resolve(out), String(seconds)], cwd: sandbox, env: runEnv(env, id) };
}

/** What stands in the way of starting it now, or undefined. */
function blocker(d: LongRunsDeps, platform: NodeJS.Platform): { node?: string; helper?: string; why?: string } {
  if (platform !== 'win32') return { why: `not built for ${platform} yet (w6367 measured Windows); start the run yourself as before` };
  const node = d.lowNode();
  if (!node) return { why: "no Low node copy: a worker's run is never started at the daemon's Medium integrity" };
  const bash = d.bash();
  if (!bash || !fs.existsSync(bash)) return { why: `no Git Bash for agents (${bash ?? 'none'})` };
  if (d.capsMode() === 'off') return { node };
  const helper = d.jobHelper();
  if (!helper) return { why: 'no job helper to give the run a job of its own (machine/winJob.cs)' };
  return { node, helper };
}

/** The keeper, started by the daemon detached (no process of a worker's host), its stdin kept for "go". */
function startKeeperReal(node: string, plan: LongRunPlan): Promise<{ pid: number; go: () => void; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const c = spawn(node, ['-e', KEEPER_SCRIPT, plan.exe, plan.cwd, JSON.stringify(plan.argv)], { cwd: plan.cwd, env: plan.env, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    c.once('error', reject);
    c.stdin!.on('error', () => undefined);
    c.once('spawn', () => {
      c.unref();
      if (!c.pid) return reject(new Error('no pid'));
      resolve({
        pid: c.pid,
        go: () => {
          c.stdin!.end('go\n');
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

const said = (p: LongRunPlan) => `${p.exe} ${p.name === 'probe' ? `-c <probe> ${p.argv.slice(2).join(' ')}` : p.argv.map((a) => JSON.stringify(a)).join(' ')} in ${p.cwd}, ${Object.keys(p.env).length} environment variables (no FF_SESSION_ID)`;

/** The routes: `runs/start` {name, ...} and `runs/status`. */
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
      const how = `at Low integrity, ${caps === 'off' ? 'with no job (workerCaps off)' : `in a job of its own (caps ${caps})`}`;
      if (mode === 'warn') {
        const why = k.why ?? (live.length >= MAX_LIVE ? `${live.length} long runs of this sandbox are live` : undefined);
        d.log(`long runs (warn): would start ${plan.name} for ${c.session} in ${c.sandbox}: ${said(plan)}, ${how}; ${why ? `could not now: ${why}` : 'ready'}; not started, so the caller starts it itself as before (w6367)`);
        return { mode: 'warn', started: false, ready: !why, ...(why ? { why } : {}), would: { name: plan.name, exe: plan.exe, cwd: plan.cwd, args: plan.argv.length, env: Object.keys(plan.env).length } };
      }
      if (k.why) throw refuse(503, `runs/start: ${k.why}`);
      if (live.length >= MAX_LIVE) throw refuse(409, `runs/start: ${live.length} long runs of ${c.sandbox} are live (${live.map((r) => r.id).join(', ')})`);
      const keeper = await (d.startKeeper ?? startKeeperReal)(k.node!, plan);
      if (k.helper && !(await (d.joinJob ?? joinJobReal)(k.helper, keeper.pid, caps))) {
        keeper.kill();
        throw refuse(503, `runs/start: could not put the run in a job of its own (pid ${keeper.pid}); not started`);
      }
      keeper.go();
      const rec: LongRun = { id, name: plan.name, session: c.session, sandbox: c.sandbox!, pid: keeper.pid, startedAt: new Date().toISOString(), job: !!k.helper };
      fs.mkdirSync(d.dir, { recursive: true });
      fs.writeFileSync(path.join(d.dir, `${id}.json`), JSON.stringify(rec));
      d.log(`long runs: started ${id} (${plan.name}) for ${c.session} in ${c.sandbox}: keeper pid ${keeper.pid}, ${said(plan)}, ${how} (w6367)`);
      return { mode: 'on', started: true, id, pid: keeper.pid, job: rec.job };
    },
    'runs/status': (c) => ({ mode: d.mode(), runs: liveRuns(d).filter((r) => r.sandbox === c.sandbox) }),
  };
}

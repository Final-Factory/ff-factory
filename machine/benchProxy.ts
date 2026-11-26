// w5545: bench tickets taken through the daemon's calls (machine/daemonRpc.ts), keyed to the calling session. The queue
// lives in the daemon's own folder (machine/benchLock.ts benchLockDir), which workers cannot write, so a worker's ticket
// is the daemon's `bench_queue.py hold` helper, started with the caller's session and sandbox from its token: the
// ticket's info.json, and with it its priority (priorities.json, keyed by session), say who really asked. The rules are
// the queue script's as before (the newest copy here, benchQueue.ts newestBenchQueueScript), and so is every exclusive
// turn: the helper numbers, waits, grants, revokes and releases exactly as the in-process hold did.
//
// A handle is one helper. Its record (<dir>/<handle>.json: session, sandbox, helper pid) and its status file live in the
// daemon's folder too, so a handle outlives a daemon restart (the helper is detached; the Linux unit's KillMode=process
// leaves it running) and only its own session may read, register under or release it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { benchQueueDir, newestBenchQueueScript, pythonExe, queueTickets, refreshTrustedBenchAsync, supportsPlace, trustedBenchRun, trustedBenchScript, type BenchMode, type TrustedBench } from './benchQueue.ts';
import { RpcRefused, type Caller } from './daemonRpc.ts';

const HANDLE = /^h[0-9a-f]{16}$/;
/** A finished handle's files go this long after its helper ended (the client has read its last line by then). */
export const DONE_KEEP_MS = 30 * 60_000;

export interface BenchHandleRecord {
  handle: string;
  session: string;
  sandbox?: string;
  pid?: number;
  ownerPid: number;
  ownerKind: 'script' | 'service';
  mode: BenchMode;
  what: string;
  createdAt: string;
}

export interface BenchProxyDeps {
  /** Where records and status files go: inside the daemon's folder. */
  dir: string;
  /** The bench lock dir (benchLockDir(root)), or undefined when this machine keeps no queue. */
  lock: () => string | undefined;
  root?: string;
  /** A sandbox's checkout, for the queue script's newest copy and the ticket's cwd. */
  sandboxPath: (id: string) => string | undefined;
  alive: (pid: number) => boolean;
  /** The FF_SESSION_ID a process runs under (machine/leftovers.ts readEnvs), or undefined when it cannot be read. */
  sessionOf: (pid: number) => Promise<string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
  /** w5572: run the game repo's master copy the daemon fetched, never a sandbox's (the daemon passes it; tests may not). */
  trusted?: TrustedBench;
  /** Tests: start the helper. */
  spawnHelper?: (python: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv }) => { pid?: number; onExit(cb: (code: number | null) => void): void };
}

export type ProxyState = { kind: 'waiting' | 'granted' | 'failed'; line: string; ticket?: string; warn?: string; exit?: number };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export class BenchProxy {
  private readonly d: BenchProxyDeps;
  constructor(d: BenchProxyDeps) {
    this.d = d;
  }

  private rec = (h: string) => path.join(this.d.dir, `${h}.json`);
  private status = (h: string) => path.join(this.d.dir, h);

  private read(h: string): BenchHandleRecord | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.rec(h), 'utf8')) as BenchHandleRecord;
    } catch {
      return undefined;
    }
  }

  /** The caller's own handle, or a refusal. */
  private own(c: Caller, b: Record<string, unknown>): BenchHandleRecord {
    const h = str(b.handle, 40);
    if (!HANDLE.test(h)) throw new RpcRefused(`not a bench handle: "${h}"`);
    const r = this.read(h);
    if (!r) throw new RpcRefused(`no bench handle ${h} here (released, or from before a cleanup)`, 404);
    if (r.session !== c.session) throw new RpcRefused(`bench handle ${h} is another session's`, 403);
    return r;
  }

  /** Take a ticket for the caller: the daemon's helper holds it, following `ownerPid` (the caller's process). */
  async take(c: Caller, b: Record<string, unknown>): Promise<{ handle: string; ownerKind: 'script' | 'service' }> {
    const mode = b.mode === 'exclusive' ? 'exclusive' : b.mode === 'shared' ? 'shared' : undefined;
    if (!mode) throw new RpcRefused('mode: "shared" or "exclusive"');
    const ownerPid = Number(b.ownerPid);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new RpcRefused('ownerPid: the process the ticket follows, a positive integer');
    if (!this.d.alive(ownerPid)) throw new RpcRefused(`ownerPid ${ownerPid} is not running`);
    const lock = this.d.lock();
    if (!lock) throw new RpcRefused('no worker root here to keep the bench queue under');
    const cwd = c.sandbox ? this.d.sandboxPath(c.sandbox) : undefined;
    // The ticket says who asked from the token alone. The daemon's own token and secrets stay out of the helper.
    const { FF_DAEMON_TOKEN: _t, FF_DAEMON_RPC: _r, FF_BENCH_TICKET: _h, ...base } = process.env;
    const askEnv: NodeJS.ProcessEnv = { ...base, FF_SESSION_ID: c.session, FF_SANDBOX_ID: c.sandbox ?? '', FF_BENCH_SESSION: '', ...(cwd ? { FF_SANDBOX_PATH: cwd } : {}) };
    // w5973: an old copy is fetched first without holding the daemon's loop; then trustedBenchRun finds it fresh.
    const fetchFailed = this.d.trusted ? await refreshTrustedBenchAsync(this.d.trusted, this.d.root) : undefined;
    // With no copy at all, what the fetch said is the refusal (not "fetching": it has just failed).
    if (fetchFailed && this.d.trusted && !fs.existsSync(trustedBenchScript(this.d.trusted.appDir))) throw new RpcRefused(`no trusted bench_queue.py in the daemon's folder (w5572): ${fetchFailed}`);
    const tr = this.d.trusted ? trustedBenchRun(this.d.trusted, this.d.root, askEnv) : undefined;
    if (tr && 'why' in tr) throw new RpcRefused(tr.why);
    const script = tr ? tr.script : newestBenchQueueScript([cwd], this.d.root);
    if (!script) throw new RpcRefused('no scripts/bench/bench_queue.py in any sandbox here');
    // A script owner's revoked turn is stopped by the helper (SIGTERM to the owner and what it started, w1656): only for
    // an owner that runs under the caller's own session, so no worker can point a revoke at another's process.
    let ownerKind: 'script' | 'service' = b.ownerKind === 'script' ? 'script' : 'service';
    const ownerWinpid = Number(b.ownerWinpid);
    if (ownerKind === 'script') {
      const of = await this.d.sessionOf(Number.isInteger(ownerWinpid) && ownerWinpid > 0 ? ownerWinpid : ownerPid).catch(() => undefined);
      if (of !== c.session) ownerKind = 'service';
    }
    this.sweep();
    fs.mkdirSync(this.d.dir, { recursive: true });
    const handle = `h${randomBytes(8).toString('hex')}`;
    const args = [script, '--lock', lock, 'hold', '--mode', mode, '--what', str(b.what, 200) || `${c.session}`, '--owner-pid', String(ownerPid), '--status', this.status(handle)];
    if (Number.isInteger(ownerWinpid) && ownerWinpid > 0) args.push('--owner-winpid', String(ownerWinpid));
    const start = str(b.ownerStart, 60);
    if (start && /^[\w.:-]+$/.test(start)) args.push('--owner-start', start);
    const maxMin = Number(b.maxMin);
    if (Number.isFinite(maxMin) && maxMin > 0) args.push('--max-min', String(maxMin));
    if (b.reason === 'timing' || b.reason === 'machine') args.push('--reason', b.reason);
    const place = Number(b.place);
    if (mode === 'exclusive' && Number.isFinite(place) && place > 0 && supportsPlace(script)) args.push('--place', String(place));
    if (b.detached === true) args.push('--detached');
    args.push('--owner-kind', ownerKind);
    const rec: BenchHandleRecord = { handle, session: c.session, ...(c.sandbox ? { sandbox: c.sandbox } : {}), ownerPid, ownerKind, mode, what: str(b.what, 200), createdAt: new Date(this.now()).toISOString() };
    const child = tr ? (this.d.spawnHelper ?? spawnDetached)(tr.python, [...tr.pythonArgs, ...args], { cwd: tr.cwd, env: tr.env }) : (this.d.spawnHelper ?? spawnDetached)(pythonExe(askEnv), args, { cwd, env: askEnv });
    if (!child.pid) throw new RpcRefused('the bench queue helper did not start');
    rec.pid = child.pid;
    fs.writeFileSync(this.rec(handle), JSON.stringify(rec));
    child.onExit((code) => {
      try {
        fs.writeFileSync(`${this.status(handle)}.exit`, String(code ?? -1));
      } catch {
        // released and swept
      }
    });
    this.d.log?.(`bench proxy: ${handle} ${mode} "${rec.what}" for ${c.session}${c.sandbox ? ` (${c.sandbox})` : ''}, owner ${ownerPid} (${ownerKind}), helper ${child.pid}`);
    return { handle, ownerKind };
  }

  /** What the helper says now (the lines BenchTicket.state reads), and its warning line. */
  state(c: Caller, b: Record<string, unknown>): ProxyState {
    return this.stateOf(this.own(c, b));
  }

  private stateOf(r: BenchHandleRecord): ProxyState {
    const read = (f: string) => {
      try {
        return fs.readFileSync(f, 'utf8').trim();
      } catch {
        return undefined;
      }
    };
    const line = (read(this.status(r.handle)) ?? '').split(/\r?\n/)[0] ?? '';
    const warn = read(`${this.status(r.handle)}.warn`);
    const exitText = read(`${this.status(r.handle)}.exit`);
    const exit = exitText !== undefined && /^-?\d+$/.test(exitText) ? Number(exitText) : undefined;
    const extra = { ...(warn ? { warn } : {}), ...(exit !== undefined ? { exit } : {}) };
    const g = /^granted (t\d{8})/.exec(line);
    const gone = exit !== undefined || (r.pid !== undefined && !this.d.alive(r.pid));
    if (g && !gone) return { kind: 'granted', ticket: g[1], line, ...extra };
    if (/^(gave up|revoked|released)/.test(line)) return { kind: 'failed', line, ...extra };
    if (gone) return { kind: 'failed', line: `the bench queue helper ended${exit !== undefined ? ` (exit ${exit})` : ''}${line ? ` after: ${line}` : ''}`, ...extra };
    return { kind: 'waiting', line: line.replace(/^waiting /, '') || 'taking a ticket', ...extra };
  }

  /** Let go: the helper sees `<status>.release` and frees the ticket (its own only). */
  release(c: Caller, b: Record<string, unknown>): { released: boolean } {
    const r = this.own(c, b);
    try {
      fs.writeFileSync(`${this.status(r.handle)}.release`, '');
    } catch {
      return { released: false };
    }
    return { released: true };
  }

  /** Note a process started inside the ticket (bench_queue.py register_pid: a game player), so a revoked turn stops it too. */
  register(c: Caller, b: Record<string, unknown>): { ticket?: string } {
    const pid = Number(b.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new RpcRefused('pid: a positive integer');
    const lock = this.d.lock();
    if (!lock) throw new RpcRefused('no worker root here to keep the bench queue under');
    // By handle, or by ticket name: a game player launched inside the ticket knows only $FF_BENCH_TICKET. Either way the
    // ticket must be granted, live and taken for the caller's own session (its info.json says whose, as its helper wrote it).
    let ticket: string | undefined;
    if (b.handle !== undefined) {
      const s = this.stateOf(this.own(c, b));
      if (s.kind !== 'granted' || !s.ticket) throw new RpcRefused(`bench handle ${String(b.handle)} holds no ticket (${s.line})`);
      ticket = s.ticket;
    } else {
      ticket = String(b.ticket ?? '');
      if (!/^t\d{8}$/.test(ticket)) throw new RpcRefused(`not a ticket: "${ticket.slice(0, 40)}"`);
    }
    const t = queueTickets(lock, this.d.alive).find((q) => q.ticket === ticket);
    if (!t || !t.granted || t.revoked) throw new RpcRefused(`ticket ${ticket} is not a held ticket here`, 404);
    if (t.session !== c.session) throw new RpcRefused(`ticket ${ticket} is another session's`, 403);
    const start = str(b.start, 60);
    fs.appendFileSync(path.join(benchQueueDir(lock), ticket, 'pids'), `${pid} ${/^[\w.:-]+$/.test(start) ? start : ''}\n`);
    return { ticket };
  }

  /** Records of helpers that ended long ago, and their files, go. */
  sweep() {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.d.dir);
    } catch {
      return;
    }
    const now = this.now();
    for (const n of names) {
      const m = /^(h[0-9a-f]{16})\.json$/.exec(n);
      if (!m) continue;
      const r = this.read(m[1]);
      const st = fs.statSync(this.rec(m[1]), { throwIfNoEntry: false });
      const done = !r || (r.pid !== undefined && !this.d.alive(r.pid));
      if (!done || !st || now - st.mtimeMs < DONE_KEEP_MS) continue;
      for (const f of [this.rec(m[1]), this.status(m[1]), `${this.status(m[1])}.warn`, `${this.status(m[1])}.release`, `${this.status(m[1])}.exit`, `${this.status(m[1])}.tmp`]) fs.rmSync(f, { force: true });
    }
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  handlers(): Record<string, (c: Caller, b: Record<string, unknown>) => unknown> {
    return {
      'bench/take': (c, b) => this.take(c, b),
      'bench/state': (c, b) => this.state(c, b),
      'bench/release': (c, b) => this.release(c, b),
      'bench/register': (c, b) => this.register(c, b),
    };
  }
}

function spawnDetached(python: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(python, args, { cwd: o.cwd, env: o.env, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
  return { pid: child.pid, onExit: (cb: (code: number | null) => void) => void child.on('exit', cb) };
}

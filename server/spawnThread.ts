/**
 * Programs started from a worker thread (w6077). Node's execFile awaits the program's output, but starting it (uv_spawn, on
 * Windows CreateProcess) runs on the calling thread before it returns. On BEAST that start alone held the daemon's loop: on
 * 2026-11-26 12:25-13:59 UTC its LoopWatch charged the synchronous part of `timer strayLowServers` (one PowerShell start) up to
 * 35.5 s and of `timer refreshMcpScopes` (one process listing) up to 8.9 s, in 62 of 117 "event loop: blocked" lines. Here the
 * start runs on a thread of its own, so the loop goes on answering while Windows starts the program.
 *
 * Behaviour is execFile's: the same options, error, stdout and stderr reach the callback. When the thread cannot start or keeps
 * dying, programs start on the calling thread again, as before (logged once), so nothing here can keep a program from running.
 */
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';

/** The thread's code, plain JavaScript so it runs from the source tree and from the installed app alike. */
const THREAD = `
const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const kids = new Map();
parentPort.on('message', (m) => {
  if (m.kill !== undefined) {
    const c = kids.get(m.kill);
    if (c) c.kill();
    return;
  }
  let c;
  const done = (err, stdout, stderr) => {
    kids.delete(m.id);
    parentPort.postMessage({ id: m.id, err: err ? { message: err.message, code: err.code, signal: err.signal, killed: err.killed } : null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  };
  try {
    c = execFile(m.cmd, m.args, m.opts, done);
  } catch (e) {
    return done(e, '', '');
  }
  kids.set(m.id, c);
  // The program's pid, so the main side can end it if this thread dies first: its timeout timer would die with the thread.
  if (c.pid) parentPort.postMessage({ started: m.id, pid: c.pid });
});
`;

/**
 * execFile's options that cross to the thread (structured clone; `signal` stays here and aborting is a message). The
 * environment is always sent whole: the thread's own process.env is a copy from when it started, and the daemon changes its own.
 */
export interface ThreadExecOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
  encoding?: BufferEncoding;
  signal?: AbortSignal;
}

export type ExecCallback = (err: (Error & { code?: number | string; signal?: string | null; killed?: boolean }) | null, stdout: string, stderr: string) => void;

/** A thread that died this many times within DEATH_WINDOW_MS is given up: programs start on the calling thread again. */
const MAX_DEATHS = 3;
const DEATH_WINDOW_MS = 60_000;

let enabled = false;
let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, ExecCallback>();
/** The pids of pending programs, by call id: a thread that dies leaves them running, with no timeout left to end them. */
const pids = new Map<number, number>();
let deaths: number[] = [];
let say: (line: string) => void = (l) => console.warn(l);

/** Turn the thread on (the daemon, at start) or off; `log` gets its one-off lines. Off: execFileOffThread is execFile. */
export function useSpawnThread(on: boolean, log?: (line: string) => void) {
  enabled = on;
  if (log) say = log;
  if (!on) stopThread();
}

/** Whether programs start on the thread now (tests, and the daemon's start line). */
export function spawnThreadOn(): boolean {
  return enabled;
}

function stopThread() {
  const w = worker;
  worker = undefined;
  if (w) void w.terminate();
  settle('the spawn thread was turned off');
}

/**
 * Answer the pending programs -1 and end the ones still running. Ending them is what execFile's own timeout or abort would
 * have done (child.kill(): SIGTERM, on Windows TerminateProcess), so a git left running cannot hold index.lock forever.
 */
function settle(why: string) {
  for (const pid of pids.values()) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  pids.clear();
  const err = Object.assign(new Error(`spawn thread ended (${why}); the program's result is unknown`), { code: -1 });
  const cbs = [...pending.values()];
  pending.clear();
  for (const cb of cbs) cb(err, '', '');
}

function lost(why: string) {
  worker = undefined;
  const now = Date.now();
  deaths = [...deaths.filter((t) => now - t < DEATH_WINDOW_MS), now];
  settle(why);
  if (deaths.length >= MAX_DEATHS) {
    enabled = false;
    say(`spawn thread: ended ${deaths.length} times in ${DEATH_WINDOW_MS / 1000} s (last: ${why}); programs start on the main thread again (w6077)`);
  } else say(`spawn thread: ended (${why}); a new one starts with the next program (w6077)`);
}

function thread(): Worker | undefined {
  if (worker) return worker;
  try {
    const w = new Worker(THREAD, { eval: true });
    w.unref();
    w.on('message', (m: { started?: number; pid?: number; id: number; err: { message: string; code?: number | string; signal?: string | null; killed?: boolean } | null; stdout: string; stderr: string }) => {
      if (m.started !== undefined) {
        if (m.pid && pending.has(m.started)) pids.set(m.started, m.pid);
        return;
      }
      const cb = pending.get(m.id);
      pids.delete(m.id);
      if (!cb) return;
      pending.delete(m.id);
      if (!pending.size) w.unref();
      cb(m.err ? Object.assign(new Error(m.err.message), { code: m.err.code, signal: m.err.signal, killed: m.err.killed }) : null, m.stdout, m.stderr);
    });
    w.on('error', (e: Error) => worker === w && lost(e.message));
    w.on('exit', (code) => worker === w && lost(`exit ${code}`));
    worker = w;
    return w;
  } catch (e) {
    enabled = false;
    say(`spawn thread: could not start (${(e as Error).message}); programs start on the main thread (w6077)`);
    return undefined;
  }
}

/**
 * execFile, with the program started on the spawn thread when it is on (useSpawnThread). The callback gets what execFile's
 * would: stdout and stderr as strings, and an error whose code is the exit status (or a string such as ENOENT), with signal
 * and killed. Aborting `signal` kills the program, as execFile does. One difference: where execFile throws at once (an argument
 * with a null byte, ERR_INVALID_ARG_VALUE), the thread answers that error through the callback instead (run() then answers
 * code -1, as its "never throws" promises). A thread that dies ends its running programs and answers them code -1.
 */
export function execFileOffThread(cmd: string, args: string[], opts: ThreadExecOptions, cb: ExecCallback): void {
  const w = enabled ? thread() : undefined;
  if (!w) {
    execFile(cmd, args, { ...opts, encoding: opts.encoding ?? 'utf8' }, (err, stdout, stderr) => cb(err as Parameters<ExecCallback>[0], String(stdout), String(stderr)));
    return;
  }
  const { signal, ...rest } = opts;
  const id = nextId++;
  let settled = false;
  const finish: ExecCallback = (err, stdout, stderr) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', abort);
    // execFile answers an abort with an AbortError (code ABORT_ERR, no signal), not the kill's SIGTERM: the same here.
    if (err && signal?.aborted) err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    cb(err, stdout, stderr);
  };
  const abort = () => w.postMessage({ kill: id });
  pending.set(id, finish);
  w.ref();
  try {
    w.postMessage({ id, cmd, args, opts: { ...rest, env: { ...(rest.env ?? process.env) }, encoding: rest.encoding ?? 'utf8' } });
  } catch (e) {
    pending.delete(id);
    if (!pending.size) w.unref();
    finish(Object.assign(new Error(`spawn thread: ${(e as Error).message}`), { code: -1 }), '', '');
    return;
  }
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
}

/** Tests: end the thread as a crash would (its pending programs answer code -1, the next one starts a new thread). */
export function endSpawnThreadForTest(): Promise<number> | undefined {
  return worker?.terminate();
}

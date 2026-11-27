import { Worker } from 'node:worker_threads';
import type { RunResult } from './proc.ts';

/**
 * w6234: the host-stats probes (nvidia-smi, the Windows GPU counters, vm_stat, sysctl) never hold the portal's event loop.
 *
 * Why a worker thread and not just execFile: execFile is asynchronous only once the child is running. The spawn itself
 * (CreateProcess on Windows, libuv's uv_spawn) runs on the calling thread, and on a fully loaded BEAST (2026-11-26, 32 cores
 * at 99.9%) Lens Scout's stall profiles read "Own time: spawn 11.4 s ... gpu (server/system.ts:189)", 27-38 s per stall at
 * its worst, every 5 s refresh. Here the spawn runs on a thread of its own, so a slow one blocks only that thread.
 */

// Plain JavaScript, run as an eval worker (CommonJS). execFile answers by callback, so jobs run side by side; only each
// spawn holds the thread, while it starts.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
parentPort.on('message', ({ id, cmd, args, timeoutMs, cwd, env, maxBuffer }) => {
  try {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: maxBuffer || 16 * 1024 * 1024, windowsHide: true, cwd, env }, (err, stdout, stderr) => {
      const raw = err ? err.code : undefined;
      parentPort.postMessage({
        id,
        code: !err ? 0 : typeof raw === 'number' ? raw : -1,
        stdout: String(stdout),
        stderr: String(stderr) || (err ? err.message : ''),
        timedOut: !!(err && err.killed && raw == null),
      });
    });
  } catch (e) {
    parentPort.postMessage({ id, code: -1, stdout: '', stderr: String((e && e.message) || e) });
  }
});
`;

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (r: RunResult) => void>();

/** The thread keeps the process alive only while a probe waits on it: a portal or test that is done exits. */
function idle() {
  if (!pending.size) worker?.unref();
}

function probeWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_SOURCE, { eval: true });
  w.on('message', (m: RunResult & { id: number }) => {
    const done = pending.get(m.id);
    pending.delete(m.id);
    idle();
    const { id: _id, ...r } = m;
    done?.(r);
  });
  const lost = (why: string) => {
    if (worker === w) worker = undefined;
    for (const [id, done] of pending) {
      pending.delete(id);
      done({ code: -1, stdout: '', stderr: `host probe thread ${why}` });
    }
  };
  w.on('error', (e: Error) => lost(`failed: ${e.message}`));
  w.on('exit', (c) => lost(`exited (${c})`));
  worker = w;
  return w;
}

/** Where and how the child runs: its folder, its whole environment (default: the portal's), its output cap (default 16 MB). */
export interface OffThreadOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

/**
 * Runs cmd on the probe thread. Answers within timeoutMs plus 5 s whatever the child does: a spawn still stuck in the
 * thread then answers timedOut here, and its late result is dropped. w6237: the guard's git, gh and python run here too.
 */
export function runOffThread(cmd: string, args: string[], timeoutMs: number, opts: OffThreadOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      idle();
      resolve({ code: -1, stdout: '', stderr: `${cmd}: no answer from the probe thread within ${timeoutMs + 5000} ms`, timedOut: true });
    }, timeoutMs + 5000);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    const w = probeWorker();
    w.ref();
    w.postMessage({ id, cmd, args, timeoutMs, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.env ? { env: { ...opts.env } } : {}), ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}) });
  });
}

export interface ProbeResult<T> {
  value: T | undefined;
  /** The probe gave up waiting (a timeout), as opposed to a tool that answered nothing useful. */
  timedOut?: boolean;
}

/**
 * One probe's last value. get() answers at once with the last value and starts a new probe only when none is running and
 * one is due: every everyMs, doubling after each timeout in a row up to maxBackoffMs, back to everyMs on the first answer.
 * A timeout keeps the last value.
 */
export class CachedProbe<T> {
  value: T | undefined;
  /** Timeouts in a row. */
  failures = 0;
  probes = 0;
  private running: Promise<void> | undefined;
  private nextAt = 0;
  private readonly name: string;
  private readonly probe: () => Promise<ProbeResult<T>>;
  private readonly o: { everyMs: number; maxBackoffMs: number; now?: () => number; log?: (line: string) => void };
  constructor(name: string, probe: () => Promise<ProbeResult<T>>, o: { everyMs: number; maxBackoffMs: number; now?: () => number; log?: (line: string) => void }) {
    this.name = name;
    this.probe = probe;
    this.o = o;
  }

  get(): T | undefined {
    this.kick();
    return this.value;
  }

  /** The probe now running, if any (tests, and a caller that can wait for a first value). */
  get inFlight(): Promise<void> | undefined {
    return this.running;
  }

  /** The wait before the next probe, in ms. */
  get delayMs(): number {
    return this.failures ? Math.min(this.o.everyMs * 2 ** this.failures, this.o.maxBackoffMs) : this.o.everyMs;
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private kick() {
    if (this.running || this.now() < this.nextAt) return;
    this.probes++;
    this.running = this.probe()
      .then(
        (r) => {
          if (r.timedOut) {
            this.failures++;
            if (this.failures === 3) (this.o.log ?? console.warn)(`host stats: the ${this.name} probe timed out 3 times in a row; probing it at most every ${Math.round(this.o.maxBackoffMs / 60_000)} min until it answers`);
          } else {
            this.failures = 0;
            this.value = r.value;
          }
        },
        () => undefined,
      )
      .finally(() => {
        this.nextAt = this.now() + this.delayMs;
        this.running = undefined;
      });
  }
}

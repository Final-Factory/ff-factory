import { Worker } from 'node:worker_threads';

/**
 * The daemon's freeze watch (w6555): a thread of its own that sees the main event loop frozen WHILE it is frozen.
 *
 * Why: on 2026-11-27 BEAST's daemon held its loop 891 s (22:06:47-22:21:38Z) in a synchronous realpath under the session
 * temp-folder sweep (w6546; fixed in w6553). The portal dropped it after 60 s with no answer and moved its work away, and the
 * machine stayed offline until the loop came free by itself; it reconnected 3 s later. The loop watch (server/loopWatch.ts) and
 * the stall profiler (server/stallProfile.ts) run ON the loop, so they could only say so after the block ended: during it the
 * daemon's log said nothing at all.
 *
 * How: the main thread stores Date.now() into a SharedArrayBuffer once a second. The thread here reads it once a second on its
 * own event loop, which a frozen main loop does not hold. When the beat is older than `afterMs` it writes a line straight to the
 * daemon's stdout (fd 1, which the supervisor sends to logs/daemon.log; console.log from a worker would go through the frozen
 * main thread), and asks V8 for the main thread's stack over the in-process inspector (Session.connectToMainThread: no port is
 * opened). V8 answers that at the main thread's next JavaScript step, so a loop of synchronous calls (the 891 s block was many
 * realpath calls) is named within milliseconds; the main thread is resumed at once after its stack is read. While the freeze
 * lasts it says so again every `repeatMs`, each time with the stack again.
 *
 * Stage 1 (this) only logs (lothsahn's lockout rule: a daemon change ships warn-only first). Ending the process, so the
 * supervisor starts a fresh daemon, is stage 2.
 */

export interface FreezeWatchSettings {
  /** Minutes with no beat from the main loop before the first line. */
  afterMin: number;
  /** Minutes between the lines of one freeze that goes on. */
  repeatMin: number;
}

export const FREEZE_DEFAULTS: FreezeWatchSettings = { afterMin: 3, repeatMin: 5 };

/** daemon.json `freezeWatch`: `false` turns it off; else afterMin (1-60) and repeatMin (1-120), the defaults for anything else. */
export function freezeWatchSettings(raw: unknown): FreezeWatchSettings | undefined {
  if (raw === false) return undefined;
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const n = (k: keyof FreezeWatchSettings, min: number, max: number) => (typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= min && (r[k] as number) <= max ? (r[k] as number) : FREEZE_DEFAULTS[k]);
  return { afterMin: n('afterMin', 1, 60), repeatMin: n('repeatMin', 1, 120) };
}

// Plain JavaScript, run as an eval worker (CommonJS), as server/hostProbe.ts does.
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const beat = new BigInt64Array(workerData.sab);
const { afterMs, repeatMs, everyMs, fd, who } = workerData;
const out = (line) => {
  try { fs.writeSync(fd, new Date().toISOString() + ' ' + line + '\\n'); } catch {}
};
// Debugger.paused's frames carry a scriptId; its url comes from the scriptParsed events Debugger.enable sends first.
const urls = new Map();
const where = (f) => {
  const url = f.url || urls.get(f.location && f.location.scriptId) || '';
  const file = url ? url.replace(/^file:\\/\\//, '').split('/').slice(-2).join('/') : '';
  const name = f.functionName || '(anonymous)';
  return name + (file ? ' (' + file + ':' + (f.location.lineNumber + 1) + ')' : '');
};
let warnedAt = 0;
let session;
const drop = (s) => {
  try { s.disconnect(); } catch {}
  if (session === s) session = undefined;
};
function askStack() {
  if (session) return;
  let s;
  try {
    const { Session } = require('node:inspector');
    s = new Session();
    s.connectToMainThread();
    session = s;
  } catch (e) {
    out('event loop: frozen: could not read the main thread\\'s stack: ' + ((e && e.message) || e));
    session = undefined;
    return;
  }
  s.on('Debugger.scriptParsed', (m) => { if (m.params && m.params.url) urls.set(m.params.scriptId, m.params.url); });
  s.on('Debugger.paused', (m) => {
    // Resume FIRST: a throw in this listener would leave the main thread paused for good (w6565's review measured it).
    // The frames are plain data in m, so reading them after the resume is fine.
    try { s.post('Debugger.resume', () => { try { s.post('Debugger.disable', () => drop(s)); } catch { drop(s); } }); } catch { drop(s); }
    try {
      const frames = ((m.params && m.params.callFrames) || []).slice(0, 12).map(where);
      // A pause asked during one long native call lands on the next JavaScript after it: then the loop is free again.
      const late = Date.now() - Number(Atomics.load(beat, 0)) < afterMs ? ' (read after the freeze ended)' : '';
      out('event loop: frozen: ' + who + "'s main thread is in " + (frames.join(' < ') || '(no JavaScript frame)') + late);
    } catch (e) {
      out('event loop: frozen: could not read the main thread\\'s stack: ' + ((e && e.message) || e));
    }
  });
  s.post('Debugger.enable', (e) => {
    if (e) { out('event loop: frozen: could not read the main thread\\'s stack: ' + e.message); drop(s); return; }
    s.post('Debugger.pause', (e2) => {
      if (e2) { out('event loop: frozen: could not read the main thread\\'s stack: ' + e2.message); s.post('Debugger.disable', () => drop(s)); }
    });
  });
}
setInterval(() => {
  const now = Date.now();
  const last = Number(Atomics.load(beat, 0));
  const gap = now - last;
  if (gap < afterMs) { warnedAt = 0; return; }
  if (warnedAt && now - warnedAt < repeatMs) return;
  warnedAt = now;
  out('event loop: frozen for ' + Math.round(gap / 1000) + ' s so far (its last beat ' + new Date(last).toISOString() + '): ' + who + ' answers nothing; the freeze watch only logs (w6555)');
  askStack();
}, everyMs);
`;

export interface FreezeWatch {
  stop(): void;
}

/**
 * Starts the freeze watch's thread and the main loop's beat. `fd`: where its lines go (default 1, the daemon's stdout);
 * `beatMs`/`everyMs`: how often the main loop beats and the thread looks (1 s; a test's shorter).
 */
export function startFreezeWatch(o: { afterMs: number; repeatMs: number; fd?: number; beatMs?: number; everyMs?: number; who?: string; onError?: (e: Error) => void }): FreezeWatch {
  const sab = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(sab);
  const tick = () => void Atomics.store(beat, 0, BigInt(Date.now()));
  tick();
  const timer = setInterval(tick, o.beatMs ?? 1000);
  timer.unref();
  const w = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { sab, afterMs: o.afterMs, repeatMs: o.repeatMs, everyMs: o.everyMs ?? 1000, fd: o.fd ?? 1, who: o.who ?? 'the daemon' },
    // Its own small heap: a thread that only reads a clock and writes a line.
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
  });
  w.on('error', (e: unknown) => o.onError?.(e instanceof Error ? e : new Error(String(e))));
  // Never what keeps the daemon (or a test) alive.
  w.unref();
  return {
    stop() {
      clearInterval(timer);
      void w.terminate();
    },
  };
}

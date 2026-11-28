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
 * Stage 1 only logged (lothsahn's lockout rule: a daemon change ships warn-only first). Stage 2 (`exitMs`): once the freeze
 * reaches `exitMs` the thread says so, reads the stack once more, and ends the whole process with SIGKILL (TerminateProcess on
 * Windows): the frozen main thread cannot run an exit of its own. Every supervisor then starts a fresh daemon: run-daemon.ps1
 * restarts on any exit but 75 (server/machineDeployWin.ts), the LaunchAgent has KeepAlive true (server/machineDeploy.ts) and
 * the systemd unit Restart=always (server/machineDeployLinux.ts). Agent hosts run detached, in their own process group, so they
 * live on and the fresh daemon finds them, as after any daemon update. If the loop comes free before the kill, it is called off.
 */

export interface FreezeWatchSettings {
  /** Minutes with no beat from the main loop before the first line. */
  afterMin: number;
  /** Minutes between the lines of one freeze that goes on. */
  repeatMin: number;
  /** Minutes of one freeze before the process is ended so its supervisor starts a fresh daemon; false: only log. */
  exitMin: number | false;
}

export const FREEZE_DEFAULTS: FreezeWatchSettings = { afterMin: 3, repeatMin: 5, exitMin: 3 };

/**
 * daemon.json `freezeWatch`: `false` turns it off; else afterMin (1-60), repeatMin (1-120) and exitMin (1-120, or false to
 * only log), the defaults for anything else.
 */
export function freezeWatchSettings(raw: unknown): FreezeWatchSettings | undefined {
  if (raw === false) return undefined;
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const n = (k: 'afterMin' | 'repeatMin' | 'exitMin', min: number, max: number) => (typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) >= min && (r[k] as number) <= max ? (r[k] as number) : (FREEZE_DEFAULTS[k] as number));
  return { afterMin: n('afterMin', 1, 60), repeatMin: n('repeatMin', 1, 120), exitMin: r.exitMin === false ? false : n('exitMin', 1, 120) };
}

// Plain JavaScript, run as an eval worker (CommonJS), as server/hostProbe.ts does.
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const beat = new BigInt64Array(workerData.sab);
const { afterMs, repeatMs, exitMs, everyMs, beatMs, fd, who, markerFile } = workerData;
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
// When this thread was last held with the main one (the computer slept, the clock jumped): time before it is no freeze, so a
// freeze is measured from the later of the main loop's last beat and that wake (w6611's review: a 3 s job just after a wake
// was measured from the beat before the sleep and killed).
let wokeAt = 0;
const frozenFor = (now) => now - Math.max(Number(Atomics.load(beat, 0)), wokeAt);
let ending; // the kill's timer, once the freeze reached exitMs
let still; // w6784: the one retry timer after a kill that did not end this process (w6785's review: one per end() stacked)
// The last look before the kill: a loop that came free meanwhile is left running.
const end = () => {
  ending = undefined;
  const gap = frozenFor(Date.now());
  if (gap < afterMs) { out('event loop: came free before it was ended (' + Math.round(gap / 1000) + ' s since its beat or a wake): ' + who + ' goes on (w6555)'); return; }
  out('event loop: ending ' + who + ' now (SIGKILL); its supervisor starts a fresh one (w6555)');
  // w6784: the supervisor reads this to tell a process stuck mid-exit (BEAST, 2026-11-28 07:41Z: still there hours after
  // this kill) from one still at work; written before the kill, as nothing runs after it.
  if (markerFile) {
    try { fs.writeFileSync(markerFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), why: 'freeze watch: SIGKILL after a ' + Math.round(gap / 1000) + ' s freeze' })); } catch (e) { out('event loop: could not write ' + markerFile + ': ' + ((e && e.message) || e)); }
  }
  const killedAt = Date.now();
  try { process.kill(process.pid, 'SIGKILL'); } catch (e) { out('event loop: could not end ' + who + ': ' + ((e && e.message) || e)); }
  // w6784: a kill that worked runs nothing more here. Still running: say so (the supervisor's own bounded wait acts on it).
  if (still) return;
  still = setInterval(() => {
    out('event loop: ' + who + ' (pid ' + process.pid + ') is still running ' + Math.round((Date.now() - killedAt) / 1000) + ' s after its SIGKILL; trying it again (w6784)');
    try { process.kill(process.pid, 'SIGKILL'); } catch {}
  }, 10000);
  still.unref?.();
};
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
      const late = frozenFor(Date.now()) < afterMs ? ' (read after the freeze ended)' : '';
      out('event loop: frozen: ' + who + "'s main thread is in " + (frames.join(' < ') || '(no JavaScript frame)') + late);
    } catch (e) {
      out('event loop: frozen: could not read the main thread\\'s stack: ' + ((e && e.message) || e));
    }
    // The stack is in the log: end now, after the resume has gone out (a short wait), not at the fallback's time.
    // Two beats' time first, so a main loop that has just come free has beaten again before the last look.
    if (ending) { clearTimeout(ending); ending = setTimeout(end, 2 * beatMs + 200); }
  });
  s.post('Debugger.enable', (e) => {
    if (e) { out('event loop: frozen: could not read the main thread\\'s stack: ' + e.message); drop(s); return; }
    s.post('Debugger.pause', (e2) => {
      if (e2) { out('event loop: frozen: could not read the main thread\\'s stack: ' + e2.message); s.post('Debugger.disable', () => drop(s)); }
    });
  });
}
let lookedAt = Date.now();
setInterval(() => {
  const now = Date.now();
  // This thread was held too (the computer slept, or the clock jumped): a gap seen now is no freeze of the main loop alone.
  // Count from now: a freeze is measured from the later of the last beat and this wake.
  const held = now - lookedAt > Math.max(5 * everyMs, 5000) || now < lookedAt;
  lookedAt = now;
  if (held) { wokeAt = now; warnedAt = 0; return; }
  const last = Number(Atomics.load(beat, 0));
  const gap = frozenFor(now);
  if (gap < afterMs) { warnedAt = 0; return; }
  if (ending) return;
  const since = ' (its last beat ' + new Date(last).toISOString() + (wokeAt > last ? ', counted from a wake at ' + new Date(wokeAt).toISOString() : '') + '): ' + who + ' answers nothing';
  if (exitMs && gap >= exitMs) {
    out('event loop: frozen for ' + Math.round(gap / 1000) + ' s' + since + '; ending it so its supervisor starts a fresh one (w6555)');
    // At most 5 s for the stack line: a pause that cannot land (one long native call) does not hold the kill.
    ending = setTimeout(end, 5000);
    if (session) return; // a stack read is already under way; its line ends it
    askStack();
    return;
  }
  if (warnedAt && now - warnedAt < repeatMs) return;
  warnedAt = now;
  out('event loop: frozen for ' + Math.round(gap / 1000) + ' s so far' + since + (exitMs ? '; it is ended at ' + Math.round(exitMs / 1000) + ' s (w6555)' : '; the freeze watch only logs (w6555)'));
  askStack();
}, everyMs);
`;

export interface FreezeWatch {
  stop(): void;
}

/**
 * Starts the freeze watch's thread and the main loop's beat. `exitMs`: end the process after a freeze this long (0 or absent:
 * only log). `fd`: where its lines go (default 1, the daemon's stdout);
 * `beatMs`/`everyMs`: how often the main loop beats and the thread looks (1 s; a test's shorter).
 */
export function startFreezeWatch(o: { afterMs: number; repeatMs: number; exitMs?: number; fd?: number; beatMs?: number; everyMs?: number; who?: string; markerFile?: string; onError?: (e: Error) => void }): FreezeWatch {
  const sab = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(sab);
  const tick = () => void Atomics.store(beat, 0, BigInt(Date.now()));
  tick();
  const timer = setInterval(tick, o.beatMs ?? 1000);
  timer.unref();
  const w = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { sab, afterMs: o.afterMs, repeatMs: o.repeatMs, exitMs: o.exitMs ?? 0, everyMs: o.everyMs ?? 1000, beatMs: o.beatMs ?? 1000, fd: o.fd ?? 1, who: o.who ?? 'the daemon', markerFile: o.markerFile ?? '' },
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

/**
 * w6784: the file in the daemon logs folder written just before the freeze watch ends the process, and at every exit:
 * {pid, at, why}. run-daemon.ps1 (server/machineDeployWin.ts supervisorScript) reads it to tell a daemon stuck mid-exit
 * from one at work.
 */
export const DAEMON_ENDING_MARKER = 'daemon-ending.json';

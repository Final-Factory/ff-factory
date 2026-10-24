/**
 * The event loop's own health (w1377). On 2026-10-15 the portal stopped answering /api/health for 80 minutes: synchronous
 * work held its one thread for tens of seconds at a time, and nothing in the log said so. This watch beats once a second and
 * says when a beat came late: "event loop: blocked for 12.3 s ...", at most once every 10 s, so a stall is in the journal next
 * to what ran around it. /api/health carries the worst lag of the last minute (`loopLagMs`), so a slow portal reads as slow
 * before it reads as dead.
 */

/** How often the watch beats. */
export const LOOP_BEAT_MS = 1000;
/**
 * A beat this much later than due is a stall worth a line in the log: the portal's target is that nothing holds the loop
 * for more than about a second (w2044, CONTRIBUTING.md "Performance"), so a block at the target is seen, not only one twice it.
 */
export const LOOP_STALL_LOG_MS = 1000;
/** How often the watch says how the loop did, stall or not: "event loop: worst block 0.2 s in the last 10 min" (w2044). */
export const LOOP_SUMMARY_MS = 10 * 60_000;
/** At most one stall line in this long; the longest one in between is in it. */
const LOG_EVERY_MS = 10_000;
/** The window /api/health's loopLagMs covers. */
const LAG_WINDOW_MS = 60_000;

/**
 * Whether a periodic timer that should have fired `everyMs` after `lastBeat` came late enough that the event loop was
 * blocked meanwhile. A late beat runs before the I/O that queued up during the block (Node runs due timers before it polls
 * sockets), so a heartbeat that judged links by their last pong then would drop every one of them at once, though their
 * pongs sit unread (w1377: all five machines and FFBox's connector "no answer for 45-59 s" in one second, 09:56:09Z).
 */
export function beatWasLate(now: number, lastBeat: number, everyMs: number, slackMs = 10_000): boolean {
  return now - lastBeat > everyMs + slackMs;
}

export class LoopWatch {
  private last: number;
  private timer?: NodeJS.Timeout;
  /** [when, lag ms] of recent late beats, oldest first. */
  private lags: [number, number][] = [];
  private loggedAt = 0;
  private unlogged = 0;
  /** Since the last summary line: when it began, its worst lag and its beats at least LOOP_STALL_LOG_MS late. */
  private summaryFrom: number;
  private summaryWorst = 0;
  private summaryStalls = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(o: { now?: () => number; log?: (line: string) => void } = {}) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.warn(l));
    this.last = this.now();
    this.summaryFrom = this.last;
  }

  start() {
    this.last = this.now();
    this.timer = setInterval(() => this.beat(), LOOP_BEAT_MS);
    this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One beat (the timer's, or a test's). */
  beat() {
    const now = this.now();
    const lag = Math.max(0, now - this.last - LOOP_BEAT_MS);
    this.last = now;
    if (lag > 0) this.lags.push([now, lag]);
    while (this.lags.length && now - this.lags[0][0] > LAG_WINDOW_MS) this.lags.shift();
    if (lag >= LOOP_STALL_LOG_MS) this.unlogged = Math.max(this.unlogged, lag);
    this.summaryWorst = Math.max(this.summaryWorst, lag);
    if (lag >= LOOP_STALL_LOG_MS) this.summaryStalls++;
    if (now - this.summaryFrom >= LOOP_SUMMARY_MS) {
      const min = Math.round((now - this.summaryFrom) / 60_000);
      this.log(`event loop: worst block ${(this.summaryWorst / 1000).toFixed(1)} s in the last ${min} min; ${this.summaryStalls} of ${(LOOP_STALL_LOG_MS / 1000).toFixed(0)} s or more`);
      this.summaryFrom = now;
      this.summaryWorst = 0;
      this.summaryStalls = 0;
    }
    if (!this.unlogged || now - this.loggedAt < LOG_EVERY_MS) return;
    this.loggedAt = now;
    this.log(`event loop: blocked for ${(this.unlogged / 1000).toFixed(1)} s (the longest since the last such line): the portal answered nothing meanwhile`);
    this.unlogged = 0;
  }

  /** The worst lag of the last minute, in ms (0: every beat on time). */
  lagMs(): number {
    return this.worstLagSince(this.now() - LAG_WINDOW_MS);
  }

  /** The worst lag of the beats since `since` (within the last minute), in ms: the stall profiler's window (stallProfile.ts). */
  worstLagSince(since: number): number {
    let worst = 0;
    for (const [at, lag] of this.lags) if (at >= since && lag > worst) worst = lag;
    return Math.round(worst);
  }
}

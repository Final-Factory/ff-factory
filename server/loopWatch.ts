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

/**
 * One beat of a link heartbeat (the portal's in server/machines.ts, the daemon's in machine/daemon.ts): 'late' when the beat
 * itself came late (the loop was blocked, so the pong may sit unread: ping and judge on the next beat), 'dead' when nothing
 * has come from the other side for more than `deadMs`, else 'ping'. w4926: the daemon had no late check, so its own stall
 * read as the portal's silence and it dropped a live link (BEAST, 2026-11-20 05:25-07:01Z, eight drops in 96 minutes).
 */
export function linkBeat(now: number, lastBeat: number, lastHeard: number, everyMs: number, deadMs: number): 'ping' | 'late' | 'dead' {
  if (lastBeat && beatWasLate(now, lastBeat, everyMs)) return 'late';
  return now - lastHeard > deadMs ? 'dead' : 'ping';
}

/**
 * What ran on the loop (w5973): the known long callers (the daemon's timers, its link messages) run inside `loopRun`, which
 * times their synchronous part. A stall line then names the labelled run that held the loop longest since the beat before,
 * or the last one that ran, so the next block is traced by measurement instead of by reading the code. Time spent after an
 * `await` inside a labelled run is not counted: it ran later, under no label, and the line says "last ran" for it.
 */
let ranLast: string | undefined;
let ranLongest: { label: string; ms: number } | undefined;

/** Runs `fn` under `label`, timing its synchronous part for the stall line (w5973). Cheap: two clock reads. */
export function loopRun<T>(label: string, fn: () => T, clock: () => number = performance.now.bind(performance)): T {
  const t0 = clock();
  try {
    return fn();
  } finally {
    const ms = clock() - t0;
    ranLast = label;
    if (!ranLongest || ms > ranLongest.ms) ranLongest = { label, ms };
  }
}

/** `fn` wrapped in loopRun, for setInterval and event handlers: `setInterval(loopLabel('pool.tick', () => ...), 30_000)`. */
export function loopLabel<A extends unknown[]>(label: string, fn: (...a: A) => unknown): (...a: A) => void {
  return (...a: A) => void loopRun(label, () => fn(...a));
}

/** What the stall line says ran (and empties the record for the next beat): "; longest labelled run: X 12.1 s" or "; last ran: X". */
export function takeLoopRan(): string {
  const longest = ranLongest;
  ranLongest = undefined;
  if (longest && longest.ms >= 100) return `; longest labelled run: ${longest.label} ${(longest.ms / 1000).toFixed(1)} s`;
  return ranLast ? `; last ran: ${ranLast}` : '';
}

export class LoopWatch {
  private last: number;
  private timer?: NodeJS.Timeout;
  /** [when, lag ms] of recent late beats, oldest first. */
  private lags: [number, number][] = [];
  private loggedAt = 0;
  private unlogged = 0;
  /** What ran during the longest unlogged block (takeLoopRan), for its line. */
  private unloggedRan = '';
  /** Since the last summary line: when it began, its worst lag and its beats at least LOOP_STALL_LOG_MS late. */
  private summaryFrom: number;
  private summaryWorst = 0;
  private summaryStalls = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** Who stopped answering during a block, for the stall line: "the portal" (default) or "the daemon" (w4926). */
  private readonly who: string;
  /** A beat at least this late gets a stall line (default LOOP_STALL_LOG_MS). */
  private readonly stallLogMs: number;

  constructor(o: { now?: () => number; log?: (line: string) => void; who?: string; stallLogMs?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((l) => console.warn(l));
    this.who = o.who ?? 'the portal';
    this.stallLogMs = o.stallLogMs ?? LOOP_STALL_LOG_MS;
    this.last = this.now();
    this.summaryFrom = this.last;
  }

  start() {
    this.last = this.now();
    this.timer = setInterval(() => this.beat(), LOOP_BEAT_MS);
    this.timer.unref();
    return this;
  }

  /**
   * The portal's startup is over (w3855): the time since start() went to loading the data folder and wiring the server, in
   * the module's one synchronous run before it listened, when no client could be connected to be kept waiting. It gets its
   * own line ("startup: ...") instead of reading as a block of a running portal, and the next beat counts from here.
   */
  started() {
    const now = this.now();
    this.log(`startup: ${((now - this.last) / 1000).toFixed(1)} s from the loop watch to listening (w3855)`);
    this.last = now;
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
    const ran = takeLoopRan();
    if (lag >= this.stallLogMs && lag > this.unlogged) {
      this.unlogged = lag;
      this.unloggedRan = ran;
    }
    this.summaryWorst = Math.max(this.summaryWorst, lag);
    if (lag >= this.stallLogMs) this.summaryStalls++;
    if (now - this.summaryFrom >= LOOP_SUMMARY_MS) {
      const min = Math.round((now - this.summaryFrom) / 60_000);
      this.log(`event loop: worst block ${(this.summaryWorst / 1000).toFixed(1)} s in the last ${min} min; ${this.summaryStalls} of ${(this.stallLogMs / 1000).toFixed(0)} s or more`);
      this.summaryFrom = now;
      this.summaryWorst = 0;
      this.summaryStalls = 0;
    }
    if (!this.unlogged || now - this.loggedAt < LOG_EVERY_MS) return;
    this.loggedAt = now;
    this.log(`event loop: blocked for ${(this.unlogged / 1000).toFixed(1)} s (the longest since the last such line): ${this.who} answered nothing meanwhile${this.unloggedRan}`);
    this.unlogged = 0;
    this.unloggedRan = '';
  }

  /** The worst lag of the last minute, in ms (0: every beat on time). */
  lagMs(): number {
    return this.worstLagSince(this.now() - LAG_WINDOW_MS);
  }

  /** The beats since `since` (within the last minute) that came late: [when, lag ms], oldest first; the stall profiler's blocks. */
  blocksSince(since: number): [number, number][] {
    return this.lags.filter(([at]) => at >= since).map(([at, lag]) => [at, Math.round(lag)]);
  }

  /** The worst lag of the beats since `since` (within the last minute), in ms: the stall profiler's window (stallProfile.ts). */
  worstLagSince(since: number): number {
    let worst = 0;
    for (const [at, lag] of this.lags) if (at >= since && lag > worst) worst = lag;
    return Math.round(worst);
  }
}

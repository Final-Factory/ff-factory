/**
 * Which function held the event loop (w2026). On 2026-10-24 the portal's one thread blocked for 36-78 s about once a minute, every
 * daemon dropped ("portal silent 45 s") and fff-health restarted it every 9-21 minutes; the journal's "event loop: blocked" line
 * (loopWatch.ts) said how long, never what. This keeps V8's sampling profiler running in the portal's own process (node:inspector,
 * no port is opened) in windows of a minute; when the loop stalled in a window it logs the functions that held it, by own time and
 * by the portal's functions underneath, and keeps the profile in <dataDir>/profiles (the newest few), so the next stall names its
 * cause in the journal without a restart, a debugger or a shell on the VM. A window with no stall is thrown away.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector';

/** A profile window. */
export const PROFILE_WINDOW_MS = 60_000;
/** A window whose worst lag is at least this keeps its profile: the loop watch's line, the 1 s target (w2044). */
export const PROFILE_STALL_MS = 1000;
/** One sample every this many microseconds (10 ms): a minute is 6,000 samples, a cost too small to see. */
const SAMPLE_US = 10_000;
/** Blocks of a window that get a line of their own, the longest first. */
const BLOCK_LINES = 3;
/** Profiles kept. */
const KEEP = 6;
/**
 * w6382: a page's state build at least this long gets a line of its own from the window's samples, stall or none: the open line's
 * phases (pageSockets.ts phasesOf) say which part was slow, this says which functions in it (a phase of 150-290 ms on the
 * portal's data was 3-5 ms on a synthetic one, so only the portal's own samples can name them).
 */
export const PROFILE_SLOW_SPAN_MS = 300;
/** Slow spans of a window that get a line, the longest first. */
const SPAN_LINES = 3;
/** w6416: a roll at least this long gets a line saying where its time went and how big the profile was. */
const ROLL_LINE_MS = 250;
/** w6416: the console profiles' titles (console.profile), so a profile of anyone else's is left alone. */
const TITLE = 'ff-stall-window-';

type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type ProfileNode = { id: number; callFrame: CallFrame; hitCount?: number; children?: number[] };
export type CpuProfile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] };

const where = (f: CallFrame) => {
  const file = f.url ? f.url.replace(/^file:\/\//, '').split('/').slice(-2).join('/') : '';
  // A regular expression's node is named by its source ("RegExp: (?<![\w-])3acf0f5f…"), which can carry ids and text: its kind only (w3843).
  const name = f.functionName.startsWith('RegExp: ') ? 'RegExp' : f.functionName;
  return `${name || '(anonymous)'}${file ? ` (${file}:${f.lineNumber + 1})` : ''}`;
};
// w6077: the daemon's own code (machine/) counts too, since the daemon runs one as well.
const ours = (f: CallFrame) => /\/(server|shared|machine)\/[^/]+\.ts$/.test(f.url) && !f.url.includes('/node_modules/');

/**
 * The functions that took the time in a profile: `self` by their own time (where the CPU was), `under` the portal's own functions
 * by the time spent in them and what they called (which of ours was on the stack). Milliseconds, the biggest first.
 */
export function summarizeProfile(p: CpuProfile, top = 6, within?: [number, number][]): { totalMs: number; self: { fn: string; ms: number }[]; under: { fn: string; ms: number }[] } {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const hits = new Map<number, number>();
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  // a sample's time is the gap to the next one (V8's own reading); without deltas every hit counts the sampling interval.
  // `within`: only the samples taken in these spans, in ms from the profile's start (a block of the loop, w2044).
  let at = 0;
  for (let i = 0; i < samples.length; i++) {
    at += (deltas[i] ?? 0) / 1000;
    if (within && !within.some(([a, b]) => at >= a && at <= b)) continue;
    hits.set(samples[i], (hits.get(samples[i]) ?? 0) + (deltas[i + 1] ?? SAMPLE_US) / 1000);
  }
  if (!samples.length && !within) for (const n of p.nodes) if (n.hitCount) hits.set(n.id, n.hitCount * (SAMPLE_US / 1000));
  const self = new Map<string, number>();
  const under = new Map<string, number>();
  let totalMs = 0;
  for (const [id, ms] of hits) {
    const n = byId.get(id);
    if (!n) continue;
    const name = n.callFrame.functionName;
    if (name === '(idle)' || name === '(program)' || name === '(garbage collector)') {
      if (name === '(garbage collector)') self.set('(garbage collector)', (self.get('(garbage collector)') ?? 0) + ms);
      if (name !== '(idle)') totalMs += ms;
      continue;
    }
    totalMs += ms;
    const k = where(n.callFrame);
    self.set(k, (self.get(k) ?? 0) + ms);
    const seen = new Set<string>();
    for (let a: number | undefined = id; a !== undefined; a = parent.get(a)) {
      const f = byId.get(a)?.callFrame;
      if (!f || !ours(f)) continue;
      const fk = where(f);
      if (seen.has(fk)) continue;
      seen.add(fk);
      under.set(fk, (under.get(fk) ?? 0) + ms);
    }
  }
  const list = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, ms]) => ({ fn, ms: Math.round(ms) }));
  return { totalMs: Math.round(totalMs), self: list(self), under: list(under) };
}

export class StallProfiler {
  private session?: Session;
  private timer?: NodeJS.Timeout;
  private windowStart = 0;
  private busy = false;
  private readonly dir: string;
  private readonly worstLagSince: (since: number) => number;
  private readonly blocksSince: (since: number) => [number, number][];
  private readonly log: (line: string) => void;
  /** A window whose worst lag is at least this keeps its profile (PROFILE_STALL_MS; the daemon's is its stall line's, w6077). */
  private readonly stallMs: number;
  /** Whose functions the lines name: "the portal's" (default) or "the daemon's" (w6077). */
  private readonly whose: string;
  /** Slow spans noted in this window (noteSpan): what, when it ended (epoch ms) and how long. */
  private spans: { what: string; end: number; ms: number }[] = [];
  /** w6416: windows overlap as console profiles (true), or stop and start the session's own profile (false, older Node). */
  overlap = false;
  private current?: string;
  private seq = 0;
  private finished?: { title: string; profile: CpuProfile };
  /** w6416: the last roll's cost in ms and its profile's size, for tests and the roll line. */
  lastRoll?: { startMs: number; endMs: number; summaryMs: number; totalMs: number; nodes: number; samples: number };

  constructor(o: { dataDir: string; worstLagSince: (since: number) => number; blocksSince?: (since: number) => [number, number][]; log?: (line: string) => void; stallMs?: number; whose?: string }) {
    this.dir = path.join(o.dataDir, 'profiles');
    this.worstLagSince = o.worstLagSince;
    this.blocksSince = o.blocksSince ?? (() => []);
    this.log = o.log ?? ((l) => console.warn(l));
    this.stallMs = o.stallMs ?? PROFILE_STALL_MS;
    this.whose = o.whose ?? "the portal's";
  }

  start() {
    try {
      this.session = new Session();
      this.session.connect();
      this.session.post('Profiler.enable');
      this.session.post('Profiler.setSamplingInterval', { interval: SAMPLE_US });
      this.session.on('Profiler.consoleProfileFinished', (m) => {
        const title = (m.params as { title?: string }).title;
        if (title?.startsWith(TITLE)) this.finished = { title, profile: (m.params as { profile: CpuProfile }).profile };
      });
      this.overlap = this.probeOverlap();
      this.begin();
      this.timer = setInterval(() => this.roll(), PROFILE_WINDOW_MS);
      this.timer.unref();
    } catch (e) {
      this.log(`stall profile: off (${(e as Error).message})`);
      this.stop();
    }
    return this;
  }

  /**
   * w6416: whether this Node gives a console profile back to our session (console.profile is the inspector's; without it the
   * windows fall back to Profiler.stop/start, which cost a cold start each minute).
   */
  private probeOverlap(): boolean {
    this.finished = undefined;
    try {
      console.profile(`${TITLE}probe`);
      console.profileEnd(`${TITLE}probe`);
    } catch {
      return false;
    }
    const f = this.finished as { title: string } | undefined;
    const ok = f?.title === `${TITLE}probe`;
    this.finished = undefined;
    return ok;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      if (this.overlap && this.current) console.profileEnd(this.current);
    } catch {
      // already ended
    }
    this.current = undefined;
    try {
      this.session?.disconnect();
    } catch {
      // already gone
    }
    this.session = undefined;
  }

  /** w6382: a span of work that took `ms` and ended now; one of PROFILE_SLOW_SPAN_MS or more is named at the window's end. */
  noteSpan(what: string, ms: number, end = Date.now()) {
    if (this.session && ms >= PROFILE_SLOW_SPAN_MS) this.spans.push({ what, end, ms });
  }

  private begin() {
    this.windowStart = Date.now();
    if (this.overlap) {
      this.current = `${TITLE}${++this.seq}`;
      console.profile(this.current);
    } else this.session?.post('Profiler.start');
  }

  /**
   * End the window: keep and summarize its profile when the loop stalled in it, then start the next one. The next window starts
   * BEFORE this one ends (w6416): when no profile runs, V8 drops its code map and the next start rebuilds it by walking the
   * whole heap, measured at 0.9-1.1 s on a 460 MB heap on a desktop and 1.1-1.7 s on the portal, once a minute (the loop watch then called it a
   * stall, and the profiler named itself). With one always running, a start costs nothing (0-1 ms measured on that heap) and the roll is only
   * the ended profile's serialization.
   */
  roll() {
    const s = this.session;
    if (!s || this.busy) return;
    this.busy = true;
    const t0 = performance.now();
    const from = this.windowStart;
    const lag = this.worstLagSince(from);
    const blocks = this.blocksSince(from).filter(([, l]) => l >= this.stallMs);
    const spans = this.spans;
    this.spans = [];
    const done = (profile: CpuProfile | undefined, tStart: number, tEnd: number) => {
      this.busy = false;
      if (!profile) return;
      const t2 = performance.now();
      this.logSpans(profile, from, spans);
      if (lag >= this.stallMs) void this.keep(profile, lag, from, blocks);
      const t3 = performance.now();
      this.lastRoll = { startMs: tStart, endMs: tEnd, summaryMs: t3 - t2, totalMs: t3 - t0, nodes: profile.nodes.length, samples: profile.samples?.length ?? 0 };
      if (t3 - t0 >= ROLL_LINE_MS)
        this.log(`stall profile: the window's roll took ${Math.round(t3 - t0)} ms (next start ${Math.round(tStart)} ms, end ${Math.round(tEnd)} ms, summaries ${Math.round(t3 - t2)} ms; ${profile.nodes.length} nodes, ${profile.samples?.length ?? 0} samples)`);
    };
    if (this.overlap && this.current) {
      const ending = this.current;
      try {
        this.begin();
        const t1 = performance.now();
        this.finished = undefined;
        console.profileEnd(ending);
        const t2 = performance.now();
        const f = this.finished as { title: string; profile: CpuProfile } | undefined;
        this.finished = undefined;
        done(f?.title === ending ? f.profile : undefined, t1 - t0, t2 - t1);
      } catch (e) {
        this.busy = false;
        this.log(`stall profile: roll failed (${(e as Error).message})`);
      }
      return;
    }
    s.post('Profiler.stop', (err, res) => {
      const t1 = performance.now();
      this.begin();
      const t2 = performance.now();
      done(err ? undefined : (res?.profile as unknown as CpuProfile | undefined), t2 - t1, t1 - t0);
    });
  }

  /** w6382: the slow spans' own lines, from their samples only; the profile itself is kept only for a stall (keep). */
  logSpans(p: CpuProfile, from: number, spans: readonly { what: string; end: number; ms: number }[]) {
    const fmt = (l: { fn: string; ms: number }[]) => l.map((x) => `${x.fn} ${x.ms} ms`).join('; ') || 'none';
    for (const sp of [...spans].sort((a, b) => b.ms - a.ms).slice(0, SPAN_LINES)) {
      const b = summarizeProfile(p, 10, [[sp.end - sp.ms - from, sp.end - from]]);
      this.log(`stall profile: ${sp.what} of ${Math.round(sp.ms)} ms ending ${new Date(sp.end).toISOString()}. Own time: ${fmt(b.self)}. In ${this.whose} functions: ${fmt(b.under)}`);
    }
  }

  private async keep(p: CpuProfile, lag: number, from: number, blocks: [number, number][] = []) {
    try {
      const sum = summarizeProfile(p);
      const fmt = (l: { fn: string; ms: number }[]) => l.map((x) => `${x.fn} ${(x.ms / 1000).toFixed(1)} s`).join('; ') || 'none';
      this.log(`stall profile: the loop stalled ${(lag / 1000).toFixed(1)} s in the minute from ${new Date(from).toISOString()}; CPU ${(sum.totalMs / 1000).toFixed(1)} s. Own time: ${fmt(sum.self)}. In ${this.whose} functions: ${fmt(sum.under)}`);
      // The minute's totals mix the block with everything else that ran (w2044: a state save once a second summed to 5 s a
      // minute, though no one save came near a second): each of the longest blocks gets its own line, from its samples only.
      // A beat `lag` ms late ran at `at`, so the loop was held from at most `at - lag` to `at`.
      for (const [at, l] of blocks.sort((a, b) => b[1] - a[1]).slice(0, BLOCK_LINES)) {
        const b = summarizeProfile(p, 4, [[at - l - from, at - from]]);
        this.log(`stall profile: block of ${(l / 1000).toFixed(1)} s ending ${new Date(at).toISOString()}. Own time: ${fmt(b.self)}. In ${this.whose} functions: ${fmt(b.under)}`);
      }
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(path.join(this.dir, `stall-${new Date(from).toISOString().replace(/[:.]/g, '-')}.cpuprofile`), JSON.stringify(p));
      const old = (await fs.promises.readdir(this.dir)).filter((f) => f.startsWith('stall-') && f.endsWith('.cpuprofile')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP))) await fs.promises.rm(path.join(this.dir, f), { force: true });
    } catch (e) {
      this.log(`stall profile: not kept (${(e as Error).message})`);
    }
  }
}

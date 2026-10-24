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
/** Profiles kept. */
const KEEP = 6;

type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type ProfileNode = { id: number; callFrame: CallFrame; hitCount?: number; children?: number[] };
export type CpuProfile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] };

const where = (f: CallFrame) => {
  const file = f.url ? f.url.replace(/^file:\/\//, '').split('/').slice(-2).join('/') : '';
  return `${f.functionName || '(anonymous)'}${file ? ` (${file}:${f.lineNumber + 1})` : ''}`;
};
const ours = (f: CallFrame) => /\/(server|shared)\/[^/]+\.ts$/.test(f.url) && !f.url.includes('/node_modules/');

/**
 * The functions that took the time in a profile: `self` by their own time (where the CPU was), `under` the portal's own functions
 * by the time spent in them and what they called (which of ours was on the stack). Milliseconds, the biggest first.
 */
export function summarizeProfile(p: CpuProfile, top = 6): { totalMs: number; self: { fn: string; ms: number }[]; under: { fn: string; ms: number }[] } {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const hits = new Map<number, number>();
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  // a sample's time is the gap to the next one (V8's own reading); without deltas every hit counts the sampling interval
  for (let i = 0; i < samples.length; i++) hits.set(samples[i], (hits.get(samples[i]) ?? 0) + (deltas[i + 1] ?? SAMPLE_US) / 1000);
  if (!samples.length) for (const n of p.nodes) if (n.hitCount) hits.set(n.id, n.hitCount * (SAMPLE_US / 1000));
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
  private readonly log: (line: string) => void;

  constructor(o: { dataDir: string; worstLagSince: (since: number) => number; log?: (line: string) => void }) {
    this.dir = path.join(o.dataDir, 'profiles');
    this.worstLagSince = o.worstLagSince;
    this.log = o.log ?? ((l) => console.warn(l));
  }

  start() {
    try {
      this.session = new Session();
      this.session.connect();
      this.session.post('Profiler.enable');
      this.session.post('Profiler.setSamplingInterval', { interval: SAMPLE_US });
      this.begin();
      this.timer = setInterval(() => this.roll(), PROFILE_WINDOW_MS);
      this.timer.unref();
    } catch (e) {
      this.log(`stall profile: off (${(e as Error).message})`);
      this.stop();
    }
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.session?.disconnect();
    } catch {
      // already gone
    }
    this.session = undefined;
  }

  private begin() {
    this.windowStart = Date.now();
    this.session?.post('Profiler.start');
  }

  /** End the window: keep and summarize its profile when the loop stalled in it, then start the next one. */
  private roll() {
    const s = this.session;
    if (!s || this.busy) return;
    this.busy = true;
    const from = this.windowStart;
    const lag = this.worstLagSince(from);
    s.post('Profiler.stop', (err, res) => {
      this.begin();
      this.busy = false;
      if (err || !res?.profile || lag < PROFILE_STALL_MS) return;
      void this.keep(res.profile as unknown as CpuProfile, lag, from);
    });
  }

  private async keep(p: CpuProfile, lag: number, from: number) {
    try {
      const sum = summarizeProfile(p);
      const fmt = (l: { fn: string; ms: number }[]) => l.map((x) => `${x.fn} ${(x.ms / 1000).toFixed(1)} s`).join('; ') || 'none';
      this.log(`stall profile: the loop stalled ${(lag / 1000).toFixed(1)} s in the minute from ${new Date(from).toISOString()}; CPU ${(sum.totalMs / 1000).toFixed(1)} s. Own time: ${fmt(sum.self)}. In the portal's functions: ${fmt(sum.under)}`);
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(path.join(this.dir, `stall-${new Date(from).toISOString().replace(/[:.]/g, '-')}.cpuprofile`), JSON.stringify(p));
      const old = (await fs.promises.readdir(this.dir)).filter((f) => f.startsWith('stall-') && f.endsWith('.cpuprofile')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP))) await fs.promises.rm(path.join(this.dir, f), { force: true });
    } catch (e) {
      this.log(`stall profile: not kept (${(e as Error).message})`);
    }
  }
}

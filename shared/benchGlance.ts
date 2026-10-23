// A machine's bench queue in words for the machine view (w1835; lothsahn, 2026-10-23: "Please display on FF factory's
// webpage for the machine view whether each machine is in shared or exclusive lock mode"). The daemon reads the queue
// (machine/benchState.ts); this says it: the mode, who holds it and for how long, and what waits.
import type { BenchState, BenchTicketGlance } from './types.ts';

export type BenchMode = BenchState['mode'];

export interface BenchGlance {
  mode: BenchMode;
  /** "Exclusive", "Shared" or "Free". */
  label: string;
  tone: 'amber' | 'blue' | 'grey';
  /** After the label: the holder (its requests and worker), or the shared group's size; empty when free. */
  detail: string;
  /** The holder's times ("held 12m, 18m left"), or empty. */
  times: string;
  /** "2 waiting", or empty. */
  waiting: string;
  /** The next timed leg and when it starts at the latest, or empty. */
  next: string;
  /** Every holder and waiter, one per line, for the hover. */
  hint: string;
}

export const BENCH_LABEL: Record<BenchMode, string> = { exclusive: 'Exclusive', shared: 'Shared', free: 'Free' };
const TONE: Record<BenchMode, BenchGlance['tone']> = { exclusive: 'amber', shared: 'blue', free: 'grey' };

/** "12m", "1h 5m": a span of minutes, rounded down, never below 0. */
export function benchMinutes(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/** Who holds or waits: its requests, else what it runs. */
const who = (t: BenchTicketGlance) => (t.requests?.length ? t.requests.join(', ') : t.what || t.ticket);

/** "held 12m, 18m left", or "held 64m, 4m past its 60m bound" once it overstays (the next waiter revokes it). */
function times(t: BenchTicketGlance, now: number): string {
  if (!t.since) return '';
  const held = `held ${benchMinutes(now - Date.parse(t.since))}`;
  if (!t.until) return held;
  const left = Date.parse(t.until) - now;
  return left >= 0 ? `${held}, ${benchMinutes(left)} left` : `${held}, ${benchMinutes(-left)} past its bound`;
}

function hintLine(t: BenchTicketGlance, now: number, waiting = false): string {
  const where = [t.host, t.sandbox].filter(Boolean).join('/');
  const bits = [
    `${t.mode} ${t.ticket}`,
    t.requests?.length ? t.requests.join(', ') : '',
    t.session ? `worker ${t.session.slice(0, 8)}` : '',
    where,
    t.what ? `"${t.what}"` : '',
    waiting ? (t.since ? `waiting ${benchMinutes(now - Date.parse(t.since))}` : 'waiting') : times(t, now),
  ];
  return bits.filter(Boolean).join(' · ');
}

/** The machine view's bench line, or undefined for a daemon that does not report its queue (before w1835). */
export function benchGlance(b: BenchState | undefined, now: number): BenchGlance | undefined {
  if (!b) return undefined;
  const lead = b.running[0];
  let detail = '';
  if (b.mode === 'exclusive') {
    if (lead?.mode === 'exclusive') detail = [who(lead), lead.session ? `worker ${lead.session.slice(0, 8)}` : ''].filter(Boolean).join(' · ');
    else if (b.legacy) detail = 'old-style lock';
  } else if (b.mode === 'shared') {
    detail = `${b.runningCount} ${b.runningCount === 1 ? 'ticket' : 'tickets'} running`;
  }
  const held = b.mode !== 'exclusive' ? '' : lead?.mode === 'exclusive' ? times(lead, now) : b.legacy ? `held ${benchMinutes(now - Date.parse(b.legacy.since))}` : '';
  const n = b.nextExclusive;
  let next = '';
  if (n) {
    // The latest end of what runs now: each holder's bound. Only a leg with nobody ahead of it starts then.
    const ends = b.running.map((t) => (t.until ? Date.parse(t.until) : NaN)).filter(Number.isFinite);
    const by = n.ahead === 0 && ends.length === b.runningCount && ends.length ? Math.max(...ends) - now : undefined;
    const when = n.ahead > 0 ? `after ${n.ahead} ahead` : by !== undefined ? (by > 0 ? `within ${benchMinutes(by)}` : 'at the next look') : !b.runningCount ? 'starting' : 'after the running group';
    next = `next timed: ${who(n)} ${when}`;
  }
  const lines = [
    ...b.running.map((t) => hintLine(t, now)),
    ...(b.runningCount > b.running.length ? [`and ${b.runningCount - b.running.length} more running`] : []),
    ...(b.legacy ? [`old-style lock: ${b.legacy.owner}`] : []),
    ...(n ? [`next: ${hintLine(n, now, true)}${n.ahead ? ` (${n.ahead} ahead of it)` : ''}`] : []),
    `${b.waiting} waiting`,
  ];
  return {
    mode: b.mode,
    label: BENCH_LABEL[b.mode],
    tone: TONE[b.mode],
    detail,
    times: held,
    waiting: b.waiting ? `${b.waiting} waiting` : '',
    next,
    hint: `Bench queue: ${BENCH_LABEL[b.mode]}\n${lines.join('\n')}`,
  };
}

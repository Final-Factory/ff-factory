// A machine's bench queue in words for the machine view (w1835; lothsahn, 2026-10-23: "Please display on FF factory's
// webpage for the machine view whether each machine is in shared or exclusive lock mode"). The daemon reads the queue
// (machine/benchState.ts); this says it: the mode, who holds it and for how long, and what waits. The turn rules are the
// game repo's scripts/bench/bench_queue.py (w1832): a 30-minute exclusive turn and a shared group's hour end only once
// another worker waits, with a 5-minute warning; the urgent release and the nightly have no turn limit.
import type { BenchState, BenchTicketGlance } from './types.ts';

export type BenchMode = BenchState['mode'];

export interface BenchGlance {
  mode: BenchMode;
  /** "Exclusive", "Shared" or "Free". */
  label: string;
  tone: 'amber' | 'blue' | 'grey';
  /** After the label: the holder (its requests and worker), or the shared group's size; empty when free. */
  detail: string;
  /** The sidebar's shorter detail: the holder without its worker, the group's size without the nightly (both in the hover). */
  short: string;
  /** The holder's or group's times ("held 12m, 18m left of its 30m turn", "warned: ends in 4m"), or empty. */
  times: string;
  /** Whether a holder was warned its turn ends: the line says it first. */
  warned: boolean;
  /** "2 waiting", or empty. */
  waiting: string;
  /** The next timed leg and when it starts at the latest, or empty. */
  next: string;
  /** What the exclusive turn closed ("for it: 2 editors closed, 1 player asked to quit"), or empty. */
  closed: string;
  /** Every holder and waiter, one per line, for the hover. */
  hint: string;
}

export const BENCH_LABEL: Record<BenchMode, string> = { exclusive: 'Exclusive', shared: 'Shared', free: 'Free' };
const TONE: Record<BenchMode, BenchGlance['tone']> = { exclusive: 'amber', shared: 'blue', free: 'grey' };
const EXEMPT: Record<NonNullable<BenchTicketGlance['exempt']>, string> = { release: 'urgent release', nightly: 'nightly' };

/** "12m", "1h 5m": a span of minutes, rounded down, never below 0. */
export function benchMinutes(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Who holds or waits: its requests, else what it runs. */
const who = (t: BenchTicketGlance) => (t.requests?.length ? t.requests.join(', ') : t.what || t.ticket);

/** The kind of work no turn limit ends: the urgent release lane's ticket or builder, or the nightly. */
function kind(t: BenchTicketGlance): string {
  return t.preempt ? EXEMPT.release : t.exempt ? EXEMPT[t.exempt] : '';
}

/** "ends in 4m", or "ends now" once the deadline passed (the queue revokes it at its next look). */
const endsIn = (at: number, now: number) => (at > now ? `ends in ${benchMinutes(at - now)}` : 'ends now');

/**
 * An exclusive holder's times: its deadline once a waiter set one ("warned: ends in 4m"; "for an urgent release" when the
 * release set it), else its turn ("18m left of its 30m turn", or "past its 30m turn: nobody waits", which it may outlast),
 * else none ("no turn limit": exempt work, a single-worker machine).
 */
function times(t: BenchTicketGlance, now: number, singleWorker: boolean, waiting = 0): string {
  if (!t.since) return '';
  const held = `held ${benchMinutes(now - Date.parse(t.since))}`;
  if (t.deadline) {
    const ends = `${t.warned ? 'warned: ' : ''}${endsIn(Date.parse(t.deadline), now)}${t.release ? ' for an urgent release' : ''}`;
    return `${held}, ${ends}`;
  }
  if (kind(t) || singleWorker) return `${held}, no turn limit`;
  // w1860: only lower-priority work waits behind it: it keeps the lock until it lets go
  if (t.keeps) return `${held}, keeps the lock: only lower-priority work waits`;
  if (!t.until) return held;
  const left = Date.parse(t.until) - now;
  const turn = t.turnMin ? `its ${t.turnMin}m turn` : 'its turn';
  // Past its turn the queue limits it only once another worker's ticket waits behind it (bench_queue.py _blocked_by): a
  // leg of its own worker's, or one an exempt holder also keeps waiting, sets no deadline.
  return left >= 0 ? `${held}, ${benchMinutes(left)} left of ${turn}` : `${held}, past ${turn}: ${waiting ? 'no deadline set' : 'nobody waits'}`;
}

/** A shared group's end, once an exclusive ticket waits behind it: one deadline for every holder (bench_queue.py). */
function groupTimes(b: BenchState, now: number): string {
  const d = b.running.find((t) => t.deadline);
  // w1860: the group outranks every timed leg that waits (its priority is its highest running ticket's)
  if (!d?.deadline) return b.running.some((t) => t.keeps) ? `the group keeps the lock: only lower-priority work waits` : '';
  return `${d.warned ? 'warned: ' : ''}the group ${endsIn(Date.parse(d.deadline), now)}`;
}

function hintLine(t: BenchTicketGlance, now: number, singleWorker: boolean, waiting = false, waiters = 0): string {
  const where = [t.host, t.sandbox].filter(Boolean).join('/');
  const bits = [
    `${t.mode} ${t.ticket}`,
    kind(t),
    t.requests?.length ? t.requests.join(', ') : '',
    t.session ? `worker ${t.session.slice(0, 8)}` : '',
    where,
    t.what ? `"${t.what}"` : '',
    waiting ? (t.since ? `waiting ${benchMinutes(now - Date.parse(t.since))}` : 'waiting') : times(t, now, singleWorker, waiters),
    !waiting && t.deadline && t.why ? `(${t.why})` : '',
    !waiting && t.keeps?.why ? `(${t.keeps.why})` : '',
  ];
  return bits.filter(Boolean).join(' · ');
}

/** When the next timed leg starts at the latest. */
function startsWhen(b: BenchState, n: NonNullable<BenchState['nextExclusive']>, now: number): string {
  if (n.ahead > 0) return `after ${plural(n.ahead, 'ticket')} ahead`;
  // An old-style lock has no bound the queue keeps (quiet_gate.sh's own age rule): the leg waits for it, however long.
  if (b.legacy) return 'after the old-style lock';
  if (!b.runningCount) return 'starting';
  // Exempt work runs on, whoever waits: the leg waits for it. An urgent release ends the holders' turns with its notice.
  const exempt = n.preempt ? undefined : b.running.find((t) => kind(t) && !t.deadline);
  if (exempt) return `after the ${kind(exempt)}`;
  // w1860: a higher-priority holder keeps the lock until it lets go: no time can be promised
  if (b.running.some((t) => t.keeps)) return 'when the higher-priority work lets go';
  // Each holder's deadline, which the queue sets at the waiter's first look; until then the running group's end.
  const ends = b.running.map((t) => (t.deadline ? Date.parse(t.deadline) : NaN)).filter(Number.isFinite);
  if (ends.length !== b.runningCount || !ends.length) return 'after the running group';
  const by = Math.max(...ends) - now;
  return by > 0 ? `within ${benchMinutes(by)}` : 'at the next look';
}

/** The machine view's bench line, or undefined for a daemon that does not report its queue (before w1835). */
export function benchGlance(b: BenchState | undefined, now: number): BenchGlance | undefined {
  if (!b) return undefined;
  const single = b.singleWorker === true;
  const lead = b.running[0];
  let detail = '';
  let short = '';
  let held = '';
  if (b.mode === 'exclusive') {
    if (lead?.mode === 'exclusive') {
      detail = [kind(lead), who(lead), lead.session ? `worker ${lead.session.slice(0, 8)}` : ''].filter(Boolean).join(' · ');
      short = [kind(lead), who(lead)].filter(Boolean).join(' · ');
      held = times(lead, now, single, b.waiting);
    } else if (b.legacy) {
      detail = short = 'old-style lock';
      held = `held ${benchMinutes(now - Date.parse(b.legacy.since))}`;
    }
  } else if (b.mode === 'shared') {
    const nightly = b.running.some((t) => t.exempt === 'nightly');
    short = `${plural(b.runningCount, 'ticket')} running`;
    detail = `${short}${nightly ? (b.runningCount === 1 ? ': the nightly' : ', the nightly among them') : ''}`;
    held = groupTimes(b, now);
  }
  const n = b.nextExclusive;
  const next = n ? `next timed: ${[kind(n), who(n)].filter(Boolean).join(' ')} ${startsWhen(b, n, now)}` : '';
  const c = b.closed;
  // A player is asked to quit, and may be left running (machine/benchTurn.ts askPlayerToQuit): said as asked.
  const closedBits = c ? [c.editors.length ? `${plural(c.editors.length, 'editor')} closed` : '', c.players ? `${plural(c.players, 'player')} asked to quit` : ''].filter(Boolean) : [];
  const closed = closedBits.length ? `for it: ${closedBits.join(', ')}` : '';
  const lines = [
    ...b.running.map((t) => hintLine(t, now, single, false, b.waiting)),
    ...(b.runningCount > b.running.length ? [`and ${b.runningCount - b.running.length} more running`] : []),
    ...(b.legacy ? [`old-style lock: ${b.legacy.owner}`] : []),
    ...(c?.editors.length ? [`editors closed for the turn: ${c.editors.join(', ')}`] : []),
    ...(c?.players ? [`game players asked to quit: ${c.players}`] : []),
    ...(n ? [`next: ${hintLine(n, now, single, true)}${n.ahead ? ` (${n.ahead} ahead of it)` : ''}`] : []),
    `${b.waiting} waiting`,
    ...(single ? ['one worker on this machine: no turn limits'] : []),
  ];
  return {
    mode: b.mode,
    label: BENCH_LABEL[b.mode],
    tone: TONE[b.mode],
    detail,
    short,
    times: held,
    warned: b.running.some((t) => t.warned),
    waiting: b.waiting ? `${b.waiting} waiting` : '',
    next,
    closed,
    hint: `Bench queue: ${BENCH_LABEL[b.mode]}\n${lines.join('\n')}`,
  };
}

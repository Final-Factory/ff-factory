// w1949 (lothsahn, 2026-10-23: "Show those requests as blocked, with the existing blocked state in the request list, and
// clearly indicate that they're blocked on the exclusive lock"): what a worker waits for in its machine's queues, read from
// the queues themselves as each daemon reports them, never from what the worker says. A ticket in the bench queue not
// granted yet (machine/benchState.ts, BenchState.waiters: the worker's own `bench_queue.py run` or `timed`, a `unity-slot
// run`'s ticket, its editor gate's), a `unity-slot run` waiting for a Unity slot (UnitySlotsReport.waiting), or a sandbox
// editor's start queued in the bench queue (its ticket carries the sandbox and no session). The ledger shows the request
// Blocked on it (shared/workState.ts) and Working again once the ticket or the slot is granted, by the next report.
import type { BenchState, BenchTicketGlance, MachineStats, UnitySlotsReport } from './types.ts';

export interface QueueWait {
  /**
   * `bench`: a worker's own ticket; `editor`: its sandbox editor's start, queued in the bench queue; `slot`: a Unity slot;
   * `full`: the machine has no Unity slot to give now (no worker named: a refused editor start waits on it,
   * SessionInfo.editorRefused); `refused`: that wait, as one worker's.
   */
  kind: 'bench' | 'editor' | 'slot' | 'full' | 'refused';
  machine: string;
  /** The worker session that waits (FF_SESSION_ID); absent for an editor's start, which the daemon queues for the sandbox. */
  session?: string;
  sandbox?: string;
  /** What it waits on, as "Blocked on …" ends: "the exclusive bench lock on lothdesktop (held by w1908 / t00000911, 2 ahead in queue)". */
  on: string;
  /** What waits: "an exclusive ticket t00000915 (timed: ...), since 22:58 UTC". */
  what: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hhmm = (iso: string | undefined) => (iso && /T\d\d:\d\d/.test(iso) ? `${iso.slice(11, 16)} UTC` : undefined);
const inQueue = (ahead: number) => (ahead > 0 ? `${ahead} ahead in queue` : 'next in queue');

/** A ticket as the reasons name it: its requests, else its worker, sandbox or what, and the ticket ("w1908 / t00000911"). */
export function ticketName(t: Pick<BenchTicketGlance, 'ticket' | 'what' | 'session' | 'requests' | 'sandbox'>): string {
  const editor = /^running editor\b/.test(t.what) && t.sandbox ? `${t.sandbox}'s editor` : undefined;
  const who = t.requests?.length ? t.requests.join('/') : editor ?? (t.session ? `worker ${t.session.slice(0, 8)}` : t.sandbox ? `sandbox ${t.sandbox}` : clip(t.what || 'a run', 40));
  return `${who} / ${t.ticket}`;
}

/** What a waiting ticket waits on: the lock as it is held now, said exclusive or shared, and its place in the queue. */
export function benchWaitOn(machine: string, b: BenchState, mine: BenchTicketGlance & { ahead: number }): string {
  const place = inQueue(mine.ahead);
  if (b.legacy) return `the exclusive bench lock on ${machine} (held by an old-style lock: ${clip(b.legacy.owner, 60)}; ${place})`;
  const ex = b.mode === 'exclusive' ? b.running.find((t) => t.mode === 'exclusive') : undefined;
  if (ex) return `the exclusive bench lock on ${machine} (held by ${ticketName(ex)}${hhmm(ex.since) ? ` since ${hhmm(ex.since)}` : ''}, ${place})`;
  if (b.mode === 'shared') {
    const names = b.running.slice(0, 3).map(ticketName);
    const more = b.runningCount > names.length ? ` and ${b.runningCount - names.length} more` : '';
    const held = `held by ${b.runningCount} shared ticket${b.runningCount === 1 ? '' : 's'}: ${names.join(', ')}${more}`;
    // A shared ticket waits only behind an exclusive one ahead of it (nobody passes a waiting exclusive ticket).
    const ahead = mine.mode === 'shared' ? (b.waiters ?? []).find((t) => t.mode === 'exclusive' && t.ahead < mine.ahead) : undefined;
    if (ahead) return `the shared bench lock on ${machine} (a shared lock, ${held}; behind the exclusive ticket ${ticketName(ahead)}, which waits for them; ${place})`;
    return `the shared bench lock on ${machine} (a shared lock, ${held}; an exclusive ticket waits for all of them to finish; ${place})`;
  }
  return `the bench queue on ${machine} (${place})`;
}

/** A Unity slot wait: "a Unity editor slot on beast (3 of 3 in use, 1 ahead in queue)". */
function slotWaitOn(machine: string, u: UnitySlotsReport, w: UnitySlotsReport['waiting'][number]): string {
  const pos = w.position ?? u.waiting.indexOf(w) + 1;
  return `a Unity editor slot on ${machine} (${u.used} of ${u.limit ?? 'no limit'} in use, ${inQueue(pos - 1)})`;
}

/** Every queue wait one machine's daemon reports now. */
export function queueWaitsOf(machine: string, st: Pick<MachineStats, 'bench' | 'unity'> | undefined): QueueWait[] {
  const out: QueueWait[] = [];
  const b = st?.bench;
  for (const t of b?.waiters ?? []) {
    const since = hhmm(t.since);
    const what = `${t.mode === 'exclusive' ? 'an exclusive' : 'a shared'} ticket ${t.ticket} (${clip(t.what, 80)})${since ? `, waiting since ${since}` : ''}`;
    const on = benchWaitOn(machine, b!, t);
    if (t.session) out.push({ kind: 'bench', machine, session: t.session, ...(t.sandbox ? { sandbox: t.sandbox } : {}), on, what });
    else if (t.sandbox && /^running editor\b/.test(t.what)) out.push({ kind: 'editor', machine, sandbox: t.sandbox, on, what });
  }
  const u = st?.unity;
  for (const w of u?.waiting ?? []) {
    if (!w.session) continue;
    const since = hhmm(w.since);
    out.push({ kind: 'slot', machine, session: w.session, on: slotWaitOn(machine, u!, w), what: `${w.count} Unity slot${w.count === 1 ? '' : 's'} for "${clip(w.label, 80)}"${since ? `, waiting since ${since}` : ''}: ${clip(w.why, 120)}` });
  }
  // No slot to give now, by the slot gate's own rule (machine/unitySlots.ts assess): every slot in use, launches already
  // waiting (a start goes behind them), or RAM at its cap. An editor start refused here still waits.
  if (u && u.limit !== undefined) {
    const ram = u.ramPct !== undefined && u.ramPct >= u.ramLimitPct;
    const n = u.waiting.length;
    if (u.used >= u.limit || n || ram) {
      const why = [`${u.used} of ${u.limit} in use`, ...(n ? [`${n} launch${n === 1 ? '' : 'es'} waiting`] : []), ...(ram ? [`RAM ${u.ramPct}%, new launches wait below ${u.ramLimitPct}%`] : [])];
      out.push({ kind: 'full', machine, on: `a Unity editor slot on ${machine} (${why.join(', ')})`, what: 'no Unity slot free' });
    }
  }
  return out;
}

/**
 * Why its machine's Unity slots refused an editor start (machine/unitySlots.ts startRefusal: "not started: <why>; …; Try
 * again once one ends (wake_me) …"), or undefined for any other error (a person playing, low disk, an offline machine).
 */
export function editorSlotRefusal(message: string): string | undefined {
  return /^not started: /.test(message) && /Try again once one ends/.test(message) ? message.slice('not started: '.length, 213) : undefined;
}

/** Every machine's queue waits (the portal's machine stats, by machine id). */
export function queueWaitsAll(stats: Readonly<Record<string, Pick<MachineStats, 'bench' | 'unity'>>> | undefined): QueueWait[] {
  return Object.entries(stats ?? {}).flatMap(([id, st]) => queueWaitsOf(id, st));
}

// w3715: a worker that holds a bench ticket can always carry on, and an idle one cannot keep holding it.
// lothsahn, 2026-11-08: "Make sure that this situation can never happen again. Design a good framework for workers so
// idle stuff can't hold locks"; "Or rather, make sure stuff holding locks can continue doing stuff"; "We probably should be
// able to pre empt a worker with a lock but it shouldn't be idle and hold the lock." On LothDesktop that day w3536's worker
// left a background probe holding the exclusive lock for over an hour while placement.hold queued its messages and wake.
//
// Three parts, all from the bench state each daemon reports with its stats (machine/benchState.ts, BenchState.running):
// - `workerTickets` names the tickets a worker's own work holds; Agents.machineHold, SessionManager.fullFor and
//   Agents.poolWait let that worker's messages and wakes through (a pause still holds it: the pause ends its processes,
//   machine/pauseStop.ts, and with them the ticket).
// - BenchHolderWatch nudges a holder that has no turn and no background task running (its ticket is held by work nothing
//   controls: a nohup'd or detached script, a leg left behind), and revokes the ticket if it stays so after the nudge
//   (the daemon's bench_revoke, machine/benchRevoke.ts: bench_queue.py's own revoke, then the helper's tree after a grace).
// - When an idle holder's last ticket goes, its pending wake_me fires then, not at its fixed time.
// The game repo's own turn limit (bench_queue.py, w1832) still pre-empts a busy holder when an equal or higher-priority
// waiter waits; a holder nobody waits behind keeps the lock while it works (w1860).
import type { BenchState, BenchTicketGlance, SessionInfo } from '../shared/types.ts';

/** How long a holder may sit with no turn and no background task before it is nudged. */
export const HOLDER_IDLE_NUDGE_MS = 2 * 60_000;
/** After the nudge: how long until a holder still idle has its ticket revoked. */
export const HOLDER_REVOKE_AFTER_MS = 10 * 60_000;
/** A holder must have been idle at least this long, continuously, when the revoke comes (it may have just ended a turn). */
export const HOLDER_IDLE_REVOKE_MS = 2 * 60_000;

/**
 * A ticket the harness itself holds, not a worker's own work: an editor's life ticket (session `editor:<sandbox>`, w1962, or
 * none), and a timed_run leg's, which the daemon takes in the worker's name (machine/timedRunner.ts names it `timed run <id>:`)
 * and ends with the run.
 */
export const harnessTicket = (t: Pick<BenchTicketGlance, 'session' | 'what'>) => !t.session || t.session.startsWith('editor:') || /^timed run /.test(t.what);

/** Whether a ticket's session is this one (bench_queue.py may record a prefix of the id). */
export const ticketOf = (t: Pick<BenchTicketGlance, 'session'>, sessionId: string) => !!t.session && (t.session === sessionId || sessionId.startsWith(t.session));

/** The granted tickets a worker's own work holds on its machine (BenchState.running lists only granted ones). */
export function workerTickets(bench: BenchState | undefined, sessionId: string): BenchTicketGlance[] {
  return bench?.running.filter((t) => ticketOf(t, sessionId) && !harnessTicket(t)) ?? [];
}

/** "LothDesktop's exclusive ticket t00000042 (probe A/B leg 3)": how a message names a ticket. */
export const ticketName = (machineId: string, t: BenchTicketGlance) => `${machineId}'s ${t.mode} bench ticket ${t.ticket} ("${t.what.slice(0, 100)}")`;

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + 'Z';

export function holderNudgeText(machineId: string, t: BenchTicketGlance, revokeAt: number): string {
  return [
    `Bench lock (w3715): your ${ticketName(machineId, t)} is held, but no turn and no background task of yours is running, so nothing you control is using it.`,
    'If a script of yours still runs under it, keep it in a background task you watch (Bash run_in_background) or wait for it in this turn; if it is done, release the ticket (bench_queue.py --release, bench_unlock).',
    `If it is still held with nothing of yours running at ${hhmm(revokeAt)}, FF Factory revokes it: what runs under it is stopped and the ticket goes to the next waiter.`,
  ].join(' ');
}

export function holderRevokeText(machineId: string, t: BenchTicketGlance): string {
  return `Bench lock (w3715): FF Factory revoked your ${ticketName(machineId, t)}: it was held with no turn and no background task of yours running after a warning. What ran under it was asked to stop (bench_queue.py's revoke), and is ended 90 seconds later if it has not. Samples already written are kept; for more, take a new ticket from a turn or a background task you watch: it goes to the back of the queue.`;
}

export interface BenchHolderWatchDeps {
  machineIds: () => Iterable<string>;
  bench: (machineId: string) => BenchState | undefined;
  /** The session a ticket names (by id or prefix), undefined when this portal has none. */
  session: (ticketSession: string) => SessionInfo | undefined;
  /** Whether its process runs now (SessionHandle.live). */
  live: (sessionId: string) => boolean;
  midTurn: (info: SessionInfo) => boolean;
  send: (sessionId: string, text: string) => void;
  /** Ask the machine's daemon to revoke a ticket (machineProtocol bench_revoke); false when it cannot be sent now. */
  revoke: (machineId: string, ticket: string, session: string, why: string) => boolean;
  /** Fire a pending wake_me now (Waker.fireEarly); false when there is none. */
  wakeEarly: (sessionId: string, why: string) => boolean;
  log?: (line: string) => void;
  now?: () => number;
}

interface Watched {
  machineId: string;
  sessionId: string;
  idleSince?: number;
  nudgedAt?: number;
  revokedAt?: number;
}

/** Watches every worker-held bench ticket; `tick` runs every 30 s (server/index.ts). */
export class BenchHolderWatch {
  private readonly watched = new Map<string, Watched>();
  private readonly d: BenchHolderWatchDeps;

  constructor(d: BenchHolderWatchDeps) {
    this.d = d;
  }

  /** Whether a session is idle: no turn, and no background task that would re-invoke it, or no process at all. */
  private idle(info: SessionInfo): boolean {
    if (!this.d.live(info.id)) return true;
    return !this.d.midTurn(info) && !(info.backgroundTasks && info.backgroundTasks > 0);
  }

  tick(): void {
    const now = this.d.now?.() ?? Date.now();
    const seen = new Set<string>();
    for (const machineId of this.d.machineIds()) {
      const bench = this.d.bench(machineId);
      if (!bench) {
        // No report from it (offline, restarting): what it held is judged when it reports again.
        for (const [k, w] of this.watched) if (w.machineId === machineId) seen.add(k);
        continue;
      }
      for (const t of bench.running) {
        if (harnessTicket(t) || !t.session) continue;
        // The urgent release lane's builder and the nightly run their own long legs (w1832 exempts them from turn limits).
        if (t.exempt === 'release' || t.exempt === 'nightly') continue;
        const info = this.d.session(t.session);
        if (!info || info.kind !== 'worker') continue;
        const key = `${machineId}:${t.ticket}`;
        seen.add(key);
        const w = this.watched.get(key) ?? { machineId, sessionId: info.id };
        this.watched.set(key, w);
        if (w.revokedAt) continue;
        if (!this.idle(info)) {
          w.idleSince = undefined;
          continue;
        }
        w.idleSince ??= now;
        if (now - w.idleSince < HOLDER_IDLE_NUDGE_MS) continue;
        if (!w.nudgedAt) {
          w.nudgedAt = now;
          try {
            this.d.send(info.id, holderNudgeText(machineId, t, now + HOLDER_REVOKE_AFTER_MS));
            this.d.log?.(`idle holder: told ${info.id} its ticket ${t.ticket} on ${machineId} is held with nothing of its running`);
          } catch (e) {
            this.d.log?.(`idle holder: ${info.id} not told about ${t.ticket} on ${machineId}: ${(e as Error).message}`);
          }
          continue;
        }
        if (now - w.nudgedAt < HOLDER_REVOKE_AFTER_MS || now - w.idleSince < HOLDER_IDLE_REVOKE_MS) continue;
        const why = `held idle by ${info.id} since ${hhmm(w.idleSince)} after a warning at ${hhmm(w.nudgedAt)} (w3715)`;
        if (!this.d.revoke(machineId, t.ticket, t.session, why)) {
          this.d.log?.(`idle holder: could not ask ${machineId} to revoke ${t.ticket} now; tried again on the next pass`);
          continue;
        }
        w.revokedAt = now;
        this.d.log?.(`idle holder: asked ${machineId} to revoke ${t.ticket} of ${info.id}: ${why}`);
        try {
          this.d.send(info.id, holderRevokeText(machineId, t));
        } catch {
          // its next turn reads the ticket gone
        }
      }
      // A list cut at BENCH_STATE_MAX_RUNNING says nothing of the tickets left out: none of them counts as gone.
      if (bench.runningCount > bench.running.length) for (const [k, w] of this.watched) if (w.machineId === machineId) seen.add(k);
    }
    // A ticket gone since the last pass: its holder's wake comes now if it has nothing else running (lothsahn's "its wake is
    // due when its background job ends, not on a fixed timer").
    const gone = new Set<string>();
    for (const [k, w] of this.watched) {
      if (seen.has(k)) continue;
      this.watched.delete(k);
      gone.add(w.sessionId);
    }
    for (const sessionId of gone) {
      if ([...this.watched.values()].some((w) => w.sessionId === sessionId)) continue;
      const info = this.d.session(sessionId);
      if (!info || !this.idle(info)) continue;
      if (this.d.wakeEarly(sessionId, 'the bench ticket your work held was let go')) this.d.log?.(`idle holder: ${sessionId}'s last ticket went, so its wake_me fired now`);
    }
  }
}

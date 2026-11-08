// w3730: a person stops a machine's bench ticket (lothsahn, 2026-11-08, about bench locks: "Make sure that this situation
// can never happen again… get it fixed"; the design asked for a Stop button for each lock on the dashboard). Two ways in,
// one path: the machine's bench line on the dashboard (POST /api/machines/<id>/bench/<ticket>/stop) and a person's own
// orchestrator (stop_bench_ticket). Both send the daemon's `bench_revoke` (machine/benchRevoke.ts, w3715) with the
// person's name in `why`, and tell the holding worker (holderRevokeText). Which tickets may be stopped is one rule for the
// page and here: shared/benchStop.ts benchStopRefusal.
import { holderRevokeText, ticketName } from './benchHolders.ts';
import { BENCH_TICKET_RE, benchStopRefusal, benchStopWhy } from '../shared/benchStop.ts';
import type { BenchState, SessionInfo } from '../shared/types.ts';
import type { ToDaemon } from './machineProtocol.ts';

/**
 * How long a stop already asked for answers "already asked" instead of sending again: the daemon's grace before it ends the
 * helper (REVOKE_KILL_GRACE_MS, 90 s) plus three of its 15 s stats reports, after which the ticket should be gone from them.
 */
export const BENCH_STOP_REPEAT_MS = 90_000 + 45_000;

/** A refusal: the route answers it with `status`, the tool with its text. */
export class BenchStopError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface BenchStopDeps {
  /** Whether this portal knows the machine. */
  known: (machineId: string) => boolean;
  machineIds: () => Iterable<string>;
  online: (machineId: string) => boolean;
  /** Its daemon's last bench report (MachineStats.bench), undefined for none. */
  bench: (machineId: string) => BenchState | undefined;
  post: (machineId: string, msg: Extract<ToDaemon, { type: 'bench_revoke' }>) => void;
  /** The session a ticket names (by id or prefix), undefined when this portal has none. */
  session: (ticketSession: string) => SessionInfo | undefined;
  send: (sessionId: string, text: string) => void;
  log?: (line: string) => void;
  now?: () => number;
}

export class BenchStops {
  private readonly asked = new Map<string, number>();
  private readonly d: BenchStopDeps;

  constructor(d: BenchStopDeps) {
    this.d = d;
  }

  /** The tickets a person may stop, on one machine or on every online one, one line each. */
  list(machineIdIn?: string): string {
    const one = machineIdIn?.trim().toLowerCase();
    if (one && !this.d.known(one)) throw new BenchStopError(404, `no machine "${machineIdIn}"; list_machines names them`);
    const ids = one ? [one] : [...this.d.machineIds()].filter((id) => this.d.online(id));
    const lines: string[] = [];
    for (const id of ids) {
      const bench = this.d.online(id) ? this.d.bench(id) : undefined;
      for (const t of bench?.running ?? []) {
        if (benchStopRefusal(t)) continue;
        const since = t.since ? `, held since ${hhmm(Date.parse(t.since))}` : '';
        lines.push(`- ${id} ${t.ticket}: ${t.mode}, ${t.requests?.join(', ') || 'no request'}, worker ${t.session!.slice(0, 8)}${since}: "${t.what.slice(0, 100)}"`);
      }
    }
    const where = one ?? 'any online machine';
    return lines.length
      ? `Bench tickets that can be stopped on ${where}:\n${lines.join('\n')}`
      : `No worker's bench ticket can be stopped on ${where} now (harness tickets, the urgent release lane's and the nightly's are not stopped from here).`;
  }

  /**
   * Stop `ticket` on `machineId` for `person` ("Lothsahn"), `via` where they asked ("from the dashboard"). Returns what was
   * done, in a line; throws BenchStopError with the reason when it cannot be stopped.
   */
  stop(machineIdIn: string, ticketIn: string, person: string, via: string): string {
    const machineId = machineIdIn.trim().toLowerCase();
    const ticket = ticketIn.trim();
    if (!this.d.known(machineId)) throw new BenchStopError(404, `no machine "${machineIdIn}"; list_machines names them`);
    if (!BENCH_TICKET_RE.test(ticket)) throw new BenchStopError(400, `"${ticketIn}" is not a bench ticket name (t and 8 digits, e.g. t00000042)`);
    if (!this.d.online(machineId)) throw new BenchStopError(409, `${machineId} is offline: its daemon cannot be asked now, and a ticket there ends with its helper`);
    const bench = this.d.bench(machineId);
    if (!bench) throw new BenchStopError(409, `${machineId}'s daemon reports no bench queue (an older daemon, or none yet): nothing to stop from here`);
    const t = bench.running.find((x) => x.ticket === ticket);
    if (!t) {
      if (bench.waiters?.some((x) => x.ticket === ticket) || bench.nextExclusive?.ticket === ticket)
        throw new BenchStopError(409, `${ticket} on ${machineId} is not granted yet: it waits and holds nothing`);
      const cut = bench.runningCount > bench.running.length ? ` (its last report lists ${bench.running.length} of ${bench.runningCount} holders)` : '';
      throw new BenchStopError(404, `${machineId} holds no ticket ${ticket} now${cut}: it may have ended already`);
    }
    const refusal = benchStopRefusal(t);
    if (refusal) throw new BenchStopError(409, refusal);
    const now = this.d.now?.() ?? Date.now();
    const key = `${machineId}:${ticket}`;
    for (const [k, at] of this.asked) if (now - at >= BENCH_STOP_REPEAT_MS) this.asked.delete(k);
    const before = this.asked.get(key);
    if (before !== undefined) return `${ticketName(machineId, t)} was already asked to stop at ${hhmm(before)}: its helper is ended 90 s after that if it has not let go.`;
    const why = benchStopWhy(person, via);
    this.d.post(machineId, {
      type: 'bench_revoke',
      ticket,
      session: t.session!,
      why,
    });
    this.asked.set(key, now);
    this.d.log?.(`stop: ${person} asked ${machineId} to revoke ${ticket} (${t.what.slice(0, 80)}; worker ${t.session!.slice(0, 8)}) ${via}`);
    const holder = this.d.session(t.session!);
    let told = '';
    if (holder) {
      try {
        this.d.send(holder.id, holderRevokeText(machineId, t, person));
        told = ` Its worker ${holder.id.slice(0, 8)} was told.`;
      } catch (e) {
        told = ` Its worker ${holder.id.slice(0, 8)} could not be told now (${(e as Error).message}).`;
      }
    } else told = ` No worker of this portal holds it (session ${t.session!.slice(0, 8)}), so nobody was told.`;
    return `Stopping ${ticketName(machineId, t)}: ${machineId}'s daemon writes its revoked file now (bench_queue.py asks what runs under it to stop) and ends its helper's process tree 90 s later if it still holds.${told}`;
  }
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + 'Z';

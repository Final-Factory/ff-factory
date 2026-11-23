/**
 * w5341 (lothsahn: "When work needs a two machine run for any reason and it's already got a slot on one machine, raise it a
 * priority level for getting the other machine slot so that the pair can get running"): which legs of the pair runs under
 * way are raised one level for their machine's Unity slot gate, and which hold the side the raised ones wait for.
 *
 * A pair's legs are started together (server/agents.ts startPair: every leg's sandbox in one call), so placement never
 * holds half a pair; what a leg then queues for on its own machine is a Unity slot (its sandbox's editor, or a `unity-slot
 * run` build or test run), and one leg can hold its slot on machine A while the other waits on machine B behind
 * same-priority work. That half-held state is what this finds. The portal sends each mark to the leg's machine in
 * priorities.json once a minute (Machines.pushBenchPriorities), so a raise starts and ends within about a minute of a side
 * being taken or let go.
 */
import { asWorkPriority, benchRank, priorityIndex, raiseOne, type BenchPriority, type PairRaise, type WorkPriority } from '../shared/types.ts';

export interface PairLegState {
  session: string;
  machine?: string;
  /** Whether the leg's sandbox holds a Unity slot on its machine now (its editor up, or a granted unity-slot run). */
  holds: boolean;
}

export interface PairState {
  work: string;
  since: string;
  priority: WorkPriority;
  legs: PairLegState[];
}

/**
 * Each leg's mark: `waiting` for a leg that holds no slot while a leg on another machine holds one, `held` for a leg that
 * holds its slot while a leg on another machine holds none. Nothing for a pair with every leg holding (it runs), none
 * holding (nothing is half held, so no raise), or legs on one machine only.
 */
export function pairRaises(pairs: PairState[]): Map<string, PairRaise> {
  const out = new Map<string, PairRaise>();
  for (const p of pairs) {
    const legs = p.legs.filter((l) => l.machine);
    for (const l of legs) {
      const elsewhere = legs.filter((o) => o.machine !== l.machine);
      if (!elsewhere.length) continue;
      const others = elsewhere.filter((o) => o.holds !== l.holds).map((o) => o.machine!);
      if (!others.length) continue;
      out.set(l.session, { half: l.holds ? 'held' : 'waiting', from: p.priority, work: p.work, since: p.since, others: [...new Set(others)].sort() });
    }
  }
  return out;
}


/**
 * Put the marks on a machine's priorities.json sessions (Agents.benchPriorities): a waiting leg goes one level above the
 * higher of its own sessions' rank and its pair run's priority, and carries `pair`; a held side keeps its rank and carries
 * `pair`. A leg not in `out` (on another machine) is left alone.
 */
export function applyPairRaises(out: Record<string, BenchPriority>, pairs: PairState[]): void {
  for (const [session, r] of pairRaises(pairs)) {
    const cur = out[session];
    if (!cur) continue;
    const own = asWorkPriority(cur.level ?? cur.priority) ?? 'low';
    const from = priorityIndex(r.from) > priorityIndex(own) ? r.from : own;
    out[session] = { ...cur, ...(r.half === 'waiting' ? benchRank(raiseOne(from)) : {}), pair: { ...r, from } };
  }
}

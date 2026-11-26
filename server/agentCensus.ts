/**
 * w5972: the agents a machine's daemon counts against its agent limits, and the portal's warning when its own count of
 * that machine disagrees. Warn only (lothsahn's lockout rule): nothing here stops, drops or places anything.
 *
 * On 2026-11-26 at 06:35:09Z placement counted beast at "2 of 6 agents mid-turn" and sent w5892 there; at 06:37:34 beast's
 * daemon refused it and four other starts with "already 6 agents running in this machine's sandboxes (max_sandbox_agents
 * 6)", naming none. Its daemon had adopted 8 agent hosts at 06:19:01, six of them mid-turn (11a84ee9, 716b6111, 828bacfa,
 * 847ebd50, 9a8691c5, d732483b), two of those stale copies of requests that had moved to biscuit. Nothing showed the two
 * counts side by side until now.
 */

/** One agent the daemon counts: mid-turn (running, starting or waiting for a permission answer), in a sandbox or standing. */
export type CensusAgent = { id: string; sandbox?: string; status: string; live: boolean };

/** What the daemon sends with its stats (every 15 s): the agents its runningIn counts, sandboxes' and standing together. */
export type AgentCensus = { midTurn: CensusAgent[] };

/** One portal session on that machine counted as mid-turn: reported so, or a turn the portal sent not yet reported. */
export type PortalCounted = { id: string; sandbox?: string; status: string; live: boolean; starting: boolean };

/** What the portal holds of a session the daemon counts but the portal does not count on that machine. */
export type PortalSeen = { machine?: string; status: string; live: boolean } | undefined;

/** The agents a refusal counted, by id, place and state: "11a84ee9 (slot1, running), 847ebd50 (slot4, running, no process)". */
export function describeCounted(agents: readonly CensusAgent[], max = 12): string {
  const one = (a: CensusAgent) => `${a.id.slice(0, 8)} (${[a.sandbox ?? 'standing', a.status, ...(a.live ? [] : ['no process'])].join(', ')})`;
  const shown = agents.slice(0, max).map(one);
  return agents.length > max ? `${shown.join(', ')} and ${agents.length - max} more` : shown.join(', ') || 'none';
}

/** A daemon's census as it came over the link, checked field by field; undefined when it is not one. */
export function censusOf(v: unknown): AgentCensus | undefined {
  if (!v || typeof v !== 'object' || !Array.isArray((v as AgentCensus).midTurn)) return undefined;
  const midTurn: CensusAgent[] = [];
  for (const a of (v as AgentCensus).midTurn.slice(0, 200)) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id || a.id.length > 80) continue;
    midTurn.push({ id: a.id, ...(typeof a.sandbox === 'string' && a.sandbox ? { sandbox: a.sandbox.slice(0, 80) } : {}), status: String(a.status ?? '?').slice(0, 40), live: a.live === true });
  }
  return { midTurn };
}

/** A mismatch must outlast this and two reports before it is warned of: a turn just sent or just ended is in flight. */
export const CENSUS_GRACE_MS = 60_000;
/** A mismatch still there is warned of again this often. */
export const CENSUS_REMIND_MS = 30 * 60_000;

type Pending = { since: number; reports: number };

/**
 * Per machine, the ids counted on one side only, and whether they were warned of. note() answers the line to log, or
 * undefined: a warning once a mismatch has lasted CENSUS_GRACE_MS over two reports (again when its set changes, and
 * every CENSUS_REMIND_MS), and one line when the counts agree again.
 */
export class CensusWatch {
  private readonly pending = new Map<string, Map<string, Pending>>();
  private readonly warned = new Map<string, { key: string; at: number }>();
  private readonly last = new Map<string, { at: number; census: AgentCensus }>();

  /** The daemon's last census of `machine` and when it came (for the enforce stage; read by nothing that acts yet). */
  lastOf(machine: string) {
    return this.last.get(machine);
  }

  forget(machine: string) {
    this.pending.delete(machine);
    this.warned.delete(machine);
    this.last.delete(machine);
  }

  note(machine: string, census: AgentCensus, portal: readonly PortalCounted[], seen: (id: string) => PortalSeen, now: number): string | undefined {
    this.last.set(machine, { at: now, census });
    const daemonIds = new Set(census.midTurn.map((a) => a.id));
    const portalIds = new Set(portal.map((p) => p.id));
    const daemonOnly = census.midTurn.filter((a) => !portalIds.has(a.id));
    const portalOnly = portal.filter((p) => !daemonIds.has(p.id));
    const now1 = new Set([...daemonOnly.map((a) => `d:${a.id}`), ...portalOnly.map((p) => `p:${p.id}`)]);
    const was = this.pending.get(machine) ?? new Map<string, Pending>();
    const next = new Map<string, Pending>();
    for (const k of now1) {
      const p = was.get(k);
      next.set(k, p ? { since: p.since, reports: p.reports + 1 } : { since: now, reports: 1 });
    }
    this.pending.set(machine, next);
    const lasting = [...next].filter(([, p]) => p.reports >= 2 && now - p.since >= CENSUS_GRACE_MS).map(([k]) => k);
    const key = lasting.sort().join(' ');
    const w = this.warned.get(machine);
    if (!key) {
      if (!w) return undefined;
      this.warned.delete(machine);
      return `agent count: ${machine}'s daemon and the portal agree again: ${census.midTurn.length} agent(s) mid-turn (w5972)`;
    }
    if (w && w.key === key && now - w.at < CENSUS_REMIND_MS) return undefined;
    this.warned.set(machine, { key, at: now });
    const last = new Set(lasting);
    const dOnly = daemonOnly.filter((a) => last.has(`d:${a.id}`)).map((a) => {
      const s = seen(a.id);
      const where = !s ? 'unknown to the portal' : s.machine && s.machine !== machine ? `on ${s.machine} for the portal` : `portal: ${s.status}${s.live ? '' : ', no process'}`;
      return `${describeCounted([a])} [${where}]`;
    });
    const pOnly = portalOnly.filter((p) => last.has(`p:${p.id}`)).map((p) => `${describeCounted([p])}${p.starting ? ' [sent, not yet reported]' : ''}`);
    const reported = portal.filter((p) => !p.starting).length;
    return [
      `agent count: ${machine}'s daemon counts ${census.midTurn.length} agent(s) mid-turn (${describeCounted(census.midTurn)}), the portal ${portal.length} (${reported} reported mid-turn, which placement counts, and ${portal.length - reported} sent, not yet reported)`,
      ...(dOnly.length ? [`counted by its daemon only: ${dOnly.join('; ')}`] : []),
      ...(pOnly.length ? [`counted by the portal only: ${pOnly.join('; ')}`] : []),
      'warn only: nothing is stopped or placed by it (w5972)',
    ].join('; ');
  }
}

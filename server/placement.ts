/**
 * Where new work has room (w416, Lothsahn: "make sure jobs are getting scheduled on LothDesktop"). The dispatcher picks
 * the computer for each request itself (start_agent with a sandbox id); this module gives it each computer's load where
 * it decides (list_sandboxes, system_status) and a hint when it places work on a busy computer while another has room.
 * It never moves or refuses anything.
 */

/** One computer that holds sandboxes: this host's own pool, or a machine's (BEAST's own daemon, LothDesktop, a Mac). */
export interface Computer {
  /** "this host", or the machine id ("beast", "lothdesktop"). */
  id: string;
  online: boolean;
  /** Agent processes up in its sandboxes (an idle one holds its memory too). */
  live: number;
  /** Of those, mid-turn (what its agent limit counts since w384). */
  midTurn: number;
  maxAgents: number;
  sandboxes: number;
  maxSandboxes: number;
  /** Ready, labelled unused, no live agent. */
  freeSandboxes: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
}

/**
 * RAM in use at which a computer counts as busy. A guess at a safe line, set from w416's numbers: BEAST at 55 of 64 GB
 * (86%) with 7 agents was overloaded, LothDesktop at 30 of 64 GB (47%) had room; one more Unity editor takes 8-12 GB
 * (the dispatcher brief), about 15% of 64 GB.
 */
export const RAM_BUSY_PCT = 85;

export const memPct = (p: Pick<Computer, 'memUsedBytes' | 'memTotalBytes'>): number | undefined =>
  p.memTotalBytes && p.memUsedBytes !== undefined ? Math.round((100 * p.memUsedBytes) / p.memTotalBytes) : undefined;

/** Why a computer is busy (at or over its agent limit, RAM high, no sandbox to use or make), or [] when it is not. */
export function busyReasons(p: Computer): string[] {
  const out: string[] = [];
  if (!p.online) out.push('offline');
  if (p.live >= p.maxAgents) out.push(`${p.live} live agents of ${p.maxAgents}`);
  const pct = memPct(p);
  if (pct !== undefined && pct >= RAM_BUSY_PCT) out.push(`RAM ${pct}% used`);
  if (!p.freeSandboxes && p.sandboxes >= p.maxSandboxes) out.push(`no free sandbox (${p.sandboxes} of ${p.maxSandboxes} made, all in use)`);
  return out;
}

/** Room for one more worker: online, under its agent limit and the RAM line, with a free sandbox or room to make one. */
export const hasRoom = (p: Computer) => busyReasons(p).length === 0;

const loadPart = (p: Computer) => {
  const pct = memPct(p);
  return `${p.live} live agents of ${p.maxAgents} (${p.midTurn} mid-turn); ${p.freeSandboxes} of ${p.maxSandboxes} sandboxes free${p.sandboxes < p.maxSandboxes ? ` (${p.maxSandboxes - p.sandboxes} more can be made)` : ''}${pct !== undefined ? `; RAM ${pct}% used` : ''}`;
};

/** Where game-repo work belongs now, in a line, or undefined when no computer is busy while another has room. */
export function preferLine(places: readonly Computer[]): string | undefined {
  const busy = places.filter((p) => p.online && !hasRoom(p));
  const room = places.filter(hasRoom);
  if (!busy.length || !room.length) return undefined;
  return `Prefer ${room.map((p) => p.id).join(' or ')} for new game-repo work: ${busy.map((p) => p.id).join(' and ')} ${busy.length > 1 ? 'are' : 'is'} busy.`;
}

/** The capacity block list_sandboxes and system_status start with: one line per computer, then where to prefer. */
export function capacityLines(places: readonly Computer[]): string[] {
  if (!places.length) return [];
  const lines = places.map((p) => {
    const why = busyReasons(p);
    return `- ${p.id}: ${why.length ? `BUSY (${why.join('; ')})` : 'ROOM'}: ${loadPart(p)}`;
  });
  const prefer = preferLine(places);
  return ['## Capacity (where new work has room; docs/machines.md, "Placing work")', ...lines, ...(prefer ? [prefer] : [])];
}

/**
 * A note for start_agent or create_sandbox when the computer it places work on is busy while another has room, or
 * undefined. A soft hint: the work may need this computer (FF Factory's own repo or its deploys, ssh to the M5, a
 * brief that pins it), and a worker going on in its own sandbox stays there.
 */
export function placementHint(target: string, places: readonly Computer[]): string | undefined {
  const here = places.find((p) => p.id === target);
  if (!here) return undefined;
  const why = busyReasons(here).filter((w) => w !== 'offline');
  if (!why.length) return undefined;
  const room = places.filter((p) => p.id !== target && hasRoom(p));
  if (!room.length) return undefined;
  return ` Note: ${target} is busy (${why.join('; ')}) while ${room.map((p) => `${p.id} has room (${loadPart(p)})`).join(', and ')}. Unless this work needs ${target} (FF Factory's own repo or its deploys, ssh to the M5, a brief that pins it, or a worker going on in its own sandbox), put new game-repo work on ${room[0].id}.`;
}

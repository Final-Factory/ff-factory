/**
 * Where new work has room (w416, Lothsahn: "make sure jobs are getting scheduled on LothDesktop", then "Game work should
 * be spread between LothDesktop and Beast, not just when BEAST is full"). The dispatcher picks the computer for each
 * request itself (start_agent with a sandbox id); this module gives it each computer's room where it decides
 * (list_sandboxes, system_status), which one the next piece of game-repo work should go to, and a note when it places
 * work elsewhere. It never moves or refuses anything.
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
  /** Sandbox editors running, and how many may. */
  editors?: number;
  maxEditors?: number;
}

/**
 * RAM in use at which a computer counts as busy. A judgment set from w416's numbers: BEAST at 55 of 64 GB (86%) with 7
 * agents was overloaded, LothDesktop at 30 of 64 GB (47%) had room; one more Unity editor takes 8-12 GB (the dispatcher
 * brief), about 15% of 64 GB.
 */
export const RAM_BUSY_PCT = 85;

/**
 * Room scores closer than this count as even: the next piece of work goes to the one with fewer live agents, then to
 * the one that did not take the last. A judgment: ten points is one agent of ten slots, or about 6 GB of 64.
 */
export const EVEN_MARGIN = 0.1;

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

/**
 * How much room a computer has relative to its own limits, 0 to 1: the mean of its free shares of agent slots, sandboxes
 * (free plus those it may still make), RAM and editors (each one it reports). 0 when it is busy. The mean, not the
 * smallest share, so work spreads by overall load; a hard limit already makes it busy.
 */
export function roomOf(p: Computer): number {
  if (!hasRoom(p)) return 0;
  const shares = [1 - p.live / p.maxAgents, (p.freeSandboxes + Math.max(0, p.maxSandboxes - p.sandboxes)) / p.maxSandboxes];
  const pct = memPct(p);
  if (pct !== undefined) shares.push(1 - pct / 100);
  if (p.maxEditors) shares.push(Math.max(0, 1 - (p.editors ?? 0) / p.maxEditors));
  return Math.max(0, Math.min(1, shares.reduce((a, b) => a + b, 0) / shares.length));
}

const pctOf = (r: number) => `${Math.round(r * 100)}%`;

/**
 * Where the next piece of new game-repo work goes, and why: the computer with the most room; when the best two are
 * within EVEN_MARGIN, the one with fewer live agents, then the one that did not take the last (`last`).
 */
export function pickComputer(places: readonly Computer[], last?: string): { pick: Computer; why: string } | undefined {
  const open = places.filter(hasRoom).sort((a, b) => roomOf(b) - roomOf(a));
  if (!open.length) return undefined;
  if (open.length === 1) return { pick: open[0], why: `the only computer with room${places.length > 1 ? ` (${places.filter((p) => p !== open[0]).map((p) => `${p.id} is busy`).join(', ')})` : ''}` };
  const [a, b] = open;
  if (roomOf(a) - roomOf(b) >= EVEN_MARGIN) return { pick: a, why: `most room (${pctOf(roomOf(a))} vs ${pctOf(roomOf(b))} on ${b.id})` };
  const even = `room about even (${a.id} ${pctOf(roomOf(a))}, ${b.id} ${pctOf(roomOf(b))})`;
  if (a.live !== b.live) {
    const [fewer, more] = a.live < b.live ? [a, b] : [b, a];
    return { pick: fewer, why: `${even}; fewer live agents (${fewer.live} vs ${more.live})` };
  }
  const next = last === a.id ? b : a;
  const other = next === a ? b : a;
  return { pick: next, why: `${even}, the same live agents; ${last === other.id ? `${other.id} took the last one` : 'taking turns'}` };
}

const loadPart = (p: Computer) => {
  const pct = memPct(p);
  return `${p.live} live agents of ${p.maxAgents} (${p.midTurn} mid-turn); ${p.freeSandboxes} of ${p.maxSandboxes} sandboxes free${p.sandboxes < p.maxSandboxes ? ` (${p.maxSandboxes - p.sandboxes} more can be made)` : ''}${pct !== undefined ? `; RAM ${pct}% used` : ''}${p.maxEditors ? `; editors ${p.editors ?? 0} of ${p.maxEditors}` : ''}`;
};

/** Where the next piece of game-repo work should go, in a line, or undefined with fewer than two computers. */
export function preferLine(places: readonly Computer[], last?: string): string | undefined {
  if (places.length < 2) return undefined;
  const p = pickComputer(places, last);
  if (!p) return 'No computer has room for new work now.';
  return `Next new game-repo work: ${p.pick.id} (${p.why}).`;
}

/** The capacity block list_sandboxes and system_status start with: one line per computer, then where the next goes. */
export function capacityLines(places: readonly Computer[], last?: string): string[] {
  if (!places.length) return [];
  const lines = places.map((p) => {
    const why = busyReasons(p);
    return `- ${p.id}: ${why.length ? `BUSY (${why.join('; ')})` : `ROOM ${pctOf(roomOf(p))}`}: ${loadPart(p)}`;
  });
  const prefer = preferLine(places, last);
  return ['## Capacity (game-repo work is spread by room; docs/machines.md, "Placing work")', ...lines, ...(prefer ? [prefer] : [])];
}

/**
 * A note for start_agent or create_sandbox when the computer it places new work on is not the one pickComputer names,
 * or undefined. A soft hint: the work may need this computer (FF Factory's own repo or its deploys, ssh to the M5, a
 * brief that pins it, Max posting on LothDesktop), and a worker going on in its own sandbox stays there.
 */
export function placementHint(target: string, places: readonly Computer[], last?: string): string | undefined {
  const here = places.find((p) => p.id === target);
  if (!here) return undefined;
  const p = pickComputer(places, last);
  if (!p || p.pick.id === target) return undefined;
  const busy = busyReasons(here).filter((w) => w !== 'offline');
  const state = busy.length ? `${target} is busy (${busy.join('; ')})` : `${target} has ${pctOf(roomOf(here))} room`;
  return ` Note: ${state}; to spread game-repo work, the next goes to ${p.pick.id} (${p.why}; ${loadPart(p.pick)}). Unless this work needs ${target} (FF Factory's own repo or its deploys, ssh to the M5, a brief that pins it, Max posting, which only LothDesktop has, or a worker going on in its own sandbox), put new game-repo work on ${p.pick.id}.`;
}

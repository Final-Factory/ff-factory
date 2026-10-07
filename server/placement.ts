/**
 * Where new work has room (w416, Lothsahn: "make sure jobs are getting scheduled on LothDesktop", then "Game work should
 * be spread between LothDesktop and Beast, not just when BEAST is full"), and where it is preferred (w428, Ben: "favor
 * using lothdesktop and the m5 and m3 because beast is having issues with its processor and keeps crashing"). The
 * dispatcher picks the computer for each request itself (start_agent with a sandbox id; every worker runs in a sandbox,
 * w536); this module gives it each computer's room where it decides (list_sandboxes, system_status), which one the
 * next piece of game-repo work should go to, and a note when it places work elsewhere. It never moves or refuses
 * anything.
 */

/** One computer that can take a worker: a machine's pool of sandboxes (BEAST's own daemon's, LothDesktop's). */
export interface Computer {
  /** The machine id ("beast", "lothdesktop", "m5"). */
  id: string;
  online: boolean;
  /** Agent processes up in its sandboxes; an idle one holds its memory too. */
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
  /** Unity editors running (every Unity process its daemon counts, w469), and how many may. */
  editors?: number;
  maxEditors?: number;
  /** What they are: "1 interactive, 3 batch; 2 waiting (...)" (shared/fleet.ts unitySlotsLine). */
  editorsDetail?: string;
  /** VRAM its GPU Whisper for the portal's mic holds now (w615, machine/voice.ts), MiB: the editors share that GPU. */
  voiceVramMiB?: number;
  /** Workers that released their sandbox there while they waited and now wait to be placed again (w640): ahead of new work. */
  resumesWaiting?: number;
}

/** config placement (w428): computers to try first, in order, and computers to keep work off, with why. */
export interface PlacementPrefs {
  /** Machine ids, first choice first. Those not named come after, spread by room. */
  prefer?: string[];
  /** Machine id to the reason: used only when no other computer has room. */
  avoid?: Record<string, string>;
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

/** A computer's `voiceVramMiB` from its GPU Whisper's status (w615): only while the model is loaded. */
export const voiceVram = (s: { state: string; vramMiB?: number } | undefined): Pick<Computer, 'voiceVramMiB'> => (s?.state === 'ready' && s.vramMiB ? { voiceVramMiB: s.vramMiB } : {});

/** A computer's id as placement compares it: machine ids are lower-case. */
export const placeId = (id: string) => id.trim().toLowerCase();

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
 * (free plus those it may still make), RAM and editors (each one it has and reports). 0 when it is busy. The mean, not
 * the smallest share, so work spreads by overall load; a hard limit already makes it busy.
 */
export function roomOf(p: Computer): number {
  if (!hasRoom(p)) return 0;
  const shares = [1 - p.live / p.maxAgents];
  shares.push((p.freeSandboxes + Math.max(0, p.maxSandboxes - p.sandboxes)) / p.maxSandboxes);
  const pct = memPct(p);
  if (pct !== undefined) shares.push(1 - pct / 100);
  if (p.maxEditors) shares.push(Math.max(0, 1 - (p.editors ?? 0) / p.maxEditors));
  return Math.max(0, Math.min(1, shares.reduce((a, b) => a + b, 0) / shares.length));
}

const pctOf = (r: number) => `${Math.round(r * 100)}%`;

/** The w416 spread among `open` (all with room): most room; within EVEN_MARGIN, fewer live agents, then taking turns. */
function spread(open: Computer[], last?: string): { pick: Computer; why: string } {
  const sorted = [...open].sort((a, b) => roomOf(b) - roomOf(a));
  if (sorted.length === 1) return { pick: sorted[0], why: 'the only one with room' };
  const [a, b] = sorted;
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

/**
 * Where the next piece of new game-repo work goes, and why. In order: the first computer in prefs.prefer with room;
 * then the others not avoided, spread by room (w416); then, only when nothing else has room, an avoided one.
 */
export function pickComputer(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): { pick: Computer; why: string } | undefined {
  const open = places.filter(hasRoom);
  if (!open.length) return undefined;
  const avoid = avoidOf(prefs);
  const busy = places.filter((p) => !hasRoom(p)).map((p) => `${p.id} is busy`);
  const tail = busy.length ? `; ${busy.join(', ')}` : '';
  const prefer = (prefs.prefer ?? []).map(placeId);
  for (const id of prefer) {
    const p = open.find((x) => x.id === id && !avoid.has(x.id));
    if (p) return { pick: p, why: `first with room in placement.prefer (${prefer.join(' > ')})${tail}` };
  }
  const usable = open.filter((p) => !avoid.has(p.id));
  if (usable.length) {
    const s = spread(usable, last);
    const why = prefer.length ? `none in placement.prefer has room; ${s.why}` : s.why;
    return { pick: s.pick, why: `${why}${tail}` };
  }
  const s = spread(open, last);
  return { pick: s.pick, why: `only avoided computers have room (${s.pick.id}: ${avoid.get(s.pick.id)}); ${s.why}${tail}` };
}

const avoidOf = (prefs: PlacementPrefs) => new Map(Object.entries(prefs.avoid ?? {}).map(([k, v]) => [placeId(k), v]));

const loadPart = (p: Computer) => {
  const pct = memPct(p);
  const ram = pct !== undefined ? `; RAM ${pct}% used` : '';
  return `${p.live} live agents of ${p.maxAgents} (${p.midTurn} mid-turn); ${p.freeSandboxes} of ${p.maxSandboxes} sandboxes free${p.sandboxes < p.maxSandboxes ? ` (${p.maxSandboxes - p.sandboxes} more can be made)` : ''}${ram}${p.maxEditors ? `; editors ${p.editors ?? 0} of ${p.maxEditors}${p.editorsDetail ? `: ${p.editorsDetail}` : ''}` : ''}${p.voiceVramMiB ? `; Whisper holds ~${(p.voiceVramMiB / 1024).toFixed(1)} GB VRAM (unloaded for the editors when VRAM runs short)` : ''}${p.resumesWaiting ? `; ${p.resumesWaiting} released worker(s) wait to resume there and take the next sandbox that frees` : ''}`;
};

/** Where the next piece of game-repo work should go, in a line, or undefined with fewer than two computers. */
export function preferLine(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string | undefined {
  if (places.length < 2) return undefined;
  const p = pickComputer(places, last, prefs);
  if (!p) return 'No computer has room for new work now.';
  return `Next new game-repo work: ${p.pick.id} (${p.why}).`;
}

/** The capacity block list_sandboxes and system_status start with: one line per computer, then where the next goes. */
export function capacityLines(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string[] {
  if (!places.length) return [];
  const avoid = avoidOf(prefs);
  const prefer = (prefs.prefer ?? []).map(placeId);
  const lines = places.map((p) => {
    const why = busyReasons(p);
    const tags = [...(prefer.includes(p.id) ? [`preferred #${prefer.indexOf(p.id) + 1}`] : []), ...(avoid.has(p.id) ? [`avoided: ${avoid.get(p.id)}`] : [])];
    return `- ${p.id}${tags.length ? ` [${tags.join('; ')}]` : ''}: ${why.length ? `BUSY (${why.join('; ')})` : `ROOM ${pctOf(roomOf(p))}`}: ${loadPart(p)}`;
  });
  const next = preferLine(places, last, prefs);
  const how = prefer.length || avoid.size ? 'placement.prefer first, avoided last, the rest spread by room' : 'game-repo work is spread by room';
  return [`## Capacity (${how}; docs/machines.md, "Placing work")`, ...lines, ...(next ? [next] : [])];
}

/**
 * What may keep new work on a computer that is not the next one (w467, change 13: no longer BEAST's own paths, which
 * the portal VM does not have). `reviewRoot`: the review folder where the portal runs.
 */
export const pinnedWork = (reviewRoot?: string) =>
  `FF Factory's own repo or its deploys, the review folder${reviewRoot ? ` (${reviewRoot})` : ''}, ssh to the M5 from a computer that has its key, a brief that pins it`;

/**
 * A note for start_agent or create_sandbox when the computer it places new work on is not the one pickComputer names,
 * or undefined. A soft hint: the work may need this computer (pinnedWork, Max posting on LothDesktop), and a worker
 * going on in its own sandbox stays there.
 */
export function placementHint(target: string, places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}, reviewRoot?: string): string | undefined {
  const here = places.find((p) => p.id === target);
  if (!here) return undefined;
  const p = pickComputer(places, last, prefs);
  if (!p || p.pick.id === target) return undefined;
  const avoided = avoidOf(prefs).get(target);
  const busy = busyReasons(here).filter((w) => w !== 'offline');
  const state = avoided ? `${target} is avoided (${avoided})` : busy.length ? `${target} is busy (${busy.join('; ')})` : `${target} has ${pctOf(roomOf(here))} room`;
  return ` Note: ${state}; the next new game-repo work goes to ${p.pick.id} (${p.why}; ${loadPart(p.pick)}). Unless this work needs ${target} (${pinnedWork(reviewRoot)}, Max posting, which only LothDesktop has, or a worker going on in its own sandbox), put it there.`;
}

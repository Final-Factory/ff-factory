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
  /**
   * Agent seats left in its sandboxes (w1098): per sandbox, max_agents_per_sandbox less the agents mid-turn there, plus a
   * whole sandbox's worth for each sandbox it may still make. What work that needs no editor and no game sandbox (FF
   * Factory, FFBox, the plugin) takes; undefined when unknown, which counts as a seat.
   */
  agentSeats?: number;
}

/** config placement (w428): computers to try first, in order, and computers to keep work off, with why. */
export interface PlacementPrefs {
  /** Machine ids, first choice first. Those not named come after, spread by room. */
  prefer?: string[];
  /** Machine id to the reason: used only when no other computer has room. */
  avoid?: Record<string, string>;
  /**
   * Machine id to who holds it and why ("Ben testing, 2026-10-12", w1089): NO new work goes there, game or not, even when
   * every other computer is busy. It still shows its room, tagged HELD, and a request waiting while only held computers
   * have room is Queued with that said (not WRONG).
   */
  hold?: Record<string, string>;
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
 * Why a computer has no agent slot for work that needs no Unity editor and no game sandbox (w1098, lothsahn: "FFBox and FF
 * Factory updates don't need unity editors"): offline, its agent cap reached (the agents mid-turn, which is what
 * start_agent's queue counts, machines.ts capFull), or no seat in any sandbox. Editors, RAM for Unity and a free game
 * sandbox do not count. [] when it has one.
 */
export function agentBusyReasons(p: Computer): string[] {
  const out: string[] = [];
  if (!p.online) out.push('offline');
  if (p.midTurn >= p.maxAgents) out.push(`${p.midTurn} agents mid-turn of ${p.maxAgents}`);
  if (p.agentSeats !== undefined && p.agentSeats <= 0) out.push('no agent seat in any sandbox');
  return out;
}

/** An agent slot for work that needs no editor (w1098). */
export const hasAgentRoom = (p: Computer) => agentBusyReasons(p).length === 0;

/** What a request needs of a computer (WorkItem.needs): a game sandbox with an editor, or only an agent slot. */
export type NeedKind = 'game' | 'agent';

/** Whether a computer has room for `kind` of work: the one test every room check goes through. */
export const hasRoomFor = (p: Computer, kind: NeedKind) => (kind === 'game' ? hasRoom(p) : hasAgentRoom(p));

/**
 * Room now, the one answer behind the Capacity block's ROOM/BUSY, decide_work queue's refusal, the Queued WRONG flag and
 * the page (w1089: the dispatcher saw "lothdesktop has room" beside a BUSY line because each had its own count). `game`:
 * computers with room for game work that are not held; `agent`: the same for work that needs only an agent slot; `held`:
 * computers with room that a hold keeps work off, with who and why.
 */
export interface RoomNow {
  game: string[];
  agent: string[];
  held: { id: string; why: string; for: NeedKind[] }[];
  /** Each computer with room, id to its numbers at this moment: a log line of a flag explains itself when it is read hours later. */
  detail?: Record<string, string>;
}

const holdOf = (prefs: PlacementPrefs) => new Map(Object.entries(prefs.hold ?? {}).map(([k, v]) => [placeId(k), v]));

export function roomNow(places: readonly Computer[], prefs: PlacementPrefs = {}): RoomNow {
  const hold = holdOf(prefs);
  const out: RoomNow = { game: [], agent: [], held: [], detail: {} };
  for (const p of places) {
    const kinds = (['game', 'agent'] as const).filter((k) => hasRoomFor(p, k));
    if (!kinds.length) continue;
    out.detail![p.id] = `${p.freeSandboxes} of ${p.maxSandboxes} sandboxes free, ${p.live} live agents of ${p.maxAgents}, ${memPct(p) !== undefined ? `RAM ${memPct(p)}%` : 'RAM unknown'}`;
    const why = hold.get(p.id);
    if (why !== undefined) {
      out.held.push({ id: p.id, why, for: kinds });
      continue;
    }
    for (const k of kinds) out[k].push(p.id);
  }
  return out;
}

/** "m5 has room but is held (Ben testing)": how a Queued reason says a computer with room is not usable. */
export const heldText = (held: RoomNow['held'], kind?: NeedKind) => held.filter((h) => !kind || h.for.includes(kind)).map((h) => `${h.id} has room but is held (${h.why})`).join('; ');

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

/** How much agent room a computer has for work that needs no editor (w1098): its free share of agent slots, 0 when it has none. */
export const agentRoomOf = (p: Computer) => (hasAgentRoom(p) ? Math.max(0, Math.min(1, 1 - p.midTurn / p.maxAgents)) : 0);

const roomFor = (p: Computer, kind: NeedKind) => (kind === 'game' ? roomOf(p) : agentRoomOf(p));

const pctOf = (r: number) => `${Math.round(r * 100)}%`;

/** The w416 spread among `open` (all with room): most room; within EVEN_MARGIN, fewer live agents, then taking turns. */
function spread(open: Computer[], last: string | undefined, kind: NeedKind): { pick: Computer; why: string } {
  const score = (p: Computer) => roomFor(p, kind);
  const sorted = [...open].sort((a, b) => score(b) - score(a));
  if (sorted.length === 1) return { pick: sorted[0], why: 'the only one with room' };
  const [a, b] = sorted;
  if (score(a) - score(b) >= EVEN_MARGIN) return { pick: a, why: `most room (${pctOf(score(a))} vs ${pctOf(score(b))} on ${b.id})` };
  const even = `room about even (${a.id} ${pctOf(score(a))}, ${b.id} ${pctOf(score(b))})`;
  if (a.live !== b.live) {
    const [fewer, more] = a.live < b.live ? [a, b] : [b, a];
    return { pick: fewer, why: `${even}; fewer live agents (${fewer.live} vs ${more.live})` };
  }
  const next = last === a.id ? b : a;
  const other = next === a ? b : a;
  return { pick: next, why: `${even}, the same live agents; ${last === other.id ? `${other.id} took the last one` : 'taking turns'}` };
}

/**
 * Where the next piece of new work goes, and why. In order: the first computer in prefs.prefer with room; then the
 * others not avoided, spread by room (w416); then, only when nothing else has room, an avoided one. A held computer
 * (prefs.hold, w1089) is never picked. `kind`: game work needs a game sandbox and an editor's worth of RAM, other work
 * (w1098) only an agent slot; both go through hasRoomFor.
 */
export function pickComputer(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}, kind: NeedKind = 'game'): { pick: Computer; why: string } | undefined {
  const hold = holdOf(prefs);
  const open = places.filter((p) => hasRoomFor(p, kind) && !hold.has(p.id));
  if (!open.length) return undefined;
  const avoid = avoidOf(prefs);
  const busy = places.filter((p) => !hasRoomFor(p, kind)).map((p) => `${p.id} is busy`);
  busy.push(...places.filter((p) => hasRoomFor(p, kind) && hold.has(p.id)).map((p) => `${p.id} is held (${hold.get(p.id)})`));
  const tail = busy.length ? `; ${busy.join(', ')}` : '';
  const prefer = (prefs.prefer ?? []).map(placeId);
  for (const id of prefer) {
    const p = open.find((x) => x.id === id && !avoid.has(x.id));
    if (p) return { pick: p, why: `first with room in placement.prefer (${prefer.join(' > ')})${tail}` };
  }
  const usable = open.filter((p) => !avoid.has(p.id));
  if (usable.length) {
    const s = spread(usable, last, kind);
    const why = prefer.length ? `none in placement.prefer has room; ${s.why}` : s.why;
    return { pick: s.pick, why: `${why}${tail}` };
  }
  const s = spread(open, last, kind);
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
  if (!p) return `No computer has room for new work now${heldNote(places, prefs, 'game')}.`;
  return `Next new game-repo work: ${p.pick.id} (${p.why}).`;
}

/** " (m5 has room but is held (Ben testing))": the computers with room that a hold keeps off. */
function heldNote(places: readonly Computer[], prefs: PlacementPrefs, kind: NeedKind): string {
  const held = roomNow(places, prefs).held.filter((h) => h.for.includes(kind));
  return held.length ? ` (${heldText(held, kind)})` : '';
}

/**
 * Where the next piece of work that needs no Unity editor and no game sandbox goes (w1098, lothsahn: "FFBox and FF
 * Factory updates don't need unity editors"): FF Factory, FFBox, the ff-agents plugin and any other non-Unity repo. Placed
 * by agent-slot room alone, still skipping held computers and last on avoided ones. Always said, even with one computer.
 */
export function nonGameLine(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string {
  const p = pickComputer(places, last, prefs, 'agent');
  if (!p) return `No computer has an agent slot for non-game work now${heldNote(places, prefs, 'agent')}.`;
  return `Next non-game work (needs only an agent slot, no editor, no free game sandbox): ${p.pick.id} (${p.why}).`;
}

/** The capacity block list_sandboxes and system_status start with: one line per computer, then where the next goes. */
export function capacityLines(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string[] {
  if (!places.length) return [];
  const avoid = avoidOf(prefs);
  const hold = holdOf(prefs);
  const prefer = (prefs.prefer ?? []).map(placeId);
  const lines = places.map((p) => {
    const why = busyReasons(p);
    const tags = [...(prefer.includes(p.id) ? [`preferred #${prefer.indexOf(p.id) + 1}`] : []), ...(avoid.has(p.id) ? [`avoided: ${avoid.get(p.id)}`] : []), ...(hold.has(p.id) ? [`held: ${hold.get(p.id)}`] : [])];
    const verdict = why.length ? `BUSY (${why.join('; ')})` : hold.has(p.id) ? `ROOM ${pctOf(roomOf(p))} but HELD (${hold.get(p.id)}): no new work goes there` : `ROOM ${pctOf(roomOf(p))}`;
    // Agent room for non-game work (w1098), beside the game verdict: the dispatcher reads both from the one line.
    const agent = hasAgentRoom(p) ? (hold.has(p.id) ? 'agent slot: free but held' : `agent slot: free (${p.midTurn} of ${p.maxAgents} mid-turn)`) : `agent slot: none (${agentBusyReasons(p).join('; ')})`;
    return `- ${p.id}${tags.length ? ` [${tags.join('; ')}]` : ''}: ${verdict}: ${loadPart(p)}; ${agent}`;
  });
  const next = preferLine(places, last, prefs);
  const how = prefer.length || avoid.size || hold.size ? `placement.prefer first, avoided last${hold.size ? ', held never' : ''}, the rest spread by room` : 'game-repo work is spread by room';
  return [`## Capacity (${how}; docs/machines.md, "Placing work")`, ...lines, ...(next ? [next] : []), nonGameLine(places, last, prefs)];
}

/**
 * What may keep new work on a computer that is not the next one (w467, change 13: no longer BEAST's own paths, which
 * the portal VM does not have). `reviewRoot`: the review folder where the portal runs.
 */
export const pinnedWork = (reviewRoot?: string) =>
  `the review folder${reviewRoot ? ` (${reviewRoot})` : ''}, ssh to the M5 from a computer that has its key, a brief that pins it`;

/**
 * A note for start_agent or create_sandbox when the computer it places new work on is not the one pickComputer names,
 * or undefined. A soft hint: the work may need this computer (pinnedWork), and a worker
 * going on in its own sandbox stays there.
 */
export function placementHint(target: string, places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}, reviewRoot?: string, kind: NeedKind = 'game'): string | undefined {
  const here = places.find((p) => p.id === target);
  if (!here) return undefined;
  const p = pickComputer(places, last, prefs, kind);
  if (!p || p.pick.id === target) return undefined;
  const avoided = avoidOf(prefs).get(target);
  const held = holdOf(prefs).get(target);
  const busy = (kind === 'game' ? busyReasons(here) : agentBusyReasons(here)).filter((w) => w !== 'offline');
  const state = held ? `${target} is held (${held})` : avoided ? `${target} is avoided (${avoided})` : busy.length ? `${target} is busy (${busy.join('; ')})` : `${target} has ${pctOf(roomFor(here, kind))} room`;
  return ` Note: ${state}; the next new ${kind === 'game' ? 'game-repo' : 'non-game'} work goes to ${p.pick.id} (${p.why}; ${loadPart(p.pick)}). Unless this work needs ${target} (${pinnedWork(reviewRoot)}, or a worker going on in its own sandbox), put it there.`;
}

/** The computers with room for `kind` of work in a RoomNow: the one place the two kinds are told apart. */
export const roomIds = (r: RoomNow, kind: NeedKind): string[] => (kind === 'game' ? r.game : r.agent);

import type { BenchLock, BenchQueueReport, WorkPriority } from '../shared/types.ts';
import { admitsPriority, minPriorityText, MIN_PRIORITIES, reservedText, type MinPriority, type ReservedRoom } from '../shared/capacity.ts';

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
  /**
   * Whether work placed here may push a change to .github/workflows (w1463): its machine's gh login has the `workflow` scope
   * (true), lacks it (false), or nobody knows (undefined: no report, or a fine-grained login). For one person's work, a vault
   * GitHub token given there (machines.githubFromVault, docs/vault.md section 13) counts as true.
   */
  workflows?: boolean;
  /** Its gh login as the notes name it ("bryding (gist, read:org, repo)"; shared/ghLogin.ts ghLoginLabel). */
  gh?: string;
  /**
   * Its bench lock while a timed run holds it (w1600, MachineStats.benchLock): who holds it and since when. A Live view editor
   * started meanwhile would spoil that run's numbers, so a worker with Live view work waits for it before it starts one.
   */
  benchLock?: BenchLock;
  /** The timed legs in its bench queue, running or waiting (w1628, MachineStats.benchQueue): a release build goes elsewhere. */
  benchQueue?: BenchQueueReport;
  /** Its platform (win32, darwin, linux): timed work that names one stays on it (w1628). */
  platform?: string;
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
  /**
   * Where work that needs a Live view goes first (w1600), machine ids in order: config placement.live, else DEFAULT_LIVE.
   * Those without room, held or avoided are skipped, and the rest of the work's placement is the general one.
   */
  live?: string[];
  /**
   * Where game builds run first (w1606), machine ids in order: config placement.build, else DEFAULT_BUILD. Work that builds
   * a player goes there first like Live view work, and a build declared coming there clears it (server/buildPlans.ts).
   */
  build?: string[];
  /**
   * Machine id to the lowest priority of work placed there (w1643, config placement.minPriority; lothsahn: "If normal (all
   * work), if high, high and urgent, if urgent, urgent only"). For work below it the computer is held (holdOf): never picked,
   * not even when nothing else has room, so that work waits Queued. The workers already there and their resumes are not
   * touched (holdReason reads only `hold`).
   */
  minPriority?: Record<string, MinPriority>;
  /**
   * The priority of the work being placed, as its request has it now (w1643): what minPriority is held against. Unset is
   * normal, which is also what the Capacity block's "Next" lines are for.
   */
  priority?: WorkPriority;
}

const ORDER: readonly WorkPriority[] = ['low', 'normal', 'high', 'urgent'];

/** The lowest priority among `work` (what a move must let in, w1643), or undefined for none. */
export const lowestPriority = (work: readonly { priority: WorkPriority }[]): WorkPriority | undefined =>
  work.reduce<WorkPriority | undefined>((a, w) => (a === undefined || ORDER.indexOf(w.priority) < ORDER.indexOf(a) ? w.priority : a), undefined);

/** The placement settings for work of `priority` (w1643): the same, with the priority minPriority is read against. */
export const forPriority = (prefs: PlacementPrefs, priority: WorkPriority | undefined): PlacementPrefs => (priority ? { ...prefs, priority } : prefs);

/** The computers reserved for higher work (placement.minPriority above normal), id to its lowest priority. */
export const minOf = (prefs: PlacementPrefs) =>
  new Map(Object.entries(prefs.minPriority ?? {}).filter(([, v]) => MIN_PRIORITIES.includes(v) && v !== 'normal').map(([k, v]) => [placeId(k), v]));

/** "reserved for urgent work only (placement.minPriority urgent; this work is normal)": why `id` takes no work of `priority`, or undefined. */
export function reservedReason(id: string, prefs: PlacementPrefs, priority = prefs.priority): string | undefined {
  const min = minOf(prefs).get(placeId(id));
  if (!min || admitsPriority(min, priority)) return undefined;
  return `reserved for ${minPriorityText(min)} (placement.minPriority ${min}; this work is ${priority ?? 'normal'})`;
}

/**
 * Where Live view work goes when config placement.live is not set (w1600). Ben, 2026-10-19: "can you prioritize beast for
 * stuff that needs live view? live view is often too slow" (the w1466 Siege Carapace view ran at about 3 fps on lothdesktop).
 */
export const DEFAULT_LIVE = ['beast'];

/** The computers Live view work tries first, in order (placement.live, else DEFAULT_LIVE). */
export const liveOf = (prefs: PlacementPrefs): string[] => (prefs.live?.length ? prefs.live : DEFAULT_LIVE).map(placeId);

/**
 * Where an urgent release builds when config placement.build is not set (w1606; w1639). Ben, 2026-10-20: "when you know
 * builds are coming up, we also prioritize using beast for builds because its faster"; lothsahn, 2026-10-20 (w1639): "a
 * quick or urgent release (beast, if offline, LothDesktop)". The first ONLINE one in order: an offline computer is
 * skipped, a busy one is cleared for it (build_plan), never passed over.
 */
export const DEFAULT_BUILD = ['beast', 'lothdesktop'];

/** The computers builds try first, in order (placement.build, else DEFAULT_BUILD). */
export const buildOf = (prefs: PlacementPrefs): string[] => (prefs.build?.length ? prefs.build : DEFAULT_BUILD).map(placeId);

/** Timed work (w1628, shared/capacity.ts needsTimed): on any platform, or on the one its words name. */
export type TimedKind = 'timed' | 'timed:win32' | 'timed:darwin';

/** Work placed on a first list before the general placement: a Live view (w1600), a release build (w1606), timed work (w1628). */
export type FirstKind = 'live' | 'build' | TimedKind;

const FIRST: Record<'live' | 'build', { of: (p: PlacementPrefs) => string[]; key: string; label: string; why: string }> = {
  live: { of: liveOf, key: 'placement.live', label: 'Live view work', why: 'w1600: Live views stream fastest there' },
  build: { of: buildOf, key: 'placement.build', label: 'Urgent release work', why: 'w1639: "beast, if offline, LothDesktop"' },
};

/**
 * Where timed work goes (w1628). lothsahn, 2026-10-20: "We should also prefer boxes with a small number of slots and
 * players for timed runs, not beast since it's big". Among the computers with room, not held or avoided, and on the
 * platform its words name: first those with no timed leg in their bench queue (a leg queued behind another waits, while
 * a computer with none runs it at once), then the smallest (fewest sandboxes, then fewest Unity processes: less else runs
 * beside the leg), then the fewest live agents. A timed A/B compares its legs on one computer, so a slower one gives as
 * good an answer; work whose absolute numbers must come from one computer names it, and the dispatcher keeps it there.
 * Undefined when none has room: the general placement then.
 */
export function pickTimed(places: readonly Computer[], prefs: PlacementPrefs, t: TimedKind): { pick: Computer; why: string } | undefined {
  const platform = t === 'timed' ? undefined : t.slice(6);
  const hold = holdOf(prefs);
  const avoid = avoidOf(prefs);
  const ok = places.filter((p) => hasRoom(p) && !hold.has(p.id) && !avoid.has(p.id) && (!platform || p.platform === platform));
  if (!ok.length) return undefined;
  const queued = (p: Computer) => p.benchQueue?.timed ?? 0;
  const key = (p: Computer) => [queued(p) ? 1 : 0, p.maxSandboxes, p.editors ?? 0, queued(p), p.live];
  const sorted = [...ok].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const p = sorted[0];
  const size = `${p.maxSandboxes} sandboxes, ${p.editors ?? 0} Unity processes, ${p.live} live agents`;
  const q = queued(p) ? `every one with room ${platform ? `on ${platform} ` : ''}has timed runs queued; this one fewest (${queued(p)})` : 'no timed run queued there';
  return { pick: p, why: `timed work goes to the smallest computer with room${platform ? ` on ${platform}` : ''} (w1628, lothsahn: "prefer boxes with a small number of slots and players for timed runs, not beast"): ${q}; ${size}` };
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
  /**
   * Computers with room that placement.minPriority reserves for higher work (w1643), with their lowest priority: not in `game`
   * or `agent`, which are for low and normal work; roomIds adds those a request's priority reaches.
   */
  reserved?: ReservedRoom[];
  /** Each computer with room, id to its numbers at this moment: a log line of a flag explains itself when it is read hours later. */
  detail?: Record<string, string>;
}

/** The holds a person or FF Factory set (placement.hold, paused machines, coming builds): they also stop resumes there. */
const holdOnly = (prefs: PlacementPrefs) => new Map(Object.entries(prefs.hold ?? {}).map(([k, v]) => [placeId(k), v]));

/**
 * The computers new work of prefs.priority may not go to, id to why: the holds, and those placement.minPriority reserves for
 * higher work (w1643). A reservation is a hold for the work below it, not an avoid: it never overflows when nothing else has
 * room, since a reservation that overflows reserves nothing.
 */
const holdOf = (prefs: PlacementPrefs) => {
  const out = holdOnly(prefs);
  for (const id of minOf(prefs).keys()) {
    const why = out.has(id) ? undefined : reservedReason(id, prefs);
    if (why) out.set(id, why);
  }
  return out;
};

export function roomNow(places: readonly Computer[], prefs: PlacementPrefs = {}): RoomNow {
  const hold = holdOnly(prefs);
  const min = minOf(prefs);
  const out: RoomNow = { game: [], agent: [], held: [], reserved: [], detail: {} };
  for (const p of places) {
    const kinds = (['game', 'agent'] as const).filter((k) => hasRoomFor(p, k));
    if (!kinds.length) continue;
    out.detail![p.id] = `${p.freeSandboxes} of ${p.maxSandboxes} sandboxes free, ${p.live} live agents of ${p.maxAgents}, ${memPct(p) !== undefined ? `RAM ${memPct(p)}%` : 'RAM unknown'}`;
    const why = hold.get(p.id);
    if (why !== undefined) {
      out.held.push({ id: p.id, why, for: kinds });
      continue;
    }
    const m = min.get(p.id);
    if (m) {
      out.reserved!.push({ id: p.id, min: m, for: kinds });
      continue;
    }
    for (const k of kinds) out[k].push(p.id);
  }
  return out;
}

/**
 * Why the computer `id` takes no work now: its hold (prefs.hold, w1089) with who and why, or undefined. For a message to an
 * agent already on it (w1376): a hold also stops resumes there, not only new placements.
 */
export function holdReason(id: string, prefs: PlacementPrefs = {}): string | undefined {
  // Not placement.minPriority (w1643): a worker already there goes on, whatever its request's priority.
  const why = holdOnly(prefs).get(placeId(id));
  if (why === undefined) return undefined;
  // A machine paused from its tray app (w1532, server/machinePause.ts) is held the same way until it runs again.
  if (why.startsWith('paused from its tray app')) return `${id} is ${why}: nothing resumes there until it runs again (its tray's Unpause, its schedule, or 90 minutes without input)`;
  return `${id} is on hold (${why}): nothing resumes there until the hold is lifted (placement.hold)`;
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
export function pickComputer(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}, kind: NeedKind = 'game', workflows = false, live: boolean | FirstKind = false): { pick: Computer; why: string } | undefined {
  const firstKind: FirstKind | undefined = live === true ? 'live' : live || undefined;
  if (firstKind?.startsWith('timed') && kind === 'game') {
    const t = pickTimed(places, prefs, firstKind as TimedKind);
    if (t) return t;
    const rest = pickComputer(places, last, prefs, kind, workflows);
    return rest && { pick: rest.pick, why: `timed work, but no computer${firstKind === 'timed' ? '' : ` on ${firstKind.slice(6)}`} has room; so the general placement: ${rest.why}` };
  }
  if ((firstKind === 'live' || firstKind === 'build') && kind === 'game') {
    // Work that needs a Live view (w1600) or builds a player (w1606): the first computer in its list with room, else the general placement.
    const f = FIRST[firstKind];
    const first = f.of(prefs);
    const hold = holdOf(prefs);
    const avoid = avoidOf(prefs);
    const skipped: string[] = [];
    // An urgent release is never passed over for a timed leg in a bench queue (w1639; w1628 sent release builds elsewhere
    // meanwhile): its exclusive tickets at the request's urgent priority go first, after the leg running now.
    for (const id of first) {
      const p = places.find((x) => x.id === id);
      if (!p) skipped.push(`${id} is not a computer here`);
      else if (hold.has(id)) skipped.push(`${id} is held (${hold.get(id)})`);
      else if (avoid.has(id)) skipped.push(`${id} is avoided (${avoid.get(id)})`);
      else if (!hasRoom(p)) skipped.push(`${id} is busy (${busyReasons(p).join('; ')})${firstKind === 'build' && p.online ? ': an urgent release clears it first (build_plan coming with its work_id), then goes there' : ''}`);
      else return { pick: p, why: `${f.label} goes to the first with room in ${f.key} (${first.join(' > ')}; ${f.why})${p.benchQueue && firstKind === 'build' ? `; it ${timedText(p.benchQueue)}: the release's exclusive tickets go first after the leg running now` : ''}${p.benchLock ? `; ${benchText(p.benchLock)}: its worker waits for it before it starts its ${firstKind === 'live' ? 'editor' : 'build'}` : ''}` };
    }
    const rest = pickComputer(places, last, prefs, kind, workflows);
    return rest && { pick: rest.pick, why: `${f.label}, but ${skipped.join(', ')}; so the general placement: ${rest.why}` };
  }
  if (workflows) {
    // Work that changes .github/workflows (w1463): first among the computers whose gh may push it, then as any other work.
    const able = places.filter((p) => p.workflows === true);
    const p = pickComputer(able, last, prefs, kind);
    if (p) return { pick: p.pick, why: `its gh token may push .github/workflows (w1463); ${p.why}` };
    const rest = pickComputer(places, last, prefs, kind);
    if (!rest) return undefined;
    const none = able.length ? `every computer whose gh may push .github/workflows (${able.map((x) => x.id).join(', ')}) is busy or held` : 'no computer reports a gh token with the workflow scope';
    return { pick: rest.pick, why: `${none}, so its workflow push must go from elsewhere; ${rest.why}` };
  }
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
  return `${p.live} live agents of ${p.maxAgents} (${p.midTurn} mid-turn); ${p.freeSandboxes} of ${p.maxSandboxes} sandboxes free${p.sandboxes < p.maxSandboxes ? ` (${p.maxSandboxes - p.sandboxes} more can be made)` : ''}${ram}${p.maxEditors ? `; editors ${p.editors ?? 0} of ${p.maxEditors}${p.editorsDetail ? `: ${p.editorsDetail}` : ''}` : ''}${p.voiceVramMiB ? `; Whisper holds ~${(p.voiceVramMiB / 1024).toFixed(1)} GB VRAM (unloaded for the editors when VRAM runs short)` : ''}${p.resumesWaiting ? `; ${p.resumesWaiting} released worker(s) wait to resume there and take the next sandbox that frees` : ''}${p.benchLock ? `; ${benchText(p.benchLock)}` : ''}`;
};

/** "has 2 timed runs in its bench queue (the first: probe A round 3)" (w1628). */
export const timedText = (q: BenchQueueReport) => `has ${q.timed} timed run${q.timed === 1 ? '' : 's'} in its bench queue, running or waiting${q.first ? ` (the first: ${q.first})` : ''}`;

/** "its bench lock is held since 21:04Z (beast pid 4121 ... probe A round 2)": a timed run there (w1600). */
export const benchText = (b: BenchLock) => `its bench lock is held since ${b.since.slice(11, 16)}Z (${b.owner.slice(0, 160)}): a timed run`;

/** Where the next piece of game-repo work should go, in a line, or undefined with fewer than two computers. */
export function preferLine(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string | undefined {
  if (places.length < 2) return undefined;
  const p = pickComputer(places, last, prefs);
  if (!p) return `No computer has room for new work now${heldNote(places, prefs, 'game')}.`;
  return `Next new game-repo work: ${p.pick.id} (${p.why}).`;
}

/** " (m5 has room but is held (Ben testing))": the computers with room that a hold keeps off. */
function heldNote(places: readonly Computer[], prefs: PlacementPrefs, kind: NeedKind): string {
  const r = roomNow(places, prefs);
  const text = [heldText(r.held, kind), reservedText(r.reserved, kind, prefs.priority)].filter(Boolean).join('; ');
  return text ? ` (${text})` : '';
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

/**
 * Where the next piece of work that needs a Live view goes (w1600): game work whose worker streams its sandbox editor's game
 * to a person (docs/live-view.md), first on placement.live (DEFAULT_LIVE), else as other game work. Undefined with fewer
 * than two computers, like preferLine.
 */
export function liveLine(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string | undefined {
  if (places.length < 2) return undefined;
  const p = pickComputer(places, last, prefs, 'game', false, true);
  if (!p) return `No computer has room for Live view work now${heldNote(places, prefs, 'game')}.`;
  return `Next Live view work (game work whose worker streams a Live view, w1600): ${p.pick.id} (${p.why}).`;
}

/**
 * Where the next piece of work that builds a player goes (w1606): first on placement.build (DEFAULT_BUILD), else as other
 * game work. Undefined with fewer than two computers, like preferLine.
 */
/** Where the next timed work goes (w1628), or undefined with fewer than two computers. */
export function timedLine(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string | undefined {
  if (places.length < 2) return undefined;
  const p = pickComputer(places, last, prefs, 'game', false, 'timed');
  if (!p) return `No computer has room for timed work now${heldNote(places, prefs, 'game')}.`;
  return `Next timed work (benchmarks, perf A/Bs and probes; on the platform it names, w1628): ${p.pick.id} (${p.why}).`;
}

export function buildLine(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string | undefined {
  if (places.length < 2) return undefined;
  const p = pickComputer(places, last, prefs, 'game', false, 'build');
  if (!p) return `No computer has room for urgent release work now${heldNote(places, prefs, 'game')}.`;
  return `Next urgent release work (a quick or urgent release, w1639; a normal release is FFBox's and needs none): ${p.pick.id} (${p.why}).`;
}

/**
 * Where the next piece of work that changes .github/workflows goes (w1463: four pushes of a workflow file were refused for a
 * machine's gh token without the `workflow` scope), and each computer's gh login; undefined when no daemon reported one yet.
 * Such work needs no editor, so it is placed by agent slot; a game request that also changes a workflow file is noted at start_agent.
 */
export function workflowLine(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string | undefined {
  if (!places.some((p) => p.gh)) return undefined;
  const p = pickComputer(places, last, prefs, 'agent', true);
  const each = places.map((x) => `${x.id} ${x.gh ?? 'not reported'}: ${x.workflows === true ? 'yes' : x.workflows === false ? 'no' : 'unknown'}`).join('; ');
  return `Next work that changes .github/workflows (its push needs a gh token with the workflow scope, w1463): ${p ? `${p.pick.id} (${p.why})` : 'no computer has an agent slot now'}. Each computer's gh login may push it: ${each}. A person's vault GitHub token, where machines.githubFromVault is on, takes the login's place for their work.`;
}

/** The capacity block list_sandboxes and system_status start with: one line per computer, then where the next goes. */
export function capacityLines(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string[] {
  if (!places.length) return [];
  const avoid = avoidOf(prefs);
  const hold = holdOnly(prefs);
  const min = minOf(prefs);
  const prefer = (prefs.prefer ?? []).map(placeId);
  const lines = places.map((p) => {
    const why = busyReasons(p);
    const m = min.get(p.id);
    const tags = [...(prefer.includes(p.id) ? [`preferred #${prefer.indexOf(p.id) + 1}`] : []), ...(avoid.has(p.id) ? [`avoided: ${avoid.get(p.id)}`] : []), ...(hold.has(p.id) ? [`held: ${hold.get(p.id)}`] : []), ...(m ? [`reserved: ${minPriorityText(m)}`] : [])];
    // A reservation (w1643) after a hold: a held computer takes nothing, whatever its level.
    const reserved = m ? ` but RESERVED for ${minPriorityText(m)} (placement.minPriority ${m}): ${m === 'urgent' ? 'low, normal and high' : 'low and normal'} work does not go there` : '';
    const verdict = why.length ? `BUSY (${why.join('; ')})` : hold.has(p.id) ? `ROOM ${pctOf(roomOf(p))} but HELD (${hold.get(p.id)}): no new work goes there` : `ROOM ${pctOf(roomOf(p))}${reserved}`;
    // Agent room for non-game work (w1098), beside the game verdict: the dispatcher reads both from the one line.
    const agent = hasAgentRoom(p) ? (hold.has(p.id) ? 'agent slot: free but held' : `agent slot: free (${p.midTurn} of ${p.maxAgents} mid-turn)${m ? `, ${minPriorityText(m)}` : ''}`) : `agent slot: none (${agentBusyReasons(p).join('; ')})`;
    return `- ${p.id}${tags.length ? ` [${tags.join('; ')}]` : ''}: ${verdict}: ${loadPart(p)}; ${agent}`;
  });
  // The "Next" lines are for low and normal work (prefs.priority unset); reservedLine says where higher work goes.
  const base = { ...prefs, priority: undefined };
  const next = preferLine(places, last, base);
  const how = prefer.length || avoid.size || hold.size || min.size ? `placement.prefer first, avoided last${hold.size ? ', held never' : ''}${min.size ? ', reserved only for the work they take' : ''}, the rest spread by room` : 'game-repo work is spread by room';
  const wf = workflowLine(places, last, base);
  const live = liveLine(places, last, base);
  const build = buildLine(places, last, base);
  const timed = timedLine(places, last, base);
  const reserved = reservedLine(places, last, base);
  return [`## Capacity (${how}; docs/machines.md, "Placing work")`, ...lines, ...(next ? [next] : []), ...(live ? [live] : []), ...(build ? [build] : []), ...(timed ? [timed] : []), nonGameLine(places, last, base), ...(wf ? [wf] : []), ...(reserved ? [reserved] : [])];
}

/**
 * Where higher work goes while placement.minPriority reserves computers for it (w1643), or undefined when none is: the Next
 * lines above it are for low and normal work. One part per level a reservation lets in, game and non-game.
 */
export function reservedLine(places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}): string | undefined {
  const min = minOf(prefs);
  if (!min.size) return undefined;
  const who = [...min].map(([id, m]) => `${id} ${minPriorityText(m)}`).join(', ');
  const levels = (['high', 'urgent'] as const).filter((lv) => [...min.values()].some((m) => admitsPriority(m, lv)));
  const at = (lv: WorkPriority, kind: NeedKind) => {
    const p = pickComputer(places, last, forPriority(prefs, lv), kind);
    return p ? `${p.pick.id} (${p.why})` : 'no computer has room now';
  };
  const parts = levels.map((lv) => `${lv} work: game ${at(lv, 'game')}; non-game ${at(lv, 'agent')}`);
  return `Reserved by priority (placement.minPriority, w1643): ${who}. The Next lines above are for low and normal work; work below a computer's level waits Queued rather than go there, and a request raised to the level may go at once. Next ${parts.join('. Next ')}.`;
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
export function placementHint(target: string, places: readonly Computer[], last?: string, prefs: PlacementPrefs = {}, reviewRoot?: string, kind: NeedKind = 'game', workflows = false, live: boolean | FirstKind = false): string | undefined {
  const here = places.find((p) => p.id === target);
  if (!here) return undefined;
  const p = pickComputer(places, last, prefs, kind, workflows, live);
  // Work that changes .github/workflows on a computer whose gh may not push it (w1463): said even when nothing better has room.
  if (workflows && here.workflows !== true) {
    const lacks = here.workflows === false ? 'lacks the workflow scope, so GitHub will refuse its push of a workflow file' : 'may not be able to push a workflow file (its scopes are unknown)';
    const better = p && p.pick.id !== target && p.pick.workflows === true ? `; ${p.pick.id}'s gh may push it (${p.pick.gh ?? '?'}; ${p.why}): put this work there unless it needs ${target}` : '; no computer whose gh may push it has room now: the worker pushes the rest and hands the workflow file on (its brief says so)';
    return ` Note: this work changes .github/workflows, and ${target}'s gh token (${here.gh ?? 'not reported yet'}) ${lacks}${better}.`;
  }
  if (!p || p.pick.id === target) return undefined;
  const avoided = avoidOf(prefs).get(target);
  const held = holdOf(prefs).get(target);
  const busy = (kind === 'game' ? busyReasons(here) : agentBusyReasons(here)).filter((w) => w !== 'offline');
  const state = held ? `${target} is held (${held})` : avoided ? `${target} is avoided (${avoided})` : busy.length ? `${target} is busy (${busy.join('; ')})` : `${target} has ${pctOf(roomFor(here, kind))} room`;
  return ` Note: ${state}; the next new ${live && kind === 'game' ? (live === 'build' ? 'urgent release' : live === true || live === 'live' ? 'Live view' : 'timed') : kind === 'game' ? 'game-repo' : 'non-game'} work goes to ${p.pick.id} (${p.why}; ${loadPart(p.pick)}). Unless this work needs ${target} (${pinnedWork(reviewRoot)}, or a worker going on in its own sandbox), put it there.`;
}

/** The computers with room for `kind` of work in a RoomNow: the one place the two kinds are told apart. */
export const roomIds = (r: RoomNow, kind: NeedKind, priority?: WorkPriority): string[] => [
  ...(kind === 'game' ? r.game : r.agent),
  // The reserved computers (w1643) the request's priority now reaches.
  ...(r.reserved ?? []).filter((x) => x.for.includes(kind) && admitsPriority(x.min, priority)).map((x) => x.id),
];

/** The held and reserved computers with room that work of `kind` and `priority` may not use, as a Queued reason says them. */
export const unusableText = (r: RoomNow, kind: NeedKind, priority?: WorkPriority): string =>
  [heldText(r.held, kind), reservedText(r.reserved, kind, priority, kind === 'agent' ? 'an agent slot' : 'room')].filter(Boolean).join('; ');

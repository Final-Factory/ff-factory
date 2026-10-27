// Capacity waits and what work needs of a computer (w1089, w1098). Pure, shared by the server and the page.
//
// w1089 (lothsahn: "I see a number of items that are blocked waiting on sandboxes, but they're all in use. These should be in
// a queued state, not blocked."): on 2026-10-12 the dispatcher put w1084 to w1088 into "blocked on 04:35/04:40/04:45/04:50/
// 04:55 UTC (a free sandbox: all in use except the m5's (Ben testing))", a made-up time for a wait that is only capacity.
// Capacity is Queued, never Blocked (docs/orchestrators.md, "Waiting, Queued, Blocked"): capacityWaitIn recognises such a
// wait in the words a blocker is given, so the server refuses the block and says to queue it.
//
// w1098 (lothsahn, 2026-10-12: "FFBox and FF Factory updates don't need unity editors"): work on a repository that is not
// the game's needs only an agent slot, not a free game sandbox, an editor or RAM for Unity. needsOf says which a request is.
import type { WorkItem, WorkPair } from './types.ts';

/**
 * Words that say a request waits for room: "a free sandbox", "all in use", "no free slot", "waiting for an editor",
 * "RAM below 85%", "until capacity frees". Deliberately about the wait, not the nouns alone: a request named "sandbox
 * cleanup" or "w633's editor fix" is not a capacity wait.
 */
const NOUN = '(?:sandbox(?:es)?|slots?|editors?|agent slots?|agent cap|capacity|room|ram|memory|machines?|computers?|places?)';
const CAPACITY_WAIT: readonly RegExp[] = [
  new RegExp(`\\b(?:free|open|empty|spare|available|vacant)\\s+${NOUN}\\b`, 'i'),
  new RegExp(`\\b(?:no|any|until|when|once|while)\\s+(?:a\\s+|an\\s+|the\\s+|more\\s+)?(?:\\w+\\s+)?${NOUN}\\s+(?:is|are|becomes?|frees?|free up|frees up|opens?|available|free|full|busy)\\b`, 'i'),
  new RegExp(`\\b(?:wait(?:s|ing)?|queue[ds]?|held|blocked)\\s+(?:for|on|until)\\s+(?:a\\s+|an\\s+|the\\s+|any\\s+)?(?:free\\s+)?${NOUN}\\b`, 'i'),
  /\b(?:all|every)\s+(?:\w+\s+){0,3}(?:in use|busy|taken|occupied|full)\b/i,
  /\bno\s+(?:free|room|capacity|place|seat)\b/i,
  /\bagent cap\b/i,
  /\bram\b.{0,30}(?:\b\d{2}\s?%|\b(?:above|over|below|under|drops?|high)\b)/i,
];

/** Whether `text` says the request waits for capacity (a free sandbox, slot, editor, RAM or computer). */
export function capacityWaitIn(text: string | undefined): boolean {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return !!t && CAPACITY_WAIT.some((re) => re.test(t));
}

/**
 * Why a blocker cannot be a capacity wait, or undefined. The same words for decide_work block and a worker's blocked_on, so
 * neither can put Queued work into Blocked. \`who\` says what to do instead.
 */
export function capacityBlockProblem(text: string | undefined, who: 'dispatcher' | 'worker'): string | undefined {
  if (!capacityWaitIn(text)) return undefined;
  return who === 'dispatcher'
    ? `"${(text ?? '').trim().slice(0, 120)}" is a wait for capacity (a free sandbox, slot, editor, RAM or computer), and that is Queued, never Blocked on a time or a thing: use decide_work queue (needs: the computers that can take it, when only some can). The queue places it on the first place that frees, in order; it is not a time you can guess. A computer with room that is held for someone (config placement.hold) is named in the Queued reason by itself.`
    : `"${(text ?? '').trim().slice(0, 120)}" is a wait for capacity (a free sandbox, slot, editor or RAM). That is Queued, not Blocked, and FF Factory queues it by itself: a message to you waits in the send queue for a free place and the ledger shows Queued. Do not call blocked_on for it, and do not poll with wake_me: end your turn with your report. blocked_on is for other requests, pull requests and deploys.`;
}

/** Whether `repo` ("owner/name" or a github.com link) is the game's repository, by its name. */
export function isGameRepo(repo: string, gameRepo: string | undefined): boolean {
  const norm = (x: string) => x.trim().toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  // No GitHub slug for the game repo (a local path in a test or a new install): the game's own name still counts.
  return gameRepo ? norm(repo) === norm(gameRepo) : /(^|\/)finalfactory$/.test(norm(repo));
}

const NON_GAME = /\bff-?factory\b|\bffbox\b|\bff-agents\b|\bfinal-factory-agents\b|\bfinalfactory-agent-kit\b|\bagent-kit\b/i;
const GAME = /\bFinalFactory\b|\bUnity\b|\.cs\b|\bprefabs?\b|\bshaders?\b|\bscenes?\b|\bplaytest|\bbuilt player\b|\bsimulation\b|\bDOTS\b|\bspecs?[ /]\d{3}/i;

/**
 * What a request needs (w1098): \`needs\` as given, else from \`repo\` (the game's repository: game; any other: agent), else a
 * guess from the title and the start of the brief: a non-game repository named and no game word (Unity, a scene, a shader,
 * the game repo, a spec) means agent; anything else game, the stricter. Decided once, when it is filed, and stored.
 */
export function resolveNeeds(o: { needs?: 'game' | 'agent'; repo?: string; title: string; brief: string }, gameRepo: string | undefined): { needs: 'game' | 'agent'; how: string } {
  if (o.needs) return { needs: o.needs, how: `needs ${o.needs} as filed` };
  if (o.repo) return isGameRepo(o.repo, gameRepo) ? { needs: 'game', how: `the game repo ${o.repo}` } : { needs: 'agent', how: `repo ${o.repo}, not the game's` };
  const text = `${o.title}\n${o.brief.slice(0, 400)}`;
  if (NON_GAME.test(text) && !GAME.test(text)) return { needs: 'agent', how: 'guessed from its title and brief: a non-game repository, no game word' };
  return { needs: 'game', how: 'no repo given: the game, the stricter default' };
}

/** What a request needs of a computer: its stored `needs`, game when absent. */
export const needsOf = (w: Pick<WorkItem, 'needs'>): 'game' | 'agent' => w.needs ?? 'game';

/** A Live view named in words (w1600): "Live view", "live-view", "liveview", any case. */
export const LIVE_VIEW_WORDS = /\blive[ -]?view\b/i;

/**
 * Whether a request needs a Live view (w1600, Ben: "can you prioritize beast for stuff that needs live view? live view is
 * often too slow"): game work (never work that needs only an agent slot) whose worker started one (`liveView`), or whose
 * title, brief or people's notes ask for one ("i want live view", w1468), or `text` does (a dispatcher's brief).
 */
export function needsLive(w: Pick<WorkItem, 'needs' | 'liveView' | 'title' | 'brief' | 'notes'> | undefined, text = ''): boolean {
  if (w && needsOf(w) === 'agent') return false;
  if (w?.liveView) return true;
  return LIVE_VIEW_WORDS.test(`${w ? `${w.title}\n${w.brief}\n${(w.notes ?? []).map((n) => n.text).join('\n')}\n` : ''}${text}`);
}

/**
 * An URGENT release named in words (w1639): "quick release", "urgent release", "urgent build", the urgent release lane or
 * its script. lothsahn, 2026-10-20: "Release builds should be handed by ffbox. We should update the version and just let
 * ffbox build it ... If we need an urgent build, we should be able to ask beast or Lothdesktop to build it for us ...
 * Then Ben and I can ask for a release (ffbox) or a quick or urgent release (beast, if offline, LothDesktop)". So a
 * normal release ("release build", "ci-release") is FFBox's and builds nothing on these computers: it is not build work
 * here, and only the urgent lane's is. (Until w1639, w1606 and w1628 placed every named release build here; a worker's
 * own player build, a fix, a clip, a playtest or MP check, never was: w1628.)
 */
export const URGENT_RELEASE_WORDS = /\b(?:quick|urgent)\s+(?:dev\s+)?(?:release|build)s?\b|\burgent[- ]release\b|\burgent_release\.py\b/i;
/** Build work's words: since w1639 the urgent release's only (above). */
export const BUILD_WORDS = URGENT_RELEASE_WORDS;

/**
 * Whether a request makes a release build on an FF Factory computer (w1606, Ben: "when you know builds are coming up, we
 * also prioritize using beast for builds because its faster"; release builds only since w1628; the urgent lane's only since
 * w1639): game work whose worker declared a release build (`build`), or whose title, brief or people's notes ask for a quick
 * or urgent release, or `text` does (a dispatcher's brief).
 */
export function needsBuild(w: Pick<WorkItem, 'needs' | 'build' | 'title' | 'brief' | 'notes'> | undefined, text = ''): boolean {
  if (w && needsOf(w) === 'agent') return false;
  if (w?.build) return true;
  return BUILD_WORDS.test(`${w ? `${w.title}\n${w.brief}\n${(w.notes ?? []).map((n) => n.text).join('\n')}\n` : ''}${text}`);
}

/**
 * Timed work named in words (w1628): a benchmark, a perf A/B or probe, a timed run or leg, frame times. Not "fps" alone
 * (60 fps clips are visual work) and not a bare "performance".
 */
// w2277: profiling, p99 frames and FPS drops or before/after are timed work too (w2257 and w2265 were p99 and FPS-drop profiling).
export const TIMED_WORDS = /\b(?:bench(?:mark)?(?:s|ed|ing)?|perf (?:a\/b|probe|test|run|fix|regression)s?|performance (?:a\/b|probe|test|run|regression|fix)s?|timed (?:runs?|legs?|a\/b)|timing (?:runs?|legs?)|exclusive (?:bench )?(?:locks?|tickets?)|probe_ab\w*|frame ?times?|a\/b (?:runs?|test|legs?)|profil(?:ing|er captures?)|profile (?:it|and fix|the (?:save|frames?|fps))|p(?:95|99)s?(?: frames?)?|fps (?:drops?|regressions?|before\/after|a\/b|probes?)|drops? (?:the )?fps|before\/after (?:fps|frames?|timings?))\b/i;

// A clause's last words that rule the timed word after them out ("no bench lock", "without a benchmark", "not a timed run").
const NEGATED_BEFORE = /(?:\b(?:no|without|never|nor|none)\b(?:\s+\S+){0,3}|\bnot(?:\s+(?:a|an|any|the))?)\s*$/i;
// Words after it that do ("bench lock not needed", "a benchmark isn't required").
const NEGATED_AFTER = /^[^.;:,!?\n]{0,25}?(?:\bnot|n't)\s+(?:needed|required|necessary|wanted)\b/i;

/**
 * Whether `text` names timed work (TIMED_WORDS) other than to rule it out (w1872): w1900's "Constraints: no timing work,
 * so no bench lock needed" kept a correctness hunt off the free m5. A mention counts unless its own clause (back to a
 * comma or a stop) negates it just before, or says it is not needed just after.
 */
export function timedMention(text: string): boolean {
  for (const m of text.matchAll(new RegExp(TIMED_WORDS.source, 'gi'))) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 60), at).split(/[.;:,!?\n(]/).pop() ?? '';
    const after = text.slice(at + m[0].length, at + m[0].length + 60);
    if (!NEGATED_BEFORE.test(before) && !NEGATED_AFTER.test(after)) return true;
  }
  return false;
}

/**
 * Whether a request runs timed legs (w1628), and on what platform when its words name one: 'win32' ("Windows", "win
 * player", "probe_ab_win"), 'darwin' ("Mac"), else 'any'; false for no timed work. lothsahn, 2026-10-20: "We should also
 * prefer boxes with a small number of slots and players for timed runs, not beast since it's big" (server/placement.ts
 * pickTimed).
 */
export function needsTimed(w: Pick<WorkItem, 'needs' | 'title' | 'brief' | 'notes'> | undefined, text = ''): false | 'any' | 'win32' | 'darwin' {
  if (w && needsOf(w) === 'agent') return false;
  // Oldest first: the title and brief as filed, then people's notes in order, then `text` (a dispatcher's brief).
  const parts = [...(w ? [w.title, w.brief, ...(w.notes ?? []).map((n) => n.text)] : []), text].filter(Boolean);
  if (!timedMention(parts.join('\n'))) return false;
  // w2358: a requester's "any OS" clears what was implied before it, when nothing newer names an OS again (w2346's brief
  // cited data "Measured by w2332 on m3"; its note said "any OS. m3 is not required."). A mention that rules an OS out
  // ("m3 is not required") names none.
  for (const part of [...parts].reverse()) {
    if (ANY_OS.test(part)) return 'any';
    if (osMention(part, WIN_WORDS) || osMention(part, MAC_WORDS)) break;
  }
  const win = parts.some((p) => osMention(p, WIN_WORDS));
  const mac = parts.some((p) => osMention(p, MAC_WORDS));
  return win === mac ? 'any' : win ? 'win32' : 'darwin';
}

// w2358: words that say the timed work runs on any OS ("any OS", "whichever computer takes the timed run").
const ANY_OS = /\bany (?:os|platform|operating system)\b|\b(?:either|both) (?:os(?:es)?|platforms?)\b|\bwhichever (?:computer|machine|box)\b|\bos(?:-| )(?:agnostic|independent)\b/i;
const WIN_WORDS = /\bwindows\b|\bwin(?:64)? (?:player|build)\b|probe_ab_win|\bbeast\b|\blothdesktop\b/gi;
// Not m5 (w1872): it takes no timed runs, so a brief naming it ("queued for m5", w1789) asks for no Mac; m3 is the Mac that does.
const MAC_WORDS = /\bmac(?:os)?\b|\bm3\b/gi;

/** Whether `text` names an OS by `words` other than to rule it out ("m3 is not required", "not on the Mac"), as timedMention. */
function osMention(text: string, words: RegExp): boolean {
  for (const m of text.matchAll(words)) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 60), at).split(/[.;:,!?\n(]/).pop() ?? '';
    const after = text.slice(at + m[0].length, at + m[0].length + 60);
    if (!NEGATED_BEFORE.test(before) && !NEGATED_AFTER.test(after)) return true;
  }
  return false;
}

/**
 * The lowest priority of work a computer takes (w1643, config placement.minPriority). lothsahn, 2026-10-20: "Instead of a
 * single setting, let's make the setting the minimum priority work that can go to a machine. If normal (all work), if high,
 * high and urgent, if urgent, urgent only". normal is the default and takes low work too.
 */
export type MinPriority = 'normal' | 'high' | 'urgent';
export const MIN_PRIORITIES: readonly MinPriority[] = ['normal', 'high', 'urgent'];

/** low and normal are one level here: a computer at normal takes all work, low included. */
const LEVEL: Record<string, number> = { low: 0, normal: 0, high: 1, urgent: 2 };

/** Whether a computer whose lowest priority is `min` takes work of `priority` (a request's priority now; unknown is normal). */
export const admitsPriority = (min: MinPriority | undefined, priority: string | undefined): boolean => (LEVEL[priority ?? 'normal'] ?? 0) >= (LEVEL[min ?? 'normal'] ?? 0);

/** "high and urgent work only", "urgent work only": what a reserved computer takes. */
export const minPriorityText = (min: MinPriority): string => (min === 'urgent' ? 'urgent work only' : min === 'high' ? 'high and urgent work only' : 'all work');

/** A computer with room reserved for higher work (RoomNow.reserved, AppState.reservedRoom): its lowest priority and the kinds it has room for. */
export interface ReservedRoom {
  id: string;
  min: MinPriority;
  for: readonly ('game' | 'agent')[];
}

/** "beast has room but takes urgent work only (placement.minPriority; this is normal)": how a Queued reason names one. */
export const reservedText = (reserved: readonly ReservedRoom[] | undefined, kind: 'game' | 'agent' | undefined, priority: string | undefined, slot = 'room'): string =>
  (reserved ?? [])
    .filter((r) => (!kind || r.for.includes(kind)) && !admitsPriority(r.min, priority))
    .map((r) => `${r.id} has ${slot} but takes ${minPriorityText(r.min)} (placement.minPriority; this is ${priority ?? 'normal'})`)
    .join('; ');

/**
 * Multiplayer work that runs every peer on one computer (w1944): a nightly MP scenario ("MP-W1020-camps-settle-join",
 * "MP-tutorial-e2e-loth") reproduced with ffnightly.py starts a host and its clients side by side. A Mac refuses a
 * multiplayer client (the game repo's scripts/nightly/player_slots.py require_mac_client_ok: w665's GPU page fault hangs the
 * whole Mac), so such work cannot run on a Mac. Game work only, as needsTimed: a portal request that names a scenario does not.
 */
export const MP_SCENARIO_WORDS = /\bMP-[A-Za-z0-9][\w-]*\w/;
export function needsMpPeers(w: Pick<WorkItem, 'needs' | 'title' | 'brief' | 'notes'> | undefined, text = ''): boolean {
  if (w && needsOf(w) === 'agent') return false;
  return MP_SCENARIO_WORDS.test(`${w ? `${w.title}\n${w.brief}\n${(w.notes ?? []).map((n) => n.text).join('\n')}\n` : ''}${text}`);
}

/**
 * How long a computer must have had room before a request still Queued beside it is WRONG (w1944; a judgment): the capacity
 * ping waits a 30 s quiet spell and up to its 2-minute gap, then the dispatcher needs a turn. At 22:13:31 UTC on 2026-10-23
 * three sandboxes freed and list_work flagged 21 requests WRONG within seconds; the dispatcher had started three by 22:15.
 */
export const ROOM_STAND_MS = 5 * 60_000;

/**
 * How long a computer's last free sandbox stays held for an older Queued pair run that still cannot start (w1983): from
 * when that computer's room began. Held longer, it starved everything (lothlaptop/slot1 sat free 02:50Z to 03:52Z on
 * 2026-10-24, held for w1970 and then w1981, while lothsahn's w1789 waited for it). A judgment: four capacity pings' worth
 * of standing room, and sandboxes freed every few minutes in that hour's journal.
 */
export const PAIR_HOLD_MS = 20 * 60_000;

/**
 * How long a small computer's last free sandbox stays held for Queued timed work that has not started there (w1995), from
 * when that computer's room began: as PAIR_HOLD_MS, so a hold the dispatcher does not act on never keeps a sandbox idle long.
 * Timed work fits one sandbox, so it can start the moment the hold begins; the bound only covers a dispatcher that does not.
 */
export const TIMED_HOLD_MS = PAIR_HOLD_MS;

/** What a computer with room is, for whether a request can run there (w1944, RoomNow.fit): its platform, and w1861's no-timed-runs reason. */
export interface RoomFit {
  platform?: string;
  noTimedRuns?: string;
}

/**
 * Why computer `id` cannot take `w` although it has room (w1944), or undefined when it can: timed work on a computer that
 * takes no timed runs (m5, w1861/w1872) or on another platform than the one its words name (w1628), and an MP scenario on a
 * Mac (needsMpPeers). w1944 (2026-10-23 22:13 UTC): list_work flagged w1941 and w1942, two urgent MP scenario fixes, "Queued
 * [WRONG: biscuit, m5 have room]" while the m5, a Mac that takes no timed runs, could never run them, and the capacity ping
 * listed them as fitting its room. Unknown facts fit: a computer whose platform nobody reported is not ruled out.
 */
export function unfitWhy(w: Pick<WorkItem, 'needs' | 'title' | 'brief' | 'notes'> & { pair?: WorkPair }, id: string, fit: Readonly<Record<string, RoomFit>> | undefined): string | undefined {
  // w2041: a retry of a pair run never goes back to a computer an earlier leg failed on.
  if (w.pair?.avoid?.includes(id)) return `${id} is where an earlier leg of this pair run failed (${w.pair.retryOf ?? 'its first run'}): a retry goes on other computers (w2041)`;
  const f = fit?.[id];
  if (!f) return undefined;
  const timed = needsTimed(w) || (w.pair?.timed ? 'any' : false);
  if (timed && f.noTimedRuns) return `${id} takes no timed runs (${f.noTimedRuns})`;
  if ((timed === 'win32' || timed === 'darwin') && f.platform && f.platform !== timed) return `${id} is not on ${timed === 'win32' ? 'Windows' : 'macOS'}, which its timed work names`;
  // w2282: a Mac fits a pair run, as its host only; pairRoom keeps the clients off Macs. A pair's MP scenario runs one peer
  // per computer, so needsMpPeers (every peer on one computer) does not rule a Mac out for it.
  if (f.platform === 'darwin' && needsMpPeers(w) && !w.pair) return `${id} is a Mac, which refuses the multiplayer client its MP scenario starts (w665)`;
  return undefined;
}

/** The most computers one pair run takes at once (w1945; a judgment: the game's own pair scenarios use 2, the honest co-op 3). */
export const PAIR_MAX_LEGS = 4;

/**
 * Whether a pair run (w1945, WorkItem.pair) can start on the computers in `ids` (those with room that fit it, unfitWhy, in the
 * order placement prefers): `pick` names one computer per leg, leg 1 (the host) first; `short` says why not. Each leg needs its
 * own computer, at the same moment. Every pair takes at most one Mac, as the host (a Mac refuses a multiplayer client, w665;
 * w2282, lothsahn: "Not windows by default, any OS. Being particular about a machine or OS limits the fleet we can use."),
 * and a Mac with room hosts first, which leaves the other computers to work a Mac cannot take. A cross-OS pair also needs
 * its legs on at least two operating systems; a computer whose platform nobody reported counts toward the legs but not
 * toward a second operating system. Work that is no pair run fits on any one of them.
 */
export function pairRoom(w: { pair?: WorkPair }, ids: readonly string[], fit: Readonly<Record<string, RoomFit>> | undefined): { pick: string[]; short?: undefined } | { pick?: undefined; short: string } {
  const p = w.pair;
  if (!p) return ids.length ? { pick: [ids[0]] } : { short: 'no computer it fits has room' };
  const os = (id: string) => fit?.[id]?.platform;
  const macs = ids.filter((id) => os(id) === 'darwin');
  const rest = ids.filter((id) => os(id) !== 'darwin');
  const have = ids.length ? `only ${ids.join(', ')} ${ids.length > 1 ? 'have' : 'has'} room it fits` : 'no computer it fits has room';
  if (!p.crossOs) {
    const pick = [...macs.slice(0, 1), ...rest].slice(0, p.legs);
    if (pick.length < p.legs) return { short: `a pair run of ${p.legs} legs needs ${p.legs} computers with room at once, at most one of them a Mac (the host), and ${have}` };
    return { pick };
  }
  // Cross-OS: a Mac host when one has room, else one computer of each operating system first.
  const byOs = new Map<string, string[]>();
  for (const id of rest) byOs.set(os(id) ?? '?', [...(byOs.get(os(id) ?? '?') ?? []), id]);
  const spread: string[] = [];
  for (let i = 0; spread.length < rest.length; i++) for (const list of byOs.values()) if (list[i]) spread.push(list[i]);
  const pick = [...macs.slice(0, 1), ...spread].slice(0, p.legs);
  const systems = new Set(pick.map(os).filter((x): x is string => !!x));
  if (pick.length < p.legs) return { short: `a cross-OS pair run of ${p.legs} legs needs ${p.legs} computers with room at once, at most one of them a Mac (the host), and ${have}` };
  if (systems.size < 2) return { short: `a cross-OS pair run (${p.crossOs}) needs its legs on two operating systems, and the computers with room it fits (${ids.join(', ')}) are all ${[...systems][0] ?? 'of unknown platform'}` };
  return { pick };
}

/** Where a pair run that needs no cross-OS pair goes (w2282): any computers, a Mac only as the host. */
export const PAIR_ANY_OS = 'on any computers, any OS (a Mac only as the host, leg 1)';
/** What pairText said of one before w2282, still in the constraints and brief of pair runs filed then (repairText). */
const PAIR_NOT_MACS = 'on computers that are not Macs';

/**
 * A pair run filed before w2282 says its legs go "on computers that are not Macs" in its constraints and brief, which the
 * dispatcher reads: say the rule placement now follows instead (its pair mark never held the old rule, so placement needs no
 * change). Whether it changed anything.
 */
export function repairText(w: Pick<WorkItem, 'constraints' | 'brief'> & { pair?: WorkPair }): boolean {
  if (!w.pair || w.pair.crossOs) return false;
  const fix = (s: string | undefined) => s?.split(PAIR_NOT_MACS).join(PAIR_ANY_OS);
  const c = fix(w.constraints), b = fix(w.brief) ?? w.brief;
  if (c === w.constraints && b === w.brief) return false;
  if (c !== undefined) w.constraints = c;
  w.brief = b;
  return true;
}

/** "a pair run of 2 legs, cross-OS: <why>, timed" (w1945): what a pair needs, as lines about it say it. */
export const pairText = (p: WorkPair): string => `a pair run of ${p.legs} legs${p.crossOs ? `, cross-OS (${p.crossOs})` : `, ${PAIR_ANY_OS}`}${p.timed ? ', timed (exclusive tickets: not on a computer that takes no timed runs)' : ''}${p.avoid?.length ? `, not on ${p.avoid.join(' or ')}` : ''}`;

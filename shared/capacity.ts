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
import type { WorkItem } from './types.ts';

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
 * A release build named in words (w1606, narrowed by w1628): "release build", "build a release", "ci-release". lothsahn,
 * 2026-10-20: "Ben's guidance was only supposed to be for release builds of the software, not all builds that workers do
 * when making fixes": a worker's own player build (a fix, a clip, a playtest or MP check) is placed like any game work.
 */
export const BUILD_WORDS = /\brelease builds?\b|\bbuild (?:a|the|an?(?: new)?) release\b|\bci-release\b/i;

/**
 * Whether a request makes a release build (w1606, Ben: "when you know builds are coming up, we also prioritize using beast
 * for builds because its faster"; release builds only since w1628): game work whose worker declared a release build
 * (`build`), or whose title, brief or people's notes name one, or `text` does (a dispatcher's brief).
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
export const TIMED_WORDS = /\b(?:bench(?:mark)?(?:s|ed|ing)?|perf (?:a\/b|probe|test|run|fix|regression)s?|performance (?:a\/b|probe|test|run|regression|fix)s?|timed (?:runs?|legs?|a\/b)|probe_ab\w*|frame ?times?|a\/b (?:runs?|test|legs?))\b/i;

/**
 * Whether a request runs timed legs (w1628), and on what platform when its words name one: 'win32' ("Windows", "win
 * player", "probe_ab_win"), 'darwin' ("Mac"), else 'any'; false for no timed work. lothsahn, 2026-10-20: "We should also
 * prefer boxes with a small number of slots and players for timed runs, not beast since it's big" (server/placement.ts
 * pickTimed).
 */
export function needsTimed(w: Pick<WorkItem, 'needs' | 'title' | 'brief' | 'notes'> | undefined, text = ''): false | 'any' | 'win32' | 'darwin' {
  if (w && needsOf(w) === 'agent') return false;
  const all = `${w ? `${w.title}\n${w.brief}\n${(w.notes ?? []).map((n) => n.text).join('\n')}\n` : ''}${text}`;
  if (!TIMED_WORDS.test(all)) return false;
  const win = /\bwindows\b|\bwin(?:64)? (?:player|build)\b|probe_ab_win|\bbeast\b|\blothdesktop\b/i.test(all);
  const mac = /\bmac(?:os)?\b|\bm[35]\b/i.test(all);
  return win === mac ? 'any' : win ? 'win32' : 'darwin';
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

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
import { desktopLacks, needsWindow, pairDrivesMenus, windowLacks, type DesktopSession } from './desktop.ts';
import { steamAccountText, steamLacks, steamSignedIn, type SteamClient } from './steam.ts';
import type { AgentIntegrity, PairPlayer, PlayerCacheReport, WorkItem, WorkPair } from './types.ts';

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
 * UI-heavy work named in words (w4738): stills, screenshots, clips, play mode, a playtest, the UI gate's tools (ui_look,
 * ui_layout, the ui-critic, unity-ui), the HUD, "UI" in capitals. w4488's brief named stills, ui_look/ui_layout and the
 * ui-critic. A bare "ui" or "panel" is not (the portal's own work says them).
 */
export const UI_HEAVY_WORDS = /\b(?:stills?|screenshots?|clips?|play[- ]?mode|playtests?|ui[-_ ]?critic|ui_look|ui_layout|unity-ui|hud)\b/i;
/** "UI" in capitals (w4738): case matters, so a path or word with "ui" in it is not UI-heavy. */
const UI_CAPS = /\bUI\b/;

/**
 * Whether a request is UI-heavy (w4738): game work (never agent-slot work) that needs a Live view (needsLive), or whose title,
 * brief or people's notes name UI-heavy work (UI_HEAVY_WORDS), or `text` does. A room move does not take it to a computer with
 * one Unity slot while another fits (server/resumeMove.ts): its editor and a player build or a second editor share that slot.
 */
export function needsUi(w: Pick<WorkItem, 'needs' | 'liveView' | 'title' | 'brief' | 'notes'> | undefined, text = ''): boolean {
  if (w && needsOf(w) === 'agent') return false;
  if (needsLive(w, text)) return true;
  const words = `${w ? `${w.title}\n${w.brief}\n${(w.notes ?? []).map((n) => n.text).join('\n')}\n` : ''}${text}`;
  return UI_HEAVY_WORDS.test(words) || UI_CAPS.test(words);
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
 * Words that say THIS work is not timed (w3720): "not a timing run", "isn't timed work", "not timed", "needs no bench lock",
 * "no timing", "doesn't need exclusive use", "no exclusive lock". Distinct from a negated mention (timedMention skips "no
 * bench lock" but goes on reading the rest): a denial is the requester's verdict, and the newest one wins over older words.
 */
export const TIMED_DENIAL = /\b(?:isn't|not|never)\s+(?:a\s+|an\s+)?(?:timed|timing)(?:\s+(?:runs?|work|legs?|tests?|measurements?|a\/b))?\b|\b(?:needs?|takes?|wants?|requires?)\s+no\s+(?:bench(?:\s+lock|\s+ticket)?|timing|exclusive)\b|\bdoes(?:n't|\s+not)\s+need\s+(?:a\s+|an\s+)?(?:exclusive|bench|timing)\b|\bno\s+(?:timing|timed)\s+(?:work|runs?|measurements?|needed)\b/i;

/** Whether `text` says the work it is about is not timed (TIMED_DENIAL). */
export const timedDenial = (text: string): boolean => TIMED_DENIAL.test(text);

/**
 * Whether a request runs timed legs (w1628), and on what platform when its words name one: 'win32' ("Windows", "win
 * player", "probe_ab_win"), 'darwin' ("Mac"), else 'any'; false for no timed work. lothsahn, 2026-10-20: "We should also
 * prefer boxes with a small number of slots and players for timed runs, not beast since it's big" (server/placement.ts
 * pickTimed).
 */
export function needsTimed(w: (Pick<WorkItem, 'needs' | 'title' | 'brief' | 'notes'> & Partial<Pick<WorkItem, 'timedBrief' | 'timedMark'>> & { pair?: Pick<WorkPair, 'timed'> }) | undefined, text = ''): false | 'any' | 'win32' | 'darwin' {
  if (w && needsOf(w) === 'agent') return false;
  // w3720: an explicit mark beats every word. decide_work timed false (or true) says it outright; a pair run is timed only
  // when request_pair or decide_work said so (WorkPair.timed), never by its words: w3705, a determinism pair run, read as
  // timed work on darwin from two notes saying it was NOT a timing run ("LothLaptop, whose bench lock is held by w3639's
  // vSync timed run"; "m5 ... may be the host as a Mac"), so m5 refused it as timed and biscuit as not a Mac, and it sat
  // Queued beside free room while it gated the 1.0 release.
  if (w?.timedMark?.timed === false) return false;
  if (w?.pair && !w.timedMark?.timed) return w.pair.timed ? 'any' : false;
  if (w?.pair) return 'any';
  // Oldest first: the title and brief as filed, then people's notes in order, then `text` (a dispatcher's brief).
  // w2358: the brief start_agent was refused for (WorkItem.timedBrief) reads as a note of its time.
  const later = [...(w?.notes ?? []), ...(w?.timedBrief ? [w.timedBrief] : [])].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const parts = [...(w ? [w.title, w.brief, ...later.map((n) => n.text)] : []), text].filter(Boolean);
  if (!w?.timedMark?.timed) {
    if (!timedMention(parts.join('\n'))) return false;
    // w3720: the newest words that speak to timing win: a note that says the work is not timed ("it's a determinism check,
    // not a timing run", "it needs no bench lock and isn't timed work") clears every mention before it, and its own.
    for (const part of [...parts].reverse()) {
      if (timedDenial(part)) return false;
      if (timedMention(part)) break;
    }
  }
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
// w2415: OS words only, never a computer's name. A name says where a worker ran or what an earlier run measured on ("Worker
// 8b4357c9 is on m3, which is offline"), not what the work needs: w2320 and w2336 read as Mac work from such notes and sat
// held 6 h beside an idle biscuit (w1789's m5 and w2358's m3 were the same mistake). A computer the work must run on is a pin
// (decide_work queue with needs), which unfitWhy honours.
const WIN_WORDS = /\bwindows\b|\bwin(?:64)? (?:player|build)\b|probe_ab_win/gi;
const MAC_WORDS = /\bmac(?:os)?\b/gi;

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
const LEVEL: Record<string, number> = { low: 0, normal: 0, high: 1, urgent: 2, frantic: 3, release: 3 }; // release: frantic's name before w4710

/** Whether a computer whose lowest priority is `min` takes work of `priority` (a request's priority now; unknown is normal). */
export const admitsPriority = (min: MinPriority | undefined, priority: string | undefined): boolean => (LEVEL[priority ?? 'normal'] ?? 0) >= (LEVEL[min ?? 'normal'] ?? 0);

/** "high and urgent work only", "urgent work only": what a reserved computer takes. */
export const minPriorityText = (min: MinPriority): string => (min === 'urgent' ? 'urgent and frantic work only' : min === 'high' ? 'high, urgent and frantic work only' : 'all work');

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
 * The override the game repo's guard reads (scripts/nightly/player_slots.py require_mac_client_ok): FF_MAC_GPU_HANG_OK set to
 * a request id lets a Mac start a multiplayer client (a w665 repro whose Mac's person agreed to unlock it afterwards).
 */
export const MAC_CLIENT_OK_WORDS = /\bFF_MAC_GPU_HANG_OK=w\d+/i;
/**
 * A pair run whose peers are spread over its computers, leg 1 the host and the others its clients: a pair lab
 * (scripts/nightly/lab.pair-m5-beast.json) or the pair relay (scripts/nightly/pair_relay.py; the game repo's
 * Determinism-Test-Strategy.md, "A pair with no ssh"). Its host leg starts no client, so a Mac may take it.
 */
export const SPLIT_PEER_WORDS =
  /\blab\.pair-[\w.-]+|\bpair[_ ]relay\b|\b(?:pair|relay|two-computer pair) lab\b|\ba Mac(?: \([^)\n]{0,60}\))? (?:may|can) host\b/i;
/** Why a Mac takes no leg of a pair run whose legs each start an MP scenario's host and client (w3697). */
export const MAC_REFUSES_SCENARIO =
  "a Mac refuses a multiplayer client (the game repo's scripts/nightly/player_slots.py require_mac_client_ok, w665; w3697). A pair lab or the relay (leg 1 hosts, the others join), a cross-OS pair or FF_MAC_GPU_HANG_OK=<request> in its words lets a Mac host";
/**
 * The words the Mac rule reads (w3697): title, brief and notes, without FF Factory's own w3697 sentence. request_pair wrote
 * "No leg goes on a Mac (w3697): ... A pair lab or the relay ... lets a Mac host" into every MP-scenario pair's brief, which
 * names a pair lab itself, so it is cut before SPLIT_PEER_WORDS reads them (w4468).
 */
export function macRuleWords(w: Pick<WorkItem, 'title' | 'brief' | 'notes'>): string {
  return `${w.title}\n${w.brief}\n${(w.notes ?? []).map((n) => n.text).join('\n')}`
    .split(MAC_REFUSES_SCENARIO)
    .join('')
    .replace(/No leg goes on a Mac \(w3697\):[^\n]*?its own computer, and \.?/g, '');
}

/**
 * The MP scenario a Mac would have to start a client of (w3697), or undefined when a Mac may take the work. ffnightly.py
 * starts every peer of an MP scenario on the computer it runs on unless a pair lab or the relay spreads them, so work that
 * names one starts a client wherever it runs, and the guard refuses that on a Mac. A pair run is no exception: w3669 (the
 * pair run for PR #3433, MP-W1587-gatling-tiers: "The scenario runs both peers, host and client, on one computer") put leg 1
 * on m5 at 17:51 UTC on 2026-11-08, and its 3 runs each ended 'env' in about 20 s at the guard after a 10-minute Mac build.
 * A pair's host leg starts no client only when its peers are spread: a cross-OS pair (its client is on the other OS) or one
 * whose words name a pair lab or the relay. Unsure is a refusal: a Windows or Linux leg costs nothing, a Mac leg that hits
 * the guard costs a build and a worker. FF_MAC_GPU_HANG_OK=<request> in its words lifts it, as it lifts the guard.
 * A pair marked split (request_pair split, decide_work pair_split; w4468) spreads its peers by its own word: w4460 ("a
 * two-computer pair lab") and w4334 (lothsahn: "A Mac may host leg 1") sat Queued for hours because the words were missed.
 */
export function macRefusedScenario(w: Pick<WorkItem, 'needs' | 'title' | 'brief' | 'notes'> & { pair?: WorkPair }): string | undefined {
  if (!needsMpPeers(w)) return undefined;
  const words = macRuleWords(w);
  if (MAC_CLIENT_OK_WORDS.test(words)) return undefined;
  if (w.pair && (w.pair.crossOs || w.pair.split || SPLIT_PEER_WORDS.test(words))) return undefined;
  return MP_SCENARIO_WORDS.exec(words)?.[0];
}

/**
 * How long a computer must have had room before a request still Queued beside it is WRONG (w1944; a judgment): the capacity
 * ping waits a 30 s quiet spell and up to its 2-minute gap, then the dispatcher needs a turn. At 22:13:31 UTC on 2026-10-23
 * three sandboxes freed and list_work flagged 21 requests WRONG within seconds; the dispatcher had started three by 22:15.
 */
export const ROOM_STAND_MS = 5 * 60_000;

/**
 * How long a computer's last free sandbox stays held for the Queued pair run that still waits for its other legs (w1983,
 * w3530): from when that computer's room began or the pair was Queued, whichever is later. 20 min at first (w1983:
 * lothlaptop/slot1 sat free 02:50Z to 03:52Z on 2026-10-24, held for w1970 and then w1981, while lothsahn's w1789 waited for
 * it). w3530: on 2026-11-08 a second computer freed 23 and 37 min after the first (biscuit/slot3 00:38Z, beast/slot1 01:01Z,
 * m5/slot2 01:38Z), so each 20 min hold lapsed before its partner came and pairs waited 5 to 17 h. A judgment: 45 min covers
 * those gaps, and since w3530 only one waiting pair holds (Agents.pairPlan), at most its legs less one sandboxes at a time.
 */
export const PAIR_HOLD_MS = 45 * 60_000;

/**
 * How long a small computer's last free sandbox stays held for Queued timed work that has not started there (w1995), from
 * when that computer's room began: 20 min, so a hold the dispatcher does not act on never keeps a sandbox idle long.
 * Timed work fits one sandbox, so it can start the moment the hold begins; the bound only covers a dispatcher that does not.
 */
export const TIMED_HOLD_MS = 20 * 60_000;

/**
 * How long a computer's free place stays held for an older or higher leg (w1863's WorkItem.legs) that nobody started there
 * (w5860), from when that computer's room began. A leg fits one place, so it can start the moment the hold begins; the bound
 * only covers a dispatcher that does not: the WRONG flag tells it after 10 min (flagQueuedWithRoom), and 30 min leaves it two
 * capacity pings to act. A judgment, not a measurement.
 */
export const LEG_HOLD_MS = 30 * 60_000;

/** What a computer with room is, for whether a request can run there (w1944, RoomNow.fit): its platform, and w1861's no-timed-runs reason. */
export interface RoomFit {
  platform?: string;
  noTimedRuns?: string;
  /** Why it runs no game players (w4621, Machine.noPlayers; m3 by default): a pair run, whose every leg runs one, never goes there. */
  noPlayers?: string;
  /** Its Steam client as its daemon reported it (w2459); absent: not reported, which no pair that needs Steam fits. */
  steam?: SteamClient;
  /** Its desktop session (w2459, shared/desktop.ts): a pair run that clicks the game's menus goes only where it is unlocked. */
  desktop?: DesktopSession;
  /** w3396: why its sandbox drive is too low for a new Rust (cargo) worker, under CARGO_MIN_FREE_GB free; absent when it has room or nobody knows. */
  cargoShort?: string;
  /** w4601: the ready players its shared player cache holds (machine/playerCache.ts); a pair leg prefers the computer with its commit's. */
  playerCache?: PlayerCacheReport;
  /** w5965: its worker fence's state (Machine.fence); absent: not reported. A pair run of a pre-w5297 player goes only where it is off. */
  fence?: 'off' | 'setting_up' | 'on' | 'failed';
  /** w6003: the integrity level its Windows sandbox agents were measured at (Machine.fence.agentIntegrity); absent: not measured. */
  agentIntegrity?: AgentIntegrity;
  /** Why it could not be measured. */
  agentIntegrityWhy?: string;
}

/** The player cache's build target for a platform (scripts/nightly/player_cache.py TARGETS), or undefined. */
const CACHE_TARGET: Record<string, string> = { win32: 'win', darwin: 'mac', linux: 'linux' };

/**
 * The cached player of `commit` that the computer with `fit` holds for its own OS (w4601): the cache entry and the player
 * folder ffnightly.py --player takes, or undefined. `commit` may be short (7 to 40 hex, as request_pair takes it); a narrowed
 * Burst build (-burstN, the nightly's) never counts, since build_player.sh's default key for that commit is the plain one.
 */
export function cachedPlayerOf(commit: string | undefined, fit: RoomFit | undefined): { entry: string; player: string } | undefined {
  const c = commit?.trim().toLowerCase();
  const target = fit?.platform ? CACHE_TARGET[fit.platform] : undefined;
  if (!c || !/^[0-9a-f]{7,40}$/.test(c) || !target || !fit?.playerCache) return undefined;
  const hit = fit.playerCache.entries.find((e) => e.key.endsWith(`-${target}`) && e.key.split('-')[0].startsWith(c));
  if (!hit) return undefined;
  const root = fit.playerCache.root.replace(/[\\/]+$/, '');
  const sep = fit.platform === 'win32' ? '\\' : '/';
  const entry = `${root}${sep}${hit.key}`;
  return { entry, player: `${entry}${sep}player` };
}

/**
 * The line a pair leg's first message carries when its computer's player cache already holds the pair's commit (w4601,
 * server/agents.ts startPairLegs), or ''. It names the player's path and tells the leg to skip the sandbox build.
 */
export function cachedPlayerNote(commit: string | undefined, fit: RoomFit | undefined): string {
  const hit = cachedPlayerOf(commit, fit);
  if (!hit) return '';
  const target = CACHE_TARGET[fit!.platform!];
  return `\n\n## A player of this commit is already built here (w4601)\nThis computer's shared player cache holds a ${target} player of ${commit!.slice(0, 10)}: \`${hit.player}\` (cache entry \`${hit.entry}\`). Use it and skip the sandbox build: pass \`--player ${hit.player}\` to \`ffnightly.py run\` (or run \`build_player.sh\` for that commit and ${target} as usual: it finds the entry, prints "cached: ... build skipped" and logs the hit, with no checkout of the commit needed). Check first that the commit you run is ${commit!.slice(0, 10)}; build only if it is not, or if the entry is gone. Never start the player where it lies: \`player_slots.py launch\` (or ffnightly.py) runs it from a slot.`;
}

/**
 * w4613: the line a pair leg's first message carries when its pair has a published player (request_pair player) of the OS
 * of the leg's computer, which does not hold that commit's player yet (cachedPlayerNote is '' there), or ''. A leg on another
 * OS gets nothing and builds as before.
 */
export function fetchPlayerNote(commit: string | undefined, player: PairPlayer | undefined, fit: RoomFit | undefined): string {
  const target = fit?.platform ? CACHE_TARGET[fit.platform] : undefined;
  if (!player || !target || player.os !== target) return '';
  const sha = player.key.slice(0, 40);
  const mb = Math.round(player.size / (1024 * 1024));
  return `\n\n## Fetch the requester's player instead of building it (w4613)\nThe worker that asked for this run published its ${target} player of ${sha.slice(0, 10)}${commit && !sha.startsWith(commit) ? ` (the run's commit is ${commit.slice(0, 10)}: if it is not ${sha.slice(0, 10)}, build instead)` : ''}: attachment ${player.id}, ${mb} MB packed. Call fetch_attachment with id ${player.id} before anything else: it downloads it, unpacks it into this computer's shared player cache (checking its build-manifest.json says ok for that commit) and answers the player's path and how long it took. Then pass \`--player <that path>\` to \`ffnightly.py run\` (or run \`build_player.sh\` for that commit as usual: it finds the entry and skips the build) and skip the sandbox build. Build as usual only if the fetch fails, and say why in your report. Put the fetch time it answers in your report. Never start the player where it lies: \`player_slots.py launch\` (or ffnightly.py) runs it from a slot.`;
}

/**
 * The free space a computer's sandbox drive needs before it takes a new FFU (Rust, cargo) worker (w3396). One clean debug
 * test build of ffu's workspace wrote 14.1 GB of target on BEAST before w3396's profile change (measured, 2026-11-07), and
 * LothDesktop's 300 GB V: ran out three times that day under running workers' targets: below this line such work queues.
 */
export const CARGO_MIN_FREE_GB = 30;

/** Whether a request's repo is FFU (Final-Factory/ffu), whose workers build Rust with cargo (w3396). */
export function isCargoRepo(repo: string | undefined): boolean {
  if (!repo) return false;
  const n = repo.trim().toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return n === 'final-factory/ffu' || n === 'ffu';
}

/** The cargoShort reason for a drive with `freeBytes` free (w3396), or undefined when it has room. */
export function cargoShortOf(freeBytes: number | undefined): string | undefined {
  if (freeBytes === undefined || freeBytes >= CARGO_MIN_FREE_GB * 1024 ** 3) return undefined;
  return `its sandbox drive has ${(freeBytes / 1024 ** 3).toFixed(1)} GB free, under the ${CARGO_MIN_FREE_GB} GB a new FFU (cargo) worker needs (w3396)`;
}

/**
 * Why a computer cannot take a leg of a pair run of a pre-w5297 player (WorkPair.legacyData), or undefined. That player
 * writes the owner's own data folder, which is Medium on Windows (w5944, w5966), so on Windows a leg goes only where a
 * sandbox agent was MEASURED at Medium or above (WorkerFenceReport.agentIntegrity, machine/agentIntegrity.ts, w6003):
 * not by the fence setting, since w6002 went on lothdesktop/slot5 and its worker measured itself at Low. An unmeasured
 * level is refused. On a Mac the fence must be off; Linux has no pre-1.0 multiplayer build. `f` undefined: nothing
 * reported, refused.
 */
export function legacyUnfitWhy(pair: Pick<WorkPair, 'legacyData'>, id: string, f: RoomFit | undefined): string | undefined {
  const old = `this pair run's player predates w5297 (${pair.legacyData})`;
  if (!f) return `${id} has reported nothing placement reads (platform, worker fence), and ${old}: it goes only where a sandbox agent was measured at Medium integrity (w6003)`;
  if (f.platform === 'linux') return `${id} is on Linux, and ${old}: pre-1.0 has no Linux multiplayer build (w5965)`;
  if (f.platform === 'win32') {
    const lvl = f.agentIntegrity;
    if (lvl === 'medium' || lvl === 'high' || lvl === 'system') return undefined;
    const seen = lvl ? `its sandbox agents were measured at ${lvl[0].toUpperCase()}${lvl.slice(1)} integrity${lvl === 'low' ? ' (S-1-16-4096)' : ''}` : `its sandbox agents' integrity level has not been measured${f.agentIntegrityWhy ? ` (${f.agentIntegrityWhy})` : ' (its daemon predates w6003 or has not reported)'}`;
    return `${id}: ${seen}, and ${old}: it writes the owner's own data folder, which only a Medium agent can write (w5944, w6003)`;
  }
  if (!f.platform && !f.fence) return `${id} has not reported its platform or worker fence, and ${old}: it goes only where a sandbox agent was measured at Medium integrity (w6003)`;
  if (f.fence && f.fence !== 'off') return `${id}'s worker fence is ${f.fence === 'setting_up' ? 'setting up' : f.fence}, and ${old}: it writes the owner's own data folder, which a fenced worker cannot write (w5944, w5965); it goes on a computer whose fence is off`;
  return undefined;
}

/**
 * Why computer `id` cannot take `w` although it has room (w1944), or undefined when it can: timed work on a computer that
 * takes no timed runs (m5, w1861/w1872) or on another platform than the one its words name (w1628), and an MP scenario on a
 * Mac (needsMpPeers). w1944 (2026-10-23 22:13 UTC): list_work flagged w1941 and w1942, two urgent MP scenario fixes, "Queued
 * [WRONG: biscuit, m5 have room]" while the m5, a Mac that takes no timed runs, could never run them, and the capacity ping
 * listed them as fitting its room. Unknown facts fit: a computer whose platform nobody reported is not ruled out.
 */
export function unfitWhy(w: Pick<WorkItem, 'needs' | 'title' | 'brief' | 'notes'> & Partial<Pick<WorkItem, 'timedBrief' | 'timedLeg' | 'repo' | 'windowMark'>> & { pair?: WorkPair }, id: string, fit: Readonly<Record<string, RoomFit>> | undefined, named?: readonly string[]): string | undefined {
  // w2041: a retry of a pair run never goes back to a computer an earlier leg failed on.
  if (w.pair?.avoid?.includes(id)) return `${id} is where an earlier leg of this pair run failed (${w.pair.retryOf ?? 'its first run'}): a retry goes on other computers (w2041)`;
  const f = fit?.[id];
  // w6003: unknown facts fit, except for a pre-w5297 pair run, which goes only where Medium was measured.
  if (w.pair?.legacyData) {
    const why = legacyUnfitWhy(w.pair, id, f);
    if (why) return why;
  }
  if (!f) return undefined;
  // w4621: every leg of a pair run runs a game player (or an FFU client), which a no-players computer (the m3) never runs.
  if (w.pair && f.noPlayers) return `${id} runs no game players (${f.noPlayers}), and every leg of a pair run runs one`;
  // w5965: a player from before w5297 (the 0.50 line) writes the owner's own data folder, which a fenced worker cannot
  // write (Windows: LocalLow, labelled Medium; SHGetKnownFolderPath ignores a child's USERPROFILE, so it cannot be moved).
  // w3396: an FFU worker's cargo target grows to many GB; a drive under the line takes none until the clean-up frees it.
  if (f.cargoShort && isCargoRepo(w.repo)) return `${id}: ${f.cargoShort}`;
  // w2459: a pair run that needs Steam (lobbies, a Steam host or join) goes only where Steam is signed in.
  if (w.pair?.steam) {
    const lacks = steamLacks(id, f.steam);
    if (lacks) return `${lacks}, and its pair run needs Steam (${w.pair.steam})`;
  }
  // w2459 (w2460's rerun 2: m5's host leg, signed in to Steam, behind a locked screen): a pair run that clicks the game's
  // menus goes only where the desktop is unlocked; a locked Mac's menus take no clicks.
  if (pairDrivesMenus(w.pair)) {
    const lacks = desktopLacks(id, f.desktop);
    if (lacks) return `${lacks}, and its pair run clicks the game's menus (${w.pair!.steam ? 'its Steam lobby' : w.pair!.menus}), which take no clicks there`;
  }
  // w4868: work that draws a window (a capture, a screenshot, play mode, the FFU client's window) never goes where the
  // screen is locked: a window there draws no frames and a capture is black. Headless work still goes.
  if (needsWindow(w)) {
    const lacks = windowLacks(id, f.desktop);
    if (lacks) return `${lacks}: its work draws a window, which gets no frames there (w4868); it goes on a computer whose screen is unlocked`;
  }
  // w2358: a timed leg (w1969) is timed work whatever its title says, as start_agent's timed hold reads it.
  const timed = needsTimed(w) || (w.pair?.timed || w.timedLeg ? (w.timedLeg?.platform === 'win32' || w.timedLeg?.platform === 'darwin' ? w.timedLeg.platform : 'any') : false);
  if (timed && f.noTimedRuns) return `${id} takes no timed runs (${f.noTimedRuns})`;
  // w2415: an OS read from the words never rules out a computer the queue names (decide_work queue with needs): the list is
  // the dispatcher's own placement, the OS a guess. Only a timed leg's own platform (timed_place) still does.
  const pinned = !!named?.some((n) => n.toLowerCase() === id.toLowerCase()) && w.timedLeg?.platform !== timed;
  if ((timed === 'win32' || timed === 'darwin') && !pinned && f.platform && f.platform !== timed) return `${id} is not on ${timed === 'win32' ? 'Windows' : 'macOS'}, which its timed work names`;
  // w2282: a Mac fits a pair run, as its host only; pairRoom keeps the clients off Macs. w3697: unless every leg starts the
  // MP scenario's host and its client on its own computer (macRefusedScenario), as w3669's legs did.
  const mp = f.platform === 'darwin' ? macRefusedScenario(w) : undefined;
  if (mp) return w.pair ? `${id} is a Mac, and each leg of this pair run starts ${mp}'s host and its client on its own computer: ${MAC_REFUSES_SCENARIO}` : `${id} is a Mac, which refuses the multiplayer client its MP scenario starts (w665)`;
  return undefined;
}

/**
 * w5988: what the brief of a pair run whose player predates w5297 says about checking the level. Git Bash's `whoami` is
 * coreutils (no /groups), and Git Bash rewrites a bare `/groups` into a path (`V:/ffw/tools/git/groups`, measured on
 * lothdesktop 2026-11-26), so the check names Windows' own whoami.exe and turns that rewrite off.
 */
export const LEGACY_INTEGRITY_CHECK =
  "Its player predates w5297 and writes the owner's own data folder, which a Low-integrity worker cannot write (w5944, w5966): " +
  "on Windows, first check your level with `MSYS2_ARG_CONV_EXCL='*' \"$SYSTEMROOT/System32/whoami.exe\" /groups | grep \"Mandatory Level\"` " +
  "(Git Bash's own `whoami` is coreutils and has no /groups, and without MSYS2_ARG_CONV_EXCL Git Bash turns /groups into a path). " +
  '`Medium Mandatory Level` runs it; at `Low Mandatory Level` (S-1-16-4096) run nothing, and report that this computer was the wrong one (w5988).';

/** w5965: what pairText says of a pair run whose player predates w5297 (WorkPair.legacyData). */
export const PAIR_LEGACY = 'only on Windows computers whose sandbox agents were measured at Medium integrity (or a Mac whose fence is off), never Linux (its player predates w5297 and writes the owner\'s own data folder)';

/**
 * w5965: whether a pair run's words say its player predates w5297: a pre-1.0 build, the 0.50 line (0.50.x.y), or the words
 * themselves. A judgment from w5944's brief ("the 0.50 line at ac80d7b0", "pre-1.0"); request_pair legacy_data "none" says no.
 */
export const mentionsLegacyPlayer = (...texts: (string | undefined)[]): boolean => texts.some((t) => !!t && /\bpre-1\.0\b|\b0\.50\.\d|\b0\.50 line\b|predates w5297/i.test(t));

/** w5965: the mark a pair run gets when its words say its player predates w5297 (mentionsLegacyPlayer). */
export const LEGACY_READ = 'read from its words: pre-1.0 or the 0.50 line; request_pair legacy_data "none" says it does not';

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
  // w2459: a pair that clicks the game's menus never takes a computer whose screen is locked (unfitWhy says why).
  if (pairDrivesMenus(p)) ids = ids.filter((id) => !desktopLacks(id, fit?.[id]?.desktop));
  // w2459: a pair that needs Steam takes one computer per Steam account (two legs on one account cannot both be in a lobby).
  if (p.steam) {
    const seen = new Set<number>();
    const twins: string[] = [];
    ids = ids.filter((id) => {
      const s = fit?.[id]?.steam;
      const a = steamSignedIn(s) ? s.accountId : undefined;
      if (a !== undefined && seen.has(a)) twins.push(id);
      if (a === undefined || seen.has(a)) return false;
      seen.add(a);
      return true;
    });
    if (ids.length < p.legs) {
      return { short: `a pair run of ${p.legs} legs that needs Steam needs ${p.legs} computers signed in to ${p.legs} different Steam accounts with room at once, and ${ids.length ? `only ${ids.map((id) => `${id} (${steamAccountText(fit![id]!.steam as SteamClient & { accountId: number })})`).join(', ')} ${ids.length > 1 ? 'have' : 'has'} room it fits` : 'no computer it fits has room'}${twins.length ? `; ${twins.join(', ')} ${twins.length > 1 ? 'are' : 'is'} signed in to an account another leg takes` : ''}` };
    }
  }
  // w4601: computers whose player cache holds the pair's commit for their OS come first (a stable sort, so placement's own
  // order rules among the rest): a leg there skips its 3 to 23 min build (w4596's timelines of 12 pair runs).
  // w4613: next come computers of the published player's OS (request_pair player): a leg there fetches it instead of building.
  // w4925: next the computers where its request's last pair run ran (WorkPair.warm): a sandbox there may still hold that run's
  // branch, whose Library builds the next commit faster.
  if (p.commit || p.player || p.warm?.legs.length) {
    const warmOn = new Set((p.warm?.legs ?? []).map(refMachine));
    const rank = (id: string) => (cachedPlayerOf(p.commit, fit?.[id]) ? 0 : p.player && fit?.[id]?.platform && CACHE_TARGET[fit[id]!.platform!] === p.player.os ? 1 : warmOn.has(id) ? 2 : 3);
    ids = [...ids].sort((a, b) => rank(a) - rank(b));
  }
  const os = (id: string) => fit?.[id]?.platform;
  const macs = ids.filter((id) => os(id) === 'darwin');
  const rest = ids.filter((id) => os(id) !== 'darwin');
  const have = ids.length ? `only ${ids.join(', ')} ${ids.length > 1 ? 'have' : 'has'} room it fits` : 'no computer it fits has room';
  if (!p.crossOs) {
    const pick = [...macs.slice(0, 1), ...rest].slice(0, p.legs);
    if (pick.length < p.legs) return { short: p.legs === 1 ? `a pair run of 1 leg needs 1 computer with room, and ${have}` : `a pair run of ${p.legs} legs needs ${p.legs} computers with room at once, at most one of them a Mac (the host), and ${have}` };
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

/** Where a pair run that needs Steam goes (w2459). */
export const PAIR_STEAM = 'only on computers signed in to Steam, a different Steam account on each leg, each screen unlocked';

/**
 * Why the whole fleet cannot hold a pair run that needs Steam (w2459), or undefined when it can: fewer computers than legs
 * (offline or busy ones counted: that much is capacity) are signed in to Steam with different accounts, at most one of them
 * a Mac (it only hosts, w665). The reason names each computer and what it lacks, so the request is Blocked on it, not Queued.
 */
export function steamPairShort(p: WorkPair, machines: readonly { id: string; platform?: string; steam?: SteamClient }[]): string | undefined {
  if (!p.steam) return undefined;
  const seen = new Map<number, string>();
  let macs = 0;
  const ok: string[] = [];
  const lacks: string[] = [];
  for (const m of [...machines].sort((a, b) => a.id.localeCompare(b.id))) {
    if (p.avoid?.includes(m.id)) {
      lacks.push(`${m.id} is where an earlier leg failed`);
      continue;
    }
    const why = steamLacks(m.id, m.steam);
    if (why || !steamSignedIn(m.steam)) {
      lacks.push(why ?? `${m.id}'s Steam client is not signed in`);
      continue;
    }
    if (seen.has(m.steam.accountId)) {
      lacks.push(`${m.id} is signed in to ${steamAccountText(m.steam)}, the account ${seen.get(m.steam.accountId)} takes`);
      continue;
    }
    if (m.platform === 'darwin' && macs >= 1) {
      lacks.push(`${m.id} is a second Mac (a Mac only hosts, w665)`);
      continue;
    }
    seen.set(m.steam.accountId, m.id);
    if (m.platform === 'darwin') macs++;
    ok.push(`${m.id} (${steamAccountText(m.steam)})`);
  }
  if (ok.length >= p.legs) return undefined;
  return `a pair run of ${p.legs} legs that needs Steam needs ${p.legs} computers signed in to different Steam accounts, and ${ok.length ? `only ${ok.join(', ')} ${ok.length > 1 ? 'are' : 'is'}` : 'none is'}: ${lacks.join('; ')}`;
}

/** The computers steamPairShort counts (w2459): every machine with a worker pool (server/machines.ts poolSettingsOf), online or not. */
export function steamFleetOf(machines: Iterable<{ id: string; platform?: string; steam?: SteamClient; sandboxRoot?: string; playOnly?: string }>): { id: string; platform?: string; steam?: SteamClient }[] {
  return [...machines].filter((m) => m.sandboxRoot && !m.playOnly?.trim()).map((m) => ({ id: m.id, ...(m.platform ? { platform: m.platform } : {}), ...(m.steam ? { steam: m.steam } : {}) }));
}

/** Why a Steam pair run's fleet is short now (steamPairShort over steamFleetOf), or undefined. */
export const steamShortIn = (machines: Iterable<Parameters<typeof steamFleetOf>[0] extends Iterable<infer M> ? M : never>) => (p: WorkPair) => steamPairShort(p, steamFleetOf(machines));

/** Where a pair run that needs no cross-OS pair goes (w2282): any computers, a Mac only as the host. */
export const PAIR_ANY_OS = 'on any computers, any OS (a Mac only as the host, leg 1)';
/**
 * The computers a not-yet-started pair run avoids only because a w2304 re-queue put them there before w4468: a leg's computer
 * where a person played (w1894), that was paused (w2443) or offline. Each keeps its computer out only while it lasts (the play
 * hold, placement.hold, offline), so the avoid is dropped (server/store.ts, at load). Read from its log's re-queue lines
 * ("re-queued as a pair run (w2304, ...; its N legs start fresh together, not on X or Y): why"): such a computer ran a leg,
 * so no filing's avoid named it then. w4460 and w4207 kept lothdesktop out for hours after lothsahn's game there ended.
 */
export function transientPairAvoids(w: Pick<WorkItem, 'log'> & { pair?: WorkPair }): string[] {
  const avoid = w.pair?.avoid ?? [];
  if (!w.pair || w.pair.started || !avoid.length) return [];
  const named = new Set<string>();
  for (const line of w.log ?? []) {
    const m = /re-queued as a pair run \(w2304, [^;]*; its \d+ legs start fresh together, not on ([^)]*)\)/.exec(line);
    for (const id of m?.[1].split(' or ') ?? []) named.add(id.trim().toLowerCase());
  }
  return avoid.filter((id) => named.has(id.toLowerCase()));
}

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

/** "a pair run of 2 legs (1 leg: one computer runs host and client side by side), cross-OS: <why>, timed" (w1945): what a pair needs, as lines about it say it. */
/**
 * Why a pair run needs two or more computers at once (w4618), or undefined when one computer runs it: then its legs default
 * to 1 (request_pair) and a Queued run of more legs whose count was never asked for is cut to 1 (Orchestrators.cutDefaultPairs).
 * The reasons: cross_os, steam, timed, split, or words that name a pair lab or the relay (SPLIT_PEER_WORDS: lab.pair-...,
 * pair_relay), read without FF Factory's own w3697 sentence (macRuleWords). ffnightly.py's default lab (lab.win.json,
 * lab.linux.json) runs an MP scenario's host and client on the one computer it runs on, so a second leg only repeats the first:
 * w4595 (the pair run for w4571, two legs of ffnightly MP scenarios on the default lab) had not started 2 h 14 min after it was
 * filed, while w4609, one leg of the same commit, was done in 51 min (r287, w4596).
 */
export function pairComputersReason(w: Pick<WorkItem, 'title' | 'brief'> & { notes?: WorkItem['notes']; pair?: Pick<WorkPair, 'crossOs' | 'steam' | 'timed' | 'split'> }): string | undefined {
  const p = w.pair;
  if (p?.crossOs) return `cross_os (${p.crossOs})`;
  if (p?.steam) return `steam (${p.steam})`;
  if (p?.timed) return 'timed';
  if (p?.split) return `split (${p.split})`;
  const named = SPLIT_PEER_WORDS.exec(macRuleWords({ title: w.title, brief: w.brief, notes: w.notes }))?.[0];
  return named ? `its words name ${named}` : undefined;
}

/**
 * w4925: what a repeat pair run says of the sandboxes its request's last pair run used (WorkPair.warm): start there when
 * free, since one still on that run's branch builds the next commit's player faster. A preference only.
 */
export const warmText = (warm: NonNullable<WorkPair['warm']>): string =>
  `Its request's last pair run, ${warm.from}, ran in ${warm.legs.join(' and ')}: start ${warm.legs.length > 1 ? 'these legs there' : 'its leg there'} when ${warm.legs.length > 1 ? 'they are' : 'it is'} FREE (w4925: a sandbox still on that run's branch has a warm Library, and its next player build took 490 s median against about 800 s elsewhere, measured on lothdesktop), and never wait for ${warm.legs.length > 1 ? 'them' : 'it'}.`;

/** The computer of a sandbox ref ("machine/slotN"). */
const refMachine = (ref: string): string => ref.split('/')[0];

export const pairText = (p: WorkPair): string => `a pair run of ${p.legs} ${p.legs === 1 ? 'leg' : 'legs'}${p.crossOs ? `, cross-OS (${p.crossOs})` : `, ${PAIR_ANY_OS}`}${p.steam ? `, ${PAIR_STEAM} (${p.steam})` : ''}${p.menus && !p.steam ? `, only on computers whose screen is unlocked (it clicks the game's menus: ${p.menus})` : ''}${p.timed ? ', timed (exclusive tickets: not on a computer that takes no timed runs)' : ''}${p.split ? `, its peers spread (a Mac may host: ${p.split})` : ''}${p.legacyData ? `, ${PAIR_LEGACY} (${p.legacyData})` : ''}${p.avoid?.length ? `, not on ${p.avoid.join(' or ')}` : ''}`;

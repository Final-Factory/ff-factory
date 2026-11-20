// A computer's desktop session (w2459, rerun 2 of w2460, 2026-10-28: the host leg went to m5, signed in to Steam but with its
// screen locked, and the game's menus take no clicks on a Mac with a locked screen, so neither check ran). The daemon reads it
// beside its Steam client (machine/steamClient.ts): on macOS CGSessionCopyCurrentDictionary (machine/macDialogs.ts
// SESSION_SCRIPT), on Windows whether LogonUI.exe (the lock screen) runs. A pair run whose legs click the game's menus (every
// pair that needs Steam, a request_pair `menus` mark, or words that name a menu, a lobby or a click) goes only where it is
// unlocked (shared/capacity.ts unfitWhy), and a leg is refused on a locked one (server/agents.ts startPairLegs).
import type { WorkPair } from './types.ts';
import { affirmedMention } from './mentions.ts';

export interface DesktopSession {
  checkedAt: string;
  /** The screen is locked (macOS CGSSessionScreenIsLocked; Windows: LogonUI.exe runs). */
  locked?: boolean;
  /** Another user has the console (macOS fast user switching: kCGSSessionOnConsoleKey false). */
  away?: boolean;
}

export function sanitizeDesktop(raw: unknown): DesktopSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.checkedAt !== 'string' || Number.isNaN(Date.parse(r.checkedAt))) return undefined;
  return { checkedAt: new Date(r.checkedAt).toISOString(), ...(r.locked === true ? { locked: true } : {}), ...(r.away === true ? { away: true } : {}) };
}

/** Why computer `id`'s game menus take no clicks now, or undefined: unlocked, or never reported (Linux, an older daemon). */
export function desktopLacks(id: string, d: DesktopSession | undefined): string | undefined {
  if (d?.locked) return `${id}'s screen is locked`;
  if (d?.away) return `${id}'s console is another user's session`;
  return undefined;
}

export const desktopLabel = (d: DesktopSession | undefined): string => (!d ? 'not reported' : d.locked ? 'locked' : d.away ? "another user's session" : 'unlocked');

const MENU_WORDS = [/\bmenus?\b/i, /\blobb(y|ies)\b/i, /\bclick(s|ed|ing)?\b/i, /\bbuttons?\b/i, /\bdialogs?\b/i];

/**
 * Whether words name what a leg clicks: a menu, a lobby, a button, a dialog, other than to rule it out (w2648: w2631's
 * "Direct IP, no Steam, no menus" is no menu click; shared/mentions.ts affirmedMention).
 */
export const mentionsMenus = (...texts: (string | undefined)[]): boolean => texts.some((t) => !!t && MENU_WORDS.some((re) => affirmedMention(t, re)));

/**
 * A request_pair `menus` (or `steam`) that says its legs click none (need none): "none", "no", "false", "off", alone or
 * followed by why (w3455: w3431's worker said steam "none: a direct (non-Steam) host and join", and that was kept as
 * the reason it needed Steam).
 */
export const saysNone = (said: string | undefined): boolean => /^(?:none|no|false|off|not needed|not required)(?:$|[\s:;,.(\u2013\u2014-])/i.test((said ?? '').trim());

/** Why a pair run clicks the game's menus when its words said so and its filer did not (WorkPair.menus). */
export const MENUS_READ = 'read from its words: a menu, a lobby, a click; request_pair menus "none" says it clicks none';

/** Why a pair run's legs click no menus, when its filer or the dispatcher said so (WorkPair.noMenus): its words are not read. */
export const MENUS_NONE = 'none: its legs click no menus, as its filer said (request_pair menus "none")';

/** Whether a pair run's legs click the game's menus: every pair that needs Steam (its lobby is a menu), or one marked so. */
export const pairDrivesMenus = (p: Pick<WorkPair, 'steam' | 'menus'> | undefined): boolean => !!(p?.steam || p?.menus);

/**
 * Work that needs a drawn window (w4868, lothsahn, 2026-11-20: "There's no way to unlock the m3's screen, as Ben is out on
 * vacation. Only run work on m3 it can do with the screen locked"). w4847, an FFU capture check, was started on the locked m3
 * and its worker asked Ben to log in. Measured on the locked m3 (macOS 26.6.2, 2026-11-20): an MTKView window got 0 draw
 * callbacks in 6 s and was never visible, `screencapture -l` of it failed and a full-screen `screencapture` was all black,
 * and the FFU client's window "presented 0 frames in 30 s and 1546 were refused" (w4847); an offscreen Metal render and a
 * batchmode EditMode test run there work. Windows, sourced: a locked session's screen capture fails or is black and
 * injected input goes nowhere (docs/machines.md, "Work that draws a window").
 */
const WINDOW_WORDS = [
  /\bscreen\s?shots?\b/i,
  /\bscreen\s?captures?\b/i,
  /\bcapture\s+(?:checks?|legs?|runs?)\b/i,
  /\bmetal\s+(?:captures?|window|legs?)\b/i,
  /\bplay\s?mode\b(?!\s*tests?)/i,
  /\bgame\s+view\b/i,
  /\blive\s+view\b/i,
  /\bplay\s?test(?:s|ing)?\b/i,
  /\b(?:record(?:s|ing)?|60\s?fps)\s+(?:an?\s+|the\s+)?(?:clips?|videos?)\b/i,
  /\b(?:draws?|drawn|drawing|present(?:s|ed|ing)?)\s+(?:an?\s+|the\s+|its\s+)?(?:window|frames?)\b/i,
  /\bwindowed\s+(?:player|run|app|client)\b/i,
  /\bui_(?:look|check)\b/i,
];

/** Whether words name work that draws a window, other than to rule it out ("headless, no screenshots"). */
export const mentionsWindow = (...texts: (string | undefined)[]): boolean => texts.some((t) => !!t && WINDOW_WORDS.some((re) => affirmedMention(t, re)));

/**
 * Whether request `w` draws a window (w4868): decide_work window says it outright (WorkItem.windowMark), else its title,
 * brief and people's notes (and `text`, a start prompt) name a capture, a screenshot, play mode, the Game view or a Live
 * view, a playtest, a recorded clip or a drawn window. A pair run goes by its menus mark instead (pairDrivesMenus).
 */
export function needsWindow(w: { title?: string; brief?: string; notes?: readonly { text: string }[]; windowMark?: { window: boolean }; pair?: unknown } | undefined, text = ''): boolean {
  if (w?.windowMark) return w.windowMark.window;
  if (w?.pair) return false;
  return mentionsWindow(w?.title, w?.brief, ...(w?.notes ?? []).map((n) => n.text), text);
}

/** "screen locked on m3": why work that draws a window does not go on computer `id` now, or undefined (desktopLacks). */
export function windowLacks(id: string, d: DesktopSession | undefined): string | undefined {
  if (d?.locked) return `screen locked on ${id}`;
  if (d?.away) return `${id}'s console is another user's session`;
  return undefined;
}

/** What a locked screen means, for refusals (w4868). */
export const LOCKED_SCREEN_RULE = `lothsahn, 2026-11-20 (w4868): "Only run work on m3 it can do with the screen locked". A locked screen is never a person's ask: nothing draws there (a window gets no frames, a capture is black), and work that needs a window waits Queued for a computer whose screen is unlocked (list_machines: "screen")`;

const LOCKED_SCREEN_WORDS = /\bscreens?\s+(?:is\s+|are\s+|stays?\s+|still\s+)*locked\b|\blocked\s+screens?\b|\block\s?screen\b|\bscreen\s+lock\b|CGSSessionScreenIsLocked|LogonUI|\bunlock(?:s|ed|ing)?\s+(?:the\s+|its\s+|their\s+|his\s+|her\s+)?(?:screen|display|desktop|session|console|mac|computer|pc|laptop)\b/i;

/**
 * Why a person's card asks them to unlock a screen or log in so a window can draw (w4868), or undefined. A FileVault
 * unlock after a reboot (the computer is offline until then) still goes through.
 */
export function screenUnlockAskProblem(what: string | undefined, questions: readonly string[], who: 'worker' | 'dispatcher'): string | undefined {
  const units = [what, ...questions].filter((u): u is string => !!u?.trim());
  // An ask to unlock or log in at a computer counts too when the card names a window step ("unlock the m3 for the Metal leg").
  const asksUnlock = units.some((u) => LOCKED_SCREEN_WORDS.test(u)) || (units.some((u) => /\bunlock(?:s|ed|ing)?\b|\blog\s?(?:in|on)\b/i.test(u)) && mentionsWindow(...units));
  if (!asksUnlock || units.some((u) => /\bfilevault\b/i.test(u))) return undefined;
  const head = `Nothing was recorded (${LOCKED_SCREEN_RULE}).`;
  return who === 'worker'
    ? `${head} Finish here what needs no window (batchmode builds and EditMode tests, an offscreen render, code). Hand the step that draws a window to a computer whose screen is unlocked: timed_place with machine naming one (list_machines shows each screen), request_pair, or hand_up_requests saying it draws a window. Then end your turn with your report and a line "wNNN: still open: screen locked on <computer>", or blocked_on the leg you filed.`
    : `${head} Mark it decide_work window true and queue it (decide_work queue, needs naming computers whose screen is unlocked): it starts by itself on the first that frees; work that needs no window still goes to the locked computer.`;
}

// A computer's desktop session (w2459, rerun 2 of w2460, 2026-10-28: the host leg went to m5, signed in to Steam but with its
// screen locked, and the game's menus take no clicks on a Mac with a locked screen, so neither check ran). The daemon reads it
// beside its Steam client (machine/steamClient.ts): on macOS CGSessionCopyCurrentDictionary (machine/macDialogs.ts
// SESSION_SCRIPT), on Windows whether LogonUI.exe (the lock screen) runs. A pair run whose legs click the game's menus (every
// pair that needs Steam, a request_pair `menus` mark, or words that name a menu, a lobby or a click) goes only where it is
// unlocked (shared/capacity.ts unfitWhy), and a leg is refused on a locked one (server/agents.ts startPairLegs).
import type { WorkPair } from './types.ts';

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

/** Whether words name what a leg clicks: a menu, a lobby, a button, a dialog. */
export const mentionsMenus = (...texts: (string | undefined)[]): boolean => texts.some((t) => !!t && MENU_WORDS.some((re) => re.test(t)));

/** Why a pair run clicks the game's menus when its words said so and its filer did not (WorkPair.menus). */
export const MENUS_READ = 'read from its words: a menu, a lobby, a click; request_pair menus "none" says it clicks none';

/** Whether a pair run's legs click the game's menus: every pair that needs Steam (its lobby is a menu), or one marked so. */
export const pairDrivesMenus = (p: Pick<WorkPair, 'steam' | 'menus'> | undefined): boolean => !!(p?.steam || p?.menus);

// A person closes a banner about an event (w751, lothsahn: "make it remember when I close the warning at the top that a
// process died and doesn't reopen for the same error"). The server keeps what each person closed in AppSettings.dismissedEvents,
// by user id, so it holds across reloads, devices and portal restarts; the page hides the events they closed. A banner
// is keyed on its events, not on its text: a new event is a new key and shows the banner again, while the same event never does.

import type { UnitWatchdogEvent } from './types.ts';

/** The most keys kept per person: older ones fall off first. A restart only shows for 24 hours, so this is far more than needed. */
export const MAX_DISMISSED_PER_USER = 200;

/** One watchdog event's identity: when, which unit and what it did. The same string server/unitWatchdog.ts uses to report an event once. */
export const unitEventKey = (e: Pick<UnitWatchdogEvent, 'at' | 'unit' | 'action'>): string => `${e.at}|${e.unit}|${e.action}`;

/** The events a person has not closed. `dismissed`: their keys (undefined: none). */
export function undismissed<E extends Pick<UnitWatchdogEvent, 'at' | 'unit' | 'action'>>(events: E[], dismissed: readonly string[] | undefined): E[] {
  if (!dismissed?.length) return events;
  const closed = new Set(dismissed);
  return events.filter((e) => !closed.has(unitEventKey(e)));
}

/** One person's list as AppSettings.dismissedEvents holds it: the user id lowercased, so a login's spelling does not matter. */
export const dismissedUserKey = (userId: string): string => userId.toLowerCase();

/** The map with `keys` added to `userId`'s list (newest last, no repeats, capped); the other people's lists untouched. */
export function withDismissed(map: Record<string, string[]> | undefined, userId: string, keys: readonly string[]): Record<string, string[]> {
  const who = dismissedUserKey(userId);
  const have = map?.[who] ?? [];
  const merged = [...have.filter((k) => !keys.includes(k)), ...new Set(keys)].slice(-MAX_DISMISSED_PER_USER);
  return { ...map, [who]: merged };
}

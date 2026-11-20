// Whether a computer takes work now, one check for every path that picks or plans one: dispatcher placement and start_agent,
// the decide_work queue, timed runs, pair legs, builds and resumes. A computer that is offline (past a daemon's blip) or
// paused (its tray app, its activity pause or its schedule) is unavailable: nothing is placed, queued or planned there, and
// what waits on it moves. Only work pinned to it (WorkItem.machinePin: setup, repair, update or clean-up of that computer,
// or work with no other place to run) waits for it, and that wait is Blocked on the computer, never a question to a person.
// A locked screen is narrower (shared/desktop.ts windowLacks): only work that draws a window keeps off it.
import type { MachinePause } from './types.ts';

/** What list_machines and the dashboard show for a paused computer, in place of "online; ready". */
export const PAUSED_STATE = 'paused; unavailable';

export interface Availability {
  online: boolean;
  pause?: Pick<MachinePause, 'paused'>;
  /** Offline past the blip grace (server/machineAway.ts longAway); undefined: offline counts at once. */
  offlineLong?: boolean;
}

/** "offline" or "paused" when computer `a` takes no work now, else undefined. */
export function unavailableAs(a: Availability | undefined): 'offline' | 'paused' | undefined {
  if (!a) return undefined;
  if (!a.online) return a.offlineLong === false ? undefined : 'offline';
  return a.pause?.paused ? 'paused' : undefined;
}

/** A pinned request's wait, as its Blocked line reads: "needs lothlaptop, which is paused". */
export const needsAwayText = (id: string, as: 'offline' | 'paused') => `needs ${id}, which is ${as}`;

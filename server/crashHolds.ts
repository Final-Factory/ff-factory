// w3740: one crash of a person's machine ends a request's player runs there until a person says yes. Ben, after w3704's
// crash tests took his m3 down twice in one request (19:50Z and 21:37Z, 2026-11-08): "m3 crashed again. you really need
// to stop crashin git. just got it back up again". The game repo's player guard (player_slots.py, FF_PLAYER_GUARD) kills a
// player only after the GPU already restarted, and its 15-minute cool-down spaces runs but never stops them; so the portal
// holds the request instead. A machine that drops mid-turn under a worker (Machines.detach, an unexpected drop: w2433)
// within CRASH_HOLD_WINDOW_MS of that worker's game player or exclusive timing ticket there puts a CrashHold on each
// request the worker holds; the machine's priorities.json carries it to the guard (checkCrashHoldLaunch), which refuses
// that worker's player launches there, and only the person's own orchestrator clears it, with their words
// (clear_crash_hold). A worker that ran on through the drop (a network blip: w2474, or its turn ended before the gate
// cleared) shows the machine never went down, and its hold goes with its gate.
import { harnessTicket } from './benchHolders.ts';
import type { BenchState, BenchTicketGlance, CrashHold, CrashHoldMark, WorkItem } from '../shared/types.ts';

/** How recent a worker's player or timing ticket on a machine must be for that machine's drop to hold its request. */
export const CRASH_HOLD_WINDOW_MS = 30 * 60_000;

/** The game repo's player_slots.py PLAYER_TICKET_WHAT: the shared ticket each player it launches holds while it runs. */
const PLAYER_TICKET = /^running player\b/;

/** A ticket whose work can take a machine down: a game player's, or an exclusive timing ticket's (a timed leg runs players). */
export const riskyTicket = (t: Pick<BenchTicketGlance, 'mode' | 'what' | 'session'>) => !harnessTicket(t) && (t.mode === 'exclusive' || PLAYER_TICKET.test(t.what));

/** The last risky ticket the portal saw of each worker session on one machine: its "what" and when. */
export type PlayerSeen = Map<string, { what: string; at: number }>;

/** Note a machine's bench state (each stats report) into what it last saw of each worker. */
export function noteBench(seen: PlayerSeen, bench: BenchState | undefined, now: number): void {
  for (const t of bench?.running ?? []) if (t.session && riskyTicket(t)) seen.set(t.session, { what: t.what, at: now });
  for (const [sid, v] of seen) if (now - v.at > CRASH_HOLD_WINDOW_MS) seen.delete(sid);
}

/** The workers among `sessionIds` with a risky ticket seen within the window, each with why (by full id; a ticket may carry a prefix). */
export function recentPlayers(seen: PlayerSeen | undefined, sessionIds: readonly string[], now: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!seen) return out;
  for (const sid of sessionIds) {
    for (const [ticketSession, v] of seen) {
      if (now - v.at > CRASH_HOLD_WINDOW_MS || !(ticketSession === sid || sid.startsWith(ticketSession))) continue;
      out[sid] = `its "${v.what.slice(0, 80)}" ticket there, last seen ${new Date(v.at).toISOString().slice(11, 16)}Z`;
      break;
    }
  }
  return out;
}

/** A request's crash holds that still hold, on one machine or all. */
export const liveCrashHolds = (w: Pick<WorkItem, 'crashHolds'>, machine?: string) => (w.crashHolds ?? []).filter((h) => !h.cleared && (!machine || h.machine === machine));

/** The mark priorities.json carries for a worker on `machine` serving `open`, or undefined when none of them is held there. */
export function crashHoldMark(open: readonly Pick<WorkItem, 'id' | 'crashHolds'>[], machine: string): CrashHoldMark | undefined {
  const held = open.map((w) => ({ w, h: liveCrashHolds(w, machine)[0] })).filter((x): x is { w: (typeof open)[number]; h: CrashHold } => !!x.h);
  if (!held.length) return undefined;
  return { at: held[0].h.at, why: held[0].h.why, requests: held.map((x) => x.w.id) };
}

/** "m3 dropped at 21:37Z with w3704's worker 7d906e95 mid-turn (its "running player pid 1 slot 0" ticket there, ...)". */
export const crashHoldLine = (w: Pick<WorkItem, 'id'>, h: CrashHold) => `${h.machine} dropped at ${h.at.slice(11, 16)}Z with ${w.id}'s worker ${h.worker} mid-turn (${h.why})${h.cleared ? `; cleared ${h.cleared.slice(0, 16)}Z by ${h.clearedBy}${h.words ? `: "${h.words}"` : ''}` : ''}`;

/** What a held worker's resume says (w3740): why its player launches there are refused, what to do, and how it clears. */
export function crashHoldNote(machine: string, requests: readonly string[]): string {
  return (
    ` Crash hold (w3740): ${machine} went offline while you ran a game player or a timed leg there, so FF Factory treats it as a crash of a person's machine: ${requests.join(', ')} launches no game player on ${machine} (player_slots.py launch or the binary: the guard refuses it) until a person says yes. ` +
    `Do not start another crash, repro or bench run there. Collect what the crash left (panic, gpuEvent and WindowServer reports, hang reports, Player.log, each leg's times), publish it, and ask that machine's person with waiting_on_person whether to run there again; their orchestrator clears the hold with their own words (clear_crash_hold). ` +
    'Work that needs no player on it goes on meanwhile (evidence-gate checklists/crash-repro.md).'
  );
}

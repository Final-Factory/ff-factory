/**
 * w5328: a worker that waits on another computer's daemon update resumes on that computer.
 *
 * w5319 (2026-11-23): its worker was moved m5 -> lothdesktop for a free seat (w2046), merged ff-factory #1109 (a macOS-only
 * fix) and waited with blocked_on deploys ["m5"] to run the check after it on m5. When m5's daemon updated, the gate resume
 * (Orchestrators.resumeGatedWorker, w890) went to the worker where it was, on lothdesktop, a Windows PC where the check cannot
 * run, and the check had to be handed up as a new request (w5327). lothsahn: "when a worker waits on deploys:[<machine id>]
 * for a machine other than its own, resume it on that machine (a seat there)".
 *
 * The design: a deploy gate on a machine names where its check runs, so no new blocked_on argument. When such a gate clears and
 * none of the machines named is the worker's own, the request records `resumeOn` (WorkItem.resumeOn). The send queue
 * (SessionManager.drainOnce -> Agents.deployMove) then moves that resume to one of them with the w2046 move (Agents.moveForRoom:
 * a fresh session in a free sandbox there switched to its branch for game work, an agent seat for agent work; the old sandbox
 * released). moveDecision decides it with the request pinned to those machines, so:
 *  - no room there (no free sandbox, no agent seat): the resume waits Queued for it, and never falls back to another computer;
 *  - the machine held (placement.hold) or offline: the same wait, its Queued line saying so; it goes once the machine is back;
 *  - its work only on its own computer (unpushed commits, a bench lock, a timed leg): it resumes where it is, told that the
 *    check is on the named machine (moving would lose the work). A worker released for its deploy wait (w890) pushed first.
 * A gate on "portal" or the machines' rollout names no computer and resumes as before.
 */
import type { WorkBlocker } from '../shared/types.ts';
import { placeId } from './placement.ts';

/** The mark on a Queued line while a deploy-gate resume waits for room on the machine it waited for. */
export const DEPLOY_WAIT_MARK = 'it resumes on the computer whose update it waited for (w5328)';

/**
 * The computers a cleared set of gates says the resume must run on (w5328), or undefined: the deploy gates naming a known
 * machine (not "portal", not the rollout's "machines"), when none of them is the worker's own computer `own`.
 */
export function deployResumeOn(gates: readonly WorkBlocker[], own: string | undefined, known: readonly string[]): string[] | undefined {
  const ids = new Set(known.map(placeId));
  const named = [...new Set(gates.filter((g) => g.kind === 'deploy' && g.ref?.trim()).map((g) => placeId(g.ref!)))].filter((m) => ids.has(m));
  if (!named.length) return undefined;
  if (own && named.includes(placeId(own))) return undefined;
  return named;
}

/** The resume note's sentence for a request whose resume goes to `machines` (w5328). */
export const deployResumeNote = (machines: readonly string[]) =>
  ` The check after ${machines.join(' or ')}'s update runs there: FF Factory resumes this on ${machines.join(' or ')}, in a fresh session if you are on another computer (w5328).`;

/** The Queued line while it waits for room (or the machine) there. */
export const deployWaitLine = (machines: readonly string[], why: string) => `${DEPLOY_WAIT_MARK}: it waits for ${machines.join(' or ')}; ${why}`;

/** The first lines of the session that carries it on there. */
export function deployLead(m: { id: string; worker: string; from: string; machines: readonly string[]; to: string; why: string }): string {
  return `[moved, w5328] FF Factory moved ${m.id} to this computer: its worker ${m.worker} on ${m.from} waited with blocked_on for ${m.machines.join(' or ')}'s daemon update, which has happened, and the check that comes after it runs on ${m.machines.join(' or ')}, not on ${m.from.split('/')[0]} (${m.why}). That worker is stopped and its sandbox released; you carry ${m.id} on from where it left off: do the check after the update here now. The handover below says where its work is (its branch, pushed) and carries the message that resumed it.`;
}

/** What the worker is told when its resume stays where it is although it waited for another computer (moving would lose work). */
export const deployStayNote = (machines: readonly string[], here: string, why: string) =>
  `\n\n[w5328] The check after ${machines.join(' or ')}'s update runs on ${machines.join(' or ')}, but FF Factory resumed you here on ${here}: ${why}. Push your work, then run the check on ${machines.join(' or ')} (hand it up with hand_up_requests if it cannot run here).`;

// The dry-run switch (docs/portal-on-ffbox-host.md, change 17; w499): FFSB_DRY_RUN=1 starts the portal on a copy of
// another portal's data with every part that acts outside it off, so the copy can be loaded, signed in to and checked
// while the real portal keeps running. Off: wakes, timers, the orchestrator heartbeat, standing runs, intake polls and
// the ledger sweep, push notifications, the FFBox connector link, Discord (Max), machine daemon links, deploys,
// redeploys, daemon control and relocate, the outside watch, the orchestrator memory's git push, the usage poll, the
// resume after a restart, republish_public, and starting any agent but an orchestrator a person writes to. Config holds
// no Claude token to defuse (w1078: every Claude process runs on a vault token), and the start does not change config.json.
// Each part checks dryRun() where it would act; the switch is read from the environment, so it applies from the
// first line of the server on and cannot be turned off without a restart.

import type { SessionKind } from '../shared/types.ts';

/** Whether this portal runs as a dry run (FFSB_DRY_RUN=1 in its environment). */
export const dryRun = (env: NodeJS.ProcessEnv = process.env): boolean => env.FFSB_DRY_RUN === '1';

/** Why something is off, for refusals and logs. */
export const DRY_RUN_WHY = 'this portal is a dry run (FFSB_DRY_RUN=1): it acts on nothing outside itself';

/** What the banner and the health answer say. */
export const DRY_RUN_BANNER =
  'Nothing here acts outside: no wakes, timers, heartbeats or standing runs, no intake, push, FFBox link or Discord, no machine links, deploys or relocates, and no workers. Only a person writing to an orchestrator starts one.';

/** Throw the dry run's refusal when it is on. `what`: the action, e.g. "deploy m5". */
export function refuseInDryRun(what: string): void {
  if (dryRun()) throw new Error(`${what}: refused, ${DRY_RUN_WHY}`);
}

/**
 * Why a Claude process may not start in a dry run, or undefined: only an orchestrator (the dispatcher included) a
 * person writes to starts. A worker, a standing agent, an agent on a machine, and an orchestrator woken by the server
 * itself (a wake, a timer, a restart note, another agent) do not.
 */
export function dryRunStartRefusal(s: { kind: SessionKind; machineId?: string }, from: 'human' | 'orchestrator' | 'system'): string | undefined {
  if (!dryRun()) return undefined;
  if (s.kind === 'orchestrator' && !s.machineId && from === 'human') return undefined;
  return s.kind === 'orchestrator' ? `${DRY_RUN_WHY}; only a person's message starts an orchestrator here` : DRY_RUN_WHY;
}

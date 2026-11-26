// w5916: what a person's hold on a machine does to its CI runners (machine/loadRunners.ts), as the portal shows it.

/** w5916: what the hold does to this machine's runners, for the portal (list_machines, list_sandboxes, the machine page). */
export interface RunnerHoldReport {
  /** The hold's words, as the portal sent them. */
  why: string;
  since: string;
  /** Runners suspended by the hold (or paused by a timed run meanwhile): they take no job. */
  stopped: string[];
  /** Runners the hold waits on: a job runs, or it was just handed one. */
  busy: string[];
  /** Runners that ended while held and start again when it lifts. */
  startOnLift: string[];
}

/** w5916: the hold's effect on a machine's runners in a few words ("runners draining (1 busy)"), or undefined with none. */
export function runnerHoldText(r: RunnerHoldReport | undefined): string | undefined {
  if (!r) return undefined;
  const lift = r.startOnLift.length ? `; ${r.startOnLift.length} start again when it lifts` : '';
  if (r.busy.length) return `runners draining (${r.busy.length} busy: ${r.busy.join(', ')}${r.stopped.length ? `; ${r.stopped.length} stopped` : ''})${lift}`;
  if (r.stopped.length) return `runners stopped by hold (${r.stopped.join(', ')})${lift}`;
  return lift ? `runners stopped by hold${lift}` : undefined;
}

const names = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === 'string') ? v.slice(0, 64).map((s) => s.slice(0, 120)) : undefined;

/**
 * w5916: a daemon's runner_hold report as the portal keeps it: the report, null when it says there is no hold, or
 * undefined for a malformed one (kept out of the store, which every list reads).
 */
export function runnerHoldReportOf(v: unknown): RunnerHoldReport | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const stopped = names(o.stopped), busy = names(o.busy), startOnLift = names(o.startOnLift ?? []);
  if (typeof o.why !== 'string' || typeof o.since !== 'string' || !stopped || !busy || !startOnLift) return undefined;
  return { why: o.why.slice(0, 500), since: o.since, stopped, busy, startOnLift };
}

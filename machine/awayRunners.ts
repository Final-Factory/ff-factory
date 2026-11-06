// w3147: CI legs on runners that are away. Final-Factory/ffu's only macOS runners (ffu-m3, ffu-m3-2) live on the m3; while
// every ffu-macos runner is offline, an ffu pull request merges on green Linux and Windows legs (Ben's standing rule), so a
// macOS leg still queued neither holds nor fails CI's verdict. A leg that started, or finished red, counts as usual, and the
// workflow keeps its macOS jobs: they run once the m3 is back. Measured 2026-11-06 04:08Z: 56 ffu-macos jobs queued up to
// 274 min with both m3 runners offline, while Linux and Windows kept up, and every ffu CI wait sat "still running".
// Read by ff-pr (machine/prFlow.ts) and the portal's CI waits (server/blockerWatch.ts).

/** Runner labels, by repository, whose queued legs do not hold CI while every runner carrying the label is offline. */
export const AWAY_LABELS: Record<string, readonly string[]> = { 'Final-Factory/ffu': ['ffu-macos'] };

/**
 * The FF Factory machine whose runners carry each away label. Listing a repository's self-hosted runners needs its
 * Administration: read permission, which the portal's fine-grained tokens lack (measured 2026-11-06 04:45Z: no ffu CI wait
 * settled after #829 deployed); FF Factory's own link to that machine stands in when the runner list cannot be read.
 */
export const AWAY_MACHINES: Record<string, string> = { 'ffu-macos': 'm3' };

/** The labels of `labels` whose machine FF Factory sees offline (`online` answers false; undefined, an unknown machine, is not away). */
export function offlineByMachine(labels: readonly string[], online?: (machineId: string) => boolean | undefined): string[] {
  if (!online) return [];
  return labels.filter((l) => AWAY_MACHINES[l] !== undefined && online(AWAY_MACHINES[l]) === false);
}

export function awayLabelsOf(repo: string): readonly string[] {
  const k = Object.keys(AWAY_LABELS).find((r) => r.toLowerCase() === repo.toLowerCase());
  return k ? AWAY_LABELS[k] : [];
}

export interface Runner {
  status?: string;
  labels?: { name?: string }[];
}

/** The labels of `labels` that some runner carries and every runner carrying them is offline (GET .../actions/runners). */
export function offlineLabels(body: { runners?: Runner[] }, labels: readonly string[]): string[] {
  const runners = body.runners ?? [];
  return labels.filter((l) => {
    const with_ = runners.filter((r) => (r.labels ?? []).some((x) => x.name === l));
    return with_.length > 0 && with_.every((r) => (r.status ?? '').toLowerCase() === 'offline');
  });
}

export interface Leg {
  name?: string;
  status?: string;
  conclusion?: string | null;
  labels?: string[];
}

const QUEUED = new Set(['queued', 'pending', 'waiting', 'requested', 'expected']);
const GOOD = new Set(['success', 'skipped', 'neutral']);

/** A leg not yet started on one of the `away` labels (its runs-on labels, or a matrix name like "test (ffu-macos)"). */
export function isAwayLeg(leg: Leg, away: readonly string[]): boolean {
  if (!away.length || !QUEUED.has((leg.status ?? '').toLowerCase())) return false;
  return away.some((l) => (leg.labels ?? []).includes(l) || (leg.name ?? '').endsWith(`(${l})`));
}

/**
 * A run's jobs (GET .../actions/runs/{id}/jobs) wait only on away legs: something is unfinished, all of it is an away leg,
 * and every finished job passed or was skipped. Such a run counts as green.
 */
export function awaitsOnlyAway(jobs: Leg[], away: readonly string[]): boolean {
  const open = jobs.filter((j) => (j.status ?? '').toLowerCase() !== 'completed');
  if (!open.length || !open.every((j) => isAwayLeg(j, away))) return false;
  return jobs.filter((j) => (j.status ?? '').toLowerCase() === 'completed').every((j) => GOOD.has((j.conclusion ?? '').toLowerCase()));
}

const BAD = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required']);

/** The finished legs of a run's jobs that failed (ffu's ci.yml has no continue-on-error, so each fails the run). */
export function failedLegs(jobs: Leg[]): Leg[] {
  return jobs.filter((j) => (j.status ?? '').toLowerCase() === 'completed' && BAD.has((j.conclusion ?? '').toLowerCase()));
}

/**
 * w3272: how an unfinished run's jobs settle CI's verdict before the run itself ends. A leg that failed ends it red at once:
 * ffu #318 (run 42254706033) had test (ffu-windows) fail at 16:46:56Z with both macOS legs queued, every m3 runner
 * offline, and its CI wait sat "still running" until the 6 h cut-off at 22:42Z, because only an all-green run was settled.
 * Else a run waiting only on away legs is green (w3147). Else undefined: still running.
 */
export function settleJobs(jobs: Leg[], away: readonly string[]): { conclusion: 'failure'; failed: string[] } | { conclusion: 'success'; legs: number } | undefined {
  const failed = failedLegs(jobs);
  if (failed.length) return { conclusion: 'failure', failed: failed.map((j) => j.name ?? '?') };
  if (awaitsOnlyAway(jobs, away)) return { conclusion: 'success', legs: jobs.filter((x) => isAwayLeg(x, away)).length };
  return undefined;
}

export const failedNote = (failed: string[]) => ` (${failed.slice(0, 3).join(', ')} failed${failed.length > 3 ? `, ${failed.length - 3} more` : ''}; the run's other legs not waited for, w3272)`;

export const awayNote = (n: number, away: readonly string[]) => `; ${n} ${away.join('/')} leg${n === 1 ? '' : 's'} still queued with every ${away.join('/')} runner offline, not waited for (w3147)`;

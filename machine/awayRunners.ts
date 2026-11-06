// w3147: CI legs on runners that are away. Final-Factory/ffu's only macOS runners (ffu-m3, ffu-m3-2) live on the m3; while
// every ffu-macos runner is offline, an ffu pull request merges on green Linux and Windows legs (Ben's standing rule), so a
// macOS leg still queued neither holds nor fails CI's verdict. A leg that started, or finished red, counts as usual, and the
// workflow keeps its macOS jobs: they run once the m3 is back. Measured 2026-11-06 04:08Z: 56 ffu-macos jobs queued up to
// 274 min with both m3 runners offline, while Linux and Windows kept up, and every ffu CI wait sat "still running".
// Read by ff-pr (machine/prFlow.ts) and the portal's CI waits (server/blockerWatch.ts).

/** Runner labels, by repository, whose queued legs do not hold CI while every runner carrying the label is offline. */
export const AWAY_LABELS: Record<string, readonly string[]> = { 'Final-Factory/ffu': ['ffu-macos'] };

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

export const awayNote = (n: number, away: readonly string[]) => `; ${n} ${away.join('/')} leg${n === 1 ? '' : 's'} still queued with every ${away.join('/')} runner offline, not waited for (w3147)`;

/**
 * What the ledger cleanup's merged-request rules would do now (w419; docs/orchestrators.md, "Ledger cleanup"), on a COPY
 * of a portal's data folder, changing nothing: which requests the pull-request rule would close (every linked PR merged,
 * nothing left after the merge), which ones it would ask its worker "Is it done?" about, and which it would stall as
 * follow-up unconfirmed, and which a worker's DONE, refused then, closes now (w515: Orchestrators.recheckDone). It uses
 * the PR states the copy has stored (no gh), the same rules as server/ledgerSweep.ts and its skip for a worker running on
 * the request.
 *
 *   node scripts/ledger-dry-run.ts <data dir> [w342,w10] [at=2026-10-05T08:00Z]
 *
 * at= runs the rules as of that time instead of now (the copy's sessions and PRs stay as they were).
 */
import { afterMergeReason, doneProblem, followUpDecision, followUpDue, partOfReason } from '../server/ledgerRules.ts';
import { servedBy } from '../shared/workState.ts';
import { ledgerStates } from './ledger-states.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

const BUSY = new Set<SessionInfo['status']>(['running', 'starting', 'waiting_permission']);
const OPEN = new Set<WorkItem['status']>(['new', 'question', 'queued', 'active']);

export interface DryRunLine {
  id: string;
  does: 'close' | 'ask' | 'stall' | 'wait';
  why: string;
}

export function dryRun(work: readonly WorkItem[], session: (id: string) => SessionInfo | undefined, now: number, canResume = true): DryRunLine[] {
  const out: DryRunLine[] = [];
  for (const w of work) {
    if (!OPEN.has(w.status) || w.approval?.state === 'pending') continue;
    const prs = w.prs ?? [];
    const merged = prs.filter((p) => p.state === 'merged');
    if (!merged.length || prs.some((p) => p.state === 'open')) continue;
    const workers = w.sessionIds.map(session).filter((s): s is SessionInfo => !!s);
    const busy = workers.filter((s) => BUSY.has(s.status));
    const busyHere = busy.some((s) => servedBy(s.id, work).has(w.id));
    if (busyHere) {
      out.push({ id: w.id, does: 'wait', why: `a worker is running on it (${busy.map((s) => s.id).join(', ')})` });
      continue;
    }
    // A DONE refused while a PR was open (w515): it closes now when nothing is missing and nobody else is still on it.
    const said = Object.entries(w.done ?? {}).sort((a, b) => b[1].at.localeCompare(a[1].at))[0];
    const stillOn = workers.filter((s) => !w.done?.[s.id] && s.status !== 'stopped' && s.status !== 'error' && servedBy(s.id, work).has(w.id));
    if (said && !stillOn.length && !w.question && !w.flag) {
      const problem = doneProblem(w, said[1].text ?? said[1].report);
      if (!problem) {
        out.push({ id: w.id, does: 'close', why: `worker ${said[0]}'s DONE of ${said[1].at.slice(11, 16)} UTC, refused then, passes now (every linked PR merged)` });
        continue;
      }
    }
    const reason = partOfReason(w.id, prs) ?? afterMergeReason(w, workers.map((s) => s.lastResult ?? ''));
    if (!reason) {
      if (!busy.length) out.push({ id: w.id, does: 'close', why: `every linked PR merged (${merged.map((p) => `#${p.number}`).join(', ')}) and nothing is left after the merge` });
      continue;
    }
    if (w.question || w.flag) continue;
    const d = followUpDecision(w, workers, reason, now, (s) => servedBy(s.id, work).has(w.id), canResume);
    if (!d) {
      const due = followUpDue(w, workers, (s) => servedBy(s.id, work).has(w.id));
      out.push({ id: w.id, does: 'wait', why: `still open: ${reason}; the cleanup asks from ${new Date(due).toISOString().slice(0, 16).replace('T', ' ')} UTC (6 h after the last word about it)` });
      continue;
    }
    out.push(d.kind === 'ask' ? { id: w.id, does: 'ask', why: `worker ${d.worker.id} (${d.worker.status}), no word for ${d.quietHours} h; still open: ${d.why}` } : { id: w.id, does: 'stall', why: d.why });
  }
  return out;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}`) {
  const args = process.argv.slice(2);
  const at = args.find((a) => a.startsWith('at='));
  const [dir, check] = args.filter((a) => !a.startsWith('at='));
  const now = at ? Date.parse(at.slice(3)) : Date.now();
  if (!dir) {
    console.error('usage: node scripts/ledger-dry-run.ts <copy of a data dir> [w342,w10]');
    process.exit(2);
  }
  const { work, sessions } = ledgerStates(dir);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  console.log(`As of ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
  const lines = dryRun(work, (id) => byId.get(id), now);
  for (const does of ['close', 'ask', 'stall', 'wait'] as const) {
    const rows = lines.filter((l) => l.does === does);
    console.log(`\nWould ${does} (${rows.length}):`);
    for (const l of rows) console.log(`  ${l.id}: ${l.why} | ${work.find((w) => w.id === l.id)?.title.slice(0, 70)}`);
  }
  if (check) {
    console.log('\nChecked:');
    for (const id of check.split(',').map((x) => x.trim())) {
      const l = lines.find((x) => x.id === id);
      console.log(`  ${id}: ${l ? `would ${l.does}: ${l.why}` : 'not a merged open request: the merged-request rules leave it alone'}`);
    }
  }
}

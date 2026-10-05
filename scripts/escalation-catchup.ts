/**
 * What w480's one-time catch-up would follow (docs/intake.md, "Escalations from Max"), on a COPY of a portal's data folder,
 * changing nothing: the escalated requests closed done in the last 14 days, each with the FFBox board ref its thread's
 * merge notice waits on, and what the done answer can already say (the fixing PR, the release) or still has to learn.
 * The portal runs the same selection (server/boardFollow.ts escalationCatchUp) once at startup and pushes each thread
 * its done answer; FFBox's once-only guards keep a thread that was already told from hearing it twice.
 *
 *   node scripts/escalation-catchup.ts <copy of a data dir> [days=14] [at=2026-10-05T08:00Z]
 */
import { escalationCatchUp, fixedByPr, followed, type CatchUpLine } from '../server/boardFollow.ts';
import { ledgerStates } from './ledger-states.ts';
import type { WorkItem } from '../shared/types.ts';

/** One line per thread: the ref, the request, and what its fix is known or still to be learnt from. */
export function catchUpReport(lines: readonly CatchUpLine[], work: ReadonlyMap<string, WorkItem>): string[] {
  return lines.map((l) => {
    const w = followed(l.followId, work)!;
    const d = w.delivery ?? {};
    const pr = d.fixPr ?? w.autoClosed?.pr ?? fixedByPr(w.outcome);
    const fix = d.fixCommit ? `fix ${d.fixCommit.slice(0, 12)}` : w.autoClosed?.sha ? `closed by merge ${w.autoClosed.sha.slice(0, 12)}` : pr ? `PR #${pr} to look up` : 'no fix named: FFBox says "Fixed, coming in the next beta build"';
    const via = l.followId === l.workId ? l.workId : `${l.workId} (merged into ${l.followId})`;
    return `${l.ref} thread ${l.threadId}: ${via}, closed ${l.closedAt.slice(0, 16).replace('T', ' ')}; ${fix}${pr && d.fixCommit ? `, PR #${pr}` : ''}${d.releasedIn ? `, in ${d.releasedIn}` : ''} | ${l.title.slice(0, 60)}${l.outcome ? ` | ${l.outcome.slice(0, 80)}` : ''}`;
  });
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}`) {
  const args = process.argv.slice(2);
  const at = args.find((a) => a.startsWith('at='));
  const days = args.find((a) => a.startsWith('days='));
  const [dir] = args.filter((a) => !a.includes('='));
  if (!dir) {
    console.error('usage: node scripts/escalation-catchup.ts <copy of a data dir> [days=14] [at=2026-10-05T08:00Z]');
    process.exit(2);
  }
  const now = at ? Date.parse(at.slice(3)) : Date.now();
  const work = new Map(ledgerStates(dir).work.map((w) => [w.id, w]));
  const lines = escalationCatchUp(work, now, days ? Number(days.slice(5)) : 14);
  console.log(`Escalated threads the catch-up would follow, as of ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC (${lines.length}):`);
  for (const l of catchUpReport(lines, work)) console.log(`  ${l}`);
}

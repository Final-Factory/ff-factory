/**
 * What w502's one-time report sweep finds (docs/intake.md, "Players' reports a request fixed"), on a COPY of a portal's
 * data folder, changing nothing: the finished requests that claim player reports (FFBox is told they are fixed once the
 * fix ships), and the ones that only mention report ids (listed for Lothsahn, never marked on a guess).
 *
 *   node scripts/report-sweep.ts <copy of a data dir> [days=30] [at=2026-10-05T08:00Z]
 */
import { reportSweep } from '../server/boardFollow.ts';
import { ledgerStates } from './ledger-states.ts';

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}`) {
  const args = process.argv.slice(2);
  const at = args.find((a) => a.startsWith('at='));
  const days = args.find((a) => a.startsWith('days='));
  const [dir] = args.filter((a) => !a.includes('='));
  if (!dir) {
    console.error('usage: node scripts/report-sweep.ts <copy of a data dir> [days=30] [at=2026-10-05T08:00Z]');
    process.exit(2);
  }
  const now = at ? Date.parse(at.slice(3)) : Date.now();
  const work = new Map(ledgerStates(dir).work.map((w) => [w.id, w]));
  const s = reportSweep(work, now, days ? Number(days.slice(5)) : 30);
  console.log(`Finished requests that claim reports (${s.certain.length}): FFBox is told they are fixed once the fix ships`);
  for (const c of s.certain) console.log(`  ${c.workId}: ${c.reportIds.join(', ')}${c.released ? '' : ' (fix not merged and released yet)'}`);
  console.log(`\nFinished requests that only mention reports (${s.uncertain.length}): for Lothsahn to confirm (update_work subjects)`);
  for (const u of s.uncertain) console.log(`  ${u.workId} "${u.title.slice(0, 70)}": ${u.reportIds.join(', ')}`);
}

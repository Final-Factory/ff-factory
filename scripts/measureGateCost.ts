// w3758: what one request blocked on a pull request's CI costs on GitHub per read, measured against real pull requests. Runs
// the blocker watch's own readers (ghPrHealth, then ghChecks) through a runner that runs gh and counts each call: REST, REST
// answered 304 (free), GraphQL. `--before` reads as the portal did before w3758 (no shared head, no remembered refusals, no
// ETags). Usage: node scripts/measureGateCost.ts [--before] [--rounds N] owner/repo#123 ... It only reads.
import { run as runProc, type RunOptions } from '../server/proc.ts';
import { ghChecks, ghPrHealth, type CheckReads } from '../server/blockerWatch.ts';

type Tally = { rest: number; rest304: number; graphql: number; failed: number };

const args = process.argv.slice(2);
const before = args.includes('--before');
const ri = args.indexOf('--rounds');
const rounds = ri >= 0 ? Number(args[ri + 1]) : 2;
const refs = args.filter((a, i) => /#\d+$/.test(a) && args[i - 1] !== '--rounds');
if (!refs.length) throw new Error('usage: node scripts/measureGateCost.ts [--before] [--rounds N] owner/repo#123 ...');

const t: Tally = { rest: 0, rest304: 0, graphql: 0, failed: 0 };
const run = async (cmd: string, a: string[], opts?: RunOptions) => {
  const r = await runProc(cmd, a, opts);
  if (cmd === 'gh') {
    const graphql = a[0] === 'pr' || (a[0] === 'api' && a.includes('graphql'));
    const is304 = /^HTTP\/[\d.]+ 304/.test(r.stdout);
    if (graphql) t.graphql++;
    else if (is304) t.rest304++;
    else t.rest++;
    if (r.code !== 0 && !is304) t.failed++;
  }
  return r;
};
const refused = new Map<string, number>();
for (let i = 1; i <= rounds; i++) {
  const s = { ...t };
  for (const ref of refs) {
    const h = await ghPrHealth(ref, run);
    const reads: CheckReads | undefined = before ? undefined : { refused, known: h.head ? { state: h.state.toUpperCase(), head: h.head } : undefined };
    const c = await ghChecks(ref, run, undefined, reads).catch((e: Error) => ({ text: `unreadable: ${e.message.slice(0, 120)}` }));
    if (i === 1) console.log(`${ref}: ${c.text}`);
  }
  console.log(`round ${i} (${before ? 'before' : 'after'}), ${refs.length} gate(s): REST ${t.rest - s.rest}, free 304s ${t.rest304 - s.rest304}, GraphQL ${t.graphql - s.graphql}, failed ${t.failed - s.failed}`);
}

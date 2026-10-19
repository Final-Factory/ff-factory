// What the context meter leaves `unitemised`, replayed (w1556): Claude Code's own transcripts (its jsonl) through the ContextMeter,
// cut into the processes each shows and resumed from the last one's snapshot as AgentSession does (server/cliTranscript.ts
// replayLines), twice: as the stream alone showed it (`stream`) and with what the transcript adds out of the stream's view
// (`hidden`: reminders, hook output, the base a resumed process sends again, the CLI's own task notifications; what AgentSession
// feeds the meter since w1556). Prints each category's share of the list-price dollars both ways. A diagnostic run by hand
// (docs/spend.md "What unitemised was (w1556)"), not a test.
//
//   node scripts/meter-unitemised.ts <transcript.jsonl>... [--carry-first] [--json <file>]
//
// --carry-first: the first resume finds no saved tally (carry()), as a conversation that crossed the w1484 deploy, or moved to
// another machine without its tally, did.
import fs from 'node:fs';
import { addCats, type Cats } from '../shared/spend.ts';
import { readCliLines, replayLines } from '../server/cliTranscript.ts';

export interface Replay {
  file: string;
  calls: number;
  processes: number;
  compactions: number;
  stream: Cats;
  hidden: Cats;
  resumed: string[];
}

export function replay(file: string, carryFirst = false): Replay {
  const lines = readCliLines(file);
  const one = (hidden: boolean) => {
    let cats: Cats = {};
    let compactions = 0;
    const resumed: string[] = [];
    const r = replayLines(lines, {
      hidden,
      carryFirst,
      onTurn: (t) => {
        cats = addCats(cats, t.cats);
        if (t.compacted) compactions++;
        if (t.resumed) resumed.push(t.resumed.kept ? `${t.resumed.by}:${Math.round(t.resumed.base / 1000)}k` : 'carried');
      },
    });
    return { cats, compactions, resumed, calls: r.calls, processes: r.processes };
  };
  const s = one(false);
  const h = one(true);
  return { file, calls: s.calls, processes: s.processes, compactions: s.compactions, stream: s.cats, hidden: h.cats, resumed: h.resumed };
}

const usd = (c: Cats) => Object.values(c).reduce((x, y) => x + y.usd, 0);
export function table(stream: Cats, hidden: Cats): string {
  const ts = usd(stream);
  const th = usd(hidden);
  const keys = [...new Set([...Object.keys(stream), ...Object.keys(hidden)])].sort((x, y) => (hidden[y]?.usd ?? 0) - (hidden[x]?.usd ?? 0));
  const out = [`category        stream $     %    hidden $     %   (list-price totals ${ts.toFixed(2)} and ${th.toFixed(2)})`];
  for (const k of keys) {
    const s = stream[k]?.usd ?? 0;
    const h = hidden[k]?.usd ?? 0;
    out.push(`${k.padEnd(14)} ${s.toFixed(2).padStart(9)} ${((100 * s) / ts).toFixed(1).padStart(5)} ${h.toFixed(2).padStart(10)} ${((100 * h) / th).toFixed(1).padStart(5)}`);
  }
  return out.join('\n');
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/meter-unitemised.ts')) {
  const args = process.argv.slice(2);
  const ji = args.indexOf('--json');
  const files = args.filter((a, i) => !a.startsWith('--') && (ji < 0 || i !== ji + 1));
  const carryFirst = args.includes('--carry-first');
  let s: Cats = {};
  let h: Cats = {};
  const all: Replay[] = [];
  for (const f of files) {
    const r = replay(f, carryFirst);
    all.push(r);
    s = addCats(s, r.stream);
    h = addCats(h, r.hidden);
    console.log(`${f.split(/[\\/]/).pop()}: ${r.calls} calls, ${r.processes} processes, ${r.compactions} compactions; resumes: ${r.resumed.join(' ') || 'none'}`);
  }
  console.log(table(s, h));
  if (ji >= 0) fs.writeFileSync(args[ji + 1], JSON.stringify(all, null, 1));
}

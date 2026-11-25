/**
 * w5679: one coverage table from the unit-test shards. CI's Linux unit run is split across runners (`node --test
 * --test-shard=i/n`), each writing node's lcov report of the files its tests loaded; a file loaded by tests in two shards
 * shows up in both. This adds them up (a line's, a function's and a branch's hits summed) and prints the table node's
 * own `--experimental-test-coverage` prints for one run: the coverage of the whole suite, none lost to the split.
 *
 * Lines add up exactly. Functions and branches are matched by line and their order on it, because lcov carries no source
 * offsets and node numbers them by what each process ran; a process can also put one branch on another line. Measured on
 * 40 script test files, one run against two shards merged: lines equal, branches 62.71% against 62.97%, functions 17.43%
 * against 17.44% (w5679). Read the branch and function columns as within about half a point.
 *
 *   node scripts/lcov-merge.ts <shard-1.lcov> <shard-2.lcov> ...
 */
import fs from 'node:fs';
import path from 'node:path';

export interface FileCov {
  /** Line -> hits. */
  lines: Map<number, number>;
  /** "line#k" (the k-th function on that line) -> hits. */
  funcs: Map<string, number>;
  /** "line#k" (the k-th branch on that line) -> hits. */
  branches: Map<string, number>;
}

const add = <K>(m: Map<K, number>, k: K, n: number) => m.set(k, (m.get(k) ?? 0) + n);

/** Fold one lcov report into `into`, keyed by the file's path relative to `cwd`. */
export function addLcov(into: Map<string, FileCov>, text: string, cwd = process.cwd()): void {
  let cur: FileCov | undefined;
  // Keyed by line and order on the line, not by node's names and block numbers: those count up through what one process
  // ran (anonymous_5, block 3), so the same function or branch has another number in another shard (w5679, measured).
  const fnKey = new Map<string, string>();
  const nth = new Map<string, number>();
  const next = (kind: string, line: string) => {
    const k = nth.get(`${kind}${line}`) ?? 0;
    nth.set(`${kind}${line}`, k + 1);
    return `${line}#${k}`;
  };
  for (const raw of text.split(/\r?\n/)) {
    const at = raw.indexOf(':');
    const tag = at < 0 ? raw : raw.slice(0, at);
    const v = at < 0 ? '' : raw.slice(at + 1);
    if (tag === 'SF') {
      const key = path.relative(cwd, path.resolve(cwd, v)).split(path.sep).join('/');
      cur = into.get(key) ?? { lines: new Map(), funcs: new Map(), branches: new Map() };
      into.set(key, cur);
      fnKey.clear();
      nth.clear();
    } else if (!cur) continue;
    else if (tag === 'DA') {
      const [line, hits] = v.split(',');
      add(cur.lines, Number(line), Number(hits));
    } else if (tag === 'FN') {
      const c = v.indexOf(',');
      fnKey.set(v.slice(c + 1), next('f', v.slice(0, c)));
    } else if (tag === 'FNDA') {
      const c = v.indexOf(',');
      const name = v.slice(c + 1);
      add(cur.funcs, fnKey.get(name) ?? `?#${name}`, Number(v.slice(0, c)));
    } else if (tag === 'BRDA') {
      const [line, , , taken] = v.split(',');
      add(cur.branches, next('b', line), taken === '-' ? 0 : Number(taken));
    } else if (tag === 'end_of_record') cur = undefined;
  }
}

const pct = (hit: number, all: number) => (all ? (100 * hit) / all : 100);
const hitOf = (m: Map<unknown, number>) => [...m.values()].filter((n) => n > 0).length;

/** Runs of uncovered lines, as node prints them: "12-14 20". */
export function uncovered(lines: Map<number, number>): string {
  const miss = [...lines].filter(([, n]) => n === 0).map(([l]) => l).sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < miss.length; ) {
    let j = i;
    while (j + 1 < miss.length && miss[j + 1] === miss[j] + 1) j++;
    runs.push(i === j ? `${miss[i]}` : `${miss[i]}-${miss[j]}`);
    i = j + 1;
  }
  return runs.join(' ');
}

export interface Totals {
  files: number;
  linePct: number;
  branchPct: number;
  funcPct: number;
}

/** The merged table and its totals. */
export function table(files: Map<string, FileCov>): { text: string; totals: Totals } {
  const rows: string[][] = [['file', 'line %', 'branch %', 'funcs %', 'uncovered lines']];
  const sum = { l: 0, lh: 0, b: 0, bh: 0, f: 0, fh: 0 };
  for (const [file, c] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const lh = hitOf(c.lines), bh = hitOf(c.branches), fh = hitOf(c.funcs);
    sum.l += c.lines.size; sum.lh += lh; sum.b += c.branches.size; sum.bh += bh; sum.f += c.funcs.size; sum.fh += fh;
    rows.push([file, pct(lh, c.lines.size).toFixed(2), pct(bh, c.branches.size).toFixed(2), pct(fh, c.funcs.size).toFixed(2), uncovered(c.lines)]);
  }
  const totals = { files: files.size, linePct: pct(sum.lh, sum.l), branchPct: pct(sum.bh, sum.b), funcPct: pct(sum.fh, sum.f) };
  rows.push(['all files', totals.linePct.toFixed(2), totals.branchPct.toFixed(2), totals.funcPct.toFixed(2), '']);
  const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)));
  const text = rows.map((r) => [r[0].padEnd(w[0]), ...[1, 2, 3].map((i) => r[i].padStart(w[i])), r[4]].join(' | ').trimEnd()).join('\n');
  return { text, totals };
}

function main(argv: string[]): number {
  if (!argv.length) {
    console.error('usage: node scripts/lcov-merge.ts <shard.lcov> ...');
    return 2;
  }
  const files = new Map<string, FileCov>();
  for (const f of argv) {
    if (!fs.existsSync(f)) {
      // A shard ended before its reporter wrote (the watchdog, a crash): that shard's job already failed and says why.
      console.error(`${f} was not written: its shard did not finish; the table below leaves its tests out.`);
      continue;
    }
    addLcov(files, fs.readFileSync(f, 'utf8'));
  }
  console.log(table(files).text);
  return 0;
}

if (path.resolve(process.argv[1] ?? '') === import.meta.filename) process.exitCode = main(process.argv.slice(2));

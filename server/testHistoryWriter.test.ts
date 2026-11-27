// w6415: a run recorded in the writer thread (TestHistory.addRunApart, server/testHistoryWriter.ts) is stored exactly as
// addRun on the loop stores it, whole or not at all, while the loop keeps running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestHistory, labelFailures, parseNunit, type RunInfo, type TestCase } from './testHistory.ts';

const T0 = Date.parse('2026-11-20T12:00:00Z');
const NOW = T0 + 3 * 86_400_000;
const tmp = (what: string) => fs.mkdtempSync(path.join(os.tmpdir(), `test-history-writer-${what}-`));
const history = () => new TestHistory({ dataDir: tmp('db'), now: () => NOW });
const at = (h: number) => new Date(T0 + h * 3_600_000).toISOString();

/** Every row of every table, in a fixed order: two databases holding the same runs dump the same. */
function dump(h: TestHistory): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of ['tests', 'runs', 'results', 'test_days', 'failures', 'run_starts']) out[t] = h.all(`SELECT * FROM ${t} ORDER BY 1, 2, 3`);
  out.meta = h.all("SELECT * FROM meta WHERE k <> 'recorded_since' ORDER BY k");
  return out;
}

/** A spread of runs: a CI gate run, a master batch (only failures kept per run), local runs with changes, every outcome. */
function runs(): [RunInfo, TestCase[]][] {
  const suite = (n: number, failEvery: number, salt: number): TestCase[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `Ns.C${i % 40}.M${i}${i % 9 === 0 ? `(${i % 4})` : ''}`,
      outcome: i % failEvery === salt ? 'fail' : i % 31 === 3 ? 'skip' : i % 53 === 5 ? 'inconclusive' : 'pass',
      ms: (i * 17 + salt) % 900,
      ...(i % 13 === 0 ? { categories: i % 26 === 0 ? ['Performance'] : ['Slow', 'Net'] } : {}),
      ...(i % failEvery === salt ? { message: `boom ${i}` } : {}),
    }));
  return [
    [{ source: 'pr-gate', key: 'gh:1', repo: 'o/r', ciRun: 11, attempt: 1, sha: 'aaa', pr: 7, branch: 'feat', finished: at(1), url: 'u', mode: 'EditMode' }, suite(600, 97, 4)],
    [{ source: 'master-batch', key: 'gh:2:00-full.xml', repo: 'o/r', sha: 'bbb', branch: 'master', finished: at(2), mode: 'EditMode', verdict: 'flaky' }, suite(600, 89, 7)],
    [
      { source: 'local', key: 'local:m/s1/a.json', machine: 'm', sandbox: 's1', branch: 'feat', sha: 'ccc', base: 'bbb', finished: at(3), started: at(2.9), sessions: ['x1'], requests: ['w1', 'w2'], tagged: 'session', changes: { 'Assets/A.cs': 'h1' } },
      suite(300, 41, 2),
    ],
    [{ source: 'local', key: 'local:m/s2/b.json', machine: 'm', sandbox: 's2', finished: at(3), tagged: 'none', changes: null }, []],
    [{ source: 'release', key: 'gh:3', repo: 'o/r', sha: 'ddd', branch: 'master', finished: at(26) }, suite(600, 97, 4)],
  ];
}

test('a run recorded in the writer thread is stored row for row as addRun on the loop stores it (w6415)', async () => {
  const loop = history();
  const apart = history();
  try {
    for (const [r, t] of runs()) loop.addRun(r, t);
    const got = [];
    for (const [r, t] of runs()) got.push(await apart.addRunApart(r, t));
    assert.deepEqual(got.map((g) => g.added), [true, true, true, true, true]);
    assert.deepEqual(dump(apart), dump(loop));
    // Asked again: nothing added, the same run answered, in both.
    const [r0, t0] = runs()[0]!;
    assert.deepEqual(await apart.addRunApart(r0, t0), loop.addRun(r0, t0));
    assert.deepEqual(dump(apart), dump(loop));
    // The prune apart deletes what the prune on the loop deletes.
    assert.equal(await apart.pruneApart(1), loop.prune(1));
    assert.deepEqual(dump(apart), dump(loop));
  } finally {
    loop.close();
    apart.close();
  }
});

test('runs asked together are recorded one by one in the order asked, and the same key twice is one run', async () => {
  const loop = history();
  const apart = history();
  try {
    for (const [r, t] of runs()) loop.addRun(r, t);
    const [r0, t0] = runs()[0]!;
    const all = await Promise.all([...runs().map(([r, t]) => apart.addRunApart(r, t)), apart.addRunApart(r0, t0)]);
    assert.deepEqual(all.map((a) => a.added), [true, true, true, true, true, false]);
    assert.equal(all[5]!.runId, all[0]!.runId);
    assert.deepEqual(dump(apart), dump(loop));
  } finally {
    loop.close();
    apart.close();
  }
});

test('while a big run is written apart the loop keeps running and sees no part of it: none, then all', async () => {
  const h = history();
  try {
    const n = 22_000;
    const tests: TestCase[] = Array.from({ length: n }, (_, i) => ({ name: `Big.C${i % 500}.M${i}`, outcome: i % 1000 === 1 ? 'fail' : 'pass', ms: i % 300 }));
    const seen = new Set<string>();
    let ticks = 0;
    let longest = 0;
    let last = performance.now();
    let done = false;
    const watch = (async () => {
      while (!done) {
        await new Promise<void>((r) => setImmediate(r));
        const t = performance.now();
        longest = Math.max(longest, t - last);
        last = t;
        ticks++;
        // One statement, one snapshot of the database.
        const r = h.all(
          "SELECT (SELECT tests FROM runs WHERE key = 'gh:big') AS run, (SELECT count(*) FROM results) AS results, (SELECT count(*) FROM test_days) AS days",
        )[0]!;
        seen.add(r.run === null ? `none, results ${r.results}, days ${r.days}` : `run ${r.run}, results ${r.results}, days ${r.days}`);
      }
    })();
    const r = await h.addRunApart({ source: 'pr-gate', key: 'gh:big', branch: 'b', sha: 's', finished: at(1) }, tests);
    done = true;
    await watch;
    assert.equal(r.added, true);
    assert.ok(ticks > 1, `the loop ran ${ticks} times while the run was written`);
    // Only the two states a transaction allows: before it and after it.
    for (const s of seen) assert.ok(s === 'none, results 0, days 0' || s === `run ${n}, results ${n}, days ${n}`, `a reader saw a part of the run: ${s}`);
    assert.equal(Number(h.all('SELECT count(*) AS n FROM results')[0]!.n), n);
    // The loop's own cost is the hand-over of the cases; a generous bound for a busy CI runner.
    assert.ok(longest < 1000, `the loop was held ${longest.toFixed(0)} ms`);
  } finally {
    h.close();
  }
});

test('a run that fails part way in the writer thread leaves no row of it, and the same run sent again is stored whole', async () => {
  const loop = history();
  const apart = history();
  try {
    const [r, t] = runs()[0]!;
    // A case with no name fails after the run row and some results are written: the transaction is rolled back.
    const broken = [...t.slice(0, 300), { name: undefined as unknown as string, outcome: 'pass' as const, ms: 1 }, ...t.slice(300)];
    await assert.rejects(apart.addRunApart(r, broken));
    const empty = history();
    assert.deepEqual(dump(apart), dump(empty));
    empty.close();
    assert.equal(apart.hasRun(r.key), false);
    loop.addRun(r, t);
    assert.equal((await apart.addRunApart(r, t)).added, true);
    assert.deepEqual(dump(apart), dump(loop));
  } finally {
    loop.close();
    apart.close();
  }
});

test('the labeller and the loop wait for the writer thread: labels land on the run once it is whole (idle)', async () => {
  const h = history();
  try {
    const [r, t] = runs()[2]!;
    const pending = h.addRunApart(r, t);
    let idleFirst = false;
    const idle = h.idle().then(() => {
      idleFirst = !h.hasRun('never') && h.hasRun(r.key);
    });
    await pending;
    await idle;
    assert.equal(idleFirst, true, 'idle resolved before the run was committed');
    // A local failure that never passed again on its sandbox: unknown once it is DECIDE_WITHIN_DAYS old.
    const n = await labelFailures(h, async () => [], T0 + 30 * 86_400_000);
    assert.equal(n, t.filter((c) => c.outcome === 'fail').length);
    await h.idle();
  } finally {
    h.close();
  }
});

test('an NUnit file parsed and recorded in the writer thread is stored as parseNunit and addRun on the loop store it; an empty one records nothing', async () => {
  const loop = history();
  const apart = history();
  const dir = tmp('xml');
  try {
    const cases = Array.from({ length: 400 }, (_, i) => {
      const result = i % 37 === 1 ? 'Failed' : i % 23 === 2 ? 'Skipped' : 'Passed';
      const body = result === 'Failed' ? `<failure><message><![CDATA[boom &amp; ${i}]]></message></failure>` : '';
      return `<test-case fullname="Ns.C${i % 11}.M${i}(&quot;${i % 3}&quot;)" result="${result}" duration="${(i % 50) / 100}">${body}</test-case>`;
    });
    const xml = `<?xml version="1.0"?><test-run><test-suite>${cases.join('\n')}</test-suite></test-run>`;
    const file = path.join(dir, 'editmode-results.xml');
    fs.writeFileSync(file, xml);
    const run: RunInfo = { source: 'pr-gate', key: 'gh:9', repo: 'o/r', sha: 'e', branch: 'f', finished: at(5), mode: 'EditMode' };
    const tests = parseNunit(xml);
    const want = loop.addRun(run, tests);
    const got = await apart.addNunitApart(run, file);
    assert.deepEqual(got, { ...want, tests: tests.length });
    assert.deepEqual(dump(apart), dump(loop));
    fs.writeFileSync(path.join(dir, 'empty.xml'), '');
    assert.deepEqual(await apart.addNunitApart({ ...run, key: 'gh:10' }, path.join(dir, 'empty.xml')), { added: false, tests: 0 });
    assert.deepEqual(await apart.addNunitApart({ ...run, key: 'gh:11' }, path.join(dir, 'missing.xml')), { added: false, tests: 0 });
    assert.deepEqual(dump(apart), dump(loop));
  } finally {
    loop.close();
    apart.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

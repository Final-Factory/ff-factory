import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TestHistory,
  beingWritten,
  classOf,
  ownSourceIn,
  labelFailures,
  labelFromChange,
  localRunKey,
  localRunTags,
  parseLocalRecord,
  parseNunit,
  queryTestHistory,
  readyQuery,
  runSql,
  sessionOfTemp,
  sqlProblem,
  type TestCase,
} from './testHistory.ts';
import { BATCH_ARTIFACT, EDITMODE_ARTIFACT, TestHistoryCi, prDiffFrom, sourceOf, type ArtifactRef, type TestHistoryGh } from './testHistoryCi.ts';
import { DatabaseSync } from 'node:sqlite';
import { ROOT_SPOOL_DIR, STALE_MS, TestHistorySpool, SPOOL_DIR, sandboxOfProject } from '../machine/testHistorySpool.ts';

// The per-test history (w4922, docs/test-history.md): what goes in, how failures are labelled, the queries.

const T0 = Date.parse('2026-11-20T12:00:00Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const tmp = (what: string) => fs.mkdtempSync(path.join(os.tmpdir(), `test-history-${what}-`));
const history = (now = T0 + 3 * 86_400_000) => new TestHistory({ dataDir: tmp('db'), now: () => now });
const tc = (name: string, outcome: TestCase['outcome'], ms = 10, extra: Partial<TestCase> = {}): TestCase => ({ name, outcome, ms, ...extra });
const labelOf = (h: TestHistory, test: string) => h.all('SELECT f.label, f.reason FROM failures f JOIN tests t ON t.id = f.test_id WHERE t.name = ? ORDER BY f.id', test);

const NUNIT = `<?xml version="1.0"?>
<test-run>
 <test-suite type="TestFixture" fullname="FF.Tests.BeltTest">
  <test-case id="1" name="Moves" fullname="FF.Tests.BeltTest.Moves" result="Passed" duration="0.25" />
  <test-case id="2" name="Stops(1,&quot;a&quot;)" fullname="FF.Tests.BeltTest.Stops(1,&quot;a&quot;)" result="Failed" duration="1.5">
   <properties><property name="Category" value="Performance" /></properties>
   <failure><message><![CDATA[Expected 3 but was 4]]></message></failure>
  </test-case>
  <test-case id="3" name="Later" fullname="FF.Tests.BeltTest.Later" result="Skipped" duration="0" />
 </test-suite>
</test-run>`;

test('parseNunit reads each case, its time, its categories and the failure message', () => {
  const cases = parseNunit(NUNIT);
  assert.equal(cases.length, 3);
  assert.deepEqual(cases[0], { name: 'FF.Tests.BeltTest.Moves', outcome: 'pass', ms: 250 });
  assert.equal(cases[1]!.name, 'FF.Tests.BeltTest.Stops(1,"a")');
  assert.equal(cases[1]!.outcome, 'fail');
  assert.equal(cases[1]!.ms, 1500);
  assert.deepEqual(cases[1]!.categories, ['Performance']);
  assert.match(cases[1]!.message ?? '', /Expected 3 but was 4/);
  assert.equal(cases[2]!.outcome, 'skip');
  assert.equal(classOf('FF.Tests.BeltTest.Stops(1,"a.b")'), 'FF.Tests.BeltTest');
});

test('labelFromChange: nothing or only tests changed is fp, only game code is detect, both is unknown', () => {
  assert.equal(labelFromChange([], 'x').label, 'fp');
  assert.equal(labelFromChange(['Assets/Tests/BeltTest.cs'], 'x').label, 'fp');
  assert.equal(labelFromChange(['scripts/test_select.py', 'docs/a.md'], 'x').label, 'fp');
  assert.equal(labelFromChange(['Assets/Scripts/FFSystems/Belt.cs'], 'x').label, 'detect');
  assert.equal(labelFromChange(['Assets/Scripts/FFSystems/Belt.cs', 'Assets/Tests/BeltTest.cs'], 'x').label, 'unknown');
  assert.equal(labelFromChange(undefined, 'x').label, 'unknown');
});

test('a re-run at the same commit that passes makes a gate failure fp; a later head with only game code changed makes it detect', async () => {
  const h = history();
  const base = { repo: 'o/r', branch: 'feature', pr: 7 };
  h.addRun({ ...base, source: 'pr-gate', key: 'a1', sha: 'aaa', finished: iso(0) }, [tc('A.T.flaky', 'fail'), tc('A.T.real', 'fail')]);
  h.addRun({ ...base, source: 'pr-gate', key: 'a2', sha: 'aaa', finished: iso(10) }, [tc('A.T.flaky', 'pass')]);
  h.addRun({ ...base, source: 'pr-gate', key: 'b1', sha: 'bbb', finished: iso(20) }, [tc('A.T.real', 'pass')]);
  const asked: string[] = [];
  const n = await labelFailures(h, async (_repo, a, b) => (asked.push(`${a}..${b}`), ['Assets/Scripts/FFSystems/Belt.cs']), T0 + 3600_000);
  assert.equal(n, 2);
  assert.equal(labelOf(h, 'A.T.flaky')[0]!.label, 'fp');
  assert.equal(labelOf(h, 'A.T.real')[0]!.label, 'detect');
  assert.deepEqual(asked, ['aaa..bbb']);
});

test('a failure that never passes again waits, then is unknown after the window; a person\'s label is never overwritten', async () => {
  const h = history(T0 + 3600_000);
  h.addRun({ source: 'pr-gate', key: 'x', repo: 'o/r', branch: 'b', sha: 's', finished: iso(0) }, [tc('A.T.one', 'fail'), tc('A.T.two', 'fail')]);
  assert.equal(await labelFailures(h, async () => [], T0 + 3600_000), 0);
  const id = h.failureId(1, 'A.T.two')!;
  assert.ok(h.label(id, 'detect', 'I fixed the bug it found', 'lothsahn'));
  assert.equal(await labelFailures(h, async () => [], T0 + 8 * 86_400_000), 1);
  assert.equal(labelOf(h, 'A.T.one')[0]!.label, 'unknown');
  assert.equal(labelOf(h, 'A.T.two')[0]!.label, 'detect');
  assert.equal(h.label(id, 'fp', 'auto try', 'auto'), false);
});

test('local runs: a pass in the same sandbox after only the test changed is fp; after the base moved it is unknown', async () => {
  const h = history();
  const run = (key: string, at: number, changes: Record<string, string>, outcome: TestCase['outcome'], baseSha = 'm1', sandbox = 'slot4') =>
    h.addRun({ source: 'local', key, machine: 'beast', sandbox, branch: 'w1', sha: `h${at}`, base: baseSha, finished: iso(at), changes }, [tc('A.T.loc', outcome)]);
  run('l1', 0, { 'Assets/Tests/X.cs': '1', 'Assets/Scripts/Y.cs': '1' }, 'fail');
  run('other', 1, { 'Assets/Tests/X.cs': '1' }, 'pass', 'm1', 'slot5');
  run('l2', 5, { 'Assets/Tests/X.cs': '2', 'Assets/Scripts/Y.cs': '1' }, 'pass');
  run('l3', 6, { 'Assets/Tests/X.cs': '2' }, 'fail', 'm1');
  run('l4', 7, { 'Assets/Tests/X.cs': '2' }, 'pass', 'm2');
  await labelFailures(h, async () => undefined, T0 + 3600_000);
  const labels = labelOf(h, 'A.T.loc');
  assert.equal(labels[0]!.label, 'fp');
  assert.equal(labels[1]!.label, 'unknown');
  assert.match(String(labels[1]!.reason), /base moved/);
});

test('w5457: a local failure while the test file was being written or edited is unknown, not fp', async () => {
  const h = history();
  const T = 'FF.Tests.PanelsHiddenHintTest.Shows';
  const F = 'Assets/Tests/UI/PanelsHiddenHintTest.cs';
  const run = (key: string, at: number, changes: Record<string, string>, outcome: TestCase['outcome'], sandbox: string) =>
    h.addRun({ source: 'local', key, machine: 'beast', sandbox, branch: 'w1', sha: `h${at}`, base: 'm1', finished: iso(at), changes }, [tc(T, outcome)]);
  // PanelsHiddenHint shape: fails with the test file new and dirty, passes after the test file's blob changed.
  run('a1', 0, { [F]: 'blob1' }, 'fail', 's4');
  run('a2', 2, { [F]: 'blob2' }, 'pass', 's4');
  // The test file dirty in the failing run only (committed before the pass): still the author's run.
  run('b1', 0, { [F]: 'blob1' }, 'fail', 's5');
  run('b2', 2, {}, 'pass', 's5');
  // Same dirty test file, re-run with nothing changed.
  run('c1', 0, { [F]: 'blob1' }, 'fail', 's6');
  run('c2', 2, { [F]: 'blob1' }, 'pass', 's6');
  // Another test file changed, not this one: still fp (the existing rule).
  run('d1', 0, { 'Assets/Tests/UI/OtherTest.cs': '1' }, 'fail', 's7');
  run('d2', 2, { 'Assets/Tests/UI/OtherTest.cs': '2' }, 'pass', 's7');
  await labelFailures(h, async () => undefined, T0 + 3600_000);
  const l = labelOf(h, T);
  assert.deepEqual(l.map((x) => x.label), ['unknown', 'unknown', 'unknown', 'fp']);
  assert.match(String(l[0]!.reason), /being written or edited/);
});

test('w5457: a failure that took over 100 times the test median is unknown (a stalled editor), not fp', async () => {
  const h = history();
  const at = (i: number, outcome: TestCase['outcome'], ms: number) => h.addRun({ source: 'pr-gate', key: `s${i}`, repo: 'o/r', branch: 'b', sha: 'same', finished: iso(i) }, [{ ...tc('A.T.slow', outcome), ms }]);
  for (let i = 0; i < 6; i++) at(i, 'pass', 1000);
  at(10, 'fail', 331_372);
  at(11, 'pass', 1000);
  at(12, 'fail', 1200);
  at(13, 'pass', 1000);
  await labelFailures(h, async () => [], T0 + 3600_000);
  const l = labelOf(h, 'A.T.slow');
  assert.equal(l[0]!.label, 'unknown');
  assert.match(String(l[0]!.reason), /stalled/);
  assert.equal(l[1]!.label, 'fp');
});

test('w5457: ownSourceIn names the test class file only, and beingWritten leaves other changes alone', () => {
  assert.deepEqual(ownSourceIn('A.B.FooTest.Case(1,2)', ['Assets/Tests/FooTest.cs', 'Assets/Tests/FooTest.cs.meta', 'Assets/Tests/BarTest.cs']), ['Assets/Tests/FooTest.cs']);
  assert.deepEqual(ownSourceIn('A.B.FooTest+Inner.Case', ['x/FooTest.cs']), ['x/FooTest.cs']);
  assert.equal(beingWritten('A.B.FooTest.Case', { 'Assets/Scripts/Foo.cs': '1' }, ['Assets/Tests/BarTest.cs']), undefined);
  assert.equal(beingWritten('A.B.FooTest.Case', undefined, ['Assets/Tests/FooTest.cs'])?.label, 'unknown');
});

test("the master batch's verdict labels its failures, and it keeps only failures per run (its passes are in the day rollup)", async () => {
  const h = history();
  const { runId } = h.addRun({ source: 'master-batch', key: 'mb', sha: 'tip', branch: 'master', finished: iso(0) }, [
    tc('A.T.ok', 'pass'), tc('A.T.flaky', 'fail'), tc('A.T.broken', 'fail'), tc('A.T.lost', 'fail'), tc('A.T.cut', 'fail'),
  ]);
  h.applyBatchVerdict(runId, { flaky: ['A.T.flaky'], culprits: [{ sha: 'abcdef1234', pr: 99, tests: ['A.T.broken'] }], unresolved: ['A.T.lost'] });
  assert.equal(labelOf(h, 'A.T.flaky')[0]!.label, 'fp');
  assert.equal(labelOf(h, 'A.T.broken')[0]!.label, 'detect');
  assert.match(String(labelOf(h, 'A.T.broken')[0]!.reason), /PR #99/);
  assert.equal(labelOf(h, 'A.T.lost')[0]!.label, 'unknown');
  await labelFailures(h, async () => [], T0 + 2 * 86_400_000);
  assert.equal(labelOf(h, 'A.T.cut')[0]!.label, 'unknown');
  assert.equal(h.all('SELECT count(*) AS n FROM results')[0]!.n, 4);
  assert.equal(h.all('SELECT sum(runs) AS n FROM test_days')[0]!.n, 5);
  assert.equal(h.addRun({ source: 'master-batch', key: 'mb', finished: iso(0) }, []).added, false);
});

test('w5415: a hung or unresolved batch labels its unresolved tests unknown, saying no run confirmed them', () => {
  const h = history();
  const { runId } = h.addRun({ source: 'master-batch', key: 'mb-hung', sha: 'tip', branch: 'master', finished: iso(0) }, [tc('A.Smoke.hung', 'fail')]);
  h.applyBatchVerdict(runId, { verdict: 'hung', unresolved: ['A.Smoke.hung'] });
  const l = labelOf(h, 'A.Smoke.hung')[0]!;
  assert.equal(l.label, 'unknown');
  assert.match(String(l.reason), /no run confirmed it/);
});

test('the ready-made queries: slowest, false positives, detections and never_caught, Performance tests left out', async () => {
  const h = history(T0 + 86_400_000);
  for (let i = 0; i < 6; i++)
    h.addRun({ source: 'master-batch', key: `mb${i}`, sha: `t${i}`, branch: 'master', finished: iso(i) }, [
      tc('A.Slow.big', 'pass', 5000), tc('A.Fast.small', i === 0 ? 'fail' : 'pass', 5), tc('A.Catch.it', i === 1 ? 'fail' : 'pass', 20),
      tc('A.Perf.timed', 'pass', 9000, { categories: ['Performance'] }),
    ]);
  h.applyBatchVerdict(1, { flaky: ['A.Fast.small'] });
  h.applyBatchVerdict(2, { culprits: [{ sha: 'c', pr: 5, tests: ['A.Catch.it'] }] });
  h.setCoverage('t5', { 'A.Slow': ['Belt', 'Splitter'] });
  const now = T0 + 86_400_000;
  assert.equal(readyQuery(h, { query: 'slowest', limit: 1 }, now).rows[0]!.test, 'A.Slow.big');
  assert.equal(readyQuery(h, { query: 'slowest', limit: 1, performance: true }, now).rows[0]!.test, 'A.Perf.timed');
  const fp = readyQuery(h, { query: 'false_positives', byRate: true, minRuns: 5 }, now).rows;
  assert.equal(fp[0]!.test, 'A.Fast.small');
  assert.equal(fp[0]!.runs, 6);
  assert.equal(readyQuery(h, { query: 'detections' }, now).rows[0]!.test, 'A.Catch.it');
  const never = readyQuery(h, { query: 'never_caught' }, now).rows;
  assert.deepEqual(never.map((r) => r.test), ['A.Slow.big', 'A.Fast.small']);
  assert.equal(never[0]!.covers, 'Belt Splitter');
  assert.match(await queryTestHistory(h, { query: 'summary' }, now), /master-batch \| 6/);
  assert.match(await queryTestHistory(h, { query: 'test', test: 'Catch' }, now), /A\.Catch\.it/);
});

test('ad-hoc sql: one read-only SELECT, refused otherwise, rows capped', async () => {
  assert.equal(sqlProblem('SELECT 1'), undefined);
  assert.equal(sqlProblem('with x as (select 1) select * from x;'), undefined);
  assert.ok(sqlProblem('DELETE FROM tests'));
  assert.ok(sqlProblem('SELECT 1; DROP TABLE tests'));
  assert.ok(sqlProblem("SELECT 1 FROM x WHERE 1 = (ATTACH 'y' AS z)"));
  assert.equal(sqlProblem("SELECT 'delete me' AS x"), undefined);
  const h = history();
  h.addRun({ source: 'local', key: 'k', finished: iso(0) }, [tc('A.B.c', 'pass'), tc('A.B.d', 'pass')]);
  const r = await runSql(h.file, 'SELECT name FROM tests ORDER BY name', 1);
  assert.deepEqual(r.rows, [{ name: 'A.B.c' }]);
  assert.equal(r.more, true);
  await assert.rejects(runSql(h.file, 'UPDATE tests SET name = 1'), /refused/);
  await assert.rejects(runSql(h.file, 'SELECT nope FROM tests'), /no such column/);
});

test('parseLocalRecord reads what TestHistoryRecorder.cs writes', () => {
  const rec = {
    version: 1, recorder: 'unity-editor', machine: 'BEAST', mode: 'EditMode', started: iso(0), finished: iso(1), head: 'h', branch: 'w1', base: 'm',
    changes: { 'Assets/Tests/X.cs': 'abc' },
    tests: [{ name: 'A.B.c', outcome: 'pass', ms: 12 }, { name: 'A.B.d', outcome: 'fail', ms: 3, message: 'boom', categories: ['Performance'] }, { name: '', outcome: 'pass' }],
  };
  const r = parseLocalRecord(JSON.stringify(rec))!;
  assert.equal(r.tests.length, 2);
  assert.equal(r.info.sha, 'h');
  assert.deepEqual(r.info.changes, { 'Assets/Tests/X.cs': 'abc' });
  assert.equal(parseLocalRecord('{"version":2,"tests":[]}'), undefined);
  assert.equal(parseLocalRecord('not json'), undefined);
});

test("the CI collector reads new gate and batch artifacts once, labels by a PR's diff, and keeps the newest coverage", async () => {
  const h = history(T0 + 3600_000);
  const art = (id: number, name: string, runId: number, sha: string, branch: string, minutes: number): ArtifactRef => ({ id, name, created: iso(minutes), expired: false, runId, sha, branch });
  const lists: Record<string, ArtifactRef[]> = {
    [EDITMODE_ARTIFACT]: [art(3, EDITMODE_ARTIFACT, 30, 'bbb', 'feat', 20), art(1, EDITMODE_ARTIFACT, 10, 'aaa', 'feat', 0)],
    [BATCH_ARTIFACT]: [art(2, BATCH_ARTIFACT, 20, 'tip', 'master', 5)],
  };
  const files: Record<number, Record<string, string>> = {
    10: { 'editmode-results.xml': `<test-case fullname="A.T.x" result="Failed" duration="0.1"><failure><message>no</message></failure></test-case>` },
    30: { 'editmode-results.xml': `<test-case fullname="A.T.x" result="Passed" duration="0.1" />` },
    20: {
      '00-full.xml': `<test-case fullname="A.T.y" result="Failed" duration="2" /><test-case fullname="A.T.x" result="Passed" duration="0.1" />`,
      'verdict.json': JSON.stringify({ verdict: 'red', tip: 'tip', flaky: ['A.T.y'] }),
      'coverage.json': JSON.stringify({ sha: 'tip', classes: { 'A.T': ['Belt'] } }),
    },
  };
  let downloads = 0;
  const gh: TestHistoryGh = {
    artifacts: async (_repo, name, page) => (page === 1 ? (lists[name] ?? []) : []),
    run: async (_repo, runId) => ({ event: runId === 20 ? 'workflow_run' : 'pull_request', attempt: 1, prs: runId === 20 ? [] : [7], url: `u${runId}`, status: 'completed' }),
    download: async (_repo, runId, _name, dir) => {
      downloads++;
      for (const [f, text] of Object.entries(files[runId] ?? {})) fs.writeFileSync(path.join(dir, f), text);
    },
    diff: async (_repo, sha) => new Map(sha === 'aaa' ? [['Assets/Scripts/A.cs', '1']] : [['Assets/Scripts/A.cs', '2']]),
  };
  const ci = new TestHistoryCi({ cfg: { dataDir: tmp('ci') }, history: h, gh, now: () => T0 + 3600_000 });
  const first = await ci.look();
  assert.deepEqual(first, { ingested: 3, tests: 4, labelled: 1 });
  assert.equal(labelOf(h, 'A.T.x')[0]!.label, 'detect');
  assert.equal(labelOf(h, 'A.T.y')[0]!.label, 'fp');
  assert.equal(h.all("SELECT count(*) AS n FROM runs WHERE source = 'pr-gate' AND pr = 7")[0]!.n, 2);
  assert.equal(h.all('SELECT type FROM coverage')[0]!.type, 'Belt');
  assert.deepEqual(await ci.look(), { ingested: 0, tests: 0, labelled: 0 });
  assert.equal(downloads, 3);
  assert.equal(sourceOf('push', 'master'), 'release');
  assert.equal(sourceOf('workflow_dispatch', 'x'), 'ci-other');
});

test('prDiffFrom: the files whose blob differs between two heads of a pull request', async () => {
  const diff = prDiffFrom({
    diff: async (_r, sha) =>
      sha === 'a' ? new Map([['x', '1'], ['y', '1'], ['gone', '1']]) : sha === 'b' ? new Map([['x', '1'], ['y', '2'], ['new', '1']]) : undefined,
  });
  assert.deepEqual(await diff('o/r', 'a', 'b'), ['gone', 'new', 'y']);
  assert.equal(await diff('o/r', 'a', 'huge'), undefined);
});

test("the daemon's spool sends each sandbox's records a few at a time and deletes one once the portal answers", () => {
  const root = tmp('spool');
  const dir = path.join(root, SPOOL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const names = ['20261120T120000000-0000000a.json', '20261120T120001000-0000000b.json', '20261120T120002000-0000000c.json', '20261120T120003000-0000000d.json', '20261120T120004000-0000000e.json'];
  for (const n of names) fs.writeFileSync(path.join(dir, n), '{}');
  fs.writeFileSync(path.join(dir, '20261120T120005000-0000000f.json.tmp'), 'half');
  const sent: string[] = [];
  let now = T0;
  const spool = new TestHistorySpool({ places: () => [{ id: 'slot4', path: root }], send: (m) => (sent.push(m.file), true), now: () => now });
  assert.equal(spool.tick(), 4);
  assert.deepEqual(sent, names.slice(0, 4));
  assert.equal(spool.tick(), 1);
  assert.equal(spool.tick(), 0);
  spool.ack('slot4', names[0]!, true);
  spool.ack('slot4', '../../etc/passwd', true);
  assert.equal(fs.existsSync(path.join(dir, names[0]!)), false);
  now += 31 * 60_000;
  sent.length = 0;
  assert.equal(spool.tick(), 4);
  assert.deepEqual(sent, names.slice(1));
});

test('hand labels are recorded as whose they are: a worker replaces the labeller, a person replaces a worker, never the other way', async () => {
  const h = history();
  h.addRun({ source: 'pr-gate', key: 'k', repo: 'o/r', branch: 'b', sha: 's', finished: iso(0) }, [tc('A.T.one', 'fail'), tc('A.T.two', 'fail')]);
  const one = h.failureId(1, 'A.T.one')!;
  const two = h.failureId(1, 'A.T.two')!;
  assert.ok(h.label(one, 'unknown', 'auto said so', 'auto'));
  const set = (a: Record<string, unknown>, by?: string) => queryTestHistory(h, { query: 'set_label', ...a } as never, T0, by);
  assert.match(await set({ failureId: one, label: 'fp', reason: 'passed on a re-run at the same commit' }, 'worker:c9560245'), /now fp, set by worker:c9560245 \(was unknown by auto\)/);
  await assert.rejects(set({ failureId: one, label: 'fp', reason: 'x' }), /caller is not known/);
  await assert.rejects(set({ failureId: one, label: 'fp', reason: 'x' }, 'auto'), /caller is not known/);
  await assert.rejects(set({ failureId: one, label: 'fp' }, 'worker:a'), /needs reason/);
  await assert.rejects(set({ failureId: 999, label: 'fp', reason: 'x' }, 'worker:a'), /no failure 999/);
  assert.match(await set({ failureId: two, label: 'detect', reason: 'the fix in #12 made it pass' }, 'person:lothsahn (personal 1234abcd)'), /now detect/);
  assert.match(await set({ failureId: two, label: 'fp', reason: 'I think it flaked' }, 'worker:c9560245'), /^Not changed/);
  assert.equal(h.label(one, 'detect', 'auto again', 'auto'), false);
  assert.ok(h.label(one, 'detect', 'person overrides worker', 'person:lothsahn'));
  const rows = h.all('SELECT t.name, f.label, f.labelled_by FROM failures f JOIN tests t ON t.id = f.test_id ORDER BY t.name');
  assert.deepEqual(
    rows.map((r) => [r.name, r.label, r.labelled_by]),
    [
      ['A.T.one', 'detect', 'person:lothsahn'],
      ['A.T.two', 'detect', 'person:lothsahn (personal 1234abcd)'],
    ],
  );
  const det = readyQuery(h, { query: 'detections' }, T0 + 86_400_000).rows;
  assert.deepEqual(
    det.map((r) => [r.test, r.by_worker, r.by_person]),
    [
      ['A.T.one', 0, 1],
      ['A.T.two', 0, 1],
    ],
  );
});

test("a local run is tagged by the session in its record, else by its sandbox's workers, else untagged; a run that never finished is kept", async () => {
  const src = {
    workInSandbox: (_m: string, sb: string) =>
      sb === 'slot4' ? { sessions: ['aaaa1111'], requests: ['w1'] } : sb === 'slot5' ? { sessions: ['b1', 'b2'], requests: ['w2', 'w3'] } : { sessions: [], requests: [] },
    sessionWork: (id: string) => (id === 'c9560245' ? ['w4922'] : undefined),
  };
  assert.deepEqual(localRunTags(src, 'beast', 'slot4', 'c9560245'), { sessions: ['c9560245'], requests: ['w4922'], tagged: 'session' });
  assert.deepEqual(localRunTags(src, 'beast', 'slot4'), { sessions: ['aaaa1111'], requests: ['w1'], tagged: 'sandbox' });
  assert.deepEqual(localRunTags(src, 'beast', 'slot5', 'gone0000'), { sessions: ['b1', 'b2'], requests: ['w2', 'w3'], tagged: 'shared' });
  assert.deepEqual(localRunTags(src, 'beast', '', 'gone0000'), { sessions: ['gone0000'], requests: [], tagged: 'none' });
  assert.equal(sessionOfTemp('F:/ffw/tmp/ffa-c9560245'), 'c9560245');
  assert.equal(sessionOfTemp('C:\\Users\\x\\AppData\\Local\\Temp'), undefined);

  const running = parseLocalRecord(
    JSON.stringify({ version: 1, status: 'running', planned: 300, tmp: 'F:/ffw/tmp/ffa-c9560245/', finished: iso(5), tests: [{ name: 'A.B.c', outcome: 'pass', ms: 4 }] }),
  )!;
  assert.equal(running.running, true);
  assert.equal(running.session, 'c9560245');
  assert.match(running.info.verdict!, /^incomplete: 1 of 300 tests finished/);
  const ended = parseLocalRecord(JSON.stringify({ version: 1, status: 'finished', session: 'dddd0000', tmp: 'F:/ffw/tmp/ffa-c9560245', finished: iso(5), tests: [] }))!;
  assert.equal(ended.running, false);
  assert.equal(ended.session, 'dddd0000');

  const h = history(T0 + 86_400_000);
  h.addRun({ ...running.info, source: 'local', key: 'local:beast/slot4/a.json', machine: 'beast', sandbox: 'slot4', ...localRunTags(src, 'beast', 'slot4', running.session) }, running.tests);
  h.addRun({ source: 'local', key: 'local:beast//b.json', machine: 'beast', finished: iso(6), ...localRunTags(src, 'beast', '') }, []);
  const all = readyQuery(h, { query: 'local_runs' }, T0 + 86_400_000).rows;
  assert.deepEqual(
    all.map((r) => [r.tagged, r.requests, r.tests]),
    [
      ['none', null, 0],
      ['session', 'w4922', 1],
    ],
  );
  assert.equal(readyQuery(h, { query: 'local_runs', untagged: true }, T0 + 86_400_000).rows.length, 1);
  assert.deepEqual(
    readyQuery(h, { query: 'local_runs', request: 'w4922' }, T0 + 86_400_000).rows.map((r) => r.verdict),
    [running.info.verdict],
  );
});

test('an editor run is tagged with the workers in its sandbox when it started, though they left before its record came', () => {
  let inSlot4 = ['aaaa1111'];
  const src = { workInSandbox: () => ({ sessions: inSlot4, requests: inSlot4.length ? ['w4922'] : [] }), sessionWork: () => undefined };
  const h = history(T0 + 86_400_000);
  const key = localRunKey('beast', 'slot4', '20261120T174741612-cc994a6e.running.json');
  assert.equal(key, 'local:beast/slot4/20261120T174741612-cc994a6e.json');
  h.noteStart(key, localRunTags(src, 'beast', 'slot4'));
  inSlot4 = ['bbbb2222'];
  h.noteStart(key, localRunTags(src, 'beast', 'slot4'));
  inSlot4 = [];
  assert.deepEqual(localRunTags(src, 'beast', 'slot4', undefined, h.startTags(key)), { sessions: ['aaaa1111'], requests: ['w4922'], tagged: 'sandbox' });
  // Without a start the record's own time decides, as before.
  assert.deepEqual(localRunTags(src, 'beast', 'slot4', undefined, h.startTags('local:beast/slot4/other.json')), { sessions: [], requests: [], tagged: 'none' });
  // A batch run's own session still wins.
  const own = { ...src, sessionWork: (id: string) => (id === 'c9560245' ? ['w1'] : undefined) };
  assert.equal(localRunTags(own, 'beast', 'slot4', 'c9560245', h.startTags(key)).tagged, 'session');
});

test('a database made before runs.tagged gains the column when the portal opens it', () => {
  const dir = tmp('old');
  new TestHistory({ dataDir: dir }).close();
  const old = new DatabaseSync(path.join(dir, 'test-history.db'));
  old.exec('ALTER TABLE runs DROP COLUMN tagged');
  assert.ok(!old.prepare('PRAGMA table_info(runs)').all().some((c) => c.name === 'tagged'));
  old.close();
  const h = new TestHistory({ dataDir: dir });
  assert.ok(h.all('PRAGMA table_info(runs)').some((c) => c.name === 'tagged'));
  h.close();
});

test("the daemon's spool reads the machine's spool too, names a record's sandbox by its project, and sends a running file only once it is stale", () => {
  const root = tmp('root');
  const sbPath = path.join(root, 'sandboxes', 'slot4');
  const dir = path.join(root, ROOT_SPOOL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const inSandbox = '20261120T120000000-0000000a.json';
  const outside = '20261120T120001000-0000000b.json';
  const live = '20261120T120002000-0000000c.running.json';
  fs.writeFileSync(path.join(dir, inSandbox), JSON.stringify({ project: sbPath.replace(/\\/g, '/') }));
  fs.writeFileSync(path.join(dir, outside), JSON.stringify({ project: path.join(root, 'tmp', 'ffa-x', 'clone') }));
  fs.writeFileSync(path.join(dir, live), JSON.stringify({ project: sbPath }));
  let now = Date.now();
  const sent: [string, string][] = [];
  const started: [string, string][] = [];
  const spool = new TestHistorySpool({
    places: () => [{ id: 'slot4', path: sbPath }],
    root,
    send: (m) => ((m.type === 'test_history_started' ? started : sent).push([m.sandbox, m.file]), true),
    now: () => now,
  });
  assert.equal(spool.tick(), 2);
  // The running file is announced once, by its project's sandbox, so the portal tags the run as it starts.
  assert.deepEqual(started, [['slot4', live]]);
  spool.tick();
  assert.equal(started.length, 1);
  assert.deepEqual(sent, [
    ['slot4', inSandbox],
    ['', outside],
  ]);
  assert.equal(sandboxOfProject(`${sbPath}/sub`, [{ id: 'slot4', path: sbPath }]), 'slot4');
  now += STALE_MS + 60_000;
  // The two unanswered ones go again (RESEND_MS), and the running file, stale now, with them.
  assert.equal(spool.tick(), 3);
  assert.deepEqual(sent[sent.length - 1], ['slot4', live]);
  spool.ack('', outside, true);
  spool.ack('slot4', live, true);
  assert.deepEqual(fs.readdirSync(dir), [inSandbox]);
});

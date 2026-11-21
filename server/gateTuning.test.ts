import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TestHistory, readyQuery, type TestCase } from './testHistory.ts';
import { CROWN_JEWEL, GateTuningJob, OUT_RULE, findMisses, findProposals, gateTuningSettings, latestGateTuning, type PrHead } from './gateTuning.ts';
import { identityKeys, workerRules } from './intakeRules.ts';
import type { Config } from './config.ts';

// The daily merge-gate tuning (w4928, docs/gate-tuning.md): the gate's misses, the move-out proposals, the daily row.

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-20T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tuning-'));
const tc = (name: string, outcome: TestCase['outcome'], ms = 100): TestCase => ({ name, outcome, ms });
const cfg = (extra: Partial<Config> = {}) => ({ dataDir: tmp(), ...extra }) as Config;
const heads: PrHead = async (_repo, pr) => ({ ref: `sandbox/pr${pr}`, sha: `head${pr}` });

/** A culprit PR whose gate ran `gateRan` (at its head), then a master batch that caught `broken` and blamed the PR. */
function missOn(h: TestHistory, pr: number, gateRan: string[], broken: string, at: number) {
  h.addRun({ source: 'pr-gate', key: `gate${pr}`, repo: 'o/r', branch: `sandbox/pr${pr}`, sha: `head${pr}`, finished: iso(at) }, gateRan.map((n) => tc(n, 'pass')));
  const { runId } = h.addRun({ source: 'master-batch', key: `mb${pr}`, sha: `tip${pr}`, branch: 'master', finished: iso(at + 3600_000) }, [tc(broken, 'fail')]);
  h.applyBatchVerdict(runId, { culprits: [{ sha: `abcdef${pr}`, pr, tests: [broken] }] });
}

test("findMisses tells a test the culprit's gate never ran from one it ran and passed", async () => {
  const h = new TestHistory({ dataDir: tmp(), now: () => T0 });
  missOn(h, 11, ['Tests.A.Other.x'], 'Tests.A.Leech.bites', T0 - 2 * DAY);
  missOn(h, 12, ['Tests.A.Belt.moves'], 'Tests.A.Belt.moves', T0 - DAY);
  const { runId } = h.addRun({ source: 'master-batch', key: 'mb13', sha: 'tip13', branch: 'master', finished: iso(T0) }, [tc('Tests.A.Gone.y', 'fail')]);
  h.applyBatchVerdict(runId, { culprits: [{ sha: 'abcdef13', pr: 13, tests: ['Tests.A.Gone.y'] }] });
  const misses = await findMisses(h, 'o/r', heads, 0);
  const by = Object.fromEntries(misses.map((m) => [m.test, m]));
  assert.equal(by['Tests.A.Leech']!.verdict, 'not-in-gate');
  assert.equal(by['Tests.A.Leech']!.pr, 11);
  assert.equal(by['Tests.A.Belt']!.verdict, 'gate-ran-passed');
  assert.equal(by['Tests.A.Gone']!.verdict, 'no-gate-record');
  assert.ok(misses.every((m) => !m.baseline));
});

test('the first run records the baseline and files nothing from it; a later miss is filed once, in one request', async () => {
  const h = new TestHistory({ dataDir: tmp(), now: () => T0 });
  missOn(h, 21, [], 'Tests.A.Old.t', T0 - 5 * DAY);
  const filings: { title: string; source: unknown; approved: boolean }[] = [];
  const store = { work: new Map() } as never;
  const identity = { systemPayer: () => ({ userId: 'ben', name: 'Ben' }) } as never;
  const orchestrators = { fileIntake: (f: { title: string; source: unknown; approved: boolean }) => (filings.push(f), { item: { id: `w${900 + filings.length}` } as never }) };
  let now = T0;
  const job = new GateTuningJob({ cfg: cfg(), history: h, store, identity, orchestrators: orchestrators as never, prHead: heads, now: () => now });

  const first = await job.run();
  assert.equal(first.misses.length, 1);
  assert.equal(first.misses[0]!.baseline, true);
  assert.equal(filings.length, 0);
  assert.match(first.summary, /0 new, 1 in the baseline/);

  missOn(h, 22, ['Tests.A.Other.x'], 'Tests.A.New.t', T0 + DAY);
  missOn(h, 23, ['Tests.A.Ran.t'], 'Tests.A.Ran.t', T0 + DAY);
  now = T0 + 2 * DAY;
  const second = await job.tick();
  assert.ok(second);
  assert.equal(filings.length, 1, 'one request a day for all its misses');
  assert.match(filings[0]!.title, /missed 1 test class: pull it in/);
  assert.deepEqual((filings[0]!.source as { masterBatch: unknown }).masterBatch, { run: 'gate-tuning', tip: '2026-11-22', kind: 'gate-miss' });
  assert.equal(filings[0]!.approved, true);
  assert.equal(second.filed, 'w901');
  assert.equal(await job.tick(), undefined, 'not due again the same day');
  now += DAY;
  await job.run();
  assert.equal(filings.length, 1, 'a miss once handled is not filed again');
  assert.equal(latestGateTuning(h)!.day, '2026-11-23');
});

test('a filing that cannot be made is kept pending and tried again', async () => {
  const h = new TestHistory({ dataDir: tmp(), now: () => T0 });
  h.setMeta('gate_tuning_baseline', '0');
  missOn(h, 31, [], 'Tests.A.New.t', T0 - DAY);
  const job = new GateTuningJob({ cfg: cfg(), history: h, prHead: heads, now: () => T0 });
  const t = await job.run();
  assert.equal(t.filePending, true);
  assert.equal(h.meta('gate_tuning_handled') ?? null, null);
  assert.ok(await job.tick(), 'a pending filing makes it due again');
});

test('findProposals: only an always-run class with enough runs, days, no gate failure, no detect and no Performance tag', () => {
  const now = T0;
  const h = new TestHistory({ dataDir: tmp(), now: () => now });
  const runs = 320;
  for (let i = 0; i < runs; i++) {
    const at = now - 20 * DAY + Math.floor((i * 19 * DAY) / runs);
    const cases = [tc('Tests.G.Quiet.a', 'pass', 2000), tc('Tests.G.SaveLayoutGuard.a', 'pass'), tc('Tests.G.Perf.a', 'pass'), tc('Tests.G.Broke.a', i === 5 ? 'fail' : 'pass')];
    if (i % 2 === 0) cases.push(tc('Tests.G.Half.a', 'pass'));
    // A parameterized case repeats its name in one run: run in half the gate runs, it must not read as always-run.
    if (i % 2 === 0) cases.push(tc('Tests.G.Param.a(1)', 'pass'), tc('Tests.G.Param.a(1)', 'pass'), tc('Tests.G.Param.a(1)', 'pass'));
    h.addRun({ source: 'pr-gate', key: `g${i}`, repo: 'o/r', branch: `b${i}`, sha: `s${i}`, finished: iso(at) }, cases);
  }
  h.addRun({ source: 'local', key: 'perf', finished: iso(now - DAY) }, [{ name: 'Tests.G.Perf.a', outcome: 'pass', ms: 5, categories: ['Performance'] }]);
  const out = findProposals(h, now);
  assert.equal(out.gateRuns, runs);
  const names = out.proposals.map((p) => p.test);
  assert.deepEqual(names, ['Tests.G.Quiet', 'Tests.G.SaveLayoutGuard']);
  const quiet = out.proposals[0]!;
  assert.equal(quiet.gateRuns, runs);
  assert.equal(quiet.perRunS, 2);
  assert.equal(quiet.boundPct, Math.round(30000 / runs) / 100, 'rule of three: 3/n');
  assert.equal(quiet.crownJewel, false);
  assert.equal(out.proposals[1]!.crownJewel, true);
  assert.ok(CROWN_JEWEL.test('Tests.Multiplayer.PerFrameSystemCensusTest'));
  assert.equal(findProposals(new TestHistory({ dataDir: tmp(), now: () => now }), now).proposals.length, 0);
  assert.ok(OUT_RULE.minRuns >= 300, '95% bound ≤ 1%');
});

test('the gate_tuning query answers the newest summary and its proposals; the request has its own key and rules', async () => {
  const h = new TestHistory({ dataDir: tmp(), now: () => T0 });
  assert.match(readyQuery(h, { query: 'gate_tuning' }, T0).title, /no run yet/);
  await new GateTuningJob({ cfg: cfg(), history: h, prHead: heads, now: () => T0 }).run();
  const q = readyQuery(h, { query: 'gate_tuning' }, T0);
  assert.match(q.title, /^Merge-gate tuning 2026-11-20/);
  assert.deepEqual(q.rows, []);
  const source = { kind: 'master-batch' as const, untrusted: false, masterBatch: { run: 'gate-tuning', tip: '2026-11-20', kind: 'gate-miss' as const } };
  assert.ok(identityKeys(source).includes('master-batch:gate-miss:2026-11-20'));
  const rules = workerRules({ id: 'w1', source, brief: 'b', triage: { class: 'follow-up', reason: 'r' } } as never);
  assert.match(rules, /gate_tuning\.py check/);
  assert.match(rules, /Nothing is reverted/);
  assert.deepEqual(gateTuningSettings({}), { enabled: true, hourUtc: 9, autoApprove: { enabled: true, maxPerDay: 1 } });
});

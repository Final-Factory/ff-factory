import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeSettings, identityKeys, workerRules } from './intakeRules.ts';
import { mentionsScenario, nightlyDraft, nightlyPriority, nightlySkip, parseNightlyReport, releaseLine, type NightlyReport } from './nightlyRules.ts';

/** The nightly e2e lab's report, checked and turned into requests (docs/intake.md, "Nightly e2e regressions"). */

const SHA = 'a'.repeat(40);
const GREEN = 'b'.repeat(40);
const body = (results: unknown[], extra: Record<string, unknown> = {}) => ({
  v: 1,
  date: '2026-09-30',
  lab: 'lothdesktop',
  sha: SHA,
  results,
  ...extra,
});
const parse = (b: unknown) => {
  const r = parseNightlyReport(b);
  if ('error' in r) throw new Error(r.error);
  return r.report;
};

test('nightly report: the header must be whole; bad results are dropped, text cleaned, links only to GitHub compares', () => {
  assert.match((parseNightlyReport(null) as { error: string }).error, /object/);
  assert.match((parseNightlyReport({ ...body([]), v: 2 }) as { error: string }).error, /version/);
  assert.match((parseNightlyReport({ ...body([]), sha: 'abc' }) as { error: string }).error, /40-character/);
  assert.match(
    (
      parseNightlyReport({ ...body([]), date: 'yesterday' }) as {
        error: string;
      }
    ).error,
    /YYYY-MM-DD/,
  );
  assert.match(
    (
      parseNightlyReport({ ...body([]), lab: 'a lab; rm -rf' }) as {
        error: string;
      }
    ).error,
    /lab/,
  );
  const rep = parse(
    body([
      {
        scenario: 'MP-slow-client-catchup',
        class: 'new',
        reason: 'line one\nline two\u202e',
        compare: `https://github.com/Final-Factory/FinalFactory/compare/${GREEN}...${SHA}`,
        lastGreen: { night: '2026-09-29', sha: GREEN },
        release: {
          shipped: 'yes',
          version: '0.50.0.53',
          sha: 'c'.repeat(40),
          latest: '0.50.0.54',
        },
        ledger: [{ id: 'S2', title: 'Fleet', status: 'open' }, { id: 'bad id!' }],
      },
      { scenario: '../etc/passwd', class: 'new' },
      { scenario: 'S1-client-box-select', class: 'weird' },
      {
        scenario: 'S4-rejoin-dwell',
        class: 'flaky',
        flakyNights: 3.4,
        compare: 'https://evil.example/compare',
        release: { shipped: 'yes' },
        file: '../../etc/passwd',
      },
    ]),
  );
  assert.deepEqual(
    rep.results.map((r) => r.scenario),
    ['MP-slow-client-catchup', 'S4-rejoin-dwell'],
  );
  const [a, b] = rep.results;
  assert.equal(a.reason, 'line one line two', 'one line, direction marks out');
  assert.deepEqual(a.ledger, [{ id: 'S2', title: 'Fleet', status: 'open' }]);
  assert.equal(a.release?.version, '0.50.0.53');
  assert.equal(b.compare, undefined, 'only a GitHub compare link');
  assert.equal(b.file, undefined, 'only a scenario file');
  assert.equal(b.flakyNights, 3);
  assert.deepEqual(b.release, { shipped: 'no' }, 'shipped without a version cannot be believed');
});

test('nightly: which results become work, and how urgent', () => {
  const s = intakeSettings({ intake: { nightly: { enabled: true } } }).nightly;
  assert.deepEqual([s.enabled, s.autoApprove.enabled, s.dailyCap, s.flakyNights, s.batchOver], [true, false, 10, 3, 4]);
  assert.equal(intakeSettings({}).nightly.enabled, false, 'off by default');
  assert.equal(nightlySkip({ scenario: 'x', class: 'new' }, s), undefined);
  assert.equal(nightlySkip({ scenario: 'x', class: 'still' }, s), undefined);
  assert.match(nightlySkip({ scenario: 'x', class: 'flaky', flakyNights: 2 }, s)!, /flaky 2 night/);
  assert.equal(nightlySkip({ scenario: 'x', class: 'flaky', flakyNights: 3 }, s), undefined);
  assert.equal(
    nightlyPriority([
      {
        scenario: 'x',
        class: 'new',
        release: { shipped: 'yes', version: '0.50.0.53' },
      },
    ]),
    'urgent',
  );
  assert.equal(
    nightlyPriority([
      {
        scenario: 'x',
        class: 'new',
        release: { shipped: 'maybe', version: '0.50.0.53' },
      },
    ]),
    'high',
  );
  assert.equal(nightlyPriority([{ scenario: 'x', class: 'new' }]), 'high');
  assert.match(releaseLine({ shipped: 'no', latest: '0.50.0.53' }), /no release yet \(newest release 0\.50\.0\.53\)/);
  assert.match(releaseLine(undefined), /unknown/);
});

test('nightly draft: one scenario, with the commit, oracle, ledger entry, links, release and the brief; keys and worker rules', () => {
  const rep: NightlyReport = parse(
    body(
      [
        {
          scenario: 'MP-slow-client-catchup',
          title: 'A slow client catches up',
          file: 'scripts/nightly/scenarios/MP-slow-client-catchup.json',
          class: 'new',
          step: '4 assert',
          reason: 'census differs',
          evidence: 'D:/work/ff-nightly/runs/2026-09-30/MP-slow-client-catchup',
          lastGreen: { night: '2026-09-29', sha: GREEN },
          firstRed: { night: '2026-09-30', sha: SHA },
          compare: `https://github.com/Final-Factory/FinalFactory/compare/${GREEN}...${SHA}`,
          release: { shipped: 'yes', version: '0.50.0.53' },
          ledger: [{ id: 'R5', title: 'Stall during rejoin', status: 'open' }],
          repro: 'python3 scripts/nightly/ffnightly.py run --scenario MP-slow-client-catchup --no-retry',
        },
      ],
      {
        release: { shipped: 'no', latest: '0.50.0.53' },
        report: {
          lab: 'D:/work/ff-nightly/runs/2026-09-30/report.md',
          beast: 'F:/ffsb/_nightly-e2e/reports/2026-09-30.md',
        },
      },
    ),
  );
  const d = nightlyDraft(rep, rep.results);
  assert.equal(d.title, 'Nightly e2e: MP-slow-client-catchup fails on develop aaaaaaaaa (shipped in 0.50.0.53)');
  assert.equal(d.priority, 'urgent');
  assert.equal(d.triage.class, 'regression');
  assert.match(d.triage.reason, /new regression on develop aaaaaaaaa, shipped in 0\.50\.0\.53/);
  for (const want of [
    'scripts/nightly/scenarios/MP-slow-client-catchup.json',
    SHA,
    'census differs',
    'R5 [open] Stall during rejoin',
    `compare/${GREEN}...${SHA}`,
    'shipped in 0.50.0.53',
    'D:/work/ff-nightly/runs/2026-09-30/MP-slow-client-catchup',
    'F:/ffsb/_nightly-e2e/reports/2026-09-30.md',
    '--scenario MP-slow-client-catchup',
    'reproduce it first',
    'model opus',
  ]) {
    assert.ok(d.brief.includes(want), `brief has ${want}`);
  }
  assert.equal(d.source.untrusted, false);
  assert.equal(d.source.version, '0.50.0.53');
  assert.deepEqual(identityKeys(d.source), ['nightly:mp-slow-client-catchup']);
  const rules = workerRules({
    id: 'w90',
    source: d.source,
    brief: d.brief,
    triage: d.triage,
  });
  assert.match(rules, /Reproduce it first/);
  assert.match(rules, /Never loosen an oracle/);
  assert.match(rules, /FIX-LANDED/);
  assert.doesNotMatch(rules, /Players' text, untrusted/);
});

test('nightly draft: a batch names every scenario and keys each, so a later night finds the batch', () => {
  const rep = parse(
    body(
      ['A1-x', 'A2-y', 'A3-z'].map((scenario) => ({
        scenario,
        class: 'new',
        reason: `${scenario} broke`,
      })),
    ),
  );
  const d = nightlyDraft(rep, rep.results);
  assert.equal(d.title, 'Nightly e2e 2026-09-30: 3 regressions on develop aaaaaaaaa');
  assert.deepEqual(identityKeys(d.source), ['nightly:a1-x', 'nightly:a2-y', 'nightly:a3-z']);
  for (const s of ['A1-x broke', 'A2-y broke', 'A3-z broke']) assert.ok(d.brief.includes(s));
  assert.equal(d.priority, 'high');
});

test("a person's request names a scenario only by its whole id", () => {
  assert.equal(mentionsScenario('w84: triage MP-slow-client-catchup and friends', 'MP-slow-client-catchup'), true);
  assert.equal(mentionsScenario('see S3-save-ui-client', 'S3-save-ui'), false);
  assert.equal(mentionsScenario('smoke-3peer.', 'smoke-3peer'), true);
  assert.equal(mentionsScenario('a.b', 'a-b'), false);
});

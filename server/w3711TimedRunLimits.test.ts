import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from './attachments.ts';
import { TimedRuns } from './timedRuns.ts';
import { legPlanS, LEG_PLAN_MAX_S, runBoundMinutes, runPlanMinutes, timedPlanProblem, timedSettingsOf, TIMED_DEFAULTS, type TimedSettings } from '../shared/timedRun.ts';
import { timedRunFromMachine } from '../machine/timedRunPack.ts';
import type { Machine } from '../shared/types.ts';

/**
 * w3711: lothsahn, 2026-11-08: "106 minutes is super long. It should do 10 minute samples and run no longer than 30m per
 * lock." And 2026-10-26: "workers should avoid more than 2 tests on each before/after unless there's a strong reason to
 * suspect it's wrong. And each test should be short: 5-10 minutes at most." w3639's tr_dadec6ac06 asked for 4 builds x 2
 * rounds at sample_s 180 (8 legs, a 106-minute bound), and the tool took it with no question.
 */

const settings = (a: Record<string, unknown>) => timedSettingsOf(a) as TimedSettings;
const REASON = 'round 2 of fix240 read 30% off round 1; a third pair settles which is right';

test('w3711: two samples per side by default; a third needs a stated reason', () => {
  assert.equal(TIMED_DEFAULTS.rounds, 2, 'the default is 2 rounds (it was 4)');
  assert.equal(timedPlanProblem(settings({}), 2), undefined, 'the defaults pass');
  assert.match(timedPlanProblem(settings({ rounds: 4 }), 2) ?? '', /at most 2 samples per side .* say why in reason/);
  assert.match(timedPlanProblem(settings({ rounds: 3 }), 2, 'more data') ?? '', /rounds 3/, 'a word is not a reason');
  assert.equal(timedPlanProblem(settings({ rounds: 4 }), 2, REASON), undefined);
});

test('w3711: a leg (launch and load included) is refused past 10 minutes, reason or not', () => {
  const long = settings({ rounds: 1, sample_s: 300, settle_s: 300 });
  assert.ok(legPlanS(long) > LEG_PLAN_MAX_S);
  assert.match(timedPlanProblem(long, 1, REASON) ?? '', /launch and load .* past the 10-minute cap/);
  assert.equal(timedPlanProblem(settings({ rounds: 1, sample_s: 300, settle_s: 25 }), 1), undefined, 'a 5-minute sample fits');
});

test("w3711: tr_dadec6ac06's plan, more legs than one exclusive lock plays, is refused unless a reason says why", () => {
  // 4 builds (base and fix at targets 120 and 240) x 2 rounds at sample 180, settle 25: what w3639's worker sent
  const s = settings({ rounds: 2, sample_s: 180, settle_s: 25 });
  assert.equal(runBoundMinutes(s, 4), 106, 'the bound the tool answered, which the worker quoted as the run length');
  assert.ok(runPlanMinutes(s, 4) < runBoundMinutes(s, 4), `the play it planned is ${runPlanMinutes(s, 4)} min`);
  assert.match(timedPlanProblem(s, 4) ?? '', /8 legs of about 310 s each .* past what one exclusive lock plays .* 4 legs fit in one/);
  assert.equal(timedPlanProblem(s, 4, REASON), undefined, 'with a reason it plays in turns, each queued again at the back');
  assert.equal(timedPlanProblem(s, 2), undefined, 'one before/after pair of it (4 legs) fits in one lock');
});

test('w3711: the worker daemon refuses the plan before it reads a build, and the portal refuses it too', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w3711-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  let asked = 0;
  const builds = ['a', 'b', 'c', 'd'].map((n) => ({ name: n, path: `builds/${n}` }));
  await assert.rejects(
    timedRunFromMachine({ portalUrl: 'http://127.0.0.1:1', token: 'x', roots: [d], cwd: d, tempDir: path.join(d, 'tmp'), args: { builds, save: 'save.zip', rounds: 2, sample_s: 180, settle_s: 25 }, rpc: async () => (asked++, '{}') }),
    /past what one exclusive lock plays/,
  );
  assert.equal(asked, 0, 'nothing went to the portal');

  const tr = new TimedRuns({
    dataDir: path.join(d, 'portal'),
    store: new AttachmentStore(path.join(d, 'portal')),
    machines: () => [{ id: 'lothlaptop', platform: 'win32' } as unknown as Machine],
    isOnline: () => true,
    offers: () => true,
    post: () => true,
    deliver: async () => {},
  });
  const variant = (name: string) => ({ name, args: [], files: [{ path: 'finalfactory.exe', size: 3 }], pieces: [{ sha256: 'a'.repeat(64), size: 3, parts: [{ path: 'finalfactory.exe', offset: 0, length: 3 }] }] });
  const who = { session: 'sess', requests: ['w3639'], what: 'w3639 vSync' };
  const a = { variants: ['base120', 'fix120', 'base240', 'fix240'].map(variant), save: { name: 'save.zip', size: 10, sha256: 'b'.repeat(64) }, rounds: 2, sample_s: 180, settle_s: 25, machine: 'lothlaptop' };
  assert.throws(() => tr.plan('beast', who, a), /past what one exclusive lock plays/);
  assert.throws(() => tr.plan('beast', who, { ...a, sample_s: 20, rounds: 4 }), /at most 2 samples per side/);
  assert.throws(() => tr.plan('beast', who, { ...a, sample_s: 300, settle_s: 300, reason: REASON }), /10-minute cap/);
});

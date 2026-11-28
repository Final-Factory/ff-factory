import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FfuSlotAutoSweep, staleSlotsOf, type FfuSlotSweepMode } from './ffuSlotAutoSweep.ts';
import { FFU_SLOT_SWEEP_KILL_MS, runFfuSlotSweep } from './ffuSlots.ts';
import { staleOutputSettings } from '../server/staleOutput.ts';
import type { FfuSlotsReport } from '../shared/types.ts';

/** The three stale holds of 2026-11-27 (w6484) and a live one beside them, as `ffu-slot list --json` reported them. */
const REPORT: FfuSlotsReport = {
  at: '2026-11-27T20:00:00.000Z',
  max: 4,
  slots: [
    { id: 'slot1', branch: 'w5512-turret-power', free: true, stale: false, why: 'released' },
    { id: 'slot2', holder: 'fba87b86', holderIs: 'live', branch: 'w6270-g6a-rerun', free: false, stale: false, why: 'held by fba87b86, which runs, used 29 min ago' },
    { id: 'slot3', holder: '49495827', holderIs: 'stopped', branch: 'w5479-m6-4b-ballista-suture', free: true, stale: true, why: 'held by 49495827, which no longer runs, unused for 255 min; its checkout has 10 uncommitted change(s), saved on a rescue branch first' },
    { id: 'slot4', holder: '5493f091', holderIs: 'gone', branch: 'w6097-ff1-body-look', free: true, stale: true, why: 'held by 5493f091, which is on no open request, and its work is pushed' },
    // w6495's review: a holder that still runs is left to a take, though the rule calls its slot stale
    { id: 'slot5', holder: 'cf8b12cb', holderIs: 'live', branch: 'w6295-newgame-hash', free: true, stale: true, why: 'held by cf8b12cb, which is on no open request, and its work is pushed' },
  ],
};

function rig(mode: FfuSlotSweepMode, sweep: () => Promise<{ ok: boolean; out: string }> = async () => ({ ok: true, out: '' })) {
  const logs: string[] = [];
  let sweeps = 0;
  const a = new FfuSlotAutoSweep({ mode: () => mode, sweep: () => (sweeps++, sweep()), log: (s) => void logs.push(s) });
  return { a, logs, sweeps: () => sweeps };
}

test('w6484: the stale slots of a report are the free ones a holder that no longer runs still holds', () => {
  assert.deepEqual(staleSlotsOf(REPORT).map((s) => s.id), ['slot3', 'slot4']);
  assert.deepEqual(staleSlotsOf(undefined), []);
  const running = { ...REPORT, slots: REPORT.slots.filter((s) => s.id === 'slot5') };
  assert.deepEqual(staleSlotsOf(running), [], 'a running holder is left to a take');
});

test('w6484: on by default (the enforce step); the portal turns it back to warn or off', () => {
  assert.equal(staleOutputSettings({}).ffuSlotSweep, 'on', 'enforce step: lothsahn turned it on everywhere');
  assert.equal(staleOutputSettings({ ffuSlotSweep: 'yes' }).ffuSlotSweep, 'on', 'an unknown value keeps the default');
  assert.equal(staleOutputSettings({ ffuSlotSweep: 'warn' }).ffuSlotSweep, 'warn', 'recovery: warn from the portal');
  assert.equal(staleOutputSettings({ ffuSlotSweep: 'off' }).ffuSlotSweep, 'off', 'recovery: off from the portal');
});

test('w6484: warn-only says each stale hold once and frees nothing', async () => {
  const r = rig('warn');
  assert.deepEqual(await r.a.onReport(REPORT), ['slot3', 'slot4']);
  assert.equal(r.sweeps(), 0, 'no sweep runs');
  assert.equal(r.logs.length, 2);
  assert.match(r.logs[0], /would free slot3 on w5479-m6-4b-ballista-suture: held by 49495827, which no longer runs, unused for 255 min; .*rescue branch first/);
  assert.match(r.logs[1], /would free slot4 on w6097-ff1-body-look: held by 5493f091, which is on no open request/);
  await r.a.onReport(REPORT);
  assert.equal(r.logs.length, 2, 'the next report of the same holds says nothing again');
  // slot4 taken by a new holder that then goes stale: said again
  const next = { ...REPORT, slots: REPORT.slots.map((s) => (s.id === 'slot4' ? { ...s, holder: 'ab12cd34' } : s)) };
  await r.a.onReport(next);
  assert.equal(r.logs.length, 3);
  assert.match(r.logs[2], /would free slot4/);
});

test('w6484: on runs one sweep per report with stale holds and logs what it freed; off and a report with none run nothing', async () => {
  const out = 'ffu-slot: saved 49495827\'s work in slot3 (a73c912d) on branch rescue/ffu-slot/slot3-49495827-a73c912d, pushed to origin\nffu-slot: freed slot3: held by 49495827\nffu-slot: freed slot4: held by 5493f091\nffu-slot: freed slot3, slot4; their targets stay warm\n(node:1) ExperimentalWarning: Type Stripping\n';
  const on = rig('on', async () => ({ ok: true, out }));
  assert.deepEqual(await on.a.onReport(REPORT), ['slot3', 'slot4']);
  assert.equal(on.sweeps(), 1);
  assert.ok(on.logs.some((l) => /auto sweep: saved 49495827's work in slot3 .* on branch rescue\/ffu-slot\/slot3-49495827-a73c912d, pushed to origin/.test(l)), on.logs.join('\n'));
  assert.ok(!on.logs.some((l) => /ExperimentalWarning/.test(l)), 'node noise is not logged');
  const none = { ...REPORT, slots: REPORT.slots.filter((s) => !s.stale) };
  assert.deepEqual(await on.a.onReport(none), []);
  assert.equal(on.sweeps(), 1, 'nothing stale: no sweep');
  const live = rig('on', async () => ({ ok: true, out }));
  assert.deepEqual(await live.a.onReport({ ...REPORT, slots: REPORT.slots.filter((s) => s.id !== 'slot3' && s.id !== 'slot4') }), []);
  assert.equal(live.sweeps(), 0, 'only a running holder is stale: no sweep');
  const off = rig('off');
  assert.deepEqual(await off.a.onReport(REPORT), []);
  assert.equal(off.sweeps() + off.logs.length, 0);
});

test('w6484: a failing sweep is a log line, once while it fails the same way, and never throws', async () => {
  const r = rig('on', async () => ({ ok: false, out: 'ffu-slot: git commit failed: index.lock exists\n' }));
  assert.deepEqual(await r.a.onReport(REPORT), []);
  await r.a.onReport(REPORT);
  assert.deepEqual(r.logs, ['ffu slots: auto sweep failed: ffu-slot: git commit failed: index.lock exists']);
  const t = rig('on', async () => {
    throw new Error('spawn failed');
  });
  assert.deepEqual(await t.a.onReport(REPORT), []);
  assert.match(t.logs[0], /auto sweep failed: spawn failed/);
});

test('w6484: runFfuSlotSweep runs the script with sweep and no session, and says how it exited', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6484-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake.mjs');
  fs.writeFileSync(script, "process.stdout.write(`ffu-slot: freed slot9: ${process.argv[2]} ${JSON.stringify(process.env.FF_SESSION_ID)} ${process.env.FF_WORKER_ROOT}\\n`); process.exit(process.env.FF_FFU_SLOTS_MAX === '3' ? 1 : 0);\n");
  const ok = await runFfuSlotSweep({ root: dir, factsFile: path.join(dir, 'facts.json'), max: 4, script });
  assert.equal(ok.ok, true);
  assert.equal(ok.out.trim(), `ffu-slot: freed slot9: sweep "" ${dir}`);
  assert.equal((await runFfuSlotSweep({ root: dir, factsFile: 'x', max: 3, script })).ok, false);
});

test('w6484: the daemon sweep has no kill timer: killed inside the slots lock it would leave the lock held and its git running (w6495)', async (t) => {
  assert.equal(FFU_SLOT_SWEEP_KILL_MS, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6484-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'slow.mjs');
  fs.writeFileSync(script, "setTimeout(() => { process.stdout.write('ffu-slot: no slot to free'); process.exit(0); }, 1500);");
  // A short kill timer (as a test may set) does kill it; the default lets it finish.
  assert.equal((await runFfuSlotSweep({ root: dir, factsFile: 'x', max: 4, script, timeoutMs: 200 })).ok, false);
  const r = await runFfuSlotSweep({ root: dir, factsFile: 'x', max: 4, script });
  assert.equal(r.ok, true, r.out);
});

test('w6803: a due unpushed rescue runs a sweep with no stale slot; a failed rescue push is logged as a failure; one not due runs nothing', async () => {
  const quiet = { ...REPORT, slots: REPORT.slots.filter((s) => !s.stale) };
  const rescue = { branch: 'rescue/ffu-slot/slot2-5a78ddd2-7e2a4052', holder: '5a78ddd2', slot: 'slot2', at: '2026-11-28T03:08:17.003Z' };
  const out = "ffu-slot: rescue push failed: rescue/ffu-slot/slot2-5a78ddd2-7e2a4052 (5a78ddd2's work from slot2, 7e2a4052) is in /x/repo only, tried again on a later sweep: remote: error: GH007: Your push would publish a private email address.\nffu-slot: no slot to free\n";
  const on = rig('on', async () => ({ ok: true, out }));
  assert.deepEqual(await on.a.onReport({ ...quiet, unpushedRescues: [{ ...rescue, due: false }] }), []);
  assert.equal(on.sweeps(), 0, 'not due: no sweep');
  assert.deepEqual(await on.a.onReport({ ...quiet, unpushedRescues: [{ ...rescue, due: true }] }), []);
  assert.equal(on.sweeps(), 1, 'due: a sweep tries it again');
  assert.ok(on.logs.some((l) => /^ffu slots: auto sweep failed: rescue push of rescue\/ffu-slot\/slot2-5a78ddd2-7e2a4052 .*GH007/.test(l)), on.logs.join('\n'));
  const warn = rig('warn', async () => ({ ok: true, out }));
  await warn.a.onReport({ ...quiet, unpushedRescues: [{ ...rescue, due: true, error: 'GH007' }] });
  await warn.a.onReport({ ...quiet, unpushedRescues: [{ ...rescue, due: true, error: 'GH007' }] });
  assert.equal(warn.sweeps(), 0);
  assert.equal(warn.logs.filter((l) => /auto sweep failed: rescue push of .* warn-only/.test(l)).length, 1, 'warn names it once');
});

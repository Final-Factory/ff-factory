import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFU_SLOT_WAIT_GRACE_MS, ffuSlotMain, readFfuSlotsReport, readSlotState, realFfuSlotDeps, slotCheckout, slotsReport, takeSlot, type FfuSlotDeps } from '../machine/ffuSlots.ts';
import type { CleanupGuard } from './cleanup.ts';
import { ffuSlotLines, pageAllStats, pageStats } from './ffuSlotsView.ts';
import { installLeftoverSettings, planInstallLeftovers } from './installLeftovers.ts';
import type { FfuSlotsReport, MachineStats } from '../shared/types.ts';

/**
 * w5912: the daemon reports each machine's ffu slots (machine/ffuSlots.ts slotsReport, `ffu-slot list --json`) with the same
 * judgement as `ffu-slot list`, the clean-up pass hands it each target's size, and the portal says them in list_sandboxes and
 * list_machines (server/ffuSlotsView.ts) and gives the page them without the `why` sentence. Real git against a local origin.
 */

const NOW = Date.now();

function git(args: string[], cwd?: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function world(t: { after: (fn: () => void) => void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w5912-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const work = path.join(base, 'src');
  fs.mkdirSync(work);
  git(['init', '-q', '-b', 'main'], work);
  git(['config', 'user.email', 't@example.com'], work);
  git(['config', 'user.name', 't'], work);
  fs.writeFileSync(path.join(work, 'Cargo.toml'), '[workspace]\n');
  git(['add', '.'], work);
  git(['commit', '-qm', 'one'], work);
  const remote = path.join(base, 'origin.git');
  git(['clone', '-q', '--bare', work, remote]);
  const root = path.join(base, 'install');
  fs.mkdirSync(root);
  return { base, root, remote };
}

type Facts = { live?: string[]; resumable?: string[]; at?: number };
const factsOf = (root: string, f: Facts) =>
  ({ at: new Date(f.at ?? NOW).toISOString(), connected: true, root, tempRoot: path.join(root, 'tmp'), sandboxes: [], live: f.live ?? [], resumable: f.resumable ?? [], open: [], closed: [] }) as NonNullable<FfuSlotDeps['facts']>;

function deps(root: string, session: string, f: Facts = {}, now = NOW): FfuSlotDeps & { out: string[] } {
  const out: string[] = [];
  return { ...realFfuSlotDeps({ FF_WORKER_ROOT: root, FF_SESSION_ID: session }), max: 4, facts: factsOf(root, f), freeGB: () => 500, now: () => now, write: (s) => void out.push(s), say: () => {}, out };
}

/** Four slots: slot1 held by a live worker, slot2 by one gone with its work pushed, slot3 by a stopped one with an edit, slot4 released. */
function fourSlots(root: string, remote: string) {
  const all = ['live0001', 'gone0002', 'stop0003', 'free0004'];
  for (const s of all) takeSlot(deps(root, s, { live: all }), { remote });
  fs.writeFileSync(path.join(slotCheckout(root, 'slot3'), 'edit.rs'), '// not committed\n');
  const file = path.join(root, 'ffu-sandboxes', 'slots.json');
  const st = readSlotState(root);
  delete st.slots[3].holder;
  fs.writeFileSync(file, JSON.stringify(st));
  return { live: ['live0001'], resumable: ['stop0003'] };
}

test('w5912: the report gives each slot its holder, whether the holder runs, its branch, commit and last use, and flags a stale hold as ffu-slot list judges it', (t) => {
  const { root, remote } = world(t);
  const f = fourSlots(root, remote);
  const r = slotsReport(deps(root, '', f));
  assert.equal(r.max, 4);
  const [s1, s2, s3, s4] = r.slots;
  assert.deepEqual([s1.holder, s1.holderIs, s1.free, s1.stale], ['live0001', 'live', false, false], s1.why ?? '');
  assert.match(s1.commit ?? '', /^[0-9a-f]{12}$/);
  assert.ok(Date.parse(s1.usedAt!) > NOW - 60_000, 'its take is its last use');
  // Gone with its work pushed: another worker may take it now, so the hold is stale (w5885's notion).
  assert.deepEqual([s2.holderIs, s2.free, s2.stale], ['gone', true, true], s2.why ?? '');
  assert.match(s2.why!, /no longer runs, and its work is pushed/);
  // Stopped with an uncommitted edit, used just now: kept for a short wait, not stale yet.
  assert.deepEqual([s3.holderIs, s3.free, s3.stale], ['stopped', false, false], s3.why ?? '');
  assert.match(s3.why!, /kept 30 min for a short wait/);
  assert.deepEqual([s4.holder, s4.holderIs, s4.free, s4.stale, s4.why], [undefined, undefined, true, false, 'released']);
  // Past the grace the stopped holder's slot is stale too, its edit to be saved on a rescue branch first.
  const later = slotsReport(deps(root, '', { ...f, at: NOW + FFU_SLOT_WAIT_GRACE_MS + 120_000 }, NOW + FFU_SLOT_WAIT_GRACE_MS + 120_000)).slots[2];
  assert.deepEqual([later.free, later.stale], [true, true], later.why ?? '');
  assert.match(later.why!, /saved on a rescue branch first/);
  // Facts older than 15 min: no holder is known to have stopped, so nothing is stale.
  const old = slotsReport(deps(root, '', { ...f, at: NOW - 20 * 60_000 }));
  assert.deepEqual(old.slots.map((s) => [s.holderIs, s.stale]), [['unknown', false], ['unknown', false], ['unknown', false], [undefined, false]]);
});

test('w5912: `ffu-slot list --json` prints the report, and the plain list says the same why for each slot', (t) => {
  const { root, remote } = world(t);
  const f = fourSlots(root, remote);
  const d = deps(root, '', f);
  assert.equal(ffuSlotMain(['list', '--json'], d), 0);
  const r = JSON.parse(d.out.join('')) as FfuSlotsReport;
  assert.deepEqual(r.slots.map((s) => s.id), ['slot1', 'slot2', 'slot3', 'slot4']);
  const plain = deps(root, '', f);
  assert.equal(ffuSlotMain(['list'], plain), 0);
  const lines = plain.out.join('').trim().split('\n');
  for (const [i, s] of r.slots.entries()) assert.ok(lines[i].endsWith(`\t${s.why}`), `${lines[i]} / ${s.why}`);
});

test('w5912: the daemon reads the report in a child process and adds each target size the clean-up pass measured', async (t) => {
  const { base, root, remote } = world(t);
  const f = fourSlots(root, remote);
  const factsFile = path.join(base, 'cleanup-facts.json');
  fs.writeFileSync(factsFile, JSON.stringify(factsOf(root, { ...f, at: Date.now() })));
  const sizes = new Map([['slot2', { bytes: 14 * 1024 ** 3, at: '2026-11-26T05:00:00.000Z' }]]);
  const r = await readFfuSlotsReport({ root, factsFile, max: 4, sizes });
  assert.ok(r, 'a report');
  assert.deepEqual(r.slots.map((s) => [s.id, s.holderIs ?? '-', s.stale]), [['slot1', 'live', false], ['slot2', 'gone', true], ['slot3', 'stopped', false], ['slot4', '-', false]]);
  assert.deepEqual([r.slots[1].targetBytes, r.slots[1].sizedAt], [14 * 1024 ** 3, '2026-11-26T05:00:00.000Z']);
  assert.equal(r.slots[0].targetBytes, undefined, 'a target never measured has no size');
  // No slot made yet: no report, and no child is started.
  assert.equal(await readFfuSlotsReport({ root: path.join(base, 'empty'), factsFile, max: 4 }), undefined);
});

test('w5912: the clean-up pass hands each slot target it measures to the daemon', async (t) => {
  const { root } = world(t);
  const tgt = path.join(root, 'ffu-sandboxes', 'slot1', 'target');
  fs.mkdirSync(path.join(tgt, 'debug', 'deps'), { recursive: true });
  fs.writeFileSync(path.join(tgt, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n');
  fs.writeFileSync(path.join(tgt, 'debug', 'deps', 'x.rlib'), Buffer.alloc(4096));
  fs.mkdirSync(path.join(root, 'ffu-sandboxes', 'slot1', 'ffu'), { recursive: true });
  const guard: CleanupGuard = { keep: [path.join(root, 'sandboxes')], inUse: [], home: path.join(root, 'home') };
  const sized: [string, number][] = [];
  await planInstallLeftovers({ root, sandboxes: [], tempRoots: [], guard, procs: [], settings: installLeftoverSettings({}), localWork: async () => false, heldMinBytes: 0, alive: () => true, runnerLog: () => undefined, scope: 'cargo-cap', ffuSized: (s, b) => void sized.push([s, b]) });
  assert.equal(sized.length, 1, JSON.stringify(sized));
  assert.equal(sized[0][0], 'slot1');
  assert.ok(sized[0][1] >= 4096, `${sized[0][1]} bytes`);
});

const REPORT: FfuSlotsReport = {
  at: new Date(NOW - 60_000).toISOString(),
  max: 4,
  slots: [
    { id: 'slot1', holder: 'live0001', holderIs: 'live', branch: 'w5655-heat-links', commit: 'abcdef123456', takenAt: new Date(NOW - 3 * 3_600_000).toISOString(), usedAt: new Date(NOW - 5 * 60_000).toISOString(), free: false, stale: false, why: 'held by live0001, which runs, used 5 min ago', targetBytes: 9.3 * 1024 ** 3, sizedAt: new Date(NOW - 20 * 60_000).toISOString() },
    { id: 'slot2', holder: 'gone0002', holderIs: 'gone', branch: 'w5633-shared-fleet', free: true, stale: true, why: 'held by gone0002, which no longer runs, and its work is pushed' },
    { id: 'slot3', free: true, stale: false, why: 'released' },
  ],
};

test('w5912: list_sandboxes says who holds each ffu slot, its request, branch and commit, since when, its target and STALE', () => {
  const lines = ffuSlotLines('lothdesktop', REPORT, (id) => (id === 'live0001' ? { title: 'w5655: heat links', requests: ['w5655'] } : undefined), NOW);
  assert.equal(lines[0], 'ffu slots (2 of 3 held, 1 stale (up to 4); ffu-slot list\'s judgement, 1 min ago; docs/ffu-sandboxes.md):');
  assert.equal(
    lines[1],
    '- lothdesktop/ffu slot1: held by live0001 "w5655: heat links" (w5655) [live]; branch w5655-heat-links at abcdef123456; held for 3 h; used 5 min ago; target 9.3 GB (measured 20 min ago); held by live0001, which runs, used 5 min ago',
  );
  assert.match(lines[2], /^- lothdesktop\/ffu slot2: held by gone0002 \[gone\] STALE; branch w5633-shared-fleet; .*target not measured yet; held by gone0002, which no longer runs/);
  assert.match(lines[3], /^- lothdesktop\/ffu slot3: FREE \(released\); branch \(origin\/main\); target not measured yet; released$/);
  assert.deepEqual(ffuSlotLines('m', undefined, () => undefined), [], 'a daemon that reported none adds no lines');
});

test('w5912: the page gets the ffu slots without their why sentence; the portal keeps it for the tools', () => {
  const stats = { at: new Date(NOW).toISOString(), ffuSlots: REPORT } as unknown as MachineStats;
  const page = pageStats(stats);
  assert.ok(page.ffuSlots!.slots.every((s) => !('why' in s)));
  assert.equal(page.ffuSlots!.slots[1].stale, true);
  assert.ok(REPORT.slots.every((s) => s.why), 'the stored report is not changed');
  const all = pageAllStats({ a: stats, b: { at: stats.at } as unknown as MachineStats });
  assert.equal(all.b.ffuSlots, undefined);
  assert.ok(JSON.stringify(all).length < JSON.stringify({ a: stats }).length);
});

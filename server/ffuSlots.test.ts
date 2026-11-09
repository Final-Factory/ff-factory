import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffuSlotMain, readSlotState, realFfuSlotDeps, slotCheckout, slotTarget, takeSlot, releaseSlot, type FfuSlotDeps } from '../machine/ffuSlots.ts';
import type { CleanupGuard } from './cleanup.ts';
import { installLeftoverSettings, planInstallLeftovers, type ProcLite } from './installLeftovers.ts';

/**
 * w3764: ffu slots, per-machine ffu worktrees with warm cargo targets (machine/ffuSlots.ts), and the clean-up rule for their
 * targets (server/installLeftovers.ts, ffu-slot-target). The leases run real git against a local "origin".
 */

const NOW = Date.now();
const HOUR = 3_600_000;

function git(args: string[], cwd?: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** An install folder and an "origin" ffu repo with main and a branch `feat`. */
function world(t: { after: (fn: () => void) => void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w3764-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const work = path.join(base, 'src');
  fs.mkdirSync(work);
  git(['init', '-q', '-b', 'main'], work);
  git(['config', 'user.email', 't@example.com'], work);
  git(['config', 'user.name', 't'], work);
  fs.writeFileSync(path.join(work, 'Cargo.toml'), '[workspace]\n');
  git(['add', '.'], work);
  git(['commit', '-qm', 'one'], work);
  git(['checkout', '-qb', 'feat'], work);
  fs.writeFileSync(path.join(work, 'feat.rs'), '// feat\n');
  git(['add', '.'], work);
  git(['commit', '-qm', 'feat'], work);
  git(['checkout', '-q', 'main'], work);
  const remote = path.join(base, 'origin.git');
  git(['clone', '-q', '--bare', work, remote]);
  const root = path.join(base, 'install');
  fs.mkdirSync(root);
  return { root, remote };
}

function deps(root: string, session: string, o: { live?: string[]; max?: number; freeGB?: number; factsAt?: number } = {}): FfuSlotDeps & { out: string[]; said: string[] } {
  const out: string[] = [];
  const said: string[] = [];
  const real = realFfuSlotDeps({ FF_WORKER_ROOT: root, FF_SESSION_ID: session });
  return {
    ...real,
    max: o.max ?? 2,
    facts: { at: new Date(o.factsAt ?? NOW).toISOString(), connected: true, root, tempRoot: path.join(root, 'tmp'), sandboxes: [], live: o.live ?? [session], resumable: [], open: [], closed: [] } as FfuSlotDeps['facts'],
    freeGB: () => o.freeGB ?? 500,
    write: (s) => void out.push(s),
    say: (s) => void said.push(s),
    out,
    said,
  };
}

test('w3764: a worker takes a slot on its branch, keeps it, and the next worker gets the warm one once it is released', (t) => {
  const { root, remote } = world(t);
  const a = deps(root, 'aaaa1111');
  const id = takeSlot(a, { branch: 'feat', remote });
  assert.equal(id, 'slot1');
  assert.ok(fs.existsSync(path.join(slotCheckout(root, id), 'feat.rs')), 'the checkout is on origin/feat');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], slotCheckout(root, id)), 'feat');
  assert.equal(takeSlot(a, { remote }), 'slot1', 'a worker keeps the slot it holds');
  fs.mkdirSync(path.join(slotTarget(root, id), 'debug'), { recursive: true });
  fs.writeFileSync(path.join(slotTarget(root, id), 'debug', 'warm.rlib'), 'x');

  const b = deps(root, 'bbbb2222', { live: ['aaaa1111', 'bbbb2222'] });
  assert.equal(takeSlot(b, { branch: 'feat', remote }), 'slot2', 'a running holder keeps slot1: the next worker gets a new slot');

  assert.equal(releaseSlot(a), 'slot1');
  const c = deps(root, 'cccc3333', { live: ['bbbb2222', 'cccc3333'] });
  assert.equal(takeSlot(c, { remote }), 'slot1', 'the released slot, used last, before a new one');
  assert.ok(fs.existsSync(path.join(slotTarget(root, 'slot1'), 'debug', 'warm.rlib')), 'its cargo target stays warm');
  assert.ok(!fs.existsSync(path.join(slotCheckout(root, 'slot1'), 'feat.rs')), 'no branch asked: detached at origin/main');
  assert.equal(readSlotState(root).slots.find((s) => s.id === 'slot1')?.holder, 'cccc3333');
});

test("w3764: a stopped holder's slot frees itself only when its work is pushed; all slots held answers exit 3", (t) => {
  const { root, remote } = world(t);
  const a = deps(root, 'aaaa1111');
  takeSlot(a, { branch: 'feat', remote });
  fs.writeFileSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs'), '// not committed\n');
  const b = deps(root, 'bbbb2222', { live: ['bbbb2222'], max: 1 });
  assert.equal(ffuSlotMain(['take', '--branch', 'feat'], { ...b, git: b.git }), 3, 'the only slot holds a stopped worker\'s uncommitted work');
  assert.match(b.said.join(''), /uncommitted change/);
  assert.ok(fs.existsSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs')), 'its work is untouched');

  fs.rmSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs'));
  // A fresh facts file is required to call a holder stopped: without one, every other holder counts as running.
  const stale = deps(root, 'bbbb2222', { live: ['bbbb2222'], max: 1, factsAt: NOW - 2 * HOUR });
  assert.throws(() => takeSlot(stale, { remote }), /all 1 ffu slots are held/);
  assert.equal(takeSlot(b, { remote }), 'slot1', 'stopped holder, nothing unpushed: the slot is free');
});

test('w3764: no new slot below the free-disk floor, and take prints the lines eval runs', (t) => {
  const { root, remote } = world(t);
  const low = deps(root, 'aaaa1111', { freeGB: 10 });
  assert.throws(() => takeSlot(low, { remote }), /not made with 10 GB free/);
  const ok = deps(root, 'aaaa1111');
  // ffuSlotMain takes the default remote: point the shared clone at the local one first.
  takeSlot(ok, { remote });
  assert.equal(ffuSlotMain(['take'], ok), 0);
  const lines = ok.out.join('');
  assert.match(lines, /^export FFU_SLOT='slot1'$/m);
  assert.match(lines, /^export CARGO_TARGET_DIR='.*ffu-sandboxes\/slot1\/target'$/m);
  assert.match(lines, /^cd '.*ffu-sandboxes\/slot1\/ffu'$/m);
});

// ---- the clean-up rule

const TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n';

function target(root: string, slot: string, ageH: number, incBytes = 10, depsBytes = 10) {
  const t = path.join(root, 'ffu-sandboxes', slot, 'target');
  const put = (rel: string, n: number) => {
    const f = path.join(t, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.alloc(n));
  };
  put('CACHEDIR.TAG', 0);
  fs.writeFileSync(path.join(t, 'CACHEDIR.TAG'), TAG);
  put('debug/incremental/a/b.bin', incBytes);
  put('debug/deps/x.rlib', depsBytes);
  fs.mkdirSync(path.join(root, 'ffu-sandboxes', slot, 'ffu'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', slot, 'ffu', 'Cargo.toml'), '');
  const at = (NOW - ageH * HOUR) / 1000;
  const walk = (p: string) => {
    if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    fs.utimesSync(p, at, at);
  };
  walk(path.join(root, 'ffu-sandboxes', slot));
  return t;
}

async function plan(root: string, o: { low?: boolean; procs?: ProcLite[]; inUse?: string[]; settings?: Record<string, unknown> } = {}) {
  const guard: CleanupGuard = { keep: [path.join(root, 'sandboxes')], inUse: o.inUse ?? [], home: path.join(root, 'home') };
  return planInstallLeftovers({
    root,
    sandboxes: [],
    tempRoots: [path.join(root, 'tmp')],
    guard,
    procs: o.procs ?? [],
    settings: installLeftoverSettings(o.settings ?? {}),
    now: NOW,
    localWork: async () => false,
    low: o.low,
    heldMinBytes: 0,
    alive: () => true,
    runnerLog: () => undefined,
  });
}

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');
const ffuItems = (root: string, p: { items: { path: string; rule: string }[] }) => p.items.filter((i) => i.rule === 'ffu-slot-target').map((i) => rel(root, i.path)).sort();

test("w3764: a slot's warm target stays on a normal pass; one idle a week with no live holder goes whole; the checkout never", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w3764c-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  target(root, 'slot1', 2);
  target(root, 'slot2', 8 * 24);
  target(root, 'slot3', 8 * 24);
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot3', holder: 'live0001' }] }));
  const p = await plan(root, { inUse: [path.join(root, 'tmp', 'ffa-live0001')] });
  assert.deepEqual(ffuItems(root, p), ['ffu-sandboxes/slot2/target'], 'slot1 is recent and slot3 held by a running worker: both stay warm');
  assert.ok(!p.items.some((i) => /slot\d\/ffu$/.test(rel(root, i.path))), 'a checkout is never an item');
});

test('w3764: a target over the slot cap loses its incremental cache first, then the whole target; a busy one stays', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w3764c-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  // cap 3000 bytes: slot1 (2000 inc + 2000 deps) fits once its incremental goes; slot2 (2000 inc + 5000 deps) does not.
  const capGB = 3000 / 1024 ** 3;
  target(root, 'slot1', 1, 2000, 2000);
  target(root, 'slot2', 1, 2000, 5000);
  const t3 = target(root, 'slot3', 1, 2000, 5000);
  const procs: ProcLite[] = [{ pid: 42, ppid: 1, cmd: `rustc --out-dir ${t3}/debug/deps` } as ProcLite];
  const p = await plan(root, { procs, settings: { ffuSlotTargetCapGB: capGB } });
  assert.deepEqual(ffuItems(root, p), ['ffu-sandboxes/slot1/target/debug/incremental', 'ffu-sandboxes/slot2/target']);
});

test('w3764: a low pass takes an unheld slot whole and only the incremental cache of a held one', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w3764c-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  target(root, 'slot1', 1);
  target(root, 'slot2', 1);
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot2', holder: 'live0002' }] }));
  const p = await plan(root, { low: true, inUse: [path.join(root, 'tmp', 'ffa-live0002')] });
  assert.deepEqual(ffuItems(root, p), ['ffu-sandboxes/slot1/target', 'ffu-sandboxes/slot2/target/debug/incremental']);
});

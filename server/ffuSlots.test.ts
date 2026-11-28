import './testLocalRemotes.ts'; // w6099: these checkouts' origins are bare repositories in a temp folder
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { FFU_SERVER_GROUP, FFU_SLOTS_DEFAULT_MAX, ffuServerExes, ffuSlotMain, readSlotState, slotCargoHome, realFfuSlotDeps, slotBin, slotGitEnv, slotCheckout, slotTarget, takeSlot, releaseSlot, sweepSlots, slotsReport, runFfuSlotSweep, FFU_SLOT_WAIT_GRACE_MS, FFU_SLOT_IDLE_MS, FFU_SLOTS_PER_WORKER, RESCUE_GIT_IDENTITY, RESCUE_RETRY_MS, rescueIdentity, type FfuSlotDeps } from '../machine/ffuSlots.ts';
import type { CleanupGuard } from './cleanup.ts';
import { installLeftoverSettings, planInstallLeftovers, type ProcLite } from './installLeftovers.ts';
import { writeCargoUnit, type FakeUnit } from './cargoGraphFixture.ts';
import type { ProcPlace } from './procPlaces.ts';
import { busySlotsOf } from '../machine/ffuBusyRetry.ts';
import { FfuSlotAutoSweep } from '../machine/ffuSlotAutoSweep.ts';

/**
 * w3764: ffu slots, per-machine ffu worktrees with warm cargo targets (machine/ffuSlots.ts), and the clean-up rule for their
 * targets (server/installLeftovers.ts, ffu-slot-target). The leases run real git against a local "origin".
 */

// w5991: no automatic gc or maintenance in the fixture repositories: every fetch and commit started a detached
// `git maintenance run --auto` (61 git processes in this file), which only made the run slower on a busy machine.
{
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
  [['maintenance.auto', 'false'], ['gc.auto', '0']].forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${n + i}`] = k;
    process.env[`GIT_CONFIG_VALUE_${n + i}`] = v;
  });
  process.env.GIT_CONFIG_COUNT = String(n + 2);
}

const NOW = Date.now();
const HOUR = 3_600_000;

/** The tests' own git is no worker's: no FF_SESSION_ID, so the slot hooks (w6038) check nothing. */
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'FF_SESSION_ID'));

function git(args: string[], cwd?: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
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
  // w4258: a cargo run in the checkout without CARGO_TARGET_DIR still builds in the slot's target.
  const cfg = fs.readFileSync(path.join(root, 'ffu-sandboxes', 'slot1', '.cargo', 'config.toml'), 'utf8');
  assert.match(cfg, /^\[build\]$/m);
  assert.match(cfg, /^incremental = false$/m, 'w5499: a slot builds with incremental off, as ffu CI does');
  assert.ok(cfg.includes(`target-dir = ${JSON.stringify(slotTarget(root, id).split(path.sep).join('/'))}`), cfg);
  fs.mkdirSync(path.join(slotTarget(root, id), 'debug'), { recursive: true });
  fs.writeFileSync(path.join(slotTarget(root, id), 'debug', 'warm.rlib'), 'x');

  const b = deps(root, 'bbbb2222', { live: ['aaaa1111', 'bbbb2222'] });
  assert.equal(takeSlot(b, { branch: 'feat', remote }), 'slot2', 'a running holder keeps slot1: the next worker gets a new slot');

  assert.deepEqual(releaseSlot(a), ['slot1']);
  const c = deps(root, 'cccc3333', { live: ['bbbb2222', 'cccc3333'] });
  assert.equal(takeSlot(c, { remote }), 'slot1', 'the released slot, used last, before a new one');
  assert.ok(fs.existsSync(path.join(slotTarget(root, 'slot1'), 'debug', 'warm.rlib')), 'its cargo target stays warm');
  assert.ok(!fs.existsSync(path.join(slotCheckout(root, 'slot1'), 'feat.rs')), 'no branch asked: detached at origin/main');
  assert.equal(readSlotState(root).slots.find((s) => s.id === 'slot1')?.holder, 'cccc3333');
});

test("w3764: a stopped holder's slot frees itself when its work is pushed, and with work stays its own through a short wait; all slots held answers exit 4 (w5885)", (t) => {
  const { root, remote } = world(t);
  const a = deps(root, 'aaaa1111');
  takeSlot(a, { branch: 'feat', remote });
  fs.writeFileSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs'), '// not committed\n');
  const b = deps(root, 'bbbb2222', { live: ['bbbb2222'], max: 1 });
  assert.equal(ffuSlotMain(['take', '--branch', 'feat'], { ...b, git: b.git }), 4, 'the only slot holds a stopped worker\'s uncommitted work');
  assert.match(b.said.join(''), /uncommitted change/);
  assert.ok(fs.existsSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs')), 'its work is untouched');

  fs.rmSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs'));
  // A fresh facts file is required to call a holder stopped: without one, every other holder counts as running.
  const stale = deps(root, 'bbbb2222', { live: ['bbbb2222'], max: 1, factsAt: NOW - 2 * HOUR });
  assert.throws(() => takeSlot(stale, { remote }), /all 1 ffu slots are held/);
  assert.equal(takeSlot(b, { remote }), 'slot1', 'stopped holder, nothing unpushed: the slot is free');
});

test("w5991: ffu-slot's own git runs no hook but on a push, and keeps the caller's config entries", () => {
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' };
  const e = slotGitEnv(['-C', 'x', 'checkout', '--quiet', 'feat'], env);
  assert.equal(e.GIT_CONFIG_COUNT, '2');
  assert.equal(e.GIT_CONFIG_KEY_0, 'a.b');
  assert.equal(e.GIT_CONFIG_KEY_1, 'core.hooksPath');
  assert.ok(fs.statSync(e.GIT_CONFIG_VALUE_1 ?? '').isFile(), 'a regular file: git finds no hook there');
  assert.equal(slotGitEnv(['push', '--quiet', 'origin', 'x'], env), env, "a push keeps git-lfs's pre-push");
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
  assert.match(lines, /^export CARGO_INCREMENTAL=0$/m);
  // w5501: the machine's cargo home inside the root, where a fenced worker can fetch a new crate.
  assert.match(lines, /^export CARGO_HOME='.*\/cache\/cargo'$/m);
  assert.match(lines, /^cd '.*ffu-sandboxes\/slot1\/ffu'$/m);
  // w5947: an agent outside the fences (the daemon set MEDIUM_AGENT_VAR) keeps its own CARGO_HOME, never the workers' one.
  for (const medium of ['warn', 'on'] as const) {
    for (const cmd of ['take', 'where']) {
      const m = Object.assign(deps(root, 'aaaa1111'), { medium });
      ffuSlotMain([cmd], m);
      assert.doesNotMatch(m.out.join(''), /CARGO_HOME/, `${medium} ${cmd}`);
    }
  }
  assert.equal(slotCargoHome({ cargoHome: '/w/cache/cargo', medium: 'warn' }), undefined);
  assert.equal(slotCargoHome({ cargoHome: '/w/cache/cargo' }), '/w/cache/cargo');
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

async function plan(root: string, o: { low?: boolean; procs?: ProcLite[]; places?: ProcPlace[]; inUse?: string[]; settings?: Record<string, unknown>; scope?: 'cargo-cap' | 'ffu-slots' | 'ffu-busy-retry'; slots?: string[] } = {}) {
  const guard: CleanupGuard = { keep: [path.join(root, 'sandboxes')], inUse: o.inUse ?? [], home: path.join(root, 'home') };
  return planInstallLeftovers({
    root,
    sandboxes: [],
    tempRoots: [path.join(root, 'tmp')],
    guard,
    procs: o.procs ?? [],
    places: o.places ?? [],
    settings: installLeftoverSettings(o.settings ?? {}),
    now: NOW,
    localWork: async () => false,
    low: o.low,
    heldMinBytes: 0,
    alive: () => true,
    runnerLog: () => undefined,
    ...(o.scope ? { scope: o.scope } : {}),
    ...(o.slots ? { slots: o.slots } : {}),
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
  // w5499: slots build with incremental off, so an incremental cache no build wrote for the settle time goes, held or not.
  assert.deepEqual(ffuItems(root, p), ['ffu-sandboxes/slot1/target/debug/incremental', 'ffu-sandboxes/slot2/target', 'ffu-sandboxes/slot3/target/debug/incremental'], 'slot1 is recent and slot3 held by a running worker: both stay warm but for their idle incremental cache');
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

/** A slot target with a current build (ffu_sim and its test, an hour old) and one from four days ago that nothing current uses. */
function unitTarget(root: string, slot: string, oldAgeH = 24 * 4) {
  const t = path.join(root, 'ffu-sandboxes', slot, 'target');
  fs.mkdirSync(path.join(root, 'ffu-sandboxes', slot, 'ffu'), { recursive: true });
  const serde: FakeUnit = { name: 'serde', hash: '1111111111111111', fp: 18_000_000_000_000_000_001n, ageH: 24 * 6 };
  const glam: FakeUnit = { name: 'glam', hash: '2222222222222222', fp: 17_000_000_000_000_000_003n, ageH: oldAgeH, bytes: 4000 };
  const simNow: FakeUnit = { name: 'ffu_sim', hash: '3333333333333333', fp: 16_000_000_000_000_000_005n, deps: [serde], workspace: true, ageH: 1 };
  const simOld: FakeUnit = { name: 'ffu_sim', hash: '4444444444444444', fp: 15_000_000_000_000_000_007n, deps: [glam, serde], workspace: true, ageH: oldAgeH, bytes: 4000 };
  const testNow: FakeUnit = { name: 'golden', hash: '5555555555555555', fp: 14_000_000_000_000_000_009n, deps: [simNow], workspace: true, ageH: 1 };
  for (const u of [serde, glam, simNow, simOld, testNow]) writeCargoUnit(t, u, NOW);
  for (const d of [path.join(t, 'CACHEDIR.TAG'), t, path.join(t, 'debug'), ...['deps', '.fingerprint'].map((x) => path.join(t, 'debug', x))]) fs.utimesSync(d, (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);
  return t;
}

test('w4258, w6240: a test binary running from a slot target keeps it whole now: no sweep, no trim, held or released', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4258c-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const tg = unitTarget(root, 'slot1');
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot1', holder: 'live0004' }] }));
  const checkout = path.join(root, 'ffu-sandboxes', 'slot1', 'ffu');
  const inUse = [path.join(root, 'tmp', 'ffa-live0004')];
  // LothDesktop, 2026-11-15: `cargo test` in the checkout, past its build, running a long test binary from deps/. w4258 swept
  // beside it; w6240 (biscuit slot4 lost 62 of 257 test binaries under a running test run) keeps the whole target.
  const procs: ProcLite[] = [
    { pid: 10, ppid: 1, cmd: `bash -c "cd ${checkout} && cargo test -p ffu-sim"` },
    { pid: 11, ppid: 10, cmd: 'cargo test -p ffu-sim' },
    { pid: 12, ppid: 11, cmd: `${tg}/debug/deps/golden-5555555555555555 --nocapture` },
  ];
  const p = await plan(root, { procs, inUse });
  assert.deepEqual(ffuItems(root, p), [], 'nothing goes while a test binary runs from it');
  // Low and over the cap: still nothing, and the kept target says why.
  const low = await plan(root, { procs, inUse, low: true, settings: { ffuSlotTargetCapGB: 1000 / 1024 ** 3 } });
  assert.deepEqual(ffuItems(root, low), []);
  const kept = (low as { held?: { path: string; why: string }[] }).held?.find((h) => rel(root, h.path) === 'ffu-sandboxes/slot1/target');
  assert.match(kept?.why ?? '', /a running process names it \(pid 1[02]/);
  // Released (no live holder) with the binary still running: kept too.
  const released = await plan(root, { procs: [procs[2]], low: true });
  assert.deepEqual(ffuItems(root, released), []);
  // Once nothing runs from it, the sweep takes the old sim and the dependency only it used, as before.
  const idle = await plan(root, { inUse });
  const it = idle.items.find((i) => i.rule === 'ffu-slot-target');
  assert.ok(it?.members, JSON.stringify(idle.items.map((i) => i.rule)));
  assert.deepEqual([...new Set(it.members.map((m) => /-([0-9a-f]{16})/.exec(path.basename(m))![1]))].sort(), ['2222222222222222', '4444444444444444']);
});

/**
 * w6240, the biscuit case (2026-11-27T00:23:32Z, ffu slot4): `cargo test --workspace --all-features --locked --no-run`, then
 * `python3 tools/run_tests_parallel.py` in the checkout over the built test binaries. Cargo rewrote only the units that changed
 * (here ffu_sim, 20 min ago, past the settle time); the alarms test binary was current but three hours old, and a pass over
 * the cap narrowed the window to 15 min, which took it.
 */
function biscuitTarget(root: string) {
  const tg = unitTarget(root, 'slot4');
  const sim: FakeUnit = { name: 'ffu_sim', hash: '7777777777777777', fp: 12_000_000_000_000_000_013n, workspace: true, ageH: 0.33 };
  const alarms: FakeUnit = { name: 'alarms', hash: 'bdd02d47710ae4cf', fp: 11_000_000_000_000_000_015n, deps: [sim], workspace: true, ageH: 3 };
  const alarmsOld: FakeUnit = { name: 'alarms', hash: 'a0a0a0a0a0a0a0a0', fp: 10_000_000_000_000_000_017n, workspace: true, ageH: 24 * 4 };
  for (const u of [sim, alarms, alarmsOld]) writeCargoUnit(tg, u, NOW);
  // the test binary cargo links: `<name>-<hash>` with its exec bit, `.exe` on Windows (where Node shows no exec bit; w6475)
  const exe = (name: string, ageH: number) => {
    const f = path.join(tg, 'debug', 'deps', process.platform === 'win32' ? `${name}.exe` : name);
    fs.writeFileSync(f, Buffer.alloc(500));
    fs.chmodSync(f, 0o755);
    fs.utimesSync(f, (NOW - ageH * HOUR) / 1000, (NOW - ageH * HOUR) / 1000);
    return f;
  };
  const fresh = exe('alarms-bdd02d47710ae4cf', 3);
  const old = exe('alarms-a0a0a0a0a0a0a0a0', 24 * 4);
  for (const d of [tg, path.join(tg, 'debug'), ...['deps', '.fingerprint'].map((x) => path.join(tg, 'debug', x))]) fs.utimesSync(d, (NOW - 0.33 * HOUR) / 1000, (NOW - 0.33 * HOUR) / 1000);
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot4', holder: '5d11b00b' }] }));
  return { tg, fresh, old, checkout: path.join(root, 'ffu-sandboxes', 'slot4', 'ffu'), inUse: [path.join(root, 'tmp', 'ffa-5d11b00b')] };
}

test("w6240: the latest build's test binaries stay at the 15 min window however old; an older one of the same name goes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6240a-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const { fresh, old, inUse } = biscuitTarget(root);
  // A low pass narrows the window to 15 min (installLeftovers.ts, the windows loop), as the cap did on biscuit.
  const p = await plan(root, { low: true, inUse });
  const it = p.items.find((i) => i.rule === 'ffu-slot-target' && i.members);
  assert.ok(it?.members, JSON.stringify(p.items.map((i) => [i.rule, i.why])));
  assert.match(it.why, /no workspace build of the last 15 min uses/);
  const members = it.members.map((m) => path.basename(m));
  assert.ok(!members.includes(path.basename(fresh)), `the current test binary stays: ${members.join(', ')}`);
  assert.ok(!members.some((m) => m.includes('bdd02d47710ae4cf')), 'and its fingerprint and files with it');
  assert.ok(!members.some((m) => m.includes('7777777777777777')), 'and the unit it was built from');
  assert.ok(members.includes(path.basename(old)), 'the four-day-old binary of the same name still goes');
});

test('w6240: a test run whose only trace is its working folder in the checkout, or its children running from the target, keeps the slot whole; unreadable processes keep it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6240b-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const { tg, checkout, inUse } = biscuitTarget(root);
  // The runner as biscuit had it: a relative script path, no target or checkout in its argv.
  const runner: ProcLite = { pid: 900, ppid: 1, cmd: 'python3 tools/run_tests_parallel.py' };
  const child: ProcLite = { pid: 901, ppid: 900, cmd: 'redteam_race-b158fae8531a6a53 --test-threads 1' };
  const settings = { ffuSlotTargetCapGB: 1000 / 1024 ** 3 };
  const before = await plan(root, { low: true, inUse, settings, procs: [runner], places: [{ pid: 900, exe: '/usr/bin/python3' }] });
  assert.ok(ffuItems(root, before).length, 'without the working folder nothing names the run: the sweep goes ahead (the bug)');
  const byCwd = await plan(root, { low: true, inUse, settings, procs: [runner], places: [{ pid: 900, exe: '/usr/bin/python3', cwd: checkout }] });
  assert.deepEqual(ffuItems(root, byCwd), [], 'its working folder in the checkout keeps the target whole');
  assert.match((byCwd as { held?: { why: string }[] }).held?.[0]?.why ?? '', /a process works in it \(pid 900, working folder .*python3 tools\/run_tests_parallel\.py/);
  const byExe = await plan(root, { low: true, inUse, settings, procs: [runner, child], places: [{ pid: 901, exe: path.join(tg, 'debug', 'deps', 'redteam_race-b158fae8531a6a53') }] });
  assert.deepEqual(ffuItems(root, byExe), [], "a child's executable in the target keeps it");
  const unread = await planInstallLeftovers({
    root,
    sandboxes: [],
    tempRoots: [path.join(root, 'tmp')],
    guard: { keep: [path.join(root, 'sandboxes')], inUse, home: path.join(root, 'home') },
    procs: [runner],
    places: async () => undefined,
    settings: installLeftoverSettings(settings),
    now: NOW,
    localWork: async () => false,
    low: true,
    heldMinBytes: 0,
    alive: () => true,
    runnerLog: () => undefined,
  });
  assert.deepEqual(ffuItems(root, unread), [], 'places that cannot be read keep it');
  assert.match(unread.held?.find((h) => /slot4/.test(h.path))?.why ?? '', /could not be read, so a program running from it cannot be ruled out/);

  // The re-check before the removal sees a run that started after the plan, for a sweep item too (not only a first-step one).
  const { ffuSlotBusyNow } = await import('./installLeftovers.ts');
  const sweep = { path: tg, rule: 'ffu-slot-target', why: 'stale build output', members: [path.join(tg, 'debug', 'deps', 'x')] };
  const guard = () => ({ keep: [], inUse, home: path.join(root, 'home') });
  assert.equal(await ffuSlotBusyNow(root, async () => [], guard, () => NOW, async () => [])(sweep), undefined, 'nothing runs: it goes');
  assert.match((await ffuSlotBusyNow(root, async () => [runner], guard, () => NOW, async () => [{ pid: 900, cwd: checkout }])(sweep)) ?? '', /^since the plan: a process works in it/);
  assert.match((await ffuSlotBusyNow(root, async () => [runner], guard, () => NOW, async () => undefined)(sweep)) ?? '', /could not be read/);
});

test("w4258: a slot holder's private cargo target in its temp folder goes once cargo is done with it; another worker's small one stays", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4258p-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const priv = (session: string) => {
    const tg = path.join(root, 'tmp', `ffa-${session}`, 'ffu-target');
    fs.mkdirSync(path.join(tg, 'debug', 'deps'), { recursive: true });
    fs.writeFileSync(path.join(tg, 'CACHEDIR.TAG'), TAG);
    fs.writeFileSync(path.join(tg, 'debug', 'deps', 'libx-1111111111111111.rlib'), Buffer.alloc(1000));
    const at = (NOW - 2 * HOUR) / 1000;
    for (const p of [path.join(tg, 'debug', 'deps', 'libx-1111111111111111.rlib'), path.join(tg, 'debug', 'deps'), path.join(tg, 'debug'), path.join(tg, 'CACHEDIR.TAG'), tg]) fs.utimesSync(p, at, at);
    return tg;
  };
  const held = priv('live0005');
  priv('live0006');
  fs.mkdirSync(path.join(root, 'ffu-sandboxes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot1', holder: 'live0005' }] }));
  const p = await plan(root, { inUse: [path.join(root, 'tmp', 'ffa-live0005'), path.join(root, 'tmp', 'ffa-live0006')] });
  const cargo = p.items.filter((i) => i.rule === 'cargo-target-cap').map((i) => i.path);
  assert.deepEqual(cargo, [held]);
});

test('w4258: a slot written minutes ago with no build running still loses its stale units; trims wait; a kept one says why', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4258r-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const tg = unitTarget(root, 'slot1');
  // LothDesktop, 2026-11-15 03:29: four slots in steady use (71 GB), each written within 15 min, and the pass freed nothing.
  const fresh = (NOW - 5 * 60_000) / 1000;
  fs.utimesSync(path.join(tg, 'debug'), fresh, fresh);
  const p = await plan(root, { settings: { ffuSlotTargetCapGB: 1000 / 1024 ** 3 } });
  const it = p.items.find((i) => i.rule === 'ffu-slot-target');
  assert.ok(it?.members, `the stale units go though the target was written 5 min ago: ${JSON.stringify(p.items.map((i) => rel(root, i.path)))}`);
  const gone = [...new Set(it.members.map((m) => /-([0-9a-f]{16})/.exec(path.basename(m))![1]))].sort();
  assert.deepEqual(gone, ['2222222222222222', '4444444444444444']);
  assert.deepEqual(ffuItems(root, p), ['ffu-sandboxes/slot1/target'], 'no incremental trim and no whole removal within the settle time');

  // A build running in it: nothing goes, and an hourly pass says so once it is over the cap.
  const procs: ProcLite[] = [{ pid: 42, ppid: 1, cmd: `rustc --out-dir ${tg}/debug/deps` } as ProcLite];
  const b = await plan(root, { procs, settings: { ffuSlotTargetCapGB: 1000 / 1024 ** 3 } });
  assert.deepEqual(ffuItems(root, b), []);
  const held = (b as { held?: { path: string; why: string }[] }).held ?? [];
  assert.ok(held.some((h) => rel(root, h.path) === 'ffu-sandboxes/slot1/target' && /a running process uses it/.test(h.why)), JSON.stringify(held));
});

test('w5442: ffu-server has a firewall path in every slot an ffu machine can make, and firewall.ps1 rules it Tailscale-only', () => {
  const exes = ffuServerExes(String.raw`F:\ffw`);
  assert.equal(exes.length, 3 * FFU_SLOTS_DEFAULT_MAX, 'debug, release and bin for each of the default slots');
  assert.deepEqual(exes.slice(0, 3), [String.raw`F:\ffw\ffu-sandboxes\slot1\target\debug\ffu-server.exe`, String.raw`F:\ffw\ffu-sandboxes\slot1\target\release\ffu-server.exe`, String.raw`F:\ffw\ffu-sandboxes\slot1\bin\ffu-server.exe`]);
  assert.ok(exes.includes(String.raw`F:\ffw\ffu-sandboxes\slot` + FFU_SLOTS_DEFAULT_MAX + String.raw`\bin\ffu-server.exe`));
  assert.equal(path.basename(slotBin('/ffw', 'slot2')), 'bin');
  const ps = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'worker', 'firewall.ps1'), 'utf8');
  assert.match(ps, /\[string\]\$FfuServer = ''/, 'firewall.ps1 takes -FfuServer');
  assert.match(ps, new RegExp(String.raw`\$FfuGroup = '` + FFU_SERVER_GROUP + `'`), 'the group name matches machine/ffuSlots.ts');
  assert.match(ps, /Get-NetFirewallRule -Group \$FfuGroup/, 'a re-run and -Remove delete the group first');
  assert.match(ps, /\$Tailnet = @\('100\.64\.0\.0\/10', 'fd7a:115c:a1e0::\/48'\)/, 'the tailnet only, never the internet');
  assert.match(ps, /-Program \$exe -Protocol \$Protocol `\s*-RemoteAddress \$\(if \(\$AnyAddress\) \{ 'Any' \} else \{ \$script:Tailnet \}\)/, 'inbound by program, from the tailnet');
  assert.doesNotMatch(ps, /-FfuServer[^\n]*-AnyAddress|Final Factory ffu-server[^\n]*-AnyAddress/, 'ffu-server is always tailnet only (only the agent node takes -AnyAddress, w5581)');
  assert.match(ps, /\[string\]\$Protocol = 'TCP'/, 'TCP unless a caller says otherwise (ffu-server says nothing: TCP; w5581)');
  const worker = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'worker', 'worker.ts'), 'utf8');
  assert.match(worker, /'-FfuServer', ffuServerExes\(l\.root\)\.join\(';'\)/, 'the install and firewallRepair pass the paths');
  assert.match(worker, /\.\.\.\(fs\.existsSync\(node\) \? \[node\] : \[\]\), \.\.\.ffu\]/, 'firewallRepair checks them on every tools rollout');
});

test('w5499: an incremental cache a build wrote within the settle time stays; an idle one of a held slot goes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w5499i-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  target(root, 'slot1', 2);
  const fresh = (NOW - 5 * 60_000) / 1000;
  fs.utimesSync(path.join(target(root, 'slot2', 2), 'debug', 'incremental'), fresh, fresh);
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot1', holder: 'live0001' }, { id: 'slot2', holder: 'live0001' }] }));
  const p = await plan(root, { inUse: [path.join(root, 'tmp', 'ffa-live0001')] });
  assert.deepEqual(ffuItems(root, p), ['ffu-sandboxes/slot1/target/debug/incremental'], "slot2's incremental cache was written 5 min ago (a worker's CARGO_INCREMENTAL=1 loop): kept");
  assert.match(p.items.find((i) => i.rule === 'ffu-slot-target')!.why, /incremental off, as ffu CI does \(w5499\)/);
});

/** unitTarget plus an idle incremental cache of the live sim (two hours untouched), `incBytes` big. */
function unitTargetWithIncremental(root: string, slot: string, incBytes: number) {
  const t = unitTarget(root, slot, 4);
  const s = path.join(t, 'debug', 'incremental', 'ffu_sim-3333333333333333', 's-abc');
  fs.mkdirSync(s, { recursive: true });
  fs.writeFileSync(path.join(s, 'dep-graph.bin'), Buffer.alloc(incBytes));
  const old = (NOW - 2 * HOUR) / 1000;
  for (const d of [path.join(s, 'dep-graph.bin'), s, path.dirname(s), path.dirname(path.dirname(s))]) fs.utimesSync(d, old, old);
  for (const d of [t, path.join(t, 'debug')]) fs.utimesSync(d, (NOW - HOUR) / 1000, (NOW - HOUR) / 1000);
  return t;
}

const sweptHashes = (it: { members?: string[] } | undefined) => [...new Set((it?.members ?? []).map((m) => /-([0-9a-f]{16})/.exec(path.basename(m))?.[1]).filter(Boolean))].sort();

test('w5503: a released slot is swept to what its last worker built in its last hour; a held one keeps its 48 h of builds', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w5503r-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  // slot1: released (no holder). slot2: held by a running worker. Both carry the current build (1 h old) and a variant
  // built three hours before it (ffu_sim-4444 and glam, which only it uses): under the cap, inside the 48 h window.
  unitTarget(root, 'slot1', 4);
  unitTarget(root, 'slot2', 4);
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot1' }, { id: 'slot2', holder: 'live0005' }] }));
  const p = await plan(root, { inUse: [path.join(root, 'tmp', 'ffa-live0005')] });
  const items = p.items.filter((i) => i.rule === 'ffu-slot-target');
  assert.deepEqual(items.map((i) => rel(root, i.path)), ['ffu-sandboxes/slot1/target'], 'only the released slot is swept');
  assert.deepEqual(sweptHashes(items[0]), ['2222222222222222', '4444444444444444'], 'the older variant and the dependency only it used go; serde, the live sim and its test stay');
  assert.match(items[0].why, /the last 1 h before its last worker released it/);

  // 0 turns the released window off: the slot keeps the held-slot window, and nothing goes.
  const off = await plan(root, { inUse: [path.join(root, 'tmp', 'ffa-live0005')], settings: { ffuSlotReleasedKeepHours: 0 } });
  assert.deepEqual(ffuItems(root, off), []);
});

test('w5503: an idle incremental cache that took a target over the cap goes alone; the warm units stay', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w5503c-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  // ~9 KB of units (8 KB of them the older variant) plus a 20 KB idle incremental cache, against a 12 KB cap: the target is
  // over the cap only because of the cache the w5499 trim takes on this pass anyway (LothDesktop slot3, 2026-11-25: 19.9 of
  // 32.1 GB incremental, 12.1 GB without it).
  unitTargetWithIncremental(root, 'slot1', 20_000);
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot1', holder: 'live0006' }] }));
  const p = await plan(root, { inUse: [path.join(root, 'tmp', 'ffa-live0006')], settings: { ffuSlotTargetCapGB: 12_000 / 1024 ** 3 } });
  assert.deepEqual(ffuItems(root, p), ['ffu-sandboxes/slot1/target/debug/incremental'], 'the cache goes; no sweep of the units built 3 h before the newest');

  // Over the cap without the cache too (a 5 KB cap): the window narrows, and the older variant goes with the cache. The cache
  // rides in the sweep's members: as an item of its own inside the swept target the plan dropped it (w5503).
  const tight = await plan(root, { inUse: [path.join(root, 'tmp', 'ffa-live0006')], settings: { ffuSlotTargetCapGB: 5_000 / 1024 ** 3 } });
  assert.deepEqual(ffuItems(root, tight), ['ffu-sandboxes/slot1/target']);
  const sweep = tight.items.find((i) => i.rule === 'ffu-slot-target')!;
  assert.deepEqual(sweptHashes(sweep), ['2222222222222222', '4444444444444444'], 'the older variant and glam; the live sim stays');
  assert.ok(sweep.members!.some((m) => rel(root, m) === 'ffu-sandboxes/slot1/target/debug/incremental'), JSON.stringify(sweep.members));
  assert.ok(!sweep.members!.some((m) => rel(root, m).startsWith('ffu-sandboxes/slot1/target/debug/incremental/')), 'nothing twice');
  assert.match(sweep.why, /stale build output.*; and the incremental cache/);
});

test('w5503: the hourly pass (scope cargo-cap) caps the ffu slots too, not only the daily or low one', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w5503h-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  // LothDesktop, 2026-11-25 05:34 UTC: the first hourly pass after #1148 deployed never looked at slot2-4 (25-35 GB each,
  // 11-21 GB of it idle incremental): the rule ran only in the full plan, which the daemon builds daily or on a low pass.
  unitTargetWithIncremental(root, 'slot1', 20_000);
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot1', holder: 'live0007' }] }));
  const inUse = [path.join(root, 'tmp', 'ffa-live0007')];
  const hourly = await plan(root, { inUse, scope: 'cargo-cap', settings: { ffuSlotTargetCapGB: 12_000 / 1024 ** 3 } });
  assert.deepEqual(ffuItems(root, hourly), ['ffu-sandboxes/slot1/target/debug/incremental'], 'the idle cache goes on the hourly pass');
  const tight = await plan(root, { inUse, scope: 'cargo-cap', settings: { ffuSlotTargetCapGB: 5_000 / 1024 ** 3 } });
  assert.deepEqual(ffuItems(root, tight), ['ffu-sandboxes/slot1/target'], 'and the sweep, with the cache in its members');
});

test('w5796: a stray ffu/target in a slot checkout goes once idle past ffuSlotKeepHours (held) or the settle time (released); a busy or recent one stays', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w5796s-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  // LothDesktop, 2026-11-25: ffu/target/compat-base (828-920 MB) in held slots 1-3, untouched for 5-9 days, which no rule took.
  const stray = (slot: string, ageH: number) => {
    target(root, slot, 1);
    const st = path.join(root, 'ffu-sandboxes', slot, 'ffu', 'target');
    fs.mkdirSync(path.join(st, 'compat-base', 'release'), { recursive: true });
    fs.writeFileSync(path.join(st, 'compat-base', 'CACHEDIR.TAG'), TAG);
    fs.writeFileSync(path.join(st, 'compat-base', 'release', 'ffu-headless.exe'), Buffer.alloc(100));
    fs.writeFileSync(path.join(root, 'ffu-sandboxes', slot, 'ffu', '.gitignore'), '/target\n');
    fs.writeFileSync(path.join(root, 'ffu-sandboxes', slot, 'ffu', 'keep.rs'), 'work');
    const at = (NOW - ageH * HOUR) / 1000;
    const walk = (p: string) => {
      if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      fs.utimesSync(p, at, at);
    };
    walk(st);
    return st;
  };
  stray('slot1', 9 * 24); // held, idle 9 days: goes
  stray('slot2', 20); // held, idle 20 h: stays (inside 48 h)
  stray('slot3', 1); // released, idle 1 h: goes (past the settle time)
  const s4 = stray('slot4', 9 * 24); // held, idle, but a build runs in it: stays
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: ['slot1', 'slot2', 'slot4'].map((id, i) => ({ id, holder: `live000${i}` })) }));
  const inUse = [0, 1, 2].map((i) => path.join(root, 'tmp', `ffa-live000${i}`));
  const procs: ProcLite[] = [{ pid: 42, ppid: 1, cmd: `cargo build --release --target-dir ${s4}/compat-base` } as ProcLite];
  const p = await plan(root, { inUse, procs });
  const strays = ffuItems(root, p).filter((x) => x.includes('/ffu/'));
  assert.deepEqual(strays, ['ffu-sandboxes/slot1/ffu/target', 'ffu-sandboxes/slot3/ffu/target']);
  assert.ok(!p.items.some((i) => /slot\d\/ffu$/.test(rel(root, i.path))), 'the checkout itself is never an item');
});

// ---- w5885: stale holders give their slot up, their work saved first; a worker with no slot waits

type Owners = NonNullable<NonNullable<FfuSlotDeps['facts']>['owners']>;

/** Worker `session` at `at` ms, with the portal's owners (absent: the portal never said). */
function at(root: string, session: string, when: number, o: { live?: string[]; owners?: Owners; max?: number } = {}) {
  const d = deps(root, session, { live: o.live, max: o.max ?? 1, factsAt: when });
  d.now = () => when;
  if (o.owners) Object.assign(d.facts!, { owners: o.owners });
  return d;
}
const own = (status: string): Owners[string] => ({ requests: [{ id: 'w1', status, with: true }] });
/** Date a slot's git files and target to NOW, as if nothing touched it since the take (the git steps above take real minutes). */
function settle(root: string, id: string) {
  const wt = slotCheckout(root, id);
  const gd = path.resolve(wt, fs.readFileSync(path.join(wt, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim());
  const t = NOW / 1000;
  for (const f of ['index', 'HEAD', path.join('logs', 'HEAD')]) if (fs.existsSync(path.join(gd, f))) fs.utimesSync(path.join(gd, f), t, t);
  for (const prof of ['debug', 'release', 'bench']) for (const sub of ['', '.fingerprint', 'deps']) if (fs.existsSync(path.join(slotTarget(root, id), prof, sub))) fs.utimesSync(path.join(slotTarget(root, id), prof, sub), t, t);
}

test('w5885: a finished holder loses its slot at once; its uncommitted work is committed onto a pushed rescue branch and it is told', (t) => {
  const { root, remote } = world(t);
  takeSlot(at(root, 'aaaa1111', NOW), { branch: 'feat', remote });
  fs.writeFileSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs'), '// not committed\n');
  const b = at(root, 'bbbb2222', NOW + 60_000, { live: ['aaaa1111', 'bbbb2222'], owners: { bbbb2222: own('active') } });
  assert.equal(takeSlot(b, { branch: 'feat', remote }), 'slot1', 'aaaa1111 is on no open request: finished, even while its process still runs');
  assert.ok(!fs.existsSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs')), 'the checkout is reset for the new holder');
  const r = readSlotState(root).rescues?.[0];
  assert.ok(r && r.holder === 'aaaa1111' && r.pushed && r.from === 'feat', JSON.stringify(r));
  assert.match(r.branch, /^rescue\/ffu-slot\/slot1-aaaa1111-[0-9a-f]{8}$/);
  assert.equal(git(['show', `${r.branch}:wip.rs`], remote), '// not committed', 'the work is on origin');
  assert.match(b.said.join(''), /saved aaaa1111's work in slot1 .* pushed to origin/);
  const a = at(root, 'aaaa1111', NOW + 120_000, { live: ['aaaa1111', 'bbbb2222'], owners: { aaaa1111: own('active'), bbbb2222: own('active') }, max: 2 });
  assert.equal(takeSlot(a, { branch: 'feat', remote }), 'slot2');
  assert.match(a.said.join(''), /your slot slot1 went to another worker .* on branch rescue\/ffu-slot\/slot1-aaaa1111-/);
  assert.equal(readSlotState(root).rescues?.[0].told, true, 'told once');
});

test('w5885: a waiting holder keeps its slot for the short-wait grace, then gives it up with its unpushed commit saved', (t) => {
  const { root, remote } = world(t);
  takeSlot(at(root, 'aaaa1111', NOW), { branch: 'feat', remote });
  const wt = slotCheckout(root, 'slot1');
  fs.writeFileSync(path.join(wt, 'more.rs'), '// committed, never pushed\n');
  git(['add', '.'], wt);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'local only'], wt);
  const sha = git(['rev-parse', 'HEAD'], wt);
  settle(root, 'slot1');
  const owners = { aaaa1111: own('blocked'), bbbb2222: own('active') };
  const early = at(root, 'bbbb2222', NOW + FFU_SLOT_WAIT_GRACE_MS - 60_000, { live: ['aaaa1111', 'bbbb2222'], owners });
  assert.equal(ffuSlotMain(['take'], early), 4, 'inside the grace a waiting holder keeps it');
  const said = early.said.join('');
  assert.match(said, /which waits, used 29 min ago/);
  assert.match(said, /Do not build ffu anywhere else/, 'the refusal says to wait');
  assert.doesNotMatch(said, /Build in your temp folder|ffu-target/, 'and no longer says to build in the temp folder');
  const late = at(root, 'bbbb2222', NOW + FFU_SLOT_WAIT_GRACE_MS + 60_000, { live: ['aaaa1111', 'bbbb2222'], owners });
  assert.equal(takeSlot(late, { remote }), 'slot1');
  const r = readSlotState(root).rescues?.[0];
  assert.equal(r?.sha, sha, 'the unpushed commit itself is the rescue tip');
  assert.equal(git(['rev-parse', `refs/heads/${r?.branch}`], remote), sha);
});

test('w5885: a holder still working keeps an unused slot up to the idle limit; a stopped one with no facts of the portal waits the grace', (t) => {
  const { root, remote } = world(t);
  takeSlot(at(root, 'aaaa1111', NOW), { remote });
  settle(root, 'slot1');
  const owners = { aaaa1111: own('active'), bbbb2222: own('active') };
  assert.throws(() => takeSlot(at(root, 'bbbb2222', NOW + FFU_SLOT_IDLE_MS - 60_000, { live: ['aaaa1111', 'bbbb2222'], owners }), { remote }), /which runs, used 119 min ago/);
  assert.equal(takeSlot(at(root, 'bbbb2222', NOW + FFU_SLOT_IDLE_MS + 60_000, { live: ['aaaa1111', 'bbbb2222'], owners }), { remote }), 'slot1', 'unused 2 h: it moved to other work');
  // no owners (the portal not connected): a stopped holder with work keeps it for the grace only
  const c = at(root, 'cccc3333', NOW + FFU_SLOT_IDLE_MS + 2 * 60_000, { live: ['cccc3333'] });
  fs.writeFileSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs'), 'x');
  settle(root, 'slot1');
  assert.throws(() => takeSlot(c, { remote }), /stopped and used 1 min ago .* uncommitted change/);
  assert.deepEqual(sweepSlots(at(root, 'cccc3333', NOW + FFU_SLOT_IDLE_MS + FFU_SLOT_WAIT_GRACE_MS + 3 * 60_000, { live: ['cccc3333'] })), ['slot1'], 'sweep frees it past the grace');
  const st = readSlotState(root);
  assert.equal(st.slots[0].holder, undefined);
  assert.equal(st.rescues?.[0].holder, 'bbbb2222');
});

test('w5885: take --wait waits for a slot to free instead of building elsewhere, and gives up with exit 4 at its limit', (t) => {
  const { root, remote } = world(t);
  const a = at(root, 'aaaa1111', NOW);
  takeSlot(a, { remote });
  let clock = NOW + 60_000;
  const owners = { aaaa1111: own('active'), bbbb2222: own('active') };
  const b = at(root, 'bbbb2222', clock, { live: ['aaaa1111', 'bbbb2222'], owners });
  b.now = () => clock;
  let slept = 0;
  b.sleep = (ms) => {
    clock += ms;
    if (++slept === 3) releaseSlot(a); // the holder pushes and releases while b waits
  };
  assert.equal(ffuSlotMain(['take', '--wait', '9'], b), 0);
  assert.equal(slept, 3, 'it looked again every 30 s until the slot freed');
  assert.match(b.said.join(''), /no slot is free; waiting up to 9 min/);
  assert.match(b.out.join(''), /^export FFU_SLOT='slot1'$/m);

  const c = at(root, 'cccc3333', clock, { live: ['bbbb2222', 'cccc3333'], owners: { bbbb2222: own('active'), cccc3333: own('active') } });
  c.now = () => clock;
  c.sleep = (ms) => void (clock += ms);
  assert.equal(ffuSlotMain(['take', '--wait', '2'], c), 4, 'still held at the limit: exit 4, nothing built anywhere');
  assert.match(c.said.join(''), /wake_me/);
});

test("w5885: one worker, two branches: each checkout gets its own slot and target and both build at once; its own slot never counts as another worker's", async (t) => {
  const { root, remote } = world(t);
  const a = deps(root, 'aaaa1111', { max: 4 });
  assert.equal(takeSlot(a, { branch: 'feat', remote }), 'slot1');
  fs.writeFileSync(path.join(slotCheckout(root, 'slot1'), 'map.rs'), '// the map branch, not committed\n');
  // lothsahn's note (w5475): a second checkout on another branch leases a second slot instead of waiting on the worker's own.
  assert.equal(takeSlot(a, { branch: 'bug-report', remote }), 'slot2', 'a second branch gets a second slot');
  assert.match(a.said.join(''), /took slot2.*beside your slot1|made slot2/s);
  assert.ok(fs.existsSync(path.join(slotCheckout(root, 'slot1'), 'map.rs')), 'the first checkout is untouched');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], slotCheckout(root, 'slot2')), 'bug-report');
  assert.equal(takeSlot(a, { branch: 'feat', remote }), 'slot1', 'each branch keeps its own slot');
  assert.equal(takeSlot(a, { branch: 'bug-report', remote }), 'slot2');
  const cfg = (id: string) => fs.readFileSync(path.join(root, 'ffu-sandboxes', id, '.cargo', 'config.toml'), 'utf8');
  assert.ok(cfg('slot1').includes(JSON.stringify(slotTarget(root, 'slot1').split(path.sep).join('/'))));
  assert.ok(cfg('slot2').includes(JSON.stringify(slotTarget(root, 'slot2').split(path.sep).join('/'))), 'two targets, never one shared');

  // Both build at once: two processes, one per checkout, each writing its target as cargo would, alive together.
  const build = (id: string) =>
    new Promise<number>((res) => {
      const p = spawn(process.execPath, ['-e', `const fs=require('fs');fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+'/started','');const t=Date.now();while(!fs.existsSync(process.argv[2]+'/started')&&Date.now()-t<10000);fs.writeFileSync(process.argv[1]+'/built',process.argv[3]);process.exit(fs.existsSync(process.argv[2]+'/started')?0:1)`, path.join(slotTarget(root, id), 'debug'), path.join(slotTarget(root, id === 'slot1' ? 'slot2' : 'slot1'), 'debug'), id], { cwd: slotCheckout(root, id), stdio: 'ignore' });
      p.on('exit', (c) => res(c ?? 1));
    });
  assert.deepEqual(await Promise.all([build('slot1'), build('slot2')]), [0, 0], 'each saw the other running: in parallel');
  assert.equal(fs.readFileSync(path.join(slotTarget(root, 'slot1'), 'debug', 'built'), 'utf8'), 'slot1');
  assert.equal(fs.readFileSync(path.join(slotTarget(root, 'slot2'), 'debug', 'built'), 'utf8'), 'slot2');

  // where --branch gives each one's lines; plain where the last used.
  const w = deps(root, 'aaaa1111', { max: 4 });
  assert.equal(ffuSlotMain(['where', '--branch', 'feat'], w), 0);
  assert.match(w.out.join(''), /^export FFU_SLOT='slot1'$/m);
  assert.equal(ffuSlotMain(['where', '--branch', 'nope'], w), 1);
  assert.match(w.said.join(''), /none of your slots \(slot2 on bug-report, slot1 on feat\) is on nope/);

  // At the per-worker cap with work in both: a third branch waits (exit 4) and names the worker's own slots as its own.
  fs.writeFileSync(path.join(slotCheckout(root, 'slot2'), 'bug.rs'), '// not committed\n');
  const c = deps(root, 'aaaa1111', { max: 4 });
  assert.equal(FFU_SLOTS_PER_WORKER, 2);
  assert.equal(ffuSlotMain(['take', '--branch', 'third'], c), 4);
  assert.match(c.said.join(''), /you hold 2 ffu slots, the most one worker may \(slot2 on bug-report: .*uncommitted.*slot1 on feat: .*uncommitted/s);
  assert.doesNotMatch(c.said.join(''), /held by aaaa1111/, "its own hold is never listed as another worker's");

  // Another worker holds the rest: the wait names the real holder.
  const b = deps(root, 'bbbb2222', { max: 3, live: ['aaaa1111', 'bbbb2222'] });
  assert.equal(takeSlot(b, { branch: 'feat', remote }), 'slot3');
  fs.rmSync(path.join(slotCheckout(root, 'slot2'), 'bug.rs'));
  fs.rmSync(path.join(slotCheckout(root, 'slot1'), 'map.rs'));
  // Under the cap with no other slot free, a clean slot of its own switches branch, as before.
  const e = deps(root, 'aaaa1111', { max: 3, live: ['aaaa1111', 'bbbb2222'] });
  assert.equal(releaseSlot(e, { slot: 'slot2' })[0], 'slot2');
  fs.writeFileSync(path.join(slotCheckout(root, 'slot1'), 'map.rs'), '// work again\n');
  const f = deps(root, 'bbbb2222', { max: 3, live: ['aaaa1111', 'bbbb2222'] });
  assert.equal(takeSlot(f, { branch: 'bug-report', remote }), 'slot2', 'b leases the slot a released');
  assert.equal(ffuSlotMain(['take', '--branch', 'third'], e), 4);
  assert.match(e.said.join(''), /no other ffu slot is free for third \(slot2: held by bbbb2222.*slot3: held by bbbb2222.*\), and yours have work \(slot1 on feat/s);

  // release with no argument gives back every slot without work, and keeps (and names) the one with work.
  assert.throws(() => releaseSlot(e), /slot1: .*uncommitted.*a slot with work stays yours/);
  assert.deepEqual(releaseSlot(f).sort(), ['slot2', 'slot3']);
});

// w6044: the first step of a pass (scope 'ffu-slots') takes released slots only: BEAST's released slot1, slot3 and slot4
// targets (49.2, 57.7 and 83.6 GB) waited behind slower steps that a restart cut off, while held slot2 must stay warm.
test('w6044: the ffu-slots scope takes a released slot whole on a low pass, at once; a held, running or recent one is left to the later step', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6044-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  target(root, 'slot1', 2, 2000, 5000); // released, settled
  target(root, 'slot2', 2, 2000, 5000); // held by a running worker
  const t3 = target(root, 'slot3', 2); // released, a program runs from it
  target(root, 'slot4', 0); // released, written within the settle time
  target(root, 'slot5', 2); // its holder stopped for good
  target(root, 'slot6', 8 * 24); // released, idle 8 days
  // A stray in-checkout ffu/target in held slot2, idle past ffuSlotKeepHours: the w5796 rule's, never the first step's.
  const stray = path.join(root, 'ffu-sandboxes', 'slot2', 'ffu', 'target');
  fs.mkdirSync(path.join(stray, 'debug'), { recursive: true });
  fs.writeFileSync(path.join(stray, 'CACHEDIR.TAG'), TAG);
  const old = (NOW - 30 * 24 * HOUR) / 1000;
  for (const p of [path.join(stray, 'debug'), path.join(stray, 'CACHEDIR.TAG'), stray]) fs.utimesSync(p, old, old);
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot2', holder: 'live0002' }, { id: 'slot5', holder: 'gone0005' }] }));
  const inUse = [path.join(root, 'tmp', 'ffa-live0002')];
  const procs: ProcLite[] = [{ pid: 43, ppid: 1, cmd: `${t3}/debug/deps/golden-1234 --test-threads 4` } as ProcLite];
  const low = await plan(root, { low: true, inUse, procs, scope: 'ffu-slots' });
  assert.deepEqual(ffuItems(root, low), ['ffu-sandboxes/slot1/target', 'ffu-sandboxes/slot5/target', 'ffu-sandboxes/slot6/target']);
  assert.ok(low.items.every((i) => /taken first in the pass \(w6044\)/.test(i.why)));
  assert.ok(!low.items.some((i) => /slot2/.test(i.path)), 'a held slot is never taken in the first step, not even its incremental cache or a stray ffu/target');
  assert.deepEqual(low.items.map((i) => i.ffuSlot), [{ id: 'slot1', mark: '@@' }, { id: 'slot5', mark: 'gone0005@@' }, { id: 'slot6', mark: '@@' }], 'the slot mark rides the item for the re-check');
  // Any other pass: only a released target idle ffuSlotIdleDays, whole; over the cap or not, its sweep and trims stay with the
  // cap step (review of #1353: the first step planned them twice in one pass), and a held one is not looked at.
  const hourly = await plan(root, { inUse, procs, scope: 'ffu-slots', settings: { ffuSlotTargetCapGB: 3000 / 1024 ** 3 } });
  assert.deepEqual(ffuItems(root, hourly), ['ffu-sandboxes/slot6/target']);
  assert.match(hourly.items[0].why, /nothing in it was written for 7 days; taken first in the pass \(w6044\)/);
});

// w6044 stage 2: the first step removes at once, so the re-check right before the rename sees a slot taken since the plan, or a
// build or a program started in it, and keeps the target.
test('w6044: ffuSlotBusyNow keeps a target whose slot was taken, or that a build or a program started in, since the plan', async (t) => {
  const { ffuSlotBusyNow } = await import('./installLeftovers.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6044b-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const t1 = target(root, 'slot1', 2);
  const state = path.join(root, 'ffu-sandboxes', 'slots.json');
  fs.writeFileSync(state, JSON.stringify({ slots: [{ id: 'slot1' }] }));
  const it = { path: t1, rule: 'ffu-slot-target', why: 'test', ffuSlot: { id: 'slot1', mark: '@@' } };
  let procs: ProcLite[] | undefined = [];
  const guard = { keep: [], inUse: [] as string[], home: path.join(root, 'home') };
  const check = ffuSlotBusyNow(root, async () => procs, () => guard, () => NOW, async () => []);
  assert.equal(await check(it), undefined, 'unchanged: it goes');
  assert.equal(await check({ path: t1, rule: 'ffu-runner-work', why: 'x' }), undefined, 'another item passes');
  procs = [{ pid: 7, ppid: 1, cmd: `${t1}/debug/deps/golden-1 --test-threads 4` } as ProcLite];
  assert.match((await check(it)) ?? '', /since the plan: a running process names it/);
  procs = [{ pid: 8, ppid: 1, cmd: `cargo build --manifest-path ${path.join(root, 'ffu-sandboxes', 'slot1', 'ffu', 'Cargo.toml')}` } as ProcLite];
  assert.match((await check(it)) ?? '', /since the plan: a running process names it/, 'a cargo build in the checkout names the slot (w6240)');
  procs = undefined;
  assert.match((await check(it)) ?? '', /process list could not be read/);
  procs = [];
  fs.writeFileSync(state, JSON.stringify({ slots: [{ id: 'slot1', holder: 'new00001', takenAt: '2026-11-26T12:00:00Z' }] }));
  assert.match((await check(it)) ?? '', /ffu slot1 was taken since the plan/);
  // The same session takes its slot back: takeSlot keeps takenAt then, but usedAt moves.
  const down = { slots: [{ id: 'slot1', holder: 'down0001', takenAt: '2026-11-20T00:00:00Z', usedAt: '2026-11-20T00:00:00Z' }] };
  fs.writeFileSync(state, JSON.stringify(down));
  const held = { ...it, ffuSlot: { id: 'slot1', mark: 'down0001@2026-11-20T00:00:00Z@2026-11-20T00:00:00Z' } };
  assert.equal(await check(held), undefined, 'its holder still down: it goes');
  fs.writeFileSync(state, JSON.stringify({ slots: [{ ...down.slots[0], usedAt: '2026-11-26T12:00:00Z' }] }));
  assert.match((await check(held)) ?? '', /ffu slot1 was taken since the plan/, 'a same-session re-take');
  // The holder runs again with no take yet: a fresh guard says it.
  fs.writeFileSync(state, JSON.stringify(down));
  guard.inUse.push(path.join(root, 'tmp', 'ffa-down0001'));
  assert.match((await check(held)) ?? '', /holder down0001 runs or can resume again/);
  assert.match((await ffuSlotBusyNow(root, async () => [], () => { throw new Error('x'); })(held)) ?? '', /sessions could not be read again/);
  assert.match((await ffuSlotBusyNow(undefined, async () => [])(it)) ?? '', /no install root/);
});

test('w6290: a slot a pass kept over the cap for a running build is judged again alone; busy it is kept, idle it gets what the pass would plan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6290-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  // Both over a 3000-byte cap; a rustc writes into slot1 (LothDesktop slot2, 2026-11-27 03:16: 16.1 GB kept for an ffu_sim rustc).
  const capGB = 3000 / 1024 ** 3;
  const t1 = target(root, 'slot1', 1, 2000, 2000);
  target(root, 'slot2', 1, 2000, 2000);
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot1', holder: 'live0290' }] }));
  const inUse = [path.join(root, 'tmp', 'ffa-live0290')];
  const procs: ProcLite[] = [{ pid: 42, ppid: 1, cmd: `rustc --out-dir ${t1}/debug/deps` } as ProcLite];
  const settings = { ffuSlotTargetCapGB: capGB };
  const pass = await plan(root, { procs, inUse, settings, scope: 'cargo-cap' });
  assert.ok(!ffuItems(root, pass).some((p) => p.startsWith('ffu-sandboxes/slot1/')), 'the pass keeps the busy slot whole');
  assert.deepEqual(busySlotsOf(pass.held, root), ['slot1'], JSON.stringify(pass.held));

  // Still building: the re-check keeps it again and names it busy; slot2 is not read at all.
  const still = await plan(root, { procs, inUse, settings, scope: 'ffu-busy-retry', slots: ['slot1'] });
  assert.deepEqual(ffuItems(root, still), []);
  assert.deepEqual(busySlotsOf(still.held, root), ['slot1']);

  // The build ended: the re-check plans for slot1 exactly what an idle pass plans there, and nothing elsewhere.
  const idle = await plan(root, { procs: [], inUse, settings, scope: 'ffu-busy-retry', slots: ['slot1'] });
  const idlePass = await plan(root, { procs: [], inUse, settings, scope: 'cargo-cap' });
  assert.deepEqual(ffuItems(root, idle), ffuItems(root, idlePass).filter((p) => p.startsWith('ffu-sandboxes/slot1/')));
  assert.deepEqual(ffuItems(root, idle), ['ffu-sandboxes/slot1/target/debug/incremental']);
  assert.deepEqual(busySlotsOf(idle.held, root), []);
});

/** Date a slot's take and its git files and target to `when`, as if nothing touched it since (w6484). */
function age(root: string, id: string, when: number) {
  const st = readSlotState(root);
  const s = st.slots.find((x) => x.id === id)!;
  s.takenAt = s.usedAt = new Date(when).toISOString();
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify(st, null, 2));
  const wt = slotCheckout(root, id);
  const gd = path.resolve(wt, fs.readFileSync(path.join(wt, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim());
  const t = when / 1000;
  for (const f of ['index', 'HEAD', path.join('logs', 'HEAD')]) if (fs.existsSync(path.join(gd, f))) fs.utimesSync(path.join(gd, f), t, t);
  for (const prof of ['debug', 'release', 'bench']) for (const sub of ['', '.fingerprint', 'deps']) if (fs.existsSync(path.join(slotTarget(root, id), prof, sub))) fs.utimesSync(path.join(slotTarget(root, id), prof, sub), t, t);
}

test("w6484: the daemon's report frees 2026-11-27's stale holds by itself (a finished holder's pushed slot, a stopped one's 10 uncommitted changes rescued); a live one stays, and a running holder's stale slot is left to a take", async (t) => {
  const { root, remote } = world(t);
  const OLD = NOW - 255 * 60_000;
  // BEAST slot4 / m5 slot1: on no open request, its work pushed
  assert.equal(takeSlot(at(root, 'aaaa1111', OLD, { max: 4 }), { branch: 'feat', remote }), 'slot1');
  // BEAST slot3: stopped, unused 255 min, 10 uncommitted changes
  assert.equal(takeSlot(at(root, 'bbbb2222', OLD, { live: ['aaaa1111', 'bbbb2222'], max: 4 }), { remote }), 'slot2');
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(slotCheckout(root, 'slot2'), `wip${i}.rs`), `// ${i}\n`);
  // a live holder working in its slot now
  assert.equal(takeSlot(at(root, 'cccc3333', NOW, { live: ['aaaa1111', 'bbbb2222', 'cccc3333'], max: 4 }), { branch: 'feat', remote }), 'slot3');
  // w6495's review: a holder that still runs but is on no open request (BEAST slot4's 5493f091 ran so), writing in its slot
  assert.equal(takeSlot(at(root, 'dddd4444', NOW, { live: ['aaaa1111', 'bbbb2222', 'cccc3333', 'dddd4444'], max: 4 }), { branch: 'feat', remote }), 'slot4');
  for (const id of ['slot1', 'slot2', 'slot3']) fs.mkdirSync(path.join(slotTarget(root, id), 'debug'), { recursive: true });
  age(root, 'slot1', OLD);
  age(root, 'slot2', OLD);
  const owners = { bbbb2222: own('blocked'), cccc3333: own('active') };
  const judge = () => {
    const d = at(root, '', NOW, { live: ['cccc3333', 'dddd4444'], owners, max: 4 });
    Object.assign(d.facts!, { resumable: ['bbbb2222'] });
    return d;
  };
  const report = slotsReport(judge());
  assert.deepEqual(report.slots.map((s) => [s.id, s.stale, s.holderIs]), [['slot1', true, 'gone'], ['slot2', true, 'stopped'], ['slot3', false, 'live'], ['slot4', true, 'live']], JSON.stringify(report.slots.map((s) => s.why)));
  const holders = () => readSlotState(root).slots.map((s) => s.holder ?? '-');
  assert.deepEqual(holders(), ['aaaa1111', 'bbbb2222', 'cccc3333', 'dddd4444'], 'reading the slots frees nothing: before w6484 only a take or a hand-run sweep did');
  const logs: string[] = [];
  let mode: 'warn' | 'on' = 'warn';
  const sweep = async () => {
    const d = judge();
    const code = ffuSlotMain(['sweep'], d);
    return { ok: code === 0, out: d.said.join('') + d.out.join('') };
  };
  const auto = new FfuSlotAutoSweep({ mode: () => mode, sweep, log: (s) => void logs.push(s) });
  assert.deepEqual(await auto.onReport(report), ['slot1', 'slot2']);
  assert.deepEqual(holders(), ['aaaa1111', 'bbbb2222', 'cccc3333', 'dddd4444'], 'warn-only frees nothing');
  assert.equal(logs.filter((l) => /would free/.test(l)).length, 2);
  mode = 'on';
  assert.deepEqual(await auto.onReport(report), ['slot1', 'slot2'], logs.join('\n'));
  assert.deepEqual(holders(), ['-', '-', 'cccc3333', 'dddd4444'], 'both stale holds freed; the live one and the running stale one kept');
  const r = readSlotState(root).rescues ?? [];
  assert.equal(r.length, 1, 'only the stopped holder had work to save');
  assert.ok(r[0].holder === 'bbbb2222' && r[0].pushed, JSON.stringify(r[0]));
  const files = git(['ls-tree', '--name-only', r[0].branch], remote).split('\n').filter((f) => f.startsWith('wip'));
  assert.equal(files.length, 10, 'all 10 uncommitted changes are on the pushed rescue branch');
  assert.ok(logs.some((l) => l.startsWith("ffu slots: auto sweep: saved bbbb2222's work in slot2") && l.includes(`on branch ${r[0].branch}, pushed to origin`)), logs.join('\n'));
  for (const id of ['slot1', 'slot2', 'slot3']) assert.ok(fs.existsSync(path.join(slotTarget(root, id), 'debug')), `${id}'s target stays warm`);
  // The running holder writes on after the sweep; the next take that needs its slot saves that work before it resets it.
  fs.writeFileSync(path.join(slotCheckout(root, 'slot4'), 'after-sweep.rs'), '// written after the sweep\n');
  const busy = { ...owners, eeee5551: own('active'), eeee5552: own('active') };
  // The first take on feat gets released slot1; the next prefers slot4, already on feat, to slot2 and frees it.
  const taker = (h: string) => at(root, h, NOW, { live: ['cccc3333', 'dddd4444', 'eeee5551', 'eeee5552'], owners: busy, max: 4 });
  assert.equal(takeSlot(taker('eeee5551'), { branch: 'feat', remote }), 'slot1');
  assert.equal(takeSlot(taker('eeee5552'), { branch: 'feat', remote }), 'slot4');
  const saved = (readSlotState(root).rescues ?? []).find((x) => x.holder === 'dddd4444');
  assert.ok(saved?.pushed, JSON.stringify(readSlotState(root).rescues));
  assert.ok(git(['ls-tree', '--name-only', saved!.branch], remote).split('\n').includes('after-sweep.rs'), 'what the running holder wrote after the sweep is on its rescue branch');
});

test("w6484: the daemon's sweep process (runFfuSlotSweep, no session) frees a finished holder's pushed slot from cleanup-facts.json", async (t) => {
  const { root, remote } = world(t);
  assert.equal(takeSlot(at(root, 'aaaa1111', NOW, { max: 3 }), { branch: 'feat', remote }), 'slot1');
  assert.equal(takeSlot(at(root, 'bbbb2222', NOW, { live: ['aaaa1111', 'bbbb2222'], max: 3 }), { branch: 'feat', remote }), 'slot2');
  const factsFile = path.join(root, 'cleanup-facts.json');
  // aaaa1111 has gone; bbbb2222 still runs, though on no open request: the sessionless sweep leaves it to a take (w6495)
  fs.writeFileSync(factsFile, JSON.stringify({ at: new Date().toISOString(), connected: true, root, tempRoot: path.join(root, 'tmp'), sandboxes: [], live: ['bbbb2222'], resumable: [], open: [], closed: [], owners: {} }));
  const r = await runFfuSlotSweep({ root, factsFile, max: 3 });
  assert.equal(r.ok, true, r.out);
  assert.match(r.out, /ffu-slot: freed slot1: held by aaaa1111, which is on no open request, and its work is pushed/);
  assert.doesNotMatch(r.out, /freed slot2/);
  assert.deepEqual(readSlotState(root).slots.map((s) => s.holder), [undefined, 'bbbb2222']);
});

test('w6484: a holder that resumes after a sweep freed its slot keeps the work it wrote there: the next take rescues it first (w6510)', async (t) => {
  const { root, remote } = world(t);
  const OLD = NOW - 255 * 60_000;
  assert.equal(takeSlot(at(root, 'aaaa1111', OLD, { max: 2 }), { branch: 'feat', remote }), 'slot1');
  age(root, 'slot1', OLD);
  // aaaa1111 waits on CI, stopped past the grace: the daemon's sweep (no session) frees its pushed slot with nothing to save
  const owners = { aaaa1111: own('blocked'), bbbb2222: own('active') };
  const sweeper = at(root, '', NOW, { live: ['bbbb2222'], owners, max: 2 });
  Object.assign(sweeper.facts!, { resumable: ['aaaa1111'] });
  assert.deepEqual(sweepSlots(sweeper), ['slot1']);
  assert.deepEqual(readSlotState(root).rescues ?? [], []);
  // aaaa1111 resumes and goes on in its old checkout: a commit on no branch of origin, and an uncommitted file
  const wt = slotCheckout(root, 'slot1');
  fs.writeFileSync(path.join(wt, 'committed.rs'), '// 1\n');
  git(['add', 'committed.rs'], wt);
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'resumed'], wt);
  fs.writeFileSync(path.join(wt, 'uncommitted.rs'), '// 2\n');
  const listed = slotsReport(at(root, 'bbbb2222', NOW, { live: ['aaaa1111', 'bbbb2222'], owners, max: 2 })).slots[0];
  assert.ok(listed.free && !listed.stale && /released; its checkout has .* saved on a rescue branch first/.test(listed.why ?? ""), listed.why ?? "");
  // another worker takes it: the work is saved under aaaa1111's name before the reset
  assert.equal(takeSlot(at(root, 'bbbb2222', NOW, { live: ['aaaa1111', 'bbbb2222'], owners, max: 2 }), { branch: 'feat', remote }), 'slot1');
  const r = readSlotState(root).rescues ?? [];
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.ok(r[0].holder === 'aaaa1111' && r[0].pushed && r[0].branch.startsWith('rescue/ffu-slot/slot1-aaaa1111-'), JSON.stringify(r[0]));
  const files = git(['ls-tree', '--name-only', r[0].branch], remote).split('\n');
  assert.ok(files.includes('committed.rs') && files.includes('uncommitted.rs'), files.join(' '));
  assert.ok(!fs.existsSync(path.join(wt, 'uncommitted.rs')), 'the checkout is reset for its new holder');
  assert.equal(readSlotState(root).slots[0].freedFrom, undefined);
});

/** w6803: a GitHub stand-in for a test's pushes: refused while `down` says why, and GH007 for a pushed tip whose author or committer email is not a noreply one. */
function github<D extends FfuSlotDeps>(d: D, o: { down?: string; gh007?: boolean }): D {
  const real = d.git;
  d.git = (args, cwd) => {
    const i = args.indexOf('push');
    if (i < 0) return real(args, cwd);
    if (o.down) return { code: 1, out: '', err: o.down };
    if (o.gh007) {
      const src = args[args.length - 1].split(':')[0];
      const who = real(['log', '-1', '--format=%ae %ce', src], cwd).out.trim().split(' ');
      if (who.some((e) => !/@users\.noreply\.github\.com$/.test(e))) return { code: 1, out: '', err: 'remote: error: GH007: Your push would publish a private email address.\nTo github.com:x/ffu.git\n ! [remote rejected] (push declined due to email privacy restrictions)' };
    }
    return real(args, cwd);
  };
  return d;
}

test("w6803: the rescue commit is made as a noreply identity, not the machine's own; a push GitHub refuses is reported and tried again by a later sweep until it is on origin", (t) => {
  const { root, remote } = world(t);
  takeSlot(at(root, 'aaaa1111', NOW), { branch: 'feat', remote });
  // m5's case: the machine's own identity is a private address (here the shared clone's config, which its checkouts read).
  git(['config', 'user.email', 'someone@private.example'], path.join(root, 'ffu-sandboxes', 'repo'));
  git(['config', 'user.name', 'Some One'], path.join(root, 'ffu-sandboxes', 'repo'));
  fs.writeFileSync(path.join(slotCheckout(root, 'slot1'), 'wip.rs'), '// not committed\n');
  const gh = { down: 'remote: Internal Server Error' };
  const b = github(at(root, 'bbbb2222', NOW + 60_000, { live: ['aaaa1111', 'bbbb2222'], owners: { bbbb2222: own('active') } }), gh);
  assert.equal(takeSlot(b, { branch: 'feat', remote }), 'slot1');
  const r = readSlotState(root).rescues?.[0];
  assert.ok(r && !r.pushed && /Internal Server Error/.test(r.pushError ?? ''), JSON.stringify(r));
  const repo = path.join(root, 'ffu-sandboxes', 'repo');
  assert.equal(git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', r.branch], repo), `${RESCUE_GIT_IDENTITY.name} <${RESCUE_GIT_IDENTITY.email}>|${RESCUE_GIT_IDENTITY.name} <${RESCUE_GIT_IDENTITY.email}>`, 'author and committer are the noreply identity');
  assert.match(b.said.join(''), /ffu-slot: rescue push failed: rescue\/ffu-slot\/slot1-aaaa1111-[0-9a-f]{8} \(aaaa1111's work from slot1, [0-9a-f]{8}\) is in .* only, tried again on a later sweep: remote: Internal Server Error/);
  assert.deepEqual(slotsReport(b).unpushedRescues?.map((x) => [x.branch, x.due]), [[r.branch, false]], 'the report names it; not due right after the try');

  gh.down = '';
  const early = github(at(root, 'cccc3333', NOW + 60_000 + RESCUE_RETRY_MS - 1, { live: ['bbbb2222', 'cccc3333'] }), gh);
  sweepSlots(early);
  assert.equal(readSlotState(root).rescues?.[0].pushed, false, 'not tried again before RESCUE_RETRY_MS');
  assert.equal(slotsReport(at(root, 'cccc3333', NOW + 60_000 + RESCUE_RETRY_MS)).unpushedRescues?.[0].due, true, 'due once RESCUE_RETRY_MS passed');
  const late = github(at(root, 'cccc3333', NOW + 60_000 + RESCUE_RETRY_MS, { live: ['bbbb2222', 'cccc3333'] }), gh);
  sweepSlots(late);
  const after = readSlotState(root).rescues?.[0];
  assert.ok(after?.pushed && !after.pushError && !after.pushedAs, JSON.stringify(after));
  assert.equal(git(['show', `${r.branch}:wip.rs`], remote), '// not committed', 'the work is on origin');
  assert.match(late.said.join(''), /rescue pushed: aaaa1111's work from slot1 .* is on origin as rescue\/ffu-slot\/slot1-aaaa1111-/);
  assert.equal(slotsReport(late).unpushedRescues, undefined);
  assert.ok(git(['rev-parse', '--verify', `refs/heads/${r.branch}`], repo), 'the local branch stays');
});

test("w6803: a rescue made before the fix as a private address (m5's slot2-5a78ddd2-7e2a4052) is made again as the noreply identity on <branch>-noreply and pushed; the original stays local", (t) => {
  const { root, remote } = world(t);
  takeSlot(at(root, 'aaaa1111', NOW), { branch: 'feat', remote });
  const wt = slotCheckout(root, 'slot1');
  const repo = path.join(root, 'ffu-sandboxes', 'repo');
  fs.writeFileSync(path.join(wt, 'wip.rs'), '// not committed\n');
  git(['add', '-A'], wt);
  git(['-c', 'user.name=Some One', '-c', 'user.email=someone@private.example', 'commit', '-qm', 'ffu-slot rescue: what aaaa1111 left uncommitted in slot1 on feat (w5885)'], wt);
  const sha = git(['rev-parse', 'HEAD'], wt);
  const branch = `rescue/ffu-slot/slot1-aaaa1111-${sha.slice(0, 8)}`;
  git(['branch', '-f', branch, sha], repo);
  git(['checkout', '-q', '--detach'], wt);
  const file = path.join(root, 'ffu-sandboxes', 'slots.json');
  const st = JSON.parse(fs.readFileSync(file, 'utf8'));
  st.slots[0].freedFrom = st.slots[0].holder;
  delete st.slots[0].holder;
  st.rescues = [{ holder: 'aaaa1111', slot: 'slot1', branch, sha, from: 'feat', pushed: false, at: new Date(NOW).toISOString(), told: true }];
  fs.writeFileSync(file, JSON.stringify(st));
  const d = github(at(root, 'cccc3333', NOW + 60_000, { live: ['cccc3333'] }), { gh007: true });
  sweepSlots(d);
  const r = readSlotState(root).rescues?.[0];
  assert.ok(r?.pushed && r.pushedAs === `${branch}-noreply`, JSON.stringify(r));
  assert.equal(git(['rev-parse', `${branch}-noreply^{tree}`], remote), git(['rev-parse', `${sha}^{tree}`], repo), 'the same work');
  assert.equal(git(['rev-parse', `${branch}-noreply^`], remote), git(['rev-parse', `${sha}^`], repo), 'on the same parent');
  assert.equal(git(['log', '-1', '--format=%ae %ce', `${branch}-noreply`], remote), `${RESCUE_GIT_IDENTITY.email} ${RESCUE_GIT_IDENTITY.email}`);
  assert.equal(git(['rev-parse', `refs/heads/${branch}`], repo), sha, 'the original stays local, unchanged');
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: remote, env: GIT_ENV }).status, 1, 'the private address never reached origin');
});

test("w6803: a refused push of someone's own commit is never rewritten: it stays unpushed and reported", (t) => {
  const { root, remote } = world(t);
  takeSlot(at(root, 'aaaa1111', NOW), { branch: 'feat', remote });
  const wt = slotCheckout(root, 'slot1');
  fs.writeFileSync(path.join(wt, 'mine.rs'), '// a worker commit\n');
  git(['add', '-A'], wt);
  git(['-c', 'user.name=Some One', '-c', 'user.email=someone@private.example', 'commit', '-qm', 'my own work'], wt);
  const b = github(at(root, 'bbbb2222', NOW + 60_000, { live: ['aaaa1111', 'bbbb2222'], owners: { bbbb2222: own('active') } }), { gh007: true });
  takeSlot(b, { branch: 'feat', remote });
  const r = readSlotState(root).rescues?.[0];
  assert.ok(r && !r.pushed && !r.pushedAs && /GH007/.test(r.pushError ?? ''), JSON.stringify(r));
  assert.match(b.said.join(''), /rescue push failed: .*GH007/);
});

test('w6803: rescueIdentity takes the run\'s own noreply identity (a worker\'s take), else the rescue bot\'s, never a private address', () => {
  const env = (email: string) => ({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'Final Factory', GIT_CONFIG_KEY_2: 'user.email', GIT_CONFIG_VALUE_2: email });
  assert.deepEqual(rescueIdentity(env('481770+bryding@users.noreply.github.com')), { name: 'Final Factory', email: '481770+bryding@users.noreply.github.com' });
  assert.deepEqual(rescueIdentity(env('someone@private.example')), { ...RESCUE_GIT_IDENTITY });
  assert.deepEqual(rescueIdentity({}), { ...RESCUE_GIT_IDENTITY }, "the daemon's sweep: no identity of its own");
  assert.match(RESCUE_GIT_IDENTITY.email, /@users\.noreply\.github\.com$/);
});

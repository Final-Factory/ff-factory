import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFU_SERVER_GROUP, FFU_SLOTS_DEFAULT_MAX, ffuServerExes, ffuSlotMain, readSlotState, realFfuSlotDeps, slotBin, slotCheckout, slotTarget, takeSlot, releaseSlot, sweepSlots, FFU_SLOT_WAIT_GRACE_MS, FFU_SLOT_IDLE_MS, type FfuSlotDeps } from '../machine/ffuSlots.ts';
import type { CleanupGuard } from './cleanup.ts';
import { installLeftoverSettings, planInstallLeftovers, type ProcLite } from './installLeftovers.ts';
import { writeCargoUnit, type FakeUnit } from './cargoGraphFixture.ts';

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
  // w4258: a cargo run in the checkout without CARGO_TARGET_DIR still builds in the slot's target.
  const cfg = fs.readFileSync(path.join(root, 'ffu-sandboxes', 'slot1', '.cargo', 'config.toml'), 'utf8');
  assert.match(cfg, /^\[build\]$/m);
  assert.match(cfg, /^incremental = false$/m, 'w5499: a slot builds with incremental off, as ffu CI does');
  assert.ok(cfg.includes(`target-dir = ${JSON.stringify(slotTarget(root, id).split(path.sep).join('/'))}`), cfg);
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

async function plan(root: string, o: { low?: boolean; procs?: ProcLite[]; inUse?: string[]; settings?: Record<string, unknown>; scope?: 'cargo-cap' } = {}) {
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
    ...(o.scope ? { scope: o.scope } : {}),
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

test('w4258: a test binary running from a slot target no longer keeps it whole: units nothing current uses go, its own stay', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w4258c-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const tg = unitTarget(root, 'slot1');
  fs.writeFileSync(path.join(root, 'ffu-sandboxes', 'slots.json'), JSON.stringify({ slots: [{ id: 'slot1', holder: 'live0004' }] }));
  const checkout = path.join(root, 'ffu-sandboxes', 'slot1', 'ffu');
  // LothDesktop, 2026-11-15: `cargo test` in the checkout, past its build, running a long test binary from deps/.
  const procs: ProcLite[] = [
    { pid: 10, ppid: 1, cmd: `bash -c "cd ${checkout} && cargo test -p ffu-sim"` },
    { pid: 11, ppid: 10, cmd: 'cargo test -p ffu-sim' },
    { pid: 12, ppid: 11, cmd: `${tg}/debug/deps/golden-5555555555555555 --nocapture` },
  ];
  const p = await plan(root, { procs, inUse: [path.join(root, 'tmp', 'ffa-live0004')] });
  const it = p.items.find((i) => i.rule === 'ffu-slot-target');
  assert.ok(it, `the sweep runs beside the test binary: ${JSON.stringify(p.items.map((i) => i.rule))} ${JSON.stringify((p as { held?: unknown }).held)}`);
  assert.equal(rel(root, it.path), 'ffu-sandboxes/slot1/target', 'one item for the target...');
  const gone = [...new Set((it.members ?? []).map((m) => /-([0-9a-f]{16})/.exec(path.basename(m))![1]))].sort();
  assert.deepEqual(gone, ['2222222222222222', '4444444444444444'], '...whose members are the old sim and the dependency only it used');
  assert.match(it.why, /stale build output/);

  // With a rustc running, the target is still building: nothing goes.
  const building = await plan(root, { procs: [...procs, { pid: 13, ppid: 11, cmd: `rustc --crate-name ffu_sim --out-dir ${tg}/debug/deps` }], inUse: [path.join(root, 'tmp', 'ffa-live0004')] });
  assert.deepEqual(ffuItems(root, building), []);

  // A held target over the cap even after the sweep and its incremental cache stays whole while the test runs.
  const over = await plan(root, { procs, inUse: [path.join(root, 'tmp', 'ffa-live0004')], settings: { ffuSlotTargetCapGB: 1000 / 1024 ** 3 } });
  assert.ok(!over.items.some((i) => i.rule === 'ffu-slot-target' && !i.members && rel(root, i.path) === 'ffu-sandboxes/slot1/target'), 'never whole while held or running');
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CleanupGuard } from './cleanup.ts';
import { fenceToRoot } from './cleanup.ts';
import { cleanupPass } from './staleOutput.ts';
import { installLeftoverSettings, mergePlans, planInstallLeftovers, runnerJobWhy, timingHeld, type ProcLite } from './installLeftovers.ts';
import { judgeTiming } from './cleanupFolders.ts';

/**
 * w3502: the daemon's clean-up rules for FF Factory's own big folders inside a worker install that only a person freed before
 * (LothDesktop's V: at 14.2 GB free, 2026-11-07, w3482): the timed runner's timing/cache and timing/builds, and the FFU
 * runners' ffu-runners/<runner>/_work. Each goes only while what uses it is idle: no timing ticket and no timed run in
 * flight, no job on that runner.
 */

const HOUR = 3_600_000;
const NOW = Date.now();

function install(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w3502-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
}

/** A file at `rel` under `root`, it and every folder up to the root aged `ageH` hours. */
function put(root: string, rel: string, ageH: number, body = 'x') {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  const at = (NOW - ageH * HOUR) / 1000;
  for (let p = f; p.length > root.length; p = path.dirname(p)) fs.utimesSync(p, at, at);
}

/** A bench ticket in the install's queue (machine/benchQueue.ts layout: <root>/tmp/bench.queue/tNNNNNNNN/info.json). */
function ticket(root: string, name: string, info: Record<string, unknown>) {
  const d = path.join(root, 'tmp', 'bench.queue', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'info.json'), JSON.stringify(info));
}

async function plan(root: string, o: { low?: boolean; procs?: ProcLite[]; timedBusy?: () => string | undefined; alive?: (pid: number) => boolean; runnerLog?: (r: string) => string | undefined } = {}) {
  const guard: CleanupGuard = { keep: [path.join(root, 'sandboxes'), path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') };
  return planInstallLeftovers({
    root,
    sandboxes: [],
    tempRoots: [path.join(root, 'tmp')],
    guard,
    procs: o.procs ?? [],
    settings: installLeftoverSettings({}),
    now: NOW,
    localWork: async () => false,
    low: o.low,
    heldMinBytes: 0,
    ...(o.timedBusy ? { timedBusy: o.timedBusy } : {}),
    alive: o.alive ?? (() => true),
    runnerLog: o.runnerLog ?? (() => undefined),
  });
}

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');
const taken = (root: string, p: { items: { path: string }[] }) => new Set(p.items.map((i) => rel(root, i.path)));

function timingTree(root: string) {
  put(root, 'timing/cache/3f2a/piece.bin', 30);
  put(root, 'timing/builds/b0/FinalFactory.exe', 30);
  put(root, 'timing/builds/b1/FinalFactory.exe', 30);
  put(root, 'timing/runs/t1/result.json', 30);
}

test('w3502 timing: with no timing ticket and no timed run, old laid-out builds go, and the cache too below the soft threshold', async (t) => {
  const root = install(t);
  timingTree(root);
  const normal = taken(root, await plan(root));
  assert.ok(normal.has('timing/builds/b0') && normal.has('timing/builds/b1'), 'a build untouched a day goes in any pass');
  assert.ok(!normal.has('timing/cache/3f2a'), 'the cache is the runner\'s own (trimmed to 8 GB) outside a low pass');
  const low = taken(root, await plan(root, { low: true }));
  assert.ok(low.has('timing/cache/3f2a'), 'below the soft threshold the cache goes: the next run fetches it again');
  assert.ok(low.has('timing/builds/b0'));
  for (const x of low) assert.ok(!x.startsWith('timing/runs'), `timing/runs is the runner's own (it keeps 10): ${x}`);
});

test('w3502 timing: a fresh build stays outside a low pass, and a piece written minutes ago stays even in one', async (t) => {
  const root = install(t);
  put(root, 'timing/builds/b0/FinalFactory.exe', 2);
  put(root, 'timing/cache/new/piece.bin', 0.05);
  assert.ok(!taken(root, await plan(root)).has('timing/builds/b0'), 'laid out two hours ago: under timingBuildHours');
  const low = taken(root, await plan(root, { low: true }));
  assert.ok(low.has('timing/builds/b0'), 'a low pass takes it after the settle minutes');
  assert.ok(!low.has('timing/cache/new'), 'written 3 minutes ago: a run may be fetching it');
});

test('w3502 timing: a held or waiting timing ticket keeps cache and builds, and a low pass says why', async (t) => {
  const root = install(t);
  timingTree(root);
  ticket(root, 't00000042', { pid: 4242, mode: 'exclusive', reason: 'timing', what: 'bench belts 1920' });
  const p = await plan(root, { low: true });
  for (const x of taken(root, p)) assert.ok(!x.startsWith('timing/'), `kept while a timing ticket lives: ${x}`);
  const why = (p.held ?? []).map((h) => `${rel(root, h.path)}: ${h.why}`).join('\n');
  assert.match(why, /timing\/cache: .*bench ticket t00000042 \(reason timing: bench belts 1920\)/);
  assert.match(why, /timing\/builds: /);
  // The timed runner's own ticket (timedRunner.ts takeTicket: timed_run, reason timing) holds them the same way.
  fs.rmSync(path.join(root, 'tmp', 'bench.queue', 't00000042'), { recursive: true });
  ticket(root, 't00000043', { pid: 4243, mode: 'exclusive', reason: 'timing', timed_run: true, what: 'timed run r7' });
  assert.equal(taken(root, await plan(root, { low: true })).size, 0);
});

test("w3502 timing: a ticket whose helper died, or one for another reason, does not hold them", async (t) => {
  const root = install(t);
  timingTree(root);
  ticket(root, 't00000050', { pid: 5050, mode: 'exclusive', reason: 'timing', what: 'dead helper' });
  ticket(root, 't00000051', { pid: 5151, mode: 'shared', reason: 'boot', what: 'editor boot' });
  assert.equal(timingHeld(root, undefined, (pid) => pid !== 5050), undefined);
  assert.ok(taken(root, await plan(root, { low: true, alive: (pid) => pid !== 5050 })).has('timing/cache/3f2a'));
});

test('w3502 timing: a timed run in flight (the daemon\'s TimedRunner.busy) keeps them with no ticket on disk', async (t) => {
  const root = install(t);
  timingTree(root);
  const p = await plan(root, { low: true, timedBusy: () => 'a timed run is in flight here' });
  assert.equal(taken(root, p).size, 0);
  assert.ok((p.held ?? []).some((h) => /a timed run is in flight here/.test(h.why)));
});

// ---------------------------------------------------------------- FFU runners

const listener = (root: string, name: string, pid: number): ProcLite => ({ pid, ppid: 1, cmd: `"${path.join(root, 'ffu-runners', name, 'bin', 'Runner.Listener.exe')}" run` });
const worker = (root: string, name: string, pid: number, ppid: number): ProcLite => ({ pid, ppid, cmd: `"${path.join(root, 'ffu-runners', name, 'bin', 'Runner.Worker.exe')}" spawnclient 1 2` });
const idleLog = (at: number) => `[${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}Z INFO JobDispatcher] WRITE LINE: x: Listening for Jobs\n`;
const jobLog = (at: number) => `[${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}Z INFO JobDispatcher] Acknowledging runner request 'bd216421'\n`;

function runnersTree(root: string) {
  for (const n of ['r1', 'r2']) {
    put(root, `ffu-runners/${n}/_work/ffu/ffu/target/debug/big.rlib`, 20 * 24);
    put(root, `ffu-runners/${n}/_work/_temp/x.sh`, 20 * 24);
    put(root, `ffu-runners/${n}/_work/_tool/rust/x`, 20 * 24);
    put(root, `ffu-runners/${n}/_work/_actions/checkout/x`, 20 * 24);
    put(root, `ffu-runners/${n}/bin/Runner.Listener.exe`, 20 * 24);
    put(root, `ffu-runners/${n}/.runner`, 20 * 24);
  }
  // a CI checkout is a git repo: the job recreates it, so its repo never keeps it
  put(root, 'ffu-runners/r1/_work/ffu/ffu/.git/HEAD', 20 * 24);
}

test('w3502 ffu-runners: an idle runner\'s old job folders go; _tool, _actions and the runner itself stay', async (t) => {
  const root = install(t);
  runnersTree(root);
  const got = taken(root, await plan(root, { procs: [listener(root, 'r1', 100), listener(root, 'r2', 200)], runnerLog: () => idleLog(NOW - HOUR) }));
  for (const n of ['r1', 'r2']) {
    assert.ok(got.has(`ffu-runners/${n}/_work/ffu`), `${n}: its checkout and cargo target go`);
    assert.ok(got.has(`ffu-runners/${n}/_work/_temp`));
    assert.ok(!got.has(`ffu-runners/${n}/_work/_tool`) && !got.has(`ffu-runners/${n}/_work/_actions`));
  }
  for (const x of got) assert.match(x, /^ffu-runners\/r\d\/_work\/[^/]+$/, `only job folder entries: ${x}`);
});

test('w3502 ffu-runners: a running job (a Runner.Worker, a process in _work, a job just handed over) keeps only that runner\'s folders', async (t) => {
  const root = install(t);
  runnersTree(root);
  // r1 runs a job: its worker under its listener. r2 is idle.
  let p = await plan(root, { low: true, procs: [listener(root, 'r1', 100), worker(root, 'r1', 101, 100), listener(root, 'r2', 200)], runnerLog: () => idleLog(NOW - HOUR) });
  let got = taken(root, p);
  assert.ok(![...got].some((x) => x.startsWith('ffu-runners/r1/')), 'r1 runs a job: nothing of its _work goes');
  assert.ok(got.has('ffu-runners/r2/_work/ffu'), 'r2 is idle: its job folders go');
  assert.ok((p.held ?? []).some((h) => rel(root, h.path) === 'ffu-runners/r1/_work' && /Runner\.Worker \(pid 101\) runs a job/.test(h.why)));
  // A cargo build left running from r1's _work with no worker: still a job.
  const cargo: ProcLite = { pid: 300, ppid: 1, cmd: `cargo build --manifest-path ${path.join(root, 'ffu-runners', 'r1', '_work', 'ffu', 'ffu', 'Cargo.toml')}` };
  got = taken(root, await plan(root, { low: true, procs: [cargo], runnerLog: () => idleLog(NOW - HOUR) }));
  assert.ok(![...got].some((x) => x.startsWith('ffu-runners/r1/')));
  // The listener acknowledged a job a minute ago and has no worker yet (benchRunners.ts holdsJob).
  p = await plan(root, { low: true, procs: [listener(root, 'r1', 100)], runnerLog: (r) => (path.basename(r) === 'r1' ? jobLog(NOW - 60_000) : idleLog(NOW - HOUR)) });
  got = taken(root, p);
  assert.ok(![...got].some((x) => x.startsWith('ffu-runners/r1/')), 'a job just handed over keeps it');
  assert.ok(got.has('ffu-runners/r2/_work/ffu'), 'r2 has no listener running: it takes no job');
});

test('w3502 ffu-runners: unknown processes keep every runner; job folders used lately stay outside a low pass', async (t) => {
  const root = install(t);
  runnersTree(root);
  assert.match(runnerJobWhy(path.join(root, 'ffu-runners', 'r1'), undefined, NOW) ?? '', /process list could not be read/);
  put(root, 'ffu-runners/r2/_work/ffu/ffu/target/debug/fresh.rlib', 2);
  const got = taken(root, await plan(root, { runnerLog: () => idleLog(NOW - HOUR) }));
  assert.ok(got.has('ffu-runners/r1/_work/ffu'));
  assert.ok(!got.has('ffu-runners/r2/_work/ffu'), 'written two hours ago: under runnerWorkDays, the next job reuses its target');
  assert.ok(taken(root, await plan(root, { low: true, runnerLog: () => idleLog(NOW - HOUR) })).has('ffu-runners/r2/_work/ffu'), 'a low pass takes it once settled');
});

test('w3502: seed/Library is never planned, and every new rule\'s item stays inside the install folder (w896)', async (t) => {
  const root = install(t);
  timingTree(root);
  runnersTree(root);
  put(root, 'seed/Library/ArtifactDB', 30 * 24);
  const p = await plan(root, { low: true, runnerLog: () => idleLog(NOW - HOUR) });
  const got = taken(root, p);
  assert.ok(got.size > 0);
  for (const x of got) assert.ok(!x.startsWith('seed'), `the Library seed warms new sandboxes: ${x}`);
  assert.equal(fenceToRoot(p.items, root).outside.length, 0);
  assert.deepEqual(new Set(p.items.map((i) => i.rule)), new Set(['timing-build', 'timing-cache', 'ffu-runner-work']));
});

test('w3502: the timing folder row tells a clean-up worker the daemon trims it', () => {
  assert.match(judgeTiming({ timedRuns: [] } as never), /daemon's clean-up trims them itself/);
});

test('w3502: a low pass removes them by itself, with no person\'s go, fenced to the install folder (the daemon\'s cleanupPass)', async (t) => {
  const root = install(t);
  timingTree(root);
  runnersTree(root);
  const guard: CleanupGuard = { keep: [path.join(root, 'repo')], inUse: [], home: path.join(root, 'home') };
  const p = await plan(root, { low: true, runnerLog: () => idleLog(NOW - HOUR) });
  // CleanupRunner.run (cleanup.ts) runs the stale plan in every low pass while staleOutput.mode is 'on', the default: no ask.
  const r = await cleanupPass({ opts: { stale: true, dryRun: false }, guard, mode: 'on', regular: async () => [], stale: async () => mergePlans({ items: [], listed: [] }, p), root });
  const gone = new Set(r.removed.map((x) => rel(root, x.path)));
  for (const x of ['timing/cache/3f2a', 'timing/builds/b0', 'ffu-runners/r1/_work/ffu', 'ffu-runners/r2/_work/_temp']) {
    assert.ok(gone.has(x), x);
    assert.ok(!fs.existsSync(path.join(root, ...x.split('/'))), `${x} is gone from disk`);
  }
  for (const x of ['timing/runs/t1/result.json', 'ffu-runners/r1/_work/_tool/rust/x', 'ffu-runners/r1/.runner']) assert.ok(fs.existsSync(path.join(root, ...x.split('/'))), `${x} stays`);
});

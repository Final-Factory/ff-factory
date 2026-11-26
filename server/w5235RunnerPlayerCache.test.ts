import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cacheLogSessions, judgeWithGit, planFolders, PLAYER_CACHE_KEEP_NEWEST, type CleanupFacts, type SlotContext } from './cleanupFolders.ts';
import type { ProcLite } from './installLeftovers.ts';
import { removeFenceProblem, removeFolders } from '../machine/leftovers.ts';

/**
 * w5235: `ff-leftovers folders`/`check`/`remove` judge the FFU runners' job folders and the shared player cache. On biscuit
 * (w5233, 2026-11-23) both were "not a place with an owner in the ledger": ffu-biscuit-2's _work held 25 GB with no
 * Runner.Worker running, player-cache/ 11 GB in eight Linux players, and the low-disk clean-up stopped at 16 GB free of 30.
 */
const HOUR = 3_600_000;
const NOW = Date.now();

function world(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w5235-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const facts: CleanupFacts = {
    at: new Date(NOW + 1000).toISOString(),
    connected: true,
    root,
    tempRoot: path.join(root, 'tmp'),
    sandboxes: [],
    live: ['a1a1a1a1'],
    resumable: [],
    owners: { b2b2b2b2: { requests: [{ id: 'w900', status: 'open' } as never] } },
    open: ['w900'],
    closed: [],
    contextAt: new Date().toISOString(),
  };
  return { root, facts };
}

/** A file at `rel` under `root`, it and its folders up to the root aged `ageH` hours. */
function put(root: string, rel: string, ageH: number, body = 'x') {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  const at = (NOW - ageH * HOUR) / 1000;
  for (let p = f; p.length > root.length; p = path.dirname(p)) fs.utimesSync(p, at, at);
}

const idleLog = (at: number) => `[${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}Z INFO JobDispatcher] WRITE LINE: x: Listening for Jobs\n`;
const jobLog = (at: number) => `[${new Date(at).toISOString().slice(0, 19).replace('T', ' ')}Z INFO JobDispatcher] Acknowledging runner request 'bd216421'\n`;
const listener = (root: string, name: string, pid: number): ProcLite => ({ pid, ppid: 1, cmd: `${path.join(root, 'ffu-runners', name, 'bin', 'Runner.Listener')} run` });
const worker = (root: string, name: string, pid: number, ppid: number): ProcLite => ({ pid, ppid, cmd: `${path.join(root, 'ffu-runners', name, 'bin', 'Runner.Worker')} spawnclient 155 160` });

function runners(root: string) {
  for (const n of ['ffu-biscuit-2', 'ffu-biscuit-3']) {
    put(root, `ffu-runners/${n}/_work/ffu/ffu/target/debug/big.rlib`, 7);
    put(root, `ffu-runners/${n}/_work/ffu/ffu/fuzz/target/CACHEDIR.TAG`, 7);
    put(root, `ffu-runners/${n}/_work/_temp/x.sh`, 7);
    put(root, `ffu-runners/${n}/_work/_PipelineMapping/Final-Factory/ffu/PipelineFolder.json`, 7);
    put(root, `ffu-runners/${n}/_work/_tool/rust/x`, 7);
    put(root, `ffu-runners/${n}/_work/_actions/checkout/x`, 7);
    put(root, `ffu-runners/${n}/bin/Runner.Listener`, 7);
    put(root, `ffu-runners/${n}/.runner`, 7);
  }
}

function ctx(o: { procs?: ProcLite[]; log?: (r: string) => string | undefined; alive?: (pid: number) => boolean } = {}): SlotContext {
  const procs = o.procs ?? [];
  return { host: 'test', alive: o.alive ?? (() => false), procs: procs.map((p) => p.cmd), procList: procs, runnerLog: o.log ?? (() => idleLog(NOW - HOUR)) };
}

test('w5235 runners: an idle runner\'s job folders are DELETE, its _tool, _actions, bin and settings KEEP', async (t) => {
  const { root, facts } = world(t);
  runners(root);
  const c = ctx({ procs: [listener(root, 'ffu-biscuit-2', 100)] });
  const at = (rel: string) => judgeWithGit(path.join(root, ...rel.split('/')), facts, NOW, c);
  const job = await at('ffu-runners/ffu-biscuit-2/_work/ffu');
  assert.equal(job.verdict, 'delete');
  assert.equal(job.kind, 'ffu-runner-work');
  assert.match(job.why, /FFU runner ffu-biscuit-2's job folder \(ffu\), no job running on the runner/);
  assert.equal((await at('ffu-runners/ffu-biscuit-2/_work/ffu/ffu/target')).verdict, 'delete', 'a path inside a job folder goes as the folder does');
  assert.match((await at('ffu-runners/ffu-biscuit-2/_work/_PipelineMapping')).why, /job folder \(_PipelineMapping\)/, 'names as written on disk');
  for (const keep of ['ffu-runners/ffu-biscuit-2/_work/_tool', 'ffu-runners/ffu-biscuit-2/_work/_actions/checkout', 'ffu-runners/ffu-biscuit-2/_work', 'ffu-runners/ffu-biscuit-2/bin', 'ffu-runners/ffu-biscuit-2/.runner']) {
    assert.equal((await at(keep)).verdict, 'keep', keep);
  }
});

test('w5235 runners: a runner with a job (Runner.Worker, a process in _work, a job just handed over) keeps its job folders; unknown processes keep all', async (t) => {
  const { root, facts } = world(t);
  runners(root);
  const p = (rel: string) => path.join(root, ...rel.split('/'));
  const busy = ctx({ procs: [listener(root, 'ffu-biscuit-2', 100), listener(root, 'ffu-biscuit-3', 200), worker(root, 'ffu-biscuit-3', 201, 200)] });
  const r3 = await judgeWithGit(p('ffu-runners/ffu-biscuit-3/_work/ffu'), facts, NOW, busy);
  assert.equal(r3.verdict, 'keep');
  assert.match(r3.why, /its Runner\.Worker \(pid 201\) runs a job/);
  assert.equal((await judgeWithGit(p('ffu-runners/ffu-biscuit-2/_work/ffu'), facts, NOW, busy)).verdict, 'delete', 'the idle runner beside it still frees');

  const cargo: ProcLite = { pid: 300, ppid: 1, cmd: `cargo test --manifest-path ${p('ffu-runners/ffu-biscuit-2/_work/ffu/ffu/Cargo.toml')}` };
  assert.match((await judgeWithGit(p('ffu-runners/ffu-biscuit-2/_work/ffu'), facts, NOW, ctx({ procs: [cargo] }))).why, /process 300 runs from its _work folder/);

  const handed = ctx({ procs: [listener(root, 'ffu-biscuit-2', 100)], log: () => jobLog(NOW - 60_000) });
  assert.match((await judgeWithGit(p('ffu-runners/ffu-biscuit-2/_work/ffu'), facts, NOW, handed)).why, /handed a job/);

  const blind: SlotContext = { host: 'test', alive: () => false };
  assert.match((await judgeWithGit(p('ffu-runners/ffu-biscuit-2/_work/ffu'), facts, NOW, blind)).why, /running processes could not be read/);

  put(root, 'ffu-runners/ffu-biscuit-2/_work/ffu/ffu/target/fresh.rlib', 0);
  assert.match((await judgeWithGit(p('ffu-runners/ffu-biscuit-2/_work/ffu'), facts, NOW, ctx())).why, /within the 15 min settle time/);
});

test('w5235 runners: a job checkout with uncommitted files still goes (actions/checkout cleans it before every job)', async (t) => {
  const { root, facts } = world(t);
  runners(root);
  const repo = path.join(root, 'ffu-runners', 'ffu-biscuit-2', '_work', 'ffu', 'ffu');
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  put(root, 'ffu-runners/ffu-biscuit-2/_work/ffu/ffu/dirty.txt', 7);
  const aged = (NOW - 7 * HOUR) / 1000;
  // git commit may start auto maintenance in the background, whose lock file comes and goes while we walk (w5322's CI: ENOENT).
  for (const f of fs.readdirSync(repo, { recursive: true }) as string[]) {
    try {
      fs.utimesSync(path.join(repo, f), aged, aged);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  for (let d = repo; d.length > root.length; d = path.dirname(d)) fs.utimesSync(d, aged, aged);
  const r = await judgeWithGit(path.join(root, 'ffu-runners', 'ffu-biscuit-2', '_work', 'ffu'), facts, NOW, ctx());
  assert.equal(r.verdict, 'delete', r.why);
});

/** A ready cached player built `ageH` hours ago, last used `usedH` hours ago. */
function player(root: string, key: string, ageH: number, usedH = ageH) {
  const e = `player-cache/${key}`;
  put(root, `${e}/player/finalfactory.x86_64`, ageH, 'p'.repeat(1000));
  put(root, `${e}/build-manifest.json`, ageH, JSON.stringify({ key, status: 'ok', finished: new Date(NOW - ageH * HOUR).toISOString().slice(0, 19) + 'Z' }));
  put(root, `${e}/last-used`, usedH, '');
  return path.join(root, ...e.split('/'));
}
const sha = (c: string) => c.repeat(40);

test(`w5235 player cache: the ${PLAYER_CACHE_KEEP_NEWEST} newest ready builds stay; an old one nothing uses is DELETE`, async (t) => {
  const { root, facts } = world(t);
  const a = player(root, `${sha('a')}-linux`, 1.5);
  const b = player(root, `${sha('b')}-linux`, 3);
  const c = player(root, `${sha('c')}-linux`, 30);
  put(root, 'player-cache/cache.log', 1, '');
  const j = (p: string) => judgeWithGit(p, facts, NOW, ctx());
  assert.match((await j(a)).why, /one of the 2 newest ready builds/);
  assert.equal((await j(b)).verdict, 'keep');
  const old = await j(c);
  assert.equal(old.verdict, 'delete');
  assert.equal(old.kind, 'player-cache');
  assert.match(old.why, /no running process, pin, slot in use or worker with a request not closed uses it/);
  // The cache's own files and the inside of an entry are never rows.
  for (const keep of [path.join(root, 'player-cache', 'cache.log'), path.join(c, 'player'), path.join(root, 'player-cache')]) assert.equal((await j(keep)).verdict, 'keep', keep);
  const plan = await planFolders(facts, { now: NOW, slots: ctx(), sizes: 'none', localWork: async () => undefined });
  assert.deepEqual(plan.filter((r) => r.kind === 'player-cache' && r.verdict === 'delete').map((r) => r.path), [c]);
});

test('w5235 player cache: a pin, a recent use, a running build, a slot in use or an open request\'s worker keeps an old player', async (t) => {
  const { root, facts } = world(t);
  player(root, `${sha('a')}-linux`, 1.5);
  player(root, `${sha('b')}-linux`, 2);
  const old = (c: string, usedH = 30) => player(root, `${sha(c)}-linux`, 30, usedH);
  const j = (p: string, c: SlotContext = ctx()) => judgeWithGit(p, facts, NOW, c);

  const pinned = old('c');
  put(root, `player-cache/${sha('c')}-linux.pins/4242`, 1, '');
  assert.match((await j(pinned, ctx({ alive: (p) => p === 4242 }))).why, /pinned by live pid 4242/);
  assert.equal((await j(pinned)).verdict, 'delete', 'a pin whose pid is gone is stale');

  assert.match((await j(old('d', 0.5))).why, /used 30 min ago, within 60 min/);

  const built = old('e');
  assert.match((await j(built, ctx({ procs: [{ pid: 9, ppid: 1, cmd: `bash scripts/nightly/build_player.sh --sha ${sha('e')}` }] }))).why, /a running process names it or its commit/);

  const half = path.join(root, 'player-cache', `${sha('f')}-linux`);
  put(root, `player-cache/${sha('f')}-linux/build.log`, 1);
  assert.match((await j(half)).why, /not ready .* a build may still run/);

  const slotted = old('9');
  put(root, 'players/slot1-0/slot.json', 1, JSON.stringify({ state: 'ready', source: path.join(slotted, 'player') }));
  put(root, 'players/slot1-0/player/finalfactory.x86_64', 1);
  put(root, 'players/slot1-0/leases/l.json', 1, JSON.stringify({ host: 'test', pid: 777, time: NOW / 1000 }));
  assert.match((await j(slotted, ctx({ alive: (p) => p === 777 }))).why, /player slot slot1-0 was filled from it and is in use/);
  assert.equal((await j(slotted)).verdict, 'delete', 'a slot no live lease holds keeps nothing');

  const owned = old('8');
  put(root, 'player-cache/cache.log', 1, `2026-11-22T22:58:52Z built-ok ${sha('8')}-linux ff_sandbox_id=slot1 ff_session_id=b2b2b2b2 478 s\n2026-11-22T22:58:52Z evicted ${sha('7')}-linux ff_sandbox_id=slot1 ff_session_id=a1a1a1a1 1.3 GB\n`);
  assert.match((await j(owned)).why, /worker b2b2b2b2 \(w900\) built or used it \(cache\.log\)/);
  const evicted = old('7');
  assert.equal((await j(evicted)).verdict, 'delete', 'an evicted line names no user');
});

test('w5235: cacheLogSessions reads built-ok and hit lines, not evicted ones', () => {
  const k = `${sha('a')}-win`;
  const log = [`t built-ok ${k} ff_sandbox_id=s ff_session_id=11111111 1 s`, `t hit ${k} pair ff_session_id=22222222`, `t evicted ${k} ff_session_id=33333333 1 GB`, `t built-ok ${sha('b')}-win ff_session_id=44444444`].join('\n');
  assert.deepEqual(cacheLogSessions(log, k), ['11111111', '22222222']);
});

test('w5235: remove never takes the player-cache folder whole', (t) => {
  const { root } = world(t);
  fs.mkdirSync(path.join(root, 'player-cache'));
  assert.match(removeFenceProblem(path.join(root, 'player-cache'), root, { home: os.homedir() }) ?? '', /a top folder of the install folder \(player-cache\)/);
});

test("w5499: remove of a runner job folder a fenced worker gets EPERM on says the daemon's rule takes it, not a half-done delete", async (t) => {
  const { root, facts } = world(t);
  runners(root);
  const c = ctx({ procs: [listener(root, 'ffu-biscuit-2', 100)] });
  const job = path.join(root, 'ffu-runners', 'ffu-biscuit-2', '_work', 'ffu');
  // Windows' Medium integrity label (NW) on ffu-runners refuses a Low integrity worker every file: rmSync throws EPERM.
  const rm = t.mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  });
  const out: string[] = [];
  const code = await removeFolders([job], facts, NOW, (s) => void out.push(s), async () => c, new Map(), { log: path.join(root, 'removed.jsonl'), cwd: root });
  rm.mock.restore();
  assert.equal(code, 1);
  assert.match(out.join(''), /KEEP .*\n.*a fenced worker cannot delete an FFU runner's folders \(EPERM.*the daemon's rule ffu-runner-work takes it while no job runs: by itself only after 14 days untouched, or 15 min when the disk is low, and at once on a machine_cleanup pass/);
  assert.match(out.join(''), /On a disk clean-up request of this machine run mcp__machine__machine_cleanup yourself; on any other request it stays until then/, 'w5929: says up front how it goes, or that it stays and why');
});

test('w5929: on Windows the DELETE row of a runner job folder says up front that the worker cannot remove it and how it goes', async (t) => {
  const { root, facts } = world(t);
  runners(root);
  const job = path.join(root, 'ffu-runners', 'ffu-biscuit-2', '_work', 'ffu');
  const win = await judgeWithGit(job, facts, NOW, { ...ctx({ procs: [listener(root, 'ffu-biscuit-2', 100)] }), platform: 'win32' });
  assert.equal(win.verdict, 'delete');
  assert.match(win.why, /A fenced worker cannot delete it on Windows .*after 14 days untouched.*run mcp__machine__machine_cleanup yourself/);
  const linux = await judgeWithGit(job, facts, NOW, { ...ctx({ procs: [listener(root, 'ffu-biscuit-2', 100)] }), platform: 'linux' });
  assert.doesNotMatch(linux.why, /machine_cleanup/, 'off Windows a worker removes it itself');
});

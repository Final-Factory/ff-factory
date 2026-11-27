// w6367: the long-run route (machine/longRuns.ts): only sanctioned runs, warn starts nothing, on joins the job before go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DROPPED_ENV, KEEPER_SCRIPT, RUN_ENV, SANCTIONED, liveRuns, longRunsRpcHandlers, longRunsSetting, planOf, readEnvFile, runEnv, type LongRunsDeps, type LongRunPlan } from './longRuns.ts';
import { RpcRefused } from './daemonRpc.ts';

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longruns-'));
  const sandbox = path.join(root, 'sandboxes', 'sb1');
  fs.mkdirSync(path.join(sandbox, path.dirname(SANCTIONED.nightly.script)), { recursive: true });
  fs.writeFileSync(path.join(sandbox, SANCTIONED.nightly.script), '#!/bin/bash\n');
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const bash = path.join(root, 'tools', 'git', 'bin', 'bash.exe');
  fs.mkdirSync(path.dirname(bash), { recursive: true });
  fs.writeFileSync(bash, '');
  const lines: string[] = [];
  const calls: string[] = [];
  const d: LongRunsDeps = {
    platform: 'win32',
    root,
    dir: path.join(root, 'app', 'long-runs'),
    mode: () => 'warn',
    capsMode: () => 'warn',
    sandboxPath: (id) => (id === 'sb1' ? sandbox : undefined),
    isNightly: (s) => s === 'night',
    lowNode: () => 'C:/low/node.exe',
    bash: () => bash,
    jobHelper: () => 'C:/app/bin/ffjob.exe',
    base: { PATH: 'C:/Windows', SystemRoot: 'C:/Windows', FF_SESSION_ID: 'leak', SECRET_TOKEN: 'x' },
    alive: () => true,
    startKeeper: async (_node: string, plan: LongRunPlan) => {
      calls.push(`keeper ${plan.name}`);
      return { pid: 4242, go: () => calls.push('go'), kill: () => calls.push('kill') };
    },
    joinJob: async (_h, pid, mode) => {
      calls.push(`job ${pid} ${mode}`);
      return true;
    },
    log: (l) => lines.push(l),
  };
  const envFile = (o: unknown) => {
    const f = path.join(root, 'tmp', `env-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(o));
    return f;
  };
  return { root, sandbox, bash, d, lines, calls, envFile };
}

const night = { session: 'night', sandbox: 'sb1' };

async function refused(p: Promise<unknown> | (() => unknown), status: number, re?: RegExp) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    assert.ok(e instanceof RpcRefused, String(e));
    assert.equal(e.status, status, e.message);
    if (re) assert.match(e.message, re);
    return;
  }
  assert.fail('not refused');
}

test('longRunsSetting: warn unless exactly off or on', () => {
  assert.equal(longRunsSetting(undefined), 'warn');
  assert.equal(longRunsSetting('ON'), 'warn');
  assert.equal(longRunsSetting('enforce'), 'warn');
  assert.equal(longRunsSetting('on'), 'on');
  assert.equal(longRunsSetting('off'), 'off');
});

test('runEnv drops what ties a run to its worker and names it', () => {
  const e = runEnv({ FF_SESSION_ID: 's', ff_for_person: 'p', FF_TIMED_RUN: '1', FF_UNITY_MCP: 'u', KEEP: 'k' }, 'lr-1');
  for (const k of DROPPED_ENV) assert.equal(e[k], undefined);
  assert.equal(e.ff_for_person, undefined);
  assert.equal(e.KEEP, 'k');
  assert.equal(e[RUN_ENV], 'lr-1');
});

test('readEnvFile: inside root only, removed after reading, odd keys dropped', async () => {
  const w = world();
  const f = w.envFile({ A: '1', 'bad key': '2', N: 3, B: 'x' });
  assert.deepEqual(readEnvFile(w.root, f), { A: '1', B: 'x' });
  assert.equal(fs.existsSync(f), false);
  const outside = path.join(os.tmpdir(), `longruns-out-${process.pid}.json`);
  fs.writeFileSync(outside, '{}');
  try {
    await refused(() => readEnvFile(w.root, outside), 403);
    assert.equal(fs.existsSync(outside), true, 'a file outside root is never touched');
  } finally {
    fs.rmSync(outside, { force: true });
  }
  await refused(() => readEnvFile(w.root, 'relative.json'), 400);
  await refused(() => readEnvFile(w.root, path.join(w.root, 'tmp', 'none.json')), 404);
  const arr = w.envFile([1]);
  await refused(() => readEnvFile(w.root, arr), 400);
});

test('planOf: only sanctioned names, a sandbox worker, nightly only for a nightly session', async () => {
  const w = world();
  await refused(() => planOf(w.d, night, { name: 'anything' }, 'id'), 400);
  await refused(() => planOf(w.d, { session: 'night' }, { name: 'nightly' }, 'id'), 403, /sandbox worker/);
  await refused(() => planOf(w.d, { session: 'night', sandbox: 'zz' }, { name: 'nightly' }, 'id'), 404);
  await refused(() => planOf(w.d, { session: 'other', sandbox: 'sb1' }, { name: 'nightly', envFile: w.envFile({}) }, 'id'), 403, /nightly/);
  await refused(() => planOf(w.d, night, { name: 'nightly', args: [1], envFile: w.envFile({}) }, 'id'), 400);
  await refused(() => planOf(w.d, night, { name: 'nightly', args: Array(21).fill('a'), envFile: w.envFile({}) }, 'id'), 400);
  const p = planOf(w.d, night, { name: 'nightly', args: ['start'], envFile: w.envFile({ FF_SESSION_ID: 'x', FF_NIGHTLY_DATE: 'd' }) }, 'lr-9');
  assert.equal(p.exe, w.bash);
  assert.equal(p.cwd, w.sandbox);
  assert.deepEqual(p.argv, [fs.realpathSync(path.join(w.sandbox, SANCTIONED.nightly.script)), 'start']);
  assert.equal(p.env.FF_SESSION_ID, undefined);
  assert.equal(p.env.FF_NIGHTLY_DATE, 'd');
  assert.equal(p.env[RUN_ENV], 'lr-9');
});

test('planOf nightly: the script must be a file of the sandbox itself (no link out)', async (t) => {
  const w = world();
  const script = path.join(w.sandbox, SANCTIONED.nightly.script);
  fs.rmSync(script);
  const elsewhere = path.join(w.root, 'elsewhere.sh');
  fs.writeFileSync(elsewhere, 'echo hi\n');
  try {
    fs.symlinkSync(elsewhere, script, 'file');
  } catch {
    t.skip('this machine makes no file links for this user');
    return;
  }
  await refused(() => planOf(w.d, night, { name: 'nightly', envFile: w.envFile({}) }, 'id'), 403, /outside/);
  fs.rmSync(script);
  await refused(() => planOf(w.d, night, { name: 'nightly', envFile: w.envFile({}) }, 'id'), 404);
});

test('planOf probe: bounded seconds, out under tmp or the sandbox, a bare environment', async () => {
  const w = world();
  await refused(() => planOf(w.d, night, { name: 'probe', seconds: 0, out: path.join(w.root, 'tmp', 'p.log') }, 'id'), 400);
  await refused(() => planOf(w.d, night, { name: 'probe', seconds: 21601, out: path.join(w.root, 'tmp', 'p.log') }, 'id'), 400);
  await refused(() => planOf(w.d, night, { name: 'probe', seconds: 60, out: path.join(w.root, 'p.log') }, 'id'), 403);
  await refused(() => planOf(w.d, night, { name: 'probe', seconds: 60, out: path.join(w.root, 'tmp', '..', 'p.log') }, 'id'), 403);
  // Any sandbox worker may run the probe; it runs only the daemon's own script.
  const p = planOf(w.d, { session: 'other', sandbox: 'sb1' }, { name: 'probe', seconds: 120, out: path.join(w.root, 'tmp', 'p.log') }, 'lr-2');
  assert.equal(p.argv[0], '-c');
  assert.deepEqual(p.argv.slice(2), ['probe', path.join(w.root, 'tmp', 'p.log'), '120']);
  assert.equal(p.env.FF_SESSION_ID, undefined);
  assert.equal(p.env.SECRET_TOKEN, undefined);
  assert.equal(p.env[RUN_ENV], 'lr-2');
  assert.ok(p.env.PATH.startsWith(path.join(w.root, 'tools', 'git', 'usr', 'bin')));
});

test('runs/start off: refused at once, nothing read', async () => {
  const w = world();
  w.d.mode = () => 'off';
  const f = w.envFile({});
  await refused(longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'nightly', envFile: f }) as Promise<unknown>, 409);
  assert.equal(fs.existsSync(f), true);
  assert.deepEqual(w.calls, []);
});

test('runs/start warn: logs what it would start and starts nothing', async () => {
  const w = world();
  const f = w.envFile({ FF_NIGHTLY_DATE: 'd', FF_SESSION_ID: 'x' });
  const r = (await longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'nightly', args: ['start'], envFile: f })) as Record<string, unknown>;
  assert.equal(r.mode, 'warn');
  assert.equal(r.started, false);
  assert.equal(r.ready, true);
  assert.deepEqual(w.calls, []);
  assert.equal(fs.existsSync(f), false, 'the env file is removed even in warn');
  assert.equal(w.lines.length, 1);
  assert.match(w.lines[0], /^long runs \(warn\): would start nightly for night in sb1: .* ready; not started/);
  assert.doesNotMatch(w.lines[0], /FF_NIGHTLY_DATE|=d\b/, 'the log names no environment values');
});

test('runs/start warn: says why it could not, off Windows or with no Low node', async () => {
  const w = world();
  w.d.platform = 'linux';
  const r = (await longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'probe', seconds: 60, out: path.join(w.root, 'tmp', 'p') })) as Record<string, unknown>;
  assert.equal(r.ready, false);
  assert.match(String(r.why), /linux/);
  w.d.platform = 'win32';
  w.d.lowNode = () => undefined;
  const r2 = (await longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'probe', seconds: 60, out: path.join(w.root, 'tmp', 'p') })) as Record<string, unknown>;
  assert.match(String(r2.why), /Low node/);
  assert.deepEqual(w.calls, []);
});

test('runs/start on: the keeper joins its job before go, and the record is written', async () => {
  const w = world();
  w.d.mode = () => 'on';
  w.d.capsMode = () => 'enforce';
  const h = longRunsRpcHandlers(w.d);
  const r = (await h['runs/start'](night, { name: 'probe', seconds: 60, out: path.join(w.root, 'tmp', 'p') })) as Record<string, unknown>;
  assert.equal(r.started, true);
  assert.equal(r.job, true);
  assert.deepEqual(w.calls, ['keeper probe', 'job 4242 enforce', 'go']);
  const runs = (h['runs/status'](night, {}) as { runs: { id: string; pid: number }[] }).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, r.id);
  assert.match(w.lines.at(-1)!, /^long runs: started lr-/);
});

test('runs/start on: no job, no run (the keeper is killed, never told go)', async () => {
  const w = world();
  w.d.mode = () => 'on';
  w.d.joinJob = async () => {
    w.calls.push('job failed');
    return false;
  };
  await refused(longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'probe', seconds: 60, out: path.join(w.root, 'tmp', 'p') }) as Promise<unknown>, 503, /job/);
  assert.deepEqual(w.calls, ['keeper probe', 'job failed', 'kill']);
  assert.deepEqual(liveRuns(w.d), []);
});

test('runs/start on: refused off Windows, with no job helper, and past the live limit', async () => {
  const w = world();
  w.d.mode = () => 'on';
  const body = { name: 'probe', seconds: 60, out: path.join(w.root, 'tmp', 'p') };
  w.d.platform = 'darwin';
  await refused(longRunsRpcHandlers(w.d)['runs/start'](night, body) as Promise<unknown>, 503);
  w.d.platform = 'win32';
  w.d.jobHelper = () => undefined;
  await refused(longRunsRpcHandlers(w.d)['runs/start'](night, body) as Promise<unknown>, 503, /job helper/);
  // workerCaps off: no job to match, so none is made.
  w.d.capsMode = () => 'off';
  const h = longRunsRpcHandlers(w.d);
  assert.equal(((await h['runs/start'](night, body)) as { job: boolean }).job, false);
  await h['runs/start'](night, body);
  await refused(h['runs/start'](night, body) as Promise<unknown>, 409, /live/);
  assert.equal(w.calls.filter((c) => c === 'go').length, 2);
});

test('liveRuns forgets the records of runs that ended', () => {
  const w = world();
  fs.mkdirSync(w.d.dir, { recursive: true });
  fs.writeFileSync(path.join(w.d.dir, 'a.json'), JSON.stringify({ id: 'a', pid: 1, sandbox: 'sb1' }));
  fs.writeFileSync(path.join(w.d.dir, 'b.json'), JSON.stringify({ id: 'b', pid: 2, sandbox: 'sb1' }));
  const live = liveRuns({ dir: w.d.dir, alive: (pid) => pid === 2 });
  assert.deepEqual(live.map((r) => r.id), ['b']);
  assert.equal(fs.existsSync(path.join(w.d.dir, 'a.json')), false);
});

function keeper(args: string[], input?: string): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', KEEPER_SCRIPT, process.execPath, os.tmpdir(), JSON.stringify(args)], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', (code) => resolve(code));
    if (input !== undefined) c.stdin.end(input);
  });
}

test('the keeper starts nothing before go, then exits with the run\'s code', async () => {
  assert.equal(await keeper(['-e', 'process.exit(7)'], 'go\n'), 7);
  assert.equal(await keeper(['-e', 'process.exit(7)'], ''), 2, 'stdin closed before go: nothing started');
});

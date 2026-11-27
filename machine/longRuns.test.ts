// w6367: the long-run route (machine/longRuns.ts): only the sanctioned nightly, warn starts nothing, on joins the job
// before go, and the env file is only a fixed name directly in the caller's own sandbox (review w6376).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DROPPED_ENV, KEEPER_SCRIPT, MAX_RUN_S, RUN_ENV, SANCTIONED, liveRuns, longRunsRpcHandlers, longRunsSetting, planOf, readEnvFile, runEnv, type LongRunsDeps, type LongRunPlan } from './longRuns.ts';
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
  const plans: LongRunPlan[] = [];
  const sent: Record<string, string>[] = [];
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
    base: { PATH: 'C:/Windows', SystemRoot: 'C:/Windows', FF_SESSION_ID: 'leak', NODE_OPTIONS: '--require x', SECRET_TOKEN: 'x' },
    alive: () => true,
    startKeeper: async (_node: string, plan: LongRunPlan) => {
      calls.push(`keeper ${plan.name}`);
      plans.push(plan);
      return {
        pid: 4242,
        go: (env) => {
          calls.push('go');
          sent.push(env);
        },
        kill: () => calls.push('kill'),
      };
    },
    joinJob: async (_h, pid, mode) => {
      calls.push(`job ${pid} ${mode}`);
      return true;
    },
    endTree: async (pid) => {
      calls.push(`end ${pid}`);
    },
    log: (l) => lines.push(l),
  };
  let n = 0;
  const envFile = (o: unknown, dir = sandbox) => {
    const f = path.join(dir, `long-run-env-${process.pid}${n++}.json`);
    fs.writeFileSync(f, JSON.stringify(o));
    return f;
  };
  return { root, sandbox, bash, d, lines, calls, plans, sent, envFile };
}

const night = { session: 'night', sandbox: 'sb1' };
const ENV_REFUSAL = /envFile must be a plain long-run-env-<digits>\.json file directly in your sandbox/;

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

test('only the nightly is sanctioned (no probe or any other route)', () => {
  assert.deepEqual(Object.keys(SANCTIONED), ['nightly']);
});

test('runEnv drops what ties a run to its worker and names it', () => {
  const e = runEnv({ FF_SESSION_ID: 's', ff_for_person: 'p', FF_TIMED_RUN: '1', FF_UNITY_MCP: 'u', KEEP: 'k' }, 'lr-1');
  for (const k of DROPPED_ENV) assert.equal(e[k], undefined);
  assert.equal(e.ff_for_person, undefined);
  assert.equal(e.KEEP, 'k');
  assert.equal(e[RUN_ENV], 'lr-1');
});

test('readEnvFile: the fixed name directly in the sandbox, removed after reading, odd keys dropped', () => {
  const w = world();
  const f = w.envFile({ A: '1', 'bad key': '2', N: 3, B: 'x' });
  assert.deepEqual(readEnvFile(w.sandbox, f), { A: '1', B: 'x' });
  assert.equal(fs.existsSync(f), false);
});

test('readEnvFile: every other file is refused the same way and left alone (review w6376 blocker)', async () => {
  const w = world();
  // The daemon's own files, files elsewhere under root, another name in the sandbox, a deeper folder, a missing file.
  const secret = path.join(w.root, 'secrets', 'daemon-rpc.key');
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  fs.writeFileSync(secret, '{"k":"v"}');
  const inTmp = w.envFile({}, path.join(w.root, 'tmp'));
  const other = path.join(w.sandbox, 'daemon.json');
  fs.writeFileSync(other, '{}');
  const deeper = w.envFile({}, path.join(w.sandbox, 'scripts'));
  const kept = [secret, inTmp, other, deeper];
  for (const f of [...kept, path.join(w.sandbox, 'long-run-env-1.json'), 'long-run-env-1.json', `${w.sandbox}/../sb1/x/../long-run-env-9.json`, 7, undefined]) {
    await refused(() => readEnvFile(w.sandbox, f), 403, ENV_REFUSAL);
  }
  for (const f of kept) assert.equal(fs.existsSync(f), true, `${f} is never touched`);
  // Not a JSON object of strings: the same answer (after the file passed the checks, so it is gone).
  await refused(() => readEnvFile(w.sandbox, w.envFile([1])), 403, ENV_REFUSAL);
});

test('readEnvFile: a hard link or a symbolic link of the fixed name is refused, and its target kept', async (t) => {
  const w = world();
  const target = path.join(w.root, 'secrets', 'k.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"A":"1"}');
  const hard = path.join(w.sandbox, 'long-run-env-11.json');
  fs.linkSync(target, hard);
  await refused(() => readEnvFile(w.sandbox, hard), 403, ENV_REFUSAL);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"A":"1"}');
  const sym = path.join(w.sandbox, 'long-run-env-12.json');
  try {
    fs.symlinkSync(target, sym, 'file');
  } catch {
    t.skip('this machine makes no file links for this user');
    return;
  }
  await refused(() => readEnvFile(w.sandbox, sym), 403, ENV_REFUSAL);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"A":"1"}');
});

test('planOf: only sanctioned names, a sandbox worker, nightly only for a nightly session, nothing read before', async () => {
  const w = world();
  const f = w.envFile({});
  await refused(() => planOf(w.d, night, { name: 'probe', envFile: f }, 'id'), 400);
  await refused(() => planOf(w.d, { session: 'night' }, { name: 'nightly', envFile: f }, 'id'), 403, /sandbox worker/);
  await refused(() => planOf(w.d, { session: 'night', sandbox: 'zz' }, { name: 'nightly', envFile: f }, 'id'), 404);
  await refused(() => planOf(w.d, { session: 'other', sandbox: 'sb1' }, { name: 'nightly', envFile: f }, 'id'), 403, /nightly/);
  await refused(() => planOf(w.d, night, { name: 'nightly', args: [1], envFile: f }, 'id'), 400);
  await refused(() => planOf(w.d, night, { name: 'nightly', args: Array(21).fill('a'), envFile: f }, 'id'), 400);
  assert.equal(fs.existsSync(f), true, 'a refused call reads and removes nothing');
  const p = planOf(w.d, night, { name: 'nightly', args: ['start'], envFile: w.envFile({ FF_SESSION_ID: 'x', FF_NIGHTLY_DATE: 'd', NODE_OPTIONS: '--require evil' }) }, 'lr-9');
  assert.equal(p.exe, w.bash);
  assert.equal(p.cwd, w.sandbox);
  assert.deepEqual(p.argv, [fs.realpathSync(path.join(w.sandbox, SANCTIONED.nightly.script)), 'start']);
  assert.equal(p.env.FF_SESSION_ID, undefined);
  assert.equal(p.env.FF_NIGHTLY_DATE, 'd');
  assert.equal(p.env[RUN_ENV], 'lr-9');
  assert.equal(p.limitS, MAX_RUN_S);
  // The keeper starts with the daemon's basics only: nothing the worker chose (NODE_OPTIONS), nothing of the daemon's own.
  assert.deepEqual(p.keeperEnv, { SystemRoot: 'C:/Windows', PATH: 'C:/Windows' });
});

test('planOf nightly: the script must be a file of the sandbox itself (no link out)', async (t) => {
  const w = world();
  const script = path.join(w.sandbox, SANCTIONED.nightly.script);
  fs.rmSync(script);
  await refused(() => planOf(w.d, night, { name: 'nightly', envFile: w.envFile({}) }, 'id'), 403, /plain file of your sandbox/);
  const elsewhere = path.join(w.root, 'elsewhere.sh');
  fs.writeFileSync(elsewhere, 'echo hi\n');
  try {
    fs.symlinkSync(elsewhere, script, 'file');
  } catch {
    t.skip('this machine makes no file links for this user');
    return;
  }
  await refused(() => planOf(w.d, night, { name: 'nightly', envFile: w.envFile({}) }, 'id'), 403, /plain file of your sandbox/);
});

test('runs/start off: refused at once, nothing read', async () => {
  const w = world();
  w.d.mode = () => 'off';
  const f = w.envFile({});
  await refused(longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'nightly', envFile: f }) as Promise<unknown>, 409);
  assert.equal(fs.existsSync(f), true);
  assert.deepEqual(w.calls, []);
});

test('runs/start warn: logs what it would start and starts nothing, naming no environment', async () => {
  const w = world();
  const f = w.envFile({ FF_NIGHTLY_DATE: 'd', FF_SESSION_ID: 'x' });
  const r = (await longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'nightly', args: ['start'], envFile: f })) as Record<string, unknown>;
  assert.deepEqual(r, { mode: 'warn', started: false, ready: true });
  assert.deepEqual(w.calls, []);
  assert.equal(fs.existsSync(f), false, 'the checked env file is removed (it holds a token)');
  assert.equal(w.lines.length, 1);
  assert.match(w.lines[0], /^long runs \(warn\): would start nightly for night in sb1: .* ready; not started/);
  assert.doesNotMatch(w.lines[0], /FF_NIGHTLY_DATE|=d\b|\benv\b/, 'the log names no environment, nor how much');
});

test('runs/start warn: says why it could not, off Windows, with no Low node or no job helper', async () => {
  const w = world();
  const h = () => longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'nightly', envFile: w.envFile({}) }) as Promise<Record<string, unknown>>;
  w.d.platform = 'linux';
  assert.match(String((await h()).why), /linux/);
  w.d.platform = 'win32';
  w.d.lowNode = () => undefined;
  assert.match(String((await h()).why), /Low node/);
  w.d.lowNode = () => 'C:/low/node.exe';
  w.d.jobHelper = () => undefined;
  assert.match(String((await h()).why), /job helper/);
  assert.deepEqual(w.calls, []);
});

test('runs/start on: the keeper joins its job before go, the env goes over stdin, and the record is written', async () => {
  const w = world();
  w.d.mode = () => 'on';
  w.d.capsMode = () => 'enforce';
  const h = longRunsRpcHandlers(w.d);
  const r = (await h['runs/start'](night, { name: 'nightly', envFile: w.envFile({ FF_NIGHTLY_DATE: 'd' }) })) as Record<string, unknown>;
  assert.equal(r.started, true);
  assert.equal(r.job, true);
  assert.deepEqual(w.calls, ['keeper nightly', 'job 4242 enforce', 'go']);
  assert.equal(w.sent[0].FF_NIGHTLY_DATE, 'd');
  assert.equal(w.sent[0][RUN_ENV], r.id);
  assert.equal(w.plans[0].keeperEnv.FF_NIGHTLY_DATE, undefined, 'the run env is not the keeper\'s');
  const runs = (h['runs/status'](night, {}) as { runs: { id: string; pid: number }[] }).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, r.id);
  assert.match(w.lines.at(-1)!, /^long runs: started lr-/);
});

test('runs/start on: workerCaps off still gives the run a warn job; no job, no run', async () => {
  const w = world();
  w.d.mode = () => 'on';
  w.d.capsMode = () => 'off';
  await longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'nightly', envFile: w.envFile({}) });
  assert.deepEqual(w.calls, ['keeper nightly', 'job 4242 warn', 'go']);
  w.calls.length = 0;
  w.d.joinJob = async () => {
    w.calls.push('job failed');
    return false;
  };
  fs.rmSync(w.d.dir, { recursive: true, force: true });
  await refused(longRunsRpcHandlers(w.d)['runs/start'](night, { name: 'nightly', envFile: w.envFile({}) }) as Promise<unknown>, 503, /job/);
  assert.deepEqual(w.calls, ['keeper nightly', 'job failed', 'kill']);
  assert.deepEqual(liveRuns(w.d), []);
});

test('runs/start on: refused off Windows, with no job helper, and past the live limit', async () => {
  const w = world();
  w.d.mode = () => 'on';
  const body = () => ({ name: 'nightly', envFile: w.envFile({}) });
  w.d.platform = 'darwin';
  await refused(longRunsRpcHandlers(w.d)['runs/start'](night, body()) as Promise<unknown>, 503);
  w.d.platform = 'win32';
  w.d.jobHelper = () => undefined;
  await refused(longRunsRpcHandlers(w.d)['runs/start'](night, body()) as Promise<unknown>, 503, /job helper/);
  w.d.jobHelper = () => 'C:/app/bin/ffjob.exe';
  const h = longRunsRpcHandlers(w.d);
  await h['runs/start'](night, body());
  await h['runs/start'](night, body());
  await refused(h['runs/start'](night, body()) as Promise<unknown>, 409, /live/);
  assert.equal(w.calls.filter((c) => c === 'go').length, 2);
});

test('runs/stop ends only a live run of the caller\'s own sandbox', async () => {
  const w = world();
  w.d.mode = () => 'on';
  const h = longRunsRpcHandlers(w.d);
  const r = (await h['runs/start'](night, { name: 'nightly', envFile: w.envFile({}) })) as { id: string };
  await refused(h['runs/stop']({ session: 'x', sandbox: 'sb2' }, { id: r.id }) as Promise<unknown>, 404);
  await refused(h['runs/stop'](night, { id: 'lr-none' }) as Promise<unknown>, 404);
  assert.deepEqual(await h['runs/stop'](night, { id: r.id }), { stopped: r.id });
  assert.equal(w.calls.at(-1), 'end 4242');
  assert.deepEqual(liveRuns(w.d), []);
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

/** The real keeper: `input` is written to its stdin, then stdin closes. */
function keeper(args: string[], input?: string, limitS = 60, cwd = os.tmpdir()): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', KEEPER_SCRIPT, process.execPath, cwd, JSON.stringify(args), String(limitS)], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('exit', (code) => resolve(code));
    if (input !== undefined) c.stdin.end(input);
  });
}
const go = (env: Record<string, string> = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }) => `go ${JSON.stringify(env)}\n`;

test('the keeper starts nothing before go, then exits with the run\'s code', async () => {
  assert.equal(await keeper(['-e', 'process.exit(7)'], go()), 7);
  assert.equal(await keeper(['-e', 'process.exit(7)'], ''), 2, 'stdin closed before go: nothing started');
  assert.equal(await keeper(['-e', 'process.exit(7)'], 'go\n'), 2, 'no environment with go: nothing started');
  assert.equal(await keeper(['-e', 'process.exit(7)'], 'run {}\n'), 2);
});

test('the keeper keeps the run going after its stdin closes, and the run has the env it was sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-'));
  const out = path.join(dir, 'done.txt');
  // The run outlives the closed stdin by 1.5 s, writes what it was given, and exits 9.
  const run = `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(out)},process.env.LR_MARK||'none');process.exit(9)},1500)`;
  assert.equal(await keeper(['-e', run], go({ PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', LR_MARK: 'sent' })), 9);
  assert.equal(fs.readFileSync(out, 'utf8'), 'sent');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the keeper ends the run at its time limit (exit 124)', async () => {
  const t0 = Date.now();
  assert.equal(await keeper(['-e', 'setTimeout(()=>{},60000)'], go(), 1), 124);
  assert.ok(Date.now() - t0 < 20_000);
});

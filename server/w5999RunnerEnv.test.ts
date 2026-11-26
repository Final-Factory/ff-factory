// w5999: the macOS and Windows CI runners' temp folders inside the worker root (machine/runnerEnv.ts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { RunnerCensus } from '../machine/benchRunners.ts';
import {
  FIRST_LOOK_MS,
  GIVE_UP_MS,
  RESTART_SETTLE_MS,
  RunnerEnv,
  envFileValues,
  hasEnv,
  keepOriginal,
  launchctlEnv,
  plistEnv,
  plistRunner,
  runnerEnvOps,
  runnerEnvTempDir,
  wantedEnv,
  winRelaunchScript,
  withEnv,
  type EnvRunner,
  type RunnerEnvDeps,
  type RunnerEnvState,
} from '../machine/runnerEnv.ts';
import { COOLDOWN_MS } from '../machine/runnerUnits.ts';

test('runnerEnvTempDir: _tmp inside ffw, runner-tmp/<folder> outside, Windows paths case-insensitive and native', () => {
  assert.equal(runnerEnvTempDir('V:\\ffw\\ffu-runners\\ffu-lothdesktop-1', 'V:\\ffw', 'win32'), 'V:\\ffw\\ffu-runners\\ffu-lothdesktop-1\\_tmp');
  assert.equal(runnerEnvTempDir('v:/FFW/ffu-runners/x', 'V:\\ffw', 'win32'), 'v:\\FFW\\ffu-runners\\x\\_tmp');
  assert.equal(runnerEnvTempDir('C:\\actions-runner', 'F:\\ffw', 'win32'), 'F:\\ffw\\runner-tmp\\actions-runner');
  assert.equal(runnerEnvTempDir('/Users/b/ffw/ffu-runners/ffu-m3-2', '/Users/b/ffw', 'darwin'), '/Users/b/ffw/ffu-runners/ffu-m3-2/_tmp');
  assert.equal(runnerEnvTempDir('/Users/b/actions-runner', '/Users/b/ffw', 'darwin'), '/Users/b/ffw/runner-tmp/actions-runner');
  // a sibling whose name starts with the root's is outside it
  assert.equal(runnerEnvTempDir('/Users/b/ffw2/r', '/Users/b/ffw', 'darwin'), '/Users/b/ffw/runner-tmp/r');
  assert.equal(runnerEnvTempDir('/Users/b/r', undefined, 'darwin'), undefined);
});

test('wantedEnv and hasEnv: Windows gets TEMP, TMP and TMPDIR, and its names match in any case', () => {
  assert.deepEqual(wantedEnv('X', 'darwin'), [['TMPDIR', 'X'], ['DOTNET_EnableDiagnostics', '0']]);
  const w = wantedEnv('V:\\t', 'win32');
  assert.deepEqual(w.map(([k]) => k), ['TEMP', 'TMP', 'TMPDIR', 'DOTNET_EnableDiagnostics']);
  assert.ok(hasEnv(new Map([['temp', 'V:\\t'], ['Tmp', 'V:\\t'], ['TMPDIR', 'V:\\t'], ['DOTNET_ENABLEDIAGNOSTICS', '0']]), w, 'win32'));
  assert.ok(!hasEnv(new Map([['tmpdir', 'X'], ['DOTNET_EnableDiagnostics', '0']]), wantedEnv('X', 'darwin'), 'darwin'));
  assert.ok(!hasEnv(new Map([['TEMP', 'V:\\t']]), w, 'win32'));
});

test('withEnv: rewrites a wanted key in place, drops its repeats, adds the missing ones, keeps CRLF and the rest', () => {
  const before = 'CARGO_HOME=V:\\ffw\\cargo\r\nTEMP=C:\\Users\\x\\AppData\\Local\\Temp\r\nPATH=a;b\r\ntemp=old\r\n';
  const after = withEnv(before, wantedEnv('V:\\r\\_tmp', 'win32'), 'win32');
  assert.equal(after, 'CARGO_HOME=V:\\ffw\\cargo\r\nTEMP=V:\\r\\_tmp\r\nPATH=a;b\r\nTMP=V:\\r\\_tmp\r\nTMPDIR=V:\\r\\_tmp\r\nDOTNET_EnableDiagnostics=0\r\n');
  assert.ok(hasEnv(envFileValues(after), wantedEnv('V:\\r\\_tmp', 'win32'), 'win32'));
  // idempotent
  assert.equal(withEnv(after, wantedEnv('V:\\r\\_tmp', 'win32'), 'win32'), after);
  assert.equal(withEnv(undefined, [['A', '1']], 'win32'), 'A=1\r\n');
  assert.equal(withEnv('B=2', [['A', '1']], 'darwin'), 'B=2\nA=1\n');
});

test('envFileValues: the last line of a key wins, as Runner.Listener LoadAndSetEnv reads it', () => {
  const m = envFileValues('A=1\nnot a line\n=x\nA=2\nB=c=d\n');
  assert.equal(m.get('A'), '2');
  assert.equal(m.get('B'), 'c=d');
  assert.equal(m.size, 2);
});

test('plistRunner and plistEnv: a LaunchAgent running <dir>/runsvc.sh of a configured runner', () => {
  const j = { Label: 'actions.runner.Final-Factory-ffu.ffu-m3-2', ProgramArguments: ['/Users/b/ffw/ffu-runners/ffu-m3-2/runsvc.sh'], EnvironmentVariables: { ACTIONS_RUNNER_SVC: '1', N: 3 } };
  const has = (p: string) => p === '/Users/b/ffw/ffu-runners/ffu-m3-2/.runner';
  assert.deepEqual(plistRunner(j, '/p.plist', has), { name: j.Label, root: '/Users/b/ffw/ffu-runners/ffu-m3-2', plist: '/p.plist' });
  assert.equal(plistRunner(j, '/p.plist', () => false), undefined);
  assert.equal(plistRunner({ Label: 'x', ProgramArguments: ['/bin/sh'] }, '/p', () => true), undefined);
  assert.equal(plistRunner(null, '/p', () => true), undefined);
  assert.deepEqual([...plistEnv(j)], [['ACTIONS_RUNNER_SVC', '1']]);
  assert.equal(plistEnv({}).size, 0);
});

test('launchctlEnv: reads the job environment block only, undefined when there is none', () => {
  const out = [
    'gui/501/actions.runner.x = {',
    '\tactive count = 1',
    '\tenvironment = {',
    '\t\tACTIONS_RUNNER_SVC => 1',
    '\t\tTMPDIR => /Users/b/ffw/runner-tmp/actions-runner',
    '\t}',
    '',
    '\tdefault environment = {',
    '\t\tPATH => /usr/bin:/bin',
    '\t\tTMPDIR => /var/folders/x/T/',
    '\t}',
    '',
    '\tinherited environment = {',
    '\t\tSSH_AUTH_SOCK => /private/tmp/x',
    '\t}',
    '}',
  ].join('\n');
  assert.deepEqual([...launchctlEnv(out)!], [['ACTIONS_RUNNER_SVC', '1'], ['TMPDIR', '/Users/b/ffw/runner-tmp/actions-runner']]);
  assert.equal(launchctlEnv(out.replace('\tenvironment = {', '\tsomething = {')), undefined);
  assert.equal(launchctlEnv(undefined), undefined);
  assert.equal(launchctlEnv('\tenvironment = {\n\t\tA => 1\n'), undefined); // cut short
});

test('winRelaunchScript: TerminateProcess with exit code 2, only of a Runner.Listener, refuses a bad pid', () => {
  const s = winRelaunchScript(64860);
  assert.match(s, /TerminateProcess\(h, 2\)/);
  assert.match(s, /OpenProcess\(0x0001/);
  assert.match(s, /Get-Process -Id 64860/);
  assert.match(s, /'Runner\.Listener'/);
  assert.throws(() => winRelaunchScript(0));
  assert.throws(() => winRelaunchScript(1.5));
});

test('keepOriginal: copies a file once and never over an earlier copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5999-'));
  try {
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, 'A=1\n');
    keepOriginal(dir, 'r/1', f, '.env');
    fs.writeFileSync(f, 'A=2\n');
    keepOriginal(dir, 'r/1', f, '.env');
    assert.equal(fs.readFileSync(path.join(dir, 'tmp', 'runner-env', 'r_1.env.orig'), 'utf8'), 'A=1\n');
    keepOriginal(dir, 'none', path.join(dir, 'missing'), '.env');
    assert.ok(!fs.existsSync(path.join(dir, 'tmp', 'runner-env', 'none.env.orig')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// runs on every OS: the census names the folder in another case (and with forward slashes) only where that resolves
test('runnerEnvOps on Windows: finds ffu-runners, writes .env keeping its original, skips a service runner', async () => {
  const ffw = fs.mkdtempSync(path.join(os.tmpdir(), 'w5999-'));
  try {
    const r1 = path.join(ffw, 'ffu-runners', 'ffu-x-1');
    fs.mkdirSync(r1, { recursive: true });
    fs.writeFileSync(path.join(r1, '.runner'), '{}');
    fs.writeFileSync(path.join(r1, '.env'), 'PATH=a\r\n');
    fs.mkdirSync(path.join(ffw, 'ffu-runners', 'not-a-runner'));
    const ops = runnerEnvOps({ platform: 'win32', workerRoot: ffw, home: ffw, uid: 0, exec: async () => '' });
    const census: RunnerCensus = { listeners: [{ pid: 9, root: process.platform === 'win32' ? r1.replace(/\\/g, '/').toUpperCase() : r1, busy: false }], workers: [], leftovers: [] };
    const rs = await ops.runners(census);
    assert.equal(rs.length, 1, JSON.stringify(rs));
    const r = rs.find((x) => x.name.toLowerCase() === 'ffu-x-1')!;
    // ops.tempDir makes a Windows path (runnerEnvTempDir, tested above), which resolves only on Windows
    const want = wantedEnv(path.join(r1, '_tmp'), 'win32');
    assert.ok(!hasEnv((await ops.configured(r))!, want, 'win32'));
    await ops.configure(r, want);
    assert.ok(hasEnv((await ops.configured(r))!, want, 'win32'));
    assert.equal(fs.readFileSync(path.join(ffw, 'tmp', 'runner-env', `${r.name}.env.orig`), 'utf8'), 'PATH=a\r\n');
    assert.equal(await ops.unrestartable!(r, 9), undefined);
    fs.writeFileSync(path.join(r1, '.service'), 'x');
    assert.match((await ops.unrestartable!(r, 9))!, /Windows service/);
    assert.equal((await ops.configured({ name: 'n', root: path.join(ffw, 'nothing') }))!.size, 0);
  } finally {
    fs.rmSync(ffw, { recursive: true, force: true });
  }
});

test('runnerEnvOps on macOS: plutil writes the keys, adding EnvironmentVariables when there is none', async () => {
  const ffw = fs.mkdtempSync(path.join(os.tmpdir(), 'w5999-'));
  try {
    const plist = path.join(ffw, 'actions.runner.x.plist');
    fs.writeFileSync(plist, '<plist/>');
    const calls: string[][] = [];
    const ops = runnerEnvOps({
      platform: 'darwin',
      workerRoot: ffw,
      home: ffw,
      uid: 501,
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return cmd === 'plutil' && args[0] === '-convert' ? JSON.stringify({ Label: 'actions.runner.x' }) : '';
      },
    });
    const r: EnvRunner = { name: 'actions.runner.x', root: '/Users/b/actions-runner', plist };
    await ops.configure(r, wantedEnv('/t', 'darwin'));
    assert.deepEqual(calls.slice(1), [
      ['plutil', '-insert', 'EnvironmentVariables', '-xml', '<dict/>', plist],
      ['plutil', '-replace', 'EnvironmentVariables.TMPDIR', '-string', '/t', plist],
      ['plutil', '-replace', 'EnvironmentVariables.DOTNET_EnableDiagnostics', '-string', '0', plist],
    ]);
    assert.ok(fs.existsSync(path.join(ffw, 'tmp', 'runner-env', 'actions.runner.x.plist.orig')));
    calls.length = 0;
    await ops.restart(r, 5);
    assert.deepEqual(calls, [
      ['launchctl', 'bootout', 'gui/501/actions.runner.x'],
      ['launchctl', 'bootstrap', 'gui/501', plist],
    ]);
  } finally {
    fs.rmSync(ffw, { recursive: true, force: true });
  }
});

// The class, with fakes

const ROOT = 'V:\\ffw\\ffu-runners\\ffu-x-1';
const TMP = `${ROOT}\\_tmp`;

function harness(o: { busyLog?: string; current?: boolean | undefined; ops?: boolean; held?: boolean } = {}) {
  let now = 1_000_000;
  let state: RunnerEnvState | undefined;
  let conf = new Map<string, string>([['PATH', 'a']]);
  let census: RunnerCensus = { listeners: [{ pid: 7, root: 'V:/ffw/ffu-runners/ffu-x-1', busy: false }], workers: [], leftovers: [] };
  const lines: string[] = [];
  const did: string[] = [];
  const paused = new Set<number>();
  const r: EnvRunner = { name: 'ffu-x-1', root: ROOT };
  const deps: RunnerEnvDeps = {
    platform: 'win32',
    runners: async () => [r],
    tempDir: () => TMP,
    configured: async () => new Map(conf),
    configure: async (_r, want) => {
      did.push('configure');
      conf = new Map([...conf, ...want]);
    },
    current: async () => o.current,
    restart: async (_r, pid) => {
      did.push(`restart ${pid}`);
      census = { listeners: [], workers: [], leftovers: [] };
    },
    alive: async (x, c) => c.listeners.some((l) => l.root.toLowerCase() === x.root.replace(/\\/g, '/').toLowerCase()),
    start: async () => {
      did.push('start');
      return 'scheduled task';
    },
    held: () => !!o.held,
    opsRunner: () => !!o.ops,
    census: async () => census,
    diag: () => o.busyLog,
    paused: () => paused,
    readState: () => (state ? JSON.parse(JSON.stringify(state)) : undefined),
    writeState: (s) => {
      state = JSON.parse(JSON.stringify(s));
    },
    log: (t) => lines.push(t),
    now: () => now,
  };
  return {
    env: new RunnerEnv(deps),
    deps,
    did,
    lines,
    paused,
    state: () => state,
    setState: (s: RunnerEnvState) => (state = s),
    advance: (ms: number) => (now += ms),
    setCensus: (c: RunnerCensus) => (census = c),
    back: (pid: number) => (census = { listeners: [{ pid, root: 'V:/ffw/ffu-runners/ffu-x-1', busy: false }], workers: [], leftovers: [] }),
  };
}

test('RunnerEnv: writes the configuration, then restarts the idle listener once on the next pass, and never again', async () => {
  const h = harness({ current: false });
  await h.env.tick();
  assert.deepEqual(h.did, ['configure']);
  await h.env.tick();
  assert.deepEqual(h.did, ['configure', 'restart 7']);
  assert.equal(h.state()!.done['ffu-x-1'], TMP);
  assert.equal(h.state()!.restarting.length, 1);
  h.back(8);
  for (let i = 0; i < 10; i++) {
    h.advance(COOLDOWN_MS);
    await h.env.tick();
  }
  assert.deepEqual(h.did, ['configure', 'restart 7'], 'restarted once only');
  assert.equal(h.state()!.restarting.length, 0, 'back for good once settled');
  assert.ok(h.lines.some((l) => /is back after its restart/.test(l)));
  // a new daemon run (a fresh class) reads the state and does not restart it either
  const again = new RunnerEnv({ ...h.deps });
  await again.tick();
  assert.deepEqual(h.did, ['configure', 'restart 7']);
});

test('RunnerEnv: a listener already started with it is left alone', async () => {
  const h = harness({ current: true });
  await h.env.tick();
  await h.env.tick();
  assert.deepEqual(h.did, ['configure']);
});

test('RunnerEnv: unreadable listener environment is said once and restarts nothing', async () => {
  const h = harness({ current: undefined });
  for (let i = 0; i < 4; i++) await h.env.tick();
  assert.deepEqual(h.did, ['configure']);
  assert.equal(h.lines.filter((l) => /could not tell whether listener/.test(l)).length, 1);
});

test('RunnerEnv: never restarts a busy, worker-running, paused or operations runner', async () => {
  for (const kind of ['busy', 'worker', 'paused', 'log', 'ops'] as const) {
    const h = harness({ current: false, ops: kind === 'ops', busyLog: kind === 'log' ? '[2026-11-26 10:00:00Z INFO JobDispatcher] Job request 1 received.' : undefined });
    if (kind === 'busy') h.setCensus({ listeners: [{ pid: 7, root: 'V:/ffw/ffu-runners/ffu-x-1', busy: true }], workers: [], leftovers: [] });
    if (kind === 'worker') h.setCensus({ listeners: [{ pid: 7, root: 'V:/ffw/ffu-runners/ffu-x-1', busy: false }], workers: [{ pid: 9, root: 'v:/ffw/ffu-runners/FFU-X-1' }], leftovers: [] });
    if (kind === 'paused') h.paused.add(7);
    await h.env.tick();
    await h.env.tick();
    assert.deepEqual(h.did, ['configure'], kind);
  }
});

test('RunnerEnv: a fresh census just before the restart wins over the pass census', async () => {
  const h = harness({ current: false });
  await h.env.tick(); // configure
  let n = 0;
  const census = h.deps.census;
  h.deps.census = async () => (++n === 2 ? { listeners: [{ pid: 7, root: 'V:/ffw/ffu-runners/ffu-x-1', busy: true }], workers: [], leftovers: [] } : census());
  await h.env.tick();
  assert.deepEqual(h.did, ['configure']);
  assert.equal(h.state(), undefined, 'nothing recorded for a runner not restarted');
});

test('RunnerEnv: a runner gone after its restart is started again after two looks, at most every 10 minutes, never while held', async () => {
  const h = harness({ current: false });
  await h.env.tick();
  await h.env.tick(); // restart; census now empty
  assert.deepEqual(h.did, ['configure', 'restart 7']);
  await h.env.tick(); // too soon to look
  h.advance(FIRST_LOOK_MS);
  await h.env.tick(); // first miss
  assert.ok(!h.did.includes('start'));
  h.advance(60_000);
  await h.env.tick(); // second miss: started
  assert.equal(h.did.filter((d) => d === 'start').length, 1);
  h.advance(60_000);
  await h.env.tick();
  assert.equal(h.did.filter((d) => d === 'start').length, 1, 'not again within 10 minutes');
  h.advance(10 * 60_000);
  await h.env.tick();
  assert.equal(h.did.filter((d) => d === 'start').length, 2);
  // back, then settled
  h.back(11);
  h.advance(RESTART_SETTLE_MS);
  await h.env.tick();
  assert.equal(h.state()!.restarting.length, 0);
});

test('RunnerEnv: a runner that exits 5 again after recovery started it is started again (the settle counts from that start)', async () => {
  const h = harness({ current: false });
  await h.env.tick();
  await h.env.tick(); // restart at t0; census empty
  const gone = { listeners: [], workers: [], leftovers: [] };
  h.back(8); // the relaunched listener retries its session conflict...
  h.advance(4 * 60_000);
  await h.env.tick();
  h.setCensus(gone); // ...and exits 5 at 4 minutes
  h.advance(60_000);
  await h.env.tick();
  h.advance(60_000);
  await h.env.tick(); // two looks: started
  assert.equal(h.did.filter((d) => d === 'start').length, 1);
  assert.ok(h.state()!.restarting[0].startedAt, 'the start is kept in the state file');
  h.back(9); // the started one conflicts too...
  h.advance(4 * 60_000);
  await h.env.tick();
  assert.equal(h.state()!.restarting.length, 1, 'not back for good 10 minutes after the first restart: 4 after its start');
  h.setCensus(gone); // ...and exits 5 again
  for (let i = 0; i < 6; i++) {
    h.advance(60_000);
    await h.env.tick();
  }
  assert.equal(h.did.filter((d) => d === 'start').length, 2, 'started again, 10 minutes after the last start');
  h.back(10);
  h.advance(RESTART_SETTLE_MS);
  await h.env.tick();
  assert.equal(h.state()!.restarting.length, 0);
  // a new daemon run keeps the start time: it waits START_EVERY_MS from it, not from its own start
  const h2 = harness({ current: false });
  h2.setState({ restarting: [{ name: 'ffu-x-1', root: ROOT, at: 1_000_000 - 20 * 60_000, pid: 7, startedAt: 1_000_000 - 60_000 }], done: { 'ffu-x-1': TMP } });
  h2.setCensus(gone);
  for (let i = 0; i < 3; i++) {
    h2.advance(60_000);
    await h2.env.tick();
  }
  assert.ok(!h2.did.includes('start'), 'not within 10 minutes of the kept start');
});

test('RunnerEnv: recovery waits while a hold has the runners, and gives up after a day, said', async () => {
  const held = harness({ current: false, held: true });
  held.setState({ restarting: [{ name: 'ffu-x-1', root: ROOT, at: 1_000_000, pid: 7 }], done: { 'ffu-x-1': TMP } });
  held.setCensus({ listeners: [], workers: [], leftovers: [] });
  for (let i = 0; i < 5; i++) {
    held.advance(FIRST_LOOK_MS);
    await held.env.tick();
  }
  assert.ok(!held.did.includes('start'));
  const h = harness({ current: false });
  h.setState({ restarting: [{ name: 'ffu-x-1', root: ROOT, at: 1_000_000, pid: 7 }], done: { 'ffu-x-1': TMP } });
  h.setCensus({ listeners: [], workers: [], leftovers: [] });
  h.advance(GIVE_UP_MS + 1);
  await h.env.tick();
  await h.env.tick();
  assert.ok(!h.did.includes('start'));
  assert.equal(h.state()!.restarting.length, 0);
  assert.ok(h.lines.some((l) => /no longer started by this/.test(l)));
});

test('RunnerEnv: a failed write is said once and nothing is restarted; a failing step never throws', async () => {
  const h = harness({ current: false });
  h.deps.configure = async () => {
    throw new Error('EPERM');
  };
  await h.env.tick();
  await h.env.tick();
  assert.equal(h.lines.filter((l) => /could not write its configuration/.test(l)).length, 1);
  assert.ok(!h.did.some((d) => d.startsWith('restart')));
  h.deps.census = async () => {
    throw new Error('ps failed');
  };
  await h.env.tick();
  assert.ok(h.lines.some((l) => /ps failed/.test(l)));
});

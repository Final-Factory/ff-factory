import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_TMPDIR_MAX, SYSTEM_TMPDIR_VAR, applyDaemonTmpdir, daemonTempDir, editorSystemTempEnv, systemTempDir } from '../machine/daemonTemp.ts';
import { editorLaunchEnv, sandboxEditorEnv } from '../machine/sandboxes.ts';
import { bareEnv } from '../machine/maxEventsFence.ts';
import { REMOVE_TOP } from '../machine/leftovers.ts';
import { TEMP_OLD_KEEP, cleanupRules, type CleanupEnv } from './cleanup.ts';
import { workerUpdateFlags } from './opsWorker.ts';
import { DEFAULT_CLEANUP } from './cleanup.ts';

// w6000 (lothsahn, w5823: "under no circumstances should workers write outside of ffw"; w5834 follow-up): the daemon's own
// temp folder moves inside the worker root, and every place left in machine/ and server/ that names the system temp is
// listed here with why it may stay.

const ROOT = path.resolve('/ffw');

test('w6000: the daemon points TMPDIR, TEMP and TMP at <root>/tmp/daemon and keeps the system temp folder in FF_SYSTEM_TMPDIR', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/var/folders/xy/T', TEMP: 'C:\\Users\\p\\AppData\\Local\\Temp' };
    const made: string[] = [];
    const r = applyDaemonTmpdir(env, ROOT, undefined, { platform, mkdir: (p) => void made.push(p), tmpdir: () => '/sys-tmp' });
    const dir = daemonTempDir(ROOT);
    assert.equal(r.dir, dir, platform);
    assert.deepEqual(made, [dir], 'made before it is named');
    for (const k of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(env[k], dir, `${platform} ${k}`);
    assert.equal(env[SYSTEM_TMPDIR_VAR], '/sys-tmp');
    assert.equal(systemTempDir(env), '/sys-tmp', 'what reads the system temp still finds it');
    assert.ok(dir.startsWith(ROOT + path.sep), 'inside the root');
  }
});

test('w6000: a re-exec of a daemon that moved its temp keeps the first system temp folder', () => {
  const env: NodeJS.ProcessEnv = { [SYSTEM_TMPDIR_VAR]: '/tmp' };
  applyDaemonTmpdir(env, ROOT, 'on', { platform: 'linux', mkdir: () => undefined, tmpdir: () => daemonTempDir(ROOT) });
  assert.equal(env[SYSTEM_TMPDIR_VAR], '/tmp');
});

test('w6000 (lockout rule): off, no root, a folder that cannot be made or a root too long only warn, and change nothing', () => {
  const cases: [string, Parameters<typeof applyDaemonTmpdir>][] = [
    ['off', [{}, ROOT, 'off', { platform: 'linux', mkdir: () => undefined, tmpdir: () => '/tmp' }]],
    ['no worker root', [{}, undefined, undefined, { platform: 'linux', mkdir: () => undefined, tmpdir: () => '/tmp' }]],
    ['could not make', [{}, ROOT, 'on', { platform: 'win32', mkdir: () => { throw new Error('EACCES'); }, tmpdir: () => '/tmp' }]],
    [`longer than ${DAEMON_TMPDIR_MAX}`, [{}, '/' + 'r'.repeat(DAEMON_TMPDIR_MAX), 'on', { platform: 'darwin', mkdir: () => undefined, tmpdir: () => '/tmp' }]],
  ];
  for (const [why, args] of cases) {
    const env = args[0];
    const r = applyDaemonTmpdir(...args);
    assert.equal(r.dir, undefined, why);
    assert.ok(r.line.includes(why), `${why}: ${r.line}`);
    assert.deepEqual(env, {}, `${why}: the environment is untouched`);
  }
  // Windows sockets are named pipes: a long root still moves there.
  assert.ok(applyDaemonTmpdir({}, 'C:\\' + 'r'.repeat(DAEMON_TMPDIR_MAX), 'on', { platform: 'win32', mkdir: () => undefined }).dir);
});

test('w6000: a sandbox editor keeps what editorTmpdir gives it (w5833), the system temp while it is off, not the daemon\'s', () => {
  const env: NodeJS.ProcessEnv = { TMPDIR: daemonTempDir(ROOT), [SYSTEM_TMPDIR_VAR]: '/tmp' };
  assert.equal(sandboxEditorEnv(env, 'slot1', ROOT, false, 'linux').TMPDIR, '/tmp', 'off: the system temp named again');
  assert.equal(sandboxEditorEnv(env, 'slot1', ROOT, true, 'linux').TMPDIR, path.join(ROOT, 'tmp', 'editor-slot1'), 'on: its own');
  assert.equal('TMPDIR' in sandboxEditorEnv(env, 'slot1', ROOT, false, 'win32'), false, 'Windows: editorTempEnv gives it <root>/tmp/unity');
  assert.deepEqual(editorSystemTempEnv({ TMPDIR: '/x' }, 'darwin'), {}, 'the daemon did not move its temp: nothing to name');
});

test('w6000: an editor whose own TMPDIR cannot be made starts with the system temp, not the daemon\'s it would inherit', () => {
  const was = process.env[SYSTEM_TMPDIR_VAR];
  process.env[SYSTEM_TMPDIR_VAR] = '/sys-tmp';
  try {
    const fail = { mkdirSync: (() => { throw new Error('EROFS'); }) as unknown as typeof fs.mkdirSync, accessSync: fs.accessSync };
    const out = editorLaunchEnv({ TMPDIR: '/ffw/tmp/editor-slot1', A: 'b' }, fail, () => undefined);
    assert.deepEqual(out, process.platform === 'win32' ? { A: 'b' } : { A: 'b', TMPDIR: '/sys-tmp' });
  } finally {
    if (was === undefined) delete process.env[SYSTEM_TMPDIR_VAR];
    else process.env[SYSTEM_TMPDIR_VAR] = was;
  }
});

test('w6000: the bare probe shell keeps the temp folder and still no token', () => {
  const env = bareEnv({ SystemRoot: 'C:/Windows', TEMP: 'V:/ffw/tmp/daemon', TMP: 'V:/ffw/tmp/daemon', GH_TOKEN: 's' });
  assert.deepEqual(env, { SystemRoot: 'C:/Windows', TEMP: 'V:/ffw/tmp/daemon', TMP: 'V:/ffw/tmp/daemon' });
});

test('w6000: the clean-up ages the daemon\'s temp folder entry by entry and never removes it whole', () => {
  const tmp = path.join(ROOT, 'tmp');
  const env: CleanupEnv = { platform: 'linux', home: '/home/p', tmp: '/tmp', agentTemp: tmp, daemonTemp: path.join(tmp, 'daemon') };
  const rules = cleanupRules(env, DEFAULT_CLEANUP);
  const old = rules.filter((r) => r.id === 'temp-old');
  assert.ok(old.some((r) => r.dir === path.join(tmp, 'daemon')), 'its entries age out');
  const parent = old.find((r) => r.dir === tmp)!;
  for (const k of TEMP_OLD_KEEP) assert.ok(parent.except?.includes(k), `${k} kept whole`);
  assert.ok(old.some((r) => r.dir === '/tmp'), 'the system temp folder is still looked at, as before');
});

test('w6000 (w5894 review N2): runner-tmp is a top folder `ff-leftovers remove` never removes whole', () => {
  assert.ok(REMOVE_TOP.has('runner-tmp'));
});

test('w6000: ops_worker machine_update daemon_tmpdir reaches the installer on every OS', () => {
  const last = (p: NodeJS.Platform, v: 'on' | 'off') => workerUpdateFlags(p, {}, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, v);
  assert.deepEqual(last('win32', 'off'), ['-DaemonTmpdir off']);
  assert.deepEqual(last('linux', 'off'), ['--daemon-tmpdir off']);
  assert.deepEqual(last('darwin', 'on'), ['--daemon-tmpdir on']);
});

/**
 * The census (w6000): every non-test file of machine/, server/ and shared/ that names the system temp folder
 * (os.tmpdir(), a mkdtemp, a '/tmp' literal), how many times, and why it may stay. The count is exact: a new use fails
 * until it is moved into the root or justified here, and a removed one fails until its count is lowered. With the daemon's
 * temp moved (machine/daemonTemp.ts), os.tmpdir() in daemon code is <root>/tmp/daemon, so "the daemon" below is inside ffw.
 */
const CENSUS: Record<string, [number, string]> = {
  'machine/daemonTemp.ts': [12, 'the move itself: reads os.tmpdir() to keep it in FF_SYSTEM_TMPDIR, and names it in comments and log lines'],
  'machine/benchQueue.ts': [1, 'a bench status file with no root (w5834): os.tmpdir(), the daemon\'s own <root>/tmp/daemon once moved'],
  'machine/daemon.ts': [2, 'a comment; the Git Bash /tmp kept from clean-up (reads)'],
  'machine/evidenceGate.ts': [2, 'fetchHudData\'s default folder: called from server/blockerWatch.ts on the portal VM (and the daemon\'s os.tmpdir() is in the root)'],
  'machine/sharedCaches.ts': [1, 'a comment: Unity\'s own fixed /tmp sockets (w5833, measured), which no TMPDIR moves'],
  'machine/unitySlots.ts': [1, 'unity-slot run --detach\'s log: the caller\'s TMPDIR or TEMP first (a worker\'s ffa-<session>), os.tmpdir() only as the last fallback'],
  'machine/writeLock.ts': [1, 'Linux write lock: /tmp create-only for Unity\'s fixed sockets (w5561), a fence rule, not a writer'],
  'server/agentTools.ts': [1, 'mkdtemp in <root>/tools-medium (inside the root)'],
  'server/cleanup.ts': [5, 'reads: the clean-up\'s rules for the system temp (as before) and the daemon\'s own; comments'],
  'server/gitBashTmp.ts': [1, 'asks cygpath where Git Bash maps /tmp (reads; w603 re-makes only the folder Git Bash itself uses)'],
  'server/guard.ts': [1, 'a comment of the guard\'s path rules'],
  'server/index.ts': [3, 'the portal\'s own local sessions\' temp folders: the portal VM only (deploy/vm), whose agents get TMPDIR=/tmp/ffa-<session> there'],
  'server/machineDeploy.ts': [2, 'the portal\'s deploy bundle staging (scpBundle): the portal VM only'],
  'server/machineSandboxesTestKit.ts': [2, 'test kit: the test run\'s TMPDIR (CI runners: <root>/runner-tmp, w5834)'],
  'server/orchestratorsTestKit.ts': [2, 'test kit: the test run\'s TMPDIR'],
  'server/ownLeftovers.ts': [1, 'a comment'],
  'server/rootFence.ts': [1, 'a comment of the guard\'s path rules'],
  'server/tempDelete.ts': [1, 'a comment of the guard\'s delete rules'],
  'server/testHistoryCi.ts': [2, 'the portal\'s test history download: its data folder, os.tmpdir() only when that is missing (portal VM)'],
  'server/testMachine.ts': [4, 'test kit: the test run\'s TMPDIR'],
  'server/testPorts.ts': [1, 'test kit: port lock files in the test run\'s TMPDIR'],
};

const SYSTEM_TEMP = /tmpdir\(\)|mkdtemp(Sync)?\(|['"`]\/tmp\b/g;

test('w6000 census: no place in machine/, server/ or shared/ names the system temp unless it is listed with why', () => {
  const repo = path.resolve(import.meta.dirname, '..');
  const found: Record<string, number> = {};
  for (const dir of ['machine', 'server', 'shared']) {
    for (const f of fs.readdirSync(path.join(repo, dir), { recursive: true }) as string[]) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const n = (fs.readFileSync(path.join(repo, dir, f), 'utf8').match(SYSTEM_TEMP) ?? []).length;
      if (n) found[`${dir}/${f.replace(/\\/g, '/')}`] = n;
    }
  }
  assert.deepEqual(found, Object.fromEntries(Object.entries(CENSUS).map(([f, [n]]) => [f, n])), 'a system temp use was added or removed: move it into the root, or list it in CENSUS with why it stays');
});

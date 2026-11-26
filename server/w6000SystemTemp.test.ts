import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DAEMON_TMPDIR_MAX, SYSTEM_TMPDIR_VAR, applyDaemonTmpdir, daemonTempDir, editorSystemTempEnv, systemTempDir } from '../machine/daemonTemp.ts';
import { editorLaunchEnv, sandboxEditorEnv } from '../machine/sandboxes.ts';
import { bareEnv } from '../machine/maxEventsFence.ts';
import { REMOVE_TOP } from '../machine/leftovers.ts';
import { DEFAULT_CLEANUP, cleanupRules, hostCleanupEnv, type CleanupEnv } from './cleanup.ts';
import { workerUpdateFlags } from './opsWorker.ts';
import { DAEMON_ONLY_CHILDREN, DAEMON_TMP_CHILD } from './claudeHome.ts';
import { WORKER_CHILDREN, openChildren } from '../machine/lowIntegrity.ts';
import { LOCKED_CHILDREN } from '../machine/writeLock.ts';
import { READ_DENIED_IN_ROOT, READ_ONLY_IN_ROOT } from './workerFence.ts';
import { daemonOnlyDirs, readFenceProbeTargets } from '../machine/readFence.ts';

// w6000 (lothsahn, w5823: "under no circumstances should workers write outside of ffw"; w5834 follow-up): the daemon's own
// temp folder moves inside the worker root, and every place left in machine/ and server/ that names the system temp is
// listed here with why it may stay.

const ROOT = path.resolve('/ffw');
/** The folder checks the real file system: tests pass their own. */
const ok = { mkdir: () => undefined, writable: () => undefined };

test('w6000: the daemon points TMPDIR, TEMP and TMP at <root>/tmp-daemon and keeps the system temp folder in FF_SYSTEM_TMPDIR', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/var/folders/xy/T', TEMP: 'C:\\Users\\p\\AppData\\Local\\Temp' };
    const made: string[] = [];
    const r = applyDaemonTmpdir(env, ROOT, undefined, { platform, mkdir: (p) => void made.push(p), writable: () => undefined, tmpdir: () => '/sys-tmp' });
    const dir = daemonTempDir(ROOT);
    assert.equal(r.dir, dir, platform);
    assert.deepEqual(made, [dir], 'made before it is named');
    for (const k of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(env[k], dir, `${platform} ${k}`);
    assert.equal(env[SYSTEM_TMPDIR_VAR], '/sys-tmp');
    assert.equal(systemTempDir(env), '/sys-tmp', 'what reads the system temp still finds it');
    assert.equal(dir, path.join(ROOT, 'tmp-daemon'), 'a root child of its own, not in the workers\' <root>/tmp (B1 of the #1345 review)');
  }
});

test('w6000: a daemon whose environment already names the system temp folder keeps that one', () => {
  const env: NodeJS.ProcessEnv = { [SYSTEM_TMPDIR_VAR]: '/tmp' };
  applyDaemonTmpdir(env, ROOT, 'on', { platform: 'linux', ...ok, tmpdir: () => daemonTempDir(ROOT) });
  assert.equal(env[SYSTEM_TMPDIR_VAR], '/tmp');
});

test('w6000 (lockout rule): off, no root, a folder that cannot be made or written, or a root too long only warn, and change nothing', () => {
  const cases: [string, Parameters<typeof applyDaemonTmpdir>][] = [
    ['off', [{}, ROOT, 'off', { platform: 'linux', ...ok, tmpdir: () => '/tmp' }]],
    ['no worker root', [{}, undefined, undefined, { platform: 'linux', ...ok, tmpdir: () => '/tmp' }]],
    ['could not make or write', [{}, ROOT, 'on', { platform: 'win32', ...ok, mkdir: () => { throw new Error('EACCES'); }, tmpdir: () => '/tmp' }]],
    ['EROFS', [{}, ROOT, 'on', { platform: 'linux', ...ok, writable: () => { throw new Error('EROFS'); }, tmpdir: () => '/tmp' }]],
    [`longer than ${DAEMON_TMPDIR_MAX}`, [{}, '/' + 'r'.repeat(DAEMON_TMPDIR_MAX), 'on', { platform: 'darwin', ...ok, tmpdir: () => '/tmp' }]],
  ];
  for (const [why, args] of cases) {
    const env = args[0];
    const r = applyDaemonTmpdir(...args);
    assert.equal(r.dir, undefined, why);
    assert.ok(r.line.includes(why), `${why}: ${r.line}`);
    assert.deepEqual(env, {}, `${why}: the environment is untouched`);
  }
  // Windows sockets are named pipes: a long root still moves there.
  assert.ok(applyDaemonTmpdir({}, 'C:\\' + 'r'.repeat(DAEMON_TMPDIR_MAX), 'on', { platform: 'win32', ...ok }).dir);
});

test('w6000 (N1 of the #1345 review): on the real file system the folder is made and checked writable', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || '.', 'w6000-'));
  try {
    const env: NodeJS.ProcessEnv = {};
    const r = applyDaemonTmpdir(env, root, undefined, { platform: 'win32', tmpdir: () => '/sys-tmp' });
    assert.equal(r.dir, path.join(root, DAEMON_TMP_CHILD));
    assert.ok(fs.statSync(r.dir!).isDirectory());
    assert.equal(env.TEMP, r.dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  const env = bareEnv({ SystemRoot: 'C:/Windows', TEMP: 'V:/ffw/tmp-daemon', TMP: 'V:/ffw/tmp-daemon', GH_TOKEN: 's' });
  assert.deepEqual(env, { SystemRoot: 'C:/Windows', TEMP: 'V:/ffw/tmp-daemon', TMP: 'V:/ffw/tmp-daemon' });
});

test('w6000: the clean-up ages the daemon\'s temp folder entry by entry whenever there is a root (N3 of the #1345 review)', () => {
  for (const agentTemp of [path.join(ROOT, 'tmp'), path.resolve('/elsewhere/tmp'), undefined]) {
    const host = hostCleanupEnv(agentTemp, ROOT);
    assert.equal(host.daemonTemp, daemonTempDir(ROOT), `agents' temp ${agentTemp}`);
    const env: CleanupEnv = { platform: 'linux', home: '/home/p', tmp: '/tmp', agentTemp, daemonTemp: host.daemonTemp };
    const old = cleanupRules(env, DEFAULT_CLEANUP).filter((r) => r.id === 'temp-old');
    assert.ok(old.some((r) => r.dir === daemonTempDir(ROOT)), 'its entries age out');
    assert.ok(old.some((r) => r.dir === '/tmp'), 'the system temp folder is still looked at, as before');
  }
  assert.equal(hostCleanupEnv(undefined).daemonTemp, undefined, 'no root: no daemon temp folder');
});

test('w6000 (B1 of the #1345 review): the daemon\'s temp folder is no worker folder on any OS, and closed to workers', () => {
  const dir = daemonTempDir(ROOT);
  const child = path.relative(ROOT, dir);
  assert.equal(child, DAEMON_TMP_CHILD, 'a root child of its own');
  assert.ok((DAEMON_ONLY_CHILDREN as readonly string[]).includes(child));
  assert.ok(!WORKER_CHILDREN.includes(child), 'Windows: never labelled Low');
  for (const c of [...WORKER_CHILDREN, ...openChildren(ROOT, [path.join(ROOT, 'tmp'), path.join(ROOT, 'sandboxes')])]) {
    const rel = path.relative(path.join(ROOT, c), dir);
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `not inside the worker folder ${c}`);
  }
  assert.ok(!openChildren(ROOT, [path.join(ROOT, 'tmp')]).includes(child), 'Linux and macOS: not opened to workers');
  assert.ok((LOCKED_CHILDREN as readonly string[]).includes(child), 'Linux: read-only under the write lock');
  assert.ok(READ_ONLY_IN_ROOT.subpaths.includes(child) && READ_DENIED_IN_ROOT.subpaths.includes(child), 'macOS: no writes and no reads');
  assert.ok(daemonOnlyDirs(ROOT).includes(dir), 'closed to reads, and made before the labels are set');
});

test('w6000: runner-tmp (w5894 review N2) and tmp-daemon are top folders `ff-leftovers remove` never removes whole', () => {
  assert.ok(REMOVE_TOP.has('runner-tmp'));
  assert.ok(REMOVE_TOP.has(DAEMON_TMP_CHILD));
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
 * temp moved (machine/daemonTemp.ts), os.tmpdir() in daemon code is <root>/tmp-daemon, so "the daemon" below is inside ffw.
 */
const CENSUS: Record<string, [number, string]> = {
  'machine/daemonTemp.ts': [16, 'the move itself: reads os.tmpdir() to keep it in FF_SYSTEM_TMPDIR, and names it in comments and log lines; defines systemTempDir, systemTempEnv and editorSystemTempEnv'],
  'machine/benchQueue.ts': [1, 'a bench status file with no root (w5834): os.tmpdir(), the daemon\'s own <root>/tmp-daemon once moved'],
  'machine/daemon.ts': [4, 'a comment; the Git Bash /tmp kept from clean-up (reads, with systemTempDir()); writer: agentTempRoot\'s no-temp_dir default, the system temp as before w6000 (an install always sets temp_dir to <root>/tmp, so only a hand-made daemon.json without it lands there)'],
  'machine/evidenceGate.ts': [2, 'fetchHudData\'s default folder: called from server/blockerWatch.ts on the portal VM (and the daemon\'s os.tmpdir() is in the root)'],
  'machine/sharedCaches.ts': [1, 'a comment: Unity\'s own fixed /tmp sockets (w5833, measured), which no TMPDIR moves'],
  'machine/unitySlots.ts': [1, 'unity-slot run --detach\'s log: the caller\'s TMPDIR or TEMP first (a worker\'s ffa-<session>), os.tmpdir() only as the last fallback'],
  'machine/writeLock.ts': [1, 'Linux write lock: /tmp create-only for Unity\'s fixed sockets (w5561), a fence rule, not a writer'],
  'server/agentTools.ts': [1, 'mkdtemp in <root>/tools-medium (inside the root)'],
  'server/cleanup.ts': [4, 'reads: the clean-up\'s rules for the system temp (as before, systemTempDir()) and the daemon\'s own; comments; writer: sessionTempEnv\'s last resort when an agent\'s ffa- folder cannot be made (systemTempEnv: the pre-w6000 behaviour, since the daemon-only tmp-daemon is closed to a fenced agent; agentTempEnv tries the shared root first and warns)'],
  'machine/sandboxes.ts': [2, 'writer: a sandbox editor on macOS or Linux while editorTmpdir is off, or whose own TMPDIR cannot be made (editorSystemTempEnv): the system temp it had before w6000, since editorTmpdir alone decides an editor\'s temp (w5833)'],
  'machine/timedRunner.ts': [1, 'writer: the timed-run player (systemTempEnv), as before w6000: a Low player on Windows and the fenced player elsewhere cannot write the daemon-only tmp-daemon; its saves and logs go to its own folders'],
  'server/reaper.ts': [1, 'reads: the browser reaper looks for the profiles browsers keep in the system temp (systemTempDir())'],
  'server/gitBashTmp.ts': [1, 'asks cygpath where Git Bash maps /tmp (reads; w603 re-makes only the folder Git Bash itself uses)'],
  'server/guard.ts': [1, 'a comment of the guard\'s path rules'],
  'server/index.ts': [3, 'the portal\'s own local sessions\' temp folders: the portal VM only (deploy/vm), whose agents get TMPDIR=/tmp/ffa-<session> there'],
  'server/machineDeploy.ts': [2, 'the portal\'s deploy bundle staging (scpBundle): the portal VM only'],
  'server/machineSandboxesTestKit.ts': [2, 'test kit: the test run\'s TMPDIR (CI runners: <root>/runner-tmp, w5834)'],
  'server/orchestratorsTestKit.ts': [2, 'test kit: the test run\'s TMPDIR'],
  'server/ownLeftovers.ts': [1, 'a comment'],
  'server/rootFence.ts': [1, 'a comment of the guard\'s path rules'],
  'server/tempDelete.ts': [1, 'a comment of the guard\'s delete rules'],
  'server/tmpWriteFence.ts': [1, 'the warn-only /tmp write fence (w6008) names the system temp folders it warns on'],
  'server/testHistoryCi.ts': [2, 'the portal\'s test history download: its data folder, os.tmpdir() only when that is missing (portal VM)'],
  'server/testMachine.ts': [4, 'test kit: the test run\'s TMPDIR'],
  'server/testPorts.ts': [1, 'test kit: port lock files in the test run\'s TMPDIR'],
  'server/tmpWriteFence.ts': [1, 'a comment of the /tmp write fence\'s argument parsing (w6008)'],
};

/**
 * What names the system temp: os.tmpdir(), mkdtemp, a '/tmp' literal, and the helpers that hand the system temp folder on
 * once the daemon moved its own (systemTempDir, systemTempEnv, editorSystemTempEnv: w6024 review, point 2), so each
 * process given the system temp back is listed here with why.
 */
const SYSTEM_TEMP = /tmpdir\(\)|mkdtemp(Sync)?\(|['"`]\/tmp\b|\b(systemTempDir|systemTempEnv|editorSystemTempEnv)\(/g;

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

test('w6000: a fenced process with no temp folder of its own gets the system temp named outright, not the daemon-only one', async () => {
  const { systemTempEnv } = await import('../machine/daemonTemp.ts');
  const { sessionTempEnv } = await import('./cleanup.ts');
  assert.deepEqual(systemTempEnv({ [SYSTEM_TMPDIR_VAR]: '/tmp' }), { TMPDIR: '/tmp', TEMP: '/tmp', TMP: '/tmp' });
  assert.deepEqual(systemTempEnv({}), {}, 'the daemon did not move its temp: inherited is the system temp already');
  // An agent whose ffa-<session> folder cannot be made (here: its root is a file).
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || '.', 'w6000-'));
  const was = process.env[SYSTEM_TMPDIR_VAR];
  process.env[SYSTEM_TMPDIR_VAR] = '/sys-tmp';
  try {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, '');
    assert.deepEqual(sessionTempEnv(file, 'abcdef12'), { TMPDIR: '/sys-tmp', TEMP: '/sys-tmp', TMP: '/sys-tmp' });
  } finally {
    if (was === undefined) delete process.env[SYSTEM_TMPDIR_VAR];
    else process.env[SYSTEM_TMPDIR_VAR] = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w6000 (w6024 review, point 3): the Linux read-fence probe leaves the daemon\'s own temp files out; elsewhere it probes the folder', () => {
  const r = fs.mkdtempSync(path.join(process.env.TMPDIR || process.env.TEMP || '.', 'w6000-probe-'));
  try {
    fs.mkdirSync(path.join(r, 'daemon', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(r, DAEMON_TMP_CHILD));
    fs.writeFileSync(path.join(r, DAEMON_TMP_CHILD, 'short-lived'), '');
    const o = { root: r, appDir: path.join(r, 'daemon'), secrets: [], allowBack: ['logs'] };
    // A relative root too (the '.' fallback where the run has no TMPDIR or TEMP, as on CI's Linux runners).
    const dt = path.join(path.resolve(r), DAEMON_TMP_CHILD);
    const linux = readFenceProbeTargets({ ...o, linux: true }).closed;
    assert.ok(!linux.some((x) => x === dt || x.startsWith(dt + path.sep)), `Linux: a file gone by the open would turn the read rules off (${JSON.stringify(linux)})`);
    assert.ok(readFenceProbeTargets({ ...o, linux: false }).closed.includes(dt), 'Windows and macOS: the folder itself');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

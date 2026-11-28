// w6599: the worker read log (machine/readLog.ts, machine/winReadLog.cs). The fake-helper tests run everywhere; the last one runs
// the real ETW helper on Windows (.github/windows-tests.txt): a GitHub runner is an administrator, as the daemon's account is a
// member of Administrators or Performance Log Users.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { READ_LOG_LINES_A_DAY, READ_LOG_SESSION, ReadLog, folderOf, readAllowWin, readLogModeOf } from '../machine/readLog.ts';
import { csHelper } from '../machine/workerCaps.ts';

const ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' };

test('w6599: readLog is warn unless daemon.json says off', () => {
  assert.equal(readLogModeOf(undefined), 'warn');
  assert.equal(readLogModeOf('warn'), 'warn');
  assert.equal(readLogModeOf('on'), 'warn');
  assert.equal(readLogModeOf('off'), 'off');
});

test('w6599: every allowlist entry has its reason; profiles and Public are not on it; drive roots and the folders above the root are exact', () => {
  const a = readAllowWin(ENV, 'F:\\ffw\\work');
  for (const e of a) assert.ok(e.why.length > 20, `${e.path} has a reason`);
  assert.deepEqual(a.filter((e) => !e.exact).map((e) => e.path), ['F:\\ffw\\work', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']);
  assert.deepEqual(a.filter((e) => e.exact).map((e) => e.path).sort(), ['C:\\', 'F:\\', 'F:\\ffw']);
  assert.ok(!a.some((e) => /users/i.test(e.path)));
});

test('w6599: a log line groups by a path\'s first three parts', () => {
  assert.equal(folderOf('C:\\Users\\rydin\\.ssh\\id_ed25519'), 'C:\\Users\\rydin');
  assert.equal(folderOf('C:\\Users'), 'C:\\Users');
  assert.equal(folderOf('\\\\server\\share\\a\\b'), '\\\\server\\share\\a');
});

function fakeHelper() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(child, { stdin, stdout });
  const sent: string[] = [];
  stdin.on('data', (b: Buffer) => sent.push(...b.toString().split('\n').filter(Boolean)));
  const say = (o: object) => stdout.write(`${JSON.stringify(o)}\n`);
  return { child, sent, say };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test('w6599: the daemon sends the allowlist and the live hosts, writes each read to the day\'s file and flags it once a day per worker and folder', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readlog-'));
  const f = fakeHelper();
  const lines: string[] = [];
  let hosts: { session: string; pid: number; startedAt?: number; sandbox: string }[] = [{ session: 'sess-1', pid: 100, startedAt: 1000, sandbox: 'agent5' }, { session: 'no-record', pid: 70, sandbox: 'x' }];
  const started: string[][] = [];
  const r = new ReadLog({
    appDir, root: 'F:\\ffw', mode: 'warn', platform: 'win32', env: ENV, hosts: () => hosts, log: (l) => lines.push(l),
    now: () => new Date('2026-11-27T12:00:00Z'), helper: () => 'ffreadlog.exe',
    start: (exe, args) => (started.push([exe, ...args]), f.child),
  });
  assert.equal(r.enabled, true);
  r.start();
  await flush();
  assert.deepEqual(started, [['ffreadlog.exe', READ_LOG_SESSION]]);
  assert.ok(f.sent.includes('work F:\\ffw'), 'the work folder, for telling a worker\'s orphaned Low process from a person\'s app (w6715)');
  assert.ok(f.sent.includes('allow F:\\ffw') &&f.sent.includes('exact C:\\') && f.sent.includes('allow C:\\ProgramData'));
  assert.equal(f.sent.at(-1), 'roots 100:1000', 'each host with the start time its record gives; one with no start time is not sent (w6728)');
  r.tick();
  await flush();
  assert.equal(f.sent.filter((l) => l.startsWith('roots')).length, 1, 'unchanged hosts are not sent again');
  hosts = [...hosts, { session: 'sess-2', pid: 50, startedAt: 2000, sandbox: 'slot1' }];
  r.tick();
  await flush();
  assert.equal(f.sent.at(-1), 'roots 100:1000 50:2000');

  f.say({ event: 'ready' });
  f.say({ event: 'read', root: 100, rootAt: 1000, pid: 101, image: 'F:\\ffw\\tools\\git\\usr\\bin\\cat.exe', path: 'C:\\Users\\rydin\\.ssh\\config' });
  f.say({ event: 'read', root: 100, rootAt: 1000, pid: 101, image: 'F:\\ffw\\tools\\git\\usr\\bin\\cat.exe', path: 'C:\\Users\\rydin\\.ssh\\known_hosts' });
  f.say({ event: 'read', root: 50, rootAt: 2000, pid: 51, image: 'C:\\x\\node.exe', path: 'C:\\Users\\Public\\a.txt' });
  // a read whose host pid came back with another start time names no session (a reused pid, w6728)
  f.say({ event: 'read', root: 100, rootAt: 9999, pid: 102, image: 'C:\\x\\a.exe', path: 'D:\\other\\x.txt' });
  f.say({ event: 'root-refused', root: '70', why: 'its process started at another time than its host' });
  f.say({ event: 'stat', fileEvents: 900, procEvents: 4, tracked: 3, reported: 3, dropped: 0, lost: 0 });
  await flush();
  assert.ok(lines.some((l) => l.startsWith('read log: running')));
  const flagged = lines.filter((l) => l.includes(' read C:\\'));
  assert.ok(lines.some((l) => l.startsWith('read log: agent host 100: a.exe read D:\\other\\x.txt')), 'a reused host pid is not named as the old session');
  assert.ok(lines.includes('read log: agent host 70 not followed: its process started at another time than its host'));
  assert.equal(flagged.length, 2, 'the second read in C:\\Users\\rydin by sess-1 is in the file, not flagged again');
  assert.match(flagged[0]!, /^read log: sess-1 \(agent5\): cat\.exe read C:\\Users\\rydin\\\.ssh\\config, outside the work folder and not on the allowlist \(warn only: nothing was refused\)$/);
  assert.match(flagged[1]!, /^read log: sess-2 \(slot1\): node\.exe read C:\\Users\\Public\\a\.txt/);
  assert.ok(lines.some((l) => l.startsWith('read log: its first minute saw 900 file opens')));
  const file = fs.readFileSync(path.join(appDir, 'logs', 'read-log-2026-11-27.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(file.length, 4);
  assert.deepEqual(Object.keys(file[0]).sort(), ['image', 'path', 'pid', 'sandbox', 'session', 't'], 'paths and the reading process only');
  r.stop();
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('w6599: a helper that cannot start is logged and tried again later; off and other platforms start nothing', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readlog-'));
  const lines: string[] = [];
  const f = fakeHelper();
  const r = new ReadLog({ appDir, root: 'F:\\ffw', mode: 'warn', platform: 'win32', env: ENV, hosts: () => [], log: (l) => lines.push(l), helper: () => 'x.exe', start: () => f.child });
  r.start();
  f.say({ event: 'error', why: 'StartTrace failed: access denied (5)' });
  await flush();
  f.child.emit('exit', 1);
  assert.ok(lines.some((l) => l === 'read log: off for now, StartTrace failed: access denied (5); tried again in an hour (warn only: nothing is refused either way)'), lines.join('\n'));
  r.stop();

  let spawned = 0;
  for (const o of [{ mode: 'off' as const, platform: 'win32' as const }, { mode: 'warn' as const, platform: 'linux' as const }]) {
    const q = new ReadLog({ appDir, root: 'F:\\ffw', ...o, env: ENV, hosts: () => [], log: () => undefined, helper: () => undefined, start: () => (spawned++, f.child) });
    assert.equal(q.enabled, false);
    q.start();
  }
  assert.equal(spawned, 0);
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('w6599: read-log files older than 14 days go at start', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readlog-'));
  const logs = path.join(appDir, 'logs');
  fs.mkdirSync(logs);
  for (const n of ['read-log-2026-11-01.jsonl', 'read-log-2026-11-20.jsonl', 'daemon.log']) fs.writeFileSync(path.join(logs, n), '');
  new ReadLog({ appDir, root: 'F:\\ffw', mode: 'off', platform: 'win32', hosts: () => [], log: () => undefined, now: () => new Date('2026-11-27T00:00:00Z'), helper: () => undefined }).start();
  assert.deepEqual(fs.readdirSync(logs).sort(), ['daemon.log', 'read-log-2026-11-20.jsonl']);
  fs.rmSync(appDir, { recursive: true, force: true });
});

// The real helper: a root process (standing in for an agent host) starts a child that reads a file outside the allowed folders;
// the log names that file and the child's program. A file the root itself opens, and one in an allowed folder, are not reported.
test('w6728 N3: past the day\'s lines only the count grows, not the set of flagged folders', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readlog-'));
  const f = fakeHelper();
  const lines: string[] = [];
  let now = new Date('2026-11-27T12:00:00Z');
  const r = new ReadLog({ appDir, root: 'F:\\ffw', mode: 'warn', platform: 'win32', env: ENV, hosts: () => [{ session: 's', pid: 100, startedAt: 1 }], log: (l) => lines.push(l), now: () => now, helper: () => 'x.exe', start: () => f.child });
  r.start();
  for (let i = 0; i < READ_LOG_LINES_A_DAY + 50; i++) f.say({ event: 'read', root: 100, rootAt: 1, pid: 101, image: 'C:\\x\\a.exe', path: `C:\\Users\\u${i}\\f.txt` });
  await flush();
  assert.equal(lines.filter((l) => l.includes(' read C:\\')).length, READ_LOG_LINES_A_DAY);
  assert.equal((r as unknown as { flagged: Set<string> }).flagged.size, READ_LOG_LINES_A_DAY, 'the set stops at the cap');
  now = new Date('2026-11-28T00:00:01Z');
  f.say({ event: 'read', root: 100, rootAt: 1, pid: 101, image: 'C:\\x\\a.exe', path: 'C:\\Users\\next\\f.txt' });
  await flush();
  assert.ok(lines.some((l) => l.startsWith('read log: 50 more reads outside the work folder on 2026-11-27')), lines.slice(-3).join('\\n'));
  r.stop();
  fs.rmSync(appDir, { recursive: true, force: true });
});

test('w6728: the helper\'s pid rules, against a made-up process table (Windows: --selftest, no ETW session, any account)', { skip: process.platform !== 'win32' }, (t) => {
  // a lost stop event and the pid given to a person's process, a reused parent pid, an orphan older than its named parent, a
  // root whose process is not its host's, a dead host's reused pid, the Low-process cache keyed by creation time
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'readlog-st-'));
  try {
    const exe = csHelper(appDir, path.join(import.meta.dirname, '..', 'machine', 'winReadLog.cs'), 'ffreadlog', 'read log selftest', (l) => t.diagnostic(l));
    assert.ok(exe, 'the helper builds with Add-Type');
    const r = spawnSync(exe, ['--selftest'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /selftest: \d+ passed, 0 failed/);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('w6599: the real ETW helper reports a file a host\'s child opens outside the allowlist (Windows)', { skip: process.platform !== 'win32' }, async (t) => {
  // the long name: a runner's TEMP is an 8.3 one (RUNNER~1), and ETW gives the path as it is on disk
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'readlog-real-')));
  const appDir = path.join(tmp, 'app');
  const root = path.join(tmp, 'root');
  fs.mkdirSync(root, { recursive: true });
  const outside = path.join(tmp, 'outside-secret.txt');
  const inside = path.join(root, 'inside.txt');
  fs.writeFileSync(outside, 'x');
  fs.writeFileSync(inside, 'x');
  const exe = csHelper(appDir, path.join(import.meta.dirname, '..', 'machine', 'winReadLog.cs'), 'ffreadlog', 'read log test', (l) => t.diagnostic(l));
  assert.ok(exe, 'the helper builds with Add-Type');
  // the root waits for "go", then has cmd read both files
  const hostAt = Date.now();
  const host = spawn(process.execPath, ['-e', `process.stdin.once('data', () => { const r = require('child_process').spawnSync('cmd.exe', ['/d', '/c', 'type', ${JSON.stringify(outside)}, '&', 'type', ${JSON.stringify(inside)}], { stdio: 'ignore' }); process.exit(r.status ?? 1); });`], { stdio: ['pipe', 'ignore', 'ignore'] });
  const lines: string[] = [];
  const r = new ReadLog({ appDir, root, mode: 'warn', platform: 'win32', hosts: () => [{ session: 'test-session', pid: host.pid!, startedAt: hostAt }], log: (l) => (lines.push(l), t.diagnostic(l)), helper: () => exe });
  try {
    r.start();
    const until = async (ok: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await new Promise((res) => setTimeout(res, 250));
      return ok();
    };
    await until(() => lines.some((l) => l.startsWith('read log: running') || l.startsWith('read log: off')), 30_000);
    const denied = lines.find((l) => l.includes('access denied'));
    if (denied && !process.env.CI) return t.skip('this account may not start an ETW session (not an administrator here)');
    assert.ok(lines.some((l) => l.startsWith('read log: running')), lines.join('\n'));
    // ETW delivers a real-time session's events within its flush timer (1 s); the roots were sent at launch
    await new Promise((res) => setTimeout(res, 2000));
    host.stdin!.write('go\n');
    const seen = await until(() => lines.some((l) => l.includes(outside)), 20_000);
    assert.ok(seen, `the outside read is flagged:\n${lines.join('\n')}`);
    const line = lines.find((l) => l.includes(outside))!;
    assert.match(line, /^read log: test-session: cmd\.exe read /i);
    const file = fs.readdirSync(path.join(appDir, 'logs')).find((n) => n.startsWith('read-log-'))!;
    const rows = fs.readFileSync(path.join(appDir, 'logs', file), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { path: string });
    assert.ok(!rows.some((x) => x.path.toLowerCase() === inside.toLowerCase()), 'a file under the root is not reported');
  } finally {
    r.stop();
    host.kill();
    await new Promise((res) => setTimeout(res, 1500));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

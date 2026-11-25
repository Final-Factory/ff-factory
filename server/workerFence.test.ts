import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOptions, type LaunchSpec } from './launch.ts';
import { SANDBOX_EXEC, fenceEnv, fenceFor, fencedArgv, seatbeltProfile, type WorkerFence } from './workerFence.ts';

const F: WorkerFence = { kind: 'seatbelt', root: '/Users/p/ffw', home: '/Users/p', darwinTemp: '/private/var/folders/xx/T', darwinCache: '/private/var/folders/xx/C' };

test('fenceFor: off unless the setting is "seatbelt" on a Mac with a root and sandbox-exec', () => {
  const base = { setting: 'seatbelt', root: '/r', platform: 'darwin' as const, home: '/h', exists: () => true, getconf: (n: string) => `/t/${n}` };
  assert.equal(fenceFor({ ...base, setting: undefined }), undefined);
  assert.equal(fenceFor({ ...base, setting: 'other' }), undefined);
  assert.equal(fenceFor({ ...base, platform: 'linux' }), undefined);
  assert.equal(fenceFor({ ...base, platform: 'win32' }), undefined);
  assert.equal(fenceFor({ ...base, root: undefined }), undefined);
  assert.equal(fenceFor({ ...base, exists: () => false }), undefined);
  const f = fenceFor(base);
  assert.equal(f?.kind, 'seatbelt');
  assert.equal(f?.darwinTemp, '/t/DARWIN_USER_TEMP_DIR');
});

test('the profile refuses every write, then allows the root, then takes the daemon, main clone and secrets back', () => {
  const p = seatbeltProfile(F);
  const at = (s: string) => {
    const i = p.indexOf(s);
    assert.ok(i >= 0, `missing: ${s}`);
    return i;
  };
  assert.ok(at('(allow default)') < at('(deny file-write*)'));
  assert.ok(at('(deny file-write*)') < at('(allow file-write* (subpath "/Users/p/ffw"))'));
  const back = p.lastIndexOf('(deny file-write*');
  assert.ok(back > at('(allow file-write* (subpath "/Users/p/ffw"))'), 'the read-only denies come after the root allow (later rules win)');
  assert.ok(!p.includes('/Users/p/ffw/repo"'), 'the main clone stays writable: worktree git writes its index and objects there');
  for (const s of ['(subpath "/Users/p/ffw/daemon")', '(subpath "/Users/p/ffw/secrets")', '(literal "/Users/p/ffw/root.json")']) assert.ok(at(s) > back, s);
  // No blanket home or /tmp allowance: only named paths in them.
  assert.ok(!p.includes('(subpath "/Users/p")'));
  assert.ok(!p.includes('(subpath "/private/tmp")'));
  assert.ok(!p.includes('(subpath "/tmp")'));
  assert.ok(p.includes('(subpath "/Users/p/.ff-factory/unity-slots")'));
});

test('a path with a quote or backslash cannot break out of its SBPL string', () => {
  const p = seatbeltProfile({ ...F, root: '/Users/p/f"f\\w', extraWritable: ['/x") (allow file-write* (subpath "/']});
  assert.ok(p.includes('(subpath "/Users/p/f\\"f\\\\w")'));
  assert.ok(!p.includes('(subpath "/")'));
});

test('fencedArgv runs the command under sandbox-exec with the profile inline; fenceEnv moves Claude Code temp into the root', () => {
  const a = fencedArgv(F, '/bin/claude', ['--x']);
  assert.deepEqual([a[0], a[1], a[3], a[4]], [SANDBOX_EXEC, '-p', '/bin/claude', '--x']);
  assert.equal(a[2], seatbeltProfile(F));
  assert.deepEqual(fenceEnv(F), { CLAUDE_CODE_TMPDIR: '/Users/p/ffw/tmp/claude-code', DISABLE_AUTOUPDATER: '1', TMPPREFIX: '/Users/p/ffw/tmp/zsh' });
});

test('buildOptions sets spawnClaudeCodeProcess only for a fenced spec', () => {
  const spec = { cwd: '.', settingSources: [], append: '', strictMcp: true, guard: { id: 'slotX', ownPath: '.', protectedPaths: [] } } as unknown as LaunchSpec;
  assert.equal(buildOptions(spec, {}, {}).spawnClaudeCodeProcess, undefined);
  assert.equal(typeof buildOptions({ ...spec, fence: F }, {}, {}).spawnClaudeCodeProcess, 'function');
});

// The kernel's own verdict, on a Mac only (CI runs on Linux).
// Inside a fenced worker a second sandbox is refused ("sandbox_apply: Operation not permitted", exit 71, m5, w5397).
const mac = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);
const nested = mac && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status !== 0;
test('live: a fenced shell writes in the root and is refused outside it and in the read-only folders', { skip: (!mac && 'needs macOS sandbox-exec') || (nested && 'already inside a sandbox (a fenced worker): sandbox-exec cannot nest') }, () => {
  const tmp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tmp, 'fence-root-'));
  const outside = fs.mkdtempSync(path.join(tmp, 'fence-out-'));
  fs.mkdirSync(path.join(root, 'daemon'));
  try {
    // The test's own temp sits in the Darwin temp folder, which the fence allows: give it none so `outside` is outside.
    const f: WorkerFence = { kind: 'seatbelt', root, home: fs.realpathSync(os.homedir()), darwinTemp: path.join(root, 'no-darwin-temp'), darwinCache: path.join(root, 'no-darwin-cache') };
    const sh = (cmd: string) => {
      const [c, ...a] = fencedArgv(f, '/bin/sh', ['-c', cmd]);
      return spawnSync(c, a, { encoding: 'utf8' });
    };
    assert.equal(sh(`echo ok > "${root}/in"`).status, 0);
    const out = sh(`echo no > "${outside}/out"`);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /Operation not permitted/);
    assert.ok(!fs.existsSync(path.join(outside, 'out')));
    assert.notEqual(sh(`echo no > "${root}/daemon/x"`).status, 0);
    assert.notEqual(sh(`ln -s "${outside}" "${root}/l" && echo no > "${root}/l/x"`).status, 0, 'a symlink out of the root is still outside');
    assert.ok(!fs.existsSync(path.join(outside, 'x')));
    assert.equal(sh(`cat "${root}/in" > /dev/null`).status, 0, 'reads are unchanged');
    // A sandbox is a worktree of <root>/repo, whose git data lives in the main clone: a fenced commit must work.
    const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' });
    git(root, 'init', '-q', '-b', 'master', 'repo');
    git(path.join(root, 'repo'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(path.join(root, 'repo'), 'worktree', 'add', '-q', path.join(root, 'sandboxes', 's1'), '-b', 's1');
    const c = sh(`cd "${root}/sandboxes/s1" && echo x > f && git add f && git -c user.name=t -c user.email=t@t commit -q -m t`);
    assert.equal(c.status, 0, `a commit in a sandbox worktree: ${c.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('w5562: the profile refuses signals except to the fence\'s own processes, after the file rules', () => {
  const p = seatbeltProfile(F);
  const deny = p.indexOf('(deny signal)');
  const allow = p.indexOf('(allow signal (target self) (target children) (target same-sandbox))');
  assert.ok(deny > 0 && allow > deny, 'the own-process allow comes after the deny (later rules win)');
  assert.ok(!/\(allow signal\)|target others/.test(p), 'no blanket signal allow');
});

// What a fenced shell may signal (w5562). `outside` is a process the test starts itself, outside the fence: it stands
// for the daemon, Unity and the owner's apps, which a probe never signals.
test('live w5562: a fenced shell signals and kills its own children (job control too) and is refused every other process and launchd jobs', { skip: (!mac && 'needs macOS sandbox-exec') || (nested && 'already inside a sandbox (a fenced worker): sandbox-exec cannot nest') }, () => {
  const tmp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tmp, 'fence-sig-'));
  const outside = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
  const twin = spawn(SANDBOX_EXEC, ['-p', seatbeltProfile({ kind: 'seatbelt', root, home: fs.realpathSync(os.homedir()), darwinTemp: root, darwinCache: root }), '/bin/sleep', '120'], { stdio: 'ignore' });
  try {
    const f: WorkerFence = { kind: 'seatbelt', root, home: fs.realpathSync(os.homedir()), darwinTemp: root, darwinCache: root };
    const sh = (cmd: string) => {
      const [c, ...a] = fencedArgv(f, '/bin/bash', ['-c', cmd]);
      return spawnSync(c, a, { encoding: 'utf8', timeout: 30_000 });
    };
    const own = sh(['set -e', 'kill -0 $$', 'sleep 60 & c=$!', 'kill -0 $c; kill -TERM $c; r=0; wait $c || r=$?; [ "$r" = 143 ]', 'set -m; sleep 60 & kill %1; wait %1 || true', `"${process.execPath}" -e "const c=require('child_process').spawn('sleep',['60']);setTimeout(()=>c.kill('SIGKILL'),200);c.on('exit',(x,s)=>process.exit(s==='SIGKILL'?0:1))"`].join('\n'));
    assert.equal(own.status, 0, `own children: ${own.stderr}`);
    const other = sh(`kill -0 ${outside.pid} 2>&1; echo rc=$?; kill -TERM ${outside.pid} 2>&1; echo rc=$?`);
    assert.match(other.stdout, /rc=1[\s\S]*rc=1/, `signals outside the fence: ${other.stdout}`);
    assert.equal(outside.exitCode, null, 'the outside process still runs');
    const tw = sh(`kill -0 ${twin.pid} 2>&1; echo rc=$?`);
    assert.match(tw.stdout, /rc=1/, `another fence with the same profile (another worker) is not this one: ${tw.stdout}`);
    const job = sh(`launchctl submit -l ff.w5562.test.$$ -- /usr/bin/touch "${root}/launchd-ran"; echo rc=$?; sleep 3`);
    assert.ok(!fs.existsSync(path.join(root, 'launchd-ran')), `launchctl submit ran a job outside the fence: ${job.stdout}`);
  } finally {
    outside.kill('SIGKILL');
    twin.kill('SIGKILL');
    spawnSync('/bin/launchctl', ['list'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes('ff.w5562.test.')).forEach((l) => spawnSync('/bin/launchctl', ['remove', l.split('\t')[2]]));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

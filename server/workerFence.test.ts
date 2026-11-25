import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('w5546: the profile closes the daemon folder, secrets and root.json to reads, then gives back what workers read there', () => {
  const p = seatbeltProfile({ ...F, appDir: '/Users/p/ffw/daemon', readAllowed: ['/Users/p/ffw/daemon/gh-app/sessions/s1.json'] });
  const deny = p.indexOf('(deny file-read-data');
  const allow = p.indexOf('(allow file-read-data');
  assert.ok(deny > 0 && allow > deny, 'the read allow comes after the read deny (later rules win)');
  const denied = p.slice(deny, allow);
  for (const s of ['(subpath "/Users/p/ffw/daemon")', '(subpath "/Users/p/ffw/secrets")', '(literal "/Users/p/ffw/root.json")']) assert.ok(denied.includes(s), s);
  const back = p.slice(allow);
  for (const s of ['(subpath "/Users/p/ffw/daemon/logs")', '(subpath "/Users/p/ffw/daemon/src")', '(subpath "/Users/p/ffw/daemon/gh-app/bin")', '(subpath "/Users/p/ffw/daemon/unity-mcp")', '(literal "/Users/p/ffw/daemon/sandboxes.json")', '(literal "/Users/p/ffw/daemon/gh-app/sessions/s1.json")'])
    assert.ok(back.includes(s), s);
  for (const s of ['tokens.json', 'daemon.json', '"/Users/p/ffw/daemon/hosts', 'root.json', 'root-backup.json', 'secrets']) assert.ok(!back.includes(s), `never given back: ${s}`);
  // Only file contents: stat and realpath of the closed paths still work (file-read-metadata is not denied).
  assert.ok(!p.includes('(deny file-read*'));
  // A daemon folder outside the root is closed to reads and writes too.
  const out = seatbeltProfile({ ...F, appDir: '/Users/p/.ff-factory' });
  assert.ok(out.slice(out.indexOf('(deny file-read-data'), out.indexOf('(allow file-read-data')).includes('(subpath "/Users/p/.ff-factory")'));
  assert.ok(out.includes('(allow file-read-data\n  (literal "/Users/p/.ff-factory")') || out.includes('(literal "/Users/p/.ff-factory")'));
});

test('live w5546: a fenced shell cannot read secrets, root.json or a closed daemon file, and reads the given-back ones', { skip: (!mac && 'needs macOS sandbox-exec') || (nested && 'already inside a sandbox (a fenced worker): sandbox-exec cannot nest') }, () => {
  const tmp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tmp, 'fence-read-'));
  try {
    const d = path.join(root, 'daemon');
    for (const x of ['secrets', 'daemon/logs', 'daemon/gh-app/sessions']) fs.mkdirSync(path.join(root, x), { recursive: true });
    for (const x of ['secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json', 'daemon/logs/daemon.log', 'daemon/gh-app/sessions/s1.json', 'daemon/gh-app/sessions/s2.json', 'daemon/sandboxes.json']) fs.writeFileSync(path.join(root, x), 'x');
    const f: WorkerFence = { kind: 'seatbelt', root, home: fs.realpathSync(os.homedir()), darwinTemp: path.join(root, 'no-t'), darwinCache: path.join(root, 'no-c'), appDir: d, readAllowed: [path.join(d, 'gh-app/sessions/s1.json')] };
    const reads = (rel: string) => {
      const [c, ...a] = fencedArgv(f, '/bin/sh', ['-c', `cat "${path.join(root, rel)}" > /dev/null`]);
      return spawnSync(c, a, { encoding: 'utf8' }).status === 0;
    };
    for (const rel of ['secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json', 'daemon/gh-app/sessions/s2.json']) assert.equal(reads(rel), false, `refused: ${rel}`);
    for (const rel of ['daemon/logs/daemon.log', 'daemon/sandboxes.json', 'daemon/gh-app/sessions/s1.json']) assert.equal(reads(rel), true, `read: ${rel}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

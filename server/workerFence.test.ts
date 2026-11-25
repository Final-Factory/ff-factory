import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOptions, type LaunchSpec } from './launch.ts';
import { SANDBOX_EXEC, fenceEnv, fenceFor, fencedArgv, ownTranscriptOf, seatbeltProfile, sessionIdOf, type WorkerFence } from './workerFence.ts';
import { projectSlug } from './claudeHome.ts';

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

test('w5563: sessionIdOf reads the conversation a claude argv runs', () => {
  assert.equal(sessionIdOf(['--output-format', 'stream-json', '--resume', 'abcdef12-3456']), 'abcdef12-3456');
  assert.equal(sessionIdOf(['--session-id', '4476260e-3192-4e62-b3ac-23e3de4f85e4', '--verbose']), '4476260e-3192-4e62-b3ac-23e3de4f85e4');
  assert.equal(sessionIdOf(['--resume=abcdef12-3456']), 'abcdef12-3456');
  assert.equal(sessionIdOf(['--resume', '../../x"y']), undefined, 'no id that is not a file name (nor a regex)');
  assert.equal(sessionIdOf(['--verbose']), undefined);
});

test("w5563: the profile takes the Claude home's transcripts back after the root, but this conversation's own, and before the read-only folders", () => {
  const sid = '4476260e-3192-4e62-b3ac-23e3de4f85e4';
  const p = seatbeltProfile(F, { projects: '/Users/p/ffw/claude/projects', sid });
  const at = (s: string) => {
    const i = p.indexOf(s);
    assert.ok(i >= 0, `missing: ${s}`);
    return i;
  };
  const root = at('(allow file-write* (subpath "/Users/p/ffw"))');
  const deny = at('(deny file-write* (subpath "/Users/p/ffw/claude/projects"))');
  const own = at(`(allow file-write* (regex #"^/Users/p/ffw/claude/projects/[^/]+/${sid}\\.jsonl$") (regex #"^/Users/p/ffw/claude/projects/[^/]+/${sid}(/|$)"))`);
  assert.ok(root < deny && deny < own && own < at('(subpath "/Users/p/ffw/daemon")'), 'later rules win');
  assert.ok(!seatbeltProfile(F).includes('claude/projects'), 'no conversation named: no transcript rule');
  // regex characters in the path are escaped
  assert.ok(seatbeltProfile(F, { projects: '/Users/p.q/ffw/claude/projects', sid }).includes('^/Users/p\\.q/ffw/claude/projects/'));
});

test("w5563: ownTranscriptOf names the conversation in a Claude home inside the root, and makes the cwd's project folder first", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-own-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f: WorkerFence = { ...F, root };
  const cwd = path.join(root, 'sandboxes', 's1');
  const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const own = ownTranscriptOf(f, { args: ['--session-id', 'abcdef12-3456'], cwd, env });
  assert.deepEqual(own, { projects: path.join(root, 'claude', 'projects'), sid: 'abcdef12-3456' });
  assert.ok(fs.statSync(path.join(root, 'claude', 'projects', projectSlug(cwd))).isDirectory());
  assert.equal(ownTranscriptOf(f, { args: ['--session-id', 'abcdef12-3456'], cwd, env: { CLAUDE_CONFIG_DIR: '/elsewhere/claude' } }), undefined, 'a home outside the root is refused whole already');
  assert.equal(ownTranscriptOf(f, { args: [], cwd, env }), undefined);
});

test("live w5563: a fenced process writes its own conversation's transcript and folder, and no other's", { skip: (!mac && 'needs macOS sandbox-exec') || (nested && 'already inside a sandbox (a fenced worker): sandbox-exec cannot nest') }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fence-tx-')));
  try {
    const sid = '11111111-2222-4333-8444-555555555555';
    const other = '99999999-2222-4333-8444-555555555555';
    const f: WorkerFence = { kind: 'seatbelt', root, home: fs.realpathSync(os.homedir()), darwinTemp: path.join(root, 'no-darwin-temp'), darwinCache: path.join(root, 'no-darwin-cache') };
    const cwd = path.join(root, 'sandboxes', 's1');
    fs.mkdirSync(cwd, { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
    const dir = path.join(root, 'claude', 'projects', projectSlug(cwd));
    const own = ownTranscriptOf(f, { args: ['--resume', sid], cwd, env });
    fs.writeFileSync(path.join(dir, `${other}.jsonl`), 'theirs\n');
    const sh = (cmd: string) => {
      const [c, ...a] = fencedArgv(f, '/bin/sh', ['-c', cmd], own);
      return spawnSync(c, a, { encoding: 'utf8', cwd });
    };
    assert.equal(sh(`echo mine >> "${dir}/${sid}.jsonl"`).status, 0, 'its own transcript');
    assert.equal(sh(`mkdir -p "${dir}/${sid}/subagents" && echo x > "${dir}/${sid}/subagents/a.jsonl"`).status, 0, 'its own folder');
    assert.notEqual(sh(`echo planted >> "${dir}/${other}.jsonl"`).status, 0, "another conversation's transcript");
    assert.notEqual(sh(`rm "${dir}/${other}.jsonl"`).status, 0);
    assert.notEqual(sh(`mv "${dir}/${other}.jsonl" "${root}/stolen"`).status, 0);
    assert.notEqual(sh(`echo planted > "${dir}/new-conv-1234.jsonl"`).status, 0, 'a planted conversation');
    assert.notEqual(sh(`mkdir "${dir}/memory"`).status, 0, 'memory');
    assert.notEqual(sh(`mv "${root}/claude/projects" "${root}/claude/p2"`).status, 0, 'the projects folder itself');
    assert.equal(fs.readFileSync(path.join(dir, `${other}.jsonl`), 'utf8'), 'theirs\n');
    assert.equal(sh(`echo ok > "${root}/elsewhere"`).status, 0, 'the rest of the root as before');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

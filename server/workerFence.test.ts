import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOptions, type LaunchSpec } from './launch.ts';
import { SANDBOX_EXEC, fenceEnv, fenceFor, fencedArgv, ownTranscriptOf, seatbeltProfile, sessionIdOf, type WorkerFence } from './workerFence.ts';
import { ensureReadBackDirs, judgeReadProbe, READ_PROBE_SCRIPT, readFenceMode, readFenceModeFile, readFenceOnRefusal, readFenceProbeTargets, secretsDirs, writeInPlace, writeReadFenceMode } from '../machine/readFence.ts';
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

test('the profile opens only the root folders workers write: no blanket root, no portal, instances or runners (w5569)', () => {
  const p = seatbeltProfile(F);
  assert.ok(!p.includes('(subpath "/Users/p/ffw")'), 'no blanket grant of the root');
  for (const c of ['tmp', 'sandboxes', 'repo', 'cache', 'tools']) assert.ok(p.includes(`(subpath "${path.join('/Users/p/ffw', c)}")`), c);
  for (const c of ['instances', 'demos', 'ben-factory', 'ffu-runners']) assert.ok(!p.includes(path.join('/Users/p/ffw', c)), c);
  const back = p.lastIndexOf('(deny file-write*');
  for (const c of ['daemon', 'secrets']) assert.ok(p.indexOf(path.join('/Users/p/ffw', c)) > back, `${c} only in the read-only block`);
  const f = fenceFor({ setting: 'seatbelt', root: '/r', platform: 'darwin', home: '/h', exists: () => true, getconf: (n) => `/t/${n}`, workFolders: [path.join('/r', 'work', 'temp'), path.join('/r', 'secrets', 'x')] });
  assert.ok(f?.open?.includes('work') && f.open.includes('tmp'));
  assert.ok(!f?.open?.includes('secrets') && !f?.open?.includes('daemon'));
});

test('the profile refuses every write, then allows the worker folders, then takes the daemon and secrets back', () => {
  const p = seatbeltProfile(F);
  const at = (s: string) => {
    const i = p.indexOf(s);
    assert.ok(i >= 0, `missing: ${s}`);
    return i;
  };
  assert.ok(at('(allow default)') < at('(deny file-write*)'));
  assert.ok(at('(deny file-write*)') < at('(subpath "/Users/p/ffw/tmp")'));
  const back = p.lastIndexOf('(deny file-write*');
  assert.ok(back > at('(subpath "/Users/p/ffw/tmp")'), 'the read-only denies come after the worker folders (later rules win)');
  assert.ok(p.indexOf(`(subpath "${path.join('/Users/p/ffw', 'repo')}")`) < back, 'the main clone stays writable: worktree git writes its index and objects there');
  for (const s of ['(subpath "/Users/p/ffw/daemon")', '(subpath "/Users/p/ffw/secrets")', '(literal "/Users/p/ffw/root.json")']) assert.ok(at(s) > back, s);
  // No blanket home or /tmp allowance: only named paths in them.
  assert.ok(!p.includes('(subpath "/Users/p")'));
  assert.ok(!p.includes('(subpath "/private/tmp")'));
  assert.ok(!p.includes('(subpath "/tmp")'));
  assert.ok(p.includes('(subpath "/Users/p/.ff-factory/unity-slots")'));
});

test('a path with a quote or backslash cannot break out of its SBPL string', () => {
  const p = seatbeltProfile({ ...F, root: '/Users/p/f"f\\w', extraWritable: ['/x") (allow file-write* (subpath "/']});
  assert.ok(p.includes('(subpath "/Users/p/f\\"f\\\\w/tmp")'));
  assert.ok(!p.includes('(subpath "/")'));
});

test('fencedArgv runs the command under sandbox-exec with the profile inline; fenceEnv moves Claude Code temp into the root', () => {
  const a = fencedArgv(F, '/bin/claude', ['--x']);
  assert.deepEqual([a[0], a[1], a[3], a[4]], [SANDBOX_EXEC, '-p', '/bin/claude', '--x']);
  assert.equal(a[2], seatbeltProfile(F));
  assert.deepEqual(fenceEnv(F), { CLAUDE_CODE_TMPDIR: '/Users/p/ffw/tmp/claude-code', DISABLE_AUTOUPDATER: '1', TMPPREFIX: '/Users/p/ffw/tmp/zsh', UV_TOOL_DIR: '/Users/p/ffw/cache/uv-tools' });
  // w5693: uvx's tool folder is inside the workers' cache (a folder the profile opens), never the Medium agents' one
  const p = seatbeltProfile(F);
  assert.ok(p.includes('(subpath "/Users/p/ffw/cache")'), 'the workers\' cache is open');
  assert.ok(!fenceEnv(F).UV_TOOL_DIR.includes('cache-medium'));
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
    // w5543: the Medium agents' Claude folder, made or not, is read-only to a fenced worker
    fs.mkdirSync(path.join(root, 'claude-medium'));
    assert.notEqual(sh(`echo no > "${root}/claude-medium/settings.json"`).status, 0);
    assert.notEqual(sh(`mkdir -p "${root}/claude-medium/plugins"`).status, 0);
    // w5565: the daemon's and Medium agents' uv cache, made or not
    assert.notEqual(sh(`mkdir -p "${root}/cache-medium/uv"`).status, 0);
    fs.mkdirSync(path.join(root, 'cache-medium', 'uv'), { recursive: true });
    assert.notEqual(sh(`echo no > "${root}/cache-medium/uv/x"`).status, 0);
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
  const p = seatbeltProfile({ ...F, appDir: '/Users/p/ffw/daemon', readAllowed: ['/Users/p/ffw/daemon/gh-app/sessions/s1'] });
  const deny = p.indexOf('(deny file-read-data');
  const allow = p.indexOf('(allow file-read-data');
  assert.ok(deny > 0 && allow > deny, 'the read allow comes after the read deny (later rules win)');
  const denied = p.slice(deny, allow);
  for (const s of ['(subpath "/Users/p/ffw/daemon")', '(subpath "/Users/p/ffw/secrets")', '(literal "/Users/p/ffw/root.json")']) assert.ok(denied.includes(s), s);
  const back = p.slice(allow);
  for (const s of ['(subpath "/Users/p/ffw/daemon/logs")', '(subpath "/Users/p/ffw/daemon/src")', '(subpath "/Users/p/ffw/daemon/gh-app/bin")', '(subpath "/Users/p/ffw/daemon/unity-mcp")', '(literal "/Users/p/ffw/daemon/sandboxes.json")', '(subpath "/Users/p/ffw/daemon/gh-app/sessions/s1")'])
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
    for (const x of ['secrets', 'daemon/logs', 'daemon/gh-app/sessions/s1', 'daemon/gh-app/sessions/s2']) fs.mkdirSync(path.join(root, x), { recursive: true });
    for (const x of ['secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json', 'daemon/logs/daemon.log', 'daemon/gh-app/sessions/s1/tokens.json', 'daemon/gh-app/sessions/s2/tokens.json', 'daemon/sandboxes.json']) fs.writeFileSync(path.join(root, x), 'x');
    const f: WorkerFence = { kind: 'seatbelt', root, home: fs.realpathSync(os.homedir()), darwinTemp: path.join(root, 'no-t'), darwinCache: path.join(root, 'no-c'), appDir: d, readAllowed: [path.join(d, 'gh-app/sessions/s1')] };
    const reads = (rel: string) => {
      const [c, ...a] = fencedArgv(f, '/bin/sh', ['-c', `cat "${path.join(root, rel)}" > /dev/null`]);
      return spawnSync(c, a, { encoding: 'utf8' }).status === 0;
    };
    for (const rel of ['secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json', 'daemon/gh-app/sessions/s2/tokens.json']) assert.equal(reads(rel), false, `refused: ${rel}`);
    for (const rel of ['daemon/logs/daemon.log', 'daemon/sandboxes.json', 'daemon/gh-app/sessions/s1/tokens.json']) assert.equal(reads(rel), true, `read: ${rel}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('w5546: with the read fence switched off the profile has no read rules; the write half stays', () => {
  const p = seatbeltProfile({ ...F, appDir: '/Users/p/ffw/daemon', readOff: true });
  assert.ok(!p.includes('(deny file-read-data'), 'no read deny');
  assert.match(p, /read fence is switched off/);
  assert.ok(p.includes('(deny file-write'), 'writes are still fenced');
});

test('w5546: writeInPlace keeps the file (same inode), so a Landlock grant or a Windows label on it holds; the marker and the given-back folders', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffrf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'cleanup-facts.json');
  writeInPlace(f, '{"a":"long contents here"}');
  const ino = fs.statSync(f).ino;
  writeInPlace(f, '{"b":1}');
  assert.equal(fs.statSync(f).ino, ino, 'the same file');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"b":1}', 'cut to the new length');
  assert.equal(readFenceMode(dir), 'off', 'off by default');
  // Lockout re-review B4 of #1193: no `on` on Linux while a self-update swaps the code folder by rename.
  assert.match(readFenceOnRefusal('linux') ?? '', /refused on Linux/);
  assert.equal(readFenceOnRefusal('darwin'), undefined);
  assert.equal(readFenceOnRefusal('win32'), undefined);
  writeReadFenceMode(dir, 'warn');
  assert.equal(readFenceMode(dir), 'warn');
  writeReadFenceMode(dir, 'on');
  assert.equal(readFenceMode(dir), 'on');
  fs.writeFileSync(readFenceModeFile(dir), 'garbage');
  assert.equal(readFenceMode(dir), 'off', 'anything else reads as off');
  writeReadFenceMode(dir, 'off');
  assert.equal(fs.existsSync(readFenceModeFile(dir)), false);
  ensureReadBackDirs(dir);
  for (const d of ['logs', 'rpc', 'unity-mcp', 'unity-slots', 'gh-app/bin', 'gh-app/sessions']) assert.ok(fs.statSync(path.join(dir, d)).isDirectory(), d);
});

test('w5563: sessionIdOf reads the conversation a claude argv runs', () => {
  assert.equal(sessionIdOf(['--output-format', 'stream-json', '--resume', 'abcdef12-3456']), 'abcdef12-3456');
  assert.equal(sessionIdOf(['--session-id', '4476260e-3192-4e62-b3ac-23e3de4f85e4', '--verbose']), '4476260e-3192-4e62-b3ac-23e3de4f85e4');
  assert.equal(sessionIdOf(['--resume=abcdef12-3456']), 'abcdef12-3456');
  assert.equal(sessionIdOf(['--resume', '../../x"y']), undefined, 'no id that is not a file name (nor a regex)');
  assert.equal(sessionIdOf(['--verbose']), undefined);
});

test("w5563: the profile takes the Claude home's transcripts back after the root's open folders (w5569), but this conversation's own, and before the read-only folders", () => {
  const sid = '4476260e-3192-4e62-b3ac-23e3de4f85e4';
  const p = seatbeltProfile(F, { projects: '/Users/p/ffw/claude/projects', sid });
  const at = (s: string) => {
    const i = p.indexOf(s);
    assert.ok(i >= 0, `missing: ${s}`);
    return i;
  };
  const root = at('  (subpath "/Users/p/ffw/claude")');
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

test('w5659: preference writes through cfprefsd are refused only when prefDeny is set, and ~/Library/Preferences stays a file deny', () => {
  assert.ok(!seatbeltProfile(F).includes('user-preference-write'), 'off unless daemon.json workerPrefFence is true');
  const p = seatbeltProfile({ ...F, prefDeny: true });
  assert.ok(p.includes('(deny user-preference-write)'));
  // cfprefsd lets a client write when it may write preferences OR the plist's file (measured on m5), so the rule needs the
  // file deny of ~/Library/Preferences: no allow may open that folder.
  assert.ok(!/\(allow file-write\*[^)]*\(subpath "\/Users\/p\/Library\/Preferences"\)/.test(p));
  assert.ok(!p.includes('(subpath "/Users/p/Library")'));
  assert.ok(!/\(allow user-preference-write/.test(p));
  const on = fenceFor({ setting: 'seatbelt', root: '/', home: '/', platform: 'darwin', prefDeny: true, exists: () => true, getconf: () => '/' });
  assert.equal(on?.prefDeny, true);
  const off = fenceFor({ setting: 'seatbelt', root: '/', home: '/', platform: 'darwin', exists: () => true, getconf: () => '/' });
  assert.equal(off?.prefDeny, undefined);
});

test('w5546 lockout review B3: a Dev Drive install\'s secrets in the host folder are closed too, on every OS', () => {
  assert.deepEqual(secretsDirs('/r'), ['/r/secrets']);
  assert.deepEqual(secretsDirs('/r', '/r/secrets/machine-token'), ['/r/secrets'], 'the same folder once');
  assert.deepEqual(secretsDirs('/r', '/host/ffw/secrets/machine-token'), ['/r/secrets', '/host/ffw/secrets'], 'the host folder (LothDesktop: D:\\work\\ffw\\secrets for root V:\\ffw)');
  assert.deepEqual(secretsDirs('/r', '/home/p/token'), ['/r/secrets'], 'a token file in a folder not named secrets never closes that folder');
  const p = seatbeltProfile({ ...F, secretsDirs: secretsDirs(F.root, '/Volumes/host/ffw/secrets/machine-token') });
  const deny = p.slice(p.indexOf('(deny file-read-data'), p.indexOf('(allow file-read-data'));
  assert.ok(deny.includes('(subpath "/Volumes/host/ffw/secrets")'), deny);
  assert.equal(deny.split('(subpath "/Users/p/ffw/secrets")').length, 2, '<root>/secrets once');
});

test('w5546 lockout review B1: the probe opens each path without reading it and says what would lock workers out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffprobe-'));
  const root = path.join(dir, 'ffw');
  const app = path.join(root, 'daemon');
  for (const d of ['secrets', 'daemon/logs', 'daemon/gh-app', 'daemon/app/machine']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ['secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json', 'daemon/app/machine/ghApp.ts', 'daemon/pause.json']) fs.writeFileSync(path.join(root, f), 'x');
  const t = readFenceProbeTargets({ root, appDir: app, secrets: [path.join(root, 'secrets')], tokenFile: path.join(root, 'secrets/machine-token'), allowBack: ['logs', 'pause.json', 'missing.json'] });
  assert.deepEqual(t.closed.map((p) => path.relative(root, p)), ['secrets', 'secrets/machine-token', 'root.json', 'daemon/daemon.json', 'daemon/gh-app/tokens.json']);
  assert.deepEqual(t.open.map((p) => path.relative(root, p)), ['daemon/logs', 'daemon/pause.json', 'daemon/app/machine/ghApp.ts'], 'only paths that are there');
  // The probe program itself, unfenced here: everything opens. A file it may not open answers `refused`.
  const r = spawnSync(process.execPath, ['-e', READ_PROBE_SCRIPT, ...t.closed, ...t.open], { encoding: 'utf8' });
  const v = judgeReadProbe(t, r.stdout);
  assert.deepEqual(v.wronglyRefused, []);
  assert.equal(v.leftOpen.length, t.closed.length, 'unfenced, nothing is closed');
  assert.deepEqual(judgeReadProbe(t, `0 refused\n1 refused\n2 refused\n3 refused\n4 refused\n5 ok\n6 refused\n`), { wronglyRefused: [t.open[1]], leftOpen: [], unknown: [`${t.open[2]} (no answer)`] });
  if (process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC)) {
    // Under the real profile: the closed paths refused, the given-back ones open.
    const fence: WorkerFence = { ...F, root: fs.realpathSync(root), home: os.homedir(), appDir: fs.realpathSync(app) };
    const real = readFenceProbeTargets({ root: fence.root, appDir: fence.appDir!, secrets: [path.join(fence.root, 'secrets')], allowBack: ['logs', 'pause.json'] });
    const [cmd, ...args] = fencedArgv(fence, process.execPath, ['-e', READ_PROBE_SCRIPT, ...real.closed, ...real.open]);
    const f = spawnSync(cmd, args, { encoding: 'utf8' });
    // Already inside a Seatbelt (a fenced agent's shell), a nested profile cannot apply; the daemon then judges every path unknown.
    if (/sandbox_apply/.test(f.stderr)) return;
    assert.deepEqual(judgeReadProbe(real, f.stdout), { wronglyRefused: [], leftOpen: [], unknown: [] }, f.stdout + f.stderr);
  }
});

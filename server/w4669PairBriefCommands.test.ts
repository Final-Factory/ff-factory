// w4669: the pair-run leg brief (request_pair, w1945) and the timed-leg brief (timed_place, w1969) carry PLAYERS_IN_SANDBOX,
// whose commands must run as written on Windows, macOS and Linux. A leg on LothDesktop (w4663) hit two misses:
// `unity-slot run -- scripts/nightly/build_player.sh <sandbox> <sha> <os>` failed with `spawn EFTYPE` (Windows starts no .sh
// by itself) and named the sandbox where build_player.sh takes the project folder, and `ffnightly.py run` left out --out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD_IN_SANDBOX, PLAYERS_IN_SANDBOX } from './cloneGuard.ts';
import { commandToSpawn, gitBash } from '../machine/unitySlots.ts';

/** The backticked commands in a brief. */
const commands = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

// The game repo's scripts/nightly/ffnightly.py, its `run` parser: `--sha` and `--out` are required=True (origin/master,
// 2026-11-18). build_player.sh: `PROJECT="$1"; SHA="$2"; TARGET="$3"` (the project folder, a 40-hex sha, mac|win|linux;
// w5965: pre-1.0's takes a required 4th, the cache root, and mac|win only).
const NIGHTLY_RUN_REQUIRED = ['--sha', '--out'];

for (const [name, brief] of [['PLAYERS_IN_SANDBOX', PLAYERS_IN_SANDBOX], ['BUILD_IN_SANDBOX', BUILD_IN_SANDBOX]] as const) {
  test(`w4669: ${name} builds through bash with the project folder first`, () => {
    const builds = commands(brief).filter((c) => c.includes('build_player.sh'));
    assert.ok(builds.length > 0, 'the brief names a build_player.sh command');
    for (const c of builds) {
      const words = c.match(/<[^>]*>|"[^"]*"|\S+/g) ?? [];
      const at = words.findIndex((w) => w.endsWith('build_player.sh'));
      assert.equal(words[at - 1], 'bash', `bash starts the script on every OS: ${c}`);
      assert.equal(words[at + 1], '"$PWD"', `the first argument is the project folder (the sandbox's path): ${c}`);
      // w5965: a pre-1.0 commit's script (`<project-dir> <sha> <mac|win> <cache-root>`) needs the cache root master's defaults.
      const args = words.length - at - 1;
      assert.ok(args === 3 || args === 4, `project, sha, os[, cache root]: ${c}`);
      assert.match(words[at + 3], args === 4 ? /^<?(win\|mac|win|mac)>?$/ : /^<?(win\|mac\|linux|win|mac|linux)>?$/);
      if (args === 4) assert.equal(words[at + 4], '"$FF_WORKER_ROOT/player-cache"', `the cache root is the shared player cache: ${c}`);
    }
  });
}

test('w4669: every ffnightly.py run in the pair and timed briefs carries its required flags', () => {
  const runs = commands(PLAYERS_IN_SANDBOX).filter((c) => /ffnightly\.py run\b/.test(c));
  assert.ok(runs.length > 0, 'the brief names the run command');
  for (const c of runs) for (const flag of NIGHTLY_RUN_REQUIRED) assert.ok(c.split(/\s+/).includes(flag), `${flag} in: ${c}`);
  assert.match(PLAYERS_IN_SANDBOX, /on Windows `python`/, 'Windows\' python3 is the Store stub');
});

test('w4669: the pair-leg role, the pair filing and the timed leg all carry PLAYERS_IN_SANDBOX', () => {
  const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), 'utf8');
  const agents = src('agents.ts');
  assert.match(agents, /## Your leg of this pair run \(w1945\)[^\n]*\$\{PLAYERS_IN_SANDBOX\}/);
  assert.match(agents, /Elsewhere \(w1969, w1996\)[^\n]*\$\{PLAYERS_IN_SANDBOX\}/);
  const orch = src('orchestrators.ts');
  assert.match(orch, /\(w1969, timed_place\)[^\n]*\$\{PLAYERS_IN_SANDBOX\}/);
  assert.match(orch, /\(w1945, request_pair\)[^\n]*\$\{PLAYERS_IN_SANDBOX\}/);
});

const GIT = 'C:\\Program Files\\Git';
const winEnv = { PATH: `C:\\Windows\\System32;${GIT}\\cmd;C:\\Python312`, ProgramFiles: 'C:\\Program Files' };
const has = (...paths: string[]) => (p: string) => paths.some((x) => x.toLowerCase() === p.toLowerCase());

test('w4669: unity-slot starts a .sh through Git for Windows\' bash on Windows', () => {
  const exists = has(`${GIT}\\bin\\bash.exe`, 'C:\\Windows\\System32\\bash.exe');
  assert.deepEqual(commandToSpawn(['scripts/nightly/build_player.sh', '/v/sb', 'abc', 'win'], 'win32', winEnv, exists), {
    cmd: `${GIT}\\bin\\bash.exe`, args: ['scripts/nightly/build_player.sh', '/v/sb', 'abc', 'win'], shell: false,
  });
  // `bash <script>` as the brief writes it: Git's bash, never WSL's in System32, though System32 comes first on PATH.
  assert.deepEqual(commandToSpawn(['bash', 'x.sh', 'a'], 'win32', winEnv, exists), { cmd: `${GIT}\\bin\\bash.exe`, args: ['x.sh', 'a'], shell: false });
  assert.deepEqual(commandToSpawn(['tool.cmd', 'a'], 'win32', winEnv, exists), { cmd: 'tool.cmd', args: ['a'], shell: true });
  assert.deepEqual(commandToSpawn(['Unity.exe', '-batchmode'], 'win32', winEnv, exists), { cmd: 'Unity.exe', args: ['-batchmode'], shell: false });
});

test('w4669: macOS and Linux start the command as given', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(commandToSpawn(['scripts/nightly/build_player.sh', '/x', 'abc', 'mac'], platform, {}, () => true), {
      cmd: 'scripts/nightly/build_player.sh', args: ['/x', 'abc', 'mac'], shell: false,
    });
    assert.deepEqual(commandToSpawn(['bash', 'x.sh'], platform, {}, () => true), { cmd: 'bash', args: ['x.sh'], shell: false });
  }
});

test('w4669: gitBash prefers Claude Code\'s Git bash, skips System32 and WindowsApps, else falls back to bash', () => {
  const claude = 'D:\\Tools\\Git\\bin\\bash.exe';
  assert.equal(gitBash({ ...winEnv, CLAUDE_CODE_GIT_BASH_PATH: claude }, has(claude, `${GIT}\\bin\\bash.exe`)), claude);
  assert.equal(gitBash({ PATH: 'C:\\Windows\\System32;C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps' }, has('C:\\Windows\\System32\\bash.exe', 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe')), 'bash');
  assert.equal(gitBash({ PATH: 'C:\\Windows\\System32' }, has('C:\\Program Files\\Git\\bin\\bash.exe')), 'C:\\Program Files\\Git\\bin\\bash.exe');
});

// w6154: a 0.50 (pre-1.0) leg that wrote only master's ffnightly.py, lab.py and player_slots.py failed at once on 48f1fbab
// (`ModuleNotFoundError: No module named 'winstop'`, lab.py:35); the game repo's scripts/nightly/use_master_runner.sh
// overlays master's whole top-level scripts/nightly *.py and *.json set and restores it.
test('w6154: the pair brief overlays master\'s whole runner through use_master_runner.sh, never single files', () => {
  const cmds = commands(PLAYERS_IN_SANDBOX);
  assert.ok(cmds.includes('git show origin/master:scripts/nightly/use_master_runner.sh > "$TMPDIR/use_master_runner.sh"'));
  assert.ok(cmds.includes('bash "$TMPDIR/use_master_runner.sh" apply'));
  assert.ok(cmds.includes('bash "$TMPDIR/use_master_runner.sh" restore'));
  for (const c of cmds) assert.doesNotMatch(c, /origin\/master:scripts\/nightly\/\w+\.py\s*>/, `no single-module overlay: ${c}`);
});

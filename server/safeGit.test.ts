import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED_GIT_CONFIG, HOOKS, SUBMODULE_GIT_CONFIG, submoduleRecursion, submoduleRefusal, aliasRefusal, gitlinkListArgs, gitlinkIn, gitlinkCovered, gitFence, wholeIndexCall, fenceArgs, firstWinsArgs, firstWinsRefusal, gitExecFileSync, gitFenceSync, gitOffThread, gitSpawnSync, isGit, lazyFetchOff, needsScan, parseScan, refusal, scanCut, scannedOverrides, splitGlobal, withConfigFirst } from './safeGit.ts';
import { readGitStatus } from './gitStatus.ts';
import { run } from './proc.ts';

// w5541 (item 3 of the w5451 rogue-worker audit): the daemon, the agent host and the other Medium processes run git in
// checkouts a worker writes; a worker's git config, or a `.git` file pointing at a git folder it made, could name a program
// that git then runs for them. Every such git call goes through server/safeGit.ts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasGit = spawnSync('git', ['--version']).status === 0;
const slash = (p: string) => p.replace(/\\/g, '/');

// ---------------------------------------------------------------- the lint

/** Where the daemon's, the agent host's and the machine install's code lives (tests and test fixtures aside). */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'test', 'tray'].includes(e.name)) walk(p);
      } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ['server', 'machine', 'shared', path.join('scripts', 'worker')]) walk(path.join(ROOT, d));
  return out;
}

/**
 * Generic runners that spawn a program named by a variable and are never handed git, each with what it runs. A new one
 * either fences git (calls gitFence or gitFenceSync in its file, as proc.ts, worker.ts and prFlow.ts do) or joins this list.
 */
const NOT_GIT: Record<string, string> = {
  'machine/playersLaunch.ts|cmd': 'a players-broker player, inside the player fence (fencedPlayer: sandbox-exec or the Landlock wrapper around the slot exe, w5615)',
  'machine/daemon.ts|runnerEnvCmd': 'plutil, launchctl and powershell.exe for the macOS and Windows CI runners (machine/runnerEnv.ts, w5999)',
  'server/spawnThread.ts|m.cmd': 'whatever execFileOffThread is given: its callers fence git (proc.run), and the lint checks each caller as a spawner (w6077)',
  'server/spawnThread.ts|cmd': 'the same, on the main thread when the spawn thread is off: its callers fence git (proc.run; w6077)',
  'server/spawnThread.ts|s.cmd': 'an agent host (node and its script), started detached by launchDetached for machine/agentHost.ts launchHost, never git (w6639)',
  'server/rerunGuard.ts|trustedGh(': 'gh (resolved from a trusted PATH, w5542)',
  'machine/ownerSecrets.ts|cmd': 'gh auth token (trustedGh, w5548)',
  'machine/lowIntegrity.ts|cmd': 'icacls (LowCopies execSync, w5838)',
  'machine/ownerSecrets.ts|trustedGh(': 'gh auth status, token and login for the owner gh login move (realGhRun, w5749)',
  'machine/timedRunner.ts|process.execPath': 'a node watchdog',
  'machine/timedRunner.ts|e': 'the game player',
  'machine/agentHost.ts|cmd.bin': 'the agent CLI',
  'machine/osJob.ts|cmd': 'launchctl, systemd-run or schtasks',
  'machine/osJob.ts|s.node': 'node',
  'machine/fenceProbe.ts|cmd': 'the fence probe (sandbox-exec, landlock)',
  'machine/maxEventsFence.ts|cmd': 'the Max events probe (/bin/sh under sandbox-exec or landlock, w5552)',
  'machine/workerCaps.ts|exe': 'the Windows job-object helper (w5554)',
  'machine/longRuns.ts|node': "the long-run keeper: the daemon's Low node copy (w6367)",
  'machine/longRuns.ts|b': "the keeper script's run: Git Bash for agents on the sandbox's nightly_run.sh (w6367)",
  'machine/longRuns.ts|tk': "the keeper's time limit and runs/stop: Windows' taskkill.exe on its run's tree (w6367)",
  'machine/longRuns.ts|helper': 'the Windows job-object helper ffjob.exe, around a long run (w6367)',
  'machine/unity.ts|bin': 'the Unity editor',
  'machine/unity.ts|SANDBOX_EXEC': 'sandbox-exec running the Unity editor under the workers\' Seatbelt profile (w5630)',
  'machine/unity.ts|lc': 'Unity\'s licensing client (Unity.Licensing.Client), started outside the fence before a fenced Mac editor (w5630)',
  'machine/unity.ts|b': 'the Low launcher script (FENCED_LAUNCH_SCRIPT, a string the launcher node runs): the Unity editor',
  'machine/benchProxy.ts|python': 'python (bench_queue.py, detached)',
  'machine/benchQueue.ts|trustedGh(root': 'gh (resolved from a trusted PATH, w5542)',
  'machine/tray.ts|build.exe': 'the tray app',
  'machine/leftovers.ts|prog': "a program a worker launches for a person (the worker's own command)",
  'machine/sharedCaches.ts|bin': 'uv and cargo cache tools',
  'machine/ghApp.ts|gh': 'gh',
  'machine/unitySlots.ts|run.cmd': "a worker's own batch command (unity-slot run)",
  'machine/unitySlots.ts|process.execPath': 'node',
  'machine/ffuSlots.ts|process.execPath': 'node (the daemon runs `ffu-slot list --json`, w5912)',
  'machine/ffuSlots.ts|cmd': 'rustc -V, to find rustc for the native slot hook (findRustc, w6062)',
  'machine/ffuSlots.ts|rustc.cmd': 'rustc, building the native slot hook (ensureNativeSlotHooks, w6062)',
  'server/publicGit.ts|cmd': 'gh and curl',
  'server/voice.ts|c.python': 'python',
  'server/machineDeployWin.ts|cmd': 'powershell or ssh',
  'server/deadMounts.ts|cmd': 'umount',
  'scripts/worker/linkJob.ts|cmd': 'powershell or bash',
  'scripts/worker/linkJob.ts|process.execPath': 'node',
  "server/apfsPrivate.ts|o.python ?? '/usr/bin/python3'": 'python',
  'server/guard.ts|evidencePython(all': 'python (pr_evidence.py)',
  'server/videoPreview.ts|this.ffmpeg[0]': 'ffmpeg',
  'machine/benchQueue.ts|this.o.python ?? pythonExe(this.o.env': 'python (bench_queue.py)',
  'machine/daemon.ts|cmd[0]': 'caffeinate or powershell (keepAwakeCommand)',
  'machine/playerCache.ts|tarCommand(': 'tar',
  'machine/unitySlots.ts|c': 'taskkill or kill (stopTree)',
  "machine/writeLock.ts|o.python ?? 'python3'": 'python',
};

/** The names a file imports from node:child_process (aliases resolved), and its namespace imports. */
function childProcessNames(text: string): { names: Set<string>; spaces: string[] } {
  const names = new Set<string>();
  const spaces: string[] = [];
  for (const m of text.matchAll(/import\s+([^'";]*?)\s+from\s*['"](?:node:)?child_process['"]/g)) {
    const clause = m[1];
    const braces = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    const outside = clause.replace(/\{[^}]*\}/, '');
    for (const n of outside.matchAll(/(?:\*\s+as\s+)?(\w+)/g)) if (n[1] !== 'type') spaces.push(n[1]);
    for (const part of braces.split(',')) {
      const n = part.replace(/^\s*type\s+/, '').trim();
      if (!n || /^type\s/.test(part.trim())) continue;
      names.add(n.split(/\s+as\s+/).pop()!.trim());
    }
  }
  return { names, spaces };
}

export function gitSpawnProblems(files: { rel: string; text: string }[]): string[] {
  const problems: string[] = [];
  for (const { rel, text } of files) {
    if (rel === 'server/safeGit.ts') continue;
    // A shell that runs git (`bash -c "git ... | tar ..."`): its environment must come from gitFence, on the same line.
    text.split('\n').forEach((l, i) => {
      if (/['"]-c['"],\s*['"`]git\s/.test(l) && !/\bgitFence(Sync)?\(/.test(l)) problems.push(`${rel}:${i + 1}: a shell runs git without server/safeGit.ts (give it gitFence's env)`);
    });
    const { names, spaces } = childProcessNames(text);
    // execFileOffThread starts what it is given (server/spawnThread.ts, w6077): each caller is checked as if it were execFile.
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*spawnThread(?:\.ts)?['"]/g)) {
      for (const part of m[1].split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (name === 'execFileOffThread') names.add((alias ?? name).trim());
      }
    }
    if (!names.size && !spaces.length) continue;
    const callee = [...names].map((n) => `(?<![\\w.])${n}`).concat(spaces.map((s) => `\\b${s}\\.\\w+`));
    if (!callee.length) continue;
    const re = new RegExp(`(${callee.join('|')})\\(\\s*([^,)]*)`, 'g');
    const fenced = /\bgitFence(Sync)?\(/.test(text);
    for (const m of text.matchAll(re)) {
      const first = m[2].trim();
      const line = text.slice(0, m.index).split('\n').length;
      if (/^['"`]git(\.exe)?\b/i.test(first)) problems.push(`${rel}:${line}: ${m[1]}(${first}, ...) runs git without server/safeGit.ts (use gitExecFile, gitExecFileSync, gitSpawn or gitSpawnSync)`);
      else if (/^['"`]/.test(first) || /^\w+\??:/.test(first) || first === '') continue; // a literal program, or a method's own declaration
      else if (!fenced && !NOT_GIT[`${rel}|${first}`]) problems.push(`${rel}:${line}: ${m[1]}(${first}, ...) runs a program a variable names; fence git there (gitFence) or add it to NOT_GIT with what it runs`);
    }
  }
  return problems;
}

test('w5541: no daemon, agent host or install code spawns git past server/safeGit.ts', () => {
  const files = sources().map((p) => ({ rel: slash(path.relative(ROOT, p)), text: fs.readFileSync(p, 'utf8') }));
  assert.ok(files.length > 100, `found the sources (${files.length})`);
  assert.deepEqual(gitSpawnProblems(files), []);
});

test('w5541: the lint catches a raw git spawn, an aliased one and a new generic runner', () => {
  const p = gitSpawnProblems([
    { rel: 'machine/a.ts', text: "import { execFile } from 'node:child_process';\nexecFile('git', ['status']);\n" },
    { rel: 'machine/b.ts', text: "import { spawnSync as ss } from 'node:child_process';\nss(\n  'git', ['status']);\n" },
    { rel: 'machine/c.ts', text: "import cp from 'node:child_process';\ncp.spawn('git.exe', []);\n" },
    { rel: 'machine/d.ts', text: "import { spawn } from 'node:child_process';\nexport const go = (bin: string) => spawn(bin, []);\n" },
    { rel: 'machine/e.ts', text: "import { spawn } from 'node:child_process';\nimport { run } from './proc.ts';\nspawn('node', []);\nrun('git', []);\nd.spawn('git', []);\n" },
    { rel: 'scripts/f.ts', text: "await must('copy', 'bash', ['-c', `git -C \"$1\" archive HEAD | tar -x`, 'x', src]);\nawait must('copy', 'bash', ['-c', `git archive HEAD`], { env: (await gitFence([])).env });\n" },
    { rel: 'machine/g.ts', text: "import { execFileOffThread as eft } from '../server/spawnThread.ts';\neft('git', [], {}, cb);\neft(bin, [], {}, cb);\neft('powershell.exe', [], {}, cb);\n" },
  ]);
  assert.equal(p.length, 7, p.join('\n'));
  assert.match(p[0], /^machine\/a\.ts:2: execFile\('git'/);
  assert.match(p[1], /^machine\/b\.ts:2: ss\('git'/);
  assert.match(p[2], /^machine\/c\.ts:2: cp\.spawn\('git\.exe'/);
  assert.match(p[3], /^machine\/d\.ts:2: spawn\(bin, \.\.\.\) runs a program a variable names/);
  assert.match(p[4], /^scripts\/f\.ts:1: a shell runs git without server\/safeGit\.ts/);
  assert.match(p[5], /^machine\/g\.ts:2: eft\('git'/);
  assert.match(p[6], /^machine\/g\.ts:3: eft\(bin, \.\.\.\) runs a program a variable names/);
});

// ---------------------------------------------------------------- the pieces

test('w5541: the fixed keys come first; the caller’s own entries follow and keep their order', () => {
  const env = withConfigFirst({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '!mine', PATH: 'p' }, [['core.fsmonitor', 'false']]);
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.deepEqual([0, 1, 2].map((i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]), [['core.fsmonitor', 'false'], ['credential.helper', ''], ['credential.helper', '!mine']]);
  assert.equal(env.PATH, 'p');
  assert.deepEqual(FIXED_GIT_CONFIG.slice(0, 2), [['core.fsmonitor', 'false'], ['core.hooksPath', HOOKS]]);
  // git-lfs's hooks and nothing else, each one line that runs `git lfs <hook>`.
  assert.deepEqual(fs.readdirSync(HOOKS).sort(), ['post-checkout', 'post-commit', 'post-merge', 'pre-push']);
  for (const h of fs.readdirSync(HOOKS)) assert.match(fs.readFileSync(path.join(HOOKS, h), 'utf8'), new RegExp(`\\nexec git lfs ${h} "\\$@"\\n$`));
  // The upload always runs; the lock hooks only where something is lockable (git-lfs on every commit slowed CI past its
  // watchdog, w5583's rerun of #1179).
  const lockGate = '\ngrep -qs lockable .gitattributes || exit 0\n';
  assert.ok(!fs.readFileSync(path.join(HOOKS, 'pre-push'), 'utf8').includes(lockGate));
  for (const h of ['post-checkout', 'post-commit', 'post-merge']) assert.ok(fs.readFileSync(path.join(HOOKS, h), 'utf8').includes(lockGate), h);
});

test('w5541: a repository-set program key takes the user’s value back, else a neutral one; credential helpers are replaced', () => {
  const rows = parseScan(
    [
      ['global', 'filter.lfs.clean\ngit-lfs clean -- %f'],
      ['local', 'filter.lfs.clean\n/evil'],
      ['local', 'filter.lfs.smudge\n/evil'],
      ['worktree', 'filter.x.clean\n/evil'],
      ['local', 'remote.origin.uploadpack\n/evil'],
      ['unknown', 'credential.helper\nosxkeychain'],
      ['command', 'credential.https://github.com.helper\n!mine'],
      ['local', 'credential.helper\n/evil'],
      ['global', 'credential.https://github.com.helper\n!gh auth git-credential'],
    ]
      .map(([s, kv]) => `${s}\0${kv}\0`)
      .join(''),
  );
  assert.equal(rows.length, 9);
  assert.deepEqual(scannedOverrides(rows), [
    ['filter.lfs.clean', 'git-lfs clean -- %f'],
    ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
    ['filter.x.clean', ''],
    ['credential.helper', ''],
    ['credential.helper', 'osxkeychain'],
    ['credential.https://github.com.helper', '!gh auth git-credential'],
  ]);
  assert.deepEqual(scannedOverrides(parseScan('global\0filter.lfs.clean\nx\0')), [], 'nothing a repository set, nothing to override');
});

test('w6570: a repository-set upload or receive program goes to the transport as an option; another transport is refused again', () => {
  const rows = parseScan(
    [
      ['local', 'remote.origin.uploadpack\n/evil'],
      ['local', 'remote.origin.receivepack\n/evil'],
      ['global', 'remote.origin.receivepack\n/usr/bin/git-receive-pack'],
      ['local', 'protocol.ext.allow\nalways'],
      ['local', 'protocol.https.allow\nnever'],
      ['local', 'core.gitproxy\n/evil'],
    ]
      .map(([s, kv]) => `${s}\0${kv}\0`)
      .join(''),
  );
  // git keeps the first value of these, so no override by value is passed for them; the protocol allow gets one.
  assert.deepEqual(scannedOverrides(rows), [['protocol.ext.allow', 'never']]);
  assert.deepEqual(firstWinsArgs(['-C', 'd', 'fetch', 'origin'], rows), ['-C', 'd', 'fetch', '--upload-pack=git-upload-pack', 'origin']);
  assert.deepEqual(firstWinsArgs(['pull', '--ff-only'], rows), ['pull', '--upload-pack=git-upload-pack', '--ff-only']);
  assert.deepEqual(firstWinsArgs(['ls-remote', 'origin'], rows), ['ls-remote', '--upload-pack=git-upload-pack', 'origin']);
  assert.deepEqual(firstWinsArgs(['push', 'origin', 'x'], rows), ['push', '--receive-pack=/usr/bin/git-receive-pack', 'origin', 'x'], 'the user’s own value');
  assert.deepEqual(firstWinsArgs(['status'], rows), ['status']);
  assert.deepEqual(firstWinsArgs(['fetch', 'origin'], parseScan('global\0remote.origin.uploadpack\nx\0')), ['fetch', 'origin'], 'nothing a repository set');
  // The calls no option covers are refused (the warn step, PR #1523, said so first: lothsahn's lockout rule).
  const up = rows.filter((r) => r.key === 'remote.origin.uploadpack');
  const rp = rows.filter((r) => r.key.endsWith('receivepack'));
  for (const a of [['fetch', 'origin'], ['pull'], ['ls-remote', 'origin']]) assert.equal(firstWinsRefusal(a, up), undefined, a.join(' '));
  assert.equal(firstWinsRefusal(['push', 'origin', 'x'], rp), undefined, 'push passes --receive-pack');
  assert.equal(lazyFetchOff(rp), false, 'a receivepack alone starts nothing outside push');
  for (const a of [['push', 'origin', 'x'], ['remote', 'update'], ['-C', 'd', 'lfs', 'push', 'origin']])
    assert.match(refusal(a, up) ?? '', /^refused by FF Factory \(w6570\): .*remote\.origin\.uploadpack.*`git config --local --unset-all remote\.origin\.uploadpack`/, a.join(' '));
  // `git submodule` is refused in every repository (w6630), before anything its config sets.
  assert.match(refusal(['submodule', 'update'], up) ?? '', /^refused by FF Factory \(w6630\)/);
  assert.equal(firstWinsRefusal(['status'], up), undefined);
  assert.equal(lazyFetchOff(up), true, 'every other call runs with lazy fetch off');
  // A key in the worktree's own config is removed with --worktree (`--local --unset-all` exits 5 there, review of PR #1523).
  const wt = parseScan('worktree\0remote.origin.uploadpack\n/evil\0');
  assert.match(firstWinsRefusal(['push', 'origin'], wt) ?? '', /`git config --worktree --unset-all remote\.origin\.uploadpack`/);
  assert.match(refusal(['fetch', 'origin'], parseScan('worktree\0url.x.insteadof\ny\0')) ?? '', /w5573.*`git config --worktree --unset-all url\.x\.insteadof`/);
  // A fetch or pull of several remotes starts a child `git fetch` per remote, which never gets the option (review of PR #1523).
  const group = [...up, ...parseScan('local\0remotes.origin\nb c\0local\0remotes.both\nb c\0')];
  const all = [...up, ...parseScan('global\0fetch.all\ntrue\0')];
  for (const [a, r] of [
    [['fetch', '--all'], up],
    [['fetch', '--multiple', 'b', 'c'], up],
    [['fetch', '-m', 'origin', 'b'], up],
    [['fetch', '-qm', 'origin', 'b'], up],
    [['fetch', '-vmq', 'origin', 'b'], up],
    // git takes any unique prefix of a long option, down to one letter (w6638's review of PR #1534).
    ...['--m', '--mu', '--mul', '--mult', '--multi', '--multip', '--multipl'].map((o) => [['fetch', o, 'origin', 'b'], up]),
    [['fetch', '--al'], up],
    [['pull', '--al'], up],
    [['fetch', '--prune', 'both'], group],
    [['fetch', '--prune', 'origin'], group],
    [['pull', 'origin', 'master'], group],
    [['pull', '--all'], up],
    [['fetch'], all],
    [['fetch', '--prune'], all],
  ] as [string[], typeof up][])
    assert.match(firstWinsRefusal(a, r) ?? '', /refused by FF Factory \(w6570\)/, a.join(' '));
  for (const [a, r] of [
    [['fetch', '--prune', 'origin'], all],
    [['fetch', '--no-all'], all],
    [['fetch', '--depth', '1', 'b'], group],
    [['fetch', '-j', 'm'], up],
    [['fetch', '-jm', 'origin'], up],
    [['pull', '-q', 'origin'], up],
    [['-C', 'd', 'fetch', '--quiet', 'origin', 'master'], up],
  ] as [string[], typeof up][])
    assert.equal(firstWinsRefusal(a, r), undefined, a.join(' '));
  // Calls that start no upload program (measured by the review): never refused, they run with lazy fetch off.
  for (const a of [['remote', '-v'], ['remote', '--verbose'], ['remote'], ['remote', '-v', 'get-url', 'origin'], ['remote', 'get-url', 'origin'], ['lfs', 'env'], ['clone', 'x', 'y'], ['archive', '--remote', 'origin', 'HEAD']])
    assert.equal(firstWinsRefusal(a, up), undefined, a.join(' '));
  for (const a of [['remote', 'show', 'origin'], ['remote', 'prune', 'origin'], ['remote', 'set-head', 'origin', '--auto'], ['remote', 'set-head', 'origin', '--a'], ['remote', 'add', '-f', 'x', 'u'], ['remote', 'add', '--f', 'x', 'u'], ['lfs', 'fetch'],
    // remote's own -v before the verb (w6652's review of PR #1534).
    ['remote', '-v', 'update'], ['remote', '-v', 'show', 'origin'], ['remote', '--verbose', 'prune', 'origin'], ['remote', '--v', 'set-head', 'origin', '-a'], ['remote', '-v', 'add', '-f', 'x', 'u']])
    assert.match(firstWinsRefusal(a, up) ?? '', /refused by FF Factory \(w6570\)/, a.join(' '));
  assert.deepEqual(scannedOverrides(group), [], 'a remote group is read, never overridden');
  assert.deepEqual(scannedOverrides(parseScan('local\0fetch.all\ntrue\0')), [], 'fetch.all is read, never overridden');
  assert.match(firstWinsRefusal(['fetch', 'origin'], rows.filter((r) => r.key === 'core.gitproxy')) ?? '', /w6570.*core\.gitproxy/);
  assert.equal(firstWinsRefusal(['status'], rows.filter((r) => r.key === 'core.gitproxy')), undefined);
  assert.equal(firstWinsRefusal(['push', 'origin'], []), undefined);
});

test('w5541: the subcommand is found past the global options; diff, log and show get no external diff or textconv', () => {
  assert.deepEqual(splitGlobal(['--no-optional-locks', '-C', 'd', '-c', 'a=b', '--git-dir=g', 'status', '-C']), { location: ['-C', 'd', '--git-dir=g'], sub: 6 });
  assert.deepEqual(fenceArgs(['-C', 'd', 'diff', 'HEAD', '--numstat']), ['-C', 'd', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', 'HEAD', '--numstat']);
  assert.deepEqual(fenceArgs(['log', '-1']), ['log', '--no-ext-diff', '--no-textconv', '-1']);
  assert.deepEqual(fenceArgs(['-C', 'd', 'rev-list', 'HEAD']), ['-C', 'd', 'rev-list', 'HEAD']);
  // w6691: a submodule's own `ignore` loses only to an option.
  assert.deepEqual(fenceArgs(['-C', 'd', 'status', '--porcelain']), ['-C', 'd', 'status', '--ignore-submodules=dirty', '--porcelain']);
  assert.deepEqual(fenceArgs(['diff', 'HEAD']), ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', 'HEAD']);
  assert.deepEqual(fenceArgs(['diff-index', 'HEAD']), ['diff-index', '--ignore-submodules=dirty', 'HEAD']);
  assert.deepEqual(fenceArgs(['diff-files']), ['diff-files', '--ignore-submodules=dirty']);
  assert.deepEqual(fenceArgs(['checkout', '--no-quiet', 'main']), ['checkout', '--no-quiet', 'main', '--quiet']);
  assert.deepEqual(fenceArgs(['checkout', 'main', '--', 'a.txt']), ['checkout', 'main', '--quiet', '--', 'a.txt']);
  assert.deepEqual(fenceArgs(['switch', '-c', 'b']), ['switch', '-c', 'b', '--quiet']);
  assert.deepEqual(fenceArgs(['stash', 'pop']), ['stash', 'pop', '--quiet']);
  assert.deepEqual(fenceArgs(['stash', 'apply', 'stash@{1}']), ['stash', 'apply', 'stash@{1}', '--quiet']);
  assert.deepEqual(fenceArgs(['stash', 'list']), ['stash', 'list']);
  assert.ok(isGit('git') && isGit('/usr/bin/git') && isGit('C:\\Program Files\\Git\\cmd\\git.exe') && !isGit('gh') && !isGit('git-lfs'));
});

test('w5991: only calls that start no program a repository names and read no object skip the scan', () => {
  for (const a of [['rev-parse', 'HEAD'], ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feat'], ['-C', 'd', 'rev-parse', '--abbrev-ref', 'HEAD'], ['rev-parse', '--show-toplevel'], ['symbolic-ref', '--short', 'HEAD'], ['config', '--get', 'x.y'], ['-C', 'd', 'worktree', 'list', '--porcelain'], ['worktree', 'prune']])
    assert.equal(needsScan(a), false, a.join(' '));
  // w5996: these read objects, and a planted partial clone lazy-fetches a missing one through core.sshCommand.
  for (const a of [['merge-base', '--is-ancestor', 'a', 'b'], ['show-ref'], ['for-each-ref'], ['rev-parse', 'HEAD^{commit}'], ['rev-parse', 'HEAD~1'], ['rev-parse', 'HEAD:a.txt'], ['rev-parse', '@{u}'], ['config', '--blob=HEAD:.gitmodules', '--list'], ['config', '--blo', 'x', '--get', 'a.b'], ['config', 'get', '--blob', 'x', 'a.b'], ['rev-parse', 'bad...HEAD'], ['rev-parse', 'HEAD..bad'], ['rev-parse', '--short', 'HEAD'], ['rev-parse', '--parseopt']])
    assert.equal(needsScan(a), true, a.join(' '));
  for (const a of [['status'], ['worktree', 'add', 'x'], ['worktree', 'remove', 'x'], ['worktree'], ['log', '-1'], ['diff'], ['checkout', 'x'], ['fetch'], ['push'], ['cat-file', '--textconv', 'x'], ['branch', '-f', 'x'], ['-c', 'rev-parse', 'status'], []])
    assert.equal(needsScan(a), true, a.join(' '));
});

// ---------------------------------------------------------------- planted programs, measured with a marker file

interface Fixture {
  root: string;
  marker: string;
  evil: string;
  ran: () => string;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safegit-'));
  const marker = slash(path.join(root, 'ran.txt'));
  const evil = slash(path.join(root, 'evil.sh'));
  // Logs what ran it, passes its input through (a filter's contract), exits 0.
  fs.writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\nexit 0\n`, { mode: 0o755 });
  return { root, marker, evil, ran: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '') };
}

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** Plants every program key this test checks into the config file `cfg`, plus a hook in `hooks`. */
function plant(f: Fixture, cfgDir: string, hooks: string) {
  const set = (k: string, v: string) => git(f.root, 'config', '--file', path.join(cfgDir, 'config'), k, v);
  set('core.fsmonitor', f.evil);
  set('filter.x.clean', `${f.evil} clean`);
  set('diff.x.textconv', `${f.evil} textconv`);
  set('diff.external', `${f.evil} external`);
  fs.mkdirSync(hooks, { recursive: true });
  for (const h of ['pre-commit', 'post-commit', 'reference-transaction', 'post-index-change']) fs.copyFileSync(f.evil, path.join(hooks, h));
  for (const h of fs.readdirSync(hooks)) fs.chmodSync(path.join(hooks, h), 0o755);
}

/** A worktree of a clone, both made the way the machines make them (a main clone, `git worktree add`). */
function worktree(f: Fixture): { main: string; wt: string } {
  const main = path.join(f.root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(main, '.gitattributes'), '*.txt filter=x diff=x\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  const wt = path.join(f.root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'sandbox/x', wt);
  return { main, wt };
}

/** Make a.txt look changed to git (new content, new mtime), so status runs the clean filter on it. */
function touch(dir: string) {
  fs.writeFileSync(path.join(dir, 'a.txt'), `two ${Date.now()}\n`);
}

const skip = !hasGit;

test('w5541: a worktree whose config plants fsmonitor, a filter, a textconv, diff.external and hooks runs none of them from the daemon', { skip }, async () => {
  const f = fixture();
  try {
    const { main, wt } = worktree(f);
    // The worker's `git config` in its worktree writes the clone's shared config: plant there.
    plant(f, path.join(main, '.git'), path.join(main, '.git', 'hooks'));

    // Control: plain git in the worktree runs the planted programs (the plant is live).
    touch(wt);
    spawnSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' });
    spawnSync('git', ['diff'], { cwd: wt, encoding: 'utf8' });
    const control = f.ran();
    assert.match(control, /evil\.sh/, 'plain git ran the planted programs');
    fs.rmSync(f.marker, { force: true });

    // The daemon's status call (server/gitStatus.ts readGitStatus).
    touch(wt);
    const st = await readGitStatus(wt);
    assert.equal(st?.branch, 'sandbox/x');
    assert.equal(st?.dirty, 1, 'the changed file still shows');
    // run() (server/proc.ts) for diff, a commit and a branch update, and the sync wrapper.
    const diff = await run('git', ['-C', wt, 'diff']);
    assert.equal(diff.code, 0, diff.stderr);
    assert.match(diff.stdout, /\+two/, 'git diff still works, with no external diff and no textconv');
    const commit = await run('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-qam', 'x']);
    assert.equal(commit.code, 0, commit.stderr);
    assert.match(gitExecFileSync(['-C', wt, 'log', '-1', '-p'], { encoding: 'utf8' }), /\+two/);
    // w5991: the calls that skip the scan still get the fixed keys: a ref update by symbolic-ref runs no planted
    // reference-transaction hook, and fsmonitor stays off for rev-parse, config and worktree list.
    touch(wt);
    assert.equal(gitExecFileSync(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'sandbox/x');
    gitExecFileSync(['-C', wt, 'symbolic-ref', 'HEAD', 'refs/heads/sandbox/x'], { encoding: 'utf8' });
    assert.match(gitExecFileSync(['-C', wt, 'config', '--get', 'filter.x.clean'], { encoding: 'utf8' }), /evil\.sh/);
    assert.match((await run('git', ['-C', main, 'worktree', 'list', '--porcelain'])).stdout, /branch refs\/heads\/sandbox\/x/);
    assert.equal((await run('git', ['-C', main, 'worktree', 'prune'])).code, 0);
    assert.equal(f.ran(), '', 'no planted program ran');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w5996: a planted partial clone lazy-fetches through core.sshCommand under plain git, never through the fence', { skip }, async () => {
  const f = fixture();
  try {
    const { main, wt } = worktree(f);
    // An ssh command that logs and fails at once (the fixture's evil.sh reads stdin, which a transport never closes).
    const ssh = slash(path.join(f.root, 'ssh.sh'));
    fs.writeFileSync(ssh, `#!/bin/sh\necho "ssh $*" >> '${f.marker}'\nexit 1\n`, { mode: 0o755 });
    const set = (k: string, v: string) => git(main, 'config', k, v);
    set('core.repositoryformatversion', '1');
    set('extensions.partialClone', 'origin');
    set('remote.origin.url', 'ssh://127.0.0.1:1/r');
    set('remote.origin.promisor', 'true');
    set('core.sshCommand', ssh);
    fs.writeFileSync(path.join(main, '.git', 'refs', 'heads', 'missing'), `${'1'.repeat(40)}\n`);
    const quiet = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

    // Control: plain git lazy-fetches the missing object and runs the planted ssh command (the plant is live).
    spawnSync('git', ['for-each-ref'], { cwd: wt, encoding: 'utf8', env: quiet, timeout: 30_000 });
    assert.match(f.ran(), /ssh /, 'plain git ran the planted ssh command');
    fs.rmSync(f.marker, { force: true });
    // w6023: config --blob reads its config from an object, so it lazy-fetches too.
    spawnSync('git', ['config', '--blob=refs/heads/missing', '--list'], { cwd: wt, encoding: 'utf8', env: quiet, timeout: 30_000 });
    assert.match(f.ran(), /ssh /, 'plain git config --blob ran the planted ssh command');
    fs.rmSync(f.marker, { force: true });

    for (const a of [['for-each-ref'], ['show-ref'], ['merge-base', 'master', 'refs/heads/missing'], ['rev-parse', 'refs/heads/missing^{commit}'], ['rev-parse', 'refs/heads/missing...master'], ['rev-parse', 'master..refs/heads/missing'], ['rev-parse', '--verify', '--quiet', 'refs/heads/missing'], ['rev-parse', '--abbrev-ref', 'HEAD'], ['symbolic-ref', '--short', 'HEAD'], ['worktree', 'list', '--porcelain'], ['config', '--get', 'remote.origin.url'], ['config', '--blob=refs/heads/missing', '--list'], ['config', '--blo', 'refs/heads/missing', '--list']])
      await run('git', ['-C', wt, ...a], { env: quiet });
    assert.equal(f.ran(), '', 'no planted program ran');

    // An older git ignores GIT_NO_LAZY_FETCH (w6005): the calls that skip the scan must start nothing without it too.
    for (const a of [['rev-parse', 'refs/heads/missing...master'], ['rev-parse', 'master..refs/heads/missing'], ['rev-parse', '--verify', '--quiet', 'refs/heads/missing'], ['rev-parse', 'refs/heads/missing'], ['rev-parse', '--abbrev-ref', 'HEAD'], ['symbolic-ref', '--short', 'HEAD'], ['worktree', 'list', '--porcelain'], ['config', '--get', 'remote.origin.url'], ['config', '--blob=refs/heads/missing', '--list'], ['config', '--blo', 'refs/heads/missing', '--list']]) {
      const g = gitFenceSync(['-C', wt, ...a], { env: quiet });
      const { GIT_NO_LAZY_FETCH: _, ...env } = g.env;
      spawnSync('git', g.args, { env, encoding: 'utf8', timeout: 30_000 });
    }
    assert.equal(f.ran(), '', 'no planted program ran without GIT_NO_LAZY_FETCH');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("w5541: a `.git` file pointing at a git folder the worker made runs none of that folder's programs from the daemon", { skip }, async () => {
  const f = fixture();
  try {
    const { main, wt } = worktree(f);
    // The worker copies the clone's git folder somewhere of its own, plants it, and points its worktree's `.git` there.
    const planted = path.join(f.root, 'planted');
    fs.cpSync(path.join(main, '.git'), planted, { recursive: true });
    const wtGit = path.join(planted, 'worktrees', path.basename(wt));
    fs.writeFileSync(path.join(wtGit, 'commondir'), slash(planted) + '\n');
    // Removed first: git for Windows hides a worktree's `.git` (core.hideDotFiles), and Windows refuses to open a hidden
    // file for writing (EPERM, w5810).
    fs.rmSync(path.join(wt, '.git'));
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${slash(wtGit)}\n`);
    plant(f, planted, path.join(planted, 'hooks'));

    touch(wt);
    spawnSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' });
    assert.match(f.ran(), /evil\.sh/, 'plain git ran the planted folder’s programs');
    fs.rmSync(f.marker, { force: true });

    touch(wt);
    const st = await readGitStatus(wt);
    assert.equal(st?.branch, 'sandbox/x');
    const commit = await run('git', ['-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-qam', 'x']);
    assert.equal(commit.code, 0, commit.stderr);
    assert.equal(f.ran(), '', 'no planted program ran');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w5541: git-lfs keeps its filter and the user’s credential helper stays when a repository overrides them', { skip }, async () => {
  const f = fixture();
  try {
    const { main, wt } = worktree(f);
    git(main, 'config', 'filter.lfs.clean', `${f.evil} lfs`);
    git(main, 'config', 'credential.helper', `!${f.evil} cred`);
    // What git would use, as `git config` reports it under the fence's environment.
    const { gitFence } = await import('./safeGit.ts');
    const fenced = await gitFence(['-C', wt, 'status'], { env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(f.root, 'gc') } });
    // --get answers the value git uses (the last one); --get-all lists every helper in order.
    const raw = (k: string, all = false) => spawnSync('git', ['-C', wt, 'config', all ? '--get-all' : '--get', k], { env: fenced.env, encoding: 'utf8' }).stdout;
    const get = (k: string) => raw(k).trim();
    assert.equal(get('filter.lfs.clean'), 'git-lfs clean -- %f');
    assert.equal(get('core.fsmonitor'), 'false');
    // git keeps the helpers after the last empty one (credential.c). Not trimmed: with no trusted helper after it (a
    // runner with no system helper), the fence's empty entry is the last line (w5583).
    const helpers = raw('credential.helper', true).replace(/\r?\n$/, '').split(/\r?\n/);
    assert.ok(!helpers.slice(helpers.lastIndexOf('') + 1).some((h) => h.includes('evil')), helpers.join(' | '));
    assert.equal(f.ran(), '');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w5573: a repository-set url.insteadOf refuses the daemon’s push and fetch, and leaves status alone', { skip }, async () => {
  const f = fixture();
  try {
    const { main, wt } = worktree(f);
    // origin is a bare repository; the worker plants a rewrite of it to a repository of its own (a token would go there).
    const origin = path.join(f.root, 'origin.git');
    const theirs = path.join(f.root, 'theirs.git');
    git(f.root, 'init', '-q', '--bare', origin);
    git(f.root, 'init', '-q', '--bare', theirs);
    git(main, 'remote', 'add', 'origin', slash(origin));
    git(main, 'config', `url.${slash(theirs)}.insteadOf`, slash(origin));
    // Control: plain git follows the plant.
    git(wt, 'push', '-q', 'origin', 'sandbox/x');
    git(f.root, '--git-dir', theirs, 'rev-parse', '--verify', 'refs/heads/sandbox/x');
    git(f.root, '--git-dir', theirs, 'update-ref', '-d', 'refs/heads/sandbox/x');
    const push = await run('git', ['-C', wt, 'push', 'origin', 'sandbox/x']);
    assert.notEqual(push.code, 0);
    assert.match(push.stderr, /refused-by-FF-Factory/);
    assert.equal(spawnSync('git', ['--git-dir', theirs, 'rev-parse', '--verify', '--quiet', 'refs/heads/sandbox/x']).status, 1, 'nothing reached the planted remote');
    assert.notEqual((await run('git', ['-C', wt, 'fetch', 'origin'])).code, 0);
    assert.equal((await run('git', ['-C', wt, 'status', '--porcelain'])).code, 0, 'a call that reaches no remote still runs');
    // Without the plant the push goes to origin.
    git(main, 'config', '--unset', `url.${slash(theirs)}.insteadOf`);
    const ok = await run('git', ['-C', wt, 'push', 'origin', 'sandbox/x']);
    assert.equal(ok.code, 0, ok.stderr);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w6650: remote add with its fetch is refused in every checkout, in any spelling; a plain remote add passes', () => {
  for (const a of [
    ['remote', 'add', '-f', 'c', 'u'],
    ['remote', 'add', '--f', 'c', 'u'],
    ['remote', 'add', '--fe', 'c', 'u'],
    ['remote', 'add', '--fetch', 'c', 'u'],
    ['remote', 'add', '-ftmaster', 'c', 'u'],
    ['remote', 'add', '-tmaster', '-f', 'c', 'u'],
    ['remote', 'add', 'c', 'u', '-f'],
    ['-C', 'd', 'remote', 'add', '--tags', '-f', 'c', 'u'],
    // remote's own -v before the verb (w6652's review of PR #1534).
    ['remote', '-v', 'add', '-f', 'c', 'u'],
    ['remote', '--verbose', 'add', '-f', 'c', 'u'],
    ['remote', '--v', 'add', '--fetch', 'c', 'u'],
    ['remote', '--', 'add', '-f', 'c', 'u'],
  ])
    assert.match(refusal(a, []) ?? '', /refused by FF Factory \(w6650\)/, a.join(' '));
  for (const a of [
    ['remote', 'add', 'origin', 'u'],
    ['remote', 'add', '-tf', 'c', 'u'],
    ['remote', 'add', '-mf', 'c', 'u'],
    ['remote', 'add', '--no-fetch', 'c', 'u'],
    ['remote', 'add', '--tags', 'c', 'u'],
    ['remote', 'add', 'c', '--', '-f'],
    ['remote', 'set-url', 'c', '-f'],
  ])
    assert.equal(refusal(a, []), undefined, a.join(' '));
});

test('w6632: only a scan that read the whole config passes; a cut-short scan refuses', () => {
  assert.equal(scanCut(0, '', 'local\0x\ny\0'), undefined);
  assert.equal(scanCut(1, '', ''), undefined, 'no such key');
  assert.equal(scanCut(128, '', ''), undefined, 'not a repository: git fails the call itself');
  assert.equal(scanCut(null, 'ENOENT', ''), undefined, 'no git or no folder: the call fails the same way');
  assert.equal(scanCut(null, 'ENOBUFS', 'local\0x\ny\0'), 'ENOBUFS');
  assert.equal(scanCut(null, 'ETIMEDOUT', ''), 'ETIMEDOUT');
  assert.equal(scanCut(null, 'SIGKILL', ''), 'SIGKILL');
  assert.equal(scanCut(128, '', 'local\0x\ny\0'), 'exit 128', 'a scan that died after printing rows read only part');
  assert.equal(scanCut(3, '', ''), 'exit 3');
});

test('w6632: a scanned key past the scan’s output limit runs on plain git, never through the fence', { skip }, async () => {
  const f = fixture();
  try {
    const { main, wt } = worktree(f);
    const origin = path.join(f.root, 'origin.git');
    const theirs = path.join(f.root, 'theirs.git');
    git(f.root, 'init', '-q', '--bare', origin);
    git(f.root, 'init', '-q', '--bare', theirs);
    git(main, 'remote', 'add', 'origin', slash(origin));
    // 5 MiB of a scanned key ahead of the plant (w6629's repro): the scan prints more than SCAN_MAX_BUFFER and is cut short.
    const cfg = path.join(main, '.git', 'config');
    fs.appendFileSync(cfg, `[remotes]\n\tpad = ${'x'.repeat(5 * 1024 * 1024)}\n[url "${slash(theirs)}"]\n\tinsteadOf = ${slash(origin)}\n`);
    // Control: plain git follows the plant.
    git(wt, 'push', '-q', 'origin', 'sandbox/x');
    git(f.root, '--git-dir', theirs, 'update-ref', '-d', 'refs/heads/sandbox/x');
    const sync = gitSpawnSync(['push', 'origin', 'sandbox/x'], { cwd: wt, encoding: 'utf8', timeout: 60_000 });
    const proc = await run('git', ['-C', wt, 'push', 'origin', 'sandbox/x']);
    const off = await gitOffThread(['push', 'origin', 'sandbox/x'], { cwd: wt, timeoutMs: 60_000 });
    for (const [name, code, err] of [['gitSpawnSync', sync.status, sync.stderr], ['run', proc.code, proc.stderr], ['gitOffThread', off.code, off.stderr]] as const) {
      assert.notEqual(code, 0, name);
      assert.match(String(err), /refused-by-FF-Factory-\(w6632\)/, `${name}: ${err}`);
    }
    assert.equal(spawnSync('git', ['--git-dir', theirs, 'rev-parse', '--verify', '--quiet', 'refs/heads/sandbox/x']).status, 1, 'nothing reached the planted remote');
    assert.match(String(gitSpawnSync(['status'], { cwd: wt, encoding: 'utf8', timeout: 60_000 }).stderr), /w6632/, 'every scanned call fails closed');
    // Without the padding the same push is refused by w5573, which the cut scan hid.
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/\[remotes\]\n\tpad = x+\n/, ''));
    const plain = gitSpawnSync(['push', 'origin', 'sandbox/x'], { cwd: wt, encoding: 'utf8', timeout: 60_000 });
    assert.match(String(plain.stderr), /refused-by-FF-Factory-\(w5573\)/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w6570: a clone’s planted uploadpack and receivepack run on plain git, never through the fence', { skip }, async () => {
  const f = fixture();
  try {
    const { main } = worktree(f);
    const bare = path.join(f.root, 'bare.git');
    git(f.root, 'clone', '-q', '--bare', '--no-local', slash(main), bare);
    const victim = path.join(f.root, 'victim');
    git(f.root, 'clone', '-q', '--no-local', slash(bare), victim);
    // Logs and exits without speaking the protocol (the fixture's evil.sh reads stdin, which git never closes here).
    const pack = slash(path.join(f.root, 'pack.sh'));
    fs.writeFileSync(pack, `#!/bin/sh\necho "pack $*" >> '${f.marker}'\nexit 1\n`, { mode: 0o755 });
    git(victim, 'config', 'remote.origin.uploadpack', pack);
    git(victim, 'config', 'remote.origin.receivepack', pack);
    git(victim, 'commit', '-q', '--allow-empty', '-m', 'v');

    // Control: plain git runs both, and the fence's old override by value (`-c`, read last) does not stop it: git keeps the first.
    spawnSync('git', ['-C', victim, '-c', 'remote.origin.uploadpack=git-upload-pack', 'fetch', 'origin'], { encoding: 'utf8', timeout: 30_000 });
    assert.match(f.ran(), /pack /, 'plain git fetch ran the planted uploadpack');
    fs.rmSync(f.marker, { force: true });
    spawnSync('git', ['-C', victim, '-c', 'remote.origin.receivepack=git-receive-pack', 'push', 'origin', 'HEAD:refs/heads/v0'], { encoding: 'utf8', timeout: 30_000 });
    assert.match(f.ran(), /pack /, 'plain git push ran the planted receivepack');
    fs.rmSync(f.marker, { force: true });

    // The fence: the sync wrapper and run() (server/proc.ts) fetch, list and pull, and each works.
    const fetch = gitSpawnSync(['fetch', 'origin'], { cwd: victim, encoding: 'utf8', timeout: 30_000 });
    assert.equal(fetch.status, 0, fetch.stderr);
    const ls = await run('git', ['-C', victim, 'ls-remote', 'origin']);
    assert.equal(ls.code, 0, ls.stderr);
    const pull = await run('git', ['-C', victim, '-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'pull', '-q', '--no-rebase', 'origin', 'master']);
    assert.equal(pull.code, 0, pull.stderr);
    assert.equal(f.ran(), '', 'no planted program ran on a fenced fetch, ls-remote or pull');
    // Every other call in this checkout runs with lazy fetch off (a partial clone's lazy fetch starts the uploadpack too).
    assert.equal(gitFenceSync(['status'], { cwd: victim }).env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(gitFenceSync(['status'], { cwd: main }).env.GIT_NO_LAZY_FETCH, undefined, 'a checkout that plants nothing keeps it');
    // The calls no option reaches are refused and run nothing: a push with both keys planted (git-lfs's pre-push hook runs
    // `git ls-remote origin`, which starts the uploadpack, measured), `fetch --all`, and, with two remotes and a group named
    // origin (review of PR #1523), `fetch origin` and `pull --all`, which start a child fetch per remote. `remote -v` runs.
    for (const r of ['b', 'c']) {
      git(victim, 'remote', 'add', r, slash(bare));
      git(victim, 'config', `remote.${r}.uploadpack`, pack);
    }
    git(victim, 'config', 'remotes.origin', 'b c');
    for (const a of [['push', 'origin', 'HEAD:refs/heads/v0'], ['fetch', '--prune', 'origin']]) {
      const r = gitSpawnSync(a, { cwd: victim, encoding: 'utf8', timeout: 30_000 });
      assert.notEqual(r.status, 0, a.join(' '));
      assert.match(String(r.stderr), /w6570/, a.join(' '));
    }
    for (const a of [['push', 'origin', 'HEAD:refs/heads/v0'], ['fetch', '--all'], ['pull', '--all', '--ff-only']]) {
      const r = await run('git', ['-C', victim, ...a]);
      assert.notEqual(r.code, 0, a.join(' '));
      assert.match(r.stderr, /w6570/, a.join(' '));
    }
    assert.equal(gitSpawnSync(['remote', '-v'], { cwd: victim, encoding: 'utf8', timeout: 30_000 }).status, 0);
    assert.equal(f.ran(), '', 'no refused call ran a planted program');
    assert.throws(() => git(f.root, '--git-dir', bare, 'rev-parse', '--verify', '-q', 'refs/heads/v0'), 'the refused push sent nothing');
    git(victim, 'config', '--unset', 'remotes.origin');
    git(victim, 'remote', 'remove', 'b');
    git(victim, 'remote', 'remove', 'c');
    // With only receivepack planted the push runs nothing of the worker's: --receive-pack replaces it.
    git(victim, 'config', '--unset', 'remote.origin.uploadpack');
    const push = gitSpawnSync(['push', 'origin', 'HEAD:refs/heads/v1'], { cwd: victim, encoding: 'utf8', timeout: 30_000 });
    assert.equal(push.status, 0, push.stderr);
    assert.equal(git(f.root, '--git-dir', bare, 'rev-parse', 'refs/heads/v1').trim(), git(victim, 'rev-parse', 'HEAD').trim());
    const push2 = await run('git', ['-C', victim, 'push', 'origin', 'HEAD:refs/heads/v2']);
    assert.equal(push2.code, 0, push2.stderr);
    assert.equal(f.ran(), '', 'no planted program ran through the fence');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w6570: a repository-set protocol.ext.allow runs an ext:: command on plain git, never through the fence', { skip }, async () => {
  const f = fixture();
  try {
    const me = path.join(f.root, 'me');
    git(f.root, 'init', '-q', me);
    const cmd = slash(path.join(f.root, 'ext.sh'));
    fs.writeFileSync(cmd, `#!/bin/sh\necho "ext $*" >> '${f.marker}'\nexit 1\n`, { mode: 0o755 });
    git(me, 'config', 'protocol.ext.allow', 'always');
    git(me, 'remote', 'add', 'x', `ext::sh ${cmd}`);
    spawnSync('git', ['-C', me, 'fetch', 'x'], { encoding: 'utf8', timeout: 30_000 });
    assert.match(f.ran(), /ext /, 'plain git ran the ext:: command');
    fs.rmSync(f.marker, { force: true });
    const r = await run('git', ['-C', me, 'fetch', 'x']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /transport 'ext' not allowed/);
    assert.equal(f.ran(), '', 'the fence ran no ext:: command');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w6650: an uploadpack that an includeIf switches on only after remote add writes the URL runs on plain git, never through the fence', { skip }, async () => {
  const f = fixture();
  try {
    const { main } = worktree(f);
    const c2 = path.join(f.root, 'c2.git');
    git(f.root, 'clone', '-q', '--bare', '--no-local', slash(main), c2);
    const pack = slash(path.join(f.root, 'pack.sh'));
    fs.writeFileSync(pack, `#!/bin/sh\necho "pack $*" >> '${f.marker}'\nexit 1\n`, { mode: 0o755 });
    const plant = slash(path.join(f.root, 'plant.cfg'));
    fs.writeFileSync(plant, `[remote "c"]\n\tuploadpack = ${pack}\n`);
    fs.appendFileSync(path.join(main, '.git', 'config'), `[includeIf "hasconfig:remote.*.url:**/c2.git"]\n\tpath = ${plant}\n`);
    // Control (w6649's repro): plain git's remote add -f runs the plant, which the scan before the call cannot see.
    assert.equal(gitFenceSync(['remote', 'add', 'c', slash(c2)], { cwd: main }).args.some((a) => /refused/.test(a)), false, 'nothing to see before');
    spawnSync('git', ['-C', main, 'remote', 'add', '-f', 'c', slash(c2)], { encoding: 'utf8', timeout: 30_000 });
    assert.match(f.ran(), /pack /, 'plain git remote add -f ran the planted uploadpack');
    git(main, 'remote', 'remove', 'c');
    fs.rmSync(f.marker, { force: true });

    for (const o of [['add', '-f'], ['add', '--fetch'], ['add', '-ftmaster'], ['-v', 'add', '-f']]) {
      const a = ['remote', ...o, 'c', slash(c2)];
      const sync = gitSpawnSync(a, { cwd: main, encoding: 'utf8', timeout: 30_000 });
      const proc = await run('git', ['-C', main, ...a]);
      const off = await gitOffThread(a, { cwd: main, timeoutMs: 30_000 });
      for (const [name, code, err] of [['gitSpawnSync', sync.status, sync.stderr], ['run', proc.code, proc.stderr], ['gitOffThread', off.code, off.stderr]] as const) {
        assert.notEqual(code, 0, `${name} ${o}`);
        assert.match(String(err), /refused-by-FF-Factory-\(w6650\)/, `${name} ${o}: ${err}`);
      }
      assert.ok(gitFenceSync(a, { cwd: main }).args.some((x) => /refused-by-FF-Factory-\(w6650\)/.test(x)), `gitFenceSync ${o}`);
    }
    assert.equal(f.ran(), '', 'no planted program ran');
    assert.equal(spawnSync('git', ['-C', main, 'remote'], { encoding: 'utf8' }).stdout.split(/\r?\n/).includes('c'), false, 'no remote was added');
    // The same work in two steps, each scanned: the plain remote add passes, and the fetch then sees the plant and is refused.
    const add = gitSpawnSync(['remote', 'add', 'c', slash(c2)], { cwd: main, encoding: 'utf8', timeout: 30_000 });
    assert.equal(add.status, 0, add.stderr);
    const fetch = gitSpawnSync(['fetch', '--all'], { cwd: main, encoding: 'utf8', timeout: 30_000 });
    assert.match(String(fetch.stderr), /w6570/);
    assert.equal(f.ran(), '', 'no planted program ran on the two-step route');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w6082: a planted core.alternateRefsCommand runs on a plain fetch through an alternate, never through the fence', { skip }, async () => {
  const f = fixture();
  try {
    const { main } = worktree(f);
    // The repository a worker points its alternates at, and the one it plants the command in.
    const alt = path.join(f.root, 'alt.git');
    git(f.root, 'clone', '-q', '--bare', slash(main), alt);
    const me = path.join(f.root, 'me');
    git(f.root, 'init', '-q', '-b', 'master', me);
    fs.writeFileSync(path.join(me, '.git', 'objects', 'info', 'alternates'), `${slash(path.join(alt, 'objects'))}\n`);
    // A command that logs and prints no refs (the fixture's evil.sh reads stdin, which git never closes here).
    const cmd = slash(path.join(f.root, 'alt.sh'));
    fs.writeFileSync(cmd, `#!/bin/sh\necho "alternateRefsCommand $*" >> '${f.marker}'\nexit 0\n`, { mode: 0o755 });
    git(me, 'config', 'core.alternateRefsCommand', cmd);
    fs.writeFileSync(path.join(main, 'b.txt'), 'b\n');
    git(main, 'add', 'b.txt');
    git(main, 'commit', '-qm', 'b');

    // Control: plain git runs the planted command on a fetch (the plant is live).
    spawnSync('git', ['-C', me, 'fetch', '-q', slash(main), 'master'], { encoding: 'utf8', timeout: 30_000 });
    assert.match(f.ran(), /alternateRefsCommand /, 'plain git fetch ran the planted command');
    fs.rmSync(f.marker, { force: true });

    // The fence: run() (server/proc.ts) and the sync wrapper fetch, and the fetch still works.
    const a = await run('git', ['-C', me, 'fetch', '-q', slash(main), 'master:refs/heads/a']);
    assert.equal(a.code, 0, a.stderr);
    gitExecFileSync(['-C', me, 'fetch', '-q', slash(main), 'master:refs/heads/b'], { encoding: 'utf8' });
    assert.equal(gitExecFileSync(['-C', me, 'rev-parse', 'refs/heads/b'], { encoding: 'utf8' }).trim(), git(main, 'rev-parse', 'master').trim());
    // The calls that skip the scan (needsScan) carry the fixed keys too.
    for (const args of [['rev-parse', '--verify', '--quiet', 'refs/heads/a'], ['symbolic-ref', '--short', 'HEAD'], ['config', '--get', 'core.alternateRefsCommand'], ['worktree', 'list', '--porcelain']])
      await run('git', ['-C', me, ...args]);
    assert.equal(f.ran(), '', 'no planted program ran');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w6630: a call that recurses into submodules by its own option is refused; add and rm list the gitlinks they cover', () => {
  for (const a of [['submodule', 'update', '--init'], ['-C', 'x', 'submodule', 'status'], ['fetch', '--recurse-submodules'], ['pull', '--recurse-submodules=on-demand'], ['checkout', '--recurse-sub', 'main'], ['status', '--ignore-submodules=none'], ['diff', '--ignore-submodules=untracked']])
    assert.ok(submoduleRecursion(a), a.join(' '));
  // w6648: routes SUBMODULE_GIT_CONFIG does not stop.
  for (const a of [['diff', '--submodule=diff', 'HEAD~1', 'HEAD'], ['log', '-p', '--submodule'], ['show', '--submod=log'], ['submodule--helper', 'update', '--remote'], ['-c', 'fetch.recurseSubmodules=yes', 'fetch'], ['-csubmodule.recurse=true', 'pull'], ['-c', 'diff.submodule=diff', 'diff'], ['-c', 'submodule.sub.ignore=none', 'status'], ['--config-env=submodule.recurse=X', 'fetch'], ['--config-env', 'diff.submodule=X', 'diff']]) {
    assert.ok(submoduleRecursion(a), a.join(' '));
    assert.match(refusal(a, []) ?? '', /^refused by FF Factory \(w6630\): `git [a-z-]+` recurses into submodules.*git -C <submodule>/, a.join(' '));
  }
  for (const a of [['fetch', 'origin'], ['fetch', '--no-recurse-submodules'], ['pull', '--recurse-submodules=no'], ['fetch', '--recurse-submodules-default=yes'], ['clone', '--recurse-submodules', 'u', 'd'], ['status', '--ignore-submodules=dirty'], ['log', '--', '--recurse-submodules'], ['diff', '--submodule=short'], ['fetch', '--submodule-prefix=x/'], ['-c', 'fetch.recurseSubmodules=false', 'fetch'], ['-c', 'diff.submodule=short', 'diff'], ['-c', 'user.name=t', 'commit']]) {
    assert.equal(submoduleRecursion(a), undefined, a.join(' '));
    assert.equal(refusal(a, []), undefined, a.join(' '));
  }
  // A global option with its value missing puts the subcommand past the end (Windows CI, scripts/updatePath.test.ts).
  assert.equal(submoduleRecursion(['-C']), undefined);
  assert.equal(submoduleRecursion(['-c']), undefined);
  // add and rm: the pathspec as given (from where the call runs), else the whole index.
  const ls = ['ls-files', '-s', '-z', '--'];
  assert.deepEqual(gitlinkListArgs(['add', '-A']), [...ls, ':/']);
  assert.deepEqual(gitlinkListArgs(['add', '-u', '--pathspec-from-file=list']), [...ls, ':/']);
  assert.deepEqual(gitlinkListArgs(['-C', 'x', 'rm', '-r', '-q', '--cached', 'sub', 'b']), ['-C', 'x', ...ls, 'sub', 'b']);
  assert.deepEqual(gitlinkListArgs(['add', '--chmod', '+x', 'f', '--', '-odd', ':!sub']), [...ls, 'f', '-odd', ':!sub']);
  assert.equal(gitlinkListArgs(['status']), undefined);
  // w6691: any prefix of --pathspec-from-file git takes; the call's pathspec options; a literal call's pathspec stays literal.
  assert.deepEqual(gitlinkListArgs(['add', '--pathspec-fr', 'list.txt']), [...ls, ':/']);
  assert.deepEqual(gitlinkListArgs(['rm', '--pathspec-from=l', 'x']), [...ls, ':/']);
  assert.deepEqual(gitlinkListArgs(['add', '--chm', '+x', 'f']), [...ls, 'f']);
  assert.deepEqual(gitlinkListArgs(['--icase-pathspecs', '-C', 'x', 'add', 'SUB']), ['-C', 'x', '--icase-pathspecs', ...ls, 'SUB']);
  assert.deepEqual(gitlinkListArgs(['--literal-pathspecs', 'add', 'su*']), [...ls, ':(literal)su*']);
  assert.deepEqual(gitlinkListArgs(['add', 'su*'], { GIT_LITERAL_PATHSPECS: '1' }), [...ls, ':(literal)su*']);
  assert.deepEqual(gitlinkListArgs(['add', 'su*'], { GIT_LITERAL_PATHSPECS: '' }), [...ls, 'su*']);
  assert.deepEqual(gitlinkListArgs(['--literal-pathspecs', 'add', '-A']), [...ls, ':/'], 'the listing runs with literal pathspecs off');
  assert.deepEqual(gitlinkListArgs(['mv', '-k', 'sub', 'sub2']), [...ls, 'sub', 'sub2']);
  // w6691: calls that look into every submodule whatever any option says list the whole index.
  for (const a of [['commit', '-a'], ['commit', '-q', '-m', 'x', '--', 'f'], ['stash'], ['stash', '-q'], ['stash', 'push', '-q'], ['stash', 'save', 'x'], ['stash', 'create'], ['stash', 'branch', 'b'], ['describe', '--dirty'], ['describe', '--always', '--broken=-b'], ['describe', '--dir'], ['rebase', '--autostash', 'main'], ['merge', '--autos', 'x'], ['pull', '--autostash'], ['-c', 'rebase.autoStash=true', 'rebase', 'main'], ['-cmerge.autostash', 'merge', 'x'], ['--config-env=rebase.autostash=V', 'pull'], ['merge', 'x'], ['merge', '--no-ff', '-m', 'x', 'x'], ['merge', '--squash', 'x'], ['merge', '--continue'], ['merge', '--ff', 'x'], ['pull'], ['pull', '--no-rebase', '.', 'x'], ['pull', '--rebase'], ['difftool', '-y'], ['mergetool'], ['merge', '--ff-o', 'x'], ['merge', '--ff-only', '--no-ff', '-m', 'x', 'x'], ['merge', '--ff-only', '--ff', 'x'], ['merge', '--no-ff', '-m', '--ff-only', 'x'], ['merge', '-m', '--abort', '--no-ff', 'x'], ['merge', '-m', '--quit', 'x'], ['merge', '--abort', 'x'], ['merge', '--ff-only', '--', 'x'], ['pull', '--ff-only', '--no-ff', '.', 'x'], ['pull', '--ff-only', '--ff', '.', 'x'], ['pull', '--ff-only', '--rebase']]) {
    assert.ok(wholeIndexCall(a), a.join(' '));
    assert.deepEqual(gitlinkListArgs(a), [...ls, ':/'], a.join(' '));
  }
  for (const a of [['stash', 'list'], ['stash', 'pop'], ['stash', 'show', '-p'], ['describe', '--tags'], ['describe', '--', '--dirty'], ['rebase', 'main'], ['rebase', '--no-autostash', 'main'], ['merge', '--ff-only', '@{u}'], ['merge', '--ff-only', '--quiet', 'origin/main'], ['merge', '-q', '--ff-only', 'x'], ['merge', '--abort'], ['merge', '--quit'], ['pull', '--ff-only'], ['pull', '-q', '--ff-only', 'origin', 'main'], ['-c', 'rebase.autoStash=false', 'rebase', 'main'], ['checkout', 'main'], ['status']]) {
    assert.ok(!wholeIndexCall(a), a.join(' '));
    assert.equal(gitlinkListArgs(a), undefined, a.join(' '));
  }
  // w6731: a name git would run as an alias is refused; a command passes, whatever aliases say.
  const aliases = [{ key: 'alias.st' }, { key: 'alias.cm' }, { key: 'alias.dt' }, { key: 'alias.status' }, { key: 'alias.commit' }];
  for (const a of [['st'], ['-C', 'x', 'cm', '-m', 'x'], ['ST'], ['--git-dir=x', 'dt', '-y']]) assert.match(aliasRefusal(a, aliases) ?? '', /^refused by FF Factory \(w6731\): `git .*alias\.(st|cm|dt)\b/, a.join(' '));
  for (const a of [['-c', 'alias.co=checkout', 'co'], ['-calias.co=checkout', 'co'], ['--config-env=alias.CO=V', 'co'], ['-c', 'Alias.Co=checkout', 'CO']]) assert.match(aliasRefusal(a, []) ?? '', /w6731/, a.join(' '));
  for (const a of [['status'], ['-c', 'alias.status=diff', 'status'], ['-C', 'x', 'commit', '-m', 'x'], ['stash', 'list'], ['lfs', 'pull'], ['co'], ['--version'], []]) assert.equal(aliasRefusal(a, a[0] === 'co' ? [] : aliases), undefined, a.join(' '));
  assert.match(gitlinkCovered(['commit', '-m', 'x'], 0, '160000 bb 0\tlib/sub\0') ?? '', /^refused by FF Factory \(w6630\): `git commit` runs in a repository with the submodule lib\/sub.*`ignore` setting.*git -C lib\/sub/);
  assert.equal(gitlinkCovered(['commit', '-m', 'x'], 0, '100644 aa 0\ta.txt\0'), undefined);
  assert.equal(gitlinkIn('100644 aa 0\ta.txt\x00160000 bb 0\tlib/sub\0'), 'lib/sub');
  assert.equal(gitlinkIn('100644 aa 0\ta.txt\0'), undefined);
  assert.match(gitlinkCovered(['rm', 'lib/sub'], 0, '160000 bb 0\tlib/sub\0') ?? '', /^refused by FF Factory \(w6630\): `git rm` covers the submodule lib\/sub.*':!lib\/sub'.*git -C lib\/sub/);
  assert.equal(gitlinkCovered(['add', '-A'], 0, '100644 aa 0\ta.txt\0'), undefined);
  assert.equal(gitlinkCovered(['add', '-A'], 0, ''), undefined);
  assert.equal(gitlinkCovered(['add', 'x'], 128, ''), undefined, 'not a repository: the call fails by itself');
  assert.match(gitlinkCovered(['add', '-A'], 1, '') ?? '', /w6630.*could not list the submodules `git add` covers \(exit 1\)/);
  assert.match(gitlinkCovered(['add', '-A'], null, '') ?? '', /w6630.*\(no exit\)/);
});

test('w6630: every scanned call runs with SUBMODULE_GIT_CONFIG; a call that skips the scan does not', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w6630-forced-'));
  try {
    git(dir, 'init', '-q');
    const keys = (env: NodeJS.ProcessEnv) => Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`);
    const forced = SUBMODULE_GIT_CONFIG.map(([k, v]) => `${k}=${v}`);
    for (const k of forced) assert.ok(keys(gitFenceSync(['status'], { cwd: dir, env: {} }).env).includes(k), k);
    // `git config` reads would see the forced value.
    assert.ok(!keys(gitFenceSync(['config', '--get', 'submodule.recurse'], { cwd: dir, env: {} }).env).includes('submodule.recurse=false'));
    // add and rm with no gitlink pass.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    assert.equal(gitSpawnSync(['add', '-A'], { cwd: dir, encoding: 'utf8' }).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w6630: a submodule’s planted uploadpack and filter run on plain git, never through the fence', { skip }, async () => {
  const f = fixture();
  const sg = (cwd: string, ...a: string[]) => git(cwd, '-c', 'protocol.file.allow=always', ...a);
  try {
    const subsrc = path.join(f.root, 'subsrc');
    fs.mkdirSync(subsrc);
    sg(subsrc, 'init', '-q', '-b', 'master');
    fs.writeFileSync(path.join(subsrc, 'a.txt'), 'one\n');
    sg(subsrc, 'add', '.');
    sg(subsrc, 'commit', '-qm', 's1');
    const seed = path.join(f.root, 'seed');
    fs.mkdirSync(seed);
    sg(seed, 'init', '-q', '-b', 'master');
    sg(seed, 'submodule', 'add', '-q', slash(subsrc), 'sub');
    fs.writeFileSync(path.join(seed, 'top.txt'), 'top\n');
    sg(seed, 'add', '.');
    sg(seed, 'commit', '-qm', 'super1');
    const up = path.join(f.root, 'up.git');
    sg(f.root, 'clone', '-q', '--bare', slash(seed), up);
    const victim = path.join(f.root, 'victim');
    sg(f.root, 'clone', '-q', '--recurse-submodules', slash(up), victim);
    // Moves the gitlink upstream, so a default (on-demand) fetch of the superproject fetches the submodule too.
    let n = 0;
    const advance = () => {
      n++;
      fs.writeFileSync(path.join(subsrc, 'a.txt'), `s${n}\n`);
      sg(subsrc, 'commit', '-qam', `s${n}`);
      const w = path.join(f.root, `w${n}`);
      sg(f.root, 'clone', '-q', '--recurse-submodules', slash(up), w);
      sg(path.join(w, 'sub'), 'pull', '-q', 'origin', 'master');
      sg(w, 'commit', '-qam', `super${n}`);
      sg(w, 'push', '-q', 'origin', 'master');
    };
    const pack = slash(path.join(f.root, 'pack.sh'));
    fs.writeFileSync(pack, `#!/bin/sh\necho "pack $*" >> '${f.marker}'\nexit 1\n`, { mode: 0o755 });
    const ext = slash(path.join(f.root, 'ext.sh'));
    fs.writeFileSync(ext, `#!/bin/sh\necho "ext $1" >> '${f.marker}'\nexit 0\n`, { mode: 0o755 });
    const mod = path.join(victim, '.git', 'modules', 'sub');
    const cfg = path.join(mod, 'config');
    git(f.root, 'config', '--file', cfg, 'remote.origin.uploadpack', pack);
    git(f.root, 'config', '--file', cfg, 'filter.w.clean', `${f.evil} clean`);
    git(f.root, 'config', '--file', cfg, 'diff.external', ext);
    fs.mkdirSync(path.join(mod, 'info'), { recursive: true });
    fs.writeFileSync(path.join(mod, 'info', 'attributes'), '*.txt filter=w\n');
    // Same bytes, a new time: the child git must run the clean filter to see that the file is unchanged.
    const touch = () => {
      const a = path.join(victim, 'sub', 'a.txt');
      fs.writeFileSync(a, fs.readFileSync(a));
      fs.utimesSync(a, new Date(), new Date(Date.now() + 5000));
    };
    const fenced = (...a: string[]) => {
      fs.rmSync(f.marker, { force: true });
      touch();
      return gitSpawnSync(a, { cwd: victim, encoding: 'utf8', timeout: 60_000 });
    };
    const plain = (...a: string[]) => {
      fs.rmSync(f.marker, { force: true });
      touch();
      return spawnSync('git', ['-c', 'protocol.file.allow=always', ...a], { cwd: victim, encoding: 'utf8', timeout: 60_000 });
    };

    // The gap, on plain git: a fetch runs the submodule's uploadpack, a status its filter.
    advance();
    plain('fetch', 'origin');
    assert.match(f.ran(), /pack /, 'plain git: the submodule’s uploadpack ran on a plain fetch');
    plain('status', '--porcelain');
    assert.match(f.ran(), /clean/, 'plain git: the submodule’s filter ran on a status');

    // Through the fence, SUBMODULE_GIT_CONFIG is forced: a fetch, a pull, a status and a diff run nothing of the submodule's.
    advance();
    const fetch = fenced('fetch', 'origin');
    assert.equal(fetch.status, 0, fetch.stderr);
    assert.equal(f.ran(), '', 'fence: fetch');
    advance();
    const pull = fenced('-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', 'pull', '-q', '--ff-only', 'origin', 'master');
    assert.equal(pull.status, 0, pull.stderr);
    assert.equal(f.ran(), '', 'fence: pull');
    // The submodule at the commit the gitlink names (the pulls moved it; rm compares its HEAD before it looks inside).
    sg(path.join(victim, 'sub'), 'fetch', '-q', '--upload-pack=git-upload-pack', 'origin');
    spawnSync('git', ['-c', 'filter.w.clean=cat', 'checkout', '-q', '-f', git(victim, 'rev-parse', 'HEAD:sub').trim()], { cwd: path.join(victim, 'sub') });
    for (const a of [['status', '--porcelain'], ['diff'], ['diff', 'HEAD~1', 'HEAD'], ['stash', 'list']]) {
      const r = fenced(...a);
      assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`);
      assert.equal(f.ran(), '', `fence: ${a.join(' ')}`);
    }
    // w6648 B: the superproject's diff.submodule=diff runs the submodule's diff.external on plain git; the forced short stops it.
    git(victim, 'config', 'diff.submodule', 'diff');
    plain('diff', 'HEAD~1', 'HEAD');
    assert.match(f.ran(), /ext /, 'plain git: diff.submodule=diff runs the submodule’s diff.external');
    fenced('diff', 'HEAD~1', 'HEAD');
    assert.equal(f.ran(), '', 'fence: diff.submodule=short stops it');
    git(victim, 'config', '--unset', 'diff.submodule');

    // What forcing cannot stop is refused, and runs nothing: A (an explicit --submodule=diff), recursion by option, D (rm), add -A.
    plain('diff', '--submodule=diff', 'HEAD~1', 'HEAD');
    assert.match(f.ran(), /ext /, 'plain git: an explicit --submodule=diff runs the submodule’s diff.external');
    for (const a of [['diff', '--submodule=diff', 'HEAD~1', 'HEAD'], ['fetch', '--recurse-submodules', 'origin'], ['-c', 'diff.submodule=log', 'diff', 'HEAD~1', 'HEAD'], ['submodule', 'status']]) {
      const r = fenced(...a);
      assert.notEqual(r.status, 0, a.join(' '));
      assert.match(r.stderr, /w6630/, a.join(' '));
      assert.equal(f.ran(), '', `fence: ${a.join(' ')}`);
    }
    for (const a of [['rm', '-n', '-q', 'sub'], ['rm', '-n', '-q', '--cached', 'sub'], ['rm', '-n', '-r', '-q', '.'], ['add', '-A'], ['add', '.'], ['add', '-u']]) {
      plain(...a);
      assert.match(f.ran(), /clean/, `plain git: ${a.join(' ')} runs the submodule’s filter`);
      const r = fenced(...a);
      assert.notEqual(r.status, 0, a.join(' '));
      assert.match(r.stderr, /w6630/, a.join(' '));
      assert.equal(f.ran(), '', `fence: ${a.join(' ')}`);
    }
    // The other two entry points refuse the same.
    fs.rmSync(f.marker, { force: true });
    const off = await gitOffThread(['add', '-A'], { cwd: victim, timeoutMs: 60_000 });
    assert.match(off.stderr, /w6630/);
    assert.match((await gitFence(['rm', '--cached', 'sub'], { cwd: victim })).args[0] ?? '', /w6630/);
    assert.equal(f.ran(), '');
    // A pathspec that leaves the submodule out passes, and so does a file's own.
    for (const a of [['add', '-A', '--', '.', ':!sub'], ['add', 'top.txt'], ['rm', '-n', '-q', 'top.txt']]) {
      const r = fenced(...a);
      assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`);
      assert.equal(f.ran(), '', `fence: ${a.join(' ')}`);
    }
    // w6691: the submodule's own `ignore = none` (in .gitmodules, which a branch can bring) beats the forced
    // diff.ignoreSubmodules: with only the forced config, each route below runs the filter on plain git.
    const forced = (...a: string[]) => plain(...SUBMODULE_GIT_CONFIG.flatMap(([k, v]) => ['-c', `${k}=${v}`]), ...a);
    const who = ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com'];
    git(victim, 'config', '--file', '.gitmodules', 'submodule.sub.ignore', 'none');
    git(victim, ...who, 'commit', '-qam', 'ignore none');
    git(victim, 'branch', 'other');
    for (const a of [['status', '--porcelain'], ['diff'], ['diff-files'], ['diff-index', 'HEAD'], ['checkout', 'other'], ['describe', '--dirty', '--always'], ['commit', '--dry-run']]) {
      forced(...a);
      assert.match(f.ran(), /clean/, `plain git with the forced config: ${a.join(' ')} runs the submodule’s filter`);
    }
    // w6713: a real merge's child git gets no option of the fence's.
    git(victim, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(victim, 'side.txt'), 'side\n');
    git(victim, 'add', 'side.txt');
    git(victim, ...who, 'commit', '-qm', 'side');
    git(victim, 'checkout', '-q', 'master');
    f.ran();
    forced(...who, 'merge', '--no-ff', '-m', 'x', 'side');
    assert.match(f.ran(), /clean/, 'plain git with the forced config: merge --no-ff runs the submodule’s filter');
    git(victim, 'reset', '-q', '--hard', 'HEAD~1');
    f.ran();
    // Through the fence, the inserted --ignore-submodules=dirty and --quiet stop these.
    for (const a of [['status', '--porcelain'], ['diff'], ['diff-files'], ['diff-index', 'HEAD'], ['checkout', 'master'], ['switch', 'other'], ['checkout', '--no-quiet', 'master']]) {
      const r = fenced(...a);
      assert.ok(r.status === 0 || (r.status === 1 && a[0]!.startsWith('diff-')), `${a.join(' ')}: ${r.stderr}`);
      assert.equal(f.ran(), '', `fence: ${a.join(' ')}`);
    }
    fs.appendFileSync(path.join(victim, 'top.txt'), 'more\n');
    plain(...who, 'stash', '-q');
    for (const a of [['stash', 'apply'], ['stash', 'pop']]) {
      const r = fenced(...a);
      assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`);
      assert.equal(f.ran(), '', `fence: ${a.join(' ')}`);
      plain('checkout', '-q', '--', 'top.txt');
    }
    // The calls no option stops are refused in a repository with a submodule, and so are add, rm and mv by any spelling.
    const list = path.join(f.root, 'list.txt');
    fs.writeFileSync(list, 'sub\n');
    for (const a of [['commit', '-q', '-m', 'x'], ['commit', '--dry-run'], ['stash'], ['stash', 'push', '-q'], ['stash', 'branch', 'xb'], ['describe', '--dirty', '--always'], ['rebase', '--autostash', 'other'], ['merge', '--autostash', 'other'], ['-c', 'rebase.autoStash=true', 'rebase', 'other'], ['--icase-pathspecs', 'add', 'SUB'], ['--literal-pathspecs', 'add', 'sub'], ['add', '--pathspec-fr', list], ['mv', '-n', 'sub', 'sub2'], ['merge', '--no-ff', '-m', 'x', 'side'], ['merge', '--squash', 'side'], ['pull', '--no-rebase', '--no-edit', '.', 'side'], ['difftool', '-y', '-x', 'true']]) {
      const r = fenced(...who, ...a);
      assert.notEqual(r.status, 0, a.join(' '));
      assert.match(r.stderr, /w6630/, a.join(' '));
      assert.equal(f.ran(), '', `fence: ${a.join(' ')}`);
    }
    // w6731: the merge shapes that slipped past a scan for --ff-only, and aliases (a caller's and the repository's).
    git(victim, 'config', 'alias.rst', 'status');
    plain('rst');
    assert.match(f.ran(), /clean/, 'plain git: the repository’s alias runs status, and the submodule’s filter');
    for (const a of [['merge', '--ff-only', '--no-ff', '-m', 'x', 'side'], ['merge', '--ff-only', '--ff', '-m', 'x', 'side'], ['merge', '--no-ff', '-m', '--ff-only', 'side'], ['merge', '-m', '--abort', '--no-ff', 'side'], ['merge', '-m', '--quit', 'side'], ['pull', '--ff-only', '--no-ff', '--no-edit', '.', 'side'], ['-c', 'alias.st=status', 'st'], ['-c', 'alias.cm=commit', 'cm', '-m', 'x'], ['-c', 'alias.dt=difftool', 'dt', '-y', '-x', 'true'], ['rst']]) {
      const r = fenced(...who, ...a);
      assert.notEqual(r.status, 0, a.join(' '));
      assert.match(r.stderr, /w6630|w6731/, a.join(' '));
      assert.equal(f.ran(), '', `fence: ${a.join(' ')}`);
    }
    git(victim, 'config', '--unset', 'alias.rst');
    plain('checkout', '-q', '--', 'top.txt');
    // E: with the submodule keys gone from the superproject's config, the forced config still stops it.
    git(victim, 'config', '--remove-section', 'submodule.sub');
    spawnSync('git', ['config', '--unset', 'submodule.active'], { cwd: victim });
    plain('status', '--porcelain');
    assert.match(f.ran(), /clean/, 'plain git: an unmarked submodule’s filter runs');
    fenced('status', '--porcelain');
    assert.equal(f.ran(), '', 'fence: marks or none');
    // Running git in the submodule itself scans its own config: its filter is overridden there.
    fs.rmSync(f.marker, { force: true });
    gitSpawnSync(['status', '--porcelain'], { cwd: path.join(victim, 'sub'), encoding: 'utf8', timeout: 60_000 });
    assert.equal(f.ran(), '', 'git in the submodule itself runs none of its programs');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('w5541: git lfs install and update keep the repository’s hooks folder (they write hooks); every other call gets FF Factory’s', async () => {
  const { fixedFor } = await import('./safeGit.ts');
  const hooks = (a: string[]) => fixedFor(a).find(([k]) => k === 'core.hooksPath')?.[1];
  assert.equal(hooks(['-C', 'x', 'lfs', 'install', '--local']), undefined);
  assert.equal(hooks(['lfs', 'update']), undefined);
  assert.equal(hooks(['-C', 'x', 'lfs', 'push', 'origin']), HOOKS);
  assert.equal(hooks(['-C', 'x', 'push', 'origin', 'x']), HOOKS);
  assert.equal(fixedFor(['lfs', 'install']).find(([k]) => k === 'core.fsmonitor')?.[1], 'false');
});

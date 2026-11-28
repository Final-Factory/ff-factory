import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED_GIT_CONFIG, HOOKS, fenceArgs, firstWinsArgs, firstWinsRefusal, gitExecFileSync, gitFenceSync, gitOffThread, gitSpawnSync, isGit, lazyFetchOff, needsScan, parseScan, refusal, scanCut, scannedOverrides, splitGlobal, withConfigFirst } from './safeGit.ts';
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
  for (const a of [['push', 'origin', 'x'], ['remote', 'update'], ['-C', 'd', 'lfs', 'push', 'origin'], ['submodule', 'update']])
    assert.match(refusal(a, up) ?? '', /^refused by FF Factory \(w6570\): .*remote\.origin\.uploadpack.*`git config --local --unset-all remote\.origin\.uploadpack`/, a.join(' '));
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
  for (const a of [['remote', '-v'], ['remote', 'get-url', 'origin'], ['lfs', 'env'], ['clone', 'x', 'y'], ['archive', '--remote', 'origin', 'HEAD']])
    assert.equal(firstWinsRefusal(a, up), undefined, a.join(' '));
  for (const a of [['remote', 'show', 'origin'], ['remote', 'prune', 'origin'], ['remote', 'set-head', 'origin', '--auto'], ['remote', 'add', '-f', 'x', 'u'], ['lfs', 'fetch']])
    assert.match(firstWinsRefusal(a, up) ?? '', /refused by FF Factory \(w6570\)/, a.join(' '));
  assert.deepEqual(scannedOverrides(group), [], 'a remote group is read, never overridden');
  assert.deepEqual(scannedOverrides(parseScan('local\0fetch.all\ntrue\0')), [], 'fetch.all is read, never overridden');
  assert.match(firstWinsRefusal(['fetch', 'origin'], rows.filter((r) => r.key === 'core.gitproxy')) ?? '', /w6570.*core\.gitproxy/);
  assert.equal(firstWinsRefusal(['status'], rows.filter((r) => r.key === 'core.gitproxy')), undefined);
  assert.equal(firstWinsRefusal(['push', 'origin'], []), undefined);
});

test('w5541: the subcommand is found past the global options; diff, log and show get no external diff or textconv', () => {
  assert.deepEqual(splitGlobal(['--no-optional-locks', '-C', 'd', '-c', 'a=b', '--git-dir=g', 'status', '-C']), { location: ['-C', 'd', '--git-dir=g'], sub: 6 });
  assert.deepEqual(fenceArgs(['-C', 'd', 'diff', 'HEAD', '--numstat']), ['-C', 'd', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--numstat']);
  assert.deepEqual(fenceArgs(['log', '-1']), ['log', '--no-ext-diff', '--no-textconv', '-1']);
  assert.deepEqual(fenceArgs(['-C', 'd', 'status']), ['-C', 'd', 'status']);
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

test('w5541: git lfs install and update keep the repository’s hooks folder (they write hooks); every other call gets FF Factory’s', async () => {
  const { fixedFor } = await import('./safeGit.ts');
  const hooks = (a: string[]) => fixedFor(a).find(([k]) => k === 'core.hooksPath')?.[1];
  assert.equal(hooks(['-C', 'x', 'lfs', 'install', '--local']), undefined);
  assert.equal(hooks(['lfs', 'update']), undefined);
  assert.equal(hooks(['-C', 'x', 'lfs', 'push', 'origin']), HOOKS);
  assert.equal(hooks(['-C', 'x', 'push', 'origin', 'x']), HOOKS);
  assert.equal(fixedFor(['lfs', 'install']).find(([k]) => k === 'core.fsmonitor')?.[1], 'false');
});

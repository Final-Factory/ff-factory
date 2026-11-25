import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOptions, standingGitEnv, STANDING_GIT_CONFIG, type LaunchSpec } from './launch.ts';
import { standingGuard, standingWriteProblem } from './standingGuard.ts';

// w5514 (follow-up of w5504, the w5452 audit): a standing agent may Write in its folder, so it could write a clone's
// config, or a folder shaped like a bare repository, that names a program the next allowed git command runs.

const standingSpec = (folder: string, env: Record<string, string> = {}): LaunchSpec => ({
  cwd: folder,
  settingSources: [],
  append: '',
  strictMcp: true,
  env,
  guard: { id: 'standing-x', ownPath: folder, protectedPaths: [], gameRepos: [], standing: { folder, groups: ['shell_read'], offLimits: [] } },
});

test('w5514: standingGitEnv appends after the entries already there; no system config except on Windows', () => {
  const env = standingGitEnv({ GIT_CONFIG_COUNT: '2' }, 'linux');
  assert.equal(env.GIT_CONFIG_COUNT, String(2 + STANDING_GIT_CONFIG.length));
  assert.equal(env.GIT_CONFIG_KEY_2, 'safe.bareRepository');
  assert.equal(env.GIT_CONFIG_VALUE_2, 'explicit');
  const pairs = STANDING_GIT_CONFIG.map((_, i) => [env[`GIT_CONFIG_KEY_${2 + i}`], env[`GIT_CONFIG_VALUE_${2 + i}`]]);
  assert.deepEqual(pairs, [
    ['safe.bareRepository', 'explicit'],
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', '/dev/null'],
    ['core.pager', 'cat'],
    ['protocol.ext.allow', 'never'],
  ]);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(standingGitEnv({}, 'win32').GIT_CONFIG_NOSYSTEM, undefined, "Git for Windows keeps its TLS backend and credential manager in the system config");
});

test('w5514: a standing agent gets it after its identity and credential entries; a sandbox worker does not', () => {
  const folder = '/srv/agents/reviewer';
  const o = buildOptions(standingSpec(folder, { GH_TOKEN: 'not-a-real-token' }), {}, { PATH: '/usr/bin' });
  const env = o.env ?? {};
  const n = Number(env.GIT_CONFIG_COUNT);
  const keys = Array.from({ length: n }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
  assert.ok(keys.includes('credential.https://github.com.helper'), 'the GitHub credential helper is kept');
  assert.deepEqual(keys.slice(-STANDING_GIT_CONFIG.length), STANDING_GIT_CONFIG.map(([k]) => k), 'the overrides come last');
  const worker = buildOptions({ ...standingSpec(folder), guard: { id: 'w', ownPath: folder, protectedPaths: [], gameRepos: [] } }, {}, { PATH: '/usr/bin' });
  assert.ok(!Object.values(worker.env ?? {}).includes('safe.bareRepository'));
});

// The proof the request asks for: git, spawned in a repository whose own config names a program, under a standing
// agent's environment (buildOptions, as launched), never runs it. The same commands without it do (the control), so the
// test fails if the crafted repository stops being hostile.
test('w5514: git under a standing agent env does not run the programs a crafted repository names', { skip: process.platform === 'win32' || spawnSync('git', ['--version']).status !== 0 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5514-'));
  try {
    const marker = path.join(root, 'ran.txt');
    const evil = path.join(root, 'evil.sh');
    fs.writeFileSync(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\n`, { mode: 0o755 });
    const hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks);
    fs.copyFileSync(evil, path.join(hooks, 'reference-transaction'));
    fs.chmodSync(path.join(hooks, 'reference-transaction'), 0o755);
    // Nobody's own config: an empty global, and the test's HOME.
    const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: path.join(root, 'global'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    fs.writeFileSync(base.GIT_CONFIG_GLOBAL, '');
    const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    const setup = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: base, stdio: 'pipe' });

    // A clone whose .git/config the agent rewrote: fsmonitor (git status, diff) and hooks (update-ref runs reference-transaction).
    const repo = path.join(root, 'clone');
    fs.mkdirSync(repo);
    setup(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'f'), 'a\n');
    setup(repo, 'add', 'f');
    setup(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one');
    fs.appendFileSync(path.join(repo, 'f'), 'b\n');
    setup(repo, 'config', 'core.fsmonitor', evil);
    setup(repo, 'config', 'core.hooksPath', hooks);
    setup(repo, 'config', 'core.pager', evil);

    // A folder shaped like a bare repository, with the same config: git would take it as one when run inside it.
    const bare = path.join(root, 'bare');
    setup(root, 'init', '-q', '--bare', bare);
    setup(bare, 'config', 'core.fsmonitor', evil);
    setup(bare, 'config', 'core.hooksPath', hooks);
    fs.rmSync(marker, { force: true });

    const runs = (env: NodeJS.ProcessEnv) => {
      fs.rmSync(marker, { force: true });
      const out = [git(repo, env, 'status', '--short'), git(repo, env, 'diff'), git(repo, env, 'update-ref', 'refs/heads/t', 'HEAD'), git(bare, env, 'log', '--oneline', '-1')];
      return { out, ran: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '' };
    };

    const control = runs(base);
    assert.match(control.ran, /evil\.sh|reference-transaction/, 'the crafted repositories run their programs without the standing env (else this test proves nothing)');
    assert.doesNotMatch(control.out[3].stderr, /safe\.bareRepository/, 'without the env git takes the bare-shaped folder as a repository');

    const env = { ...base, ...(buildOptions(standingSpec(root), {}, base).env as NodeJS.ProcessEnv) };
    const hardened = runs(env);
    assert.equal(hardened.ran, '', 'no program the repository named ran');
    const [status, diff, updateRef, bareLog] = hardened.out;
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /M f/, 'git status still works');
    assert.equal(diff.status, 0, diff.stderr);
    assert.match(diff.stdout, /\+b/, 'git diff still works');
    assert.equal(updateRef.status, 0, updateRef.stderr);
    assert.notEqual(bareLog.status, 0, 'the bare-shaped folder is not taken as a repository');
    assert.match(bareLog.stderr, /safe\.bareRepository/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("w5514: Write/Edit never reach git's own files, by any spelling or through a symlink", { skip: process.platform === 'win32' }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'w5514w-')));
  try {
    const folder = path.join(root, 'agent');
    const clone = path.join(folder, 'clone');
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'outside'));
    // What a hostile repository could check out: symlinks into its own .git and out of the folder.
    fs.symlinkSync('.git', path.join(clone, 'meta'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(clone, 'out'));
    fs.symlinkSync(path.join(clone, '.git', 'config'), path.join(clone, 'cfg'));

    const refused = [
      '.git/config',
      'clone/.git/config',
      'clone/.git/hooks/pre-commit',
      'clone/.git/info/attributes',
      'clone/.git',
      'clone/sub/.git',
      'clone/.GIT/config',
      'clone/.Git/config',
      'clone/.git./config',
      'clone/.git /config',
      'clone/GIT~1/config',
      'clone/x/../.git/config',
      'clone/meta/config',
      'clone/meta/hooks/post-checkout',
      'clone/cfg',
      'clone/out/x.txt',
      path.join(clone, '.git', 'config'),
    ];
    for (const t of refused) assert.ok(standingWriteProblem(t, folder), `refused: ${t}`);
    assert.match(standingWriteProblem('clone/meta/config', folder) ?? '', /\.git/);
    assert.match(standingWriteProblem('clone/out/x.txt', folder) ?? '', /outside/);

    const allowed = ['NOTES.md', 'clone/.gitignore', 'clone/.github/workflows/x.yml', 'clone/.gitattributes', 'clone/src/git/x.ts', 'clone/.gitx/a', 'new/dir/file.md', path.join(folder, 'notes', 'a.md')];
    for (const t of allowed) assert.equal(standingWriteProblem(t, folder), undefined, `allowed: ${t}`);

    // Through the hook, as the agent's tools call it.
    const hook = standingGuard({ folder, groups: [], offLimits: [] });
    const call = (tool_name: string, tool_input: unknown) =>
      hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's', transcript_path: '', cwd: folder, tool_use_id: 't' } as never, undefined, { signal: new AbortController().signal });
    const denied = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny';
    assert.ok(denied(await call('Write', { file_path: 'clone/.git/config' })));
    assert.ok(denied(await call('Edit', { file_path: path.join(clone, 'meta', 'config') })));
    assert.ok(denied(await call('MultiEdit', { file_path: 'clone/out/x' })));
    assert.ok(!denied(await call('Write', { file_path: 'NOTES.md' })));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

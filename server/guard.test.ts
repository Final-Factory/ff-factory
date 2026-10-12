import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { checkEditorSwitch, checkShell, sandboxGuard } from './guard.ts';

const decide = async (g: ReturnType<typeof sandboxGuard>, tool_name: string, tool_input: unknown, cwd = '') => {
  const input = { hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd };
  const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
  return r.hookSpecificOutput?.permissionDecision ?? 'allow';
};

const make = () => sandboxGuard({ sandboxId: 'sb1', sandboxPath: 'C:/ffsb/sb1', protectedPaths: ['C:/Users/dev/games/MyGame', path.join(os.homedir(), 'games', 'MyGame')] });

test('shell access to the protected checkout is denied in every spelling', async () => {
  const g = make();
  assert.equal(await decide(g, 'Bash', { command: 'ls /c/Users/dev/games/MyGame/Assets' }), 'deny');
  assert.equal(await decide(g, 'Bash', { command: 'cat C:\\Users\\dev\\games\\MyGame\\x' }), 'deny');
  assert.equal(await decide(g, 'PowerShell', { command: 'dir c:/users/dev/games/mygame' }), 'deny');
});

test('pushes: own branch allowed, master/main, develop (retired, w1137) and force denied', async () => {
  const g = make();
  assert.equal(await decide(g, 'Bash', { command: 'git push -u origin sandbox/sb1' }), 'allow');
  assert.equal(await decide(g, 'Bash', { command: 'git push --force-with-lease origin sandbox/sb1' }), 'allow');
  assert.equal(await decide(g, 'Bash', { command: 'git push origin HEAD:master' }), 'deny');
  assert.equal(await decide(g, 'Bash', { command: 'git push origin main' }), 'deny');
  assert.equal(await decide(g, 'Bash', { command: 'git push origin HEAD:develop' }), 'deny');
  assert.equal(await decide(g, 'Bash', { command: 'git push -f origin sandbox/sb1' }), 'deny');
  assert.equal(await decide(g, 'Bash', { command: 'git push --force origin sandbox/sb1' }), 'deny');
});

test('file writes are confined away from protected paths', async () => {
  const g = make();
  assert.equal(await decide(g, 'Edit', { file_path: 'C:\\Users\\dev\\games\\MyGame\\a.cs' }), 'deny');
  assert.equal(await decide(g, 'Write', { file_path: 'C:\\ffsb\\sb1\\a.cs' }), 'allow');
});

test('Unity MCP: refused until pinned, and only to this sandbox editor', async () => {
  const g = make();
  assert.equal(await decide(g, 'mcp__UnityMCP__read_console', {}), 'deny');
  assert.equal(await decide(g, 'mcp__UnityMCP__set_active_instance', { instance: 'FinalFactory@abc' }), 'deny');
  assert.equal(await decide(g, 'mcp__UnityMCP__set_active_instance', { instance: '6401' }), 'deny');
  assert.equal(await decide(g, 'mcp__UnityMCP__set_active_instance', { instance: 'sb1@abc' }), 'allow');
  assert.equal(await decide(g, 'mcp__UnityMCP__read_console', {}), 'allow');
  assert.equal(await decide(g, 'mcp__UnityMCP__read_console', { unity_instance: 'FinalFactory@abc' }), 'deny');
});

test('review bypasses are closed (push variants, gh, process kills)', async () => {
  const g = make();
  const deny = [
    'git push origin HEAD:refs/heads/master',
    'git push -uf origin sandbox/sb1',
    'git push origin --delete develop',
    'git push origin :develop',
    'git push --mirror origin',
    'cd x && git push -f origin sb1',
    'gh api -X PATCH repos/o/r/git/refs/heads/master -F force=true',
    'git push origin HEAD:refs/heads/develop',
    'git push origin develop',
    'git push origin develop:develop',
    'gh pr create --base develop --title x --body y',
    'gh pr create --base=develop --title x',
    'gh pr create -B develop --title x',
    'gh pr edit 12 --base develop',
    'gh pr edit 12 --base=develop',
    'Get-Process Unity | Stop-Process -Force',
    'taskkill //IM Unity.exe //F',
    'pkill -f node',
    'shutdown /r /t 0',
    'ls ~/games/MyGame',
  ];
  for (const command of deny) assert.equal(await decide(g, 'Bash', { command }), 'deny', command);
  const allow = [
    'git push',
    'git push -u origin sandbox/sb1',
    'git push origin HEAD',
    'git push --force-with-lease origin sandbox/sb1',
    'gh pr create --base master --title x --body y',
    'gh pr create --base=master --title x',
    'gh pr create -B master --title x',
    'gh pr edit 12 --base master',
    'gh pr create --base main --title x',
    'gh pr merge 12 --merge',
    'gh pr merge 12 --squash',
    'gh api repos/o/r/pulls',
    'git log --oneline -5',
  ];
  for (const command of allow) assert.equal(await decide(g, 'Bash', { command }), 'allow', command);
});

test('master/main: blocked for the game repo only, and whenever the target is unknown', async () => {
  const remotes = (dir: string) => {
    const d = dir.replace(/\\/g, '/').toLowerCase();
    if (d === 'c:/ffsb/sb1') return new Map([['origin', 'git@github.com:example-org/example-game.git']]);
    if (d === 'c:/tmp/tools') return new Map([['origin', 'https://github.com/Final-Factory/ff-factory.git']]);
    return undefined;
  };
  const g = sandboxGuard({ sandboxId: 'sb1', sandboxPath: 'C:/ffsb/sb1', protectedPaths: [], gameRepos: ['https://github.com/example-org/example-game.git', 'C:/ffsb/_base'], remotes });
  const sb = 'C:/ffsb/sb1';
  const tools = 'C:/tmp/tools';
  const cases: [string, string, 'allow' | 'deny'][] = [
    [sb, 'git push origin HEAD:master', 'deny'],
    // w1137: master takes a PR but no push; develop is retired for pushes and PRs alike.
    [sb, 'gh pr create --base master --title x', 'allow'],
    [sb, 'gh pr create --base=master --title x', 'allow'],
    [sb, 'gh pr edit 7 --base master', 'allow'],
    [sb, 'gh pr create --base main --title x', 'allow'], // the game repo has no main; not judged
    [sb, 'git push origin HEAD:develop', 'deny'],
    [sb, 'git push -u origin develop', 'deny'],
    [sb, 'git push origin HEAD:refs/heads/develop', 'deny'],
    [sb, 'git push origin sandbox/x:develop', 'deny'],
    [sb, 'gh pr create --base develop --title x', 'deny'],
    [sb, 'gh pr create --base=develop --title x', 'deny'],
    [sb, 'gh pr create -b develop --title x', 'deny'],
    [sb, 'gh pr edit 7 --base develop', 'deny'],
    [sb, 'gh pr edit 7 --base=develop', 'deny'],
    [sb, 'gh pr merge 7 --merge', 'allow'],
    [sb, 'git push origin sandbox/x', 'allow'],
    [tools, 'git push origin HEAD:develop', 'allow'], // another repo's develop is its own business
    [tools, 'gh pr create --base develop --title x', 'allow'],
    [sb, 'gh pr create -R Final-Factory/ff-factory --base develop --title x', 'allow'],
    [sb, 'cd C:/tmp/tools && gh pr create --base develop --title x', 'allow'],
    [tools, 'git push origin HEAD:main', 'allow'],
    [tools, 'git push origin main', 'allow'],
    [tools, 'gh pr create --base main --title x', 'allow'],
    [sb, 'cd C:/tmp/tools && git push origin HEAD:main', 'allow'],
    [sb, 'cd /c/tmp/tools && git push origin HEAD:main', 'allow'],
    [sb, 'git -C C:/tmp/tools push origin main', 'allow'],
    [sb, 'git push https://github.com/Final-Factory/ff-factory HEAD:main', 'allow'],
    [tools, 'git push https://github.com/example-org/example-game.git HEAD:master', 'deny'],
    [tools, 'git push C:/ffsb/_base HEAD:master', 'deny'],
    [tools, 'cd C:/ffsb/sb1 && git push origin HEAD:master', 'deny'],
    [tools, 'cd $HOME/x && git push origin main', 'deny'],
    [tools, 'git push upstream main', 'deny'],
    [tools, 'git push main', 'deny'],
    ['C:/elsewhere', 'git push origin main', 'deny'],
    [tools, 'gh pr create -R example-org/example-game --base master', 'allow'],
    [tools, 'gh pr create -R example-org/example-game --base develop', 'deny'],
    [tools, 'GH_REPO=example-org/example-game gh pr create --base develop', 'deny'],
    [tools, 'GH_REPO=example-org/example-game gh pr create --base master', 'allow'],
    [sb, 'gh pr create --repo Final-Factory/ff-factory --base main', 'allow'],
    // Repository settings: other repos when the user asks; the game repo (or an unknown one) never; delete never.
    [tools, 'gh repo rename ff-factory-private -R Final-Factory/ff-factory --yes', 'allow'],
    [tools, 'gh repo rename ff-factory-private --yes', 'allow'], // the directory's repo is the app's
    [sb, 'gh repo rename renamed --yes', 'deny'], // the directory's repo is the game's
    [tools, 'gh repo rename x -R example-org/example-game', 'deny'],
    ['C:/elsewhere', 'gh repo rename x --yes', 'deny'], // no remotes known
    [sb, 'gh repo create Final-Factory/ff-factory --public --description "A portal"', 'allow'],
    [tools, 'gh repo create example-org/example-game --private', 'deny'],
    [tools, 'gh repo create --public', 'deny'],
    [sb, 'gh repo edit Final-Factory/ff-factory --visibility public --accept-visibility-change-consequences', 'allow'],
    [sb, 'gh repo edit --visibility public', 'deny'],
    [tools, 'gh repo edit example-org/example-game --visibility public', 'deny'],
    [tools, 'gh repo edit --description "x/y" example-org/example-game', 'deny'],
    [sb, 'gh repo archive Final-Factory/ff-factory-private --yes', 'allow'],
    [tools, 'GH_REPO=example-org/example-game gh repo archive --yes', 'deny'],
    [tools, 'gh repo delete Final-Factory/ff-factory-private --yes', 'deny'],
    [sb, 'gh api -X PUT repos/Final-Factory/ff-factory/private-vulnerability-reporting', 'allow'],
    [tools, 'gh api -X DELETE repos/example-org/example-game/private-vulnerability-reporting', 'deny'],
    [sb, 'gh api repos/example-org/example-game/private-vulnerability-reporting', 'allow'], // a read
    // The every-repo rules still hold outside the game repo.
    [tools, 'git push -' + 'f origin main', 'deny'],
    [tools, 'git push origin --del' + 'ete old', 'deny'],
    [tools, 'git push --mir' + 'ror origin', 'deny'],
  ];
  for (const [cwd, command, want] of cases) assert.equal(await decide(g, 'Bash', { command }, cwd), want, `${command} (in ${cwd})`);
  // w1112: a clone reached through a variable is an unknown repo, refused as the game's; the reason says so and names -R.
  const ctx = { cwd: sb, gameRepos: ['https://github.com/example-org/example-game.git'], remotes };
  assert.match(checkShell('cd $TMPDIR/ff-factory && gh pr create --base develop --title x', ctx) ?? '', /could not be determined.*develop is retired.*gh pr create -R <owner>\/<repo>/);
  assert.equal(checkShell('cd $TMPDIR/ff-factory && gh pr create -R Final-Factory/ff-factory --base develop --title x', ctx), undefined);
  assert.equal(checkShell('cd $TMPDIR/ff-factory && gh pr create --base master --title x', ctx), undefined);
  // The refusals say what to do instead (w1137).
  assert.match(checkShell('git push origin HEAD:master', ctx) ?? '', /master takes changes only through a pull request.*gh pr create --base master.*merge it when CI is green/);
  assert.match(checkShell('git push origin HEAD:develop', ctx) ?? '', /develop is retired \(w1137, 2026-10-12\).*master is the one trunk.*open a PR into master/);
  assert.match(checkShell('cd $NOPE/x && git push origin HEAD:develop', ctx) ?? '', /could not be determined.*pushing to develop is blocked.*develop is retired/);
});

test('w1132: master/main of Final-Factory/ffbox is pushed straight; the game repo and unknown targets are not', async () => {
  const game = 'https://github.com/Final-Factory/FinalFactory.git';
  const byDir: Record<string, Record<string, string>> = {
    'c:/ffsb/sb1': { origin: 'git@github.com:Final-Factory/FinalFactory.git' },
    'c:/tmp/ffbox-https': { origin: 'https://github.com/Final-Factory/ffbox.git' },
    'c:/tmp/ffbox-ssh': { origin: 'git@github.com:Final-Factory/ffbox.git', upstream: 'ssh://git@github.com/Final-Factory/ffbox' },
    'c:/tmp/ffbox-token': { origin: 'https://x-access-token:abc@github.com/final-factory/FFBox' },
    'c:/tmp/fork': { origin: 'https://github.com/Final-Factory/FinalFactory' },
    'c:/tmp/not-a-clone': {},
  };
  const remotes = (dir: string) => {
    const r = byDir[dir.replace(/\\/g, '/').toLowerCase()];
    return r ? new Map(Object.entries(r)) : undefined;
  };
  const sb = 'C:/ffsb/sb1';
  const env = { TMPDIR: 'C:\\tmp', HOME: 'C:\\tmp\\home' };
  const g = sandboxGuard({ sandboxId: 'sb1', sandboxPath: sb, protectedPaths: [], gameRepos: [game, 'F:/ffw/repo'], remotes, env });
  const cases: [string, string, 'allow' | 'deny'][] = [
    // ffbox master/main, every remote spelling and every refspec form
    ['C:/tmp/ffbox-https', 'git push origin HEAD:master', 'allow'],
    ['C:/tmp/ffbox-https', 'git push origin master', 'allow'],
    ['C:/tmp/ffbox-https', 'git push origin HEAD:refs/heads/master', 'allow'],
    ['C:/tmp/ffbox-https', 'git push origin HEAD:main', 'allow'],
    ['C:/tmp/ffbox-https', 'git push -u origin master', 'allow'],
    ['C:/tmp/ffbox-ssh', 'git push origin HEAD:master', 'allow'],
    ['C:/tmp/ffbox-ssh', 'git push upstream master', 'allow'],
    ['C:/tmp/ffbox-token', 'git push origin HEAD:master', 'allow'],
    [sb, 'git push https://github.com/Final-Factory/ffbox.git HEAD:master', 'allow'],
    [sb, 'git push git@github.com:Final-Factory/ffbox.git HEAD:refs/heads/master', 'allow'],
    // reached from the sandbox: a path, -C, or a variable the worker's shell has
    [sb, 'cd C:/tmp/ffbox-https && git push origin HEAD:master', 'allow'],
    [sb, 'git -C C:/tmp/ffbox-ssh push origin master', 'allow'],
    [sb, 'cd $TMPDIR/ffbox-https && git push origin HEAD:master', 'allow'],
    [sb, 'cd "$TMPDIR/ffbox-https" && git push origin HEAD:master', 'allow'],
    [sb, 'cd ${TMPDIR}/ffbox-ssh && git push origin master', 'allow'],
    [sb, 'git -C "$TMPDIR/ffbox-https" push origin HEAD:master', 'allow'],
    [sb, 'Set-Location $env:TMPDIR/ffbox-https; git push origin HEAD:master', 'allow'],
    [sb, 'cd %TMPDIR%/ffbox-https && git push origin HEAD:master', 'allow'],
    [sb, 'D=$TMPDIR/ffbox-https; cd $D && git push origin HEAD:master', 'allow'],
    // the game repo, every spelling, from anywhere
    [sb, 'git push origin HEAD:master', 'deny'],
    [sb, 'git push origin master', 'deny'],
    [sb, 'git push origin HEAD:main', 'deny'],
    ['C:/tmp/fork', 'git push origin HEAD:main', 'deny'],
    [sb, 'git push https://github.com/Final-Factory/FinalFactory HEAD:master', 'deny'],
    [sb, 'git push git@github.com:Final-Factory/FinalFactory.git master', 'deny'],
    [sb, 'cd $TMPDIR/ffbox-https && git push https://github.com/Final-Factory/FinalFactory.git HEAD:master', 'deny'],
    // force pushes and deletions are refused for ffbox too
    ['C:/tmp/ffbox-https', 'git push --force origin HEAD:master', 'deny'],
    ['C:/tmp/ffbox-https', 'git push -f origin master', 'deny'],
    ['C:/tmp/ffbox-https', 'git push origin +HEAD:master', 'deny'],
    ['C:/tmp/ffbox-https', 'git push origin --delete master', 'deny'],
    [sb, 'cd $TMPDIR/ffbox-https && git push --force origin HEAD:master', 'deny'],
    ['C:/tmp/ffbox-https', 'git push --force-with-lease origin HEAD:master', 'allow'],
    // a target that cannot be determined stays the game repo's
    [sb, 'cd $NOPE/ffbox-https && git push origin HEAD:master', 'deny'],
    [sb, 'cd $(mktemp -d) && git push origin HEAD:master', 'deny'],
    ['C:/tmp/not-a-clone', 'git push origin HEAD:master', 'deny'],
    ['C:/tmp/ffbox-https', 'git push nosuch master', 'deny'],
    ['C:/tmp/ffbox-https', 'git push master', 'deny'],
  ];
  for (const [cwd, command, want] of cases) assert.equal(await decide(g, 'Bash', { command }, cwd), want, `${command} (in ${cwd})`);
});

test('w1132: a refused master push says which repo it saw, or why it could not tell', () => {
  const remotes = (dir: string) => {
    const d = dir.replace(/\\/g, '/').toLowerCase();
    if (d === 'c:/ffsb/sb1') return new Map([['origin', 'git@github.com:Final-Factory/FinalFactory.git']]);
    if (d === 'c:/tmp/ffbox') return new Map([['origin', 'https://github.com/Final-Factory/ffbox.git']]);
    return undefined;
  };
  const ctx = { cwd: 'C:/ffsb/sb1', gameRepos: ['https://github.com/Final-Factory/FinalFactory.git'], remotes, env: { TMPDIR: 'C:/tmp' } };
  // The shell goes back to the sandbox after every command: the refusal names the repo it read there and how to aim at another.
  const game = checkShell('git push origin HEAD:master', ctx) ?? '';
  assert.match(game, /github\.com\/final-factory\/finalfactory/);
  assert.match(game, /remote origin/);
  assert.match(game, /C:\/ffsb\/sb1/);
  assert.match(game, /cd <clone> && git push/);
  // A variable the shell does not have: says which path, and that the push counts as the game repo's.
  const unset = checkShell('cd $NOPE/ffbox && git push origin HEAD:master', ctx) ?? '';
  assert.match(unset, /could not be determined/);
  assert.match(unset, /\$NOPE\/ffbox/);
  // A remote name the clone does not have: lists the ones it has.
  const noRemote = checkShell('cd C:/tmp/ffbox && git push ffbox master', ctx) ?? '';
  assert.match(noRemote, /could not be determined/);
  assert.match(noRemote, /remote ffbox/);
  assert.match(noRemote, /origin=https:\/\/github\.com\/Final-Factory\/ffbox\.git/);
  // A directory that is no git repo.
  assert.match(checkShell('cd C:/tmp/other && git push origin master', ctx) ?? '', /C:\/tmp\/other is not a git repo/);
  // No remote before the branch.
  assert.match(checkShell('git push master', ctx) ?? '', /names no remote/);
  // Without a configured game repo nothing can be told apart.
  assert.match(checkShell('git push origin master', { cwd: 'C:/tmp/ffbox', gameRepos: [], remotes }) ?? '', /no game repo is configured/);
  // And the answer for ffbox, from the same directory the refusal named, is none.
  assert.equal(checkShell('cd $TMPDIR/ffbox && git push origin HEAD:master', ctx), undefined);
});

test('branch switches: refused in the sandbox while its editor runs, fine otherwise', async () => {
  const sb = 'C:/ffsb/sb1';
  const denied = ['git switch other', 'git switch -c new origin/develop', 'git checkout other', 'git checkout -b new', 'git -C C:/ffsb/sb1 switch x', 'cd /c/ffsb/sb1 && git checkout x'];
  for (const c of denied) assert.match(checkEditorSwitch(c, sb, sb) ?? '', /switch_branch/, c);
  const allowed = ['git checkout -- Assets/a.cs', 'git checkout HEAD -- a.unity', 'git restore Assets/a.cs', 'git switch --help', 'git status', 'git -C C:/tools/other switch main', 'cd C:/tools/other && git checkout main'];
  for (const c of allowed) assert.equal(checkEditorSwitch(c, sb, sb), undefined, c);
  // Wired into the guard only while the editor is up.
  let running = true;
  const g = sandboxGuard({ sandboxId: 'sb1', sandboxPath: sb, protectedPaths: [], gameRepos: ['https://github.com/example-org/example-game.git'], remotes: () => new Map(), editorRunning: () => running });
  assert.equal(await decide(g, 'Bash', { command: 'git switch other' }, sb), 'deny');
  running = false;
  assert.equal(await decide(g, 'Bash', { command: 'git switch other' }, sb), 'allow');
});

test('public repos: a push whose commits carry a private email is refused', async () => {
  const remotes = () => new Map([['origin', 'https://github.com/Final-Factory/ff-factory.git'], ['game', 'git@github.com:example-org/example-game.git'], ['kit', 'git@github.com:Final-Factory/agent-kit.git']]);
  let emails = ['1+someone@users.noreply.github.com', 'bot@example.org'];
  const seen: string[][] = [];
  const g = sandboxGuard({
    sandboxId: 'sb1',
    sandboxPath: 'C:/ffsb/sb1',
    protectedPaths: [],
    gameRepos: ['https://github.com/example-org/example-game.git'],
    remotes,
    publicIdentity: { repos: ['https://github.com/Final-Factory/ff-factory'], name: 'Public Name', email: 'bot@example.org', pushedEmails: (_dir, remote, srcs) => (seen.push([remote, ...srcs]), emails), isPublic: (k) => k === 'github.com/final-factory/agent-kit' },
  });
  const cwd = 'C:/tmp/app';
  assert.equal(await decide(g, 'Bash', { command: 'git push origin HEAD:main' }, cwd), 'allow');
  assert.deepEqual(seen.at(-1), ['origin', 'HEAD']);
  emails = ['1+someone@users.noreply.github.com', 'person@gmail.example'];
  for (const command of ['git push origin HEAD:main', 'git push', 'git push origin feature:feature', 'git push https://github.com/Final-Factory/ff-factory.git x:y']) {
    assert.equal(await decide(g, 'Bash', { command }, cwd), 'deny', command);
  }
  assert.deepEqual(seen.at(-1), ['https://github.com/Final-Factory/ff-factory.git', 'x']);
  // Other repos are not its business (the game repo's own rules still apply).
  assert.equal(await decide(g, 'Bash', { command: 'git push game HEAD:feature' }, cwd), 'allow');
  // A repo GitHub reports as public counts too, configured or not.
  assert.equal(await decide(g, 'Bash', { command: 'git push kit HEAD:develop' }, cwd), 'deny');
  // The refusal says how to fix it.
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd };
  const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
  assert.match(r.hookSpecificOutput?.permissionDecisionReason ?? '', /person@gmail\.example.*git config user\.email "bot@example\.org".*--reset-author/);
});

test('public repos: the real lookup lists the unpushed commits\' emails', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const { gitPushedEmails } = await import('./guard.ts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pushed-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '--bare', path.join(tmp, 'o.git')]);
  const w = path.join(tmp, 'w');
  execFileSync('git', ['init', '-q', w]);
  git(w, 'remote', 'add', 'origin', path.join(tmp, 'o.git'));
  git(w, '-c', 'user.name=a', '-c', 'user.email=1+a@users.noreply.github.com', 'commit', '-q', '--allow-empty', '-m', 'pushed');
  git(w, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(w, 'fetch', '-q', 'origin');
  git(w, '-c', 'user.name=b', '-c', 'user.email=b@example.com', 'commit', '-q', '--allow-empty', '-m', 'not yet');
  assert.deepEqual(gitPushedEmails(w, 'origin', ['HEAD']), ['b@example.com']);
});

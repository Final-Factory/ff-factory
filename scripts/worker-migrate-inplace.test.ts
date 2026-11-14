// w14: migrate --config moves a hand-made second instance's daemon in place into an installer-made --instance install
// (scripts/worker/migrate.ts; docs/worker-install.md, "A second instance's daemon"). Windows paths are built with
// path.win32.join, never written as literals.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cleanup, daemonProcs, discoverOld, plan, rehome, rollback, samePlace, type Proc } from './worker/migrate.ts';
import { layoutOf, preflightProblems, rootState, type Facts } from './worker/worker.ts';

const TOKEN = `ffm_beast_${'A'.repeat(43)}`;

/** A hand-made instance as the lens one is: daemon.json and the token file beside the root, the daemon folder in it. */
function handMade(base: string) {
  const root = path.join(base, 'worker');
  const appDir = path.join(root, 'app');
  const config = path.join(base, 'daemon.json');
  const tokenFile = path.join(base, 'secrets', 'machine-token.txt');
  const slot1 = path.join(root, 'sandboxes', 'slot1');
  for (const d of [appDir, slot1, path.join(root, 'clone', '.git'), path.join(root, 'temp'), path.join(root, 'unity-slots'), path.dirname(tokenFile), path.join(appDir, 'gh-app', 'bin'), path.join(appDir, 'unity-mcp', 'slot1')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(tokenFile, `${TOKEN}\n`);
  fs.writeFileSync(path.join(appDir, 'published.jsonl'), '{}\n');
  fs.writeFileSync(path.join(appDir, 'cleanup-facts.json'), '{}');
  fs.writeFileSync(path.join(appDir, 'sandboxes.json'), JSON.stringify([{ id: 'slot1', branch: 'sandbox/slot1', base: 'origin/main', path: slot1, createdAt: '', status: 'ready' }]));
  // An editor's BOM, as a hand-written file may have.
  fs.writeFileSync(config, `\ufeff${JSON.stringify({ portalUrl: 'http://127.0.0.1:8892', id: 'beast', tokenFile, root, repoPath: path.join(root, 'clone'), appDir, tempDir: path.join(root, 'temp'), sandboxes: { root: path.join(root, 'sandboxes'), maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 0 } })}`);
  return { root, appDir, config, slot1 };
}

function withBase(fn: (base: string) => void | Promise<void>) {
  return async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-inplace-'));
    try {
      await fn(base);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

test('w14 in place: a hand-made daemon.json outside its folder, with a token file, is discovered', withBase((base) => {
  const h = handMade(base);
  const old = discoverOld(undefined, { config: h.config, root: h.root });
  assert.equal(old.inPlace, true);
  assert.equal(old.configFile, path.resolve(h.config));
  assert.equal(old.appDir, path.resolve(h.appDir), 'the folder is the one daemon.json names, not the one it is in');
  assert.equal(old.token, TOKEN, 'read from the token file (machine/daemon.ts readToken)');
  assert.deepEqual(old.sandboxes.map((s) => s.id), ['slot1']);
  assert.throws(() => discoverOld(undefined, { config: h.config, root: path.join(base, 'elsewhere') }), /names the root/);
  // Without --config, a daemon.json that belongs to a root is refused as before.
  fs.copyFileSync(h.config, path.join(h.appDir, 'daemon.json'));
  assert.throws(() => discoverOld(h.appDir), /already belongs to the worker root/);
  // No appDir: its folder would be ~/.ff-factory, the main install's.
  fs.writeFileSync(h.config, JSON.stringify({ token: TOKEN, root: h.root }));
  assert.throws(() => discoverOld(undefined, { config: h.config, root: h.root }), /names no appDir/);
}));

test('w14 in place: the plan renames and copies no sandbox, only rehomes it, and copies the daemon\'s own state', withBase((base) => {
  const h = handMade(base);
  const old = discoverOld(undefined, { config: h.config, root: h.root });
  const l = layoutOf(h.root);
  const items = plan(old, l, { claudeConfigDir: path.join(base, 'claude-worker'), fromService: 'fflensscout-daemon', measure: false });
  const sb = items.filter((i) => i.what.startsWith('sandbox '));
  assert.equal(sb.length, 1);
  assert.equal(sb[0].method, 'rehome');
  assert.equal(sb[0].from, h.slot1);
  assert.ok(samePlace(sb[0].to!, sb[0].from), 'it stays where it is');
  assert.ok(!items.some((i) => i.method === 'rename' || i.method === 'claude'), 'nothing renamed, no conversations copied');
  assert.ok(!items.some((i) => i.method === 'copy' && i.what.startsWith('sandbox ')));
  for (const what of ['daemon state published.jsonl', 'daemon state cleanup-facts.json', 'daemon state sandboxes.json', 'daemon gh-app/', 'daemon unity-mcp/']) {
    const i = items.find((x) => x.what === what);
    assert.ok(i && i.method === 'copy' && i.to!.startsWith(l.daemon), `${what} copied into the root's daemon folder`);
  }
  assert.equal(items.find((i) => i.what.startsWith('the machine credential'))!.from, path.resolve(h.config));
  for (const what of ['the old clone', 'the old daemon folder', 'the old temp folder', 'the Claude Code folder', 'the old service']) assert.equal(items.find((i) => i.what === what)?.method, 'leave', what);
  // A normal migration's plan is as it was: none of the in-place items.
  const normal = plan({ ...old, inPlace: undefined, configFile: undefined }, layoutOf(path.join(base, 'other-root')), { claudeDir: path.join(base, 'c'), measure: false });
  assert.ok(!normal.some((i) => i.what === 'daemon state published.jsonl' || i.what === 'the old service'));
}));

test('w14 in place: samePlace follows each platform\'s rules', () => {
  assert.equal(samePlace(path.win32.join('F:', 'ffw', 'lens', 'worker', 'sandboxes', 'slot1'), 'f:/FFW/lens/worker/sandboxes/slot1/', 'win32'), true);
  assert.equal(samePlace(path.win32.join('F:', 'ffw', 'a'), path.win32.join('F:', 'ffw', 'b'), 'win32'), false);
  assert.equal(samePlace('/Users/b/lens/worker/sandboxes/slot1', '/Users/b/lens/worker/sandboxes/slot1/', 'darwin'), true);
  assert.equal(samePlace('/Users/b/Lens', '/Users/b/lens', 'darwin'), false);
});

test('w14 in place: rootState accepts the root a migration journal marks, and nothing wider', withBase((base) => {
  const h = handMade(base);
  assert.equal(rootState(h.root), 'other', 'a folder with an old daemon in it is not a root to install into');
  const journal = (j: object) => fs.writeFileSync(path.join(h.root, 'migration.json'), JSON.stringify({ from: h.appDir, startedAt: '', moved: [], renamed: [], ...j }));
  journal({ state: 'prepared', config: h.config });
  assert.equal(rootState(h.root), 'ours');
  journal({ state: 'rolled-back', config: h.config });
  assert.equal(rootState(h.root), 'other', 'a rolled-back one is not');
  journal({ state: 'prepared' });
  assert.equal(rootState(h.root), 'other', 'a normal migration\'s journal does not cover other files');
  const elsewhere = path.join(base, 'other.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ root: path.join(base, 'not-this') }));
  journal({ state: 'prepared', config: elsewhere });
  assert.equal(rootState(h.root), 'other', 'the daemon.json must name this root');
}));

test('w14 in place: the stop finds the old daemon by its daemon.json on the command line (Windows and Mac), and fails closed', () => {
  const cfg = path.win32.join('F:', 'ffw', 'lens-factory', 'daemon.json');
  const app = path.win32.join('F:', 'ffw', 'lens-factory', 'worker', 'app');
  const node = `"${path.win32.join('C:', 'Program Files', 'nodejs', 'node.exe')}"`;
  const p = (pid: number, cmd: string): Proc => ({ pid, ppid: 1, cmd });
  const win = daemonProcs([
    p(10, `${node} machine/daemon.ts "F:/ffw/lens-factory/daemon.json"`),
    p(11, `${node} ${path.win32.join('F:', 'FFW', 'lens-factory', 'app', 'machine', 'daemon.ts')} ${cfg.toUpperCase()}`),
    p(12, `${node} ${path.win32.join('C:', 'Users', 'b', '.ff-factory', 'app', 'machine', 'daemon.ts')} ${path.win32.join('C:', 'Users', 'b', '.ff-factory', 'daemon.json')}`),
    p(13, `${node} scripts/worker/worker.ts migrate --config F:/ffw/lens-factory/daemon.json --root F:/ffw/lens-factory/worker`),
    p(14, `${node} machine/daemon.ts "F:/ffw/lens-factory/daemon.json.bak"`),
    p(15, `${node} ${path.win32.join(app, 'machine', 'agentHost.ts')} ${path.win32.join(app, 'hosts', 's1')}`),
    p(16, `"C:/Program Files/Git/usr/bin/bash.exe" F:/ffw/lens-factory/start-daemon.sh`),
  ], cfg, app, 'win32');
  assert.deepEqual(win.ours.map((x) => x.pid), [10, 11, 15], 'either slash, any case, and its agent hosts; not the main daemon, this migration or a longer path');
  assert.deepEqual(win.unknown, []);
  const unknown = daemonProcs([p(20, `${node} machine/daemon.ts`), p(21, 'node machine/daemon.ts daemon.json')], cfg, app, 'win32');
  assert.deepEqual(unknown.unknown.map((x) => x.pid), [20, 21], 'no absolute daemon.json: whose it is cannot be told, so the stop refuses');
  const mac = daemonProcs([
    p(30, '/opt/homebrew/bin/node --disable-warning=ExperimentalWarning /Users/b/lens/app/machine/daemon.ts /Users/b/lens/daemon.json'),
    p(31, '/opt/homebrew/bin/node /Users/b/.ff-factory/app/machine/daemon.ts /Users/b/.ff-factory/daemon.json'),
    p(32, '/opt/homebrew/bin/node /Users/b/lens/app/machine/daemon.ts /Users/b/Lens/daemon.json'),
  ], '/Users/b/lens/daemon.json', '/Users/b/lens/worker/app', 'darwin');
  assert.deepEqual(mac.ours.map((x) => x.pid), [30], 'case counts on a Mac');
});

test('w14 in place: cleanup refuses, and deletes nothing', withBase(async (base) => {
  const h = handMade(base);
  fs.writeFileSync(path.join(h.root, 'migration.json'), JSON.stringify({ from: h.appDir, oldRepo: path.join(h.root, 'clone'), startedAt: '', state: 'switched', moved: [], renamed: [], config: h.config }));
  await assert.rejects(cleanup({ root: h.root, legacy: false }), /migrated in place/);
  for (const d of [h.appDir, path.join(h.root, 'clone'), h.slot1]) assert.ok(fs.existsSync(d), d);
}));

test('w14 in place: an instance may run no Unity editor (max-unity 0); a normal install still may not', () => {
  const f = { platform: 'darwin', nodeVersion: 'v24.0.0', git: [2, 50], gitLfs: true, claude: '/usr/local/bin/claude', rootState: 'missing', rootParentExists: true, portal: { ok: false, error: 'x' } } as unknown as Facts;
  const o = { root: '/Users/b/lens/worker', portalUrl: 'https://portal.example', maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 0 };
  assert.ok(preflightProblems(f, o).some((x) => x.startsWith('--max-unity')));
  assert.ok(!preflightProblems(f, { ...o, instance: 'lens' }).some((x) => x.startsWith('--max-unity')));
});

test('w14 in place: a sandbox that stays is rehomed (its old link kept), and a rollback gives it back to the old clone', withBase(async (base) => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', '-c', 'core.autocrlf=false', ...a], { cwd, stdio: 'pipe' }).toString();
  const origin = path.join(base, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, 'README.md'), 'hi\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'init');
  const l = layoutOf(path.join(base, 'worker'));
  const clone = path.join(l.root, 'clone');
  git(base, 'clone', '-q', origin, clone);
  const sb = path.join(l.sandboxes, 'slot1');
  git(clone, 'worktree', 'add', '-q', '-b', 'sandbox/slot1', sb, 'origin/main');
  fs.appendFileSync(path.join(sb, 'README.md'), 'unstaged\n');
  const before = git(sb, 'status', '--porcelain=v1');
  const head = git(sb, 'rev-parse', 'HEAD').trim();
  git(base, 'clone', '-q', '--bare', origin, l.repo);
  const snap = { head, branch: 'sandbox/slot1', status: before.split('\n').filter(Boolean).sort(), staged: '', unstaged: git(sb, 'diff', '--binary') };
  await rehome(sb, 'slot1', l, snap, path.join(sb, '.git'));
  assert.match(fs.readFileSync(path.join(sb, '.git'), 'utf8'), /repo[\/]worktrees[\/]slot1/);
  assert.match(fs.readFileSync(path.join(sb, '.git.pre-ffw'), 'utf8'), /clone[\/]\.git[\/]worktrees[\/]slot1/);
  const config = path.join(base, 'daemon.json');
  fs.writeFileSync(config, JSON.stringify({ root: l.root, appDir: path.join(l.root, 'app') }));
  fs.writeFileSync(path.join(l.root, 'migration.json'), JSON.stringify({ from: path.join(l.root, 'app'), startedAt: '', state: 'prepared', moved: [{ id: 'slot1', from: sb, to: sb, method: 'rename', armedReimport: true }], renamed: [], config }));
  await rollback(l.root);
  assert.ok(fs.existsSync(sb), 'it never moved');
  assert.match(fs.readFileSync(path.join(sb, '.git'), 'utf8'), /clone[\/]\.git[\/]worktrees[\/]slot1/);
  assert.equal(git(sb, 'status', '--porcelain=v1'), before, 'its work as it was, in the old clone');
  assert.doesNotMatch(git(l.repo, 'worktree', 'list'), /slot1/, "the root's clone forgot it");
  assert.ok(fs.existsSync(path.join(clone, '.git')), 'the old clone stays');
}));

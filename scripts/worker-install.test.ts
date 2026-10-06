// w513: the worker install, uninstall and migration (scripts/worker/; docs/worker-install.md). The end-to-end runs
// against a throwaway portal (scripts/worker/test/) are in the runbook; these cover the decisions and the git move.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readToken, rootEnv, withRootDefaults } from '../machine/daemon.ts';
import { macControlScript, macLabel, macReloadLines, plist } from '../server/machineDeploy.ts';
import { installScript, taskName, uninstallScript } from '../server/machineDeployWin.ts';
import { adoptLayout, leaveRoot } from '../server/machines.ts';
import type { Machine } from '../shared/types.ts';
import { claudeSlug, plan, rehome, sameVolume, type OldLayout } from './worker/migrate.ts';
import { credentialId, daemonJson, gitVersion, layoutOf, noteOutside, parseArgs, preflightProblems, type Facts, type InstallOptions, type Manifest } from './worker/worker.ts';

const TOKEN = `ffm_lothdesktop_${'A'.repeat(43)}`;
const OPTS = { root: 'D:\\work\\ffw', portalUrl: 'https://portal.example', slots: 8, maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2 };
const GOOD: Facts = {
  platform: 'win32',
  elevated: false,
  nodeVersion: 'v22.17.1',
  git: [2, 50],
  gitLfs: true,
  claude: 'C:\\Users\\l\\.local\\bin\\claude.exe',
  rootState: 'missing',
  rootParentExists: true,
  freeGB: 81,
  portal: { ok: true, me: { id: 'lothdesktop', online: false, agents: [], sandboxes: [] } },
  credentialId: 'lothdesktop',
  loggedOn: true,
};

test('worker install: the command line, the credential and git versions', () => {
  assert.deepEqual(parseArgs(['install', '--root', 'D:\\ffw', '--no-firewall', '--slots', '4']), { cmd: 'install', opts: { root: 'D:\\ffw', slots: '4' }, flags: new Set(['no-firewall']) });
  assert.throws(() => parseArgs(['install', 'stray']), /unexpected argument "stray"/);
  assert.equal(credentialId(TOKEN), 'lothdesktop');
  assert.equal(credentialId(`  ${TOKEN}\n`), 'lothdesktop');
  assert.equal(credentialId('ffm_x_short'), undefined);
  assert.equal(credentialId('sk-ant-oat01-whatever'), undefined);
  assert.deepEqual(gitVersion('git version 2.45.1.windows.1'), [2, 45]);
  assert.deepEqual(gitVersion('git version 2.50.1 (Apple Git-155)'), [2, 50]);
  assert.equal(gitVersion('not git'), undefined);
});

test('worker install: every missing prerequisite is named before anything changes', () => {
  assert.deepEqual(preflightProblems(GOOD, OPTS), []);
  const bad = (f: Partial<Facts>, o: Partial<typeof OPTS> = {}) => preflightProblems({ ...GOOD, ...f }, { ...OPTS, ...o }).join('\n');
  assert.match(bad({ elevated: true }), /not administrator/);
  assert.deepEqual(preflightProblems({ ...GOOD, elevated: true }, { ...OPTS, owner: 'Lothsahn' }), [], 'an elevated run that gives its files to the user (--owner)');
  assert.match(bad({ git: [2, 45] }), /git 2\.45 is too old: 2\.48 or newer.*winget upgrade --id Git\.Git/);
  assert.match(bad({ git: undefined }), /git is missing.*winget install --id Git\.Git/);
  assert.match(bad({ platform: 'darwin', git: [2, 46] }), /brew upgrade git/);
  assert.match(bad({ gitLfs: false }), /git-lfs is missing/);
  assert.match(bad({ claude: undefined }), /Claude Code is missing/);
  assert.deepEqual(preflightProblems({ ...GOOD, claude: undefined, claudeShim: 'C:\Users\l\AppData\Roaming\npm\claude.cmd' }, OPTS), [], 'an npm shim is enough: the SDK uses its own (as the portal's deploy)');
  assert.match(bad({ nodeVersion: 'v20.11.0' }), /node 22\.6 or newer/);
  assert.match(bad({ rootState: 'other' }), /already holds other files/);
  assert.match(bad({ rootParentExists: false }), /does not exist/);
  assert.match(bad({ freeGB: 12 }), /only 12 GB free/);
  assert.match(bad({}, { portalUrl: 'https://p/x' }), /no path/);
  assert.match(bad({ portal: { ok: false, error: 'the portal does not accept this credential' } }), /does not accept/);
  assert.match(bad({ portal: { ok: true, me: { id: 'm5', online: false, agents: [], sandboxes: [] } } }), /machine m5, not lothdesktop/);
  assert.match(bad({ credentialId: undefined }), /not a machine credential/);
  assert.match(bad({ serviceElsewhere: 'the FFFactoryDaemon task runs D:\\work\\.ff-factory' }), /move it into a root with migrate/);
  assert.match(bad({ loggedOn: false }), /nobody is logged on/);
  assert.match(bad({}, { slots: 0 }), /--slots must be a whole number from 1 to 32/);
  assert.equal(preflightProblems({ ...GOOD, elevated: true, git: [2, 1], gitLfs: false }, OPTS).length, 3, 'all of them at once');
});

test('worker install: daemon.json keeps every folder in the root and no token; a migration carries the old settings', () => {
  const root = path.join(os.tmpdir(), `ffw-json-${process.pid}`);
  const l = layoutOf(root);
  const o: InstallOptions = { ...OPTS, root, token: TOKEN, repoUrl: 'x', service: 'FFFactoryDaemon', firewall: true };
  const j = daemonJson(o, l, 'lothdesktop', 'C:\\claude.exe');
  assert.equal('token' in j, false);
  assert.equal(j.tokenFile, l.token);
  assert.equal(j.root, root);
  assert.equal(j.repoPath, l.repo);
  assert.equal(j.appDir, l.daemon);
  assert.equal(j.tempDir, l.tmp);
  assert.equal(j.maxSessions, 0, 'sandboxes only (w477)');
  assert.equal((j.sandboxes as { root: string }).root, l.sandboxes);
  const carried = daemonJson({ ...o, carry: { token: TOKEN, appDir: 'C:\\old', repoPath: 'C:\\ffsb\\_base', hostGuard: { devDriveVhdx: 'C:\\ffsb-devdrive.vhdx' }, sandboxes: { root: 'F:\\ffsb', maxSandboxes: 5, librarySeed: 'F:\\ffsb\\_seed\\Library', belowNormal: true } } }, l, 'beast', undefined);
  assert.equal('token' in carried, false, 'the old token never reaches the new daemon.json');
  assert.deepEqual(carried.hostGuard, { devDriveVhdx: 'C:\\ffsb-devdrive.vhdx' });
  assert.equal(carried.appDir, l.daemon);
  assert.equal(carried.repoPath, l.repo);
  const pool = carried.sandboxes as Record<string, unknown>;
  assert.equal(pool.root, l.sandboxes);
  assert.equal(pool.maxSandboxes, 5, 'the old limits');
  assert.equal(pool.belowNormal, true);
  assert.equal(pool.librarySeed, undefined, 'the old seed path is not the root\'s');
  const m = { outside: [] } as unknown as Manifest;
  noteOutside(m, { kind: 'task', name: 'FFFactoryDaemon' });
  noteOutside(m, { kind: 'task', name: 'fffactorydaemon' });
  assert.equal(m.outside.length, 1);
});

test('worker install: a second install uses its own task or LaunchAgent and stops only its own daemon', () => {
  assert.equal(taskName(), 'FFFactoryDaemon');
  assert.equal(taskName({ task: 'FFWorkerTest-w513' }), 'FFWorkerTest-w513');
  assert.throws(() => taskName({ task: "x'; Remove-Item C:\\" }), /not a usable scheduled task name/);
  const s = installScript({ sid: 'S-1-5-21-1-2-3-1001', home: 'C:\\Users\\l', config: '{}', node: 'C:\\node.exe', flag: false, appDir: 'D:\\ffw\\daemon', service: { task: 'FFWorkerTest', only: true } });
  assert.match(s, /Register-ScheduledTask -TaskName 'FFWorkerTest'/);
  assert.match(s, /\$FFDirs = @\(@\(\$F\) \| Select-Object -Unique\)/, 'only its own folder');
  assert.doesNotMatch(s, /'FFFactoryDaemon'/);
  assert.match(installScript({ sid: 'S-1-5-21-1-2-3-1001', home: 'C:\\Users\\l', config: '{}', node: 'C:\\node.exe', flag: false }), /\.ff-factory'\)/, 'a portal deploy still stops a daemon in the default folder');
  assert.match(uninstallScript('D:\\ffw\\daemon', { task: 'FFWorkerTest', only: true }), /Unregister-ScheduledTask -TaskName 'FFWorkerTest'/);
  assert.equal(macLabel('com.fffactory.w513test'), 'com.fffactory.w513test');
  assert.throws(() => macLabel('a b;rm -rf'), /not a usable LaunchAgent label/);
  assert.match(plist('/Users/b', '/opt/homebrew/bin/node', false, '', '/Users/b/ffw/daemon', 'com.fffactory.w513test'), /<key>Label<\/key><string>com\.fffactory\.w513test<\/string>/);
  assert.match(macReloadLines('gui/501', 'com.fffactory.w513test'), /bootout gui\/501\/com\.fffactory\.w513test/);
  assert.match(macControlScript('uninstall', 'com.fffactory.w513test'), /LaunchAgents\/com\.fffactory\.w513test\.plist/);
});

test('worker daemon: a root gives the folders, the agents\' environment and the credential file', () => {
  const cfg = withRootDefaults({ portalUrl: 'https://p', id: 'x', token: '', repoPath: '/r/repo', root: '/r' });
  assert.equal(cfg.appDir, path.join('/r', 'daemon'));
  assert.equal(cfg.tempDir, path.join('/r', 'tmp'));
  assert.equal(cfg.tokenFile, path.join('/r', 'secrets', 'machine-token'));
  assert.equal(cfg.unitySlotsDir, undefined, 'the Unity slots mailbox stays where every script finds it (w469)');
  assert.equal(cfg.maxEventsFile, path.join('/r', 'daemon', 'max-events.jsonl'));
  assert.equal(withRootDefaults({ portalUrl: 'p', id: 'x', token: 't', repoPath: 'r' }).appDir, undefined, 'no root: unchanged');
  assert.deepEqual(rootEnv('/r'), { FF_WORKER_ROOT: '/r', FF_PLAYER_SLOT_ROOT: path.join('/r', 'players'), FF_NIGHTLY_ROOT: path.join('/r', 'nightly') });
  assert.equal(readToken({ token: 'in-json' }), 'in-json');
  assert.equal(readToken({ token: '', tokenFile: 'f' }, () => `${TOKEN}\r\n`), TOKEN);
  assert.throws(() => readToken({ token: '', tokenFile: 'f' }, () => '\n'), /is empty/);
  assert.throws(() => readToken({ token: '' }), /neither a token nor a tokenFile/);
});

test('worker portal record: a new root is the daemon\'s to say; a rollback gives the old folders back', () => {
  const m = { id: 'beast', appDir: 'C:\\Users\\r\\.ff-factory', repoPath: 'C:\\ffsb\\_base', sandboxRoot: 'F:\\ffsb', librarySeed: 'F:\\ffsb\\_seed\\Library', maxSandboxes: 5 } as Machine;
  const layout = { root: 'F:\\ffw', appDir: 'F:\\ffw\\daemon', repoPath: 'F:\\ffw\\repo', tempDir: 'F:\\ffw\\tmp', sandboxes: { root: 'F:\\ffw\\sandboxes', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2, diskWarnGB: 50, diskCriticalGB: 20 } };
  assert.equal(adoptLayout(m, layout), true, 'the pool moved');
  assert.equal(m.root, 'F:\\ffw');
  assert.equal(m.sandboxRoot, 'F:\\ffw\\sandboxes');
  assert.equal(m.repoPath, 'F:\\ffw\\repo');
  assert.equal(m.maxSandboxes, 5, 'the record\'s limits stay');
  assert.deepEqual(m.preRoot, { appDir: 'C:\\Users\\r\\.ff-factory', repoPath: 'C:\\ffsb\\_base', tempDir: undefined, sandboxRoot: 'F:\\ffsb', librarySeed: 'F:\\ffsb\\_seed\\Library' });
  m.sandboxRoot = 'G:\\elsewhere';
  assert.equal(adoptLayout(m, layout), false, 'the same root again: the record (add_machine) wins');
  assert.equal(m.sandboxRoot, 'G:\\elsewhere');
  m.sandboxRoot = 'F:\\ffw\\sandboxes';
  assert.equal(leaveRoot(m), true);
  assert.equal(m.root, undefined);
  assert.equal(m.sandboxRoot, 'F:\\ffsb');
  assert.equal(m.repoPath, 'C:\\ffsb\\_base');
  assert.equal(leaveRoot(m), false, 'no root: nothing to give back');
});

test('worker migration: Claude\'s folder names, volumes and the plan', () => {
  // Measured: a worker in F:\ffsb\agent-mcp keeps its conversations in ~/.claude/projects/F--ffsb-agent-mcp.
  assert.equal(claudeSlug('F:\\ffsb\\agent-mcp'), 'F--ffsb-agent-mcp');
  assert.equal(claudeSlug('/Users/b/ffw/sandboxes/sb1'), '-Users-b-ffw-sandboxes-sb1');
  assert.equal(sameVolume('F:\\ffsb\\x', 'f:\\ffw\\sandboxes\\x', 'win32'), true);
  assert.equal(sameVolume('C:\\ffsb\\x', 'F:\\ffw', 'win32'), false);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-plan-'));
  try {
    const sb = path.join(base, 'old', 'sb1');
    fs.mkdirSync(sb, { recursive: true });
    const old: OldLayout = { appDir: path.join(base, 'oldapp'), config: {}, token: 't', repoPath: path.join(base, 'clone'), sandboxes: [{ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/develop', path: sb, createdAt: '', status: 'ready' }], nightlyRoots: [], slotRoot: path.join(base, 'players') };
    const items = plan(old, layoutOf(path.join(base, 'root')), { claudeDir: path.join(base, 'claude'), measure: false });
    const sbItem = items.find((i) => i.what.startsWith('sandbox sb1'))!;
    assert.equal(sbItem.method, 'rehome', 'same volume: renamed in place');
    assert.equal(sbItem.to, path.join(base, 'root', 'sandboxes', 'sb1'));
    assert.ok(items.some((i) => i.method === 'leave' && i.what === 'the old clone'));
    assert.ok(items.some((i) => i.method === 'leave' && i.what === 'player slots'));
    assert.ok(items.some((i) => i.what.startsWith('the machine credential') && i.note === 'never printed'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('worker migration: a sandbox moves to the root\'s clone with its commits, staged, unstaged and untracked work', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-rehome-'));
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', '-c', 'core.autocrlf=false', ...a], { cwd, stdio: 'pipe' }).toString();
  try {
    const origin = path.join(base, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'develop');
    fs.writeFileSync(path.join(origin, 'README.md'), 'hi\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'init');
    const clone = path.join(base, 'clone');
    git(base, 'clone', '-q', origin, clone);
    const oldSb = path.join(base, 'oldsb', 'sb1');
    git(clone, 'worktree', 'add', '-q', '-b', 'sandbox/sb1', oldSb, 'origin/develop');
    fs.writeFileSync(path.join(oldSb, 'c.txt'), 'committed\n');
    git(oldSb, 'add', 'c.txt');
    git(oldSb, 'commit', '-qm', 'unpushed');
    fs.writeFileSync(path.join(oldSb, 's.txt'), 'staged\n');
    git(oldSb, 'add', 's.txt');
    fs.appendFileSync(path.join(oldSb, 'README.md'), 'unstaged\n');
    fs.writeFileSync(path.join(oldSb, 'u.txt'), 'untracked\n');
    const before = git(oldSb, 'status', '--porcelain=v1');
    const head = git(oldSb, 'rev-parse', 'HEAD').trim();

    const l = layoutOf(path.join(base, 'root'));
    git(base, 'clone', '-q', '--bare', origin, l.repo);
    git(l.repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    fs.mkdirSync(l.sandboxes, { recursive: true });
    const to = path.join(l.sandboxes, 'sb1');
    const snap = {
      head,
      branch: 'sandbox/sb1',
      status: before.split('\n').filter(Boolean).sort(),
      staged: git(oldSb, 'diff', '--cached', '--binary'),
      unstaged: git(oldSb, 'diff', '--binary'),
    };
    fs.renameSync(oldSb, to);
    const armed = await rehome(to, 'sb1', l, snap, path.join(to, '.git'));
    assert.equal(armed, true, 'the one-time script reimport was armed by the move');
    assert.equal(git(to, 'rev-parse', 'HEAD').trim(), head);
    assert.equal(git(to, 'status', '--porcelain=v1'), before, 'the same work, nothing more (.git.pre-ffw and the reimport folder are excluded)');
    assert.match(fs.readFileSync(path.join(to, '.git'), 'utf8'), /repo[\\/]worktrees[\\/]sb1/);
    assert.match(fs.readFileSync(path.join(to, '.git.pre-ffw'), 'utf8'), /clone[\\/]\.git[\\/]worktrees[\\/]sb1/, 'the old link kept for a rollback');
    assert.match(git(l.repo, 'worktree', 'list'), /sb1/);
    assert.equal(git(l.repo, 'log', '--oneline', 'sandbox/sb1').split('\n').filter(Boolean).length, 2, 'the unpushed commit came along');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

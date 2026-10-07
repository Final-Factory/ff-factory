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
import { installScript, taskName, taskXml, uninstallScript } from '../server/machineDeployWin.ts';
import { adoptLayout, leaveRoot } from '../server/machines.ts';
import type { Machine } from '../shared/types.ts';
import { carryExclude, claudeSlug, plan, rehome, sameVolume, stopOldScript, type OldLayout } from './worker/migrate.ts';
import { cloneRepo, credentialId, daemonJson, gitVersion, holdRedeploys, layoutOf, nightlyTaskProblem, playerFolders, supervisorProblems, syncPlayerFolders, noteOutside, parseArgs, preflightProblems, removeSlotsPointer, writeSlotsPointer, type Facts, type InstallOptions, type Manifest } from './worker/worker.ts';
import { slotsPointer } from '../machine/unitySlots.ts';
import { adminFromProbe, authorizeIn, authorizedKeysFile, fetchPortalKey, inAdministrators, keyBlob, parseKeyscan, registerSsh, revokeIn, tailnetNameOf, withAuthorizedKey, withoutAuthorizedKey } from './worker/portalSsh.ts';
import { runElevatedSteps } from './worker/worker.ts';

const TOKEN = `ffm_lothdesktop_${'A'.repeat(43)}`;
const OPTS = { root: 'D:\\work\\ffw', portalUrl: 'https://portal.example', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2 };
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
  assert.deepEqual(preflightProblems({ ...GOOD, claude: undefined, claudeShim: 'C:\\Users\\l\\AppData\\Roaming\\npm\\claude.cmd' }, OPTS), [], "an npm shim is enough: the SDK uses its own (as in the portal's deploy)");
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
  const four = { ok: true as const, me: { id: 'lothdesktop', online: true, agents: [], sandboxes: ['slot1', 'slot2', 'slot3', 'slot4'] } };
  assert.match(bad({ portal: four }, { maxSandboxes: 3 }), /--max-sandboxes 3 is below the 4 sandboxes there \(slot1, slot2, slot3, slot4\): delete 1 first/);
  assert.deepEqual(preflightProblems({ ...GOOD, portal: four }, { ...OPTS, maxSandboxes: 4 }), [], 'as many as there are is fine (w576)');
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
  assert.equal(m.maxSandboxes, 3, "its sandbox count is its installer's (w576: the installer also makes the player-folder pairs)");
  assert.equal(m.maxUnity, 2, 'a limit the record lacks comes from the daemon');
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

test('worker install: a migration seeds the root\'s clone from the old clone\'s origin branches, its remote still the real one', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-seed-'));
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', ...a], { cwd, stdio: 'pipe' }).toString();
  try {
    const origin = path.join(base, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'develop');
    fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'init');
    const clone = path.join(base, 'clone');
    git(base, 'clone', '-q', origin, clone);
    git(clone, 'checkout', '-q', '-b', 'mine');
    const repo = path.join(base, 'root', 'repo');
    await cloneRepo({ repo }, 'https://example.invalid/never/fetched.git', false, clone);
    assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/develop').trim(), git(origin, 'rev-parse', 'develop').trim());
    assert.equal(git(repo, 'for-each-ref', 'refs/heads').trim(), '', "the person's own branches stay theirs");
    assert.equal(git(repo, 'config', 'remote.origin.url').trim(), 'https://example.invalid/never/fetched.git');
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
    // An agent's scratch folder the old clone's info/exclude hides (pr-fix's .w397 on LothDesktop, w513).
    fs.mkdirSync(path.join(clone, '.git', 'info'), { recursive: true });
    fs.appendFileSync(path.join(clone, '.git', 'info', 'exclude'), '\n.w9/\n');
    fs.mkdirSync(path.join(oldSb, '.w9'));
    fs.writeFileSync(path.join(oldSb, '.w9', 'scratch.bin'), 'x');
    const before = git(oldSb, 'status', '--porcelain=v1');
    assert.doesNotMatch(before, /\.w9/);
    const head = git(oldSb, 'rev-parse', 'HEAD').trim();

    const l = layoutOf(path.join(base, 'root'));
    git(base, 'clone', '-q', '--bare', origin, l.repo);
    git(l.repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    fs.mkdirSync(l.sandboxes, { recursive: true });
    assert.equal(carryExclude(path.join(clone, '.git'), l.repo), 1);
    assert.equal(carryExclude(path.join(clone, '.git'), l.repo), 0, 'carried once');
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

test('worker install: the Unity slots pointer leads scripts outside the daemon to the root\'s mailbox; uninstall removes only its own (w469)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-wslots-'));
  try {
    const root = path.join(home, 'ff-worker');
    const file = writeSlotsPointer({ daemon: path.join(root, 'daemon') }, home);
    assert.equal(file, slotsPointer(home));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { dir: path.join(root, 'daemon', 'unity-slots') });
    assert.equal(removeSlotsPointer(path.join(home, 'other-root'), home), false, "another install's root: left");
    assert.ok(fs.existsSync(file));
    assert.equal(removeSlotsPointer(root, home), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(removeSlotsPointer(root, home), false, 'none left: nothing to do');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('worker migration: the portal holds its redeploys before the old daemon stops, and the stop checks nothing of it runs (w513)', async () => {
  const asked: string[] = [];
  const answer = (status: number) => (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push(`${init?.method} ${String(url)} ${new Headers(init?.headers).get('authorization')}`);
    return new Response('{}', { status });
  }) as typeof fetch;
  assert.deepEqual(await holdRedeploys('https://portal.example', 'ffm_pc_x', answer(200)), { ok: true });
  assert.deepEqual(asked, ['POST https://portal.example/machine/stopping Bearer ffm_pc_x']);
  const old = await holdRedeploys('https://portal.example', 'ffm_pc_x', answer(404));
  assert.equal(old.ok === false && old.tooOld, true, 'an older portal: allowed only once its daemon was stopped from the portal');
  const refused = await holdRedeploys('https://portal.example', 'ffm_pc_x', answer(401));
  assert.equal(refused.ok === false && !refused.tooOld && /HTTP 401/.test(refused.error), true);
  // The stop counts what still runs from the old folder: the supervisor and the daemon, nothing else.
  const s = stopOldScript('D:\\work\\.ff-factory', 'FFFactoryDaemon');
  assert.match(s, /Stop-FFDaemon/);
  assert.ok(s.includes(`$marks = @('D:\\work\\.ff-factory\\app\\machine\\daemon.ts', 'D:\\work\\.ff-factory\\run-daemon.ps1')`));
  assert.match(s, /'left=' \+ \$left\.Count/);
});

// ---------------------------------------------------------------- the portal's ssh (w568, scripts/worker/portalSsh.ts)

const PORTAL_PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGgE0GjCLsOOdLNBCR5KKXguNoZCX0Mh7C3tZbQzCDQx fff-portal@fff-portal';
const PORTAL_LINE = `from="100.124.172.97",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${PORTAL_PUB}`;
const BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIGgE0GjCLsOOdLNBCR5KKXguNoZCX0Mh7C3tZbQzCDQx';
const OTHER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJPzhFYZX4GtbGkBP2Fl8RqwkZaXjQ9fUWN9P+p+/OX3 ben@laptop';
const OTHER_KEY = OTHER.split(' ').slice(0, 2).join(' ');

test('worker install: the portal\'s key line goes in once, replaces an earlier line for the same key in place, and comes out alone (w568)', () => {
  assert.equal(keyBlob(PORTAL_LINE), BLOB, 'after the options');
  assert.equal(keyBlob(OTHER), 'AAAAC3NzaC1lZDI1NTE5AAAAIJPzhFYZX4GtbGkBP2Fl8RqwkZaXjQ9fUWN9P+p+/OX3');
  assert.equal(keyBlob('# a comment'), undefined);
  // Into an empty file, and into one with a person's key: added at the end, theirs kept.
  assert.deepEqual(withAuthorizedKey('', PORTAL_LINE), { text: `${PORTAL_LINE}\n`, changed: true, existed: false });
  const two = withAuthorizedKey(`# keys\r\n${OTHER}\r\n`, PORTAL_LINE);
  assert.equal(two.text, `# keys\n${OTHER}\n${PORTAL_LINE}\n`);
  // Again: nothing changes. A line pasted by hand earlier (no from=): replaced in place, and remembered as existing.
  assert.deepEqual(withAuthorizedKey(two.text, PORTAL_LINE), { text: two.text, changed: false, existed: true });
  assert.deepEqual(withAuthorizedKey(`${PORTAL_PUB}\n${OTHER}\n`, PORTAL_LINE), { text: `${PORTAL_LINE}\n${OTHER}\n`, changed: true, existed: true });
  // Out: exactly the lines for that key; the person's key and the comment stay.
  assert.deepEqual(withoutAuthorizedKey(two.text, BLOB), { text: `# keys\n${OTHER}\n`, removed: 1 });
  assert.deepEqual(withoutAuthorizedKey(`${OTHER}\n`, BLOB), { text: `${OTHER}\n`, removed: 0 });
  assert.throws(() => withAuthorizedKey('', 'not a key'), /not an authorized_keys line/);
});

test('worker install: where this account\'s sshd reads its keys: Windows\' admin file for a member of Administrators, else its own (w568)', () => {
  assert.equal(authorizedKeysFile('win32', 'C:\\Users\\Loth', true, 'C:\\ProgramData'), 'C:\\ProgramData\\ssh\\administrators_authorized_keys');
  assert.equal(authorizedKeysFile('win32', 'C:\\Users\\Loth', false, 'C:\\ProgramData'), 'C:\\Users\\Loth\\.ssh\\authorized_keys');
  assert.equal(authorizedKeysFile('darwin', '/Users/benryding', true), '/Users/benryding/.ssh/authorized_keys', 'a Mac has no admin file');
  // whoami /groups /fo csv for an admin in a non-elevated shell: the group is there, deny-only.
  assert.equal(inAdministrators('"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n'), true);
  assert.equal(inAdministrators('"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"\r\n'), false);
  assert.equal(adminFromProbe('admin=True\r\n'), true);
  assert.equal(adminFromProbe('admin=False\r\n'), false);
  assert.equal(adminFromProbe(''), false, 'no answer: not an admin, so its own file');
});

test('worker install: this machine\'s host keys come from its own sshd (a loopback ssh-keyscan), ed25519 first; its tailnet name from Tailscale (w568)', () => {
  const scan = [
    '# 127.0.0.1:22 SSH-2.0-OpenSSH_for_Windows_9.5',
    '127.0.0.1 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7',
    `127.0.0.1 ${OTHER_KEY}`,
    '127.0.0.1 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=',
    '127.0.0.1 ssh-dss AAAAB3NzaC1kc3M',
    '',
  ].join('\n');
  assert.deepEqual(parseKeyscan(scan), [OTHER_KEY, 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7']);
  assert.deepEqual(parseKeyscan(''), [], 'no sshd answers');
  assert.equal(tailnetNameOf(JSON.stringify({ Self: { DNSName: 'M3.tailedfcad.ts.net.', HostName: 'Bens-MacBook' } })), 'm3');
  assert.equal(tailnetNameOf(JSON.stringify({ Self: { DNSName: '', HostName: 'Loth2800' } })), 'loth2800');
  assert.equal(tailnetNameOf('not json'), undefined);
});

test('worker install: the portal\'s key comes from GET /machine/ssh with this machine\'s own credential; the host keys go back with POST (w568)', async () => {
  const seen: { url: string; auth?: string; method?: string; body?: string }[] = [];
  const fake = (status: number, body: unknown) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization, method: init?.method, body: init?.body as string | undefined });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  const k = await fetchPortalKey('https://portal.example', TOKEN, fake(200, { publicKey: PORTAL_PUB, from: '100.124.172.97', authorizedKey: PORTAL_LINE }));
  assert.deepEqual(k, { ok: true, key: { publicKey: PORTAL_PUB, authorizedKey: PORTAL_LINE, from: '100.124.172.97' } });
  assert.deepEqual([seen[0].url, seen[0].auth], ['https://portal.example/machine/ssh', `Bearer ${TOKEN}`]);
  assert.deepEqual(await fetchPortalKey('https://portal.example', TOKEN, fake(401, { error: 'a valid machine token is required' })), { ok: false, error: 'a valid machine token is required' });
  assert.deepEqual(await fetchPortalKey('https://portal.example', TOKEN, fake(200, { authorizedKey: 'rm -rf /' })), { ok: false, error: 'the portal sent no usable key line' });
  const r = await registerSsh('https://portal.example', TOKEN, { user: 'benryding', host: 'm3', hostKeys: [OTHER_KEY] }, fake(200, { host: 'benryding@m3', reachable: false, detail: 'Permission denied (publickey).' }));
  assert.deepEqual(r, { ok: true, host: 'benryding@m3', reachable: false, detail: 'Permission denied (publickey).' });
  assert.equal(seen.at(-1)!.method, 'POST');
  assert.deepEqual(JSON.parse(seen.at(-1)!.body!), { user: 'benryding', host: 'm3', hostKeys: [OTHER_KEY] });
});

test('worker install: the key file itself: made with its folder, the key in once, then out (w568)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-ssh-'));
  try {
    const file = path.join(home, '.ssh', 'authorized_keys');
    assert.deepEqual(authorizeIn(file, PORTAL_LINE), { changed: true, existed: false });
    assert.deepEqual(authorizeIn(file, PORTAL_LINE), { changed: false, existed: true });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    fs.appendFileSync(file, `${OTHER}\n`);
    // The uninstall's removal, as its elevated step runs it on Windows' admin file (any file here: no icacls needed).
    const log = path.join(home, 'elevated.log');
    assert.equal(await runElevatedSteps([{ kind: 'revoke-key', file, blob: BLOB }], log), 0);
    assert.equal(fs.readFileSync(file, 'utf8'), `${OTHER}\n`);
    assert.match(fs.readFileSync(log, 'utf8'), /removed 1 line\(s\) from /);
    assert.equal(revokeIn(path.join(home, 'none'), BLOB), 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('worker install: a nightly lab task left on an old root is named, with the command that re-points it (w577)', () => {
  // lothdesktop's task after w513, as schtasks /query /tn ff-nightly-e2e /xml printed it (2026-10-06).
  const old = String.raw`<Actions Context="Author">
    <Exec>
      <Command>"C:\Program Files\Git\bin\bash.exe"</Command>
      <Arguments>-lc "FF_NIGHTLY_ROOT="/d/work/ff-nightly" bash "/d/work/ff-nightly/FinalFactory/scripts/nightly/nightly.sh""</Arguments>
    </Exec>
  </Actions>`;
  const root = String.raw`D:\work\ffw\nightly`;
  const said = nightlyTaskProblem(old, root) ?? '';
  assert.ok(said.includes(`does not run from ${root}`), said);
  assert.ok(said.includes('(it runs: -lc "FF_NIGHTLY_ROOT="/d/work/ff-nightly" bash'), said);
  assert.ok(said.includes(`FF_NIGHTLY_ROOT="${root}" bash scripts/nightly/install_schedule.sh`), said);
  // Re-pointed: Git Bash's form or Windows' form of the root, any case, a trailing separator: nothing to say.
  assert.equal(nightlyTaskProblem(old.replaceAll('/d/work/ff-nightly', '/d/work/ffw/nightly'), root), undefined);
  assert.equal(nightlyTaskProblem(old.replaceAll('/d/work/ff-nightly', String.raw`D:\Work\FFW\nightly`), root + '/'), undefined);
  // No task, no line.
  assert.equal(nightlyTaskProblem(undefined, root), undefined);
  assert.equal(nightlyTaskProblem('', root), undefined);
});

test("worker install: each sandbox owns two player folders, and a new count adds or removes pairs (w576)", () => {
  assert.deepEqual(playerFolders(2), ['slot1-0', 'slot1-1', 'slot2-0', 'slot2-1', 'slotnightly-0', 'slotnightly-1']);
  assert.equal(playerFolders(5).length, 12, "5 sandboxes' pairs and the nightly lab's");
  const players = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-players-'));
  try {
    // LothDesktop before: the old pool slot0..slot7, one with a leftover build and its lease files.
    for (let k = 0; k < 8; k++) fs.mkdirSync(path.join(players, `slot${k}`, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(players, 'slot0', 'slot.json'), '{}');
    fs.writeFileSync(path.join(players, 'pool.lock'), '');
    const lines: string[] = [];
    const first = syncPlayerFolders(players, playerFolders(5), (l) => lines.push(l));
    assert.equal(first.made.length, 12);
    assert.deepEqual(first.removed.sort(), ['slot0', 'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7']);
    assert.deepEqual(fs.readdirSync(players).sort(), ['pool.lock', ...playerFolders(5)].sort(), 'other files stay');
    // Lowered to 4 sandboxes: slot5's pair goes; the rest are kept as they are.
    fs.writeFileSync(path.join(players, 'slot1-0', 'slot.json'), '{"sha":"a"}');
    const second = syncPlayerFolders(players, playerFolders(4), (l) => lines.push(l));
    assert.deepEqual([second.made, second.removed.sort(), second.kept], [[], ['slot5-0', 'slot5-1'], []]);
    assert.equal(fs.readFileSync(path.join(players, 'slot1-0', 'slot.json'), 'utf8'), '{"sha":"a"}');
    assert.deepEqual(lines, []);
  } finally {
    fs.rmSync(players, { recursive: true, force: true });
  }
});

test('worker install: the supervisor is required, and what the installer writes passes its check (w576)', () => {
  const ok = { installed: true, here: true, restarts: true, script: true, running: 1 };
  const winL = { daemon: String.raw`D:\work\ffw\daemon` };
  assert.deepEqual(supervisorProblems(ok, winL, 'FFFactoryDaemon', true, 'win32'), []);
  assert.deepEqual(supervisorProblems({ ...ok, installed: false }, winL, 'FFFactoryDaemon', true, 'win32'), ['no FFFactoryDaemon task']);
  // A task an administrator registered for another folder, kept because this run could not register its own.
  const kept = supervisorProblems({ ...ok, here: false, running: 0 }, winL, 'FFFactoryDaemon', true, 'win32');
  assert.equal(kept.length, 1);
  assert.ok(kept[0].includes(String.raw`does not run D:\work\ffw\daemon\run-daemon.ps1`), kept[0]);
  assert.deepEqual(supervisorProblems({ ...ok, restarts: false, script: false }, winL, 'FFFactoryDaemon', true, 'win32').length, 2);
  // Running is required only when someone is logged on (otherwise it starts at the next logon).
  assert.deepEqual(supervisorProblems({ ...ok, running: 0 }, winL, 'FFFactoryDaemon', true, 'win32'), [String.raw`no supervisor runs from D:\work\ffw\daemon\run-daemon.ps1`]);
  assert.deepEqual(supervisorProblems({ ...ok, running: 0 }, winL, 'FFFactoryDaemon', false, 'win32'), []);
  const macL = { daemon: '/Users/b/ffw/daemon' };
  assert.deepEqual(supervisorProblems(ok, macL, 'com.ff.daemon', true, 'darwin'), []);
  assert.ok(supervisorProblems({ ...ok, restarts: false }, macL, 'com.ff.daemon', true, 'darwin')[0].includes('KeepAlive'));
  assert.deepEqual(supervisorProblems({ ...ok, running: 0 }, macL, 'com.ff.daemon', true, 'darwin'), ['launchd does not run com.ff.daemon']);
  // The task the installer registers runs that folder's run-daemon.ps1 and is restarted on failure.
  const x = taskXml('S-1-5-21-1-2-3-1001', String.raw`C:\Users\loth`, winL.daemon);
  assert.ok(x.includes(String.raw`-File "D:\work\ffw\daemon\run-daemon.ps1"`), x);
  assert.match(x, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>/);
  // The LaunchAgent runs the root's daemon with KeepAlive, the facts supervisorFacts reads from it.
  const p = plist('/Users/b', '/opt/homebrew/bin/node', false, '', macL.daemon, 'com.ff.daemon');
  assert.ok(p.includes(`${macL.daemon}/app/machine/daemon.ts`));
  assert.match(p, /<key>KeepAlive<\/key>\s*<true\/>/);
});

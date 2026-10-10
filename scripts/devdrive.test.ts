// w900: a worker install's Dev Drive (scripts/worker/devdrive.ts, devdrive.ps1, the helper's boot mount; docs/worker-install.md
// "The Dev Drive"). The PowerShell halves run here under PowerShell 7 with the Windows disk cmdlets faked
// (scripts/worker/test/devdrive-scenario.ps1) when `pwsh` is on the PATH (CI's Linux and Windows runners have it; FF_PWSH names
// another); the real VHDX is made, remounted and re-run by scripts/worker/test/devdrive-e2e.ts on a Windows runner.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeSlug, decideDevDrive, defaultMaxGB, devDriveDirs, devDriveGuard, linkRootFolders, moveSandboxes, parseDevDriveOutput, type MoveDeps, type PoolRec } from './worker/devdrive.ts';
import { daemonJson, devDriveFlags, layoutOf, parseArgs, planUpdate, preflightProblems, type Facts, type InstallOptions, type Manifest } from './worker/worker.ts';
import { saveWork } from '../server/saveWork.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWSH = process.env.FF_PWSH || 'pwsh';
const hasPwsh = spawnSync(PWSH, ['-NoProfile', '-Command', '1'], { env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } }).status === 0;
const needPwsh = hasPwsh ? false : 'PowerShell 7 (pwsh) is not installed here';
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `w900-${name}-`));

// ---------------------------------------------------------------- the letter

/** Select-DriveLetter (scripts/privileged/devdrive-lib.ps1) on the lists given. */
function pick(o: { inUse?: string[]; mapped?: string[]; reserved?: string[]; skip?: string[]; prefer?: string }): { letter: string | null; rejected: Record<string, string> } {
  const arr = (a: string[] = []) => (a.length ? `@(${a.map((x) => `'${x}'`).join(',')})` : '@()');
  const script = `. '${path.join(HERE, 'privileged', 'devdrive-lib.ps1')}'
$r = Select-DriveLetter -InUse ${arr(o.inUse)} -Mapped ${arr(o.mapped)} -Reserved ${arr(o.reserved)} -Skip ${arr(o.skip)} -Prefer '${o.prefer ?? ''}'
@{ letter = $r.Letter; rejected = $r.Rejected } | ConvertTo-Json -Compress`;
  const out = execFileSync(PWSH, ['-NoProfile', '-Command', script], { encoding: 'utf8', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } });
  return JSON.parse(out);
}

const ALL = 'ABCDEFGHIJKLMNOPQRSTUV'.split('');

test('letters: the first free one from V: down', { skip: needPwsh }, () => {
  assert.equal(pick({ inUse: ['C', 'D', 'F'] }).letter, 'V');
  assert.equal(pick({}).letter, 'V');
  assert.equal(pick({ inUse: ['V'] }).letter, 'U');
  assert.equal(pick({ inUse: ['V', 'U', 'T'] }).letter, 'S');
  // W: to Z: are never tried (Z: is where a share is mapped first), even when everything below is gone.
  assert.equal(pick({ inUse: ALL }).letter, null);
});

test('letters: a letter in use, mapped to a network share, reserved by Windows or excluded is passed over, and says why', { skip: needPwsh }, () => {
  const r = pick({ inUse: ['C', 'D', 'V'], mapped: ['U'], reserved: ['T', 'S'], skip: ['R'] });
  assert.equal(r.letter, 'Q');
  assert.deepEqual(r.rejected, { V: 'in use', U: 'mapped network drive', T: 'reserved by Windows for another volume', S: 'reserved by Windows for another volume', R: 'excluded' });
  // Case and a colon do not matter; a list in one string neither (what a task's -Skip "U,T" carries).
  assert.equal(pick({ inUse: ['v:'], mapped: ['u'] }).letter, 'T');
  assert.equal(pick({ skip: ['V,U;T'] }).letter, 'S');
});

test('letters: A: and B: only when nothing else is free, B: before A:', { skip: needPwsh }, () => {
  const c = ALL.filter((l) => l >= 'C');
  assert.equal(pick({ inUse: c }).letter, 'B');
  assert.equal(pick({ inUse: [...c, 'B'] }).letter, 'A');
  assert.equal(pick({ inUse: c, mapped: ['B'] }).letter, 'A');
  assert.equal(pick({ inUse: c, reserved: ['B', 'A'] }).letter, null);
  // Not before: with D: free it is D:, never A: or B:.
  assert.equal(pick({ inUse: ALL.filter((l) => l >= 'E') }).letter, 'D');
});

test('letters: the drive keeps the letter it had; its own reservation does not count against it, another volume holding it does', { skip: needPwsh }, () => {
  assert.equal(pick({ prefer: 'T', reserved: ['T'] }).letter, 'T', "Windows reserved T: for this very volume when it first mounted");
  assert.equal(pick({ prefer: 'T', inUse: ['T'] }).letter, 'V', 'taken: the first free letter from V: down');
  assert.equal(pick({ prefer: 'T', mapped: ['T'], inUse: ['V'] }).letter, 'U');
  assert.equal(pick({ prefer: 'T', skip: ['T'] }).letter, 'V');
});

// ---------------------------------------------------------------- the boot mount (the helper's mount task, faked disks)

interface Scenario {
  attached: boolean;
  autoLetter?: string;
  inUse?: string[];
  mapped?: string[];
  reserved?: string[];
  state?: Record<string, unknown> | null;
  files?: Record<string, unknown>;
}

/** Run the real ffsb-helper.ps1 mount against a faked PC; returns what it called and wrote. */
function boot(sc: Scenario, o: { letter?: string; flex?: boolean; skip?: string[] } = {}) {
  const work = tmp('boot');
  const args = ['-NoProfile', '-File', path.join(HERE, 'worker', 'test', 'devdrive-scenario.ps1'), '-Helper', path.join(HERE, 'privileged', 'ffsb-helper.ps1'), '-Work', work, '-Scenario', JSON.stringify({ autoLetter: '', inUse: ['C', 'D'], mapped: [], reserved: [], state: null, files: {}, ...sc }), '-Letter', o.letter ?? 'V'];
  if (o.flex === false) args.push('-NoFlex');
  if (o.skip) args.push('-Skip', o.skip.join(','));
  const out = execFileSync(PWSH, args, { encoding: 'utf8', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } });
  fs.rmSync(work, { recursive: true, force: true });
  return JSON.parse(out) as { calls: string[]; held: string; result: { ok: boolean; detail: string } | null; state: { letter: string } | null; daemon: any; pool: PoolRec[] | null };
}

test('boot mount: a detached drive is attached and gets its letter back; an attached one is left alone', { skip: needPwsh }, () => {
  const a = boot({ attached: false, autoLetter: '', state: { letter: 'V' } });
  assert.deepEqual(a.calls, ['Mount-DiskImage', 'Set-Partition V']);
  assert.equal(a.result?.ok, true);
  assert.match(a.result!.detail, /attached .* as V:$/, 'no letter change to report');
  // Windows put it at some letter of its own on the way up (the lowest free one): it is moved to V:.
  assert.deepEqual(boot({ attached: false, autoLetter: 'E', state: { letter: 'V' } }).calls, ['Mount-DiskImage', 'Set-Partition V']);
  // Already attached and lettered: nothing is called (a second boot task, or the daemon's remount asking twice).
  const b = boot({ attached: true, autoLetter: 'V', state: { letter: 'V' } });
  assert.deepEqual(b.calls, []);
  assert.equal(b.result?.ok, true);
  assert.match(b.result!.detail, /V: is already there/);
});

test('boot mount: the letter in the state file wins over the one the task was installed with', { skip: needPwsh }, () => {
  const r = boot({ attached: false, state: { letter: 'T' } }, { letter: 'V' });
  assert.deepEqual(r.calls, ['Mount-DiskImage', 'Set-Partition T']);
  assert.equal(boot({ attached: true, autoLetter: 'T', state: { letter: 'T' } }, { letter: 'V' }).calls.length, 0);
});

test('boot mount: the letter is taken, so the next free one is used and everything that stored the old one is repointed', { skip: needPwsh }, () => {
  const files = {
    'daemon.json': { root: 'D:\\work\\ffw', sandboxes: { root: 'V:\\sandboxes', librarySeed: 'V:\\seed\\Library', librarySeedCopy: 'clone', maxSandboxes: 6 }, hostGuard: { hostDiskPaths: ['D:/'] } },
    'sandboxes.json': [
      { id: 'slot1', path: 'V:\\sandboxes\\slot1', logPath: 'V:\\sandboxes\\slot1\\Logs\\editor.log' },
      { id: 'slot2', path: 'V:\\sandboxes\\slot2' },
    ],
  };
  // V: is another volume's, U: a mapped share, T: reserved by Windows for a stick that is not plugged in: the drive goes to S:.
  const r = boot({ attached: false, inUse: ['C', 'D', 'V'], mapped: ['U'], reserved: ['T'], state: { letter: 'V', vhdx: 'D:\\work\\ffw\\devdrive.vhdx' }, files });
  assert.deepEqual(r.calls, ['Mount-DiskImage', 'Set-Partition S']);
  assert.equal(r.result?.ok, true);
  assert.match(r.result!.detail, /the letter changed from V: to S:/);
  assert.equal(r.state?.letter, 'S', 'the state file says where it is now');
  assert.equal(r.daemon.sandboxes.root, 'S:\\sandboxes');
  assert.equal(r.daemon.sandboxes.librarySeed, 'S:\\seed\\Library');
  assert.equal(r.daemon.sandboxes.maxSandboxes, 6, 'everything else is kept');
  assert.equal(r.daemon.root, 'D:\\work\\ffw', 'a path on another drive is not touched');
  assert.deepEqual(r.daemon.hostGuard.hostDiskPaths, ['D:/']);
  assert.deepEqual(r.pool?.map((x) => x.path), ['S:\\sandboxes\\slot1', 'S:\\sandboxes\\slot2']);
  assert.equal(r.pool?.[0].logPath, 'S:\\sandboxes\\slot1\\Logs\\editor.log');
});

test('boot mount: attached by Windows at a letter that is not the drive’s, it is moved to the right one when that is free, else to the next', { skip: needPwsh }, () => {
  assert.deepEqual(boot({ attached: true, autoLetter: 'E', state: { letter: 'V' } }).calls, ['Set-Partition V']);
  const r = boot({ attached: true, autoLetter: 'E', inUse: ['C', 'D', 'V'], state: { letter: 'V' } });
  assert.deepEqual(r.calls, ['Set-Partition U']);
});

test('boot mount: with no letter free from V: to A: it fails and says so, without touching anything', { skip: needPwsh }, () => {
  const r = boot({ attached: false, inUse: ALL, state: { letter: 'V' }, files: { 'daemon.json': { sandboxes: { root: 'V:\\sandboxes' } } } });
  assert.equal(r.result?.ok, false);
  assert.match(r.result!.detail, /no free drive letter from V: down to A:/);
  assert.equal(r.daemon.sandboxes.root, 'V:\\sandboxes');
});

test('boot mount: BEAST’s drive (no -Flex) still takes exactly the letter it was installed with', { skip: needPwsh }, () => {
  const r = boot({ attached: false, autoLetter: 'E', inUse: ['C', 'D'] }, { letter: 'F', flex: false });
  assert.deepEqual(r.calls, ['Mount-DiskImage', 'Set-Partition F']);
  assert.equal(r.result?.ok, true);
  // A fixed letter that is taken is not replaced (the old behaviour): Windows' own error is what the guard retries.
  assert.equal(boot({ attached: true, autoLetter: 'F' }, { letter: 'F', flex: false }).calls.length, 0);
});

// ---------------------------------------------------------------- the decisions

test('the Dev Drive is on by default for a new Windows install, off for an update, and never on a root that is already ReFS', () => {
  const win = { platform: 'win32' as const, hasOne: false, update: false };
  assert.equal(decideDevDrive({ ...win }).action, 'ensure', 'a new install: the default');
  assert.equal(decideDevDrive({ ...win, rootFileSystem: 'NTFS' }).action, 'ensure');
  assert.equal(decideDevDrive({ ...win, flag: 'off' }).action, 'none', '--no-dev-drive');
  assert.equal(decideDevDrive({ ...win, rootFileSystem: 'ReFS' }).action, 'none', "BEAST's F: needs none");
  assert.match(decideDevDrive({ ...win, rootFileSystem: 'ReFS' }).why, /already ReFS/);
  // An update (the portal runs one after every deploy, by itself) never makes one unless asked...
  assert.equal(decideDevDrive({ ...win, update: true }).action, 'none');
  assert.equal(decideDevDrive({ ...win, update: true, flag: 'on' }).action, 'ensure', '--dev-drive');
  // ...and keeps the one the install has (a re-run reuses it), unless told not to touch it.
  assert.equal(decideDevDrive({ ...win, update: true, hasOne: true }).action, 'ensure');
  assert.equal(decideDevDrive({ ...win, update: true, hasOne: true, flag: 'off' }).action, 'none');
  assert.equal(decideDevDrive({ ...win, update: true, hasOne: true, rootFileSystem: 'NTFS' }).action, 'ensure');
  for (const platform of ['darwin', 'linux'] as const) assert.equal(decideDevDrive({ platform, update: false, hasOne: false }).action, 'none');
});

test('the maximum size: 90 % of the root’s volume, between 100 GB and 1 TB, and a flag', () => {
  assert.equal(defaultMaxGB(1000), 900);
  assert.equal(defaultMaxGB(500), 450);
  assert.equal(defaultMaxGB(2000), 1024);
  assert.equal(defaultMaxGB(60), 100);
  assert.equal(defaultMaxGB(undefined), 600);
  const f = (...argv: string[]) => {
    const { opts, flags } = parseArgs(['update', ...argv]);
    return devDriveFlags(opts, flags);
  };
  assert.deepEqual(f(), {});
  assert.deepEqual(f('--dev-drive-max-gb', '600', '--dev-drive-skip', 'U,T'), { devDriveMaxGB: 600, devDriveSkip: 'U,T' });
  assert.deepEqual(f('--no-dev-drive'), { devDrive: 'off' });
  assert.deepEqual(f('--dev-drive'), { devDrive: 'on' });
  assert.deepEqual(f('--move-to-dev-drive'), { devDrive: 'on', moveToDevDrive: true });
  assert.throws(() => f('--dev-drive', '--no-dev-drive'), /contradict/);
  assert.throws(() => f('--dev-drive-max-gb', 'lots'), /whole number/);
  assert.throws(() => f('--dev-drive-skip', 'U:\\'), /drive letters/);
});

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
const OPTS = { root: 'D:\\work\\ffw', portalUrl: 'https://portal.example', maxSandboxes: 3, maxAgentsPerSandbox: 2, maxUnity: 2 };

test('preflight: the Dev Drive flags are checked, and a move needs every sandbox free of workers and editors', () => {
  const bad = (f: Partial<Facts>, o: Partial<InstallOptions> = {}) => preflightProblems({ ...GOOD, ...f }, { ...OPTS, ...o }).join('\n');
  assert.equal(bad({}, { devDrive: 'on', devDriveMaxGB: 600 }), '');
  assert.match(bad({}, { devDriveMaxGB: 20 }), /at least|from 50/);
  assert.match(bad({ platform: 'darwin' }, { devDrive: 'on' }), /Windows feature/);
  assert.match(bad({ sandboxAgents: ['Loth (a1b2, in slot2)'] }, { moveToDevDrive: true }), /1 agent\(s\) are in one: Loth \(a1b2, in slot2\)/);
  assert.match(bad({ sandboxEditors: 2 }, { moveToDevDrive: true }), /2 run\(s\) from D:\\work\\ffw\\sandboxes/);
  assert.match(bad({}, { moveToDevDrive: true, devDrive: 'off' }), /contradict/);
  assert.equal(bad({ sandboxAgents: [], sandboxEditors: 0 }, { moveToDevDrive: true }), '', 'free sandboxes: go');
});

// ---------------------------------------------------------------- daemon.json

const MANIFEST: Manifest = { installId: 'i', layout: 1, machineId: 'lothdesktop', portalUrl: 'https://portal.example', platform: 'win32', service: 'FFFactoryDaemon', slots: 6, repoUrl: 'https://github.com/x/y.git', createdAt: 't', updatedAt: 't', outside: [] };

test('daemon.json on the Dev Drive: the drive’s own paths, block-clone copies, and a host guard that watches the volume the VHDX grows on', () => {
  const l = layoutOf('D:\\work\\ffw');
  const o = { ...OPTS, token: 'ffm_x', repoUrl: 'u', service: 'FFFactoryDaemon', firewall: false, devDriveDirs: { ...devDriveDirs('v'), seedReady: true } } as InstallOptions;
  const cfg = daemonJson(o, l, 'lothdesktop', undefined) as any;
  assert.equal(cfg.sandboxes.root, 'V:\\sandboxes', 'never the junction D:\\work\\ffw\\sandboxes');
  assert.equal(cfg.sandboxes.librarySeed, 'V:\\seed\\Library');
  assert.equal(cfg.sandboxes.librarySeedCopy, 'clone');
  assert.equal(cfg.root, 'D:\\work\\ffw');
  assert.deepEqual(cfg.hostGuard, { pollSeconds: 30, warnFreeGB: 20, criticalFreeGB: 10, hysteresisGB: 10, remountMinFreeGB: 30, hostDiskPaths: ['D:/'], reapBrowsersAfterHours: 0, reapEveryMinutes: 15 });
  // No seed yet: no librarySeed (the pool then copies a sandbox's Library once).
  assert.equal((daemonJson({ ...o, devDriveDirs: { ...devDriveDirs('V'), seedReady: false } }, l, 'lothdesktop', undefined) as any).sandboxes.librarySeed, undefined);
  // A host guard the machine already has (BEAST's, tuned) is kept as it is; a carried old root and seed never beat the drive's.
  const carried = daemonJson({ ...o, update: true, carry: { hostGuard: { pollSeconds: 60, hostDiskPaths: ['C:/'] }, sandboxes: { root: 'D:\\work\\ffw\\sandboxes', librarySeed: 'D:\\work\\ffw\\seed\\Library', diskWarnGB: 50 } } }, l, 'lothdesktop', undefined) as any;
  assert.deepEqual(carried.hostGuard, { pollSeconds: 60, hostDiskPaths: ['C:/'] });
  assert.equal(carried.sandboxes.root, 'V:\\sandboxes');
  assert.equal(carried.sandboxes.librarySeed, 'V:\\seed\\Library');
  assert.equal(carried.sandboxes.diskWarnGB, 50);
  // The guard uses the pool's own thresholds, so it never refuses work sooner than the pool does.
  assert.equal((devDriveGuard('D:\\', { diskWarnGB: 50, diskCriticalGB: 25 }) as any).warnFreeGB, 50);
  // Without a Dev Drive nothing changes: the root's own folders, no clone mode, no guard of its own.
  const plain = daemonJson({ ...o, devDriveDirs: undefined }, l, 'lothdesktop', undefined) as any;
  assert.equal(plain.sandboxes.root, l.sandboxes);
  assert.equal(plain.sandboxes.librarySeedCopy, undefined);
  assert.equal(plain.hostGuard, undefined);
});

test('an update carries the Dev Drive flags, and says nothing about one when it was not asked', () => {
  const base = planUpdate('D:\\work\\ffw', MANIFEST, { portalUrl: 'https://portal.example', sandboxes: {} }, 'ffm_x', {});
  assert.equal(base.devDrive, undefined);
  assert.equal(base.moveToDevDrive, undefined);
  const move = planUpdate('D:\\work\\ffw', MANIFEST, { portalUrl: 'https://portal.example', sandboxes: {} }, 'ffm_x', { moveToDevDrive: true, devDriveMaxGB: 700, devDriveSkip: 'U' });
  assert.equal(move.devDrive, 'on');
  assert.equal(move.moveToDevDrive, true);
  assert.equal(move.devDriveMaxGB, 700);
  assert.equal(move.devDriveSkip, 'U');
});

// ---------------------------------------------------------------- the root's junctions (re-running is idempotent)

test('the root’s sandboxes and seed folders become junctions to the drive; a re-run keeps them; a new letter retargets them; a real folder with sandboxes in it is never replaced', () => {
  const root = tmp('root');
  const drive = tmp('drive'); // stands in for V:
  const target = { sandboxes: path.join(drive, 'sandboxes'), seed: path.join(drive, 'seed') };
  const made: string[] = [];
  const junction = (t: string, l: string) => {
    made.push(l);
    fs.symlinkSync(t, l, 'junction');
  };
  fs.mkdirSync(path.join(root, 'sandboxes'));
  fs.mkdirSync(path.join(root, 'seed'));
  // Empty real folders (a new install made them): replaced.
  const first = linkRootFolders(root, target, junction);
  assert.deepEqual(first.map((x) => x.action), ['created', 'created']);
  assert.equal(fs.readlinkSync(path.join(root, 'sandboxes')), target.sandboxes);
  // A second run: nothing is made, nothing changes.
  made.length = 0;
  const again = linkRootFolders(root, target, junction);
  assert.deepEqual(again.map((x) => x.action), ['kept', 'kept']);
  assert.deepEqual(made, []);
  // The drive came back on another letter: retargeted.
  const other = tmp('drive2');
  const moved = linkRootFolders(root, { sandboxes: path.join(other, 'sandboxes'), seed: path.join(other, 'seed') }, junction);
  assert.deepEqual(moved.map((x) => x.action), ['retargeted', 'retargeted']);
  assert.equal(fs.readlinkSync(path.join(root, 'seed')), path.join(other, 'seed'));
  // What is on the drive is never touched by any of it.
  fs.writeFileSync(path.join(other, 'sandboxes', 'keep.txt'), 'x');
  linkRootFolders(root, target, junction);
  assert.equal(fs.readFileSync(path.join(other, 'sandboxes', 'keep.txt'), 'utf8'), 'x');
  // A real folder with something in it is blocked, not replaced.
  const busy = tmp('busy');
  fs.mkdirSync(path.join(busy, 'sandboxes', 'slot1'), { recursive: true });
  const blocked = linkRootFolders(busy, target, junction);
  assert.equal(blocked[0].action, 'blocked');
  assert.match(blocked[0].detail, /real folder with 1 entries/);
  assert.equal(fs.lstatSync(path.join(busy, 'sandboxes')).isDirectory(), true);
  for (const d of [root, drive, other, busy]) fs.rmSync(d, { recursive: true, force: true });
});

test('devdrive.ps1’s last line is parsed, and anything else is not', () => {
  const out = 'formatted V: as a ReFS Dev Drive\nFFW-DEVDRIVE {"letter":"V","created":true,"maxGB":900,"blockClone":true}\n';
  assert.deepEqual(parseDevDriveOutput(out), { letter: 'V', created: true, maxGB: 900, blockClone: true });
  assert.equal(parseDevDriveOutput('FAILED: no free drive letter'), undefined);
  assert.equal(parseDevDriveOutput('FFW-DEVDRIVE {not json}'), undefined);
});

// ---------------------------------------------------------------- moving an existing install's sandboxes

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** A root with a bare clone, an origin it pushes to, and two sandboxes as worktrees of it with Libraries and unsaved work. */
function oldInstall() {
  const base = tmp('move');
  const origin = path.join(base, 'origin.git');
  const seedWork = path.join(base, 'seed-work');
  git(base, 'init', '--bare', '-q', '-b', 'main', origin);
  fs.mkdirSync(seedWork);
  git(seedWork, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seedWork, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(seedWork, '.gitignore'), 'Library/\nLogs/\n');
  git(seedWork, 'add', '.');
  git(seedWork, 'commit', '-q', '-m', 'first');
  git(seedWork, 'push', '-q', origin, 'main');
  const root = path.join(base, 'ffw');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(root);
  git(base, 'clone', '-q', '--bare', origin, repo);
  git(repo, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  // saveWork commits in a worktree: the identity comes from the clone's own config (a bare machine has none).
  git(repo, 'config', 'user.name', 'FF Factory test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'fetch', '-q', 'origin');
  const sandboxes = path.join(root, 'sandboxes');
  fs.mkdirSync(sandboxes);
  const recs: PoolRec[] = [];
  for (const id of ['slot1', 'slot2']) {
    const dir = path.join(sandboxes, id);
    git(repo, 'worktree', 'add', '-q', '-b', `sandbox/${id}-w1`, dir, 'origin/main');
    fs.mkdirSync(path.join(dir, 'Library', 'Bee'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Library', 'Bee', `${id}.dat`), `library of ${id}`);
    recs.push({ id, branch: `sandbox/${id}-w1`, base: 'origin/main', path: dir, createdAt: 't', status: 'ready', logPath: path.join(dir, 'Logs', 'editor.log') });
  }
  // slot1 has an unsaved edit and a new file; slot2 an unpushed commit.
  fs.writeFileSync(path.join(sandboxes, 'slot1', 'README.md'), 'edited\n');
  fs.writeFileSync(path.join(sandboxes, 'slot1', 'notes.txt'), 'new file\n');
  fs.writeFileSync(path.join(sandboxes, 'slot2', 'b.txt'), 'b\n');
  git(path.join(sandboxes, 'slot2'), 'add', 'b.txt');
  git(path.join(sandboxes, 'slot2'), 'commit', '-q', '-m', 'unpushed');
  fs.mkdirSync(path.join(root, 'daemon'));
  const stateFile = path.join(root, 'daemon', 'sandboxes.json');
  fs.writeFileSync(stateFile, JSON.stringify(recs, null, 2));
  const drive = path.join(base, 'V');
  return { base, root, repo, sandboxes, stateFile, drive, newSandboxes: path.join(drive, 'sandboxes'), newSeed: path.join(drive, 'seed'), oldSeed: path.join(root, 'seed') };
}

function fakeDeps(over: Partial<MoveDeps> = {}, said: string[] = []): MoveDeps {
  const copy = (src: string, dst: string) => fs.cpSync(src, dst, { recursive: true });
  return {
    git: async (args) => {
      try {
        return { code: 0, stdout: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
      } catch (e) {
        const x = e as { status?: number; stdout?: string; stderr?: string };
        return { code: x.status ?? 1, stdout: String(x.stdout ?? ''), stderr: String(x.stderr ?? '') };
      }
    },
    moveTree: async (src, dst) => {
      copy(src, dst);
      fs.rmSync(src, { recursive: true, force: true });
    },
    cloneTree: async (src, dst) => copy(src, dst),
    removeTree: async (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    save: (dir, branch, message) => saveWork({ dir, branch, message }),
    say: (l) => said.push(l),
    ...over,
  };
}

test('moving the sandboxes: unsaved work is committed first, each sandbox is re-created on the drive from the seed, the pool’s record follows', async () => {
  const w = oldInstall();
  const said: string[] = [];
  const claude = path.join(w.base, 'claude-projects');
  fs.mkdirSync(path.join(claude, claudeSlug(path.join(w.sandboxes, 'slot1'))), { recursive: true });
  fs.writeFileSync(path.join(claude, claudeSlug(path.join(w.sandboxes, 'slot1')), 'a.jsonl'), '{}');
  const rep = await moveSandboxes({ repo: w.repo, stateFile: w.stateFile, oldSandboxes: w.sandboxes, oldSeed: w.oldSeed, newSandboxes: w.newSandboxes, newSeed: w.newSeed }, fakeDeps({ claudeProjects: claude }, said));
  assert.deepEqual(rep.moved.map((m) => m.id), ['slot1', 'slot2']);
  assert.ok(rep.moved[0].saved, 'slot1’s edit and new file were committed');
  // The work is on the branch, in the root's clone, and checked out in the new worktree.
  const s1 = path.join(w.newSandboxes, 'slot1');
  assert.equal(fs.readFileSync(path.join(s1, 'README.md'), 'utf8'), 'edited\n');
  assert.equal(fs.readFileSync(path.join(s1, 'notes.txt'), 'utf8'), 'new file\n');
  assert.equal(git(w.repo, 'log', '-1', '--format=%s', 'sandbox/slot1-w1').startsWith('FF Factory: saved slot1'), true);
  assert.equal(git(s1, 'status', '--porcelain').split('\n').filter((l) => l && !/__FFFactoryReimport/.test(l)).length, 0, 'clean after the move');
  assert.equal(fs.readFileSync(path.join(w.newSandboxes, 'slot2', 'b.txt'), 'utf8'), 'b\n', 'slot2’s unpushed commit is in the new worktree');
  // The seed came from the freshest sandbox Library (there was no seed), by move, and both sandboxes cloned it.
  assert.ok(rep.seedFrom?.endsWith('Library'));
  assert.equal(fs.existsSync(path.join(w.newSeed, 'Library', 'Bee')), true);
  for (const id of ['slot1', 'slot2']) assert.equal(fs.existsSync(path.join(w.newSandboxes, id, 'Library', 'Bee')), true, `${id} has a Library`);
  // The old folders are empty of sandboxes; the pool's record and a sandbox’s Claude conversations point at the new place.
  assert.deepEqual(fs.readdirSync(w.sandboxes), []);
  const recs = JSON.parse(fs.readFileSync(w.stateFile, 'utf8')) as PoolRec[];
  assert.deepEqual(recs.map((r) => r.path), [s1, path.join(w.newSandboxes, 'slot2')]);
  assert.equal(recs[0].logPath, path.join(s1, 'Logs', 'editor.log'));
  assert.equal(recs[0].branch, 'sandbox/slot1-w1');
  assert.equal(fs.existsSync(path.join(claude, claudeSlug(s1), 'a.jsonl')), true);
  assert.equal(git(w.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 3, 'the bare repo + the two new worktrees; the old ones are pruned');
  // Run again: nothing is on the old path any more, so nothing happens.
  const again = await moveSandboxes({ repo: w.repo, stateFile: w.stateFile, oldSandboxes: w.sandboxes, oldSeed: w.oldSeed, newSandboxes: w.newSandboxes, newSeed: w.newSeed }, fakeDeps());
  assert.deepEqual(again.moved, []);
  fs.rmSync(w.base, { recursive: true, force: true });
});

test('moving the sandboxes: an existing seed is moved, not a sandbox’s Library, and a move cut off after a removal is finished by running it again', async () => {
  const w = oldInstall();
  fs.mkdirSync(path.join(w.oldSeed, 'Library', 'ShaderCache'), { recursive: true });
  fs.writeFileSync(path.join(w.oldSeed, 'Library', 'ShaderCache', 'seed.dat'), 'seed');
  let failOnce = true;
  const deps = fakeDeps({
    cloneTree: async (src, dst) => {
      if (dst.includes('slot2') && failOnce) {
        failOnce = false;
        throw new Error('disk went away');
      }
      fs.cpSync(src, dst, { recursive: true });
    },
  });
  const opts = { repo: w.repo, stateFile: w.stateFile, oldSandboxes: w.sandboxes, oldSeed: w.oldSeed, newSandboxes: w.newSandboxes, newSeed: w.newSeed };
  await assert.rejects(() => moveSandboxes(opts, deps), /disk went away/);
  // slot1 is done and recorded; slot2’s old worktree is gone and its new one has no Library yet; the record still names the old path.
  const mid = JSON.parse(fs.readFileSync(w.stateFile, 'utf8')) as PoolRec[];
  assert.equal(mid[0].path, path.join(w.newSandboxes, 'slot1'));
  assert.equal(mid[1].path, path.join(w.sandboxes, 'slot2'));
  assert.equal(fs.existsSync(path.join(w.sandboxes, 'slot2')), false);
  const rep = await moveSandboxes(opts, deps);
  assert.deepEqual(rep.moved.map((m) => m.id), ['slot2'], 'only the unfinished one');
  assert.equal(fs.existsSync(path.join(w.newSandboxes, 'slot2', 'Library', 'ShaderCache', 'seed.dat')), true, 'cloned from the seed that was moved');
  assert.equal(fs.existsSync(path.join(w.sandboxes, 'slot1')), false);
  assert.equal(fs.existsSync(path.join(w.oldSeed, 'Library')), false, 'the old seed was moved, not copied');
  const final = JSON.parse(fs.readFileSync(w.stateFile, 'utf8')) as PoolRec[];
  assert.deepEqual(final.map((r) => r.path), [path.join(w.newSandboxes, 'slot1'), path.join(w.newSandboxes, 'slot2')]);
  fs.rmSync(w.base, { recursive: true, force: true });
});

test('moving the sandboxes: work that cannot be kept stops everything before anything is removed', async () => {
  const w = oldInstall();
  // A sandbox on a shared branch with uncommitted work: committing there is a person’s decision.
  git(path.join(w.sandboxes, 'slot2'), 'reset', '--hard', '-q');
  git(path.join(w.sandboxes, 'slot2'), 'checkout', '-q', '-b', 'tmp');
  git(w.repo, 'branch', '-f', 'main', 'tmp');
  const dir3 = path.join(w.sandboxes, 'slot3');
  git(w.repo, 'worktree', 'add', '-q', dir3, 'main');
  fs.writeFileSync(path.join(dir3, 'x.txt'), 'x');
  const recs = JSON.parse(fs.readFileSync(w.stateFile, 'utf8')) as PoolRec[];
  recs.push({ id: 'slot3', branch: 'main', base: 'origin/main', path: dir3, createdAt: 't', status: 'ready' });
  fs.writeFileSync(w.stateFile, JSON.stringify(recs));
  await assert.rejects(() => moveSandboxes({ repo: w.repo, stateFile: w.stateFile, oldSandboxes: w.sandboxes, oldSeed: w.oldSeed, newSandboxes: w.newSandboxes, newSeed: w.newSeed }, fakeDeps()), /nothing was moved:\n- slot3 has 1 uncommitted file\(s\) on the shared branch main/);
  assert.equal(fs.existsSync(path.join(w.sandboxes, 'slot1', 'notes.txt')), true, 'slot1 untouched');
  assert.equal(fs.existsSync(w.newSandboxes), false);
  fs.rmSync(w.base, { recursive: true, force: true });
});

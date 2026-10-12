// w1070: the whole worker root on its Dev Drive (scripts/worker/driveRoot.ts, worker.ts install step 0 and `reinstall`,
// docs/worker-install.md "The Dev Drive"). lothsahn: "If using a dev drive, the entire folder structure should be under V: Then we
// won't need the folder symlinks or anything"; "report space of the V: drive to ff factory instead of the D: space for disk. And
// then cap the vdisk file at 275GB"; "Instead of doing a move, can we just do a fresh reinstall on LothDesktop instead?"
// The PowerShell and the VHDX itself are Windows-only; what decides and what is written is tested here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HOST_FILES, driveRootOf, isHostFile, moveMap, readMoved, rebaseJson, rebasePath, rebaseText, writeMoved } from './worker/driveRoot.ts';
import { carryDevDrive, devDriveGuard, hostDirOf } from './worker/devdrive.ts';
import { anchorOf, daemonJson, layoutOf, planUpdate, reinstallProblems, sandboxRisks, type InstallOptions, type Manifest } from './worker/worker.ts';
import { taskXml } from '../server/machineDeployWin.ts';
import { roomLevel, blockReason } from '../server/hostHealth.ts';
import { MachineGuard } from '../machine/hostGuard.ts';
import { adoptLayout, rebaseUnder } from '../server/machines.ts';
import type { Machine } from '../shared/types.ts';

const GB = 1024 ** 3;
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `w1070-${name}-`));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---------------------------------------------------------------- the stored paths

test('paths: the old root and the drive’s own folders go to the new root; the drive’s file and its state stay; nothing else moves', () => {
  const map = moveMap('D:\\work\\ffw', 'V:\\ffw', { sandboxes: 'V:\\sandboxes', seed: 'V:\\seed' });
  assert.equal(rebasePath('D:\\work\\ffw\\repo', map), 'V:\\ffw\\repo');
  assert.equal(rebasePath('d:/Work/FFW/tmp/ffa-1', map), 'V:\\ffw/tmp/ffa-1', 'any case and slash; the rest kept as written');
  assert.equal(rebasePath('V:\\sandboxes\\slot3', map), 'V:\\ffw\\sandboxes\\slot3');
  assert.equal(rebasePath('V:\\seed\\Library', map), 'V:\\ffw\\seed\\Library');
  assert.equal(rebasePath('D:\\work\\ffw', map), 'V:\\ffw');
  assert.equal(rebasePath('/d/work/ffw/nightly', map), '/v/ffw/nightly', "Git Bash's form (the nightly task's command line)");
  // Not under it, only alike, or one of the files the host folder keeps.
  assert.equal(rebasePath('D:\\work\\ffw2\\x', map), 'D:\\work\\ffw2\\x');
  assert.equal(rebasePath('D:/', map), 'D:/');
  assert.equal(rebasePath('C:\\Users\\Lothsahn\\.claude', map), 'C:\\Users\\Lothsahn\\.claude');
  for (const f of HOST_FILES) assert.equal(rebasePath(`D:\\work\\ffw\\${f}`, map), `D:\\work\\ffw\\${f}`, f);
  assert.ok(isHostFile('DevDrive.VHDX') && !isHostFile('repo'));
  const cfg = { root: 'D:\\work\\ffw', repoPath: 'D:\\work\\ffw\\repo', sandboxes: { root: 'V:\\sandboxes', librarySeed: 'V:\\seed\\Library' }, extraRoots: ['V:\\sandboxes', 'V:\\seed'], hostGuard: { hostDiskPaths: ['D:/'] }, maxEventsFile: 'D:\\work\\ffw\\daemon\\max-events.jsonl', n: 3 };
  const r = rebaseJson(cfg, map);
  assert.equal(r.changed, 6, 'the daemon\'s folder stays in the host folder (it remounts the drive)');
  assert.deepEqual(r.value, { root: 'V:\\ffw', repoPath: 'V:\\ffw\\repo', sandboxes: { root: 'V:\\ffw\\sandboxes', librarySeed: 'V:\\ffw\\seed\\Library' }, extraRoots: ['V:\\ffw\\sandboxes', 'V:\\ffw\\seed'], hostGuard: { hostDiskPaths: ['D:/'] }, maxEventsFile: 'D:\\work\\ffw\\daemon\\max-events.jsonl', n: 3 });
});

test('paths: the nightly lab’s task text is repointed in each spelling it uses, and nothing alike is touched', () => {
  const map = moveMap('D:\\work\\ffw', 'V:\\ffw', { sandboxes: 'V:\\sandboxes', seed: 'V:\\seed' });
  const xml = '<Arguments>-lc "FF_NIGHTLY_ROOT=/d/work/ffw/nightly bash /d/work/ffw/nightly/FinalFactory/scripts/nightly/nightly.sh"</Arguments><WorkingDirectory>D:\\work\\ffw\\nightly</WorkingDirectory><X>D:/work/ffw/players</X><Y>D:\\work\\ffw2</Y>';
  assert.equal(rebaseText(xml, map), '<Arguments>-lc "FF_NIGHTLY_ROOT=/v/ffw/nightly bash /v/ffw/nightly/FinalFactory/scripts/nightly/nightly.sh"</Arguments><WorkingDirectory>V:\\ffw\\nightly</WorkingDirectory><X>V:/ffw/players</X><Y>D:\\work\\ffw2</Y>');
});

// ---------------------------------------------------------------- the drive's record and daemon.json

test('daemon.json of a root on its drive: the root’s own folders, no extra roots, and a host guard that judges the host volume by the VHDX’s room to grow', () => {
  const l = layoutOf('V:\\ffw');
  const o = { root: 'V:\\ffw', portalUrl: 'https://p', token: 't', maxSandboxes: 6, maxAgentsPerSandbox: 2, maxUnity: 4, repoUrl: 'r', service: 'FFFactoryDaemon', firewall: true, carry: { extraRoots: ['V:\\ffw\\sandboxes', 'V:\\ffw\\seed'] }, devDriveDirs: { sandboxes: l.sandboxes, seed: l.seed, seedReady: true, blockClone: true, onRoot: true, host: 'D:\\work\\ffw', vhdx: 'D:\\work\\ffw\\devdrive.vhdx', maxGB: 275 } } as unknown as InstallOptions;
  const j = daemonJson(o, l, 'lothdesktop', undefined) as Record<string, any>;
  assert.equal(j.extraRoots, undefined);
  assert.equal(j.root, l.root);
  assert.equal(j.sandboxes.root, l.sandboxes);
  assert.equal(j.sandboxes.librarySeed, path.win32.join(l.seed, 'Library'));
  assert.equal(j.sandboxes.librarySeedCopy, 'clone');
  assert.deepEqual(j.hostGuard.hostDiskPaths, ['D:/']);
  assert.equal(j.hostGuard.devDriveVhdx, 'D:\\work\\ffw\\devdrive.vhdx');
  assert.equal(j.hostGuard.devDriveMaxGB, 275);
  // A host guard carried from the install is kept, with the VHDX and its maximum added.
  const k = daemonJson({ ...o, carry: { hostGuard: { pollSeconds: 30, warnFreeGB: 50, hostDiskPaths: ['D:/'] } } } as unknown as InstallOptions, l, 'lothdesktop', undefined) as Record<string, any>;
  assert.equal(k.hostGuard.warnFreeGB, 50);
  assert.equal(k.hostGuard.devDriveMaxGB, 275);
  assert.deepEqual(devDriveGuard('D:\\', {}, { path: 'D:\\x.vhdx', maxGB: 275 }).devDriveMaxGB, 275);
});

test('the drive’s record: a root on it names the host folder, and is rebuilt from daemon.json’s VHDX when root.json lost it', () => {
  const rec = { vhdx: 'D:\\work\\ffw\\devdrive.vhdx', letter: 'V', maxGB: 275, inUse: true, rootOnDrive: true, host: 'D:\\work\\ffw' };
  assert.equal(hostDirOf(rec, 'V:\\ffw'), 'D:\\work\\ffw');
  assert.equal(hostDirOf({ ...rec, rootOnDrive: false }, 'D:\\work\\ffw'), 'D:\\work\\ffw');
  assert.equal(hostDirOf(undefined, 'D:\\ffw'), 'D:\\ffw');
  // The real paths are Windows ones; path here is the platform's, so the test speaks its spelling.
  const host = path.join(path.sep, 'D', 'work', 'ffw');
  const vhdx = path.join(host, 'devdrive.vhdx');
  const files: Record<string, string> = { [path.join(host, 'devdrive.json')]: JSON.stringify({ letter: 'v', maxGB: 275 }) };
  const io = { read: (f: string) => files[f], exists: (p: string) => p === vhdx || p in files, isLink: () => false };
  assert.deepEqual(carryDevDrive(undefined, path.join(path.sep, 'V', 'ffw'), io, vhdx), { vhdx, letter: 'V', maxGB: 275, inUse: true, rootOnDrive: true, host });
  assert.equal(carryDevDrive(undefined, path.join(path.sep, 'V', 'ffw'), io), undefined, 'no hint, no VHDX in the root: no drive');
  assert.equal(driveRootOf('v'), 'V:\\ffw');
});

// ---------------------------------------------------------------- the daemon stays off the drive it remounts

test('a root on its drive keeps the daemon, its logs and the credential in the host folder; the task names them there, with no junction', () => {
  // The daemon's host guard is what remounts the drive (machine/hostGuard.ts): run from the drive, it would go with it (BEAST's
  // C:\\ffw-anchor, docs/worker-root.md 2.2; review of #331 by e7618560).
  const l = layoutOf('V:\\ffw', 'D:\\work\\ffw');
  const P = path;
  assert.equal(l.daemon, P.join('D:\\work\\ffw', 'daemon'));
  assert.equal(l.logs, P.join('D:\\work\\ffw', 'daemon', 'logs'));
  assert.equal(l.src, P.join('D:\\work\\ffw', 'daemon', 'src'));
  assert.equal(l.secrets, P.join('D:\\work\\ffw', 'secrets'));
  assert.equal(l.token, P.join('D:\\work\\ffw', 'secrets', 'machine-token'));
  for (const k of ['repo', 'sandboxes', 'seed', 'players', 'nightly', 'scratch', 'tmp', 'manifest'] as const) assert.ok(l[k].startsWith('V:\\ffw'), k);
  assert.deepEqual(layoutOf('D:\\ffw'), layoutOf('D:\\ffw', undefined), 'no anchor: everything in the root, as before');
  const m = { devDrive: { vhdx: 'D:\\work\\ffw\\devdrive.vhdx', letter: 'V', maxGB: 275, inUse: true, rootOnDrive: true, host: 'D:\\work\\ffw' } } as Manifest;
  assert.equal(anchorOf(m), 'D:\\work\\ffw');
  assert.equal(anchorOf({ devDrive: { ...m.devDrive!, rootOnDrive: false } } as Manifest), undefined);
  // An update reads and writes the daemon there.
  const o = planUpdate('V:\\ffw', { ...m, machineId: 'lothdesktop', portalUrl: 'https://p', service: 'FFFactoryDaemon', slots: 6, repoUrl: 'r', outside: [] } as unknown as Manifest, { portalUrl: 'https://p', sandboxes: { maxSandboxes: 6 } }, 'ffm_x', {});
  assert.equal(o.anchor, 'D:\\work\\ffw');
  // daemon.json: the daemon's own folders on D:, the work on V:.
  const j = daemonJson({ ...o, devDriveDirs: { sandboxes: l.sandboxes, seed: l.seed, seedReady: false, blockClone: true, onRoot: true, host: 'D:\\work\\ffw', vhdx: 'D:\\work\\ffw\\devdrive.vhdx', maxGB: 275 } } as InstallOptions, l, 'lothdesktop', undefined) as Record<string, any>;
  assert.equal(j.appDir, l.daemon);
  assert.equal(j.tokenFile, l.token);
  assert.equal(j.maxEventsFile, P.join(l.daemon, 'max-events.jsonl'));
  assert.equal(j.root, 'V:\\ffw');
  assert.equal(j.repoPath, l.repo);
  assert.equal(j.tempDir, l.tmp);
  assert.deepEqual(j.extraRoots, [l.daemon], 'the clean-up may still tidy the daemon\'s folder, the one part of the install off the drive');
  // The task runs the supervisor from the host folder, which is there before the drive and stays while it is gone.
  assert.match(taskXml('S-1-5-21-1-2-3-1001', 'C:\\Users\\Lothsahn', 'D:\\work\\ffw\\daemon'), /-File "D:\\work\\ffw\\daemon\\run-daemon\.ps1"<\/Arguments>/);
  assert.ok(['daemon', 'secrets'].every(isHostFile));
});

// ---------------------------------------------------------------- V:'s space, not D:'s

test('the host volume is judged by whether the VHDX can still grow to its maximum, not by a fixed number of GB', () => {
  const g = { criticalFreeGB: 10, hysteresisGB: 10 };
  assert.equal(roomLevel(39, 25, 'ok', g), 'ok', 'D: under the old 50 GB floor, but the drive can still grow its last 25 GB');
  assert.equal(roomLevel(39, 45, 'ok', g), 'warn', 'the drive could not reach its maximum');
  assert.equal(roomLevel(5, 45, 'ok', g), 'critical');
  assert.equal(roomLevel(50, 45, 'warn', g), 'warn', 'hysteresis: 5 GB of room is not yet 10');
  assert.equal(roomLevel(60, 45, 'warn', g), 'ok');
  assert.equal(roomLevel(500, 0, 'ok', g), 'ok');
  assert.match(blockReason({ sandboxRoot: 'ok', level: 'warn', disks: [{ path: 'D:/', freeBytes: 39 * GB, level: 'warn', growthBytes: 45 * GB }] }, 'agent', { freeGB: 30, minFreeRamGB: 0 }) ?? '', /D:\/ 39 GB free \(the Dev Drive's file can still grow 45 GB there\)/);
});

test('the daemon’s guard on LothDesktop after the move: V: is the disk; D: below 50 GB with room for the VHDX blocks nothing', async () => {
  const world = { dFree: 39 * GB, vhdx: 250 * GB };
  const changed: { level: string; blocked?: string }[] = [];
  const guard = new MachineGuard(
    { pollSeconds: 30, warnFreeGB: 50, criticalFreeGB: 10, hysteresisGB: 10, remountMinFreeGB: 30, hostDiskPaths: ['D:/'], reapBrowsersAfterHours: 0, reapEveryMinutes: 15, devDriveVhdx: 'D:\\work\\ffw\\devdrive.vhdx', devDriveMaxGB: 275 },
    'V:\\ffw\\sandboxes',
    {
      exists: () => true,
      statfs: async (p) => (p.toUpperCase().startsWith('D') ? { free: world.dFree, total: 781 * GB } : { free: 140 * GB, total: 275 * GB }),
      fileBytes: () => world.vhdx,
      mem: () => ({ free: 30 * GB, total: 64 * GB }),
      runHelper: async (a) => ({ action: a, ok: true, at: '', detail: '' }),
    },
    { sandboxes: () => [], sessions: () => [], startEditor: async () => undefined, stopEditor: async () => undefined, interrupt: async () => undefined, tell: () => undefined, report: () => undefined, changed: (h) => void changed.push({ level: h.level, ...(h.blocked ? { blocked: h.blocked } : {}) }), log: () => undefined },
  );
  await guard.tick();
  assert.equal(guard.health.level, 'ok');
  assert.deepEqual(guard.health.disks.map((d) => [d.path, d.level, d.growthBytes === undefined ? undefined : d.growthBytes / GB]), [['V:\\ffw\\sandboxes', 'ok', undefined], ['D:/', 'ok', 25]]);
  assert.equal(guard.blockReason('agent'), undefined);
  // V: itself low: the pool's own thresholds, on the drive.
  world.vhdx = 200 * GB;
  await guard.tick();
  assert.equal(guard.health.disks[1].level, 'warn', 'D: cannot hold the 75 GB the drive may still grow');
  assert.match(guard.blockReason('agent') ?? '', /D:\/ 39 GB free \(the Dev Drive's file can still grow 75 GB there\)/);
});

// ---------------------------------------------------------------- the portal's record

test('the portal’s record follows a root that moved onto its drive: folders, seed and its copy mode, protected paths', () => {
  const m = { id: 'lothdesktop', root: 'D:\\work\\ffw', appDir: 'D:\\work\\ffw\\daemon', repoPath: 'D:\\work\\ffw\\repo', tempDir: 'D:\\work\\ffw\\tmp', sandboxRoot: 'V:\\sandboxes', librarySeed: 'V:\\seed\\Library', maxSandboxes: 6, protectedPaths: ['D:\\work\\ffw\\repo', 'D:\\work\\ffw\\daemon\\unity-mcp', 'C:\\Users\\Lothsahn\\Documents'] } as unknown as Machine;
  adoptLayout(m, { root: 'V:\\ffw', appDir: 'D:\\work\\ffw\\daemon', repoPath: 'V:\\ffw\\repo', tempDir: 'V:\\ffw\\tmp', sandboxes: { root: 'V:\\ffw\\sandboxes', maxSandboxes: 6, maxAgentsPerSandbox: 2, maxUnity: 4, librarySeed: 'V:\\ffw\\seed\\Library', librarySeedCopy: 'clone' } } as any);
  assert.equal(m.root, 'V:\\ffw');
  assert.equal(m.appDir, 'D:\\work\\ffw\\daemon', 'the daemon stays off the drive');
  assert.equal(m.repoPath, 'V:\\ffw\\repo');
  assert.equal(m.tempDir, 'V:\\ffw\\tmp');
  assert.equal(m.sandboxRoot, 'V:\\ffw\\sandboxes');
  assert.equal(m.librarySeed, 'V:\\ffw\\seed\\Library');
  assert.equal(m.librarySeedCopy, 'clone');
  assert.deepEqual(m.protectedPaths, ['V:\\ffw\\repo', 'D:\\work\\ffw\\daemon\\unity-mcp', 'C:\\Users\\Lothsahn\\Documents']);
  assert.equal(rebaseUnder('d:/work/ffw/daemon', 'D:\\work\\ffw', 'V:\\ffw'), 'V:\\ffw/daemon');
  assert.equal(rebaseUnder('D:\\work\\ffw2', 'D:\\work\\ffw', 'V:\\ffw'), 'D:\\work\\ffw2');
});

// ---------------------------------------------------------------- the reinstall

test('the reinstall refuses, changing nothing, while an agent, a process or unpushed work is there; the seed is kept only with room beside the new drive', () => {
  const manifest = { machineId: 'lothdesktop', devDrive: { vhdx: 'D:\\work\\ffw\\devdrive.vhdx', letter: 'V', maxGB: 702, inUse: true } } as unknown as Manifest;
  const base = { root: 'D:\\work\\ffw', windows: true, elevated: true, manifest, agents: [], processes: [], risks: [], seedBytes: 13.3 * GB, freeBytes: 39 * GB };
  assert.deepEqual(reinstallProblems(base), { problems: [], keepSeed: true });
  const r = reinstallProblems({ ...base, agents: [{ id: '476c7481', sandbox: 'slot5', midTurn: true }], processes: ['34164 Unity.exe: -buildTarget Win64 -projectPath V:\\sandboxes\\slot4'], risks: [{ sandbox: 'slot3', unpushed: ['abc w1054'], dirty: [] }] });
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0], /1 agent\(s\) run here: 476c7481 in slot5 \(mid-turn\)/);
  assert.match(r.problems[1], /Unity\.exe/);
  assert.match(r.problems[2], /sandbox slot3 holds work that is not on origin \(1 unpushed commit/);
  assert.match(reinstallProblems({ ...base, elevated: false }).problems.join(), /elevated session/);
  // lothsahn: "The daemon and support files from the installer should go in d:\ffw": that folder must be new or empty.
  assert.deepEqual(reinstallProblems({ ...base, home: { path: 'D:\\ffw', entries: [] } }).problems, []);
  assert.match(reinstallProblems({ ...base, home: { path: 'D:\\ffw', entries: ['notes.txt'] } }).problems.join(), /D:\\ffw, where the drive, the daemon and the credential go, already holds notes\.txt/);
  assert.match(reinstallProblems({ ...base, agents: undefined }).problems.join(), /could not be asked/);
  assert.match(reinstallProblems({ ...base, manifest: { ...manifest, devDrive: { ...manifest.devDrive!, rootOnDrive: true } } as Manifest }).problems.join(), /on its Dev Drive already/);
  // D: at 19.5 GB (2026-10-12 ~02:00Z) holds the 13.3 GB seed with 5 GB to spare; at 17 GB it does not, and the first sandbox imports.
  assert.equal(reinstallProblems({ ...base, freeBytes: 19.5 * GB }).keepSeed, true);
  assert.equal(reinstallProblems({ ...base, freeBytes: 17 * GB }).keepSeed, false);
});

test('the reinstall’s check of the sandboxes: a commit no remote has, or an uncommitted file, is work that would be lost', async () => {
  const base = tmp('risks');
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(base, 'init', '--bare', '-q', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, work);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a');
  fs.writeFileSync(path.join(work, '.gitignore'), 'Library/\n');
  git(work, 'add', '.');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-qm', 'one');
  git(work, 'push', '-q', 'origin', 'main');
  const sandboxes = path.join(base, 'sandboxes');
  for (const id of ['slot1', 'slot2', 'slot3']) git(work, 'worktree', 'add', '-q', '-b', `b-${id}`, path.join(sandboxes, id), 'origin/main');
  // slot1: pushed, a Library (ignored): no risk. slot2: a commit only here. slot3: an uncommitted edit.
  git(path.join(sandboxes, 'slot1'), 'push', '-q', '-u', 'origin', 'b-slot1');
  fs.mkdirSync(path.join(sandboxes, 'slot1', 'Library'));
  fs.writeFileSync(path.join(sandboxes, 'slot2', 'b.txt'), 'b');
  git(path.join(sandboxes, 'slot2'), 'add', 'b.txt');
  git(path.join(sandboxes, 'slot2'), '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-qm', 'unpushed');
  fs.writeFileSync(path.join(sandboxes, 'slot3', 'a.txt'), 'edited');
  const risks = await sandboxRisks(sandboxes);
  assert.deepEqual(risks.map((r) => [r.sandbox, r.unpushed.length, r.dirty.length]), [['slot2', 1, 0], ['slot3', 0, 1]]);
  fs.rmSync(base, { recursive: true, force: true });
});

test('moved.json in the folder the install went into names the root on the drive', () => {
  const host = tmp('host');
  assert.equal(readMoved(host), undefined);
  writeMoved(host, 'V:\\ffw');
  assert.equal(readMoved(host), 'V:\\ffw');
  fs.rmSync(host, { recursive: true, force: true });
});

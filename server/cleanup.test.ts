import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CleanupRunner,
  DEFAULT_CLEANUP,
  cleanupRules,
  describeCleanup,
  expandDir,
  neverDelete,
  planCleanup,
  runCleanup,
  staleUnityLibraries,
  superseded,
  type CleanupGuard,
  type CleanupRun,
} from './cleanup.ts';
import { machineCleanupSettings, hostSoftFreeGB } from './config.ts';
import { normalizeSetting, setAppConfig } from './appConfig.ts';
import type { Config } from './config.ts';

const GB = 1024 ** 3;

test('never delete (Windows paths): repos, sandboxes, secrets, backups, installs, the VHDX, agents at work', () => {
  const g: CleanupGuard = {
    home: 'C:\\Users\\rydin',
    keep: ['F:\\ffsb', 'C:\\Users\\rydin\\ffsb-factory', 'C:\\Users\\rydin\\FinalFactory'],
    inUse: ['C:\\Users\\rydin\\AppData\\Local\\Temp\\ffa-live1'],
  };
  const no = (p: string) => neverDelete(p, g);
  assert.equal(no('C:\\'), 'a drive root');
  assert.equal(no('F:/'), 'a drive root');
  assert.match(no('C:\\Users\\rydin')!, /home folder/);
  assert.match(no('C:\\Users')!, /home folder/);
  assert.match(no('C:\\Users\\rydin\\Downloads')!, /top-level folder/);
  assert.match(no('F:\\ffsb\\blackhole\\Library')!, /kept \(F:\\ffsb\)/, 'a live sandbox Library');
  assert.match(no('F:\\ffsb')!, /kept/);
  assert.match(no('C:/Users/rydin/ffsb-factory/data')!, /kept/, 'forward slashes, other case');
  assert.match(no('c:\\users\\RYDIN\\finalfactory\\Library')!, /kept/, 'case-insensitive');
  assert.match(no('C:\\Users\\rydin\\AppData\\Local\\Temp\\ffa-live1')!, /in use by a running agent/);
  assert.match(no('C:\\Users\\rydin\\AppData\\Local\\Temp\\ffa-live1\\build')!, /in use/);
  assert.match(no('C:\\Users\\rydin\\.claude\\projects\\x.jsonl')!, /Claude Code/);
  assert.match(no('C:\\Users\\rydin\\.ssh\\id_ed25519')!, /credentials/);
  assert.match(no('C:\\Users\\rydin\\tmp\\ff-local-backups\\20260928-1200')!, /backup/);
  assert.match(no('C:\\Users\\rydin\\AppData\\LocalLow\\Never Games\\finalfactory\\DeterminismAudit\\r1')!, /audit/);
  assert.match(no('C:\\Users\\rydin\\work\\lab\\run-7')!, /lab/);
  assert.match(no('C:\\Program Files (x86)\\Steam\\steamapps\\common\\x')!, /system folder/);
  assert.match(no('D:\\SteamLibrary\\steamapps\\common\\Final Factory')!, /Steam/);
  assert.match(no('D:\\Unity\\Hub\\Editor\\6000.3.2f1')!, /Unity install/);
  assert.match(no('C:\\ffsb-devdrive.vhdx')!, /virtual disk/);
  assert.match(no('D:\\old\\disk.VHD')!, /virtual disk/);
  assert.match(no('C:\\Users\\rydin\\AppData\\Local\\Temp\\gh-credentials.json')!, /secret/);
  assert.match(no('C:\\Windows\\Temp\\x')!, /system folder/);
  // What the rules may take.
  for (const ok of [
    'C:\\Users\\rydin\\AppData\\Local\\Temp\\fff-abc',
    'C:\\Users\\rydin\\AppData\\Local\\Temp\\ffa-done2',
    'C:\\Users\\rydin\\AppData\\Local\\Temp\\claude\\C--Users-rydin\\5b0c',
    'C:\\Users\\rydin\\AppData\\Local\\CrashDumps\\Unity.exe.1234.dmp',
    'C:\\Users\\rydin\\nevergames\\FFAlt\\Library',
    'C:\\actions-runner\\_work\\ff-factory',
  ]) {
    assert.equal(no(ok), undefined, ok);
  }
});

test('never delete (POSIX paths): torque on the M5, the clone, Claude Code, keychains', () => {
  const g: CleanupGuard = { home: '/Users/ben', keep: ['/Users/ben/tmp/sonnet55/game', '/Users/ben/.ff-factory'], inUse: [] };
  const no = (p: string) => neverDelete(p, g);
  assert.equal(no('/'), 'a drive root');
  assert.match(no('/Users/ben/torque/runs/1')!, /torque/);
  assert.match(no('/Users/ben/torque')!, /top-level|torque/);
  assert.match(no('/Users/ben/tmp/sonnet55/game/Library')!, /kept/);
  assert.match(no('/Users/ben/tmp/sonnet55')!, /kept/, 'a folder holding a kept path');
  assert.match(no('/Users/ben/Library/Keychains/login.keychain-db')!, /credentials/);
  assert.match(no('/Applications/Unity/Hub/Editor/6000.3.2f1')!, /system folder/);
  assert.match(no('/Users/ben/Applications/Unity Hub.app')!, /Unity install/);
  assert.equal(no('/Users/ben/Library/Developer/Xcode/DerivedData/Game-abc'), undefined);
  assert.equal(no('/private/tmp/claude-501/-Users-ben-game/0d1e'), undefined);
  assert.equal(no('/var/folders/xy/T/ffa-s1'), undefined);
});

test('rules per platform: Windows (checked with Windows paths anywhere) and macOS', () => {
  const win = cleanupRules({ platform: 'win32', home: 'C:\\Users\\rydin', tmp: 'C:\\Users\\rydin\\AppData\\Local\\Temp', localAppData: 'C:\\Users\\rydin\\AppData\\Local' }, DEFAULT_CLEANUP);
  const at = (rules: typeof win, id: string) => rules.filter((r) => r.id === id).map((r) => r.dir.replace(/\\/g, '/'));
  assert.deepEqual(at(win, 'temp-old'), ['C:/Users/rydin/AppData/Local/Temp']);
  assert.deepEqual(at(win, 'crash-dumps'), ['C:/Users/rydin/AppData/Local/CrashDumps']);
  assert.deepEqual(at(win, 'unity-crashes'), ['C:/Users/rydin/AppData/Local/Temp/Unity/Editor/Crashes']);
  assert.deepEqual(at(win, 'claude-temp'), ['C:/Users/rydin/AppData/Local/Temp/claude*/*']);
  assert.deepEqual(at(win, 'claude-edit-diff'), ['C:/Users/rydin/AppData/Local/Temp/claude*/bash-edit-diff']);
  assert.deepEqual(at(win, 'worker-archives'), ['C:/Users/rydin/ff-worker']);
  assert.deepEqual(at(win, 'playtest-sessions'), ['C:/Users/rydin/AppData/LocalLow/Never Games/finalfactory*/PlaytestSessions']);
  assert.deepEqual(at(win, 'sandbox-builds'), [], 'only where there are sandboxes');
  assert.deepEqual(at(cleanupRules({ platform: 'win32', home: 'C:\\U', tmp: 'C:\\T', sandboxRoots: ['F:\\ffsb'] }, DEFAULT_CLEANUP), 'sandbox-builds'), ['F:/ffsb/*/Builds']);
  assert.deepEqual(at(win, 'actions-work'), ['C:/Users/rydin/actions-runner*/_work', 'C:/actions-runner*/_work']);
  assert.deepEqual(at(win, 'unity-gi-cache'), ['C:/Users/rydin/AppData/LocalLow/Unity/Caches/GiCache']);
  assert.ok(win.filter((r) => r.id === 'npm-cache').every((r) => r.when === 'low'), 'whole caches only when space is low');
  assert.ok(!win.some((r) => r.id === 'xcode-derived'));
  const tempOld = win.find((r) => r.id === 'temp-old')!;
  assert.deepEqual(tempOld.except, ['claude', 'claude-*'], "Claude Code's temp has its own rule");
  const withAgentTemp = cleanupRules({ platform: 'darwin', home: '/Users/ben', tmp: '/var/folders/xy/T', agentTemp: '/Volumes/scratch/agents' }, DEFAULT_CLEANUP);
  assert.deepEqual(at(withAgentTemp, 'agent-temp'), ['/var/folders/xy/T', '/Volumes/scratch/agents']);
  assert.deepEqual(at(withAgentTemp, 'claude-temp'), ['/var/folders/xy/T/claude*/*', '/Volumes/scratch/agents/claude*/*', '/tmp/claude*/*']);
  assert.deepEqual(at(withAgentTemp, 'xcode-derived'), ['/Users/ben/Library/Developer/Xcode/DerivedData']);
  assert.deepEqual(at(withAgentTemp, 'diagnostic-reports'), ['/Users/ben/Library/Logs/DiagnosticReports']);
  assert.ok(!withAgentTemp.some((r) => r.id === 'crash-dumps'));
  const aged = cleanupRules({ platform: 'win32', home: 'C:\\U', tmp: 'C:\\T' }, { ...DEFAULT_CLEANUP, ageRules: [{ path: 'D:\\builds', olderThanDays: 14 }] });
  assert.deepEqual(aged.filter((r) => r.id === 'age-rule').map((r) => [r.dir, r.olderThanHours]), [['D:\\builds', 14 * 24]]);
});

test('superseded Playwright browsers: every older build of a family, never the newest', () => {
  assert.deepEqual(superseded(['chromium-1181', 'chromium-1200', 'chromium_headless_shell-1181', 'chromium_headless_shell-1200', 'ffmpeg-1011', '.links']).sort(), ['chromium-1181', 'chromium_headless_shell-1181']);
  assert.deepEqual(superseded(['webkit-2000']), []);
});

/** A scratch world: files and folders with ages, git clones in three states. */
function world(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const age = (p: string, hours: number) => {
    const at = new Date(now - hours * 3_600_000);
    fs.utimesSync(p, at, at);
  };
  /** A folder with one file, everything `hours` old (or a file when `file`). */
  const make = (rel: string, hours: number, file = false) => {
    const p = path.join(root, rel);
    fs.mkdirSync(file ? path.dirname(p) : p, { recursive: true });
    if (file) fs.writeFileSync(p, 'x'.repeat(100));
    else fs.writeFileSync(path.join(p, 'x'), 'x'.repeat(100));
    if (!file) age(path.join(p, 'x'), hours);
    age(p, hours);
    return p;
  };
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'ignore' });
  const clone = (rel: string, hours: number, state: 'clean' | 'dirty' | 'unpushed') => {
    const bare = path.join(root, `${path.basename(rel)}.git`);
    execFileSync('git', ['init', '-q', '--bare', bare]);
    const app = path.join(root, rel, 'app');
    fs.mkdirSync(app, { recursive: true });
    git(app, 'init', '-q');
    git(app, 'commit', '-q', '--allow-empty', '-m', 'one');
    git(app, 'remote', 'add', 'origin', bare);
    git(app, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(app, 'fetch', '-q', 'origin');
    if (state === 'dirty') fs.writeFileSync(path.join(app, 'new.txt'), 'work');
    if (state === 'unpushed') git(app, 'commit', '-q', '--allow-empty', '-m', 'local');
    // Everything in it as old as asked, so only the git state decides.
    const walk = (p: string) => {
      for (const n of fs.readdirSync(p)) {
        const c = path.join(p, n);
        if (fs.lstatSync(c).isDirectory()) walk(c);
        age(c, hours);
      }
    };
    walk(path.join(root, rel));
    age(path.join(root, rel), hours);
    return path.join(root, rel);
  };
  return { root, now, make, clone, age };
}

test('plan and run on a real tree: what each rule takes, and everything the guards keep', async (t) => {
  const w = world(t);
  const tmp = path.join(w.root, 'Temp');
  const home = path.join(w.root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const D = 24;
  // temp: scratch, agent temp folders, clones, anything old, Claude Code's task files.
  const oldShot = w.make('Temp/edge-shot-abc123', 5);
  const newShot = w.make('Temp/edge-shot-def456', 0.2);
  const doneAgent = w.make('Temp/ffa-done', 3);
  const liveAgent = w.make('Temp/ffa-live', 30 * D);
  const oldClean = w.clone('Temp/fff-old', 5 * D, 'clean');
  const oldDirty = w.clone('Temp/fff-dirty', 30 * D, 'dirty');
  const oldUnpushed = w.clone('Temp/ffsb-unpushed', 30 * D, 'unpushed');
  const anyOld = w.make('Temp/somethingelse', 8 * D);
  const anyNew = w.make('Temp/somethingfresh', 2 * D);
  const deepFresh = w.make('Temp/oldtop-freshinside', 30 * D);
  fs.writeFileSync(path.join(deepFresh, 'fresh.log'), 'still written'); // touched now, deep inside
  w.age(deepFresh, 30 * D);
  const backups = w.make('Temp/ff-local-backups', 30 * D);
  const sshy = w.make('Temp/.ssh', 30 * D);
  const claudeOld = w.make('Temp/claude/C--proj/sess-old', 4 * D);
  const claudeNew = w.make('Temp/claude/C--proj/sess-new', 1 * D);
  const leftover = w.make('Temp/fff-x.ffclean-1727000000000', 0.1);
  const diffOld = w.make('Temp/claude/bash-edit-diff/539-939-53f1', 13);
  const diffNew = w.make('Temp/claude/bash-edit-diff/539-939-4d00', 2);
  // Build outputs: a sandbox's Builds (the sandbox itself is kept), archives in ff-worker, playtest sessions.
  const buildOld = w.make('ffsb/mp-r2/Builds/win-3f28', 8 * D);
  const buildNew = w.make('ffsb/mp-r2/Builds/win-4aab', 2 * D);
  const sandboxOld = w.make('ffsb/mp-r2/Library/old', 60 * D);
  const tarOld = w.make('home/ff-worker/t87-player.tar', 9 * D, true);
  const notes = w.make('home/ff-worker/notes.md', 90 * D, true);
  const playOld = w.make('home/AppData/LocalLow/Never Games/finalfactory/PlaytestSessions/s-0901', 20 * D);
  const playNew = w.make('home/AppData/LocalLow/Never Games/finalfactory/PlaytestSessions/s-0927', 1 * D);
  const auditOld = w.make('home/AppData/LocalLow/Never Games/finalfactory/DeterminismAudit/r1', 90 * D);
  // Caches and the Actions runner.
  const pwOld = w.make('home/AppData/Local/ms-playwright/chromium-1181', 30 * D);
  const pwNew = w.make('home/AppData/Local/ms-playwright/chromium-1200', 30 * D);
  const dump = w.make('home/AppData/Local/CrashDumps/Unity.exe.42.dmp', 3 * D, true);
  const freshDump = w.make('home/AppData/Local/CrashDumps/Unity.exe.43.dmp', 1, true);
  const npm = w.make('home/AppData/Local/npm-cache/_cacache', 2 * D);
  const job = w.clone('home/actions-runner/_work/ff-factory', 20 * D, 'dirty');
  const tool = w.make('home/actions-runner/_work/_tool', 60 * D);
  // A stale Unity project (Library goes), one open in an editor, one just used, and a linked Library.
  const project = (rel: string, days: number, opts: { lock?: boolean; link?: string } = {}) => {
    const p = path.join(w.root, rel);
    w.make(`${rel}/ProjectSettings`, days * D);
    fs.writeFileSync(path.join(p, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.2f1');
    w.age(path.join(p, 'ProjectSettings', 'ProjectVersion.txt'), days * D);
    if (opts.link) fs.symlinkSync(opts.link, path.join(p, 'Library'), 'junction');
    else w.make(`${rel}/Library/ArtifactDB`, days * D);
    if (opts.link === undefined) w.age(path.join(p, 'Library'), days * D);
    if (opts.lock) {
      w.make(`${rel}/Temp`, days * D);
      fs.writeFileSync(path.join(p, 'Temp', 'UnityLockfile'), '');
    }
    return path.join(p, 'Library');
  };
  const staleLib = project('home/nevergames/FFAlt', 400);
  const openLib = project('home/nevergames/Open', 400, { lock: true });
  const recentLib = project('home/nevergames/Recent', 10);
  const linkedLib = project('home/nevergames/FFAlt_clone_0', 400, { link: staleLib });
  const keptLib = project('home/FinalFactory', 400);

  const env = { platform: 'win32' as const, home, tmp, localAppData: path.join(home, 'AppData', 'Local'), sandboxRoots: [path.join(w.root, 'ffsb')] };
  // The same rules as on Windows, with this OS's paths (the folders are real here).
  const rules = cleanupRules({ ...env, platform: 'win32' }, DEFAULT_CLEANUP).map((r) => ({ ...r, dir: r.dir.replace(/[\\/]/g, path.sep) }));
  const guard: CleanupGuard = { home, keep: [path.join(home, 'FinalFactory'), path.join(w.root, 'ffsb')], inUse: [liveAgent] };
  const plan = async (low: boolean) =>
    (await planCleanup({ rules, guard, low, now: w.now, libraries: { roots: [home], deleteDays: 180 } })).map((i) => i.path).sort();

  const regular = await plan(false);
  const expected = [oldShot, doneAgent, oldClean, anyOld, claudeOld, leftover, diffOld, buildOld, tarOld, playOld, pwOld, dump, job, staleLib].sort();
  assert.deepEqual(regular, expected);
  for (const p of [newShot, liveAgent, oldDirty, oldUnpushed, anyNew, deepFresh, backups, sshy, claudeNew, diffNew, buildNew, sandboxOld, notes, playNew, auditOld, pwNew, freshDump, npm, tool, openLib, recentLib, linkedLib, keptLib]) {
    assert.ok(!regular.includes(p), `kept: ${p}`);
  }
  assert.deepEqual(await plan(true), [...expected, npm].sort(), 'low space adds the whole caches');
  assert.deepEqual((await staleUnityLibraries([home], 30, w.now)).map((l) => l.path).sort(), [keptLib, staleLib].sort(), 'reported: past 30 days, not open, not a link');

  const items = await planCleanup({ rules, guard, low: false, now: w.now, libraries: { roots: [home], deleteDays: 180 } });
  // A new agent started in ffa-done between the plan and the run: the run checks again.
  const r = await runCleanup(items, { ...guard, inUse: [...guard.inUse, doneAgent] });
  assert.deepEqual(r.failed.map((f) => f.path), [doneAgent]);
  assert.match(r.failed[0].why, /refused: in use by a running agent/);
  assert.equal(r.removed.length, expected.length - 1);
  assert.ok(r.bytes > 0 && r.removed.every((x) => x.bytes >= 0));
  for (const p of expected.filter((p) => p !== doneAgent)) assert.ok(!fs.existsSync(p), `removed: ${p}`);
  assert.ok(fs.existsSync(path.join(path.dirname(staleLib), 'ProjectSettings')), 'only the Library of the stale project');
  assert.ok(fs.readdirSync(tmp).every((n) => !/\.ffclean-\d+$/.test(n)), 'nothing left renamed');
  for (const p of [liveAgent, oldDirty, oldUnpushed, backups, sshy, keptLib, tool, buildNew, sandboxOld, notes, auditOld]) assert.ok(fs.existsSync(p), p);
});

test('expandDir: star segments match folders only', async (t) => {
  const w = world(t);
  w.make('actions-runner/_work', 1);
  w.make('actions-runner-2/_work', 1);
  w.make('actions-runner-3', 1); // no _work
  fs.writeFileSync(path.join(w.root, 'actions-runner-file'), 'x');
  assert.deepEqual((await expandDir(path.join(w.root, 'actions-runner*', '_work'))).sort(), [path.join(w.root, 'actions-runner', '_work'), path.join(w.root, 'actions-runner-2', '_work'), path.join(w.root, 'actions-runner-3', '_work')].sort());
  assert.deepEqual(await expandDir(path.join(w.root, 'x')), [path.join(w.root, 'x')]);
});

test('runner: hourly, every 15 minutes below the soft threshold, one notice a day while it cannot get above', async () => {
  let now = Date.parse('2026-09-28T10:00:00Z');
  let free = 200 * GB;
  const passes: boolean[] = [];
  const notices: string[] = [];
  const run: CleanupRun = { removed: [{ path: 'C:/T/a', bytes: 2 * GB, rule: 'temp-old' }], failed: [{ path: 'C:/T/b', why: 'in use (EBUSY)' }], bytes: 2 * GB };
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 120 }),
    diskPaths: () => ['C:/', 'C:/'],
    statfs: async () => ({ free, total: 2000 * GB }),
    pass: async (low) => (passes.push(low), run),
    consumers: async () => [{ path: 'C:/Users/rydin/FFAlt', bytes: 110 * GB }],
    stale: async () => [{ path: 'C:/Users/rydin/FFAlt/Library', days: 400 }],
    log: () => undefined,
    done: (_s, n) => void (n && notices.push(n)),
    now: () => now,
  });
  assert.equal((await r.tick())?.trigger, 'hourly');
  assert.equal(await r.tick(), undefined);
  now += 59 * 60_000;
  assert.equal(await r.tick(), undefined);
  now += 60_000;
  assert.equal((await r.tick())?.trigger, 'hourly');
  free = 100 * GB;
  now += 14 * 60_000;
  assert.equal(await r.tick(), undefined, 'below the soft threshold: every 15 minutes');
  now += 60_000;
  const low = await r.tick();
  assert.equal(low?.trigger, 'low-space');
  assert.deepEqual(passes, [false, false, true]);
  assert.equal(low?.belowSoft, true);
  assert.equal(low?.failed, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /freed 2\.0 GB \(1 item\(s\)\) but only 100\.0 GB is free, below the soft threshold of 120 GB/);
  assert.match(notices[0], /Biggest remaining: C:\/Users\/rydin\/FFAlt 110\.0 GB/);
  assert.match(notices[0], /FFAlt\/Library \(400 days\)/);
  for (let i = 0; i < 4; i++) {
    now += 15 * 60_000;
    await r.tick();
  }
  assert.equal(notices.length, 1, 'not every pass');
  now += 24 * 3_600_000;
  await r.tick();
  assert.equal(notices.length, 2, 'again after a day');
  free = 300 * GB;
  now += 60 * 60_000;
  await r.tick();
  free = 100 * GB;
  now += 15 * 60_000;
  await r.tick();
  assert.equal(notices.length, 3, 'a new episode notices at once');
  assert.match(describeCleanup(r.last!), /^2026-09-\d\d \d\d:\d\d \(low-space\): 1 item\(s\), 2\.0 GB, 1 skipped, 100\.0 GB free \(below the soft 120 GB\)\./);
});

test('thresholds: host soft default, per-machine settings, and what set_app_config accepts', (t) => {
  assert.equal(hostSoftFreeGB({ warnFreeGB: 80, cleanup: { ...DEFAULT_CLEANUP } }), 120);
  assert.equal(hostSoftFreeGB({ warnFreeGB: 80, cleanup: { ...DEFAULT_CLEANUP, softFreeGB: 150 } }), 150);
  assert.deepEqual(machineCleanupSettings({}, 'm3'), { everyMinutes: 60, softFreeGB: 80 });
  const machines = { cleanup: { softFreeGB: { '*': 70, m3: 40 }, everyMinutes: 30 } };
  assert.deepEqual(machineCleanupSettings({ machines }, 'm3'), { everyMinutes: 30, softFreeGB: 40 });
  assert.deepEqual(machineCleanupSettings({ machines }, 'lothdesktop'), { everyMinutes: 30, softFreeGB: 70 });

  const cfg = { hostGuard: { warnFreeGB: 80, cleanup: { ...DEFAULT_CLEANUP } } } as unknown as Config;
  assert.throws(() => normalizeSetting('hostGuard.cleanup.softFreeGB', 60, cfg), /from 81 to 2000/);
  assert.equal(normalizeSetting('hostGuard.cleanup.softFreeGB', '130', cfg), 130);
  assert.throws(() => normalizeSetting('machines.cleanup.everyMinutes', 5, cfg), /0 \(only when disk space is low\) or/);
  assert.equal(normalizeSetting('machines.cleanup.everyMinutes', 0, cfg), 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  const live = { hostGuard: { warnFreeGB: 80, cleanup: { ...DEFAULT_CLEANUP } } } as unknown as Config;
  setAppConfig(file, live, 'machines.cleanup.softFreeGB', 70);
  setAppConfig(file, live, 'machines.cleanup.softFreeGB', 40, { machine: 'm3' });
  setAppConfig(file, live, 'hostGuard.cleanup.everyMinutes', 30);
  assert.deepEqual(live.machines?.cleanup, { softFreeGB: { '*': 70, m3: 40 } });
  assert.equal(live.hostGuard.cleanup.everyMinutes, 30);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { machines: { cleanup: { softFreeGB: { '*': 70, m3: 40 } } }, hostGuard: { cleanup: { everyMinutes: 30 } } });
  assert.throws(() => setAppConfig(file, live, 'hostGuard.cleanup.softFreeGB', 150, { machine: 'm3' }), /machine is only for/);
});

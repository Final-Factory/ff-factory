import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentAccount, ghConfigDirFor, isLabelledLow, isLabelledMedium, labelLow, ownerGameDataLock, lowCopy, lowEnv, lowRunners, lowTargets, lowUnityDir, strayLowServers, type Exec } from '../machine/lowIntegrity.ts';

/**
 * w5377: the Windows worker fence. What gets the Low label (and what must stay Medium: daemon, secrets, the daemon's
 * folder, the person's working files in repo), the environment a Low agent gets, and the w5347 compiler-server guard.
 */

const R = path.resolve('/ffw');
const kids = (...n: string[]) => n.map((name) => ({ name, dir: true }));

test('labels the root children except daemon, secrets and the daemon folder; of repo only .git', () => {
  const t = lowTargets({
    root: R,
    appDir: path.join(R, 'app', 'current'),
    children: [...kids('daemon', 'secrets', 'claude-medium', 'cache-medium', 'Sandboxes', 'repo', 'tmp', 'app', 'home'), { name: 'root.json', dir: false }],
    exists: () => true,
  });
  assert.deepEqual(t.dirs, [path.join(R, 'Sandboxes'), path.join(R, 'repo', '.git'), path.join(R, 'tmp'), path.join(R, 'home')]);
  assert.deepEqual(t.files, []);
});

test('a bare repo, the store every sandbox is a worktree of, is labelled whole; an empty repo folder is not', () => {
  const head = path.join(R, 'repo', 'HEAD');
  const t = lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('repo', 'home'), exists: (p) => p === head });
  assert.deepEqual(t.dirs, [path.join(R, 'repo'), path.join(R, 'home')]);
  const none = lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('repo', 'home'), exists: () => false });
  assert.deepEqual(none.dirs, [path.join(R, 'home')]);
});

test('adds home when missing, extras outside the root, and files not already under a Low folder', () => {
  const app = path.resolve('/daemon');
  const slots = path.join(app, 'unity-slots');
  const t = lowTargets({
    root: R,
    appDir: app,
    children: kids('sandboxes'),
    extra: [path.join(R, 'sandboxes'), path.resolve('/other'), path.join(app, 'logs'), slots, undefined],
    files: [path.join(app, 'max-events.jsonl'), path.join(R, 'sandboxes', 'x.txt'), undefined],
    allowInAppDir: [slots],
    exists: () => false,
  });
  assert.deepEqual(t.dirs, [path.join(R, 'sandboxes'), path.join(R, 'home'), path.resolve('/other'), slots]);
  assert.deepEqual(t.files, [path.join(app, 'max-events.jsonl')]);
});

test("the agents' node stays Medium inside a Low tools folder, and only then (w5377)", () => {
  const t = lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('tools', 'tmp'), exists: () => true });
  assert.ok(t.dirs.includes(path.join(R, 'tools')));
  assert.deepEqual(t.medium, [path.join(R, 'tools', 'node')]);
  assert.deepEqual(lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('tmp'), exists: () => true }).medium, []);
});

test('CI runner folders are never labelled Low and are kept Medium where an earlier rollout labelled them (w5440)', () => {
  const t = lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('ffu-runners', 'tmp'), exists: () => true });
  assert.ok(!t.dirs.some((d) => d.toLowerCase().includes('ffu-runners')));
  assert.deepEqual(t.medium, [path.join(R, 'ffu-runners')]);
  const both = lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('tools', 'FFU-Runners'), exists: () => true });
  assert.deepEqual(both.medium, [path.join(R, 'tools', 'node'), path.join(R, 'FFU-Runners')]);
});

test("only the folders workers write are labelled Low; BEAST's instances, demos, portals and any new folder stay Medium (w5539)", () => {
  // BEAST's root on 2026-11-24 (ls F:\ffw), the folders the w5451 audit found labelled Low.
  const beast = kids('archives', 'ben-factory', 'cache', 'claude', 'daemon', 'demos', 'ffu-runners', 'ffu-sandboxes', 'gamedata', 'home', 'instances',
    'lens-factory', 'logs', 'max', 'migration', 'nightly-history', 'nightly', 'player-cache', 'players', 'release-records', 'repo', 'sandboxes',
    'scratch-slot3', 'scratch', 'secrets', 'seed', 'steam-lobby-gate', 'steam', 'test-history', 'tmp', 'tools', 'unity-slots', 'voice', 'some-new-portal');
  const t = lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: beast, exists: (p) => p === path.join(R, 'repo', 'HEAD') });
  // max: the old worker-writable Max events folder, unused since w5552 (the events file is the daemon's).
  const fenced = ['archives', 'ben-factory', 'demos', 'ffu-runners', 'instances', 'lens-factory', 'max', 'migration', 'scratch-slot3', 'some-new-portal'];
  for (const n of fenced) {
    assert.ok(!t.dirs.includes(path.join(R, n)), `${n} is not labelled Low`);
    assert.ok(t.medium.includes(path.join(R, n)), `${n} is kept Medium`);
  }
  for (const n of ['daemon', 'secrets']) assert.ok(!t.dirs.includes(path.join(R, n)) && !t.medium.includes(path.join(R, n)), `${n} is left alone`);
  for (const n of ['sandboxes', 'tmp', 'tools', 'claude', 'home', 'cache', 'players', 'nightly', 'logs', 'unity-slots', 'repo']) assert.ok(t.dirs.includes(path.join(R, n)), `${n} is labelled Low`);
  // A temp or sandboxes folder the config puts in another root child makes that child a worker one.
  const moved = lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('sb', 'instances'), extra: [path.join(R, 'sb', 'sandboxes')], exists: () => true });
  assert.ok(moved.dirs.includes(path.join(R, 'sb')));
  assert.deepEqual(moved.medium, [path.join(R, 'instances')]);
});

test("lowRunners names each runner whose Runner.Worker.exe is labelled Low (BEAST's ffu runners, w5440)", async () => {
  const worker = (r: string) => path.join(R, 'ffu-runners', r, 'bin', 'Runner.Worker.exe');
  const exec: Exec = async (_c, args) => ({
    code: 0,
    stdout: args[0] === worker('ffu-beast-4') ? `${args[0]} Mandatory Label\\Low Mandatory Level:(I)(NW)` : `${args[0]} BUILTIN\\Users:(RX)`,
    stderr: '',
  });
  const list = (d: string) => (d === path.join(R, 'ffu-runners') ? ['cargo', 'ffu-beast-3', 'ffu-beast-4'] : []);
  const exists = (p: string) => p === worker('ffu-beast-3') || p === worker('ffu-beast-4');
  assert.deepEqual(await lowRunners(R, exec, { list, exists }), [worker('ffu-beast-4')]);
});

test('labelLow keeps a medium folder Medium only when it inherited Low, and a failure there leaves the fence on (w5377)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'low-'));
  const node = path.join(dir, 'node');
  const gone = path.join(dir, 'gone');
  fs.mkdirSync(node);
  const said: string[] = [];
  const { exec, calls } = icacls(new Set([node]));
  assert.equal(await labelLow({ dirs: [], files: [], medium: [node, gone] }, exec, (l) => void said.push(l)), true);
  assert.deepEqual(calls.filter((c) => c.length > 1), [[node, '/setintegritylevel', '(OI)(CI)medium']]);
  assert.ok(said.some((l) => l.includes('kept') && l.includes('Medium')));
  const already = icacls(new Set());
  await labelLow({ dirs: [], files: [], medium: [node] }, already.exec, () => {});
  assert.deepEqual(already.calls.filter((c) => c.length > 1), [], 'not Low: left alone');
  const bad = icacls(new Set([node]), node);
  assert.equal(await labelLow({ dirs: [], files: [], medium: [node] }, bad.exec, (l) => void said.push(l)), true);
  assert.ok(said.some((l) => l.includes('could not keep')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reads the Low label from icacls', () => {
  assert.ok(isLabelledLow('V:\\ffw\\tmp Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)'));
  assert.ok(!isLabelledLow('V:\\ffw\\tmp BUILTIN\\Administrators:(F)'));
});

const icacls = (labelled: Set<string>, fail?: string): { exec: Exec; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (_cmd, args) => {
      calls.push(args);
      if (args.length === 1) return { code: 0, stdout: labelled.has(args[0]) ? 'Mandatory Label\\Low Mandatory Level' : '', stderr: '' };
      if (args[0] === fail) return { code: 5, stdout: '', stderr: 'Access is denied.' };
      labelled.add(args[0]);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
};

test('labelLow labels only what is not Low yet, makes missing paths, and reports a failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'low-'));
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  const f = path.join(dir, 'events.jsonl');
  const said: string[] = [];
  const { exec, calls } = icacls(new Set([a]));
  assert.equal(await labelLow({ dirs: [a, b], files: [f] }, exec, (l) => void said.push(l)), true);
  assert.ok(fs.existsSync(b) && fs.existsSync(f));
  assert.deepEqual(calls.filter((c) => c.length > 1), [[b, '/setintegritylevel', '(OI)(CI)low'], [f, '/setintegritylevel', 'low']]);
  const bad = icacls(new Set(), b);
  assert.equal(await labelLow({ dirs: [b], files: [] }, bad.exec, (l) => void said.push(l)), false);
  assert.ok(said.some((l) => l.includes('Access is denied')));
});

test('labelLow grants the account Full and labels again when the label is denied for want of WRITE_OWNER (BEAST, w5402)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'low-'));
  const a = path.join(dir, 'a');
  const f = path.join(dir, 'events.jsonl');
  const node = path.join(dir, 'node');
  fs.mkdirSync(node);
  const granted = new Set<string>();
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    if (args.length === 1) return { code: 0, stdout: args[0] === node ? 'Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)' : '', stderr: '' };
    if (args[1] === '/grant') {
      granted.add(args[0]);
      return { code: 0, stdout: 'processed file', stderr: '' };
    }
    return granted.has(args[0]) ? { code: 0, stdout: '', stderr: '' } : { code: 5, stdout: '', stderr: `${args[0]}: Access is denied.` };
  };
  const said: string[] = [];
  assert.equal(await labelLow({ dirs: [a], files: [f], medium: [node] }, exec, (l) => void said.push(l), 'BEAST\\rydin'), true);
  assert.deepEqual(
    calls.filter((c) => c[1] === '/grant'),
    [
      [a, '/grant', 'BEAST\\rydin:(OI)(CI)F'],
      [f, '/grant', 'BEAST\\rydin:F'],
      [node, '/grant', 'BEAST\\rydin:(OI)(CI)F'],
    ],
  );
  assert.ok(said.some((l) => l.includes(`labelled ${a} Low`)) && said.some((l) => l.includes(`kept ${node} Medium`)));
  // A denial the grant cannot cure (the grant is refused too) still fails, so the agents run unfenced.
  const none: Exec = async (_cmd, args) => (args.length === 1 ? { code: 0, stdout: '', stderr: '' } : { code: 5, stdout: '', stderr: 'Access is denied.' });
  assert.equal(await labelLow({ dirs: [a], files: [] }, none, () => {}, 'BEAST\\rydin'), false);
});

test('currentAccount names DOMAIN\\user as icacls takes it', () => {
  assert.equal(currentAccount({ USERDOMAIN: 'BEAST', USERNAME: 'rydin' }), 'BEAST\\rydin');
  assert.equal(currentAccount({ USERNAME: 'rydin' }), 'rydin');
  assert.equal(currentAccount({}), undefined);
});

test('lowCopy names the copy by size and mtime, labels it, and removes older copies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcopy-'));
  const exe = path.join(root, 'claude.exe');
  fs.writeFileSync(exe, 'v1');
  const { exec } = icacls(new Set());
  const first = await lowCopy(root, exe, exec, () => {});
  assert.ok(first && fs.existsSync(first) && path.basename(first).startsWith('claude-2-'));
  fs.writeFileSync(exe, 'v2 longer');
  const second = await lowCopy(root, exe, exec, () => {});
  assert.notEqual(second, first);
  assert.deepEqual(fs.readdirSync(path.dirname(second!)), [path.basename(second!)]);
  assert.equal(await lowCopy(root, path.join(root, 'missing.exe'), exec, () => {}), undefined);
});

test('lowEnv moves APPDATA into the root and puts the agent Git first', () => {
  const git = path.join(R, 'tools', 'git');
  const e = lowEnv(R, git, 'Path', 'C:\\Windows');
  assert.equal(e.APPDATA, path.join(R, 'home', 'AppData', 'Roaming'));
  assert.equal(e.LOCALAPPDATA, path.join(R, 'home', 'AppData', 'Local'));
  assert.equal(e.CLAUDE_CODE_GIT_BASH_PATH, path.join(git, 'bin', 'bash.exe'));
  assert.equal(e.Path, [path.join(git, 'cmd'), path.join(git, 'usr', 'bin'), 'C:\\Windows'].join(path.delimiter));
  assert.deepEqual(Object.keys(lowEnv(R, undefined, 'Path', 'x')).sort(), ['APPDATA', 'LOCALAPPDATA']);
});

test("w5430: lowEnv points gh at the machine's own gh login, and ghConfigDirFor finds it", () => {
  const login = path.join(R, 'person', 'GitHub CLI');
  const e = lowEnv(R, undefined, 'Path', 'x', login);
  assert.equal(e.GH_CONFIG_DIR, login);
  assert.notEqual(path.dirname(e.GH_CONFIG_DIR), e.APPDATA, "the login is the daemon user's, not the moved APPDATA");
  const appdata = path.join(R, 'person');
  assert.equal(ghConfigDirFor({ APPDATA: appdata }, (p) => p === path.join(login, 'hosts.yml')), login);
  assert.equal(ghConfigDirFor({ APPDATA: appdata }, () => false), undefined, 'no hosts.yml: gh has no login here');
  assert.equal(ghConfigDirFor({ APPDATA: appdata, GH_CONFIG_DIR: 'X' }, () => false), 'X');
  assert.equal(ghConfigDirFor({}, () => true), undefined);
});

test('strayLowServers: a Low compiler server on the install path is ended, one through the junction or at Medium is not', () => {
  const junction = path.join(lowUnityDir(R), '6000.3.1f1', 'Data', 'DotNetSdkRoslyn', 'VBCSCompiler.dll');
  const servers = [
    { pid: 1, rid: 0x1000, dll: path.resolve('/Program Files/Unity/Hub/Editor/6000.3.1f1/Editor/Data/DotNetSdkRoslyn/VBCSCompiler.dll') },
    { pid: 2, rid: 0x1000, dll: junction },
    { pid: 3, rid: 0x2000, dll: path.resolve('/Program Files/Unity/x.dll') },
    { pid: 4, rid: 0x1000, dll: '' },
  ];
  assert.deepEqual(strayLowServers(servers, R), [1]);
});

test('w5557: the owner game folder lock reads back Medium, and says so when it is still Low or missing', async () => {
  const dir = 'C:\\Users\\p\\AppData\\LocalLow\\Never Games\\finalfactory';
  // icacls' own words (measured on LothDesktop for Low, w5333; Medium is the same line with "Medium").
  const medium = `${dir} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n    Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)\n`;
  const low = `${dir} NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n    Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)\n`;
  const exec = (out: string): Exec => async () => ({ code: 0, stdout: out, stderr: '' }) as never;
  assert.ok(isLabelledMedium(medium) && !isLabelledMedium(low));
  assert.match(await ownerGameDataLock(dir, exec(medium), () => true), /is Medium; a Low worker's write there is refused/);
  assert.match(await ownerGameDataLock(dir, exec(low), () => true), /is NOT Medium/);
  assert.match(await ownerGameDataLock(dir, exec(medium), () => false), /does not exist yet/);
});

test('w5557: labelLow keeps an inherited-Low owner game folder Medium when it is in the medium list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownergd-'));
  try {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: args.length === 1 ? `${args[0]} Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)` : '', stderr: '' } as never;
    };
    assert.equal(await labelLow({ dirs: [], files: [], medium: [dir] }, exec, () => {}), true);
    assert.deepEqual(calls.find((c) => c.includes("/setintegritylevel")), ["icacls", dir, "/setintegritylevel", "(OI)(CI)medium"], JSON.stringify(calls));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

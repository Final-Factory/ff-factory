import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_READ_UP, READ_BACK, currentAccount, ghConfigDirFor, hasLabel, isExplicitLow, isLabelledLow, isLabelledMedium, labelLow, ownerGameDataLock, labelNoReadUp, LowCopies, LOW_COPY_NAME, lowUnityJunctions, MEDIUM_TOOLS, pickEnv, PROBE_ENV_KEYS, isReadOnlyCopy, junctionLeadsTo, readOnlyGrants, type ExecSync, lowEnv, lowRunners, lowTargets, lowUnityDir, noReadUpTargets, onSystemDrive, openNoReadUp, strayLowServers, type Exec } from '../machine/lowIntegrity.ts';
import { FENCE_READ_ALLOW } from './daemonReads.ts';
import { ensureDaemonOnlyDirs } from '../machine/readFence.ts';

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

test('w5717: given its children, tools turns Medium, each child folder but node is labelled Low on its own, and node keeps its path', () => {
  const tools = path.join(R, 'tools');
  const toolsChildren = [...kids('cargo', 'git', 'node', 'NODE-old', 'low', 'unity-low', 'final-factory-agents'), { name: 'git.json', dir: false }];
  const t = lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('tools', 'tmp'), toolsChildren, exists: () => true });
  assert.ok(!t.dirs.includes(tools), 'tools is not labelled Low');
  for (const c of ['cargo', 'git', 'NODE-old', 'final-factory-agents']) assert.ok(t.dirs.includes(path.join(tools, c)), `${c} is labelled Low`);
  assert.ok(!t.dirs.includes(path.join(tools, 'node')) && !t.files.includes(path.join(tools, 'git.json')), 'node and the stamp are not');
  // w5838: the folders of programs the daemon runs (the Low copies, the Unity junctions, the shims) stay Medium too.
  for (const c of ['low', 'unity-low']) assert.ok(!t.dirs.includes(path.join(tools, c)), `${c} is not labelled Low`);
  assert.deepEqual(t.medium, [tools, ...MEDIUM_TOOLS.map((c) => path.join(tools, c))]);
  assert.deepEqual(MEDIUM_TOOLS, ['node', 'low', 'unity-low', 'shims']);
  // Without the list (a daemon from before w5717 never passes one): the old layout.
  const old = lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('tools'), exists: () => true });
  assert.ok(old.dirs.includes(tools));
  assert.deepEqual(old.medium, [path.join(tools, 'node')]);
  // No tools folder: nothing about it.
  assert.deepEqual(lowTargets({ root: R, appDir: path.join(R, 'daemon'), children: kids('tmp'), toolsChildren: kids('cargo'), exists: () => true }).medium, []);
});

test('w5717: the Mac and Linux fences are unchanged: tools stays one open child, and neither agent tool exists there', async () => {
  const { openChildren } = await import('../machine/lowIntegrity.ts');
  const { agentNodePathDir } = await import('./agentNode.ts');
  const { agentGitPathDir } = await import('./agentGit.ts');
  assert.ok(openChildren('/w').includes('tools'));
  for (const plat of ['darwin', 'linux'] as const) {
    assert.equal(agentNodePathDir('/w', plat, () => true), undefined, plat);
    assert.equal(agentGitPathDir('/w', plat, () => true), undefined, plat);
  }
});

test('w5717: labelLow gives a child of a Medium folder its own Low label, raises the folder after, and reads the child again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'low-'));
  const tools = path.join(dir, 'tools');
  const cargo = path.join(tools, 'cargo');
  const git = path.join(tools, 'git');
  const node = path.join(tools, 'node');
  for (const d of [cargo, git, node]) fs.mkdirSync(d, { recursive: true });
  // The old layout: tools Low on its own, cargo inheriting it, git already Low on its own, node Medium on its own.
  const label = new Map<string, string>([
    [tools, 'Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)'],
    [cargo, 'Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)'],
    [git, 'Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)'],
    [node, 'Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)'],
  ]);
  const calls: string[][] = [];
  const exec: Exec = async (_c, args) => {
    calls.push(args);
    if (args.length === 1) return { code: 0, stdout: `${args[0]} ${label.get(args[0]) ?? ''}`, stderr: '' };
    label.set(args[0], args[2].endsWith('low') ? 'Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)' : 'Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)');
    return { code: 0, stdout: '', stderr: '' };
  };
  const said: string[] = [];
  assert.equal(await labelLow({ dirs: [cargo, git], files: [], medium: [tools, node] }, exec, (l) => void said.push(l)), true);
  const sets = calls.filter((c) => c.length > 1).map((c) => `${path.basename(c[0])} ${c[2]}`);
  assert.deepEqual(sets, ['cargo (OI)(CI)low', 'tools (OI)(CI)medium'], 'cargo first, then tools; git and node untouched');
  assert.ok(calls.filter((c) => c.length === 1 && c[0] === cargo).length >= 2, 'cargo read again after tools rose');
  // A child that cannot be labelled holds its parent Low, so workers keep writing it.
  const stuck = new Map(label);
  stuck.set(tools, 'Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)');
  stuck.set(cargo, 'Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)');
  const bad: Exec = async (_c, args) => {
    if (args.length === 1) return { code: 0, stdout: `${args[0]} ${stuck.get(args[0]) ?? ''}`, stderr: '' };
    if (args[0] === cargo) return { code: 1, stdout: '', stderr: 'The media is write protected.' };
    stuck.set(args[0], 'set');
    return { code: 0, stdout: '', stderr: '' };
  };
  const said2: string[] = [];
  assert.equal(await labelLow({ dirs: [cargo], files: [], medium: [tools, node] }, bad, (l) => void said2.push(l)), false);
  assert.match(stuck.get(tools)!, /Low/, 'tools left Low');
  assert.ok(said2.some((l) => l.includes(`left ${tools} Low`)), said2.join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('w5717: isExplicitLow tells a Low label of its own from an inherited one', () => {
  assert.ok(isExplicitLow('V:\\ffw\\tools\\cargo Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)'));
  assert.ok(!isExplicitLow('V:\\ffw\\tools\\cargo Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)'));
  assert.ok(!isExplicitLow('V:\\ffw\\tools Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)'));
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
  const fenced = ['archives', 'ben-factory', 'demos', 'ffu-runners', 'instances', 'lens-factory', 'max', 'migration', 'scratch-slot3', 'some-new-portal',
    // steamcmd's folder and cached login are the daemon's alone (w5551).
    'steam'];
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

/**
 * A fake icacls for LowCopies (w5838): remembers which files carry a Low label and which the read-only grants; a file
 * written after them (fs.writeFileSync) keeps its marks, as an NTFS write keeps its ACL, which is the case the hash catches.
 */
// The marks belong to the file, not its name: a copy removed and made again starts with none. Not the file id alone: Linux
// gives a new file the id of one just removed (CI, w5838). Its change time too, which a write also moves (NTFS keeps the
// DACL then; no test here needs it kept).
const markKey = (p: string) => {
  const st = fs.statSync(p, { bigint: true });
  return `${p}#${st.ino}#${st.ctimeNs}`;
};

const icaclsSync = (o: { readOnlyFails?: boolean } = {}): { exec: ExecSync; calls: string[][]; low: Set<string>; ro: Set<string> } => {
  const calls: string[][] = [];
  const low = new Set<string>();
  const ro = new Set<string>();
  return {
    calls,
    low,
    ro,
    exec: (_cmd, args) => {
      calls.push(args);
      const [path0, ...rest] = args;
      const f = markKey(path0);
      if (!rest.length) return { code: 0, stdout: `${path0} ${ro.has(f) ? 'OWNER RIGHTS:(RX)' : 'BUILTIN\\Users:(I)(RX)'}\n${low.has(f) ? 'Mandatory Label\\Low Mandatory Level:(NW)' : ''}`, stderr: '' };
      if (rest[0] === '/setintegritylevel') {
        if (ro.has(f)) return { code: 5, stdout: '', stderr: 'Access is denied.' };
        low.add(f);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (o.readOnlyFails) return { code: 5, stdout: '', stderr: 'Access is denied.' };
      ro.add(f);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
};

test('LowCopies names the copy by size and mtime, labels it Low and read-only, and removes older copies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcopy-'));
  const exe = path.join(root, 'claude.exe');
  fs.writeFileSync(exe, 'v1');
  const f = icaclsSync();
  const copies = new LowCopies(root, () => {}, f.exec, 'BEAST\\rydin');
  const first = copies.make(exe);
  assert.ok(first && fs.existsSync(first) && path.basename(first).startsWith('claude-2-'));
  const id = markKey(first!);
  assert.ok(f.low.has(id) && f.ro.has(id), 'labelled Low, then read-only');
  assert.deepEqual(
    f.calls.find((c) => c[0] === first && c[1] === '/inheritance:r'),
    [first, ...readOnlyGrants('BEAST\\rydin')],
  );
  assert.equal(copies.check(first), first, 'an unchanged copy runs as it is');
  fs.writeFileSync(exe, 'v2 longer');
  const second = copies.make(exe)!;
  assert.notEqual(second, first);
  assert.deepEqual(fs.readdirSync(path.dirname(second)), [path.basename(second)]);
  assert.equal(copies.make(path.join(root, 'missing.exe')), undefined);
  assert.equal(copies.check(path.join(root, 'tools', 'low', 'not-ours.exe')), undefined, 'a path it did not make is never passed');
});

test('w5838: a replaced Low copy is not run: check makes it again from its source, with a WARNING', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcopy-'));
  const exe = path.join(root, 'claude.exe');
  fs.writeFileSync(exe, 'the real claude');
  // Read-only applied (the stat key changes with the write) and refused (hashed in full every time): both catch it.
  for (const readOnlyFails of [false, true]) {
    const said: string[] = [];
    const copies = new LowCopies(root, (l) => void said.push(l), icaclsSync({ readOnlyFails }).exec, 'BEAST\\rydin');
    const copy = copies.make(exe)!;
    // A Low worker's program in its place (same size, so only the bytes tell).
    fs.writeFileSync(copy, 'the evil claude');
    const ran = copies.check(copy);
    assert.ok(ran, `readOnlyFails ${readOnlyFails}: still a copy to run`);
    assert.equal(fs.readFileSync(ran, 'utf8'), 'the real claude', 'the copy run has the source bytes again');
    assert.ok(said.some((l) => /WARNING/.test(l) && /made again/.test(l)), said.join('\n'));
    if (readOnlyFails) assert.ok(said.some((l) => /hashed in full before every run/.test(l)), said.join('\n'));
    // A copy replaced while the daemon was down is caught at make, too.
    fs.writeFileSync(copy, 'the evil claude');
    said.length = 0;
    assert.equal(fs.readFileSync(copies.make(exe)!, 'utf8'), 'the real claude');
    assert.ok(said.some((l) => /WARNING/.test(l) && /bytes differ/.test(l)), said.join('\n'));
  }
});

test('w5838: a replaced copy whose source is gone is not run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcopy-'));
  const exe = path.join(root, 'node.exe');
  fs.writeFileSync(exe, 'node');
  const copies = new LowCopies(root, () => {}, icaclsSync().exec, 'BEAST\\rydin');
  const copy = copies.make(exe)!;
  fs.writeFileSync(copy, 'evil');
  fs.rmSync(exe);
  assert.equal(copies.check(copy), undefined);
});

test('w5838 review: what was planted in tools/low before it was Medium goes before any copy runs, with a WARNING each', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcopy-'));
  const exe = path.join(root, 'claude.exe');
  fs.writeFileSync(exe, 'the real claude');
  const dir = path.join(root, 'tools', 'low');
  fs.mkdirSync(path.join(dir, 'claude.exe.local'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude.exe.local', 'version.dll'), 'evil');
  fs.writeFileSync(path.join(dir, 'version.dll'), 'evil');
  fs.writeFileSync(path.join(dir, 'node-1-2.exe.part'), 'evil');
  fs.writeFileSync(path.join(dir, 'gh-10-20.exe'), 'a copy of another program, kept');
  const said: string[] = [];
  const copy = new LowCopies(root, (l) => void said.push(l), icaclsSync().exec, 'BEAST\\rydin').make(exe)!;
  assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(copy), 'gh-10-20.exe'].sort());
  assert.equal(said.filter((l) => /WARNING: removed .*not a copy the daemon made/.test(l)).length, 3, said.join('\n'));
  assert.ok(LOW_COPY_NAME.test('node-1-2.exe') && LOW_COPY_NAME.test('node-1-2') && !LOW_COPY_NAME.test('node-1-2.exe.part') && !LOW_COPY_NAME.test('version.dll'));
});

test('w5838 review: a folder or unreadable file planted at the copy\'s own name is removed and the copy made', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcopy-'));
  const exe = path.join(root, 'claude.exe');
  fs.writeFileSync(exe, 'the real claude');
  const st = fs.statSync(exe);
  const at = path.join(root, 'tools', 'low', `claude-${st.size}-${Math.floor(st.mtimeMs)}.exe`);
  fs.mkdirSync(path.join(at, 'inside'), { recursive: true });
  const said: string[] = [];
  const copy = new LowCopies(root, (l) => void said.push(l), icaclsSync().exec, 'BEAST\\rydin').make(exe);
  assert.equal(copy, at);
  assert.equal(fs.readFileSync(copy!, 'utf8'), 'the real claude');
  assert.ok(said.some((l) => /WARNING/.test(l) && /cannot be read/.test(l)), said.join('\n'));
});

test('w5838 review: tools/unity-low keeps only the junctions it checked; a planted folder goes and a link never takes its target with it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowunity-'));
  const dir = lowUnityDir(root);
  fs.mkdirSync(path.join(dir, '6000.9.9f1'), { recursive: true });
  fs.writeFileSync(path.join(dir, '6000.9.9f1', 'Unity.exe'), 'evil');
  const install = path.join(root, 'install', 'Editor');
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'Unity.exe'), 'the real Unity');
  fs.symlinkSync(install, path.join(dir, '6000.1.0f1'), 'junction');
  const said: string[] = [];
  const have = await lowUnityJunctions(root, [], async () => ({ code: 1, stdout: '', stderr: 'no' }), (l) => void said.push(l));
  assert.deepEqual(have, []);
  assert.deepEqual(fs.readdirSync(dir), [], said.join('\n'));
  assert.equal(fs.readFileSync(path.join(install, 'Unity.exe'), 'utf8'), 'the real Unity', 'what the link led to is untouched');
  assert.equal(said.filter((l) => /WARNING: removed/.test(l)).length, 2, said.join('\n'));
});

test('w5838 review: pickEnv keeps only the named keys, whatever their case', () => {
  assert.deepEqual(pickEnv(['PATH', 'USERPROFILE'], { Path: 'p', USERPROFILE: 'u', GH_TOKEN: 'secret' }), { Path: 'p', USERPROFILE: 'u' });
  assert.ok(!PROBE_ENV_KEYS.some((k) => /TOKEN|KEY|SECRET/i.test(k)));
});

test('w5838: isReadOnlyCopy wants the OWNER RIGHTS entry and nothing inherited', () => {
  assert.ok(isReadOnlyCopy('x OWNER RIGHTS:(RX)\n   BEAST\\rydin:(RX)\n   Mandatory Label\\Low Mandatory Level:(NW)'));
  assert.ok(!isReadOnlyCopy('x OWNER RIGHTS:(RX)\n   BUILTIN\\Users:(I)(RX)'));
  assert.ok(!isReadOnlyCopy('x BEAST\\rydin:(I)(F)'));
});

test('w5877: isReadOnlyCopy refuses an access list that still lets anyone but SYSTEM or Administrators write', () => {
  // What readOnlyGrants leaves, as icacls prints it (measured on BEAST, w5877).
  const ours = 'F:\\ffw\\tools\\low\\claude-1-2.exe BUILTIN\\Administrators:(F)\n   NT AUTHORITY\\SYSTEM:(F)\n   BEAST\\rydin:(RX)\n   OWNER RIGHTS:(RX)\n   Mandatory Label\\Low Mandatory Level:(NW)\n\nSuccessfully processed 1 files; Failed processing 0 files';
  assert.ok(isReadOnlyCopy(ours));
  // The reviewer's measured case: OWNER RIGHTS:(RX) set by a Low worker beside Everyone:(F), nothing inherited.
  assert.ok(!isReadOnlyCopy('F:\\x\\c.exe OWNER RIGHTS:(RX)\n   Everyone:(F)\n   Mandatory Label\\Low Mandatory Level:(NW)'));
  assert.ok(!isReadOnlyCopy(ours.replace('BEAST\\rydin:(RX)', 'BEAST\\rydin:(RX,W)')));
  assert.ok(!isReadOnlyCopy(ours.replace('BEAST\\rydin:(RX)', 'BEAST\\rydin:(M)')));
});

test('w5877: a copy left by an earlier daemon run is never taken over, even with its source\'s bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcopy-'));
  const exe = path.join(root, 'claude.exe');
  fs.writeFileSync(exe, 'the real claude');
  const first = new LowCopies(root, () => {}, icaclsSync().exec, 'BEAST\\rydin').make(exe)!;
  const before = fs.statSync(first, { bigint: true });
  // The next daemon run (a new LowCopies) finds it there, its bytes right but its access list a Low worker's.
  const f = icaclsSync();
  const said: string[] = [];
  const again = new LowCopies(root, (l) => void said.push(l), f.exec, 'BEAST\\rydin').make(exe)!;
  assert.equal(fs.readFileSync(again, 'utf8'), 'the real claude');
  const after = fs.statSync(again, { bigint: true });
  assert.ok(after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs, 'a new file, not the old one');
  assert.ok(f.calls.some((c) => c[0] === again && c[1] === '/inheritance:r'), 'locked by this run');
  assert.ok(said.some((l) => /earlier daemon run; made again, never taken over/.test(l)), said.join('\n'));
});

test('w5877: a same-size rewrite with its times put back is still caught before the run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcopy-'));
  const exe = path.join(root, 'claude.exe');
  fs.writeFileSync(exe, 'the real claude');
  const said: string[] = [];
  const copies = new LowCopies(root, (l) => void said.push(l), icaclsSync().exec, 'BEAST\\rydin');
  const copy = copies.make(exe)!;
  const st = fs.statSync(copy);
  fs.writeFileSync(copy, 'the evil claude');
  fs.utimesSync(copy, st.atime, st.mtime);
  const ran = copies.check(copy)!;
  assert.equal(fs.readFileSync(ran, 'utf8'), 'the real claude');
  assert.ok(said.some((l) => /WARNING/.test(l) && /made again/.test(l)), said.join('\n'));
});

test('w5877: when tools/low is not Medium, a DLL planted after make is swept before the next run, with a WARNING', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowcopy-'));
  const exe = path.join(root, 'node.exe');
  fs.writeFileSync(exe, 'node');
  const dir = path.join(root, 'tools', 'low');
  const f = icaclsSync();
  const exec: ExecSync = (cmd, args) => (args.length === 1 && args[0] === dir ? { code: 0, stdout: `${dir} Mandatory Label\\Low Mandatory Level:(I)(OI)(CI)(NW)`, stderr: '' } : f.exec(cmd, args));
  const said: string[] = [];
  const copies = new LowCopies(root, (l) => void said.push(l), exec, 'BEAST\\rydin');
  const copy = copies.make(exe)!;
  assert.ok(said.some((l) => /WARNING: .* is not labelled Medium/.test(l)), said.join('\n'));
  fs.writeFileSync(path.join(dir, 'version.dll'), 'evil');
  assert.equal(copies.check(copy), copy);
  assert.ok(!fs.existsSync(path.join(dir, 'version.dll')), 'swept before the run');
});

test('w5877: a Unity junction with a Low label of its own is made again', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowunity-'));
  const dir = lowUnityDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const install = path.join(root, 'install', 'Editor');
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'Unity.exe'), 'the real Unity');
  const link = path.join(dir, '6000.1.0f1');
  fs.symlinkSync(install, link, 'junction');
  // Node reads a junction whose target it cannot parse (on BEAST, one into F: made from a sandbox reads `Global\F:\...`)
  // as a plain folder: junctionLeadsTo is false there and this case is never reached.
  try {
    fs.readlinkSync(link);
  } catch {
    t.skip("this volume's junctions cannot be read back by Node");
    return;
  }
  let made = 0;
  const said: string[] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'icacls') return { code: 0, stdout: `${args[0]} Mandatory Label\\Low Mandatory Level:(NW)`, stderr: '' };
    made++;
    fs.symlinkSync(install, link, 'junction');
    return { code: 0, stdout: '', stderr: '' };
  };
  const have = await lowUnityJunctions(root, [{ version: '6000.1.0f1', bin: path.join(install, 'Unity.exe') }], exec, (l) => void said.push(l));
  assert.deepEqual(have, ['6000.1.0f1']);
  assert.equal(made, 1, said.join('\n'));
  assert.ok(said.some((l) => /WARNING: the Unity junction .* Low label of its own/.test(l)), said.join('\n'));
  assert.equal(fs.readFileSync(path.join(install, 'Unity.exe'), 'utf8'), 'the real Unity');
});

test('w5838: junctionLeadsTo compares where a junction leads, whatever its prefix or case', () => {
  const target = 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.19f1\\Editor';
  assert.ok(junctionLeadsTo('L', target, () => '\\\\?\\c:\\program files\\Unity\\Hub\\Editor\\6000.3.19f1\\Editor\\'));
  assert.ok(junctionLeadsTo('L', target, () => target));
  assert.ok(!junctionLeadsTo('L', target, () => 'F:\\ffw\\tmp\\evil\\Editor'));
  assert.ok(
    !junctionLeadsTo('L', target, () => {
      throw new Error('not a link');
    }),
  );
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

test('w5546: No-Read-Up on the daemon folder, secrets and root.json; the worker reads in the daemon folder given back', () => {
  const app = path.join(R, 'daemon');
  const there = new Set([app, path.join(R, 'secrets'), path.join(R, 'root.json'), path.join(app, 'logs'), path.join(app, 'src'), path.join(app, 'sandboxes.json'), path.join(app, 'gh-app', 'sessions')]);
  const files = new Set([path.join(R, 'root.json'), path.join(app, 'sandboxes.json')]);
  const t = noReadUpTargets({ root: R, appDir: app, allowBack: FENCE_READ_ALLOW, extraBack: [path.join(app, 'gh-app', 'sessions')], stat: (p) => (there.has(p) ? (files.has(p) ? 'file' : 'dir') : undefined) });
  assert.deepEqual(t, [
    { path: app, sddl: NO_READ_UP.dir },
    { path: path.join(R, 'secrets'), sddl: NO_READ_UP.dir },
    { path: path.join(R, 'root.json'), sddl: NO_READ_UP.file },
    { path: path.join(app, 'logs'), sddl: READ_BACK.dir },
    { path: path.join(app, 'src'), sddl: READ_BACK.dir },
    { path: path.join(app, 'sandboxes.json'), sddl: READ_BACK.file },
    { path: path.join(app, 'gh-app', 'sessions'), sddl: READ_BACK.dir },
  ]);
  assert.equal(NO_READ_UP.dir, 'S:(ML;OICI;NWNR;;;ME)');
  assert.ok(!t.some((x) => /tokens\.json|hosts|daemon\.json/.test(x.path)));
});

test('w5546: labelNoReadUp skips the system drive and labels already set, sets the rest through SetNamedSecurityInfoW, and retries a WRITE_OWNER refusal after the grant', async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const t = [
    { path: 'C:\\ffw-anchor\\secrets', sddl: NO_READ_UP.dir },
    { path: 'F:\\ffw\\daemon', sddl: NO_READ_UP.dir },
    { path: 'F:\\ffw\\daemon\\src', sddl: READ_BACK.dir },
    { path: 'F:\\ffw\\root.json', sddl: NO_READ_UP.file },
  ];
  let first = true;
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'icacls' && args.length === 1) return { code: 0, stdout: args[0].endsWith('src') ? `${args[0]} Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)` : '', stderr: '' };
    if (cmd === 'icacls') return { code: 0, stdout: '', stderr: '' };
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
    assert.match(script, /SetNamedSecurityInfoW\(path, 1, 0x10,/);
    const n = (script.match(/\[FfLabel\]::Set\(/g) ?? []).length;
    if (first) {
      first = false;
      assert.ok(script.includes("'F:\\ffw\\daemon', 'S:(ML;OICI;NWNR;;;ME)'") && script.includes("'F:\\ffw\\root.json', 'S:(ML;;NWNR;;;ME)'"));
      return { code: 0, stdout: 'ok 0\r\nerr 1 5\r\n', stderr: '' };
    }
    assert.equal(n, 1);
    return { code: 0, stdout: 'ok 0\r\n', stderr: '' };
  };
  const said: string[] = [];
  assert.equal(await labelNoReadUp(t, exec, (l) => void said.push(l), { account: 'me', systemDrive: (p) => p.startsWith('C:') }), true);
  assert.ok(said.some((l) => l.includes('C:\\ffw-anchor\\secrets') && l.includes('system drive')));
  assert.ok(!calls.some((c) => c.args.some((a) => a.startsWith('C:'))), 'nothing on C: is touched');
  assert.ok(calls.some((c) => c.cmd === 'icacls' && c.args[0] === 'F:\\ffw\\root.json' && c.args[1] === '/grant'));
  assert.equal(calls.filter((c) => c.cmd === 'powershell.exe').length, 2);
  const bad: Exec = async (cmd, args) => (cmd === 'icacls' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'boom' });
  assert.equal(await labelNoReadUp([t[1]], bad, () => {}, { systemDrive: () => false }), false);
});

test('w5546: hasLabel reads icacls for an explicit Medium label with or without NR; an inherited one does not count', () => {
  assert.equal(hasLabel('x Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW,NR)', NO_READ_UP.dir), true);
  assert.equal(hasLabel('x Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)', NO_READ_UP.dir), false);
  assert.equal(hasLabel('x Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)', READ_BACK.dir), true);
  assert.equal(hasLabel('x Mandatory Label\\Medium Mandatory Level:(I)(OI)(CI)(NW,NR)', NO_READ_UP.dir), false);
  assert.equal(hasLabel('x Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)', READ_BACK.dir), false);
  assert.equal(onSystemDrive('C:\\ffw', 'C:', (p) => p), true);
  assert.equal(onSystemDrive('F:\\ffw\\daemon', 'C:', () => 'C:\\ffw-anchor\\daemon'), true, 'a junction into C:');
  assert.equal(onSystemDrive('F:\\ffw\\daemon', 'C:', (p) => p), false);
});

test('w5546 lockout review B1, B3: off takes only the NR labels still there off again; a Dev Drive host secrets folder is closed', async () => {
  const there = new Set(['F:\\ffw\\daemon', 'F:\\ffw\\secrets', 'D:\\work\\ffw\\secrets', 'F:\\ffw\\root.json', 'F:\\ffw\\daemon\\logs']);
  const t = noReadUpTargets({ root: 'F:\\ffw', appDir: 'F:\\ffw\\daemon', allowBack: ['logs'], secrets: ['D:\\work\\ffw\\secrets'], stat: (p) => (there.has(p) ? (p.endsWith('.json') ? 'file' : 'dir') : undefined) });
  assert.ok(t.some((x) => x.path === 'D:\\work\\ffw\\secrets' && x.sddl === NO_READ_UP.dir), 'the host folder\'s secrets closed');
  const scripts: string[] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'icacls') return { code: 0, stdout: args[0] === 'F:\\ffw\\daemon' ? `${args[0]} Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW,NR)` : `${args[0]} Mandatory Label\\Medium Mandatory Level:(I)(OI)(CI)(NW,NR)`, stderr: '' };
    scripts.push(Buffer.from(args[args.length - 1], 'base64').toString('utf16le'));
    return { code: 0, stdout: 'ok 0\r\n', stderr: '' };
  };
  assert.deepEqual(await openNoReadUp(t, exec, () => {}, { systemDrive: () => false }), ['F:\\ffw\\daemon'], 'only the explicit NR label; inherited ones go with it');
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes("'F:\\ffw\\daemon', 'S:(ML;OICI;NW;;;ME)'") && !scripts[0].includes('NWNR'), scripts[0]);
  const none: Exec = async (cmd) => (cmd === 'icacls' ? { code: 0, stdout: 'x Mandatory Label\\Medium Mandatory Level:(OI)(CI)(NW)', stderr: '' } : assert.fail('nothing to set'));
  assert.deepEqual(await openNoReadUp(t, none, () => {}, { systemDrive: () => false }), [], 'never labelled: nothing walked');
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

test('w5731: a <root>/steam made after the start is labelled at the next labelling, and its secret files get NR of their own', async () => {
  // N1 of the #1237 review: the daemon labels only paths that exist. ensureDaemonOnlyDirs makes steam first (start and the
  // read-fence switch), so No-Read-Up is set on it before steamcmd's first install writes inside.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w5731-'));
  try {
    const root = path.join(dir, 'ffw');
    const app = path.join(root, 'daemon');
    fs.mkdirSync(path.join(app, 'logs'), { recursive: true });
    const steam = path.join(root, 'steam');
    assert.ok(!noReadUpTargets({ root, appDir: app, allowBack: [] }).some((t) => t.path === steam), 'no folder yet: no target');
    ensureDaemonOnlyDirs(root);
    assert.ok(fs.statSync(steam).isDirectory());
    assert.ok(!fs.existsSync(path.join(root, 'steam-lobby-gate')), 'only the daemon-only children are made');
    const t = noReadUpTargets({ root, appDir: app, allowBack: [] });
    assert.deepEqual(t.find((x) => x.path === steam), { path: steam, sddl: NO_READ_UP.dir });
    // The label is then set: labelNoReadUp's script names steam with the folder's NR label.
    const scripts: string[] = [];
    const exec: Exec = async (cmd, args) => {
      if (cmd === 'icacls') return { code: 0, stdout: '', stderr: '' };
      const s = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
      scripts.push(s);
      const n = (s.match(/\[FfLabel\]::Set\(/g) ?? []).length;
      return { code: 0, stdout: Array.from({ length: n }, (_, i) => `ok ${i}`).join('\r\n'), stderr: '' };
    };
    assert.equal(await labelNoReadUp(t, exec, () => {}, { systemDrive: () => false }), true);
    assert.ok(scripts.some((s) => s.includes(`'${steam}', '${NO_READ_UP.dir}'`)), scripts.join('\n'));
    ensureDaemonOnlyDirs(root); // again at every start: no error on an existing folder
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // N2: steam's secret files by name, with a file's NR label, when they are there; nothing else inside steam.
  const W = 'F:\\ffw';
  const files = new Set([W + '\\steam\\config.json', W + '\\steam\\steamcmd\\config\\config.vdf']);
  const bs = (x: string) => x.replace(/\//g, '\\');
  const stat = (x: string) => {
    const p = bs(x);
    return files.has(p) ? ('file' as const) : p === W + '\\steam' || p === W + '\\daemon' ? ('dir' as const) : undefined;
  };
  const t2 = noReadUpTargets({ root: W, appDir: W + '\\daemon', allowBack: [], stat });
  const inSteam = t2.filter((x) => bs(x.path).startsWith(W + '\\steam\\'));
  assert.deepEqual(inSteam.map((x) => [bs(x.path), x.sddl]).sort(), [...files].map((f) => [f, NO_READ_UP.file]).sort());
  // A file that kept an explicit Low label is not "already so", so it is labelled; one already NR is left alone.
  const vdf = t2.find((x) => bs(x.path).endsWith('config.vdf'))!;
  assert.equal(hasLabel(`${vdf.path} Mandatory Label\\Low Mandatory Level:(NW)`, vdf.sddl), false);
  assert.equal(hasLabel(`${vdf.path} Mandatory Label\\Medium Mandatory Level:(NW,NR)`, vdf.sddl), true);
});

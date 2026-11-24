import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLabelledLow, labelLow, lowCopy, lowEnv, lowTargets, lowUnityDir, strayLowServers, type Exec } from '../machine/lowIntegrity.ts';

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
    children: [...kids('daemon', 'secrets', 'Sandboxes', 'repo', 'tmp', 'app', 'home'), { name: 'root.json', dir: false }],
    exists: () => true,
  });
  assert.deepEqual(t.dirs, [path.join(R, 'Sandboxes'), path.join(R, 'repo', '.git'), path.join(R, 'tmp'), path.join(R, 'home')]);
  assert.deepEqual(t.files, []);
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

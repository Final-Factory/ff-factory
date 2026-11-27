// w5631 (w5540 stage 3): Linux sandbox editors start under the workers' Landlock write rules, warn-only first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { EDITOR_HOME_SEED, MacUnity, linuxEditorFenceFor, seedEditorHomeFenced, linuxLicensingClientRunning, macEditorStatusDir, seedLinuxEditorHome, type EditorFence, type Proc, type UnityDeps } from '../machine/unity.ts';
import { FF_LANDLOCK, writeLockArgs } from '../machine/writeLock.ts';

const ROOT = '/home/u/ffw';
const REPO = `${ROOT}/sandboxes/slot1`;
const BIN = '/home/u/Unity/Hub/Editor/6000.3.19f1/Editor/Unity';
const RULES = writeLockArgs({ root: ROOT, runtimeDir: '/run/user/1000', home: `${ROOT}/home` });
/**
 * w6475: the Linux editor fence and its home seeding run only on Linux; on Windows writeLockArgs resolves these Linux
 * paths to drive paths, the seeding joins with '/', and a folder symlink needs a privilege the test run lacks.
 */
const LINUX_ONLY = { skip: process.platform === 'win32' && 'the Linux editor fence (Landlock) and its home seeding run only on Linux' };

test('w5631: no editor fence while the workers\' write lock is off', () => {
  assert.equal(linuxEditorFenceFor(undefined, ROOT, 'enforce'), undefined);
});

test('w5631: the enforced rules are the workers\' with <root>/home as the home; the editor\'s home and bridge folder are set', LINUX_ONLY, () => {
  const f = linuxEditorFenceFor(RULES, ROOT, 'enforce')!;
  assert.equal(f.kind, 'landlock');
  assert.equal(f.warn, false);
  assert.deepEqual(f.args, RULES);
  const rw = f.args.flatMap((a, i) => (f.args[i - 1] === '--rw' ? [a] : []));
  assert.ok(rw.includes(`${ROOT}/home/.local/share/unity3d`) && rw.includes(`${ROOT}/home/.config/unity3d`), 'Unity\'s prefs folders under the moved home');
  assert.ok(!rw.some((p) => p.startsWith('/home/u/.')), 'nothing of the person\'s own home');
  assert.ok(!rw.includes('/'), 'not the whole disk');
  assert.ok(!rw.includes(`${ROOT}/daemon`) && !rw.includes(`${ROOT}/secrets`), 'the daemon and secrets folders stay read-only');
  assert.deepEqual(f.env, { HOME: `${ROOT}/home`, UNITY_MCP_STATUS_DIR: `${ROOT}/home/.unity-mcp` });
  assert.equal(f.env.UNITY_MCP_STATUS_DIR, macEditorStatusDir(ROOT), 'the folder the daemon reads from its start');
});

test('w5631: warn-only grants / and drops the socket denies, so it refuses nothing; the rest is kept', () => {
  const w = linuxEditorFenceFor(RULES, ROOT, 'warn')!;
  assert.equal(w.warn, true);
  assert.deepEqual(w.args.slice(-2), ['--rw', '/']);
  assert.ok(RULES.includes('--deny-unix') && !w.args.includes('--deny-unix'));
  assert.ok(!w.args.includes('/run/user/1000/bus') && !w.args.includes('/run/user/1000/systemd'));
  assert.deepEqual(w.args.slice(0, -2), RULES.filter((a, i) => a !== '--deny-unix' && RULES[i - 1] !== '--deny-unix'));
});

function landlockRuns(): boolean {
  if (process.platform !== 'linux') return false;
  return spawnSync('python3', [FF_LANDLOCK, '--rw', '/', '--', '/bin/true']).status === 0;
}

test('w5631: under the enforced rules the editor cannot make a folder outside the root; warn-only can (Linux with Landlock)', { skip: !landlockRuns() }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w5631-'));
  const root = path.join(tmp, 'ffw');
  for (const d of ['home', 'sandboxes', 'daemon']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  const rules = writeLockArgs({ root, home: path.join(root, 'home') });
  const mk = (mode: 'warn' | 'enforce', dir: string) => spawnSync('python3', [FF_LANDLOCK, ...linuxEditorFenceFor(rules, root, mode)!.args, '--', '/bin/mkdir', dir], { encoding: 'utf8' });
  assert.notEqual(mk('enforce', path.join(outside, 'e')).status, 0, 'outside the root: refused');
  assert.notEqual(mk('enforce', path.join(root, 'daemon', 'e')).status, 0, 'the daemon\'s folder: refused');
  assert.equal(mk('enforce', path.join(root, 'home', 'e')).status, 0, 'its home: written');
  assert.equal(mk('enforce', path.join(root, 'sandboxes', 'e')).status, 0, 'the sandboxes: written');
  assert.equal(mk('warn', path.join(outside, 'w')).status, 0, 'warn-only refuses nothing');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('w5631: the moved home gets Unity\'s prefs folders and the person\'s prefs once; a prefs file already there is kept', LINUX_ONLY, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w5631seed-'));
  const real = path.join(tmp, 'real');
  const home = path.join(tmp, 'ffw', 'home');
  fs.mkdirSync(path.join(real, '.local', 'share', 'unity3d'), { recursive: true });
  fs.writeFileSync(path.join(real, '.local', 'share', 'unity3d', 'prefs'), '<unity_prefs version_major="1"/>');
  assert.deepEqual(seedLinuxEditorHome(home, real).seeded, [path.join(home, '.local', 'share', 'unity3d', 'prefs')], 'only what the real home has');
  assert.ok(fs.statSync(path.join(home, '.config', 'unity3d')).isDirectory(), 'Unity makes this folder without its parents');
  assert.ok(fs.statSync(path.join(home, '.unity-mcp')).isDirectory());
  fs.writeFileSync(path.join(home, '.local', 'share', 'unity3d', 'prefs'), 'the editors\' own');
  assert.deepEqual(seedLinuxEditorHome(home, real).seeded, []);
  assert.equal(fs.readFileSync(path.join(home, '.local', 'share', 'unity3d', 'prefs'), 'utf8'), 'the editors\' own');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('w6354 (review of w5631): the seeding follows no link a worker planted in the editor\'s home, and writes nothing outside it', LINUX_ONLY, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w5631link-'));
  const real = path.join(tmp, 'real');
  const home = path.join(tmp, 'ffw', 'home');
  const outside = path.join(tmp, 'outside');
  for (const d of [path.join(real, '.local', 'share', 'unity3d'), path.join(real, '.config', 'unity3d'), outside, path.join(home, '.local', 'share', 'unity3d')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(real, '.local', 'share', 'unity3d', 'prefs'), 'the person\'s editor prefs');
  fs.writeFileSync(path.join(real, '.config', 'unity3d', 'prefs'), 'the person\'s global prefs');
  fs.symlinkSync(outside, path.join(home, '.config'));
  const dangling = path.join(outside, 'planted');
  fs.symlinkSync(dangling, path.join(home, '.local', 'share', 'unity3d', 'prefs'));
  const r = seedLinuxEditorHome(home, real);
  assert.deepEqual(r.seeded, []);
  assert.deepEqual(r.safe, [], 'no prefs file the daemon may write later');
  assert.equal(r.refused.length, 2, r.refused.join('; '));
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing made through the .config link');
  assert.ok(!fs.existsSync(dangling), 'the dangling link\'s target was not filled with the person\'s prefs');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('w5631: any Unity licensing client of the user counts, the Hub\'s or an editor\'s, and nothing that only names one', () => {
  assert.ok(linuxLicensingClientRunning('/usr/lib/unityhub/UnityLicensingClient_V1/Unity.Licensing.Client --namedPipe Unity-LicenseClient-u\n'));
  assert.ok(linuxLicensingClientRunning('bash\n  /home/u/Unity/Hub/Editor/6000.3.19f1/Editor/Data/Resources/Licensing/Client/Unity.Licensing.Client\n'));
  assert.ok(!linuxLicensingClientRunning('/bin/grep Unity.Licensing.Client\n'));
  assert.ok(!linuxLicensingClientRunning(''));
});

function fakeLinux(fence: EditorFence | undefined, o: { fenced?: boolean; client?: string | undefined; throws?: string } = {}) {
  const world = { procs: [] as Proc[], plain: [] as string[][], fenced: [] as { fence: EditorFence; bin: string; args: string[] }[], now: 0 };
  const launchAt = (bin: string, args: string[]) => {
    const pid = 7000 + world.procs.length;
    world.procs.push({ pid, ppid: 1, cmd: `${bin} ${args.join(' ')}` });
    return pid;
  };
  const deps: UnityDeps = {
    procs: async () => [...world.procs],
    kill: () => undefined,
    launch: (bin, args) => (world.plain.push([bin, ...args]), launchAt(bin, args)),
    ...(o.fenced !== false ? { launchFenced: async (f: EditorFence, bin: string, args: string[]) => { if (o.throws) throw new Error(o.throws); world.fenced.push({ fence: f, bin, args }); return launchAt(bin, args); } } : {}),
    licensingClient: async () => o.client,
    exists: () => false,
    remove: () => undefined,
    sleep: async (ms) => void (world.now += ms),
    now: () => world.now,
  };
  return { world, u: new MacUnity(REPO, deps, () => BIN, 'linux', {}, { fence: () => fence }) };
}

test('w5631: a Linux sandbox editor starts through the fenced launch with its own binary and arguments, and says how', async () => {
  const enforce = linuxEditorFenceFor(RULES, ROOT, 'enforce')!;
  const a = fakeLinux(enforce);
  const said = await a.u.start();
  assert.equal(a.world.plain.length, 0, 'never the unfenced launch');
  assert.equal(a.world.fenced[0].fence, enforce);
  assert.equal(a.world.fenced[0].bin, BIN);
  assert.deepEqual(a.world.fenced[0].args, ['-projectPath', REPO]);
  assert.match(said, /inside the workers' Landlock write rules/);
  assert.deepEqual(a.u.fenced, { on: true });

  const w = fakeLinux(linuxEditorFenceFor(RULES, ROOT, 'warn')!);
  assert.match(await w.u.start(), /Landlock write rules, warn-only/);
  assert.deepEqual(w.u.fenced, { on: true, warn: true });
});

test('w5631: with no licensing client running, no fenced launcher or no fence, the editor starts unfenced as before and says why', async () => {
  const enforce = linuxEditorFenceFor(RULES, ROOT, 'enforce')!;
  const noClient = fakeLinux(enforce, { client: 'no Unity licensing client runs for this user' });
  assert.match(await noClient.u.start(), /unfenced \(no Unity licensing client runs for this user\)/);
  assert.equal(noClient.world.fenced.length, 0);
  assert.deepEqual(noClient.world.plain[0], [BIN, '-projectPath', REPO]);

  const noLauncher = fakeLinux(enforce, { fenced: false });
  assert.match(await noLauncher.u.start(), /unfenced \(no fenced launcher here\)/);

  const off = fakeLinux(undefined);
  const saidOff = await off.u.start();
  assert.equal(off.world.fenced.length, 0);
  assert.doesNotMatch(saidOff, /fence|unfenced/);
});

test('w5631: the daemon reads <root>/home/.unity-mcp from its start on Linux too, and picks the Linux fence there', () => {
  // a Windows checkout with core.autocrlf has CRLF line ends (w6475)
  const src = fs.readFileSync(new URL('../machine/daemon.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const setup = src.slice(src.indexOf('private async fenceSetup()'), src.indexOf('private editorFence()'));
  const add = setup.indexOf("if (process.platform !== 'win32' && this.cfg.root) addMcpStatusDir(macEditorStatusDir(this.cfg.root));");
  assert.ok(add > 0 && add < setup.indexOf("if (this.fence.state.state !== 'setting_up') return;"));
  const pick = src.slice(src.indexOf('private editorFence()'), src.indexOf('private macEditorMemo'));
  assert.match(pick, /if \(this\.cfg\.editorFence === false\) return undefined;\n\s+if \(process\.platform === 'darwin'\) return this\.macEditorFence\(\);\n\s+if \(process\.platform === 'linux'\) return this\.linuxEditorFence\(\);/);
});

test('w6354 (review of w5631): a fenced launch that throws starts the editor unfenced in warn and says why; enforced, the start fails', async () => {
  const w = fakeLinux(linuxEditorFenceFor(RULES, ROOT, 'warn')!, { throws: 'EACCES: mkdir' });
  assert.match(await w.u.start(), /unfenced \(the fenced launch failed: EACCES: mkdir\)/);
  assert.deepEqual(w.world.plain[0], [BIN, '-projectPath', REPO]);
  const e = fakeLinux(linuxEditorFenceFor(RULES, ROOT, 'enforce')!, { throws: 'EACCES: mkdir' });
  await assert.rejects(e.u.start(), /EACCES: mkdir/);
  assert.equal(e.world.plain.length, 0, 'never an unfenced editor once enforced');
});

const BURST_OFF = '<unity_prefs version_major="1"><pref name="BurstCompilation" type="int">0</pref></unity_prefs>';

test('w6356 (review of w5631): the daemon seeds the home in a child under ff-landlock.py that may write only that home', async () => {
  const calls: string[][] = [];
  const r = await seedEditorHomeFenced(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'w5631argv-')), 'home'), '/home/u', async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: '{"seeded":[],"refused":[],"safe":[]}\n', stderr: '' }) as never);
  assert.deepEqual(r, { seeded: [], refused: [], safe: [] });
  const [cmd, lock, ...rest] = calls[0];
  assert.equal(cmd, 'python3');
  assert.equal(lock, FF_LANDLOCK);
  assert.deepEqual(rest.slice(0, 3), ['--rw', rest[1], '--'], 'one writable folder, the home');
  assert.ok(rest.includes(EDITOR_HOME_SEED));
  const fail = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'w5631fail-')), 'home');
  await assert.rejects(seedEditorHomeFenced(fail, '/home/u', async () => ({ code: 1, stdout: '', stderr: 'boom' }) as never), /seeding the editor's home failed \(exit 1\): boom/);
});

test('w6356 (review of w5631): under Landlock the seeding child seeds the home and turns Burst on, and cannot write outside it (Linux with Landlock)', { skip: !landlockRuns() }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w5631child-'));
  const real = path.join(tmp, 'real');
  const home = path.join(tmp, 'ffw', 'home');
  fs.mkdirSync(path.join(real, '.local', 'share', 'unity3d'), { recursive: true });
  fs.writeFileSync(path.join(real, '.local', 'share', 'unity3d', 'prefs'), BURST_OFF);
  const r = await seedEditorHomeFenced(home, real);
  assert.deepEqual(r.seeded, [path.join(home, '.local', 'share', 'unity3d', 'prefs')]);
  assert.match(r.burst ?? '', /BurstCompilation was 0/);
  assert.match(fs.readFileSync(path.join(home, '.local', 'share', 'unity3d', 'prefs'), 'utf8'), /type="int">1</);
  assert.equal(fs.readFileSync(path.join(real, '.local', 'share', 'unity3d', 'prefs'), 'utf8'), BURST_OFF, 'the person\'s own prefs untouched');
  // The kernel is what holds the child to the home: the same rules refuse a write outside it, whatever path leads there.
  const out = spawnSync('python3', [FF_LANDLOCK, '--rw', home, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(path.join(real, 'x'))}, 'x')`], { encoding: 'utf8' });
  assert.notEqual(out.status, 0);
  assert.ok(!fs.existsSync(path.join(real, 'x')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('w5631: the Linux editor fence is off unless daemon.json says editorFence true (Landlock aborts a windowed editor in GTK)', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'machine', 'daemon.ts'), 'utf8');
  const body = src.slice(src.indexOf('private linuxEditorFence()'), src.indexOf('this.linuxEditorMemo = { fence }'));
  assert.match(body, /if \(this\.cfg\.editorFence !== true\) log\(/);
  assert.ok(body.indexOf('editorFence !== true') < body.indexOf('linuxEditorFenceFor('), 'decided before any rules are made');
});

test('w6371 (review of #1448): the daemon fences Linux editors, enforced, only with editorFence true and the write lock on', { skip: !landlockRuns() }, async () => {
  const { Daemon } = await import('../machine/daemon.ts');
  const pick = (Daemon.prototype as unknown as { linuxEditorFence(this: object): ReturnType<typeof linuxEditorFenceFor> }).linuxEditorFence;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w6371-'));
  const self = (editorFence: boolean | undefined, writeLock: string[] | undefined) => ({ cfg: { editorFence, root }, writeLock, lockRules: () => ['--rw', root], lockMemo: undefined });
  assert.equal(pick.call(self(undefined, ['--rw', root])), undefined, 'unset: unfenced');
  assert.equal(pick.call(self(false, ['--rw', root])), undefined);
  assert.equal(pick.call(self(true, undefined)), undefined, 'no write lock: unfenced');
  const on = pick.call(self(true, ['--rw', root]));
  assert.equal(on?.kind, 'landlock');
  assert.equal(on?.warn, false, 'the only opt-in is enforce');
  fs.rmSync(root, { recursive: true, force: true });
});

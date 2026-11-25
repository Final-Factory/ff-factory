// w5630 (w5540 stage 2): macOS sandbox editors start under the workers' Seatbelt profile, warn-only first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { MacUnity, macEditorFenceFor, macLicensingClientBin, warnOnlyProfile, type EditorFence, type Proc, type UnityDeps } from '../machine/unity.ts';
import { SANDBOX_EXEC, seatbeltProfile, type WorkerFence } from './workerFence.ts';

const ROOT = '/Users/u/ffw';
const REPO = `${ROOT}/sandboxes/slot2`;
const BIN = '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity';
const WORKER: WorkerFence = { kind: 'seatbelt', root: ROOT, home: '/Users/u', darwinTemp: '/private/var/folders/x/T', darwinCache: '/private/var/folders/x/C', open: ['sandboxes', 'tmp', 'home'] };

test('w5630: no editor fence while the workers\' Seatbelt fence is off', () => {
  assert.equal(macEditorFenceFor(undefined, 'enforce'), undefined);
});

test('w5630: the enforced editor profile is the workers\' with <root>/home writable; its home and bridge folder are set', () => {
  const f = macEditorFenceFor(WORKER, 'enforce')!;
  assert.equal(f.kind, 'seatbelt');
  assert.equal(f.warn, false);
  assert.equal(f.profile, seatbeltProfile({ ...WORKER, extraWritable: [`${ROOT}/home`] }));
  assert.match(f.profile, /\(deny file-write\*\)/);
  assert.match(f.profile, /\(subpath "\/Users\/u\/ffw\/home"\)/);
  assert.match(f.profile, /\(deny file-write\*\n {2}\(subpath "\/Users\/u\/ffw\/daemon"\)\n {2}\(subpath "\/Users\/u\/ffw\/secrets"\)/, 'the daemon and secrets folders stay read-only');
  assert.deepEqual(f.env, { HOME: `${ROOT}/home`, CFFIXED_USER_HOME: `${ROOT}/home`, UNITY_MCP_STATUS_DIR: `${ROOT}/home/.unity-mcp` });
});

test('w5630: warn-only turns every deny into a reported allow and keeps the rest', () => {
  const enforced = macEditorFenceFor(WORKER, 'enforce')!.profile;
  const warn = macEditorFenceFor(WORKER, 'warn')!;
  assert.equal(warn.warn, true);
  assert.equal(warn.profile, warnOnlyProfile(enforced));
  assert.doesNotMatch(warn.profile, /\(deny /);
  assert.match(warn.profile, /\(allow file-write\* \(with report\)\)/);
  assert.match(warn.profile, /\(allow signal \(with report\)\)/);
  assert.equal(warn.profile.split('\n').length, enforced.split('\n').length, 'line for line');
  assert.equal(warnOnlyProfile('(deny file-write*\n  (subpath "/a"))'), '(allow file-write* (with report)\n  (subpath "/a"))');
});

test('w5630: both profiles compile under sandbox-exec (macOS only)', { skip: process.platform !== 'darwin' || !fs.existsSync(SANDBOX_EXEC) }, () => {
  for (const mode of ['enforce', 'warn'] as const) {
    const r = spawnSync(SANDBOX_EXEC, ['-p', macEditorFenceFor(WORKER, mode)!.profile, '/usr/bin/true'], { encoding: 'utf8' });
    // Inside a worker's own fence sandbox-exec compiles the profile, then cannot apply it (sandbox_apply EPERM): either is fine;
    // a syntax error says "unbound variable" or "syntax" before that.
    assert.ok(r.status === 0 || /sandbox_apply/.test(r.stderr), `${mode}: ${r.stderr}`);
  }
});

function fakeMac(fence: EditorFence | undefined, fenced: boolean, platform: 'darwin' | 'win32' = 'darwin') {
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
    ...(fenced ? { launchFenced: async (f: EditorFence, bin: string, args: string[]) => (world.fenced.push({ fence: f, bin, args }), launchAt(bin, args)) } : {}),
    exists: () => false,
    remove: () => undefined,
    sleep: async (ms) => void (world.now += ms),
    now: () => world.now,
  };
  return { world, u: new MacUnity(REPO, deps, () => BIN, platform, {}, { fence: () => fence }) };
}

test('w5630: a Mac sandbox editor starts through the fenced launch with its own binary and arguments, and says how', async () => {
  const enforce = macEditorFenceFor(WORKER, 'enforce')!;
  const a = fakeMac(enforce, true);
  const said = await a.u.start();
  assert.equal(a.world.plain.length, 0, 'never the unfenced launch');
  assert.equal(a.world.fenced[0].bin, BIN);
  assert.equal(a.world.fenced[0].fence, enforce);
  assert.deepEqual(a.world.fenced[0].args, ['-projectPath', REPO]);
  assert.match(said, /inside the workers' Seatbelt profile/);
  assert.deepEqual(a.u.fenced, { on: true });

  const w = fakeMac(macEditorFenceFor(WORKER, 'warn')!, true);
  assert.match(await w.u.start(), /warn-only/);
  assert.deepEqual(w.u.fenced, { on: true, warn: true });
});

test('w5630: no fenced launcher, no fence (editorFence false or the workers\' fence off), or a Seatbelt fence off a Mac: the editor starts as before', async () => {
  const enforce = macEditorFenceFor(WORKER, 'enforce')!;
  const noLauncher = fakeMac(enforce, false);
  assert.match(await noLauncher.u.start(), /unfenced \(no fenced launcher here\)/);
  assert.deepEqual(noLauncher.world.plain[0], [BIN, '-projectPath', REPO]);

  const off = fakeMac(undefined, true);
  const saidOff = await off.u.start();
  assert.equal(off.world.fenced.length, 0);
  assert.deepEqual(off.world.plain[0], [BIN, '-projectPath', REPO]);
  assert.doesNotMatch(saidOff, /fence|unfenced/);

  const win = fakeMac(enforce, true, 'win32');
  await win.u.start();
  assert.equal(win.world.fenced.length, 0, 'a Seatbelt fence is never used off a Mac');
});

test('w5630: the licensing client starts outside the fence before a fenced editor, and only then; its failure is said, not fatal', async () => {
  assert.equal(macLicensingClientBin(BIN), '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/Helpers/UnityLicensingClient.app/Contents/MacOS/Unity.Licensing.Client');
  const order: string[] = [];
  const a = fakeMac(macEditorFenceFor(WORKER, 'enforce')!, true);
  const fencedLaunch = a.u['d'].launchFenced!;
  a.u['d'].licensingClient = async (bin) => void order.push(`client ${bin}`);
  a.u['d'].launchFenced = async (...xs) => (order.push('editor'), fencedLaunch(...xs));
  await a.u.start();
  assert.deepEqual(order, [`client ${BIN}`, 'editor'], 'the client is up before the fenced editor looks for its channel');

  const b = fakeMac(macEditorFenceFor(WORKER, 'enforce')!, true);
  b.u['d'].licensingClient = async () => {
    throw new Error('spawn EACCES');
  };
  const said = await b.u.start();
  assert.equal(b.world.fenced.length, 1, 'the editor still starts');
  assert.match(said, /could not start Unity's licensing client: spawn EACCES/);

  let asked = 0;
  const off = fakeMac(undefined, true);
  off.u['d'].licensingClient = async () => void asked++;
  await off.u.start();
  assert.equal(asked, 0, 'an unfenced editor starts its own client, as before');
});

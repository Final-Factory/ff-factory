import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRuns, copyNoLinks, inside, runSteamJob, steamEnv, type Runner, type SteamUploadMsg } from './steamUpload.ts';

function tmp(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-steam-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function runFolder(dir: string) {
  fs.mkdirSync(path.join(dir, 'release', 'player'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'release', 'player', 'finalfactory.exe'), 'x');
  fs.writeFileSync(path.join(dir, 'release.json'), '{}');
  fs.writeFileSync(path.join(dir, 'build.log'), 'log');
}

test('steam upload: run folders must be the caller\'s', (t) => {
  const d = tmp(t);
  const mine = path.join(d, 'ffa-me');
  const other = path.join(d, 'ffa-other');
  runFolder(path.join(mine, 'win'));
  runFolder(path.join(other, 'win'));
  fs.mkdirSync(path.join(mine, 'empty'));
  assert.deepEqual(checkRuns({ windows: path.join(mine, 'win') }, [mine]), { windows: path.join(mine, 'win') });
  assert.match(checkRuns({ windows: path.join(other, 'win') }, [mine]) as string, /not inside your sandbox or temp folder/);
  assert.match(checkRuns({ windows: path.join(mine, '..', 'ffa-other', 'win') }, [mine]) as string, /not inside/);
  assert.match(checkRuns({ windows: path.join(mine, 'empty') }, [mine]) as string, /no release\/player/);
  assert.match(checkRuns({ windows: path.join(mine, 'nope') }, [mine]) as string, /does not exist/);
  assert.equal(inside('C:\\A\\b', ['c:\\a'], true), true);
  assert.equal(inside('C:\\A', ['c:\\a'], true), false, 'the root itself is no run folder');
});

test('steam upload: a link in the player is refused', (t) => {
  const d = tmp(t);
  runFolder(path.join(d, 'win'));
  fs.writeFileSync(path.join(d, 'secret.txt'), 's');
  try {
    fs.symlinkSync(path.join(d, 'secret.txt'), path.join(d, 'win', 'release', 'player', 'link.txt'), 'file');
  } catch {
    t.skip('this account cannot make symlinks');
    return;
  }
  assert.throws(() => copyNoLinks(path.join(d, 'win'), path.join(d, 'copy')), /is a link/);
});

test('steam upload: ffsteam gets the job\'s secrets and none of the daemon\'s', () => {
  const before = { GH_TOKEN: process.env.GH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, FFSTEAM_PASSWORD: process.env.FFSTEAM_PASSWORD };
  process.env.GH_TOKEN = 'gh-x';
  process.env.ANTHROPIC_API_KEY = 'ak-x';
  process.env.FFSTEAM_PASSWORD = 'stale';
  try {
    const env = steamEnv('/r', { FFSTEAM_PASSWORD: 'pw', OTHER: 'no' }, 'ABCDE');
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.FFSTEAM_PASSWORD, 'pw');
    assert.equal(env.OTHER, undefined);
    assert.equal(env.FFSTEAM_GUARD_CODE, 'ABCDE');
    assert.equal(env.FFBOX_CONFIG_DIR, path.join('/r', 'steam'));
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('steam upload: a preview copies, checks and runs ffsteam on the copy, then removes it', async (t) => {
  const d = tmp(t);
  const root = path.join(d, 'root');
  fs.mkdirSync(path.join(root, 'steam', 'ffbox', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'steam', 'config.json'), '{}');
  const me = path.join(d, 'ffa-me');
  runFolder(path.join(me, 'win'));
  runFolder(path.join(me, 'mac'));
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: Runner = async (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    if (args.some((a) => a.endsWith('ffrelease-check.py'))) {
      assert.ok(fs.existsSync(path.join(args[2], 'release', 'player', 'finalfactory.exe')), 'the check reads the copy');
      return { code: 0, out: '{"good": true}' };
    }
    return { code: 0, out: 'ok' };
  };
  const sent: { state: string; error?: string }[] = [];
  const msg: SteamUploadMsg = { type: 'steam_upload', id: 'j1', action: 'upload', session: 's', version: '1.0.0.50', app: 'main', runs: { windows: path.join(me, 'win'), mac: path.join(me, 'mac') }, preview: true, secrets: { FFSTEAM_PASSWORD: 'pw' } };
  await runSteamJob(msg, { root, allowedRoots: [me], python: 'py', send: (m) => sent.push(m), log: () => {}, run });
  const last = sent.at(-1)!;
  assert.equal(last.state, 'done', last.error ?? '');
  const up = calls.find((c) => c.args.includes('upload'))!;
  assert.ok(up.args.includes('--preview'));
  assert.ok(!up.args.includes('--setlive-main'));
  assert.ok(up.args[up.args.indexOf('--main-windows') + 1].startsWith(path.join(root, 'steam', 'staging')), 'uploads the copy, not the worker\'s folder');
  assert.equal(up.env.FFSTEAM_PASSWORD, 'pw');
  assert.equal(fs.readdirSync(path.join(root, 'steam', 'staging')).length, 0, 'the copy is removed');
  assert.ok(!fs.existsSync(path.join(root, 'steam', 'job.lock')));

  // Another session's folder, and a live branch other than development, are refused here too.
  sent.length = 0;
  await runSteamJob({ ...msg, id: 'j2' }, { root, allowedRoots: [path.join(d, 'ffa-other')], python: 'py', send: (m) => sent.push(m), log: () => {}, run });
  assert.match(sent.at(-1)!.error!, /none of your folders|not inside/);
  sent.length = 0;
  await runSteamJob({ ...msg, id: 'j3', preview: false, live: 'default' }, { root, allowedRoots: [me], python: 'py', send: (m) => sent.push(m), log: () => {}, run });
  assert.match(sent.at(-1)!.error!, /refusing to set default live/);
});

test('steam upload: no fence lets a worker write steamcmd\'s folder (w5551)', async () => {
  const { MEDIUM_CHILDREN, WORKER_CHILDREN } = await import('./lowIntegrity.ts');
  const { LOCKED_CHILDREN, writeLockArgs } = await import('./writeLock.ts');
  const { READ_ONLY_IN_ROOT } = await import('../server/workerFence.ts');
  assert.ok(!MEDIUM_CHILDREN.includes('steam'), 'Windows: not left alone, so a Low label from before is made Medium');
  assert.ok(!WORKER_CHILDREN.includes('steam'), 'Windows: never labelled Low');
  assert.ok((LOCKED_CHILDREN as readonly string[]).includes('steam'), 'Linux: Landlock leaves it unwritable');
  const root = path.resolve('/home/u/ffw');
  const args = writeLockArgs({ root, workFolders: [path.join(root, 'steam', 'x')] });
  assert.ok(!args.some((a) => a === path.join(root, 'steam') || a.startsWith(path.join(root, 'steam') + path.sep)), 'Linux: no write grant reaches it');
  assert.ok(READ_ONLY_IN_ROOT.subpaths.includes('steam'), 'macOS: Seatbelt keeps it read-only');
});

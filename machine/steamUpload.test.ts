import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRuns, copyNoLinks, inside, installSteamcmd, runSteamJob, steamEnv, steamMissing, steamcmdExe, type Runner, type SteamUploadMsg } from './steamUpload.ts';

function tmp(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-steam-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A computer set up for ffsteam: steamcmd there, config.json naming it and an account. */
function setUp(root: string) {
  const exe = steamcmdExe(root);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'x');
  fs.writeFileSync(path.join(root, 'steam', 'config.json'), JSON.stringify({ release: { steam: { account: 'acct_one', steamcmd: exe } } }));
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
  setUp(root);
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

// w5640: a new urgent-lane computer sets itself up; no worker may write <root>/steam, so urgent_release.py steam-install cannot.
const ACCT = 'build_acct_7';
/** A runner and a download that act like Valve's: tar unpacks the exe, its first run exits 7 (an update). */
function fakeValve() {
  const calls: { cmd: string; args: string[] }[] = [];
  const downloads: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === '-xf') {
      fs.writeFileSync(path.join(args[3], path.basename(steamcmdExe('/r'))), 'steamcmd');
      return { code: 0, out: '' };
    }
    if (args[0] === '+quit') return { code: 7, out: `Logging in user '${ACCT}' ... no` };
    if (args.some((a) => a.endsWith('ffsteam.py'))) return { code: 0, out: `steam login: ok as ${ACCT}` };
    if (args.includes('-c')) return { code: 0, out: '{"main": ["linux", "mac", "windows"]}' };
    return { code: 0, out: '' };
  };
  const download = async (url: string, file: string) => {
    downloads.push(url);
    fs.writeFileSync(file, 'archive');
  };
  return { calls, downloads, run, download };
}
const readCfg = (root: string) => JSON.parse(fs.readFileSync(path.join(root, 'steam', 'config.json'), 'utf8')) as { other?: number; release: { steam: Record<string, string> } };

test('steam install: a fresh computer gets steamcmd and config.json with the portal account, never said back', async (t) => {
  const root = path.join(tmp(t), 'root');
  const v = fakeValve();
  const sent: { state: string; error?: string; said?: string; result?: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const msg: SteamUploadMsg = { type: 'steam_upload', id: 'i1', action: 'install', session: 's', secrets: {}, account: ACCT };
  await runSteamJob(msg, { root, allowedRoots: [], python: 'py', send: (m) => sent.push(m), log: (l) => logs.push(l), run: v.run, download: v.download });
  const last = sent.at(-1)!;
  assert.equal(last.state, 'done', last.error ?? '');
  assert.equal(v.downloads.length, 1);
  assert.match(v.downloads[0], /^https:\/\/steamcdn-a\.akamaihd\.net\/client\/installer\/steamcmd/);
  assert.deepEqual(readCfg(root).release.steam, { account: ACCT, steamcmd: steamcmdExe(root), home: path.join(root, 'steam', 'home') });
  assert.equal(steamMissing(root), undefined);
  assert.deepEqual(fs.readdirSync(path.join(root, 'steam')).sort(), ['config.json', 'steamcmd'], 'the archive and the lock are gone');
  assert.ok(!v.calls.some((c) => c.args.some((a) => a.endsWith('ffsteam.py'))), 'install logs nobody in');
  assert.ok(!JSON.stringify([sent, logs]).includes(ACCT), 'the account is never said back');

  // Again: steamcmd is there, so nothing is fetched; the account follows the setting; other config keys stay.
  fs.writeFileSync(path.join(root, 'steam', 'config.json'), JSON.stringify({ ...readCfg(root), other: 1 }));
  await installSteamcmd(root, 'acct_two', v.run, { download: v.download });
  assert.equal(v.downloads.length, 1);
  assert.equal(readCfg(root).other, 1);
  assert.equal(readCfg(root).release.steam.account, 'acct_two');
  // No setting: the account config.json names already is kept.
  await installSteamcmd(root, undefined, v.run, { download: v.download });
  assert.equal(readCfg(root).release.steam.account, 'acct_two');
});

test('steam install: no account in the setting or config.json installs nothing, and a bad name is refused', async (t) => {
  const root = path.join(tmp(t), 'root');
  const v = fakeValve();
  const sent: { state: string; error?: string }[] = [];
  await runSteamJob({ type: 'steam_upload', id: 'i2', action: 'install', session: 's', secrets: {} }, { root, allowedRoots: [], python: 'py', send: (m) => sent.push(m), log: () => {}, run: v.run, download: v.download });
  assert.equal(sent.at(-1)!.state, 'failed');
  assert.match(sent.at(-1)!.error!, /steamBuildAccount/);
  assert.equal(v.downloads.length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'steam', 'steamcmd')));
  await assert.rejects(installSteamcmd(root, 'a b; rm', v.run, { download: v.download }), /not a Steam account name/);
  await assert.rejects(installSteamcmd(root, ACCT, v.run, { download: v.download, platform: 'aix' }), /no steamcmd for aix/);
});

test('steam check: the account config.json names is not said back when the portal sends none', async (t) => {
  const root = path.join(tmp(t), 'root');
  setUp(root);
  const run: Runner = async (_cmd, args) => {
    if (args.some((a) => a.endsWith('ffsteam.py'))) return { code: 0, out: 'ffsteam: acct_one logs in.' };
    if (args.includes('-c')) return { code: 0, out: '{"main": ["windows"]}' };
    return { code: 0, out: '' };
  };
  const sent: { state: string; error?: string }[] = [];
  await runSteamJob({ type: 'steam_upload', id: 'c0', action: 'check', session: 's', secrets: { FFSTEAM_PASSWORD: 'pw' } }, { root, allowedRoots: [], python: 'py', send: (m) => sent.push(m), log: () => {}, run });
  assert.equal(sent.at(-1)!.state, 'done', sent.at(-1)!.error ?? '');
  assert.ok(!JSON.stringify(sent).includes('acct_one'), JSON.stringify(sent));
});

test('steam install: a check on a fresh computer sets it up first, then logs in', async (t) => {
  const root = path.join(tmp(t), 'root');
  const v = fakeValve();
  const sent: { state: string; phase?: string; error?: string; result?: Record<string, unknown> }[] = [];
  await runSteamJob({ type: 'steam_upload', id: 'c1', action: 'check', session: 's', secrets: { FFSTEAM_PASSWORD: 'pw' }, account: ACCT }, { root, allowedRoots: [], python: 'py', send: (m) => sent.push(m), log: () => {}, run: v.run, download: v.download });
  const last = sent.at(-1)!;
  assert.equal(last.state, 'done', last.error ?? '');
  assert.deepEqual([...new Set(sent.map((m) => m.phase).filter(Boolean))], ['installing steamcmd', 'ffbox', 'login check']);
  assert.deepEqual(last.result, { exit: 0, depots: { main: ['linux', 'mac', 'windows'] } });
  assert.equal(v.downloads.length, 1);
  const login = v.calls.findIndex((c) => c.args.some((a) => a.endsWith('ffsteam.py')));
  assert.ok(login > v.calls.findIndex((c) => c.args[0] === '+quit'), 'the login runs after the install');
});

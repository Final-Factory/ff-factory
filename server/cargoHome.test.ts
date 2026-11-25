import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootEnv } from '../machine/daemon.ts';
import { realFfuSlotDeps } from '../machine/ffuSlots.ts';
import { lowTargets } from '../machine/lowIntegrity.ts';
import { writeLockArgs } from '../machine/writeLock.ts';
import { CARGO_SEED_PIECES, seedCargoHome, workerCargoHome, workerCargoHomeDir } from '../machine/sharedCaches.ts';

// w5501: the machine's cargo home moves inside the install folder, where every fence lets a worker write, so a fenced
// worker's `cargo fetch` of a new crate works (BEAST: "Access is denied (os error 5)" in the person's ~/.cargo on C:).

test('w5501: a CARGO_HOME outside the root moves to <root>/cache/cargo and is seeded from the old one (Windows paths)', () => {
  const w = path.win32;
  const root = 'F:\\ffw';
  assert.deepEqual(workerCargoHome(root, {}, 'C:\\Users\\ben', w), { home: 'F:\\ffw\\cache\\cargo', seedFrom: 'C:\\Users\\ben\\.cargo' }, 'unset: cargo used ~/.cargo');
  assert.deepEqual(workerCargoHome(root, { CARGO_HOME: 'D:\\rust\\cargo' }, 'C:\\Users\\ben', w), { home: 'F:\\ffw\\cache\\cargo', seedFrom: 'D:\\rust\\cargo' });
  // LothDesktop: already inside the root, in a folder workers write (any case).
  assert.deepEqual(workerCargoHome('V:\\ffw', { CARGO_HOME: 'v:/FFW/tools/cargo' }, 'C:\\Users\\l', w, () => true), { home: 'v:\\FFW\\tools\\cargo' });
  // w5717: tools is Medium, so a Low worker cannot make it again once deleted: a missing one moves to cache/cargo.
  assert.deepEqual(workerCargoHome('V:\\ffw', { CARGO_HOME: 'V:\\ffw\\tools\\cargo' }, 'C:\\Users\\l', w, () => false), { home: 'V:\\ffw\\cache\\cargo', seedFrom: 'V:\\ffw\\tools\\cargo' });
  // Inside the root but in a folder a Low worker cannot write (the runners' Medium folder, the daemon's, the secrets): moves.
  for (const c of ['ffu-runners\\cargo', 'daemon\\cargo', 'secrets\\cargo']) {
    const r = workerCargoHome(root, { CARGO_HOME: `F:\\ffw\\${c}` }, 'C:\\Users\\ben', w);
    assert.equal(r.home, 'F:\\ffw\\cache\\cargo', c);
    assert.equal(r.seedFrom, `F:\\ffw\\${c}`, c);
  }
  // Already the new one (a daemon restarted by its own updater inherits it): kept, nothing to seed.
  assert.deepEqual(workerCargoHome(root, { CARGO_HOME: 'F:\\ffw\\cache\\cargo' }, 'C:\\Users\\ben', w), { home: 'F:\\ffw\\cache\\cargo' });
});

test('w5501: the same on macOS and Linux', () => {
  const p = path.posix;
  assert.deepEqual(workerCargoHome('/Users/b/ffw', {}, '/Users/b', p), { home: '/Users/b/ffw/cache/cargo', seedFrom: '/Users/b/.cargo' });
  assert.deepEqual(workerCargoHome('/home/b/ffw', { CARGO_HOME: '/home/b/ffw/tools/cargo' }, '/home/b', p, () => true), { home: '/home/b/ffw/tools/cargo' });
  assert.deepEqual(workerCargoHome('/home/b/ffw', { CARGO_HOME: '/home/b/ffw-other/cargo' }, '/home/b', p), { home: '/home/b/ffw/cache/cargo', seedFrom: '/home/b/ffw-other/cargo' }, 'a sibling with the root as a prefix is outside it');
});

test('w5501: the daemon, ffu-slot take and the fences agree the cargo home is inside the root and writable', () => {
  const root = path.resolve('/ffw-root');
  for (const platform of ['win32', 'darwin', 'linux'] as const) assert.equal(rootEnv(root, platform).CARGO_HOME, workerCargoHomeDir(root), platform);
  assert.equal(realFfuSlotDeps({ FF_WORKER_ROOT: root }).cargoHome, workerCargoHomeDir(root));
  assert.equal(realFfuSlotDeps({ FF_WORKER_ROOT: root, CARGO_HOME: path.join(root, 'tools', 'cargo') }).cargoHome, path.join(root, 'tools', 'cargo'));
  // Windows: `cache`, its parent, is a root child the daemon labels Low (OI)(CI), so the cargo home inherits Low.
  const t = lowTargets({ root, appDir: path.join(root, 'daemon'), children: ['cache', 'daemon', 'secrets', 'ffu-runners', 'tools'].map((name) => ({ name, dir: true })) });
  assert.ok(t.dirs.includes(path.join(root, 'cache')), 'cache is labelled Low');
  assert.ok(!t.dirs.includes(path.join(root, 'ffu-runners')), 'the runners stay Medium, so a CARGO_HOME there is moved');
  // Linux Landlock: `cache` is one of the root folders workers write (w5569).
  const args = writeLockArgs({ root });
  assert.ok(args.includes(path.join(root, 'cache')), 'cache is writable');
  assert.ok(!args.includes(path.join(root, 'ffu-runners')), 'the runners are not');
});

function tree(t: { after: (fn: () => void) => void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w5501-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const from = path.join(base, 'home', '.cargo');
  const put = (rel: string, text: string) => {
    const f = path.join(from, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  put('registry/index/index.crates.io-1949cf8c6b5b557f/.cache/se/rd/serde', 'index');
  put('registry/cache/index.crates.io-1949cf8c6b5b557f/serde-1.0.0.crate', 'crate');
  put('registry/src/index.crates.io-1949cf8c6b5b557f/serde-1.0.0/lib.rs', 'src');
  put('git/db/foo-abc/HEAD', 'ref');
  put('config.toml', '[net]\ngit-fetch-with-cli = true\n');
  put('credentials.toml', 'token = "secret"\n');
  put('bin/cargo-sweep', 'tool');
  return { base, from, to: path.join(base, 'ffw', 'cache', 'cargo') };
}

/** Every file under a folder with its size and mtime: the old home must read the same after a seed. */
function snapshot(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]).map((e) => {
    const f = path.join(e.parentPath, e.name);
    const s = fs.statSync(f);
    return `${path.relative(dir, f)} ${s.isDirectory() ? 'd' : s.size} ${s.mtimeMs}`;
  }).sort();
}

test('w5501: a seed copies the registry, git clones and config, never bin, src or credentials, and only reads the old home', async (t) => {
  const { from, to } = tree(t);
  const before = snapshot(from);
  fs.mkdirSync(to, { recursive: true });
  const msg = await seedCargoHome(from, to);
  assert.match(msg, /seeded registry\/index, registry\/cache, git\/db, config\.toml from/);
  assert.equal(fs.readFileSync(path.join(to, 'registry/cache/index.crates.io-1949cf8c6b5b557f/serde-1.0.0.crate'), 'utf8'), 'crate');
  assert.ok(fs.existsSync(path.join(to, 'registry/index/index.crates.io-1949cf8c6b5b557f/.cache/se/rd/serde')));
  assert.ok(fs.existsSync(path.join(to, 'git/db/foo-abc/HEAD')));
  assert.ok(fs.existsSync(path.join(to, 'config.toml')));
  for (const no of ['credentials.toml', 'bin', 'registry/src', '.seed']) assert.ok(!fs.existsSync(path.join(to, no)), `${no} is not copied`);
  assert.deepEqual(snapshot(from), before, 'nothing in the old home was written, moved or deleted');
  assert.ok(!CARGO_SEED_PIECES.some((p) => p[0] === 'bin' || p[0].startsWith('credentials')));
  // Run again (every daemon start): nothing to do.
  assert.match(await seedCargoHome(from, to), /nothing to seed/);
});

test('w5501: a piece cargo already made in the new home is kept, and a copy that loses the race is dropped', async (t) => {
  const { from, to } = tree(t);
  fs.mkdirSync(path.join(to, 'registry', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(to, 'registry', 'cache', 'mine'), 'worker');
  // registry/index appears while its copy runs: the worker's stays, the copy goes.
  const cp = async (a: string, b: string) => {
    await fs.promises.cp(a, b, { recursive: true });
    if (a.endsWith(path.join('registry', 'index'))) fs.mkdirSync(path.join(to, 'registry', 'index', 'theirs'), { recursive: true });
  };
  const msg = await seedCargoHome(from, to, { cp });
  assert.ok(!/registry\/cache|registry\/index/.test(msg), msg);
  assert.deepEqual(fs.readdirSync(path.join(to, 'registry', 'cache')), ['mine']);
  assert.deepEqual(fs.readdirSync(path.join(to, 'registry', 'index')), ['theirs']);
  assert.ok(!fs.existsSync(path.join(to, '.seed')));
});

test('w5501: a seed never runs between nested homes, and a copy that fails is said, not thrown', async (t) => {
  const { from, to } = tree(t);
  assert.match(await seedCargoHome(from, path.join(from, 'cache')), /one holds the other/);
  assert.match(await seedCargoHome(to, path.dirname(to)), /one holds the other/);
  assert.ok(!fs.existsSync(path.join(from, 'cache')));
  const msg = await seedCargoHome(from, to, { cp: async () => { throw new Error('EACCES: permission denied'); } });
  assert.match(msg, /could not copy registry\/index \(EACCES/);
  assert.ok(!fs.existsSync(path.join(to, 'registry', 'index')));
});

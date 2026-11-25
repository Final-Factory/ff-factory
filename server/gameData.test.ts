import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildReadsGameDataDir, exeReadsGameDataDir, gameDataRoots, legacyGameDataRoot, sandboxGameDataDir, sandboxGameDataDirs, sandboxGameDataEnv, playerHomeEnv, preparePlayerHome, savesDirsFor, workerGameDataDir, workerPlayerHomeDir } from '../machine/gameData.ts';
import { rootEnv } from '../machine/daemon.ts';

test('w5306: the game data roots, the override first; the old root per OS as GameDataPaths.ResolveRoot has it', () => {
  assert.equal(workerGameDataDir('/ffw'), path.join('/ffw', 'gamedata'));
  assert.match(legacyGameDataRoot('win32', 'C:/Users/x'), /AppData[\\/]LocalLow[\\/]Never Games[\\/]finalfactory$/);
  assert.match(legacyGameDataRoot('darwin', '/Users/x'), /Library[\\/]Application Support[\\/]Never Games[\\/]finalfactory$/);
  assert.match(legacyGameDataRoot('linux', '/home/x'), /\.config[\\/]unity3d[\\/]Never Games[\\/]finalfactory$/);
  assert.deepEqual(gameDataRoots({ FF_GAME_DATA_DIR: '/ffw/gamedata' }, 'linux', '/home/x'), ['/ffw/gamedata', legacyGameDataRoot('linux', '/home/x')]);
  assert.deepEqual(gameDataRoots({}, 'linux', '/home/x'), [legacyGameDataRoot('linux', '/home/x')]);
});

test('w5306: a build reads FF_GAME_DATA_DIR when its FFCore.dll carries the literal (UTF-16, Mono) or its IL2CPP metadata does (UTF-8)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gamedata-build-'));
  const managed = path.join(d, 'finalfactory_Data', 'Managed');
  fs.mkdirSync(managed, { recursive: true });
  assert.equal(buildReadsGameDataDir(d), undefined, 'no code file: unknown');
  fs.writeFileSync(path.join(managed, 'FFCore.dll'), Buffer.concat([Buffer.from('MZ junk'), Buffer.from('FF_SOMETHING_ELSE', 'utf16le')]));
  assert.equal(buildReadsGameDataDir(d), false, 'a build from before game PR #4237');
  fs.writeFileSync(path.join(managed, 'FFCore.dll'), Buffer.concat([Buffer.from('MZ junk'), Buffer.from('FF_GAME_DATA_DIR', 'utf16le'), Buffer.from('tail')]));
  assert.equal(buildReadsGameDataDir(d), true);
  const il = fs.mkdtempSync(path.join(os.tmpdir(), 'gamedata-il2cpp-'));
  fs.mkdirSync(path.join(il, 'finalfactory_Data', 'il2cpp_data', 'Metadata'), { recursive: true });
  fs.writeFileSync(path.join(il, 'finalfactory_Data', 'il2cpp_data', 'Metadata', 'global-metadata.dat'), Buffer.from('xxFF_GAME_DATA_DIRyy'));
  assert.equal(buildReadsGameDataDir(il), true);
});

test('w5306: a timed run puts its save where each build loads it: the override for a new build, the old folder for an old one, both when unknown', () => {
  const env = { FF_GAME_DATA_DIR: 'V:/ffw/gamedata' };
  const home = 'C:/Users/loth';
  const fresh = path.join('V:/ffw/gamedata', 'UserData', 'saves');
  const old = path.join(legacyGameDataRoot('win32', home), 'UserData', 'saves');
  const reads = (m: Record<string, boolean | undefined>) => (d: string) => m[d];
  assert.deepEqual(savesDirsFor(['b0'], env, 'win32', home, reads({ b0: true })), [fresh]);
  assert.deepEqual(savesDirsFor(['b0'], env, 'win32', home, reads({ b0: false })), [old]);
  assert.deepEqual(savesDirsFor(['b0', 'b1'], env, 'win32', home, reads({ b0: true, b1: false })), [fresh, old], 'an A/B of an old and a new build');
  assert.deepEqual(savesDirsFor(['b0'], env, 'win32', home, reads({})), [fresh, old], 'unknown: both');
  assert.deepEqual(savesDirsFor(['b0'], {}, 'win32', home, reads({ b0: true })), [old], 'no override set: the old folder');
});

test('w5344: a player gets a home of its own under FF_PLAYER_HOME (Linux XDG_CONFIG_HOME, macOS CFFIXED_USER_HOME), never HOME', () => {
  const root = '/ffw';
  const env = rootEnv(root, 'linux');
  assert.equal(env.FF_PLAYER_HOME, workerPlayerHomeDir(root));
  assert.equal(env.FF_PLAYER_HOME, path.join(root, 'gamedata-home'));
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'CFFIXED_USER_HOME']) assert.equal(env[k], undefined, `${k} is not set for the whole worker`);
  const given = { FF_PLAYER_HOME: '/ffw/gamedata-home', FF_GAME_DATA_DIR: '/ffw/gamedata', HOME: '/home/w' };
  assert.deepEqual(playerHomeEnv(given, true, 'linux'), { XDG_CONFIG_HOME: '/ffw/gamedata-home/config' });
  assert.deepEqual(playerHomeEnv(given, true, 'darwin'), { CFFIXED_USER_HOME: '/ffw/gamedata-home' });
  assert.deepEqual(playerHomeEnv({ ...given, FF_PLAYER_HOME: 'V:\ffw\gamedata-home' }, true, 'win32'), {}, 'nothing moves HKCU');
  // an older build keeps its data root under the home, where savesDirsFor and the live view look: unchanged, as is an unknown one
  assert.deepEqual(playerHomeEnv(given, false, 'linux'), {});
  assert.deepEqual(playerHomeEnv(given, undefined, 'linux'), {});
  assert.deepEqual(playerHomeEnv({ ...given, FF_GAME_DATA_DIR: ' ' }, true, 'linux'), {});
  assert.deepEqual(playerHomeEnv({ ...given, FF_PLAYER_HOME: undefined }, true, 'linux'), {});
  assert.deepEqual(playerHomeEnv({ ...given, XDG_CONFIG_HOME: '/tour' }, true, 'linux'), {}, "a caller's own stays");
});

test('w5344: the build of an exe reads FF_GAME_DATA_DIR from its folder or a Mac .app; preparePlayerHome makes the folders', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w5344-'));
  try {
    const managed = path.join(d, 'win', 'finalfactory_Data', 'Managed');
    fs.mkdirSync(managed, { recursive: true });
    fs.writeFileSync(path.join(managed, 'FFCore.dll'), Buffer.concat([Buffer.from('MZ'), Buffer.from('FF_GAME_DATA_DIR', 'utf16le')]));
    assert.equal(exeReadsGameDataDir(path.join(d, 'win', 'finalfactory.exe')), true);
    const mac = path.join(d, 'finalfactory.app', 'Contents', 'Resources', 'Data', 'Managed');
    fs.mkdirSync(mac, { recursive: true });
    fs.writeFileSync(path.join(mac, 'FFCore.dll'), Buffer.from('MZ older build'));
    assert.equal(exeReadsGameDataDir(path.join(d, 'finalfactory.app', 'Contents', 'MacOS', 'finalfactory')), false);
    assert.equal(exeReadsGameDataDir(path.join(d, 'none', 'x.exe')), undefined);
    const home = path.join(d, 'gamedata-home');
    preparePlayerHome({ XDG_CONFIG_HOME: path.join(home, 'config') });
    assert.ok(fs.statSync(path.join(home, 'config')).isDirectory());
    const real = path.join(d, 'real');
    fs.mkdirSync(path.join(real, 'Library', 'Application Support', 'Steam'), { recursive: true });
    preparePlayerHome({ CFFIXED_USER_HOME: home }, real);
    assert.ok(fs.statSync(path.join(home, 'Library', 'Preferences')).isDirectory());
    if (process.platform !== 'win32') assert.ok(fs.lstatSync(path.join(home, 'Library', 'Application Support', 'Steam')).isSymbolicLink());
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('w5557: each sandbox keeps its game data in a folder of its own under the override; none without it', () => {
  const base = path.join('V:', 'ffw', 'gamedata');
  assert.equal(sandboxGameDataDir(base, 'slot3'), path.join(base, 'sandboxes', 'slot3'));
  assert.equal(sandboxGameDataDir(base, '../x'), path.join(base, 'sandboxes', '.._x'), 'a sandbox id never leads out of the folder');
  assert.deepEqual(sandboxGameDataEnv({ FF_GAME_DATA_DIR: ` ${base} ` }, 'slot3'), { FF_GAME_DATA_DIR: path.join(base, 'sandboxes', 'slot3') });
  assert.deepEqual(sandboxGameDataEnv({}, 'slot3'), {}, 'no override: the game keeps its own default, nothing is invented');
  assert.deepEqual(sandboxGameDataEnv({ FF_GAME_DATA_DIR: base }, undefined), {}, 'no sandbox: the machine root as it is');
  const list = (d: string) => (d === path.join(base, 'sandboxes') ? ['slot1', 'slot3'] : []);
  assert.deepEqual(sandboxGameDataDirs(base, list), [path.join(base, 'sandboxes', 'slot1'), path.join(base, 'sandboxes', 'slot3')]);
  const home = path.join('C:', 'Users', 'p');
  assert.deepEqual(gameDataRoots({ FF_GAME_DATA_DIR: base }, 'win32', home, list), [base, path.join(base, 'sandboxes', 'slot1'), path.join(base, 'sandboxes', 'slot3'), legacyGameDataRoot('win32', home)]);
});

test('w5579: every worker folder rootEnv puts in the root is one the Landlock and Seatbelt fences open (WORKER_CHILDREN)', async () => {
  const { WORKER_CHILDREN } = await import('../machine/lowIntegrity.ts');
  const root = path.resolve('/ffw');
  // UV_CACHE_DIR is the daemon's and Medium agents' own cache (w5565), closed to workers on purpose; FF_WORKER_ROOT is the root.
  for (const platform of ['linux', 'darwin'] as const) {
    for (const [k, v] of Object.entries(rootEnv(root, platform))) {
      if (k === 'FF_WORKER_ROOT' || k === 'UV_CACHE_DIR') continue;
      const rel = path.relative(root, v);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      assert.ok(WORKER_CHILDREN.includes(rel.split(/[\\/]/)[0]), `${k}=${v} (${platform}): its root folder is not in WORKER_CHILDREN`);
    }
  }
});

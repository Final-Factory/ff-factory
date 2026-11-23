import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildReadsGameDataDir, gameDataRoots, legacyGameDataRoot, savesDirsFor, workerGameDataDir } from '../machine/gameData.ts';

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

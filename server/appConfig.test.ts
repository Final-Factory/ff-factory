import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSetting, setAppConfig } from './appConfig.ts';
import type { Config } from './config.ts';

const setup = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  // As PowerShell writes it: a byte order mark, other keys that must survive untouched.
  fs.writeFileSync(file, '﻿' + JSON.stringify({ port: 8790, limits: { maxUnity: 3 }, voice: { device: 'auto' } }, null, 2));
  const cfg = { ownerName: undefined, voice: { vocabulary: [], ttsVoice: 'af_heart', device: 'auto' } } as unknown as Config;
  return { file, cfg };
};

test('set_app_config: writes the key, keeps the rest and the old file, applies it live', (t) => {
  const { file, cfg } = setup(t);
  assert.deepEqual(setAppConfig(file, cfg, 'ownerName', '  Sam   Lee '), { before: undefined, after: 'Sam Lee' });
  assert.equal(cfg.ownerName, 'Sam Lee');
  setAppConfig(file, cfg, 'voice.vocabulary', 'Belt, Splitter, , Belt');
  assert.deepEqual(cfg.voice.vocabulary, ['Belt', 'Splitter']);
  setAppConfig(file, cfg, 'voice.ttsVoice', 'bm_george');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { port: 8790, limits: { maxUnity: 3 }, voice: { device: 'auto', vocabulary: ['Belt', 'Splitter'], ttsVoice: 'bm_george' }, ownerName: 'Sam Lee' });
  assert.ok(fs.existsSync(file + '.prev'));
  // null removes it again: back to the default.
  assert.deepEqual(setAppConfig(file, cfg, 'voice.ttsVoice', null), { before: 'bm_george', after: undefined });
  assert.equal(cfg.voice.ttsVoice, 'af_heart');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).voice.ttsVoice, undefined);
});

test('set_app_config: only the allowlisted keys, only sane values', (t) => {
  const { file, cfg } = setup(t);
  for (const key of ['protectedPaths', 'worker.permissionMode', 'limits.maxSessions', 'claudeEnv', 'host']) {
    assert.throws(() => setAppConfig(file, cfg, key as never, 'x'), /cannot be changed/);
  }
  assert.throws(() => normalizeSetting('ownerName', 'a'.repeat(61)));
  assert.throws(() => normalizeSetting('ownerName', 'x ${process.env.X}'));
  assert.throws(() => normalizeSetting('ownerName', 42));
  assert.throws(() => normalizeSetting('voice.ttsVoice', '../../evil'));
  assert.throws(() => normalizeSetting('voice.vocabulary', Array.from({ length: 61 }, (_, i) => `w${i}`)));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').slice(1)).port, 8790, 'refused changes leave the file alone');
});

test('set_app_config: the public commit identity', (t) => {
  const { file, cfg } = setup(t);
  setAppConfig(file, cfg, 'publicGitIdentity.email', ' 12345+someone@users.noreply.github.com ');
  setAppConfig(file, cfg, 'publicGitIdentity.name', 'Some Team');
  assert.deepEqual(cfg.publicGitIdentity, { email: '12345+someone@users.noreply.github.com', name: 'Some Team' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).publicGitIdentity, { email: '12345+someone@users.noreply.github.com', name: 'Some Team' });
  assert.throws(() => normalizeSetting('publicGitIdentity.email', 'not an email'));
  assert.throws(() => normalizeSetting('publicGitIdentity.name', 'a "quoted" name'));
});

// The host guard's paths are Windows paths (drive letters, a Dev Drive .vhdx): on Linux "C:/..." is not absolute.
test('set_app_config: host guard housekeeping, with age rules kept away from anything that matters', { skip: process.platform !== 'win32' && 'Windows only' }, (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg, protectedPaths: ['C:/live/game'], sandboxRoot: 'F:/ffsb', standingRoot: 'F:/ffsb/_agents', dataDir: 'C:/app/data', repo: { basePath: 'C:/ffsb/_base' }, hostGuard: { devDriveVhdx: '', compactWhenReclaimGB: 0, cleanup: { ageRules: [] } } } as unknown as Config;
  setAppConfig(file, full, 'hostGuard.devDriveVhdx', 'C:/ffsb-devdrive.vhdx');
  assert.throws(() => setAppConfig(file, full, 'hostGuard.compactWhenReclaimGB' as never, '60'), /not|allowed|unknown/i, 'compaction is manual only');
  setAppConfig(file, full, 'hostGuard.cleanup.ageRules', '[{"path":"C:/Users/u/AppData/LocalLow/Studio/game/DeterminismAudit","olderThanDays":14}]');
  assert.equal(full.hostGuard.devDriveVhdx, 'C:/ffsb-devdrive.vhdx');
  assert.equal(full.hostGuard.compactWhenReclaimGB, 0);
  assert.deepEqual(full.hostGuard.cleanup.ageRules, [{ path: 'C:/Users/u/AppData/LocalLow/Studio/game/DeterminismAudit', olderThanDays: 14 }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hostGuard.cleanup.ageRules[0].olderThanDays, 14);
  for (const bad of [
    [{ path: 'C:/', olderThanDays: 30 }],
    [{ path: os.homedir(), olderThanDays: 30 }],
    [{ path: 'F:/ffsb/sb1', olderThanDays: 30 }],
    [{ path: 'C:/live', olderThanDays: 30 }],
    [{ path: 'relative/dir', olderThanDays: 30 }],
    [{ path: 'C:/Users/u/old-builds', olderThanDays: 1 }],
  ]) {
    assert.throws(() => normalizeSetting('hostGuard.cleanup.ageRules', bad, full), Error, JSON.stringify(bad));
  }
  assert.throws(() => normalizeSetting('hostGuard.devDriveVhdx', 'C:/not-a-disk.txt'));
});

test('app config: limits.maxUnity caps editors at once, live, 1 to 8', (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg, limits: { maxUnity: 3, maxSessions: 6 } } as unknown as Config;
  setAppConfig(file, full, 'limits.maxUnity', '2');
  assert.equal(full.limits.maxUnity, 2, 'applies at once');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).limits.maxUnity, 2);
  for (const bad of ['0', '9', '2.5', 'two']) assert.throws(() => setAppConfig(file, full, 'limits.maxUnity', bad), /1 to 8/, bad);
  setAppConfig(file, full, 'limits.maxUnity', null);
  assert.equal(full.limits.maxUnity, 3, 'null: back to the default');
});

test('app config: publicUrl (the portal address machines and the outside watchdog use)', (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg } as unknown as Config;
  setAppConfig(file, full, 'publicUrl', 'https://beast.tailedfcad.ts.net/');
  assert.equal(full.publicUrl, 'https://beast.tailedfcad.ts.net', 'applies at once, without the trailing slash');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).publicUrl, 'https://beast.tailedfcad.ts.net');
  for (const bad of ['beast.tailedfcad.ts.net', 'https://beast.tailedfcad.ts.net/api', 'ftp://x']) assert.throws(() => setAppConfig(file, full, 'publicUrl', bad), /base URL/, bad);
});

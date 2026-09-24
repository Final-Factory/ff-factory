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
  for (const key of ['protectedPaths', 'worker.permissionMode', 'limits.maxUnity', 'claudeEnv', 'host']) {
    assert.throws(() => setAppConfig(file, cfg, key as never, 'x'), /cannot be changed/);
  }
  assert.throws(() => normalizeSetting('ownerName', 'a'.repeat(61)));
  assert.throws(() => normalizeSetting('ownerName', 'x ${process.env.X}'));
  assert.throws(() => normalizeSetting('ownerName', 42));
  assert.throws(() => normalizeSetting('voice.ttsVoice', '../../evil'));
  assert.throws(() => normalizeSetting('voice.vocabulary', Array.from({ length: 61 }, (_, i) => `w${i}`)));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').slice(1)).port, 8790, 'refused changes leave the file alone');
});

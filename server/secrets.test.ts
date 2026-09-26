import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskSecret, redactSecrets, scrubTranscripts } from './secrets.ts';
import { setAppConfig } from './appConfig.ts';
import { Store, bus } from './store.ts';
import type { Config } from './config.ts';

const TOKEN = `sk-ant-oat01-${'Ab3_-'.repeat(10)}XyZ9`;

test('secrets: the OAuth token is set write-only and never read back', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 1, claudeEnv: { OTHER: 'x' } }));
  const cfg = { claudeEnv: { OTHER: 'x' } } as unknown as Config;
  const r = setAppConfig(file, cfg, 'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN', TOKEN);
  assert.deepEqual(r, { before: 'not set', after: 'set (…XyZ9)' });
  assert.equal(cfg.claudeEnv?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN, 'new sessions get it');
  assert.equal(cfg.claudeEnv?.OTHER, 'x');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeEnv.CLAUDE_CODE_OAUTH_TOKEN, TOKEN, 'written to config.json');
  // A second one: both sides masked.
  const again = setAppConfig(file, cfg, 'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN', TOKEN.replace('XyZ9', 'QQQQ'));
  assert.deepEqual(again, { before: 'set (…XyZ9)', after: 'set (…QQQQ)' });
  // Not a token: refused, and the error does not echo it.
  for (const bad of ['sk-ant-api03-abc', 'sk-ant-oat01-short', `${TOKEN} extra`]) {
    assert.throws(
      () => setAppConfig(file, cfg, 'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN', bad),
      (e: Error) => /must be a Claude OAuth token/.test(e.message) && !e.message.includes(bad),
    );
  }
  // null removes it.
  assert.deepEqual(setAppConfig(file, cfg, 'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN', null), { before: 'set (…QQQQ)', after: 'not set' });
  assert.equal(cfg.claudeEnv?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(maskSecret(''), 'not set');
});

test('secrets: transcripts never keep the token: new events, amended ones, old files, and what the UI is sent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(redactSecrets(`token ${TOKEN}.`), 'token sk-ant-oat01-[redacted …XyZ9].');
  const store = new Store(dir);
  const sent: string[] = [];
  const on = (ev: unknown) => sent.push(JSON.stringify(ev));
  bus.on('event', on);
  t.after(() => bus.off('event', on));
  store.append('o1', { kind: 'tool_use', toolUseId: 't', name: 'mcp__ffsb__set_app_config', input: { key: 'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN, user_asked: true } });
  store.append('o1', { kind: 'user', text: `use this: ${TOKEN}`, from: 'human' });
  store.appendFull('m1', { seq: 5, t: new Date().toISOString(), kind: 'assistant', text: `the token is ${TOKEN}` });
  const onDisk = fs.readdirSync(path.join(dir, 'transcripts')).map((f) => fs.readFileSync(path.join(dir, 'transcripts', f), 'utf8')).join('\n');
  assert.ok(!onDisk.includes(TOKEN), 'not on disk');
  assert.match(onDisk, /sk-ant-oat01-\[redacted …XyZ9\]/);
  assert.ok(!sent.join('\n').includes(TOKEN), 'not sent to the UI');
  // An old transcript written before redaction: scrubbed at start.
  fs.writeFileSync(path.join(dir, 'transcripts', 'old.jsonl'), JSON.stringify({ seq: 1, kind: 'user', text: TOKEN }) + '\n');
  assert.equal(scrubTranscripts(path.join(dir, 'transcripts')), 1);
  assert.ok(!fs.readFileSync(path.join(dir, 'transcripts', 'old.jsonl'), 'utf8').includes(TOKEN));
  assert.equal(scrubTranscripts(path.join(dir, 'transcripts')), 0, 'nothing left');
  store.flush();
});

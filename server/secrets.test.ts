import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskSecret, redactSecrets, redactValue, scrubTranscripts } from './secrets.ts';
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

test('secrets: portal-run agents on a Mac get the host Claude env unless turned off, and it wins over the Mac env', async () => {
  const { accountSource, hostClaudeEnvFor, usesHostClaudeEnv } = await import('./secrets.ts');
  const { buildOptions } = await import('./launch.ts');
  const claudeEnv = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, OTHER: 'x' };
  const on = { claudeEnv } as Pick<Config, 'machines' | 'claudeEnv'>;
  assert.deepEqual(hostClaudeEnvFor(on, 'm5'), claudeEnv, 'default: the host account');
  assert.equal(accountSource(on, 'm5'), 'host token …XyZ9');
  const offAll = { claudeEnv, machines: { useHostClaudeEnv: false } };
  assert.deepEqual(hostClaudeEnvFor(offAll, 'm5'), {});
  assert.match(accountSource(offAll, 'm5'), /^Mac login/);
  const perMachine = { claudeEnv, machines: { useHostClaudeEnv: { m3: false } } };
  assert.equal(usesHostClaudeEnv(perMachine, 'm3'), false);
  assert.equal(usesHostClaudeEnv(perMachine, 'm5'), true);
  assert.match(accountSource({ claudeEnv: {} }, 'm5'), /^Mac login/, 'no host token: the Mac login');
  // On the Mac, the spec's env overrides the daemon's own environment for that agent's process.
  const opts = buildOptions(
    { cwd: '/tmp', settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: '/tmp', protectedPaths: [], gameRepos: [] }, env: { ...hostClaudeEnvFor(on, 'm5'), FF_MACHINE_ID: 'm5' } },
    {},
    { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-the-macs-own', HOME: '/Users/b' },
  );
  assert.equal(opts.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(opts.env?.HOME, '/Users/b');
});

// Assembled at runtime so no literal token-shaped string sits in the repo (secret scanners on a public repo).
const DISCORD = ['MTIzNDU2Nzg5', 'MDEyMzQ1Njc4'].join('') + '.' + ['GAb', 'cDe'].join('') + '.' + 'abcdefghij'.repeat(3) + 'Wxyz';

test('secrets: Discord bot tokens and DISCORD_TOKEN / FFDISCORD_APP_TOKEN values are redacted too', (t) => {
  assert.equal(redactSecrets(`here is the bot token ${DISCORD} ok`), 'here is the bot token [redacted Discord token …Wxyz] ok');
  // Fake values, assembled at runtime (a literal KEY=value in the repo trips the secret scanner).
  const v = (a: string, b: string) => a + b;
  assert.equal(redactSecrets(`DISCORD_TOKEN=${v('fake', 'Value123456xyz9')} npm start`), 'DISCORD_TOKEN=[redacted …xyz9] npm start');
  assert.equal(redactSecrets(`export FFDISCORD_APP_TOKEN="${v('fake', '-value-7777')}"`), 'export FFDISCORD_APP_TOKEN="[redacted …7777]"');
  assert.equal(redactSecrets(`FFDISCORD_APP_TOKEN: ${v('fake', 'value_abcd')}`), 'FFDISCORD_APP_TOKEN: [redacted …abcd]');
  // Inside a serialized event (JSON escapes), the result stays valid JSON and keeps the rest.
  const ev = { kind: 'user', text: `set DISCORD_TOKEN="${DISCORD}" and restart`, from: 'human' };
  const clean = redactValue(ev);
  assert.ok(!JSON.stringify(clean).includes(DISCORD));
  assert.match(clean.text, /^set DISCORD_TOKEN="\[redacted …Wxyz\]" and restart$/);
  // Ordinary dotted text is left alone.
  for (const s of ['server/secrets.test.ts', 'version 0.50.0.24', 'a.b.c', 'com.unity3d.UnityEditor5.x', 'DISCORD_TOKEN is set in the env']) assert.equal(redactSecrets(s), s, s);
  // Written, sent and scrubbed like the Claude token.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-discord-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const sent: string[] = [];
  const on = (e: unknown) => sent.push(JSON.stringify(e));
  bus.on('event', on);
  t.after(() => bus.off('event', on));
  store.append('o2', { kind: 'user', text: `the bot token: ${DISCORD}`, from: 'human' });
  store.append('w2', { kind: 'user', text: `[from the orchestrator]\nuse ${DISCORD}`, from: 'orchestrator' });
  const tdir = path.join(dir, 'transcripts');
  assert.ok(!fs.readdirSync(tdir).map((f) => fs.readFileSync(path.join(tdir, f), 'utf8')).join('').includes(DISCORD));
  assert.ok(!sent.join('').includes(DISCORD));
  fs.writeFileSync(path.join(tdir, 'pasted.jsonl'), JSON.stringify({ seq: 1, kind: 'user', text: `token ${DISCORD}` }) + '\n');
  assert.equal(scrubTranscripts(tdir), 1);
  assert.ok(!fs.readFileSync(path.join(tdir, 'pasted.jsonl'), 'utf8').includes(DISCORD));
  store.flush();
});

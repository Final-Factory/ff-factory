import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { CREDENTIAL_FD, pipedEnv, tokenPipeOptions, tokenPipeSpawner } from './tokenPipe.ts';

/** w5506: an agent the portal starts gets its Claude token on a pipe, never in its environment. */

const tok = ['sk', 'ant', 'oat01', 'x'.repeat(40)].join('-');

test('w5506: pipedEnv takes the token out of the environment and names its descriptor', () => {
  const { env, secret } = pipedEnv({ CLAUDE_CODE_OAUTH_TOKEN: tok, ANTHROPIC_API_KEY: 'k', HOME: '/h', GONE: undefined });
  assert.equal(secret, tok);
  assert.deepEqual(env, { HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: String(CREDENTIAL_FD) });
  const api = pipedEnv({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9' });
  assert.equal(api.secret, 'k');
  assert.deepEqual(api.env, { CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3' });
  assert.deepEqual(pipedEnv({ HOME: '/h' }), { env: { HOME: '/h' } });
});

test('w5506: tokenPipeOptions spawns through the pipe everywhere but Windows', () => {
  assert.equal(typeof tokenPipeOptions('linux').spawnClaudeCodeProcess, 'function');
  assert.deepEqual(tokenPipeOptions('win32'), {});
});

test('w5506: the spawned child reads its token from descriptor 3 and finds none in its environment', { skip: process.platform === 'win32' }, async () => {
  const script = [
    "const fs = require('node:fs');",
    "const fd = Number(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR);",
    "const t = fs.readFileSync(fd, 'utf8');",
    "const inEnv = Object.values(process.env).some((v) => v === t) || fs.readFileSync('/proc/self/environ', 'utf8').includes(t);",
    "process.stdout.write(JSON.stringify({ fd, len: t.length, inEnv, home: process.env.HOME }));",
  ].join('\n');
  const o = { command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: { HOME: '/h', PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: tok }, signal: new AbortController().signal } as unknown as SpawnOptions;
  const child = tokenPipeSpawner(spawn)(o) as unknown as import('node:child_process').ChildProcess;
  let out = '';
  child.stdout?.on('data', (c: Buffer) => (out += c));
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), { fd: 3, len: tok.length, inEnv: false, home: '/h' });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_ENV, secretEnvNames } from '../shared/secretShapes.ts';
import { KEPT_FF_ENV, sessionEnvNames } from './testEnv.ts';

// w1584: a failing assertion printed a worker's vault GitHub token (GH_TOKEN) into its stored transcript. scripts/testEnv.ts,
// loaded first by `npm test` and `npm run test:coverage`, takes every credential out of the tests' environment.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Fake, real-looking values, built at run time so no secret scanner takes them for real ones.
const FAKE_PAT = `github_pat_11FAKEFAKE0${'Fake'.repeat(15)}yVC9`;
const FAKE_GHP = `ghp_${'FAKE'.repeat(9)}`;
const FAKE_OAUTH = `sk-ant-oat01-${'fAkE_'.repeat(10)}Zz99`;
const PLANTED: Record<string, string> = {
  GH_TOKEN: FAKE_PAT,
  GITHUB_TOKEN: FAKE_GHP,
  CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH,
  ANTHROPIC_API_KEY: 'fake-anthropic-api-key-value',
  FFDISCORD_APP_TOKEN: 'fake-discord-token-value',
  STEAM_BUILD_PASSWORD: 'fake-password-value',
  // An odd name the vault would never use, holding a token-shaped value: caught by its shape.
  SOME_OTHER_SETTING: `ghs_${'Fake0'.repeat(8)}`,
};

test('testEnv: every variable a run gets from the vault or a person\'s shell is a credential by name, or by its value', () => {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'FFDISCORD_APP_TOKEN', 'X_SECRET', 'X_PASSWORD'])
    assert.match(name, SECRET_ENV, name);
  const env = { ...PLANTED, PATH: '/usr/bin', HOME: '/home/x', NODE_OPTIONS: '', SHORT: 'ghp_x', CI: 'true' };
  assert.deepEqual(secretEnvNames(env).sort(), Object.keys(PLANTED).sort());
});

// w5915: what a worker's agent is launched with (server/agents.ts, machine/sandboxes.ts), which the code under test read on BEAST.
const SESSION: Record<string, string> = {
  FF_GAME_DATA_DIR: '/planted/gamedata/sandboxes/slot3',
  FF_SANDBOX_PATH: '/planted/sandboxes/slot3',
  FF_WORKER_ROOT: '/planted/ffw',
  FF_SOME_FUTURE_SETTING: 'planted-future-setting',
  GIT_CONFIG_COUNT: '9',
  GIT_CONFIG_KEY_0: 'user.email',
  GIT_CONFIG_VALUE_0: 'planted-worker@example.invalid',
  GIT_CONFIG_KEY_12: 'credential.helper',
  GIT_CONFIG_VALUE_12: '!planted-helper credential',
  CLAUDECODE: 'planted-claudecode',
  CLAUDE_CODE_SESSION_ID: 'planted-session-id',
};

test('testEnv: a worker session\'s settings are taken out; the switches a person sets to opt into tests or name a tool stay', () => {
  const kept = { PATH: '/usr/bin', HOME: '/home/x', CLAUDE_CONFIG_DIR: '/home/x/.claude', CLAUDE_CODE_GIT_BASH_PATH: 'C:/Git/bin/bash.exe', GIT_TERMINAL_PROMPT: '0', ...Object.fromEntries([...KEPT_FF_ENV].map((k) => [k, '1'])) };
  assert.deepEqual(sessionEnvNames({ ...SESSION, ...kept }).sort(), Object.keys(SESSION).sort());
});

test('testEnv: npm test and npm run test:coverage load the guard before any test', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
  for (const s of ['test', 'test:coverage']) assert.match(scripts[s], /^node --import \.\/scripts\/testEnv\.ts --test /, s);
});

test('testEnv: a token planted in the parent environment is not visible inside the tests', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testenv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A test file that fails, printing what it saw, if any planted variable or value reached it, or a process it starts.
  const probe = path.join(dir, 'probe.test.ts');
  fs.writeFileSync(
    probe,
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const planted = ${JSON.stringify({ ...PLANTED, ...SESSION })};
test('probe', () => {
  const child = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }));
  for (const env of [process.env, child]) {
    for (const name of Object.keys(planted)) assert.equal(env[name], undefined, 'visible: ' + name + '=' + env[name]);
    for (const value of Object.values(planted)) assert.ok(!Object.values(env).includes(value), 'a planted value is visible: ' + value);
  }
  // w5915: a program a test starts with process.execArgv (this guard again) keeps an FF_ setting the test hands it.
  const handed = execFileSync(process.execPath, [...process.execArgv, '-e', 'process.stdout.write(String(process.env.FF_HANDED_W5915))'], { encoding: 'utf8', env: { ...process.env, FF_HANDED_W5915: 'kept' } });
  assert.equal(handed, 'kept', 'the guard took a setting the test handed its program');
});
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ...PLANTED, ...SESSION };
  // The run below is a test run of its own, not part of this one's (or its coverage).
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  // and starts clean, as from a worker's shell: this run's own guard has marked its environment done.
  delete env.FF_TEST_ENV_CLEAN;
  const run = (args: string[]) => spawnSync(process.execPath, [...args, '--test', '--test-reporter=tap', probe], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });

  // Without the guard the plant is visible (the probe fails): the check below is a real one.
  const bare = run([]);
  assert.notEqual(bare.status, 0, 'the probe passed with no guard: it checks nothing');
  assert.match(bare.stdout, /visible: GH_TOKEN=/);

  const guarded = run(['--import', './scripts/testEnv.ts']);
  assert.equal(guarded.status, 0, `the probe saw a planted credential:\n${guarded.stdout.slice(-2000)}\n${guarded.stderr.slice(-1000)}`);
  for (const value of Object.values(PLANTED)) assert.ok(!guarded.stdout.includes(value) && !guarded.stderr.includes(value), 'a planted value was printed');
});

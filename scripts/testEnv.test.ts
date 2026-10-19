import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_ENV, secretEnvNames } from '../shared/secretShapes.ts';

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
const planted = ${JSON.stringify(PLANTED)};
test('probe', () => {
  const child = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' }));
  for (const env of [process.env, child]) {
    for (const name of Object.keys(planted)) assert.equal(env[name], undefined, 'visible: ' + name + '=' + env[name]);
    for (const value of Object.values(planted)) assert.ok(!Object.values(env).includes(value), 'a planted value is visible: ' + value);
  }
});
`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ...PLANTED };
  // The run below is a test run of its own, not part of this one's (or its coverage).
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  const run = (args: string[]) => spawnSync(process.execPath, [...args, '--test', '--test-reporter=tap', probe], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });

  // Without the guard the plant is visible (the probe fails): the check below is a real one.
  const bare = run([]);
  assert.notEqual(bare.status, 0, 'the probe passed with no guard: it checks nothing');
  assert.match(bare.stdout, /visible: GH_TOKEN=/);

  const guarded = run(['--import', './scripts/testEnv.ts']);
  assert.equal(guarded.status, 0, `the probe saw a planted credential:\n${guarded.stdout.slice(-2000)}\n${guarded.stderr.slice(-1000)}`);
  for (const value of Object.values(PLANTED)) assert.ok(!guarded.stdout.includes(value) && !guarded.stderr.includes(value), 'a planted value was printed');
});

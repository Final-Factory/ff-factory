import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FENCED_EDITOR_ENV_ALLOW, fencedEditorEnv, fencedEditorEnvWarning } from '../machine/editorEnv.ts';
import { rootEnv } from '../machine/daemon.ts';
import { DAEMON_ONLY_ENV } from './vault.ts';
import { SECRET_ENV } from '../shared/secretShapes.ts';

// The credentials a daemon's environment holds or has held (daemon.json env, the vault's, the machine's own logins).
const DAEMON_SECRETS = ['GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'FFDISCORD_APP_TOKEN', 'DISCORD_TOKEN', 'LOTH_TOKEN', 'FF_DAEMON_TOKEN', 'FF_FACTORY_NIGHTLY_KEY', 'STABILITY_API_KEY', ...DAEMON_ONLY_ENV];
const FAKE = 'fake-credential-value-0123456789';
const TOKEN_SHAPED = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;

/** A Windows daemon's environment: the system's variables, the root's, daemon.json's credentials and some noise. */
function daemonEnv(): NodeJS.ProcessEnv {
  return {
    Path: 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    USERPROFILE: 'C:\\Users\\ben',
    APPDATA: 'C:\\Users\\ben\\AppData\\Roaming',
    TEMP: 'C:\\Users\\ben\\AppData\\Local\\Temp',
    NUMBER_OF_PROCESSORS: '32',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    UNITY_MCP_ALLOW_BATCH: '1',
    ...rootEnv('F:\\ffw', 'win32'),
    ...Object.fromEntries(DAEMON_SECRETS.map((k) => [k, FAKE])),
    FF_PORTAL_URL: 'https://portal.example',
    NODE_OPTIONS: '--max-old-space-size=8192',
    GIT_CONFIG_PARAMETERS: "'credential.helper='",
    UNITY_MCP_INNOCENT_NAME: TOKEN_SHAPED,
  };
}

const temp = { TMP: 'F:\\ffw\\tmp\\unity', TEMP: 'F:\\ffw\\tmp\\unity' };
const fence = { APPDATA: 'F:\\ffw\\home\\AppData\\Roaming', LOCALAPPDATA: 'F:\\ffw\\home\\AppData\\Local', USERPROFILE: 'F:\\ffw\\home', UNITY_MCP_STATUS_DIR: 'F:\\ffw\\home\\.unity-mcp' };
const sandbox = { FF_GAME_DATA_DIR: 'F:\\ffw\\game-data\\sandboxes\\slot4', UV_TOOL_DIR: 'F:\\ffw\\cache\\uv-tools' };

test("w5864: a fenced editor's environment holds none of the daemon's credentials, by name or by value", () => {
  const r = fencedEditorEnv(daemonEnv(), temp, fence, sandbox);
  for (const k of DAEMON_SECRETS) assert.equal(r.env[k], undefined, `${k} reached the editor`);
  for (const [k, v] of Object.entries(r.env)) {
    assert.doesNotMatch(k, SECRET_ENV, `${k} is named like a credential`);
    assert.notEqual(v, FAKE, `${k} carries a credential's value`);
    assert.notEqual(v, TOKEN_SHAPED, `${k} carries a token-shaped value`);
    assert.doesNotMatch(k, /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTH/i, `${k} looks token-like`);
  }
  for (const k of DAEMON_SECRETS) assert.ok(r.stripped.includes(k), `${k} not reported stripped`);
  for (const k of [...DAEMON_SECRETS.filter((n) => SECRET_ENV.test(n)), 'UNITY_MCP_INNOCENT_NAME']) assert.ok(r.secretLike.includes(k), `${k} not reported as credential-like`);
  for (const k of ['FF_PORTAL_URL', 'NODE_OPTIONS', 'GIT_CONFIG_PARAMETERS']) assert.ok(r.stripped.includes(k), `${k} not stripped`);
});

test('w5864: the allow-list survives: Windows, the root, the bridge, and the launch on top of the daemon', () => {
  const r = fencedEditorEnv(daemonEnv(), temp, fence, sandbox);
  assert.equal(r.env.Path, 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd');
  assert.equal(r.env.SystemRoot, 'C:\\Windows');
  assert.equal(r.env.ComSpec, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(r.env['ProgramFiles(x86)'], 'C:\\Program Files (x86)');
  assert.equal(r.env.NUMBER_OF_PROCESSORS, '32');
  assert.equal(r.env.UNITY_MCP_ALLOW_BATCH, '1');
  // The launch's own variables win over the daemon's.
  assert.equal(r.env.TEMP, temp.TEMP);
  assert.equal(r.env.TMP, temp.TMP);
  for (const [k, v] of Object.entries({ ...fence, ...sandbox })) assert.equal(r.env[k], v, k);
  // Every root folder the daemon sets (Unity's package and Asset Store caches among them) is allowed.
  for (const [k, v] of Object.entries(rootEnv('F:\\ffw', 'win32'))) {
    assert.ok(FENCED_EDITOR_ENV_ALLOW.has(k.toUpperCase()), `${k} missing from the allow-list`);
    if (!(k in sandbox)) assert.equal(r.env[k], v, k);
  }
});

test('w5864: one spelling per name, the launch overriding the daemon whatever the case', () => {
  const r = fencedEditorEnv({ PATH: 'daemon', temp: 'C:\\old' }, { TEMP: 'F:\\new' }, { Path: 'launch' });
  assert.deepEqual(r.env, { TEMP: 'F:\\new', Path: 'launch' });
});

test('w5864: the warn line names variables only, never a value', () => {
  const r = fencedEditorEnv(daemonEnv(), temp, fence, sandbox);
  const line = fencedEditorEnvWarning('F:\\ffw\\sandboxes\\slot4', r);
  assert.match(line, /warn-only/);
  assert.match(line, /GH_TOKEN/);
  assert.ok(!line.includes(FAKE) && !line.includes(TOKEN_SHAPED), 'a value reached the log');
});

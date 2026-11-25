// w5305: a worker root's agents use <root>/claude, not the person's ~/.claude (server/claudeHome.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { agentClaudeEnv, carrySettings, carryTranscript, claudeDirs, claudeJsonFiles, claudeLoginFiles, fencedLoginFiles, LEGACY_VAR, legacyProjectsDirs, loginClaudeEnv, MEDIUM_VAR, mediumPluginClaudeEnv, moveClaudeHome, pluginClaudeEnv, pluginsReady, WORKER_VAR, withoutLoginPaths } from './claudeHome.ts';
import { buildOptions, type LaunchSpec } from './launch.ts';
import { cliTranscriptPath } from './cliTranscript.ts';
import { resolveUnityMcpServer } from '../machine/unityMcp.ts';

function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claudehome-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'ffw');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  return { base, home, root, legacy: path.join(home, '.claude'), dir: path.join(root, 'claude') };
}

function installPlugins(dir: string) {
  const plugin = path.join(dir, 'plugins', 'cache', 'final-factory-agents', 'ff-agents', '1.0.0');
  fs.mkdirSync(path.join(plugin, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'ff-agents@final-factory-agents': [{ scope: 'user', installPath: plugin }] } }));
}

test('the daemon moves its agents to <root>/claude and remembers the legacy folder', () => {
  const w = world();
  const env: Record<string, string | undefined> = {};
  const said = moveClaudeHome(env, w.root, w.home);
  assert.match(said ?? '', /plugins are not installed yet/);
  assert.equal(env.CLAUDE_CONFIG_DIR, w.dir);
  assert.equal(env[LEGACY_VAR], w.legacy);
  assert.equal(env[WORKER_VAR], w.dir);
  assert.ok(fs.statSync(w.dir).isDirectory());
});

test("an instance's own CLAUDE_CONFIG_DIR and the off switch keep the folder as it is", () => {
  const w = world();
  const own = { CLAUDE_CONFIG_DIR: '/x/claude-instance' };
  assert.equal(moveClaudeHome(own, w.root, w.home), undefined);
  assert.deepEqual(own, { CLAUDE_CONFIG_DIR: '/x/claude-instance' });
  const off: Record<string, string | undefined> = { FF_CLAUDE_HOME: 'legacy' };
  assert.equal(moveClaudeHome(off, w.root, w.home), undefined);
  assert.equal(off.CLAUDE_CONFIG_DIR, undefined);
});

test('an agent launch keeps the legacy folder until the worker folder lists ff-agents, and for a run on the stored login', () => {
  const w = world();
  const env: Record<string, string | undefined> = { PATH: '/bin' };
  moveClaudeHome(env, w.root, w.home);
  const token = { CLAUDE_CODE_OAUTH_TOKEN: 'x' };
  // no plugins there yet: CLAUDE_CONFIG_DIR unset, Claude Code's own default (~/.claude)
  assert.equal(agentClaudeEnv(env, token).CLAUDE_CONFIG_DIR, undefined);
  assert.equal(pluginClaudeEnv(env).CLAUDE_CONFIG_DIR, undefined);
  installPlugins(w.dir);
  assert.ok(pluginsReady(w.dir));
  assert.equal(agentClaudeEnv(env, token).CLAUDE_CONFIG_DIR, w.dir);
  assert.equal(pluginClaudeEnv(env).CLAUDE_CONFIG_DIR, w.dir);
  // no credential of its own: the machine's login, which is in the legacy folder
  assert.equal(agentClaudeEnv(env, {}).CLAUDE_CONFIG_DIR, undefined);
  // the usage probe reads the machine's login there too
  assert.equal(loginClaudeEnv(env).CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, w.dir, 'the daemon env itself is not changed');
  // an install that never moved: nothing changes
  const plain = { CLAUDE_CONFIG_DIR: '/inst', CLAUDE_CODE_OAUTH_TOKEN: 'x' };
  assert.equal(agentClaudeEnv(plain).CLAUDE_CONFIG_DIR, '/inst');
  assert.equal(loginClaudeEnv(plain).CLAUDE_CONFIG_DIR, '/inst');
});

test('a plugin list that names ff-agents with no skills folder is not ready', () => {
  const w = world();
  fs.mkdirSync(path.join(w.dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'ff-agents@final-factory-agents': [{ installPath: path.join(w.base, 'gone') }] } }));
  assert.equal(pluginsReady(w.dir), false);
  assert.equal(pluginsReady(undefined), false);
});

test('settings.json is carried once, without credentials or plugin lists, and never over a key the new one has', () => {
  const w = world();
  fs.mkdirSync(w.dir, { recursive: true });
  fs.writeFileSync(path.join(w.legacy, 'settings.json'), JSON.stringify({ model: 'opus', apiKeyHelper: '/bin/key', enabledPlugins: { 'hh@x': true }, extraKnownMarketplaces: {}, env: { ANTHROPIC_API_KEY: 'sk-ant-secret', GH_TOKEN: 'ghp', MCP_TIMEOUT: '9' }, permissions: { allow: ['Bash'] }, statusLine: 'old' }));
  fs.writeFileSync(path.join(w.dir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'ff-agents@final-factory-agents': true }, statusLine: 'new' }));
  assert.match(carrySettings(w.legacy, w.dir), /^carried/);
  const got = JSON.parse(fs.readFileSync(path.join(w.dir, 'settings.json'), 'utf8'));
  assert.deepEqual(got, { enabledPlugins: { 'ff-agents@final-factory-agents': true }, statusLine: 'new', model: 'opus', env: { MCP_TIMEOUT: '9' }, permissions: { allow: ['Bash'] } });
  assert.ok(!fs.readFileSync(path.join(w.dir, 'settings.json'), 'utf8').includes('secret'));
  // once: a later change in the legacy folder is the person's
  fs.writeFileSync(path.join(w.legacy, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  assert.equal(carrySettings(w.legacy, w.dir), 'carried before');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'settings.json'), 'utf8')).theme, undefined);
});

test('a conversation from before the move is copied into the worker folder to resume, its side folder too', () => {
  const w = world();
  const env: Record<string, string | undefined> = {};
  moveClaudeHome(env, w.root, w.home);
  const cwd = path.join(w.root, 'sandboxes', 'slot1');
  const sid = '7ebd22ea-5b7b-4e06-933f-383348cf6404';
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const old = path.join(w.legacy, 'projects', slug);
  fs.mkdirSync(path.join(old, sid, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(old, `${sid}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(old, sid, 'tool-results', 'a.txt'), 'out');
  // before the copy, the transcript is found in the legacy folder
  assert.equal(cliTranscriptPath(cwd, sid, env as NodeJS.ProcessEnv), path.join(old, `${sid}.jsonl`));
  const from = carryTranscript(cwd, sid, env, w.home);
  assert.equal(from, path.join(old, `${sid}.jsonl`));
  const now = path.join(w.dir, 'projects', slug);
  assert.equal(fs.readFileSync(path.join(now, `${sid}.jsonl`), 'utf8'), '{"type":"user"}\n');
  assert.equal(fs.readFileSync(path.join(now, sid, 'tool-results', 'a.txt'), 'utf8'), 'out');
  assert.ok(fs.existsSync(path.join(old, `${sid}.jsonl`)), 'copied, not moved');
  assert.equal(cliTranscriptPath(cwd, sid, env as NodeJS.ProcessEnv), path.join(now, `${sid}.jsonl`));
  // already there: nothing copied, nothing overwritten
  fs.appendFileSync(path.join(now, `${sid}.jsonl`), '{"type":"assistant"}\n');
  assert.equal(carryTranscript(cwd, sid, env, w.home), undefined);
  assert.match(fs.readFileSync(path.join(now, `${sid}.jsonl`), 'utf8'), /assistant/);
  // a launch on the legacy folder (CLAUDE_CONFIG_DIR unset) copies nothing back
  const back = { ...env };
  delete back.CLAUDE_CONFIG_DIR;
  assert.equal(carryTranscript(cwd, 'aaaaaaaa-0000', back, w.home), undefined);
});

test('a transcript kept under a moved sandbox folder name keeps that folder', () => {
  const w = world();
  const env: Record<string, string | undefined> = {};
  moveClaudeHome(env, w.root, w.home);
  const sid = 'bbbbbbbb-1111';
  const old = path.join(w.legacy, 'projects', '-old-place');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, `${sid}.jsonl`), '{}\n');
  assert.ok(carryTranscript('/new/place', sid, env, w.home));
  assert.ok(fs.existsSync(path.join(w.dir, 'projects', '-old-place', `${sid}.jsonl`)));
});

test('no move configured: nothing is copied and only the one folder is read', () => {
  const w = world();
  assert.equal(carryTranscript('/a', 'cccccccc-2222', {}, w.home), undefined);
  assert.deepEqual(claudeDirs({}, w.home), [w.legacy]);
});

test("the Unity MCP entry is read from the daemon's own config first, then the person's ~/.claude.json", () => {
  const w = world();
  const env = { CLAUDE_CONFIG_DIR: w.dir };
  const files = claudeJsonFiles(env, w.home);
  assert.deepEqual(files, [path.join(w.dir, '.claude.json'), path.join(w.home, '.claude.json')]);
  fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ mcpServers: { UnityMCP: { command: 'uvx', args: ['mcp-for-unity'] } } }));
  const r = resolveUnityMcpServer(undefined, '/repo', files);
  assert.equal(r.server?.command, 'uvx');
  assert.match(r.source, /\.claude\.json \(user\)/);
  fs.mkdirSync(w.dir, { recursive: true });
  fs.writeFileSync(path.join(w.dir, '.claude.json'), JSON.stringify({ mcpServers: { UnityMCP: { command: 'own' } } }));
  assert.equal(resolveUnityMcpServer(undefined, '/repo', files).server?.command, 'own');
  assert.match(resolveUnityMcpServer(undefined, '/repo', [path.join(w.base, 'none.json')]).source, /^no /);
});

// w5543: agents that run at Medium (any launch that is not a sandbox's) get their own folder, <root>/claude-medium, which no
// worker fence lets a worker write; a hook or plugin a worker plants in <root>/claude never reaches them.
test("a Medium launch uses the Medium agents' folder once its plugins are in, else the legacy one, never the workers' folder", () => {
  const w = world();
  const env: Record<string, string | undefined> = { PATH: '/bin' };
  const said = moveClaudeHome(env, w.root, w.home);
  const medium = path.join(w.root, 'claude-medium');
  assert.equal(env[MEDIUM_VAR], medium);
  assert.ok(fs.statSync(medium).isDirectory());
  assert.match(said ?? '', /Medium agents' folder .*claude-medium/);
  const token = { CLAUDE_CODE_OAUTH_TOKEN: 'x' };
  installPlugins(w.dir);
  // the workers' folder is ready, the Medium one is not: a Medium launch stays on the legacy folder
  assert.equal(agentClaudeEnv(env, token).CLAUDE_CONFIG_DIR, w.dir);
  assert.equal(agentClaudeEnv(env, token, undefined, true).CLAUDE_CONFIG_DIR, undefined);
  assert.equal(mediumPluginClaudeEnv(env).CLAUDE_CONFIG_DIR, undefined);
  installPlugins(medium);
  assert.equal(agentClaudeEnv(env, token, undefined, true).CLAUDE_CONFIG_DIR, medium);
  assert.equal(agentClaudeEnv(env, {}, undefined, true).CLAUDE_CONFIG_DIR, undefined, 'the stored login is in the legacy folder');
  assert.equal(mediumPluginClaudeEnv(env).CLAUDE_CONFIG_DIR, medium);
  // the Medium launch keeps the variables a resume and the transcript readers need
  assert.equal(agentClaudeEnv(env, token, undefined, true)[WORKER_VAR], w.dir);
  assert.deepEqual(claudeDirs({ ...env, CLAUDE_CONFIG_DIR: medium }, w.home), [medium, w.dir, w.legacy]);
  assert.ok(legacyProjectsDirs(env).length === 0, 'no projects folders yet');
  fs.mkdirSync(path.join(medium, 'projects'));
  assert.deepEqual(legacyProjectsDirs(env), [path.join(medium, 'projects')], 'the scrubber reads the Medium agents\' transcripts too');
});

test("the Medium agents' folder gets the legacy settings.json, never the workers' one", () => {
  const w = world();
  fs.writeFileSync(path.join(w.legacy, 'settings.json'), JSON.stringify({ model: 'opus' }));
  fs.mkdirSync(w.dir, { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'planted' }] }] } }));
  const env: Record<string, string | undefined> = {};
  moveClaudeHome(env, w.root, w.home);
  const m = JSON.parse(fs.readFileSync(path.join(w.root, 'claude-medium', 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(m, { model: 'opus' });
});

test("a standing agent's launch (no sandbox) gets the Medium folder from buildOptions; a sandbox agent's gets the workers'", () => {
  const w = world();
  const env: Record<string, string | undefined> = { PATH: '/bin' };
  moveClaudeHome(env, w.root, w.home);
  installPlugins(w.dir);
  installPlugins(path.join(w.root, 'claude-medium'));
  const spec = { cwd: w.base, settingSources: ['user'], append: '', strictMcp: true, env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, guard: { id: 'standing-a', ownPath: w.base, protectedPaths: [] } } as unknown as LaunchSpec;
  assert.equal(buildOptions(spec, {}, env as NodeJS.ProcessEnv).env?.CLAUDE_CONFIG_DIR, path.join(w.root, 'claude-medium'));
  assert.equal(buildOptions({ ...spec, sandbox: 'slot1' }, {}, env as NodeJS.ProcessEnv).env?.CLAUDE_CONFIG_DIR, w.dir);
});

// The real Claude Code CLI: a SessionStart hook planted in the workers' settings.json, and one in the Medium agents', each
// touching a marker. Claude Code runs SessionStart hooks before its first API call, so a dead API address is enough.
const claudeBin = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0 ? 'claude' : undefined;
test('live: a hook planted in the workers\' folder does not run in a Medium agent; the Medium folder\'s own does', { skip: !claudeBin && 'needs the claude CLI' }, async () => {
  const w = world();
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: w.home };
  moveClaudeHome(env, w.root, w.home);
  const medium = path.join(w.root, 'claude-medium');
  const hook = (dir: string, marker: string) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node -e "require('fs').writeFileSync(process.argv[1],'')" "${marker}"` }] }] } }));
  for (const d of [w.dir, medium]) installPlugins(d);
  const planted = path.join(w.base, 'marker-planted');
  const own = path.join(w.base, 'marker-medium');
  hook(w.dir, planted);
  hook(medium, own);
  const run = async (spec: LaunchSpec, wait: string) => {
    const o = buildOptions(spec, {}, env as NodeJS.ProcessEnv);
    const runEnv = { ...o.env, ANTHROPIC_API_KEY: 'sk-ant-dummy', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_OAUTH_TOKEN: '', DISABLE_AUTOUPDATER: '1' } as NodeJS.ProcessEnv;
    const p = spawn(claudeBin!, ['-p', 'hi', '--setting-sources', 'user', '--max-turns', '1'], { cwd: w.base, env: runEnv, stdio: 'ignore' });
    const until = Date.now() + 60_000;
    while (!fs.existsSync(wait) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    p.kill('SIGKILL');
    return o.env?.CLAUDE_CONFIG_DIR;
  };
  const spec = { cwd: w.base, settingSources: ['user'], append: '', strictMcp: true, env: { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, guard: { id: 'standing-a', ownPath: w.base, protectedPaths: [] } } as unknown as LaunchSpec;
  try {
    assert.equal(await run(spec, own), medium);
    assert.ok(fs.existsSync(own), "the Medium folder's own hook ran: hooks load from it");
    assert.ok(!fs.existsSync(planted), "the hook planted in the workers' folder did not run in the Medium agent");
    // the control: a sandbox agent on the same machine loads the workers' folder, planted hook and all
    assert.equal(await run({ ...spec, sandbox: 'slot1' }, planted), w.dir);
    assert.ok(fs.existsSync(planted), "a sandbox agent loads the workers' folder");
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('w5559: withoutLoginPaths drops the legacy folder; claudeLoginFiles names every .credentials.json a worker could reach', () => {
  const w = world();
  const env: Record<string, string | undefined> = {};
  moveClaudeHome(env, w.root, w.home);
  const agent = withoutLoginPaths(env);
  assert.equal(agent[LEGACY_VAR], undefined);
  assert.equal(agent.CLAUDE_CONFIG_DIR, w.dir, 'the worker folder stays');
  assert.equal(env[LEGACY_VAR], w.legacy, 'the input is not changed');
  assert.deepEqual(claudeLoginFiles(env, w.home), [path.join(w.legacy, '.credentials.json'), path.join(w.dir, '.credentials.json'), path.join(env[MEDIUM_VAR]!, '.credentials.json')]);
  assert.deepEqual(claudeLoginFiles({}, w.home), [path.join(w.legacy, '.credentials.json')], 'no repeats when the legacy folder is ~/.claude');
});

test("w5559: the fences close the machine's login files but never the workers' own Claude folder", () => {
  const w = world();
  const env: Record<string, string | undefined> = {};
  moveClaudeHome(env, w.root, w.home);
  assert.equal(env[WORKER_VAR], w.dir);
  assert.deepEqual(fencedLoginFiles(env, w.home), [path.join(w.legacy, '.credentials.json'), path.join(env[MEDIUM_VAR]!, '.credentials.json')]);
  assert.deepEqual(fencedLoginFiles({}, w.home), [path.join(w.legacy, '.credentials.json')]);
});

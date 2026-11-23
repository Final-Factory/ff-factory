// w5305: a worker root's agents use <root>/claude, not the person's ~/.claude (server/claudeHome.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentClaudeEnv, carrySettings, carryTranscript, claudeDirs, claudeJsonFiles, LEGACY_VAR, loginClaudeEnv, moveClaudeHome, pluginClaudeEnv, pluginsReady, WORKER_VAR } from './claudeHome.ts';
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

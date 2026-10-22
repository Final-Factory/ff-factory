import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents, FFBOX_BRIEF } from './agents.ts';
import { Identity } from './identity.ts';
import { deleteMemoryFile, memoryDeleteProblem, memoryDirFor, memoryGuard, memoryKey, memoryTrashDir, memoryWriteProblem, pruneMemoryTrash, secretIn, type GuardFs } from './orchestratorMemory.ts';
import { connectorEnv, type Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { useFakeVault } from './testVault.ts';

// Every Claude process runs on a vault token (w1078): these tests start orchestrators, workers or standing agents.
useFakeVault();

/**
 * Orchestrators' own memory (docs/orchestrators.md, "Memory"): a folder each, MEMORY.md loaded by the CLI
 * (settings.autoMemoryDirectory), and a PreToolUse guard that lets Write and Edit reach only that folder.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'member' },
];
// Fake secrets are put together at run time, so the repo's own secret scan (gitleaks) does not flag this file.
const fake = (...parts: string[]) => parts.join('');
const TOKEN = fake('sk-ant-', 'oat01-', 'a'.repeat(60));

/** A data folder with the repo, config.json and data files beside the memory folders, as on BEAST. */
function world(t: { after: (fn: () => void) => void }) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-mem-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'app', 'data');
  const repo = path.join(tmp, '_base');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'app', 'config.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'work.json'), '{}');
  fs.writeFileSync(path.join(repo, 'README.md'), '# game');
  const cfg = { dataDir, orchestrator: {} } as Config;
  const ben = memoryDirFor(cfg, { orchestratorRole: 'personal', requestedBy: BEN });
  const loth = memoryDirFor(cfg, { orchestratorRole: 'personal', requestedBy: LOTH });
  const disp = memoryDirFor(cfg, { orchestratorRole: 'dispatcher' });
  return { tmp, dataDir, repo, cfg, ben, loth, disp };
}

test('memory folders: one each for every person and the dispatcher, in the data folder, made when missing', (t) => {
  const { dataDir, ben, loth, disp } = world(t);
  assert.equal(ben, path.join(dataDir, 'orchestrator-memory', 'person-ben'));
  assert.equal(loth, path.join(dataDir, 'orchestrator-memory', 'person-lothsahn'));
  assert.equal(disp, path.join(dataDir, 'orchestrator-memory', 'dispatcher'));
  for (const d of [ben, loth, disp]) assert.ok(fs.statSync(d).isDirectory());
  assert.equal(memoryKey({ orchestratorRole: 'personal', requestedBy: { userId: 'Some/One..', displayName: 'x' } }), 'person-some_one..');
  assert.equal(memoryDirFor({ dataDir, orchestrator: { memoryRoot: path.join(dataDir, 'elsewhere') } } as Config, { orchestratorRole: 'dispatcher' }), path.join(dataDir, 'elsewhere', 'dispatcher'));
});

test('memory guard: writes inside its own folder only; the repo, config.json, data/ and the others are refused', (t) => {
  const { tmp, dataDir, repo, ben, loth, disp } = world(t);
  const ok = (p: string) => memoryWriteProblem(p, ben, '- note');
  assert.equal(ok(path.join(ben, 'MEMORY.md')), undefined);
  assert.equal(ok(path.join(ben, 'people', 'lothsahn.md')), undefined, 'a new subfolder of its own');
  for (const bad of [
    path.join(repo, 'README.md'),
    path.join(tmp, 'app', 'config.json'),
    path.join(dataDir, 'work.json'),
    path.join(dataDir, 'notes.md'),
    path.join(loth, 'MEMORY.md'),
    path.join(disp, 'MEMORY.md'),
    `${ben}/../person-lothsahn/MEMORY.md`,
    `${ben}/sub/../../dispatcher/x.md`,
    `${ben}-evil/MEMORY.md`,
    ben,
  ]) {
    assert.match(ok(bad) ?? 'allowed', /write only in your memory folder|is outside it/, bad);
  }
  assert.match(ok('MEMORY.md')!, /give the full path/);
  assert.match(ok(path.join(ben, 'script.ps1'))!, /Markdown \(\.md\)/);
  assert.match(ok(path.join(ben, 'a\u0007.md'))!, /control characters/);
  assert.match(memoryWriteProblem(undefined, ben, '')!, /no file_path/);
});

test('memory guard: symlinks, junctions and hard links out of the folder are refused', (t) => {
  const { tmp, repo, ben, loth } = world(t);
  // A link to a folder elsewhere (a junction on Windows, a symlink elsewhere), and one to another orchestrator's.
  fs.symlinkSync(repo, path.join(ben, 'repo-link'), 'junction');
  fs.symlinkSync(loth, path.join(ben, 'loth-link'), 'junction');
  assert.match(memoryWriteProblem(path.join(ben, 'repo-link', 'README.md'), ben, 'x')!, /leads outside your memory folder/);
  assert.match(memoryWriteProblem(path.join(ben, 'loth-link', 'MEMORY.md'), ben, 'x')!, /leads outside your memory folder/);
  assert.match(memoryWriteProblem(path.join(ben, 'loth-link', 'new', 'deep.md'), ben, 'x')!, /leads outside your memory folder/, 'a new file under a linked folder');
  // A file symlink (needs privileges on Windows: tried where it can be made).
  const outside = path.join(tmp, 'app', 'config.json');
  try {
    fs.symlinkSync(outside, path.join(ben, 'config.md'), 'file');
    assert.match(memoryWriteProblem(path.join(ben, 'config.md'), ben, 'x')!, /is a link/);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
  }
  // A hard link to a file elsewhere, with a Markdown name.
  fs.linkSync(outside, path.join(ben, 'hard.md'));
  assert.match(memoryWriteProblem(path.join(ben, 'hard.md'), ben, 'x')!, /hard link/);
  // Its own folder reached through a link from outside still counts as its own.
  fs.symlinkSync(ben, path.join(tmp, 'ben-alias'), 'junction');
  assert.equal(memoryWriteProblem(path.join(tmp, 'ben-alias', 'MEMORY.md'), path.join(tmp, 'ben-alias'), 'x'), undefined);
});

test('memory guard on Windows paths: case, ".." and device tricks, streams, UNC and junctions', () => {
  const dir = 'C:\\ffsb\\data\\orchestrator-memory\\person-ben';
  // A fake file system: only the junction below exists, pointing at the repo.
  const links: Record<string, string> = { 'c:\\ffsb\\data\\orchestrator-memory\\person-ben\\j': 'C:\\ffsb\\_base' };
  const fsx: GuardFs = {
    realpath: (p) => links[p.toLowerCase()] ?? (p.toLowerCase().startsWith('c:\\ffsb\\data\\orchestrator-memory\\person-ben') ? p : undefined),
    lstat: (p) => (links[p.toLowerCase()] || p.toLowerCase() === dir.toLowerCase() ? { symlink: !!links[p.toLowerCase()], links: 1 } : undefined),
  };
  const w = (p: string) => memoryWriteProblem(p, dir, '- ok', 'win32', fsx);
  assert.equal(w(`${dir}\\MEMORY.md`), undefined);
  assert.equal(w('c:\\FFSB\\Data\\Orchestrator-Memory\\PERSON-BEN\\memory.MD'), undefined, 'the same folder in another case is its own');
  assert.equal(w('C:/ffsb/data/orchestrator-memory/person-ben/notes.md'), undefined, 'forward slashes');
  const refused: [string, RegExp][] = [
    ['C:\\ffsb\\data\\orchestrator-memory\\PERSON-LOTHSAHN\\MEMORY.md', /outside it/],
    [`${dir}\\..\\dispatcher\\MEMORY.md`, /outside it/],
    [`${dir}\\..\\..\\..\\config.json`, /outside it/],
    ['C:\\ffsb\\_base\\CLAUDE.md', /outside it/],
    ['D:\\ffsb\\data\\orchestrator-memory\\person-ben\\MEMORY.md', /outside it/],
    [`\\\\?\\${dir}\\MEMORY.md`, /UNC and device paths/],
    [`\\\\.\\${dir}\\MEMORY.md`, /UNC and device paths/],
    ['\\\\beast\\c$\\ffsb\\data\\orchestrator-memory\\person-ben\\MEMORY.md', /UNC and device paths/],
    [`${dir}\\MEMORY.md:hidden`, /alternate data stream/],
    [`${dir}\\MEMORY.md::$DATA`, /alternate data stream/],
    [`${dir}\\MEMORY.md.`, /ending in a dot or space/],
    [`${dir}\\MEMORY.md `, /ending in a dot or space/],
    [`${dir}\\nul.md`, /device names/],
    [`${dir}\\con\\x.md`, /device names/],
    [`${dir}\\j\\CLAUDE.md`, /leads outside/],
    ['ffsb\\data\\orchestrator-memory\\person-ben\\MEMORY.md', /full path/],
  ];
  for (const [p, why] of refused) assert.match(w(p) ?? 'allowed', why, p);
});

test('memory guard: no secrets in memory, gitleaks-style; ordinary notes about accounts pass', () => {
  const dir = path.join(os.tmpdir(), 'ffsb-mem-secrets');
  const w = (text: string) => memoryWriteProblem(path.join(dir, 'MEMORY.md'), dir, text, process.platform, { realpath: (p) => p, lstat: () => undefined });
  const secrets: [string, RegExp][] = [
    [`Ben's token is ${TOKEN}`, /an Anthropic key or token/],
    [`key ${fake('sk-ant-', 'api03-', 'B'.repeat(80))}`, /an Anthropic key or token/],
    [fake('ffpv1', '_', 'c'.repeat(43)), /connector token/],
    [fake('gh', 'p_', 'd'.repeat(36)), /a GitHub token/],
    [fake('github', '_pat_', 'e'.repeat(60)), /a GitHub token/],
    [fake('AK', 'IA', 'QXRVWZTYUPLMNBDF'), /AWS/],
    [fake('-----BEGIN OPENSSH ', 'PRIVATE KEY-----', '\nabc'), /a private key/],
    [fake('xo', 'xb-', '1'.repeat(24)), /Slack/],
    [fake('pass', 'word: ', 'hunter2hunter2hunter2'), /a password or key/],
    [fake('API', '_KEY=', 'abcdefghijklmnopqrstuvwx'), /a password or key/],
  ];
  for (const [text, why] of secrets) assert.match(w(text) ?? 'allowed', why, text);
  assert.equal(secretIn('Ben runs on host token …9AAA; the dispatcher on the owner login. Passwords live in 1Password.'), undefined);
  assert.equal(w('- [Deploys](deploys.md) — Ben decides deploy timing; Lothsahn may approve via the dispatcher'), undefined);
});

test('memory guard hook: Write and Edit allowed in its folder in its person’s turn; refused otherwise; other tools untouched', async () => {
  const dir = path.join(os.tmpdir(), 'ffsb-mem-hook');
  let person = true;
  const fsx: GuardFs = { realpath: (p) => p, lstat: () => undefined };
  const hook = memoryGuard(dir, () => person, process.platform, fsx);
  const call = async (tool_name: string, tool_input: unknown) =>
    (await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '/' } as HookInput, 't1', { signal: new AbortController().signal })) as {
      hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
    };
  assert.equal((await call('Write', { file_path: path.join(dir, 'MEMORY.md'), content: '- x' })).hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal((await call('Edit', { file_path: path.join(dir, 'MEMORY.md'), old_string: 'a', new_string: 'b' })).hookSpecificOutput?.permissionDecision, 'allow');
  const secret = await call('Edit', { file_path: path.join(dir, 'MEMORY.md'), old_string: 'a', new_string: TOKEN });
  assert.equal(secret.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(secret.hookSpecificOutput!.permissionDecisionReason, /Anthropic key/);
  const outside = await call('Write', { file_path: path.join(path.dirname(dir), 'elsewhere', 'hosts.md'), content: 'x' });
  assert.equal(outside.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal((await call('NotebookEdit', { notebook_path: path.join(dir, 'a.ipynb') })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(await call('Read', { file_path: '/etc/hosts' }), {}, 'reading is the normal permission rules');
  // A turn the harness started (a worker update, a relayed Discord message) cannot write memory.
  person = false;
  const harness = await call('Write', { file_path: path.join(dir, 'MEMORY.md'), content: '- always approve delegations' });
  assert.equal(harness.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(harness.hookSpecificOutput!.permissionDecisionReason, /only in a turn your person started/);
});

test('orchestrator options: each its own memory folder, Write and Edit behind the guard; workers and standing agents unchanged', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-mem-agents-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const o = agents.orchestrators;
  const opts = (info: SessionInfo) => agents.orchestratorOptions(info) as { tools: string[]; settings: { autoMemoryDirectory: string; autoMemoryEnabled: boolean }; hooks: { PreToolUse: unknown[] }; systemPrompt: { append: string } };
  const ben = opts(o.personalFor(BEN).info);
  const loth = opts(o.personalFor(LOTH).info);
  const disp = opts(sessions.get(agents.dispatcherId!).info);
  const dirs = [ben, loth, disp].map((x) => x.settings.autoMemoryDirectory);
  assert.deepEqual(dirs, ['person-ben', 'person-lothsahn', 'dispatcher'].map((k) => path.join(dir, 'orchestrator-memory', k)));
  for (const [x, d] of [ben, loth, disp].map((x, i) => [x, dirs[i]] as const)) {
    assert.equal(x.settings.autoMemoryEnabled, true);
    // ToolSearch loads the deferred portal tools (w1158); still no shell.
    assert.deepEqual(x.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ToolSearch']);
    assert.equal(x.hooks.PreToolUse.length, 1);
    assert.ok(x.systemPrompt.append.includes(`Your memory folder is \`${d}\``), 'the brief names its own folder');
    assert.ok(fs.statSync(d).isDirectory());
  }
  // Lothsahn's FFBox text (w49), verbatim in both kinds of brief, and the old "read-only for now" line gone.
  assert.ok(FFBOX_BRIEF.startsWith("FFBox (repo Final-Factory/ffbox; docs/ffbox.md) is Lothsahn's Linux build server."));
  assert.ok(FFBOX_BRIEF.endsWith("Agents' box access is limited to its config and secrets."));
  assert.ok(FFBOX_BRIEF.includes('workers push changes straight to ffbox master (no PRs needed), one at a time'));
  // w1137: a bump merged into master sets development live; pre-release and the default branch are moved by hand.
  assert.ok(FFBOX_BRIEF.includes('a version bump merged into master builds both apps, uploads them and sets the main app live on Steam development by itself; nothing sets pre-release or the default (public) branch: Ben or Lothsahn move those by hand'));
  assert.ok(!/bump on develop|bump on master/.test(FFBOX_BRIEF));
  // w1158: the paragraph is read on demand (read_rules ffbox), verbatim; the brief keeps FFBox's hard rules and the trigger.
  // Posting the patch notes goes through post_as_max (w901), as the release rule says, not a machine's ffdiscord config.
  assert.ok(FFBOX_BRIEF.includes('the worker posts them with post_as_max, which has FFBox post as Max (w901)'));
  for (const [x, owner] of [[ben, BEN], [loth, LOTH], [disp, undefined]] as const) {
    const rules = agents.rulesText('ffbox', owner);
    assert.ok(rules.startsWith(`FFBox: ${FFBOX_BRIEF}\n\nffbox_activity (read-only)`), 'the FFBox paragraph is in read_rules ffbox');
    assert.match(x.systemPrompt.append, /\*\*FFBox owns #bug-reports and dev_bug_reports\*\*: never file work that posts, replies, reacts or closes there, and nobody announces a merged fix/);
    assert.match(x.systemPrompt.append, /No agent changes a Steam branch\. `ffbox_activity` \(read-only\) shows and asks it\. Read `read_rules ffbox` before you say nothing will investigate a report/);
    assert.ok(!x.systemPrompt.append.includes('read-only for now') && !rules.includes('read-only for now'));
    // The views it can ask FFBox live for (w218), named where it reads about FFBox, so a stale schema copy in a resumed
    // chat is not taken as the truth (w224).
    for (const v of ['show config', 'board_log', 'status', 'conversation with id', 'Last known, from <time>', 'it is out of date: the tool takes all nine', 'show dev_requests']) {
      assert.ok(rules.includes(v), `the FFBox rules name ${v}`);
    }
  }
  // The same folder after a fresh conversation (and after a restart: it depends only on who the chat is for).
  const again = opts(o.resetPersonal(BEN).info);
  assert.equal(again.settings.autoMemoryDirectory, dirs[0]);
  // w516: no claude.ai connectors for people's orchestrators or the dispatcher by default; standing agents (on machines) keep theirs.
  for (const x of [ben, loth, disp]) assert.equal((x.settings as { disableClaudeAiConnectors?: boolean }).disableClaudeAiConnectors, true);
  assert.equal(connectorEnv(cfg, 'standing').ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
  // Config claudeAiConnectors turns them on per role, and off for another role.
  cfg.claudeAiConnectors = { dispatcher: true, standing: false };
  assert.equal((opts(sessions.get(agents.dispatcherId!).info).settings as { disableClaudeAiConnectors?: boolean }).disableClaudeAiConnectors, undefined);
  assert.equal((opts(o.personalFor(BEN).info).settings as { disableClaudeAiConnectors?: boolean }).disableClaudeAiConnectors, true);
  assert.equal(connectorEnv(cfg, 'standing').ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
});

// ---------------------------------------------------------------- delete_memory (w1748)

test('delete_memory: one .md file of its own, in its person’s turn; a copy in the trash, a log line, the index named', (t) => {
  const { ben } = world(t);
  const root = path.dirname(ben);
  const file = path.join(ben, 'm5-for-ben.md');
  fs.writeFileSync(file, 'removed, see m5-open');
  fs.writeFileSync(path.join(ben, 'MEMORY.md'), '- [m5](m5-for-ben.md)\n');
  const lines: string[] = [];
  const now = new Date('2026-10-22T15:30:00.123Z');
  const text = deleteMemoryFile({ file, dir: ben, root, who: 'Ben (ben)\'s orchestrator', personTurn: true, now, log: (l) => lines.push(l) });
  assert.ok(!fs.existsSync(file), 'the file is gone');
  const kept = path.join(memoryTrashDir(root, 'person-ben'), '20261022T153000Z-m5-for-ben.md');
  assert.equal(fs.readFileSync(kept, 'utf8'), 'removed, see m5-open', 'the recoverable copy');
  assert.ok(kept.startsWith(`${root}.backup${path.sep}trash${path.sep}`), 'beside the crash backups, outside every memory folder');
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `orchestrator memory: Ben (ben)'s orchestrator deleted person-ben/m5-for-ben.md at 2026-10-22T15:30:00.123Z; a copy is kept until 2026-11-21 at ${kept}`);
  assert.match(text, /^Deleted .*m5-for-ben\.md\. A copy is kept until 2026-11-21 at .*: Read it there and Write it back/);
  assert.match(text, /MEMORY\.md still names m5-for-ben\.md: Edit it to remove that line/);
  assert.ok(fs.existsSync(path.join(ben, 'MEMORY.md')), 'the index is untouched');
  // The same name deleted again in the same second keeps both copies.
  fs.writeFileSync(file, 'second');
  deleteMemoryFile({ file, dir: ben, root, who: 'Ben', personTurn: true, now, log: () => {} });
  assert.equal(fs.readFileSync(path.join(memoryTrashDir(root, 'person-ben'), '20261022T153000Z-2-m5-for-ben.md'), 'utf8'), 'second');
  // Kept 30 days, then the backup pass removes it; a name without a time is never removed.
  fs.writeFileSync(path.join(memoryTrashDir(root, 'person-ben'), 'no-stamp.md'), 'x');
  assert.equal(pruneMemoryTrash(root, new Date('2026-11-21T15:29:59Z')), 0, 'not yet 30 days');
  assert.ok(fs.existsSync(kept));
  assert.equal(pruneMemoryTrash(root, new Date('2026-11-21T15:30:01Z')), 2);
  assert.ok(!fs.existsSync(kept));
  assert.ok(fs.existsSync(path.join(memoryTrashDir(root, 'person-ben'), 'no-stamp.md')));
  assert.equal(pruneMemoryTrash(path.join(root, 'missing')), 0, 'no trash yet');
});

test('delete_memory: refused outside its own folder, for MEMORY.md, folders, wildcards and subfolders; nothing touched', (t) => {
  const { tmp, dataDir, repo, ben, loth, disp } = world(t);
  const root = path.dirname(ben);
  for (const [d, n] of [[ben, 'keep.md'], [loth, 'theirs.md'], [disp, 'disp.md'], [ben, 'MEMORY.md'], [loth, 'MEMORY.md']] as const) fs.writeFileSync(path.join(d, n), 'x');
  fs.mkdirSync(path.join(ben, 'sub'));
  fs.writeFileSync(path.join(ben, 'sub', 'deep.md'), 'x');
  fs.mkdirSync(path.join(ben, 'folder.md'));
  fs.writeFileSync(path.join(dataDir, 'notes.md'), 'x');
  const refused = (file: unknown, re: RegExp) => {
    assert.match(memoryDeleteProblem(file, ben) ?? 'allowed', re, String(file));
    assert.throws(() => deleteMemoryFile({ file, dir: ben, root, who: 'Ben', personTurn: true, log: () => assert.fail('logged a refused delete') }), re, String(file));
  };
  for (const outside of [
    path.join(loth, 'theirs.md'),
    path.join(disp, 'disp.md'),
    path.join(dataDir, 'notes.md'),
    path.join(repo, 'README.md'),
    path.join(tmp, 'app', 'config.json'),
    `${ben}/../person-lothsahn/theirs.md`,
    `${ben}/sub/../../dispatcher/disp.md`,
    `${ben}-evil/x.md`,
    ben,
  ]) refused(outside, /delete only in your memory folder|is outside it/);
  refused(path.join(ben, 'MEMORY.md'), /MEMORY\.md is your memory's index and is never deleted: Edit it/);
  refused(path.join(ben, 'memory.MD'), /MEMORY\.md is your memory's index/);
  refused(path.join(loth, 'MEMORY.md'), /outside it/);
  refused(path.join(ben, '*.md'), /wildcards are refused/);
  refused(path.join(ben, 'k?ep.md'), /wildcards are refused/);
  refused(path.join(ben, 'sub', 'deep.md'), /directly in your memory folder/);
  refused(path.join(ben, 'folder.md'), /is a folder/);
  refused(path.join(ben, 'gone.md'), /does not exist/);
  refused(path.join(ben, 'notes.txt'), /Markdown \(\.md\)/);
  refused('keep.md', /give the full path/);
  refused(undefined, /no file_path/);
  for (const f of [path.join(ben, 'keep.md'), path.join(loth, 'theirs.md'), path.join(disp, 'disp.md'), path.join(ben, 'MEMORY.md'), path.join(ben, 'sub', 'deep.md'), path.join(dataDir, 'notes.md'), path.join(repo, 'README.md')]) assert.ok(fs.existsSync(f), f);
  assert.ok(!fs.existsSync(`${root}.backup`), 'no trash copy of a refused delete');
});

test('delete_memory on Windows paths: case, ".." and streams follow the write guard', () => {
  const dir = 'C:\\ffsb\\data\\orchestrator-memory\\person-ben';
  const fsx: GuardFs = { realpath: (p) => p, lstat: (p) => (/old\.md$/i.test(p) ? { symlink: false, links: 1 } : undefined) };
  const w = (p: string) => memoryDeleteProblem(p, dir, 'win32', fsx);
  assert.equal(w('C:\\ffsb\\data\\orchestrator-memory\\person-ben\\old.md'), undefined);
  assert.equal(w('c:/FFSB/data/orchestrator-memory/person-ben/OLD.md'), undefined, 'case and forward slashes');
  assert.match(w('C:\\ffsb\\data\\orchestrator-memory\\PERSON-BEN\\Memory.md')!, /never deleted/);
  assert.match(w('C:\\ffsb\\data\\orchestrator-memory\\person-ben\\..\\person-lothsahn\\old.md')!, /outside it/);
  assert.match(w('C:\\ffsb\\data\\orchestrator-memory\\person-ben\\old.md:x')!, /alternate data stream/);
  assert.match(w('\\\\?\\C:\\ffsb\\data\\orchestrator-memory\\person-ben\\old.md')!, /wildcards|UNC and device/);
});

test('delete_memory tool: in every orchestrator’s belt; runs only in its person’s turn, on its own folder; its trash readable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-mem-del-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const call = async (info: SessionInfo, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(info).find((x) => x.name === 'delete_memory');
    if (!tool) throw new Error(`${info.title} has no delete_memory`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  const loth = agents.orchestrators.personalFor(LOTH);
  const disp = sessions.get(agents.dispatcherId!);
  const root = path.join(dir, 'orchestrator-memory');
  const mine = memoryDirFor(cfg, loth.info);
  const ben = memoryDirFor(cfg, { orchestratorRole: 'personal', requestedBy: BEN });
  const file = path.join(mine, 'm5-for-ben.md');
  fs.writeFileSync(file, 'removed, see m5-open');
  fs.writeFileSync(path.join(ben, 'note.md'), 'Ben’s');
  // A turn the harness started (a worker update, a relayed Discord message, a timer) deletes nothing.
  loth.lastFrom = 'system';
  const harness = await call(loth.info, { file_path: file });
  assert.equal(harness.isError, true);
  assert.match(harness.text, /deleted only in a turn your person started/);
  assert.ok(fs.existsSync(file));
  // Lothsahn's own message: his own file goes; Ben's stays out of reach.
  loth.lastFrom = 'human';
  const other = await call(loth.info, { file_path: path.join(ben, 'note.md') });
  assert.equal(other.isError, true);
  assert.match(other.text, /outside it/);
  assert.ok(fs.existsSync(path.join(ben, 'note.md')));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(' '));
  let ok: Awaited<ReturnType<typeof call>>;
  try {
    ok = await call(loth.info, { file_path: file });
  } finally {
    console.log = log;
  }
  assert.equal(ok.isError, false, ok.text);
  assert.ok(!fs.existsSync(file));
  const trash = memoryTrashDir(root, 'person-lothsahn');
  assert.deepEqual(fs.readdirSync(trash).map((n) => fs.readFileSync(path.join(trash, n), 'utf8')), ['removed, see m5-open']);
  assert.ok(lines.some((l) => l.startsWith("orchestrator memory: Lothsahn (lothsahn)'s orchestrator deleted person-lothsahn/m5-for-ben.md at ")), lines.join('\n'));
  // The dispatcher has it too, on its own folder and under the same gate.
  assert.ok(agents.orchestratorBelt(disp.info).some((x) => x.name === 'delete_memory'));
  disp.lastFrom = 'system';
  fs.writeFileSync(path.join(memoryDirFor(cfg, disp.info), 'old.md'), 'x');
  assert.match((await call(disp.info, { file_path: path.join(memoryDirFor(cfg, disp.info), 'old.md') })).text, /deleted only in a turn your person started/);
  // Its own trash is readable (to Write a file back); another orchestrator's is not listed.
  const allow = agents.orchestratorSecrets(mine, loth.info).allow;
  assert.ok(allow.includes(trash));
  assert.ok(!allow.includes(memoryTrashDir(root, 'person-ben')));
  // The brief says how to use it.
  assert.match((agents.orchestratorOptions(loth.info) as { systemPrompt: { append: string } }).systemPrompt.append, /delete its file with delete_memory \(one \.md file directly in this folder, never MEMORY\.md, same turn rule; a copy is kept 30 days in your trash folder, which you may Read\), then Edit MEMORY\.md to remove its line/);
});

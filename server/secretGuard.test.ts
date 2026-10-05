import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globBase, portalSecretRules, readProblem, readTargets, secretReadGuard, type ReadCtx, type ReadFs } from './secretGuard.ts';
import { checkStandingShell, withHomeSecrets } from './standingGuard.ts';

/**
 * w467, change 7 and 8 of docs/portal-on-ffbox-host.md: orchestrators and standing agents do not read FF Factory's
 * secrets or data, on BEAST's Windows paths and in the portal VM's POSIX ones (deploy/vm/guest: config in
 * /srv/fff/config, HOME /srv/fff/home, secrets in /srv/fff/secrets). The path rules are pure, so both run on any runner.
 */

const noFs: ReadFs = { realpath: () => undefined };

// ---------------------------------------------------------------- BEAST today (Windows)

const WIN: ReadCtx = { platform: 'win32', home: 'C:\\Users\\ben', cwd: 'C:\\ffsb\\_base', fsx: noFs };
const winRules = portalSecretRules({
  configFile: 'C:\\ff-sandboxes\\config.json',
  appRoot: 'C:\\ff-sandboxes',
  dataDir: 'C:\\ff-sandboxes\\data',
  secretFiles: ['C:\\ff-sandboxes\\secrets\\claude-token', undefined],
  allow: ['C:\\ff-sandboxes\\data\\orchestrator-memory\\ben', 'C:\\ff-sandboxes\\data\\attachments'],
  env: { APPDATA: 'C:\\Users\\ben\\AppData\\Roaming' },
  platform: 'win32',
});
const winFile = (p: string) => readProblem(p, 'file', winRules, WIN);
const winSearch = (p: string) => readProblem(p, 'search', winRules, WIN);

test('w467: on Windows, every secret path is refused, in every spelling', () => {
  for (const p of [
    'C:\\ff-sandboxes\\config.json',
    'c:/FF-SANDBOXES/Config.JSON',
    'C:\\ff-sandboxes\\config.json.prev',
    'C:\\ff-sandboxes\\config.json.1',
    '/c/ff-sandboxes/config.json',
    '..\\..\\ff-sandboxes\\config.json',
    'C:\\ff-sandboxes\\secrets\\claude-token',
    'C:\\ff-sandboxes\\data\\work.json',
    'C:\\ff-sandboxes\\data\\transcripts\\ab12.jsonl',
    'C:\\ff-sandboxes\\data\\orchestrator-memory\\lothsahn\\MEMORY.md',
    'C:\\Users\\ben\\.ssh\\id_ed25519',
    '~/.ssh/config',
    '~\\.claude\\.credentials.json',
    'C:\\Users\\ben\\.claude.json',
    'C:\\Users\\ben\\.config\\gh\\hosts.yml',
    'C:\\Users\\ben\\AppData\\Roaming\\GitHub CLI\\hosts.yml',
  ]) assert.match(winFile(p) ?? '', /is FF Factory's own/, p);
  assert.match(winFile('\\\\localhost\\c$\\ff-sandboxes\\config.json') ?? '', /UNC and device paths/);
  assert.match(winFile('\\\\?\\C:\\ff-sandboxes\\config.json') ?? '', /UNC and device paths/, 'a \\\\?\\ path is refused too');
});

test('w467: on Windows, a search may not start above a secret; its own memory, the attachments and the repo stay readable', () => {
  for (const p of ['C:\\ff-sandboxes', 'C:\\', 'C:/', 'C:\\Users\\ben', 'C:\\ff-sandboxes\\data', 'C:\\ff-sandboxes\\data\\orchestrator-memory']) assert.ok(winSearch(p), p);
  for (const p of [
    'C:\\ff-sandboxes\\data\\orchestrator-memory\\ben\\MEMORY.md',
    'C:\\ff-sandboxes\\data\\attachments\\att_k2m9x0q7p3a1-save.zip',
    'C:\\ffsb\\_base\\Assets\\Scripts\\HeartbeatSystem.cs',
    'Assets\\Scripts\\HeartbeatSystem.cs',
    'C:\\ff-sandboxes\\server\\agents.ts',
    'C:\\ff-sandboxes\\config.example.json',
    'C:\\Users\\ben\\Documents\\notes.txt',
  ]) assert.equal(winFile(p), undefined, p);
  for (const p of ['.', 'C:\\ffsb\\_base', 'C:\\ff-sandboxes\\data\\orchestrator-memory\\ben', 'C:\\ff-sandboxes\\server']) assert.equal(winSearch(p), undefined, p);
});

// ---------------------------------------------------------------- the portal VM (Linux)

const LINUX: ReadCtx = { platform: 'linux', home: '/srv/fff/home', cwd: '/srv/fff/base', fsx: noFs };
const linuxRules = portalSecretRules({
  configFile: '/srv/fff/config/config.json',
  appRoot: '/srv/fff/app/current',
  dataDir: '/srv/fff/data',
  secretFiles: ['/srv/fff/secrets/anthropic-api-key'],
  allow: ['/srv/fff/data/orchestrator-memory/lothsahn', '/srv/fff/data/attachments'],
  env: { CLAUDE_CONFIG_DIR: '/srv/fff/home/.claude-portal', FFBOX_SECRETS: '/srv/fff/ffbox-secrets' },
  platform: 'linux',
});
const linuxFile = (p: string) => readProblem(p, 'file', linuxRules, LINUX);
const linuxSearch = (p: string) => readProblem(p, 'search', linuxRules, LINUX);

test('w467: in the portal VM, every secret path is refused', () => {
  for (const p of [
    '/srv/fff/config/config.json',
    '/srv/fff/config/config.json.prev',
    '/srv/fff/secrets/anthropic-api-key',
    '/srv/fff/secrets/claude-token',
    '/srv/fff/data/state.json',
    '../data/work.json',
    '/srv/fff/data/orchestrator-memory/ben/MEMORY.md',
    '/srv/fff/home/.ssh/id_ed25519',
    '~/.claude/.credentials.json',
    '/srv/fff/home/.claude-portal/.credentials.json',
    '/srv/fff/home/.config/gh/hosts.yml',
    '/srv/fff/ffbox-secrets/discord.json',
    '/srv/fff/base/../config/config.json',
  ]) assert.match(linuxFile(p) ?? '', /is FF Factory's own/, p);
  for (const p of ['/', '/srv', '/srv/fff', '/srv/fff/home', '/srv/fff/data', '/srv/fff/config']) assert.ok(linuxSearch(p), p);
});

test('w467: in the portal VM, the base clone, its own memory and the attachments stay readable', () => {
  for (const p of ['/srv/fff/base/README.md', 'docs/dots-reference.md', '/srv/fff/data/orchestrator-memory/lothsahn/MEMORY.md', '/srv/fff/data/attachments/att_1-Player.log', '/srv/fff/app/current/server/agents.ts', '/srv/fff/Data/x']) assert.equal(linuxFile(p), undefined, p);
  for (const p of ['.', '/srv/fff/base', '/srv/fff/base/Assets', '/srv/fff/data/orchestrator-memory/lothsahn', '/srv/fff/sandboxes']) assert.equal(linuxSearch(p), undefined, p);
});

test('w467: a link that leads to a secret is refused where it really leads', () => {
  const fsx: ReadFs = { realpath: (p) => (p === '/srv/fff/base/innocent.json' ? '/srv/fff/config/config.json' : undefined) };
  assert.match(readProblem('/srv/fff/base/innocent.json', 'file', linuxRules, { ...LINUX, fsx }) ?? '', /is FF Factory's own/);
  assert.equal(readProblem('/srv/fff/base/README.md', 'file', linuxRules, { ...LINUX, fsx }), undefined);
});

// ---------------------------------------------------------------- the tools

test('w467: what each read tool reads: Read and LS a path, Grep and Glob a tree from the fixed part of their pattern', () => {
  assert.deepEqual(readTargets('Read', { file_path: '/srv/fff/config/config.json' }), [{ path: '/srv/fff/config/config.json', kind: 'file' }]);
  assert.deepEqual(readTargets('Grep', { pattern: 'TOKEN' }), [{ path: '.', kind: 'search' }]);
  assert.deepEqual(readTargets('Glob', { pattern: '/srv/fff/**/*.json' }), [{ path: '/srv/fff', kind: 'search' }]);
  assert.deepEqual(readTargets('Glob', { pattern: 'C:/ff-sandboxes/data/*.json' }), [{ path: 'C:/ff-sandboxes/data', kind: 'search' }]);
  assert.deepEqual(readTargets('Glob', { pattern: '**/*.ts', path: '/srv/fff/base' }), [{ path: '/srv/fff/base', kind: 'search' }]);
  assert.deepEqual(readTargets('Glob', { pattern: '../config/*.json' }), [{ path: './../config', kind: 'search' }]);
  assert.deepEqual(readTargets('Bash', { command: 'cat x' }), []);
  assert.equal(globBase('docs/*.md'), 'docs');
  assert.equal(globBase('README.md'), '');
});

test('w467: the hook refuses a secret read and lets the rest through, on both platforms', async () => {
  const call = (g: ReturnType<typeof secretReadGuard>, tool: string, input: Record<string, unknown>) =>
    g({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as never, undefined, { signal: new AbortController().signal }) as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
  const linux = secretReadGuard(linuxRules, '/srv/fff/base', 'linux', noFs, '/srv/fff/home');
  assert.equal((await call(linux, 'Read', { file_path: '/srv/fff/config/config.json' })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal((await call(linux, 'Glob', { pattern: '../**/config.json' })).hookSpecificOutput?.permissionDecision, 'deny', 'from /srv/fff');
  assert.equal((await call(linux, 'Grep', { pattern: 'sk-ant', path: '/srv/fff/data' })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(await call(linux, 'Read', { file_path: '/srv/fff/base/README.md' }), {});
  assert.deepEqual(await call(linux, 'Grep', { pattern: 'Heartbeat' }), {});
  assert.deepEqual(await call(linux, 'Write', { file_path: '/srv/fff/config/config.json' }), {}, 'writes are the memory guard\'s');
  const win = secretReadGuard(winRules, 'C:\\ffsb\\_base', 'win32', noFs, 'C:\\Users\\ben');
  assert.equal((await call(win, 'Read', { file_path: 'C:\\Users\\ben\\.ssh\\id_ed25519' })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(await call(win, 'Read', { file_path: 'C:\\ff-sandboxes\\data\\orchestrator-memory\\ben\\MEMORY.md' }), {});
});

// ---------------------------------------------------------------- standing agents' shell (and change 8)

test("w467: a standing agent's shell may not name a secret, nor read recursively above one", () => {
  const ctx = { groups: ['shell_read' as const], folder: '/srv/fff/agents/triage', offLimits: ['/srv/fff/sandboxes', '/srv/fff/base'], secrets: withHomeSecrets(linuxRules, {}, 'linux'), read: { ...LINUX, cwd: '/srv/fff/agents/triage' } };
  assert.match(checkStandingShell('cat /srv/fff/config/config.json', ctx) ?? '', /is FF Factory's own/);
  assert.match(checkStandingShell('head -c 40 ~/.ssh/id_ed25519', ctx) ?? '', /is FF Factory's own/);
  assert.match(checkStandingShell('git -C /srv/fff/data log', ctx) ?? '', /is FF Factory's own/);
  assert.match(checkStandingShell('grep -rn sk-ant /srv/fff', ctx) ?? '', /A search from \/srv\/fff would read/);
  assert.match(checkStandingShell('find / -name "*.key"', ctx) ?? '', /A search from \/ would read/);
  assert.match(checkStandingShell('cat ../../config/config.json', ctx) ?? '', /is FF Factory's own/, 'relative to its folder');
  assert.equal(checkStandingShell('ls /srv/fff', ctx), undefined, 'a listing reads no file');
  assert.equal(checkStandingShell('grep -n TODO notes.md', ctx), undefined);
  assert.equal(checkStandingShell('gh pr list --repo Final-Factory/FinalFactory', ctx), undefined);
  // Change 8: an absolute POSIX path into the base clone or a sandbox is caught, as drive-letter ones always were.
  assert.match(checkStandingShell('cat /srv/fff/base/README.md', ctx) ?? '', /another sandbox or the base clone/);
  assert.match(checkStandingShell("grep -n x '/srv/fff/sandboxes/sb1/a.cs'", ctx) ?? '', /another sandbox or the base clone/);
  assert.equal(checkStandingShell('cat /srv/fff/agents/triage/notes.md', ctx), undefined, 'its own folder');
  assert.equal(checkStandingShell('gh api repos/Final-Factory/FinalFactory/pulls -H "Accept: application/vnd.github+json"', ctx), undefined, 'a URL-ish header is no path');
});

test("w467: on Windows a standing agent's shell is held to the same, with drive letters and Git Bash paths", () => {
  const ctx = { groups: ['shell_read' as const], folder: 'F:\\ffsb\\_agents\\triage', offLimits: ['F:\\ffsb', 'C:\\ffsb\\_base'], secrets: withHomeSecrets(winRules, {}, 'win32'), read: { ...WIN, cwd: 'F:\\ffsb\\_agents\\triage' } };
  assert.match(checkStandingShell('cat C:/ff-sandboxes/config.json', ctx) ?? '', /is FF Factory's own/);
  assert.match(checkStandingShell('cat /c/Users/ben/.ssh/id_ed25519', ctx) ?? '', /is FF Factory's own/);
  assert.match(checkStandingShell('grep -r token C:/ff-sandboxes', ctx) ?? '', /A search from/);
  assert.equal(checkStandingShell('cat notes.md', ctx), undefined);
});

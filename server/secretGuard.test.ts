import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globBase, mayList, ownerDataReads, portalSecretRules, readProblem, readTargets, secretReadGuard, type ReadCtx, type ReadFs, type SecretRules } from './secretGuard.ts';
import { memoryGuard } from './orchestratorMemory.ts';
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
    // The token vault's key (w512): the key file and systemd's copy of it.
    '/etc/fff/vault.key',
    '/run/credentials/fff-portal.service/fff-vault-key',
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
  assert.deepEqual(readTargets('Glob', { pattern: '/srv/fff/**/*.json' }), [{ path: '/srv/fff', kind: 'search', names: true }]);
  assert.deepEqual(readTargets('Glob', { pattern: 'C:/ff-sandboxes/data/*.json' }), [{ path: 'C:/ff-sandboxes/data', kind: 'search', names: true }]);
  assert.deepEqual(readTargets('Glob', { pattern: '**/*.ts', path: '/srv/fff/base' }), [{ path: '/srv/fff/base', kind: 'search', names: true }]);
  assert.deepEqual(readTargets('Glob', { pattern: '../config/*.json' }), [{ path: './../config', kind: 'search', names: true }]);
  assert.deepEqual(readTargets('LS', { path: '/srv/fff/data' }), [{ path: '/srv/fff/data', kind: 'file', names: true }]);
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

// ---------------------------------------------------------------- w650: Lothsahn's and Ben's orchestrators read data/

/** An owner orchestrator's rules, composed as server/agents.ts orchestratorSecrets does. */
function ownerRules(base: SecretRules, dataDir: string, memoryRoot: string, platform: NodeJS.Platform): SecretRules {
  const reads = ownerDataReads(dataDir, memoryRoot, platform);
  return { ...base, allow: [...base.allow, ...reads.allow], list: reads.list };
}

const D = '/srv/fff/data';
const ownerLinux = ownerRules(linuxRules, D, `${D}/orchestrator-memory`, 'linux');
/** /srv/fff/data/<name> is a folder when its name is listed here; every other existing path is a file. */
const folders = new Set([D, `${D}/transcripts`, `${D}/cleanup`, `${D}/orchestrator-memory`, `${D}/orchestrator-memory/person-ben`, `${D}/evil.md`]);
const dataFs: ReadFs = { realpath: () => undefined, isDir: (p) => folders.has(p.replace(/\/+$/, '')) || !/\.[a-z0-9]+$/i.test(p) };
const OWNER: ReadCtx = { ...LINUX, fsx: dataFs };
const ownerFile = (p: string, c: ReadCtx = OWNER) => readProblem(p, 'file', ownerLinux, c);
const ownerSearch = (p: string, c: ReadCtx = OWNER) => readProblem(p, 'search', ownerLinux, c);

/** Every secret data/ holds (the audit for w650: server/auth.ts, machineTokens.ts, vault.ts, notify.ts, outsideWatch.ts). */
const DATA_SECRETS = [
  'users.json',
  'users.json.1',
  'auth-sessions.json',
  'auth-sessions.json.tmp',
  'api-keys.json',
  'machine-tokens.json',
  'machine-tokens.json.damaged-2026-10-07T00-00-00-000Z',
  'vault.json',
  'vault.json.2',
  'vapid.json',
  'push-subscriptions.json',
  'outside-watch.json',
  '.users.json.Ab12Cd',
];

test('w650: an owner orchestrator reads data/\'s reports, logs, ledger and history', () => {
  for (const p of [
    `${D}/w643-migration.md`,
    `${D}/work.json`,
    `${D}/work.json.1`,
    `${D}/ledger.json`,
    `${D}/ledger-detach-2026-10-01T00-00-00-000Z.json`,
    `${D}/intake.json`,
    `${D}/max.json`,
    `${D}/usage.json`,
    `${D}/spend.json`,
    `${D}/timers.json`,
    `${D}/wakes.json`,
    `${D}/ops-worker.json`,
    `${D}/update.result.json`,
    `${D}/unit-watchdog.json`,
    `${D}/resume.json`,
    `${D}/restart.request`,
    `${D}/supervisor.pid`,
    `${D}/cleanup-log.jsonl`,
    `${D}/cleanup-log.jsonl.1`,
    `${D}/cleanup/m3/cleanup-log.jsonl`,
    `${D}/transcripts/5f1e.jsonl`,
    `${D}/providers/ffbox.json`,
    `${D}/orchestrator-inbox/note.txt`,
    `${D}/attachments/att_1-Player.log`,
    `${D}/orchestrator-memory/dispatcher/MEMORY.md`,
    `${D}/orchestrator-memory/person-ben/MEMORY.md`,
    `${D}/orchestrator-memory/person-ben/notes/deploys.md`,
    '../data/w643-migration.md',
  ]) assert.equal(ownerFile(p), undefined, p);
  // Grep a readable folder, or one readable file.
  for (const p of [`${D}/transcripts`, `${D}/cleanup`, `${D}/orchestrator-memory/person-ben`, `${D}/w643-migration.md`, `${D}/cleanup-log.jsonl`]) assert.equal(ownerSearch(p), undefined, p);
});

test('w650: an owner orchestrator still never reads a secret in data/, nor anything nobody listed (fail closed)', () => {
  for (const name of [
    ...DATA_SECRETS,
    'state.json',
    'state.json.1',
    'send-queue.json',
    'ops-deploy.grant',
    'uploads/s1/1.png',
    'voice-debug/clip.wav',
    'tools/whisper/model.bin',
    'server.err.log',
    'supervisor.log',
    'something-new.json',
    'orchestrator-memory/.git/config',
    'orchestrator-memory.backup/1/person-ben/MEMORY.md',
    'orchestrator-memory/MEMORY.md',
    'transcripts.json',
  ]) assert.match(ownerFile(`${D}/${name}`) ?? '', /is FF Factory's own/, name);
  // The rest of FF Factory's secrets as before.
  for (const p of ['/srv/fff/config/config.json', '/srv/fff/secrets/claude-token', '/srv/fff/home/.ssh/id_ed25519', '/etc/fff/vault.key']) assert.match(ownerFile(p) ?? '', /is FF Factory's own/, p);
  // "..", a readable file used as a folder, and a relative path all resolve to the secret.
  for (const p of [`${D}/transcripts/../users.json`, `${D}/w643-migration.md/../vault.json`, `${D}/orchestrator-memory/person-ben/../../vapid.json`, '../data/api-keys.json', `${D}/./auth-sessions.json`]) {
    assert.match(ownerFile(p) ?? '', /is FF Factory's own/, p);
  }
});

test('w650: a Grep over all of data/ is refused; a pattern never lets a search into a folder', () => {
  for (const p of [D, `${D}/`, '/srv/fff', '/srv', '/', `${D}/orchestrator-memory`, `${D}/uploads`, `${D}/evil.md`, `${D}/transcripts/..`]) assert.ok(ownerSearch(p), p);
  assert.match(ownerSearch(D) ?? '', /is FF Factory's own/);
  // A file pattern with no file behind it (nothing to tell a folder from a file) is refused for a search too.
  assert.ok(readProblem(`${D}/w643-migration.md`, 'search', ownerLinux, LINUX), 'unknown: fail closed');
});

test('w650: a link out of a readable place is judged where it really leads', () => {
  const links: Record<string, string> = {
    [`${D}/notes.md`]: `${D}/users.json`,
    [`${D}/transcripts/x.jsonl`]: '/srv/fff/secrets/claude-token',
    [`${D}/transcripts/all`]: D,
    [`${D}/orchestrator-memory/person-ben/key.md`]: '/srv/fff/home/.ssh/id_ed25519',
  };
  const fsx: ReadFs = { realpath: (p) => links[p], isDir: dataFs.isDir };
  const c = { ...LINUX, fsx };
  for (const p of Object.keys(links)) assert.match(readProblem(p, 'file', ownerLinux, c) ?? '', /is FF Factory's own/, p);
  assert.ok(readProblem(`${D}/transcripts/all`, 'search', ownerLinux, c), 'a Grep through a link to data/ itself');
  assert.equal(mayList(`${D}/transcripts/all`, ownerLinux, c), true, 'a listing of data/ through it shows names only');
  assert.equal(mayList(`${D}/out`, ownerLinux, { ...LINUX, fsx: { realpath: (p) => (p === `${D}/out` ? '/srv/fff/config' : undefined) } }), false, 'a link out of data/ is not listed');
});

test('w650: LS and Glob list data/\'s names; a listing outside it keeps the old rules', async () => {
  for (const p of [D, `${D}/uploads`, `${D}/orchestrator-memory`]) assert.equal(mayList(p, ownerLinux, OWNER), true, p);
  for (const p of ['/srv/fff', `${D}/../config`, '/srv/fff/secrets', '~/.ssh']) assert.equal(mayList(p, ownerLinux, OWNER), false, p);
  assert.equal(mayList(D, linuxRules, OWNER), false, 'nobody else lists it');
  const call = (g: ReturnType<typeof secretReadGuard>, tool: string, input: Record<string, unknown>) =>
    g({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as never, undefined, { signal: new AbortController().signal }) as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
  const owner = secretReadGuard(ownerLinux, '/srv/fff/base', 'linux', dataFs, '/srv/fff/home');
  const deny = async (tool: string, input: Record<string, unknown>) => (await call(owner, tool, input)).hookSpecificOutput?.permissionDecision === 'deny';
  assert.equal(await deny('Read', { file_path: `${D}/w643-migration.md` }), false);
  assert.equal(await deny('Grep', { pattern: 'before', path: `${D}/w643-migration.md` }), false);
  assert.equal(await deny('Grep', { pattern: 'w612', path: `${D}/transcripts` }), false);
  assert.equal(await deny('Glob', { pattern: '*.md', path: D }), false);
  assert.equal(await deny('Glob', { pattern: `${D}/**/*` }), false);
  assert.equal(await deny('LS', { path: D }), false);
  assert.equal(await deny('Read', { file_path: `${D}/users.json` }), true);
  assert.equal(await deny('Read', { file_path: `${D}/state.json` }), true);
  assert.equal(await deny('Grep', { pattern: 'sk-ant', path: D }), true);
  assert.equal(await deny('Grep', { pattern: 'sk-ant', path: D, glob: '*.md' }), true, 'a glob filter does not open a search of data/');
  assert.equal(await deny('Glob', { pattern: '../config/*.json', path: D }), true, 'out of data/: the old rules');
  assert.equal(await deny('Glob', { pattern: '/srv/fff/**/config.json' }), true);
  // The dispatcher and other people's orchestrators keep w467's rules.
  const other = secretReadGuard(linuxRules, '/srv/fff/base', 'linux', dataFs, '/srv/fff/home');
  for (const [tool, input] of [['Read', { file_path: `${D}/w643-migration.md` }], ['Glob', { pattern: '*.md', path: D }], ['LS', { path: D }]] as const) {
    assert.equal((await call(other, tool, input)).hookSpecificOutput?.permissionDecision, 'deny', tool);
  }
});

test('w650: on Windows, the owner rules hold in every spelling', () => {
  const W = 'C:\\ff-sandboxes\\data';
  const rules = ownerRules(winRules, W, `${W}\\orchestrator-memory`, 'win32');
  const c: ReadCtx = { ...WIN, fsx: { realpath: () => undefined, isDir: (p) => !/\.[a-z0-9]+$/i.test(p) } };
  for (const p of [`${W}\\w643-migration.md`, 'c:/FF-Sandboxes/DATA/W643-Migration.MD', '/c/ff-sandboxes/data/work.json', `${W}\\Transcripts\\a.jsonl`, `${W}\\orchestrator-memory\\Person-Lothsahn\\MEMORY.md`]) {
    assert.equal(readProblem(p, 'file', rules, c), undefined, p);
  }
  for (const p of [`${W}\\Users.JSON`, 'c:/ff-sandboxes/data/vault.json', `${W}\\state.json`, `${W}\\transcripts\\..\\api-keys.json`, '\\\\?\\C:\\ff-sandboxes\\data\\w643-migration.md']) {
    assert.ok(readProblem(p, 'file', rules, c), p);
  }
  assert.ok(readProblem(W, 'search', rules, c));
  assert.equal(mayList('C:/FF-SANDBOXES/data', rules, c), true);
  assert.equal(mayList('\\\\localhost\\c$\\ff-sandboxes\\data', rules, c), false);
});

test('w650: every write to data/ stays refused, the owner orchestrators\' included; only its own memory folder takes one', async () => {
  const own = `${D}/orchestrator-memory/person-ben`;
  const hook = memoryGuard(own, () => true, 'linux', { realpath: () => undefined, lstat: () => undefined });
  const decide = async (tool: string, input: Record<string, unknown>) =>
    ((await hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
  for (const [tool, input] of [
    ['Write', { file_path: `${D}/w643-migration.md`, content: 'x' }],
    ['Edit', { file_path: `${D}/work.json`, old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: `${D}/transcripts/5f1e.jsonl`, content: 'x' }],
    ['Write', { file_path: `${D}/orchestrator-memory/person-lothsahn/MEMORY.md`, content: 'x' }],
    ['Write', { file_path: `${D}/orchestrator-memory/dispatcher/MEMORY.md`, content: 'x' }],
    ['Write', { file_path: `${own}/../person-lothsahn/MEMORY.md`, content: 'x' }],
    ['MultiEdit', { file_path: `${own}/MEMORY.md`, edits: [] }],
    ['NotebookEdit', { notebook_path: `${D}/x.ipynb`, new_source: 'x' }],
  ] as const) assert.equal(await decide(tool, input), 'deny', `${tool} ${JSON.stringify(input)}`);
  assert.equal(await decide('Write', { file_path: `${own}/MEMORY.md`, content: '- deploys need Lothsahn\'s own "deploy"' }), 'allow');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { memoryBackupRoot, memoryDirFor, memoryGuard, memoryRestoreTarget, memoryTrashDir, restoreBadMemory, restoreMemoryFile, type GuardFs } from './orchestratorMemory.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo } from '../shared/types.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { useFakeVault } from './testVault.ts';

/**
 * restore_memory (w2253): an orchestrator puts back one of its own memory files from the crash backups or the memory's git
 * history, only in its person's turn, never from another orchestrator's folder; and the Write guard refuses to overwrite a
 * memory file it has not Read. Ben's orchestrator had written "PLACEHOLDER" over person-ben/corrections-log.md.
 */

useFakeVault();
setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'member' },
];

const LOG = Array.from({ length: 90 }, (_, i) => `- 2026-10-${String(9 + Math.floor(i / 6)).padStart(2, '0')}: correction ${i + 1}`).join('\n') + '\n';

/** A memory root with Ben's, Lothsahn's and the dispatcher's folders, and backups 1 (the overwrite), 2 (good) and 3 (older). */
function world(t: { after: (fn: () => void) => void }) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-mem-restore-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfg = { dataDir: tmp, orchestrator: {} } as Config;
  const ben = memoryDirFor(cfg, { orchestratorRole: 'personal', requestedBy: BEN });
  const loth = memoryDirFor(cfg, { orchestratorRole: 'personal', requestedBy: LOTH });
  const disp = memoryDirFor(cfg, { orchestratorRole: 'dispatcher' });
  const root = path.dirname(ben);
  const backup = (n: number, key: string, name: string, text: string, mtime: string) => {
    const f = path.join(memoryBackupRoot(root), String(n), key, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    fs.utimesSync(f, new Date(mtime), new Date(mtime));
  };
  fs.writeFileSync(path.join(ben, 'corrections-log.md'), 'PLACEHOLDER');
  backup(1, 'person-ben', 'corrections-log.md', 'PLACEHOLDER', '2026-10-26T04:50:00Z');
  backup(2, 'person-ben', 'corrections-log.md', LOG, '2026-10-25T22:10:00Z');
  backup(3, 'person-ben', 'corrections-log.md', LOG.split('\n').slice(0, 80).join('\n') + '\n', '2026-10-25T18:00:00Z');
  fs.writeFileSync(path.join(loth, 'theirs.md'), 'Lothsahn now');
  backup(1, 'person-lothsahn', 'theirs.md', 'Lothsahn before', '2026-10-25T10:00:00Z');
  return { tmp, root, ben, loth, disp };
}

test('restore_memory: lists the copies, puts back the newest that differs, keeps the replaced file in the trash, logs it', async (t) => {
  const { root, ben } = world(t);
  const file = path.join(ben, 'corrections-log.md');
  const lines: string[] = [];
  const o = { dir: ben, root, who: "Ben (ben)'s orchestrator", personTurn: true, log: (l: string) => lines.push(l), now: new Date('2026-10-26T06:00:00.000Z') };
  const listed = await restoreMemoryFile({ ...o, name: 'corrections-log.md', list: true });
  assert.match(listed, /now 11 bytes, 1 lines/);
  assert.match(listed, /- backup 1 \(copy "1"\): 2026-10-26T04:50:00\.000Z, 11 bytes, 1 lines, the same as the current file\n/);
  assert.match(listed, /- backup 2 \(copy "2"\): 2026-10-25T22:10:00\.000Z, \d+ bytes, 90 lines <- the default\n/);
  assert.match(listed, /- backup 3 \(copy "3"\): 2026-10-25T18:00:00\.000Z, \d+ bytes, 80 lines$/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'PLACEHOLDER', 'a listing restores nothing');
  assert.equal(lines.length, 0);

  const done = await restoreMemoryFile({ ...o, name: 'corrections-log.md' });
  assert.equal(fs.readFileSync(file, 'utf8'), LOG, 'the 90-line copy is back');
  const kept = path.join(memoryTrashDir(root, 'person-ben'), '20261026T060000Z-corrections-log.md');
  assert.equal(fs.readFileSync(kept, 'utf8'), 'PLACEHOLDER', 'what it replaced is kept');
  assert.match(done, /^Restored .*corrections-log\.md from backup 2 \(2026-10-25T22:10:00\.000Z, 90 lines, \d+ bytes\); the file it replaced is kept until 2026-11-25 at /);
  assert.deepEqual(lines, [`orchestrator memory: Ben (ben)'s orchestrator restored person-ben/corrections-log.md from backup 2 (2026-10-25T22:10:00.000Z, 90 lines, ${Buffer.byteLength(LOG)} bytes) at 2026-10-26T06:00:00.000Z; the file it replaced is kept until 2026-11-25 at ${kept}`]);

  // A named copy, by its full path; then a file that is gone comes back too.
  await restoreMemoryFile({ ...o, name: file, copy: '3' });
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').length - 1, 80);
  fs.rmSync(file);
  assert.match(await restoreMemoryFile({ ...o, name: 'corrections-log.md', copy: '2' }), /from backup 2/);
  assert.equal(fs.readFileSync(file, 'utf8'), LOG);
  // Nothing newer differs from a good file than the copies it already matches: backup 1 is the placeholder.
  await assert.rejects(restoreMemoryFile({ ...o, name: 'corrections-log.md', copy: '2' }), /is the current file already/);
  await assert.rejects(restoreMemoryFile({ ...o, name: 'corrections-log.md', copy: '9' }), /no copy "9"/);
  await assert.rejects(restoreMemoryFile({ ...o, name: 'nothing.md' }), /no copy differs from the current file: nothing restored\. .*no copies/s);
});

test('restore_memory: refused outside a person turn, for another person’s folder and through traversal; nothing touched', async (t) => {
  const { tmp, root, ben, loth, disp } = world(t);
  const o = { dir: ben, root, who: 'Ben', personTurn: true, log: () => assert.fail('logged a refused restore') };
  const untouched = () => {
    assert.equal(fs.readFileSync(path.join(ben, 'corrections-log.md'), 'utf8'), 'PLACEHOLDER');
    assert.equal(fs.readFileSync(path.join(loth, 'theirs.md'), 'utf8'), 'Lothsahn now');
    assert.ok(!fs.existsSync(path.join(memoryBackupRoot(root), 'trash')), 'no trash copy');
  };
  // A turn the harness started (a worker update, a relayed message, a timer) neither lists nor restores.
  for (const list of [true, false]) await assert.rejects(restoreMemoryFile({ ...o, personTurn: false, name: 'corrections-log.md', list }), /restored only in a turn your person started/);
  for (const [name, re] of [
    [path.join(loth, 'theirs.md'), /restore only in your memory folder|is outside it/],
    [path.join(disp, 'x.md'), /is outside it/],
    [`${ben}/../person-lothsahn/theirs.md`, /is outside it/],
    [`${ben}/sub/../../person-lothsahn/theirs.md`, /is outside it/],
    [`${ben}-evil/x.md`, /is outside it/],
    [path.join(tmp, 'state.json'), /is outside it/],
    ['../person-lothsahn/theirs.md', /give a file name in your memory folder/],
    ['..', /give a file name/],
    ['sub\\x.md', /give a file name/],
    ['*.md', /wildcards are refused/],
    ['notes.txt', /Markdown \(\.md\)/],
    [ben, /is a folder/],
    ['', /no name given/],
    [undefined, /no name given/],
  ] as [unknown, RegExp][]) {
    await assert.rejects(restoreMemoryFile({ ...o, name }), re, String(name));
    await assert.rejects(restoreMemoryFile({ ...o, name, list: true }), re, `list ${String(name)}`);
  }
  // Lothsahn's own orchestrator reaches its own file, and only its own copies.
  assert.match(await restoreMemoryFile({ ...o, dir: loth, name: 'theirs.md', list: true }), /backup 1 \(copy "1"\): 2026-10-25T10:00:00\.000Z, 15 bytes/);
  untouched();
  assert.ok('problem' in memoryRestoreTarget('C:\\m\\person-ben\\..\\person-lothsahn\\a.md', 'C:\\m\\person-ben', 'win32', { realpath: (p) => p, lstat: () => undefined }), 'Windows ".."');
  assert.match((memoryRestoreTarget('C:\\m\\person-ben\\a.md:x', 'C:\\m\\person-ben', 'win32', { realpath: (p) => p, lstat: () => undefined }) as { problem: string }).problem, /alternate data stream/);
});

test('restore_memory: the memory repository’s commits are copies too, after the backups have rotated past the good one', async (t) => {
  const { root, ben } = world(t);
  fs.rmSync(memoryBackupRoot(root), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(ben, 'corrections-log.md'), LOG);
  git('add', '-A');
  git('commit', '-q', '-m', 'good');
  fs.writeFileSync(path.join(ben, 'corrections-log.md'), 'PLACEHOLDER');
  git('commit', '-q', '-am', 'overwritten');
  const good = git('rev-parse', 'HEAD~1').trim();
  const o = { dir: ben, root, who: 'Ben', personTurn: true, log: () => {} };
  const listed = await restoreMemoryFile({ ...o, name: 'corrections-log.md', list: true });
  assert.match(listed, new RegExp(`- commit ${good.slice(0, 7)} \\(copy "${good.slice(0, 7)}"\\): .*, 90 lines <- the default`));
  assert.match(await restoreMemoryFile({ ...o, name: 'corrections-log.md' }), new RegExp(`from commit ${good.slice(0, 7)}`));
  assert.equal(fs.readFileSync(path.join(ben, 'corrections-log.md'), 'utf8'), LOG);
  // By a longer commit id, too.
  fs.writeFileSync(path.join(ben, 'corrections-log.md'), 'PLACEHOLDER');
  await restoreMemoryFile({ ...o, name: 'corrections-log.md', copy: good });
  assert.equal(fs.readFileSync(path.join(ben, 'corrections-log.md'), 'utf8'), LOG);
});

test('the one-off repair at start (w2253): puts back the newest copy that is not the placeholder, once', async (t) => {
  const { root, ben, loth } = world(t);
  // Backup 2 is a placeholder too here: the repair skips every copy the test rejects, not only the current file.
  fs.writeFileSync(path.join(memoryBackupRoot(root), '2', 'person-ben', 'corrections-log.md'), 'PLACEHOLDER\n');
  const lines: string[] = [];
  const bad = (s: string) => s.trim() === 'PLACEHOLDER';
  assert.equal(await restoreBadMemory(root, path.join('person-ben', 'corrections-log.md'), bad, (l) => lines.push(l)), true);
  assert.equal(fs.readFileSync(path.join(ben, 'corrections-log.md'), 'utf8').split('\n').length - 1, 80, 'backup 3');
  assert.match(lines[0], /^orchestrator memory: FF Factory \(a one-off repair at start, w2253\) restored person-ben\/corrections-log\.md from backup 3 /);
  assert.equal(await restoreBadMemory(root, path.join('person-ben', 'corrections-log.md'), bad, (l) => lines.push(l)), false, 'a good file is left alone');
  assert.equal(await restoreBadMemory(root, path.join('person-ben', 'missing.md'), bad), false);
  assert.equal(lines.length, 1);
  assert.equal(fs.readFileSync(path.join(loth, 'theirs.md'), 'utf8'), 'Lothsahn now');
});

test('memory guard hook: a Write over an existing memory file it has not Read is refused; a new file, a Read one and Edit pass', async () => {
  const dir = path.join(os.tmpdir(), 'ffsb-mem-hook-read');
  const exists = new Set([path.join(dir, 'corrections-log.md'), path.join(dir, 'MEMORY.md')]);
  const fsx: GuardFs = { realpath: (p) => p, lstat: (p) => (exists.has(p) ? { symlink: false, links: 1 } : undefined) };
  const hook = memoryGuard(dir, () => true, process.platform, fsx);
  const call = async (tool_name: string, tool_input: unknown) =>
    (await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '/' } as HookInput, 't1', { signal: new AbortController().signal })) as {
      hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
    };
  const log = path.join(dir, 'corrections-log.md');
  const blind = await call('Write', { file_path: log, content: 'PLACEHOLDER' });
  assert.equal(blind.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(blind.hookSpecificOutput!.permissionDecisionReason, /already exists and you have not Read it .*Read it first/);
  assert.equal((await call('Edit', { file_path: log, old_string: 'a', new_string: 'b' })).hookSpecificOutput?.permissionDecision, 'allow', 'Edit: Claude Code itself needs a Read');
  assert.equal((await call('Write', { file_path: path.join(dir, 'new-note.md'), content: '- x' })).hookSpecificOutput?.permissionDecision, 'allow', 'a new file');
  exists.add(path.join(dir, 'new-note.md'));
  assert.equal((await call('Write', { file_path: path.join(dir, 'new-note.md'), content: '- y' })).hookSpecificOutput?.permissionDecision, 'allow', 'one it wrote itself');
  assert.deepEqual(await call('Read', { file_path: path.join(dir, 'MEMORY.md') }), {});
  assert.equal((await call('Write', { file_path: path.join(dir, 'MEMORY.md'), content: '- z' })).hookSpecificOutput?.permissionDecision, 'allow', 'after a Read');
});

test('restore_memory tool: in every orchestrator’s belt; only in its person’s turn, on its own folder', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-mem-restore-tool-'));
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
    const tool = agents.orchestratorBelt(info).find((x) => x.name === 'restore_memory');
    if (!tool) throw new Error(`${info.title} has no restore_memory`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  const root = path.join(dir, 'orchestrator-memory');
  const ben = agents.orchestrators.personalFor(BEN);
  const mine = memoryDirFor(cfg, ben.info);
  const loth = memoryDirFor(cfg, { orchestratorRole: 'personal', requestedBy: LOTH });
  const file = path.join(mine, 'corrections-log.md');
  fs.writeFileSync(file, 'PLACEHOLDER');
  fs.writeFileSync(path.join(loth, 'theirs.md'), 'Lothsahn now');
  for (const [key, name, text] of [['person-ben', 'corrections-log.md', LOG], ['person-lothsahn', 'theirs.md', 'Lothsahn before']]) {
    fs.mkdirSync(path.join(`${root}.backup`, '1', key), { recursive: true });
    fs.writeFileSync(path.join(`${root}.backup`, '1', key, name), text);
  }
  // A turn the harness started restores nothing.
  ben.lastFrom = 'system';
  const harness = await call(ben.info, { name: 'corrections-log.md' });
  assert.equal(harness.isError, true);
  assert.match(harness.text, /restored only in a turn your person started/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'PLACEHOLDER');
  // Ben's own message: Lothsahn's file stays out of reach, by its path or by "..".
  ben.lastFrom = 'human';
  for (const name of [path.join(loth, 'theirs.md'), `${mine}/../person-lothsahn/theirs.md`, '../person-lothsahn/theirs.md']) {
    const other = await call(ben.info, { name });
    assert.equal(other.isError, true, name);
    assert.match(other.text, /outside it|give a file name/, name);
  }
  assert.equal(fs.readFileSync(path.join(loth, 'theirs.md'), 'utf8'), 'Lothsahn now');
  const log = console.log;
  console.log = () => {};
  let ok: Awaited<ReturnType<typeof call>>;
  try {
    ok = await call(ben.info, { name: 'corrections-log.md' });
  } finally {
    console.log = log;
  }
  assert.equal(ok.isError, false, ok.text);
  assert.equal(fs.readFileSync(file, 'utf8'), LOG);
  // The dispatcher has it too, under the same gate.
  const disp = sessions.get(agents.dispatcherId!);
  assert.ok(agents.orchestratorBelt(disp.info).some((x) => x.name === 'restore_memory'));
  disp.lastFrom = 'system';
  assert.match((await call(disp.info, { name: 'x.md' })).text, /restored only in a turn your person started/);
  // The brief names it.
  assert.match((agents.orchestratorOptions(ben.info) as { systemPrompt: { append: string } }).systemPrompt.append, /MEMORY\.md \(no emptied stubs\)\. Lost by mistake: restore_memory it\./);
});

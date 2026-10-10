import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { neverDelete, type CleanupGuard } from './cleanup.ts';
import { cleanupPass, STALE_OUTPUT_DEFAULTS } from './staleOutput.ts';
import {
  editorFolderOf,
  leaseLive,
  mentions,
  ownRecheck,
  parseWorktreeList,
  planOwnLeftovers,
  planPlayerSlots,
  planUnityEditors,
  planWorktrees,
  playerSlotRoots,
  runOwnLeftovers,
  unityVersionsInUse,
} from './ownLeftovers.ts';

/**
 * FF Factory's own leftovers (w626, server/ownLeftovers.ts): what the daemon's low-space clean-up picks by itself
 * (stale player slots, pushed agent worktrees, unused Unity editors) and what it must keep, laid out as the m3 held them
 * on 2026-10-07 (player slots outside the install folder, an old agent worktree, Unity versions no project used).
 */

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.now();

function tmp(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-own-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function put(file: string, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** `p` and everything under it last changed `ms` ago. */
function age(p: string, ms: number) {
  const t = (NOW - ms) / 1000;
  const walk = (q: string) => {
    const st = fs.lstatSync(q);
    if (st.isDirectory()) for (const n of fs.readdirSync(q)) walk(path.join(q, n));
    fs.utimesSync(q, t, t);
  };
  walk(p);
}

const guardFor = (root: string, keep: string[] = []): CleanupGuard => ({ keep, inUse: [], home: path.join(root, 'home') });

// ---------------------------------------------------------------- player slots

test('a lease holds its slot as player_slots.py judges it: young and alive here, or young elsewhere', () => {
  const o = { host: 'm3', now: NOW, maxAgeHours: 12, alive: (pid: number) => pid === 42 };
  const sec = (msAgo: number) => (NOW - msAgo) / 1000;
  assert.equal(leaseLive({ host: 'm3', pid: 42, time: sec(H) }, o), true);
  assert.equal(leaseLive({ host: 'M3', pid: 7, time: sec(H) }, o), false, 'its pid is gone');
  assert.equal(leaseLive({ host: 'm3', pid: 42, time: sec(13 * H) }, o), false, 'older than the max age');
  assert.equal(leaseLive({ host: 'beast', pid: 7, time: sec(H) }, o), true, "a remote holder's pid means nothing here");
  assert.equal(leaseLive({ host: 'beast', pid: 7, time: sec(13 * H) }, o), false);
  assert.equal(leaseLive({}, o), false);
});

test('player slots: picks the ones nobody holds and nothing touched for a day; keeps held, recent and empty ones', async (t) => {
  const root = tmp(t);
  const slots = path.join(root, 'ffw', 'players');
  const lease = (slot: string, l: object) => put(path.join(slots, slot, 'leases', `${slot}.json`), JSON.stringify(l));
  const sec = (msAgo: number) => (NOW - msAgo) / 1000;
  const fill = (slot: string) => {
    put(path.join(slots, slot, 'player', 'finalfactory.app', 'Contents', 'MacOS', 'finalfactory'), 'build');
    put(path.join(slots, slot, 'slot.json'), '{"state":"ready"}');
  };
  for (const s of ['slot0', 'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6-1']) fill(s);
  lease('slot0', { host: 'm3', pid: 999_999, time: sec(3 * D) }); // dead holder, long ago
  lease('slot1', { host: 'm3', pid: 42, time: sec(2 * H) }); // a running player
  lease('slot2', { host: 'beast', pid: 1, time: sec(2 * H) }); // a remote peer's run
  lease('slot4', { host: 'm3', pid: 42, time: sec(20 * H) }); // alive, but past the 12 h max age
  put(path.join(slots, 'slot5', 'trash-123', 'old.bin'));
  fs.rmSync(path.join(slots, 'slot5', 'player'), { recursive: true });
  put(path.join(slots, 'slot7', 'leases', '.keep')); // an empty slot: nothing to free
  put(path.join(slots, 'notaslot', 'player', 'x.bin')); // not a slot's name
  put(path.join(slots, 'slot8.ffclean-1700000000000', 'player', 'x.bin')); // an interrupted removal
  age(slots, 3 * D);
  fill('slot3'); // filled an hour ago: a run is starting
  age(path.join(slots, 'slot3'), H);

  const plan = await planPlayerSlots({ roots: [slots], guard: guardFor(root), host: 'm3', alive: (pid) => pid === 42, now: NOW });
  const picked = plan.items.map((i) => path.basename(i.path)).sort();
  assert.deepEqual(picked, ['slot0', 'slot4', 'slot5', 'slot6-1', 'slot8.ffclean-1700000000000']);
  assert.ok(plan.items.filter((i) => i.rule === 'player-slot').every((i) => /no live lease/.test(i.why)));

  // A protected path keeps a slot: listed, never picked.
  const kept = await planPlayerSlots({ roots: [slots], guard: guardFor(root, [path.join(slots, 'slot0')]), host: 'm3', alive: () => false, now: NOW });
  assert.ok(!kept.items.some((i) => i.path.endsWith('slot0')));
  assert.ok(kept.listed.some((l) => l.path.endsWith('slot0') && /kept/.test(l.why)));

  // Removed whole, and the next launch makes the folder again (player_slots.py: os.makedirs(<slot>/leases)).
  const r = await runOwnLeftovers(plan, ownRecheck({ guard: guardFor(root), busy: [], host: 'm3', alive: (pid) => pid === 42, procs: async () => [], clock: () => NOW }));
  assert.deepEqual(r.failed, []);
  assert.equal(r.removed.length, 5);
  for (const s of ['slot0', 'slot4', 'slot5', 'slot6-1']) assert.ok(!fs.existsSync(path.join(slots, s)), s);
  for (const s of ['slot1', 'slot2', 'slot3', 'slot7', 'notaslot']) assert.ok(fs.existsSync(path.join(slots, s)), s);
});

test('player slots: the recheck refuses a slot leased between the plan and the removal', async (t) => {
  const root = tmp(t);
  const slots = path.join(root, 'players');
  put(path.join(slots, 'slot0', 'player', 'finalfactory.exe'));
  age(slots, 3 * D);
  const plan = await planPlayerSlots({ roots: [slots], guard: guardFor(root), host: 'beast', alive: () => true, now: NOW });
  assert.equal(plan.items.length, 1);
  put(path.join(slots, 'slot0', 'leases', 'beast-5-abc.json'), JSON.stringify({ host: 'beast', pid: 5, time: NOW / 1000 }));
  const r = await runOwnLeftovers(plan, ownRecheck({ guard: guardFor(root), busy: [], host: 'beast', alive: () => true, procs: async () => [] }));
  assert.equal(r.removed.length, 0);
  assert.match(r.failed[0].why, /refused: held or used/);
  assert.ok(fs.existsSync(path.join(slots, 'slot0', 'player', 'finalfactory.exe')));
});

test("player slot roots: the worker root's and the configured one, only those that exist; the old default places are gone", () => {
  const there = new Set(['/Users/ben/ffw/players', '/Volumes/x/slots']);
  const mac = playerSlotRoots({ platform: 'darwin', home: '/Users/ben', workerRoot: '/Users/ben/ffw', env: {}, read: () => '{"root":"/Volumes/x/slots"}', exists: (p) => there.has(p) });
  assert.deepEqual(mac, ['/Users/ben/ffw/players', '/Volumes/x/slots']);
  const winThere = new Set(['F:\\ffw\\players']);
  const win = playerSlotRoots({ platform: 'win32', home: 'C:\\Users\\b', workerRoot: 'F:\\ffw', env: { ProgramData: 'C:\\ProgramData' }, read: () => '\ufeff{"root":"F:\\\\ffw\\\\players"}', exists: (p) => winThere.has(p) });
  assert.deepEqual(win, ['F:\\ffw\\players']);
});

// ---------------------------------------------------------------- agent worktrees

/** A bare origin, the machine's clone and a sandbox root, with git that commits. */
function repos(root: string) {
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'FinalFactory');
  const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString().trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'develop', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'pipe' });
  git(main, 'switch', '-q', '-c', 'develop');
  put(path.join(main, '.gitignore'), 'Library/\nTemp/\nLogs/\n.claude/worktrees/\n');
  put(path.join(main, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.2f1\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'base');
  git(main, 'push', '-q', '-u', 'origin', 'develop');
  const sbRoot = path.join(root, 'ffsb');
  /** A worktree on a new branch, pushed unless `push` is false. */
  const add = (from: string, at: string, branch: string, push = true) => {
    git(from, 'worktree', 'add', '-q', '-b', branch, at, 'develop');
    put(path.join(at, 'Library', 'Artifacts', 'big.bin'), 'imported'); // ignored: no local work
    if (push) git(at, 'push', '-q', 'origin', branch);
    return at;
  };
  return { origin, main, sbRoot, git, add };
}

/** Everything a worktree's last use is read from (its folder and its git admin folder) last changed `ms` ago. */
function ageWorktree(p: string, ms: number) {
  age(p, ms);
  const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(p, '.git'), 'utf8'))![1].trim();
  age(path.resolve(p, gitdir), ms);
}

test('worktrees: picks old, fully pushed agent worktrees; keeps sandboxes, local work, recent, locked, busy and running ones', async (t) => {
  const root = tmp(t);
  const r = repos(root);
  const sb1 = r.add(r.main, path.join(r.sbRoot, 'slot1'), 'sandbox/slot1');
  const sb2 = r.add(r.main, path.join(r.sbRoot, 'slot2'), 'sandbox/slot2');
  const old = r.add(r.main, path.join(root, 'agent-wt', 'w400'), 'w400-fix'); // the m3's old agent worktree
  const unpushed = r.add(r.main, path.join(root, 'agent-wt', 'w401'), 'w401-wip', false);
  put(path.join(unpushed, 'notes.md'));
  r.git(unpushed, 'add', 'notes.md');
  r.git(unpushed, 'commit', '-q', '-m', 'local only');
  const untracked = r.add(r.main, path.join(root, 'agent-wt', 'w402'), 'w402');
  put(path.join(untracked, 'draft.txt'));
  const recent = r.add(r.main, path.join(root, 'agent-wt', 'w403'), 'w403');
  const locked = r.add(r.main, path.join(root, 'agent-wt', 'w404'), 'w404');
  r.git(r.main, 'worktree', 'lock', locked);
  const running = r.add(r.main, path.join(root, 'agent-wt', 'w405'), 'w405');
  const claudeIdle = r.add(sb2, path.join(sb2, '.claude', 'worktrees', 'tidy'), 'claude-tidy');
  const claudeBusy = r.add(sb1, path.join(sb1, '.claude', 'worktrees', 'busy'), 'claude-busy');
  const forgotten = r.add(r.main, path.join(r.sbRoot, 'slot9'), 'sandbox/slot9'); // a sandbox the pool does not list
  for (const w of [sb1, sb2, old, unpushed, untracked, locked, running, claudeIdle, claudeBusy, forgotten]) ageWorktree(w, 5 * D);
  ageWorktree(recent, 6 * H);

  const guard = guardFor(root, [r.main, r.sbRoot]);
  const plan = await planWorktrees({
    clones: [r.main],
    sandboxes: [sb1, sb2],
    busy: [sb1],
    relax: [r.main, r.sbRoot],
    guard,
    procs: [`"C:/Unity/Editor/Unity.exe" -projectPath ${running}`],
    now: NOW,
  });
  // The inputs keep the temp folder's own form (on Windows CI an 8.3 short name, RUNNER~1) while git reports long paths.
  const name = (p: string) => path.relative(fs.realpathSync.native(root), fs.realpathSync.native(p)).replace(/\\/g, '/');
  assert.deepEqual(plan.items.map((i) => name(i.path)).sort(), ['agent-wt/w400', 'ffsb/slot2/.claude/worktrees/tidy']);
  assert.ok(plan.items.every((i) => i.rule === 'old-worktree' && i.clone === r.main && /everything in it pushed/.test(i.why)));
  assert.deepEqual(plan.listed.map((l) => name(l.path)).sort(), ['agent-wt/w401', 'agent-wt/w402']);
  assert.ok(plan.listed.every((l) => /unpushed work: kept for its owner/.test(l.why)));

  const out = await runOwnLeftovers(plan, ownRecheck({ guard, busy: [sb1], host: 'h', alive: () => true, procs: async () => [] }));
  assert.deepEqual(out.failed, []);
  assert.equal(out.removed.length, 2);
  assert.ok(!fs.existsSync(old) && !fs.existsSync(claudeIdle));
  for (const w of [sb1, sb2, unpushed, untracked, recent, locked, running, claudeBusy, forgotten]) assert.ok(fs.existsSync(w), w);
  // Git's record is pruned; the branches stay (they are on origin anyway).
  const list = parseWorktreeList(r.git(r.main, 'worktree', 'list', '--porcelain'));
  assert.ok(!list.some((w) => /agent-wt\/w400$/.test(w.path.replace(/\\/g, '/'))));
  assert.ok(!list.some((w) => w.prunable));
  assert.match(r.git(r.main, 'branch', '--list', 'w400-fix'), /w400-fix/);
});

test('worktrees: nothing is judged when the process list could not be read', async (t) => {
  const root = tmp(t);
  const r = repos(root);
  const old = r.add(r.main, path.join(root, 'agent-wt', 'w400'), 'w400-fix');
  ageWorktree(old, 5 * D);
  const plan = await planOwnLeftovers({ platform: process.platform, home: path.join(root, 'home'), guard: guardFor(root, [r.main]), slotRoots: [], host: 'h', alive: () => true, clones: [r.main], sandboxes: [], busy: [], relax: [r.main], editorDirs: [], procs: undefined, now: NOW });
  assert.deepEqual(plan.items, []);
});

test('a .claude/worktrees entry is a worktree, not Claude Code settings, only when asked', () => {
  const g: CleanupGuard = { keep: [], inUse: [], home: '/Users/ben' };
  assert.match(neverDelete('/Users/ben/ffw/sandboxes/sb1/.claude/worktrees/tidy', g) ?? '', /Claude Code/);
  assert.equal(neverDelete('/Users/ben/ffw/sandboxes/sb1/.claude/worktrees/tidy', g, { claudeWorktrees: true }), undefined);
  assert.match(neverDelete('/Users/ben/ffw/sandboxes/sb1/.claude/projects', g, { claudeWorktrees: true }) ?? '', /Claude Code/);
  assert.match(neverDelete('/Users/ben/ffw/sandboxes/sb1/.claude/worktrees', g, { claudeWorktrees: true }) ?? '', /Claude Code/);
});

// ---------------------------------------------------------------- Unity editors

test('the Unity versions still needed: projects, the clone and its origin branches, recent projects of a person', async (t) => {
  const root = tmp(t);
  const r = repos(root);
  r.git(r.main, 'switch', '-q', '-c', 'next');
  put(path.join(r.main, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.4.0f1\n');
  r.git(r.main, 'commit', '-q', '-am', 'upgrade');
  r.git(r.main, 'push', '-q', 'origin', 'next:master');
  r.git(r.main, 'fetch', '-q');
  r.git(r.main, 'switch', '-q', 'develop');
  const sb = path.join(root, 'ffsb', 'slot1');
  put(path.join(sb, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.5f1\nm_EditorVersionWithRevision: 6000.3.5f1 (abc)\n');
  const home = path.join(root, 'home');
  put(path.join(home, 'Projects', 'Mine', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.10f1\n');
  put(path.join(home, 'Projects', 'Mine', 'Library', 'ArtifactDB'));
  put(path.join(home, 'Projects', 'Ancient', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2019.4.1f1\n');
  put(path.join(home, 'Projects', 'Ancient', 'Library', 'ArtifactDB'));
  age(path.join(home, 'Projects', 'Ancient'), 400 * D);
  const v = await unityVersionsInUse({ projects: [sb], clones: [r.main], recentRoots: [home], now: NOW });
  assert.deepEqual([...v].sort(), ['2022.3.10f1', '6000.3.2f1', '6000.3.5f1', '6000.4.0f1']);
});

test('Unity editors: picks installed versions nothing needs and nothing runs; keeps the rest; nothing without a known version', async (t) => {
  const root = tmp(t);
  const hub = path.join(root, 'Unity', 'Hub', 'Editor');
  const win = (v: string) => put(path.join(hub, v, 'Editor', 'Unity.exe'));
  const mac = (v: string) => put(path.join(hub, v, 'Unity.app', 'Contents', 'MacOS', 'Unity'));
  win('6000.3.2f1'); // the project's
  win('6000.0.5f1'); // unused
  mac('2021.3.1f1'); // unused (a Mac layout)
  win('2022.3.10f1'); // unused, but an editor runs from it
  win('6000.1.0f1'); // unused, but it holds the machine's unity_path
  put(path.join(hub, '6000.2.0f1', 'modules.json')); // no editor inside: a half install, not judged
  put(path.join(hub, 'Hub', 'x.txt'));
  const guard = guardFor(root, [hub, path.join(hub, '6000.1.0f1', 'Editor', 'Unity.exe')]);
  const procs = [`${path.join(hub, '2022.3.10f1', 'Editor', 'Unity.exe')} -projectPath C:/Users/b/Mine`, `${path.join(hub, '6000.0.5f1')}x\\other.exe`];
  const plan = await planUnityEditors({ editorDirs: [hub, hub], keep: new Set(['6000.3.2f1']), procs, guard });
  assert.deepEqual(plan.items.map((i) => path.basename(i.path)).sort(), ['2021.3.1f1', '6000.0.5f1']);
  assert.ok(plan.items.every((i) => i.rule === 'unity-editor' && /6000\.3\.2f1/.test(i.why)));
  assert.deepEqual(plan.listed.map((l) => path.basename(l.path)).sort(), ['2022.3.10f1', '6000.1.0f1']);

  assert.deepEqual((await planUnityEditors({ editorDirs: [hub], keep: new Set(), procs: [], guard })).items, [], 'no version known: nothing goes');

  // The recheck refuses one an editor started from meanwhile.
  const started = async () => [`${path.join(hub, '6000.0.5f1', 'Editor', 'Unity.exe')} -batchmode`];
  const out = await runOwnLeftovers(plan, ownRecheck({ guard, busy: [], host: 'h', alive: () => true, procs: started }));
  assert.deepEqual(out.removed.map((x) => path.basename(x.path)), ['2021.3.1f1']);
  assert.match(out.failed[0].why, /refused: a process runs from it/);
  assert.ok(fs.existsSync(path.join(hub, '6000.0.5f1')) && fs.existsSync(path.join(hub, '6000.3.2f1')));
});

test('helpers: an editor binary to its version folder; a command line naming a path', () => {
  assert.equal(editorFolderOf('C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.2f1\\Editor\\Unity.exe'), 'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.2f1');
  assert.equal(editorFolderOf('/Applications/Unity/Hub/Editor/6000.3.2f1/Unity.app/Contents/MacOS/Unity'), '/Applications/Unity/Hub/Editor/6000.3.2f1');
  assert.equal(editorFolderOf('/opt/unity/Editor/Unity'), undefined);
  assert.equal(mentions('/x/wt/Editor -projectPath /a/wt', '/a/wt'), true);
  assert.equal(mentions('-projectPath "/a/wt"', '/a/wt'), true);
  assert.equal(mentions('-projectPath /a/wt2', '/a/wt'), false);
});

// ---------------------------------------------------------------- in the pass

test('the pass: own leftovers are planned in a dry run and removed in a real one; a failure there spares the regular pass', async (t) => {
  const root = tmp(t);
  const slots = path.join(root, 'players');
  put(path.join(slots, 'slot0', 'player', 'finalfactory.exe'), 'x'.repeat(1000));
  age(slots, 3 * D);
  const guard = guardFor(root);
  const own = {
    plan: () => planPlayerSlots({ roots: [slots], guard, host: 'h', alive: () => false, now: NOW }),
    run: (p: Awaited<ReturnType<typeof planPlayerSlots>>) => runOwnLeftovers(p, async () => undefined),
  };
  const base = { guard, mode: STALE_OUTPUT_DEFAULTS.mode, regular: async () => [], stale: async () => ({ items: [], listed: [] }) };
  const dry = await cleanupPass({ ...base, opts: { stale: false, dryRun: true }, own });
  assert.equal(dry.planned?.length, 1);
  assert.equal(dry.planned?.[0].rule, 'player-slot');
  assert.ok(fs.existsSync(path.join(slots, 'slot0')));
  const real = await cleanupPass({ ...base, opts: { stale: false, dryRun: false }, own });
  assert.equal(real.removed.length, 1);
  assert.ok(real.bytes >= 1000);
  assert.ok(!fs.existsSync(path.join(slots, 'slot0')));
  const broken = await cleanupPass({ ...base, opts: { stale: false, dryRun: false }, own: { plan: async () => Promise.reject(new Error('boom')), run: own.run } });
  assert.deepEqual(broken.failed, []);
});

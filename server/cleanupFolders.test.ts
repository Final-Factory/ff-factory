import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasLocalWork, localRemotePath, localWorkWhy, norm } from './cleanup.ts';
import { FACTS_MAX_AGE_MS, factsProblem, judgePath, judgeSession, judgeTiming, planFolders, renderFolders, type CleanupFacts } from './cleanupFolders.ts';
import { ownersOf } from './resumable.ts';
import { foldersMain, hostSessionsIn, installLeftoversShim, slotContext, slotPathOf } from '../machine/leftovers.ts';
import type { WorkItem } from '../shared/types.ts';

/**
 * w1379: a clean-up deletes only the folders of closed requests and orphans, judged by the ledger, never by a list in a
 * brief. 2026-10-15, w1374 (LothDesktop's low-disk clean-up) deleted the temp folder of stopped worker a735f37c: the builds
 * and preview clips of w1332 (comet catch tail), stalled on a usage limit that day and then waiting for Ben's OK.
 */
const item = (id: string, status: WorkItem['status'], sessionIds: string[]) => ({ id, status, sessionIds }) as WorkItem;

// The three workers of the request: a735f37c is stopped on w1332 (stalled), b0b0b0b0 stopped on w900 (done), c1c1c1c1 is on
// nothing the ledger knows (an orphan). d2d2d2d2 runs now.
const WORK = [item('w1332', 'stalled', ['a735f37c']), item('w900', 'done', ['b0b0b0b0']), item('w1400', 'active', ['d2d2d2d2'])];

function world(t: { after: (fn: () => void) => void }, over: Partial<CleanupFacts> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w1379-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, 'tmp');
  const mk = (rel: string) => {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, 'player.bin'), 'x'.repeat(100));
    return path.join(root, rel);
  };
  for (const sid of ['a735f37c', 'b0b0b0b0', 'c1c1c1c1', 'd2d2d2d2']) mk(`tmp/ffa-${sid}/builds`);
  mk('scratch/w1332-clips');
  mk('scratch/w900-old');
  mk('scratch/w77-gone');
  mk('scratch/loose');
  mk('sandboxes/slot1/Builds/cache/abc');
  mk('sandboxes/slot1/Library/x');
  mk('sandboxes/slot2/.nightly-builds/cache/def');
  const owners = ownersOf(
    [{ id: 'a735f37c', machineSandbox: 'slot1' }, { id: 'b0b0b0b0' }, { id: 'c1c1c1c1' }, { id: 'd2d2d2d2', machineSandbox: 'slot2' }],
    WORK,
  );
  const facts: CleanupFacts = {
    // A second ahead of the folders made above: a folder's fractional mtimeMs in the same millisecond is later than a
    // truncated `at`, and sessionSeen (w3217) then keeps it as made after the facts (flaky on CI, PR ff-factory#840).
    at: new Date(Date.now() + 1000).toISOString(),
    connected: true,
    root,
    tempRoot,
    sandboxes: [{ id: 'slot1', path: path.join(root, 'sandboxes', 'slot1') }, { id: 'slot2', path: path.join(root, 'sandboxes', 'slot2') }],
    live: ['d2d2d2d2'],
    resumable: ['a735f37c', 'd2d2d2d2'],
    owners,
    open: ['w1332', 'w1400'],
    closed: ['w900', 'w77'],
    contextAt: new Date().toISOString(),
    ...over,
  };
  return { root, tempRoot, facts };
}

test('w1379: ownersOf names a session only while a request it is on has not closed, with every request of it', () => {
  const o = ownersOf(
    [{ id: 'a735f37c', machineSandbox: 'slot1' }, { id: 'b0b0b0b0' }, { id: 'c1c1c1c1' }, { id: 'e3e3e3e3' }],
    [...WORK, item('w800', 'done', ['e3e3e3e3', 'a735f37c']), item('w801', 'blocked', ['e3e3e3e3', 'f4f4f4f4'])],
  );
  assert.deepEqual(Object.keys(o).sort(), ['a735f37c', 'e3e3e3e3']);
  assert.deepEqual(o.a735f37c, { sandbox: 'slot1', requests: [{ id: 'w1332', status: 'stalled', with: true }, { id: 'w800', status: 'done', with: true }] });
  // e3e3e3e3 was on w801 first and moved on: the request is open but no longer with it.
  assert.deepEqual(o.e3e3e3e3!.requests, [{ id: 'w800', status: 'done', with: false }, { id: 'w801', status: 'blocked', with: false }]);
});

test('w1379: a stopped worker on an open request is kept, a worker on a closed request and an orphan are deleted', async (t) => {
  const { tempRoot, facts } = world(t);
  const at = (sid: string) => judgePath(path.join(tempRoot, `ffa-${sid}`, 'builds'), facts);
  const stalled = at('a735f37c');
  assert.equal(stalled.verdict, 'keep');
  assert.match(stalled.why, /stopped worker a735f37c is still on w1332 \(stalled\)/);
  assert.equal(at('b0b0b0b0').verdict, 'delete', 'its only request closed');
  assert.equal(at('c1c1c1c1').verdict, 'delete', 'no request names it: an orphan');
  assert.match(at('c1c1c1c1').why, /orphan/);
  assert.equal(at('d2d2d2d2').verdict, 'keep', 'running now');

  const rows = await planFolders(facts);
  const verdict = (name: string) => rows.find((r) => r.path.endsWith(name))?.verdict;
  assert.equal(verdict('ffa-a735f37c'), 'keep');
  assert.equal(verdict('ffa-b0b0b0b0'), 'delete');
  assert.equal(verdict('ffa-c1c1c1c1'), 'delete');
  assert.equal(rows.find((r) => r.path.endsWith('ffa-b0b0b0b0'))!.bytes, 100, 'the deletable ones are measured');
  const text = renderFolders(rows, facts);
  assert.match(text, /KEEP .*ffa-a735f37c\n\s+stopped worker a735f37c is still on w1332 \(stalled\)/);
  assert.match(text, /DELETE .*ffa-b0b0b0b0/);
});

test('w1379: a worker handed off its open request keeps its folders too: the request has not closed', () => {
  const o = ownersOf([{ id: 'old00001' }], [item('w50', 'active', ['old00001', 'new00002'])]);
  const f = { owners: o, live: [], resumable: [] } as unknown as CleanupFacts;
  const j = judgeSession('old00001', f);
  assert.equal(j.verdict, 'keep');
  assert.match(j.why, /moved on to another worker/);
});

test("w1379: scratch folders are judged by the requests in their names; a sandbox's output by its workers", async (t) => {
  const { facts } = world(t);
  const rows = await planFolders(facts);
  const v = (suffix: string) => rows.find((r) => r.path.replace(/\\/g, '/').endsWith(suffix));
  assert.equal(v('scratch/w1332-clips')!.verdict, 'keep');
  assert.equal(v('scratch/w900-old')!.verdict, 'delete');
  assert.equal(v('scratch/w77-gone')!.verdict, 'delete');
  assert.equal(v('scratch/loose')!.verdict, 'keep', 'names no request: cannot be attributed');
  // slot1 holds a735f37c's request (stalled, stopped): its build cache stays. slot2 has d2d2d2d2 running.
  assert.equal(v('slot1/Builds/cache')!.verdict, 'keep');
  assert.match(v('slot1/Builds/cache')!.why, /w1332/);
  assert.equal(v('slot2/.nightly-builds/cache')!.verdict, 'keep');
  assert.ok(!rows.some((r) => r.path.replace(/\\/g, '/').includes('/Library')), 'Library is never a candidate');
  // The same sandbox once its worker's request closed.
  const closed = { ...facts, owners: ownersOf([{ id: 'a735f37c', machineSandbox: 'slot1' }], [item('w1332', 'done', ['a735f37c'])]), live: [], resumable: [] };
  const again = await planFolders(closed);
  assert.equal(again.find((r) => r.path.replace(/\\/g, '/').endsWith('slot1/Builds/cache'))!.verdict, 'delete');
});

test('w1379: nothing is deleted on facts that are missing, old, offline, without owners, or for a path outside the install folder', async (t) => {
  const { root, tempRoot, facts } = world(t);
  const orphan = path.join(tempRoot, 'ffa-c1c1c1c1');
  assert.equal(judgePath(orphan, facts).verdict, 'delete', 'the control: an orphan goes on good facts');
  const old = { ...facts, at: new Date(Date.now() - FACTS_MAX_AGE_MS - 60_000).toISOString() };
  const offline = { ...facts, connected: false };
  const noOwners = { ...facts, owners: undefined };
  const noRoot = { ...facts, root: undefined };
  for (const [name, f, why] of [['old', old, /old/], ['offline', offline, /not connected/], ['no owners', noOwners, /predates w1379/], ['no root', noRoot, /no worker install folder/]] as const) {
    assert.equal(judgePath(orphan, f).verdict, 'keep', name);
    assert.match(factsProblem(f)!, why, name);
    const rows = await planFolders(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.verdict, 'keep');
    assert.match(renderFolders(rows, f), /Nothing may be deleted/);
  }
  assert.match(factsProblem(undefined)!, /no ledger facts/);
  // Outside the install folder (w896), the folder itself and the daemon's own are not candidates either.
  assert.match(judgePath(path.join(os.homedir(), 'AppData'), facts).why, /outside the worker install folder/);
  assert.equal(judgePath(root, facts).verdict, 'keep');
  assert.equal(judgePath(path.join(root, 'daemon', 'x'), facts).verdict, 'keep');
});

test('w1379: ff-leftovers folders and check read the daemon\'s facts file; check exits 1 when any path is to be kept', async (t) => {
  const { tempRoot, facts } = world(t);
  const file = path.join(tempRoot, '..', 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const out: string[] = [];
  const say = (s: string) => void out.push(s);
  const env = { FF_CLEANUP_FACTS: file } as NodeJS.ProcessEnv;
  const codes = [
    await foldersMain('check', [path.join(tempRoot, 'ffa-b0b0b0b0'), path.join(tempRoot, 'ffa-c1c1c1c1', 'builds')], env, Date.now(), say),
    await foldersMain('check', [path.join(tempRoot, 'ffa-b0b0b0b0'), path.join(tempRoot, 'ffa-a735f37c')], env, Date.now(), say),
    await foldersMain('folders', [], env, Date.now(), say),
    await foldersMain('check', [path.join(tempRoot, 'ffa-b0b0b0b0')], {} as NodeJS.ProcessEnv, Date.now(), say),
  ];
  assert.deepEqual(codes, [0, 1, 0, 1], 'closed + orphan: 0; one kept: 1; the listing: 0; no facts file: 1');
  const text = out.join('');
  assert.match(text, /KEEP .*ffa-a735f37c/);
  assert.match(text, /no ledger facts on this machine/);
});

test('w1379: the shim hands the facts file to the command', (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w1379-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  installLeftoversShim(bin, 'node', [], 'leftovers.ts', path.join(bin, 'cleanup-facts.json'));
  assert.match(fs.readFileSync(path.join(bin, 'ff-leftovers'), 'utf8'), /FF_CLEANUP_FACTS=".*cleanup-facts\.json"\nexport FF_CLEANUP_FACTS\n/);
  assert.match(fs.readFileSync(path.join(bin, 'ff-leftovers.cmd'), 'utf8'), /set "FF_CLEANUP_FACTS=.*cleanup-facts\.json"/);
});

/**
 * w1387: the ledger is not a clone's only owner. 2026-10-15, w1385 (LothDesktop's next low-disk clean-up) deleted
 * V:\ffw\tmp\ffa-31ffe8cc on a DELETE row (its request w1367 was done) while the portal's clean-up had kept it three times
 * that evening: "holds a git repo with uncommitted or unpushed work (...\ffa-31ffe8cc\ff)". A clone with work on no remote
 * now keeps its folder in `folders` and `check`, with the repo and what it holds, as the portal's sweeps keep it.
 */
function git(cwd: string, ...a: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A bare remote and a clone of it at `dir` with one pushed commit: no local work. */
function pushedClone(remotes: string, dir: string) {
  const bare = path.join(remotes, `${path.basename(path.dirname(dir))}-${path.basename(dir)}.git`);
  git(remotes, 'init', '-q', '--bare', bare);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(path.dirname(dir), 'clone', '-q', bare, dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'Builds/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  git(dir, 'push', '-q', 'origin', 'HEAD');
  return dir;
}

test('w1387: localWorkWhy names uncommitted changes, commits on no remote and stashes; a pushed clone holds none', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w1387-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const remotes = path.join(base, 'remotes');
  fs.mkdirSync(remotes);
  const clean = pushedClone(remotes, path.join(base, 'clean', 'ff'));
  assert.equal(await localWorkWhy(clean), undefined);

  const dirty = pushedClone(remotes, path.join(base, 'dirty', 'ff'));
  fs.writeFileSync(path.join(dirty, 'report.md'), 'the report\n');
  assert.equal(await localWorkWhy(dirty), '1 uncommitted change');

  const ahead = pushedClone(remotes, path.join(base, 'ahead', 'ff'));
  for (const n of ['b', 'c']) {
    fs.writeFileSync(path.join(ahead, `${n}.txt`), n);
    git(ahead, 'add', '.');
    git(ahead, 'commit', '-q', '-m', n);
  }
  assert.equal(await localWorkWhy(ahead), '2 commits on no remote');

  const stashed = pushedClone(remotes, path.join(base, 'stashed', 'ff'));
  fs.writeFileSync(path.join(stashed, 'a.txt'), 'changed\n');
  git(stashed, 'stash', 'push', '-q', '-m', 'set aside');
  assert.equal(await localWorkWhy(stashed), '1 stash');
  assert.equal(await hasLocalWork(stashed), true, "the portal's sweeps keep a stash too");

  // A linked worktree shares its main clone's stashes: they keep the main clone, not the worktree.
  const wt = path.join(base, 'stashed', 'wt');
  git(stashed, 'worktree', 'add', '-q', '--detach', wt);
  assert.equal(await localWorkWhy(wt), undefined);

  assert.match((await localWorkWhy(path.join(base, 'no-such-repo')))!, /could not be read/, 'unknown counts as work');
});

function dropRemoteRefs(dir: string) {
  for (const r of execFileSync('git', ['-C', dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)) git(dir, 'update-ref', '-d', r);
}

test('w3180: commits a remote holds now are not "on no remote", though the clone never fetched them', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w3180-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const remotes = path.join(base, 'remotes');
  fs.mkdirSync(remotes);
  // A sandbox whose origin is a bare "GitHub"; a scratch clone of the sandbox, detached at the sandbox's commit X.
  const sandbox = pushedClone(remotes, path.join(base, 'sb', 'ff'));
  fs.writeFileSync(path.join(sandbox, 'x.txt'), 'x');
  git(sandbox, 'add', '.');
  git(sandbox, 'commit', '-q', '-m', 'x');
  const x = execFileSync('git', ['-C', sandbox, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const scratch = path.join(base, 'tmp', 'scratch');
  git(base, 'clone', '-q', '--shared', sandbox, scratch);
  git(scratch, 'checkout', '-q', '--detach', x);
  git(sandbox, 'checkout', '-q', '--detach', 'HEAD~1'); // the sandbox moves on: no ref of it names X any more
  git(sandbox, 'branch', '-q', '-D', 'main');
  dropRemoteRefs(scratch); // its snapshot of the sandbox's heads is stale
  assert.equal(await localWorkWhy(scratch), '1 commit on no remote', 'X is not pushed yet');

  git(sandbox, 'push', '-q', 'origin', `${x}:refs/heads/pushed`);
  assert.equal(await localWorkWhy(scratch), undefined, "X is on the sandbox's origin now (its refs/remotes)");

  // The same through a file:// URL to the bare repo, with the clone's own remote refs stale.
  const viaUrl = path.join(base, 'tmp', 'via-url');
  git(base, 'clone', '-q', sandbox, viaUrl);
  git(viaUrl, 'checkout', '-q', '--detach', x);
  const bare = execFileSync('git', ['-C', sandbox, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  git(viaUrl, 'remote', 'set-url', 'origin', 'file:///' + path.resolve(bare).replace(/\\/g, '/').replace(/^\//, ''));
  git(viaUrl, 'update-ref', '-d', 'refs/remotes/origin/HEAD');
  for (const r of execFileSync('git', ['-C', viaUrl, 'for-each-ref', '--format=%(refname)', 'refs/remotes'], { encoding: 'utf8' }).split('\n').filter(Boolean)) git(viaUrl, 'update-ref', '-d', r);
  assert.equal(await localWorkWhy(viaUrl), undefined, 'X is in the bare repo the file:// URL names');
  fs.writeFileSync(path.join(viaUrl, 'y.txt'), 'y');
  git(viaUrl, 'add', '.');
  git(viaUrl, 'commit', '-q', '-m', 'y');
  assert.equal(await localWorkWhy(viaUrl), '1 commit on no remote', 'a commit no remote has still counts');
});

test('w3180: localRemotePath tells a local remote from a network one', () => {
  assert.equal(localRemotePath('https://github.com/Final-Factory/ff-factory.git', '/x'), undefined);
  assert.equal(localRemotePath('git@github.com:Final-Factory/ff-factory.git', '/x'), undefined);
  assert.equal(localRemotePath('ssh://host/repo', '/x'), undefined);
  assert.equal(localRemotePath('file:///F:/ffw/repo', '/x'), 'F:/ffw/repo');
  assert.equal(localRemotePath('F:/ffw/sandboxes/slot2', '/x'), path.resolve('/x', 'F:/ffw/sandboxes/slot2'));
  assert.equal(localRemotePath('../sb', path.resolve('/a/b')), path.resolve('/a/sb'));
});

test('w1387: a folder the ledger frees stays KEEP while a git repo in it holds work on no remote; check exits 1 and says why', async (t) => {
  const { root, tempRoot, facts } = world(t);
  const remotes = path.join(root, 'remotes');
  fs.mkdirSync(remotes);
  // b0b0b0b0's request closed and c1c1c1c1 is an orphan: both DELETE by the ledger (the w1379 control above).
  const closed = path.join(tempRoot, 'ffa-b0b0b0b0');
  const orphan = path.join(tempRoot, 'ffa-c1c1c1c1');
  // b0b0b0b0 left a clone with a report it never committed, as 31ffe8cc's ff clone was kept for.
  const ff = pushedClone(remotes, path.join(closed, 'ff'));
  fs.writeFileSync(path.join(ff, 'report.md'), 'x');
  // c1c1c1c1's clone, three levels down, is pushed and clean: nothing to lose.
  const deep = pushedClone(remotes, path.join(orphan, 'legs', 'leg1', 'game'));
  // The daemon writes its facts after the folders were last written (w3217 keeps a folder written after them).
  facts.at = new Date(Date.now() + 1000).toISOString();

  const rows = await planFolders(facts, { now: Date.now() + 1000 });
  const row = (p: string) => rows.find((r) => norm(r.path) === norm(p))!;
  assert.equal(row(closed).verdict, 'keep');
  assert.match(row(closed).why, /holds a git repo with uncommitted or unpushed work \(.*ff: 1 uncommitted change\)/);
  assert.match(row(closed).why, /The ledger alone said: no open, stalled or paused request names worker b0b0b0b0/);
  assert.equal(row(orphan).verdict, 'delete', 'a pushed, clean clone loses nothing');
  assert.match(renderFolders(rows, facts), /KEEP .*ffa-b0b0b0b0\n\s+holds a git repo/);

  // Unpushed commits, a stash, and a clone nested deeper than the portal's one level each keep it too.
  git(ff, 'add', '.');
  git(ff, 'commit', '-q', '-m', 'report');
  assert.match((await planFolders(facts)).find((r) => norm(r.path) === norm(closed))!.why, /1 commit on no remote/);
  fs.writeFileSync(path.join(deep, 'a.txt'), 'changed\n');
  git(deep, 'stash', 'push', '-q');
  const o = (await planFolders(facts)).find((r) => norm(r.path) === norm(orphan))!;
  assert.equal(o.verdict, 'keep');
  assert.match(o.why, /game: 1 stash/);

  // `check` on the folder, and on a path inside the clone (the clone around it), says KEEP and exits 1.
  const file = path.join(root, 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const out: string[] = [];
  const say = (s: string) => void out.push(s);
  const env = { FF_CLEANUP_FACTS: file } as NodeJS.ProcessEnv;
  assert.equal(await foldersMain('check', [closed], env, Date.now(), say), 1);
  fs.mkdirSync(path.join(ff, 'notes'));
  fs.writeFileSync(path.join(ff, 'notes', 'brief.md'), 'job brief');
  assert.equal(await foldersMain('check', [path.join(ff, 'notes')], env, Date.now(), say), 1);
  assert.match(out.join(''), /KEEP .*notes\n\s+holds a git repo .*\(around it\)/);
  // An ignored folder inside the clone (its Builds/) takes nothing git holds: the ledger's verdict stands.
  fs.mkdirSync(path.join(ff, 'Builds', 'x'), { recursive: true });
  assert.equal(await foldersMain('check', [path.join(ff, 'Builds')], env, Date.now(), say), 0);
});

test("w1387: a sandbox's ignored build output stays deletable though the sandbox's own worktree has work", async (t) => {
  const { root, facts } = world(t);
  const remotes = path.join(root, 'remotes');
  fs.mkdirSync(remotes);
  // slot1 becomes a clone whose Builds/ git ignores, with uncommitted work of its own; its worker's request closes.
  const sb = path.join(root, 'sandboxes', 'slot1');
  const held = path.join(root, 'held');
  fs.renameSync(sb, held);
  pushedClone(remotes, sb);
  fs.renameSync(path.join(held, 'Builds'), path.join(sb, 'Builds'));
  fs.writeFileSync(path.join(sb, 'a.txt'), 'in progress\n');
  const closed = { ...facts, owners: ownersOf([{ id: 'a735f37c', machineSandbox: 'slot1' }], [item('w1332', 'done', ['a735f37c'])]), live: [], resumable: [] };
  const rows = await planFolders(closed);
  assert.equal(rows.find((r) => norm(r.path).endsWith('slot1/builds/cache'))!.verdict, 'delete');
});

test('w1755: on a Windows install, ff-leftovers check keeps a path on C: without looking at it', async (t) => {
  const { tempRoot, facts } = world(t);
  const file = path.join(tempRoot, '..', 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify({ ...facts, root: 'V:\\ffw' }));
  const out: string[] = [];
  const code = await foldersMain('check', ['C:\\Users\\loth\\AppData\\Local', '/c/Users/loth/.claude'], { FF_CLEANUP_FACTS: file } as NodeJS.ProcessEnv, Date.now(), (s) => void out.push(s));
  assert.equal(code, 1);
  const text = out.join('');
  assert.equal(text.match(/^KEEP /gm)?.length, 2, text);
  assert.match(text, /not looked at: off this Windows computer's install drive V:; disk work never reads, measures or touches C: \(w1755\)/);
});

test("w1755: ff-leftovers check of the game's AppData Never Games folder says KEEP: read-only, never deleted", async (t) => {
  const { tempRoot, facts } = world(t);
  const file = path.join(tempRoot, '..', 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify({ ...facts, root: 'V:\\ffw' }));
  const out: string[] = [];
  const env = { FF_CLEANUP_FACTS: file, USERPROFILE: 'C:\\Users\\loth' } as NodeJS.ProcessEnv;
  const code = await foldersMain('check', ['C:\\Users\\loth\\AppData\\LocalLow\\Never Games\\finalfactory\\PlaytestSessions', 'C:\\Users\\loth\\AppData\\LocalLow\\Unity'], env, Date.now(), (s) => void out.push(s));
  assert.equal(code, 1);
  const text = out.join('');
  assert.equal(text.match(/^KEEP /gm)?.length, 2, text);
  assert.match(text, /the game's data folder under AppData \(Never Games\): read-only, never deleted, moved or written by a clean-up \(w1755\)/);
  assert.match(text, /not looked at: off this Windows computer's install drive V:/);
});

/**
 * w2796: `ff-leftovers check` called every V:\ffw\players\slotN-M "not a place with an owner in the ledger", and w2795's worker
 * read the pool's lease files by hand to find nine free slots (about 17 GB). A slot is now judged by its own leases.
 */
test('w2796: a player slot is KEEP while leased, filling or played from, and DELETE when no live lease holds it', async (t) => {
  const { root, facts } = world(t);
  const NOW = Date.now();
  const slot = (name: string, o: { leases?: object[]; marker?: object } = {}) => {
    const d = path.join(root, 'players', name);
    fs.mkdirSync(path.join(d, 'player'), { recursive: true });
    fs.mkdirSync(path.join(d, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(d, 'player', 'FinalFactory.exe'), 'x');
    fs.writeFileSync(path.join(d, 'slot.json'), JSON.stringify(o.marker ?? { state: 'ready', sha: 'abc', used: NOW / 1000 }));
    (o.leases ?? []).forEach((l, i) => fs.writeFileSync(path.join(d, 'leases', `l${i}.json`), JSON.stringify(l)));
    return d;
  };
  const t0 = NOW / 1000;
  const leased = slot('slot0', { leases: [{ pid: 42, host: 'lothdesktop', time: t0 - 60, session: 'a735f37c' }] });
  const dead = slot('slot1', { leases: [{ pid: 7, host: 'lothdesktop', time: t0 - 60 }] });
  const old = slot('slot2-1', { leases: [{ pid: 42, host: 'lothdesktop', time: t0 - 13 * 3600 }] });
  const remote = slot('slot3', { leases: [{ pid: 9, host: 'm5', time: t0 - 600 }] });
  const filling = slot('slot4', { marker: { state: 'filling', filled: t0 - 30 } });
  const played = slot('slot5-2');
  const empty = slot('slot6');
  const ctx = { host: 'lothdesktop', alive: (pid: number) => pid === 42, procs: [`"${path.join(played, 'player', 'FinalFactory.exe')}" -screen-fullscreen 0`] };
  const at = (p: string, c: typeof ctx | undefined = ctx) => judgePath(p, facts, NOW, c);
  assert.equal(at(leased).verdict, 'keep');
  assert.match(at(leased).why, /leased now \(worker a735f37c on lothdesktop pid 42\)/);
  assert.equal(at(remote).verdict, 'keep', "a remote holder's lease holds by its age alone");
  assert.equal(at(filling).verdict, 'keep');
  assert.match(at(filling).why, /filling/);
  assert.equal(at(played).verdict, 'keep');
  assert.match(at(played).why, /running process plays from it/);
  for (const p of [dead, old, empty]) {
    assert.equal(at(p).kind, 'player-slot');
    assert.equal(at(p).verdict, 'delete', p);
    assert.match(at(p).why, /no live lease holds/);
  }
  // A path inside a slot takes the slot's verdict; without the context, or the process list, nothing is deleted.
  assert.equal(at(path.join(dead, 'player', 'FinalFactory.exe')).verdict, 'delete');
  assert.equal(judgePath(dead, facts, NOW).verdict, 'keep');
  assert.equal(at(dead, { ...ctx, procs: undefined as unknown as string[] }).verdict, 'keep');
  assert.equal(judgePath(path.join(root, 'players', 'slots.lock'), facts, NOW, ctx).verdict, 'keep');

  // `folders` lists every slot with its verdict; `check` agrees and exits 1 on a leased one.
  const rows = await planFolders(facts, { now: NOW, sizes: 'none', slots: ctx });
  const slotRows = Object.fromEntries(rows.filter((r) => r.kind === 'player-slot').map((r) => [path.basename(r.path), r.verdict]));
  assert.deepEqual(slotRows, { slot0: 'keep', slot1: 'delete', 'slot2-1': 'delete', slot3: 'keep', slot4: 'keep', 'slot5-2': 'keep', slot6: 'delete' });
  const file = path.join(root, 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const out: string[] = [];
  const env = { FF_CLEANUP_FACTS: file } as NodeJS.ProcessEnv;
  const say = (s: string) => void out.push(s);
  assert.equal(await foldersMain('check', [dead, empty], env, NOW, say, async () => ctx), 0);
  assert.equal(await foldersMain('check', [dead, leased], env, NOW, say, async () => ctx), 1);
  assert.match(out.join(''), /KEEP .*slot0/);
});

/**
 * w3204: on LothDesktop, 2026-11-06, `ff-leftovers folders` listed every player slot DELETE and `check <slot>` answered KEEP
 * "a running process plays from it" for each, one that did not exist included: the process naming the slot was the check's
 * own command line (node leftovers.ts check <slot>). Run as the real command, so the check's own process is in the list.
 */
test('w3204: check, run as the command, judges an idle ready slot DELETE as folders does; its own command line plays from nothing', async (t) => {
  const { root, facts } = world(t);
  const slotDir = (name: string, leases: object[] = []) => {
    const d = path.join(root, 'players', name);
    fs.mkdirSync(path.join(d, 'player'), { recursive: true });
    fs.mkdirSync(path.join(d, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(d, 'player', 'FinalFactory.exe'), 'x');
    fs.writeFileSync(path.join(d, 'slot.json'), JSON.stringify({ state: 'ready', sha: 'abc', used: Date.now() / 1000 }));
    leases.forEach((l, i) => fs.writeFileSync(path.join(d, 'leases', `l${i}.json`), JSON.stringify(l)));
    return d;
  };
  const idle = slotDir('slot1-1');
  const leased = slotDir('slot4-1', [{ pid: process.pid, host: os.hostname().toLowerCase(), time: Date.now() / 1000 - 60, session: '00981797' }]);
  const file = path.join(root, 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const cli = path.join(import.meta.dirname, '..', 'machine', 'leftovers.ts');
  const runCli = (...args: string[]) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { env: { ...process.env, FF_CLEANUP_FACTS: file }, encoding: 'utf8' }) };
    } catch (e) {
      return { code: (e as { status: number }).status, out: String((e as { stdout: string }).stdout) };
    }
  };
  const idleCheck = runCli('check', idle);
  assert.equal(idleCheck.code, 0, idleCheck.out);
  assert.match(idleCheck.out, /DELETE .*slot1-1\s+a player slot no live lease holds/);
  const leasedCheck = runCli('check', leased);
  assert.equal(leasedCheck.code, 1, leasedCheck.out);
  assert.match(leasedCheck.out, /KEEP .*slot4-1\s+a player slot leased now \(worker 00981797/);

  // remove-slot, the supported delete: the idle slot is emptied (its folder stays for its path and firewall rule); the leased one is untouched.
  const removed = runCli('remove-slot', idle, leased);
  assert.equal(removed.code, 1, removed.out);
  assert.match(removed.out, /REMOVED .*slot1-1/);
  assert.match(removed.out, /KEEP .*slot4-1\s+not removed: a player slot leased now/);
  assert.deepEqual(fs.readdirSync(idle).sort(), ['leases']);
  assert.ok(fs.existsSync(path.join(leased, 'player', 'FinalFactory.exe')));
  assert.ok(fs.existsSync(path.join(leased, 'slot.json')));
});

test('w3204: slotContext leaves out this process and the shells that ran it, never a player under the slot', async () => {
  const slot = path.join(os.tmpdir(), 'ffw', 'players', 'slot6-0');
  const procs = [
    { pid: 100, ppid: 1, cmd: 'claude.exe' },
    { pid: 200, ppid: 100, cmd: `bash -c "ff-leftovers check ${slot}"` },
    { pid: 250, ppid: 200, cmd: `/bin/sh ff-leftovers check ${slot}` },
    { pid: 300, ppid: 250, cmd: `node --experimental-strip-types leftovers.ts check ${slot}` },
    { pid: 500, ppid: 1, cmd: `"${path.join(slot, 'player', 'FinalFactory.exe')}" -batchmode` },
  ];
  const ctx = await slotContext({ procs: async () => procs, self: 300, callers: [250] });
  assert.deepEqual(ctx.procs, [procs[4]!.cmd], 'the whole chain above the check is left out, the player is not');
  // A lost ppid (an MSYS parent): the shim's caller list still drops the shells.
  const lost = await slotContext({ procs: async () => procs.map((p) => (p.pid === 300 ? { ...p, ppid: 9999 } : p)), self: 300, callers: [250, 200] });
  assert.deepEqual(lost.procs, [procs[4]!.cmd]);
  assert.equal((await slotContext({ procs: async () => { throw new Error('no ps'); } })).procs, undefined);
});

test('w3204: remove-slot refuses a slot a process plays from, a path inside a slot, and anything that is not a slot', async (t) => {
  const { root, facts } = world(t);
  const d = path.join(root, 'players', 'slot2-0');
  fs.mkdirSync(path.join(d, 'player'), { recursive: true });
  fs.mkdirSync(path.join(d, 'leases'), { recursive: true });
  fs.writeFileSync(path.join(d, 'player', 'FinalFactory.exe'), 'x');
  fs.writeFileSync(path.join(d, 'slot.json'), JSON.stringify({ state: 'ready' }));
  const file = path.join(root, 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const env = { FF_CLEANUP_FACTS: file } as NodeJS.ProcessEnv;
  const out: string[] = [];
  const say = (s: string) => void out.push(s);
  const playing = { host: 'lothdesktop', alive: () => false, procs: [`"${path.join(d, 'player', 'FinalFactory.exe')}" -screen-fullscreen 0`] };
  assert.equal(await foldersMain('remove-slot', [d], env, Date.now(), say, async () => playing), 1);
  assert.match(out.join(''), /KEEP .*slot2-0\s+not removed: a player slot no lease holds, but a running process plays from it/);
  assert.ok(fs.existsSync(path.join(d, 'player', 'FinalFactory.exe')));
  // A process that shows up between the two looks: the player folder is put back.
  let looks = 0;
  const late = async () => ({ host: 'lothdesktop', alive: () => false, procs: looks++ ? playing.procs : [] });
  assert.equal(await foldersMain('remove-slot', [d], env, Date.now(), say, late), 1);
  assert.match(out.join(''), /put back/);
  assert.ok(fs.existsSync(path.join(d, 'player', 'FinalFactory.exe')));
  const idle = async () => ({ host: 'lothdesktop', alive: () => false, procs: [] });
  out.length = 0;
  assert.equal(await foldersMain('remove-slot', [path.join(d, 'player'), path.join(root, 'scratch', 'w77-gone')], env, Date.now(), say, idle), 1);
  assert.equal(out.join('').match(/not a player slot folder/g)?.length, 2, out.join(''));
  assert.ok(fs.existsSync(path.join(d, 'player', 'FinalFactory.exe')));
  assert.equal(await foldersMain('remove-slot', [d], env, Date.now(), say, idle), 0);
  assert.deepEqual(fs.readdirSync(d), ['leases']);
});

/**
 * w3217: on LothDesktop, 2026-11-06 17:49, w3213's clean-up (worker 9aad7b21) ran `ff-leftovers folders` 44 s after its
 * session started; the facts it read predated the session, so its own temp folder was DELETE ("no open, stalled or paused
 * request names worker 9aad7b21") and it removed it. A running session's folder is KEEP whatever the facts say.
 */
test("w3217: a running session's ffa folder is KEEP though the facts do not name it: made after them, its own, or its agent host runs", async (t) => {
  const { tempRoot, facts } = world(t);
  // The facts the worker read: written before its session started, naming it nowhere.
  facts.at = new Date(Date.now() - 44_000).toISOString();
  const dir = path.join(tempRoot, 'ffa-9aad7b21');
  fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
  const now = Date.now();
  const made = judgePath(dir, facts, now);
  assert.equal(made.verdict, 'keep', made.why);
  assert.match(made.why, /after the ledger facts .* were written: they cannot speak for worker 9aad7b21 yet/);
  // Facts written after the folder (a later daemon write that still misses the session): the asking worker and its agent host keep it.
  const later = { ...facts, at: new Date(now + 1000).toISOString() };
  assert.equal(judgePath(dir, later, now + 1000).verdict, 'delete', 'the control: the ledger alone frees it');
  const ctx = { host: 'lothdesktop', alive: () => false, procs: [] as string[] };
  const own = judgePath(dir, later, now + 1000, { ...ctx, self: '9aad7b21' });
  assert.equal(own.verdict, 'keep');
  assert.match(own.why, /your own temp folder/);
  const hosted = judgePath(dir, later, now + 1000, { ...ctx, hosts: ['9aad7b21'] });
  assert.equal(hosted.verdict, 'keep');
  assert.match(hosted.why, /agent host process runs now/);
  // `check` as the clean-up runs it: its own session (FF_SESSION_ID) keeps the folder, exit 1.
  const file = path.join(path.dirname(tempRoot), 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify(later));
  const out: string[] = [];
  assert.equal(await foldersMain('check', [dir], { FF_CLEANUP_FACTS: file } as NodeJS.ProcessEnv, now + 1000, (s) => void out.push(s), async () => ({ ...ctx, self: '9aad7b21' })), 1);
  assert.match(out.join(''), /KEEP .*ffa-9aad7b21\n\s+it is your own temp folder/);
  // `folders` lists it KEEP too.
  const rows = await planFolders(later, { now: now + 1000, slots: { ...ctx, hosts: ['9aad7b21'] } });
  assert.equal(rows.find((r) => norm(r.path) === norm(dir))!.verdict, 'keep');
});

test('w3217: hostSessionsIn reads the agent hosts from their command lines, as LothDesktop shows them', () => {
  const cmds = [
    String.raw`"C:\Program Files\nodejs\node.exe" --experimental-strip-types --disable-warning=ExperimentalWarning D:\work\ffw\daemon\app\machine\agentHost.ts D:\work\ffw\daemon\hosts\9aad7b21`,
    '/usr/bin/node --experimental-strip-types /home/ff/ffw/daemon/app/machine/agentHost.ts /home/ff/ffw/daemon/hosts/1618470e',
    'node machine/leftovers.ts check V:/ffw/tmp/ffa-6a8d9300',
    'node daemon.ts --hosts D:/x/hosts/abcdef12 --other',
  ];
  assert.deepEqual(hostSessionsIn(cmds), ['9aad7b21', '1618470e']);
});

test('w3217: remove-slot takes the slot names check prints and both path styles', async (t) => {
  const { root, facts } = world(t);
  const slot = (name: string) => {
    const d = path.join(root, 'players', name);
    fs.mkdirSync(path.join(d, 'player'), { recursive: true });
    fs.mkdirSync(path.join(d, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(d, 'player', 'FinalFactory.exe'), 'x');
    fs.writeFileSync(path.join(d, 'slot.json'), JSON.stringify({ state: 'ready' }));
    return d;
  };
  const [a, b, c] = [slot('slot3-0'), slot('slot3-1'), slot('slot5-0')];
  assert.equal(slotPathOf('slot3-0', root), path.join(root, 'players', 'slot3-0'));
  assert.equal(slotPathOf(String.raw`players\slot3-0`, root), path.join(root, 'players', 'slot3-0'));
  const file = path.join(root, 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const env = { FF_CLEANUP_FACTS: file } as NodeJS.ProcessEnv;
  const out: string[] = [];
  const idle = async () => ({ host: 'lothdesktop', alive: () => false, procs: [] as string[] });
  // The name as check and folders print it, and players/<name>.
  assert.equal(await foldersMain('remove-slot', ['slot3-0', 'players/slot3-1'], env, Date.now(), (s) => void out.push(s), idle), 0, out.join(''));
  assert.deepEqual(fs.readdirSync(a), ['leases']);
  assert.deepEqual(fs.readdirSync(b), ['leases']);
  // A Windows path with backslashes, as folders prints it there.
  const back = process.platform === 'win32' ? c.replaceAll('/', '\\') : c;
  assert.equal(await foldersMain('remove-slot', [back], env, Date.now(), (s) => void out.push(s), idle), 0, out.join(''));
  assert.deepEqual(fs.readdirSync(c), ['leases']);
  // What a shell left of one ("V:\ffw\players\$s" became V:\ffw\players$s): refused, and the answer says what reached it.
  out.length = 0;
  assert.equal(await foldersMain('remove-slot', [`${path.join(root, 'players')}$s`, 'V:ffwplayersslot3-0'], env, Date.now(), (s) => void out.push(s), idle), 1);
  assert.equal(out.join('').match(/a shell ate its backslashes/g)?.length, 2, out.join(''));
});

test('w3217: check says whether a timed run plays or waits on this machine, for timing/', () => {
  const base = { at: '', connected: true, sandboxes: [], live: [], resumable: [], open: [], closed: [] } as CleanupFacts;
  assert.match(judgeTiming({ ...base, timedRuns: ['t42'] }), /timed run\(s\) t42 play or wait here now and use it/);
  assert.match(judgeTiming({ ...base, timedRuns: [] }), /no timed run plays or waits here now/);
  assert.match(judgeTiming(base), /did not say which timed runs/);
});

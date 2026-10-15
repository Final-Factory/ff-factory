import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FACTS_MAX_AGE_MS, factsProblem, judgePath, judgeSession, planFolders, renderFolders, type CleanupFacts } from './cleanupFolders.ts';
import { ownersOf } from './resumable.ts';
import { foldersMain, installLeftoversShim } from '../machine/leftovers.ts';
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
    at: new Date().toISOString(),
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

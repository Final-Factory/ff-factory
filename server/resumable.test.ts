import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resumableSessions } from './resumable.ts';
import { neverDelete, runCleanup, sessionTempDir } from './cleanup.ts';
import { SessionSweeper } from './sessionSweep.ts';
import { planInstallLeftovers } from './installLeftovers.ts';
import type { WorkItem } from '../shared/types.ts';

/**
 * w1097: a stopped worker's temp folder survives while a request still waits for it (a wait for CI, a person, a pause);
 * it goes once no request does. 2026-10-12: during LothDesktop's V: grow, dcf976fc (w1086) lost its "before" clips and a
 * player build in progress, and b3327616 (w1097) its probe files, to the w913 sweep that took any stopped session's folder
 * 10 minutes after its process ended.
 */
const item = (id: string, status: WorkItem['status'], sessionIds: string[], extra: Partial<WorkItem> = {}) => ({ id, status, sessionIds, ...extra }) as WorkItem;

test('w1097: a worker is resumable while a request it is on still waits for it', () => {
  const work = [
    item('w1', 'blocked', ['aaaa0001']), // waiting on CI: comes back
    item('w2', 'done', ['bbbb0002']), // closed
    item('w3', 'active', ['cccc0003', 'dddd0004']), // handed on to dddd0004
    item('w4', 'stalled', ['eeee0005']), // the ledger's follow-ups resume it
    item('w5', 'merged', ['ffff0006']),
    item('w6', 'waiting' as WorkItem['status'], ['gggg0007']), // not a status: not open
    item('w7', 'blocked', ['hhhh0008', 'iiii0009'], { blocked: { kind: 'pr', ref: 'x#1', what: 'its PR', at: 'x', by: 'worker hhhh0008' } }),
  ];
  assert.deepEqual(resumableSessions(['aaaa0001', 'bbbb0002', 'cccc0003', 'dddd0004', 'eeee0005', 'ffff0006', 'gggg0007', 'zzzz9999'], work), ['aaaa0001', 'dddd0004', 'eeee0005']);
  // A worker that set its request's gate is still with it although a newer worker was linked (shared/blockers.ts isWith).
  assert.deepEqual(resumableSessions(['hhhh0008', 'iiii0009'], work), ['hhhh0008', 'iiii0009']);
});

test("w1097: the clean-up guard keeps a resumable session's folder and everything in it", () => {
  const dir = '/w/tmp/ffa-aaaa0001';
  const g = { keep: [], inUse: [], home: '/home/u', resumable: [dir] };
  assert.match(neverDelete(`${dir}/f1920`, g)!, /a stopped session's folder that its open request will resume/);
  assert.match(neverDelete(dir, g)!, /will resume/);
  assert.equal(neverDelete('/w/tmp/ffa-bbbb0002/x', g), undefined);
});

function world(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w1097-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temp = path.join(root, 'tmp');
  const old = Date.now() / 1000 - 5 * 3600;
  const session = (id: string) => {
    const dir = sessionTempDir(temp, id);
    fs.mkdirSync(path.join(dir, 'f1920'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'f1920', 'before.mp4'), 'clip');
    fs.writeFileSync(path.join(dir, 'player-build.log'), 'building');
    for (const p of [path.join(dir, 'f1920', 'before.mp4'), path.join(dir, 'f1920'), path.join(dir, 'player-build.log'), dir]) fs.utimesSync(p, old, old);
    return dir;
  };
  return { root, temp, session, guard: { keep: [], inUse: [], home: path.join(root, 'home') } };
}

test('w1097: the sweep leaves a stopped worker its folder while its request waits, and starts its clock when it no longer does', async (t) => {
  const { root, temp, session, guard } = world(t);
  const dir = session('aaaa0001');
  let resumable = true;
  let now = Date.now() + 60 * 60_000;
  const sw = new SessionSweeper({
    root,
    tempRoot: () => temp,
    sessions: () => [{ id: 'aaaa0001', live: false, resumable }],
    dirOf: (id) => sessionTempDir(temp, id),
    guard: () => ({ ...guard, resumable: resumable ? [dir] : [] }),
    localWork: async () => false,
    now: () => now,
  });
  await sw.tick();
  now += 3 * 60 * 60_000; // three hours blocked on CI: the w913 sweep took it after ten minutes
  await sw.tick();
  assert.ok(fs.existsSync(path.join(dir, 'f1920', 'before.mp4')), 'kept while the request waits');
  assert.deepEqual(sw.pending(), []);
  resumable = false; // its request closed
  await sw.tick();
  now += 9 * 60_000;
  await sw.tick();
  assert.ok(fs.existsSync(path.join(dir, 'player-build.log')), 'the grace runs from the close, not from the stop');
  now += 2 * 60_000;
  await sw.tick();
  assert.ok(!fs.existsSync(dir), 'then it goes');
});

const DAY = 86_400_000;

test('w1575: a closed request keeps its worker resumable while it may be reopened (7 days), then not', () => {
  const now = Date.parse('2026-10-19T21:48:00Z');
  const at = (ms: number) => new Date(now - ms).toISOString();
  const work = [
    item('w1', 'done', ['aaaa0001'], { updatedAt: at(3 * DAY) }),
    item('w2', 'done', ['bbbb0002'], { updatedAt: at(7 * DAY + 60_000) }),
    item('w3', 'cancelled', ['cccc0003'], { updatedAt: at(DAY) }),
    item('w4', 'rejected', ['dddd0004'], { updatedAt: at(DAY) }),
    item('w5', 'merged', ['eeee0005'], { updatedAt: at(DAY) }),
    item('w6', 'done', ['ffff0006', 'gggg0007'], { updatedAt: at(DAY) }),
  ];
  assert.deepEqual(resumableSessions(['aaaa0001', 'bbbb0002', 'cccc0003', 'dddd0004', 'eeee0005', 'ffff0006', 'gggg0007'], work, now), ['aaaa0001', 'cccc0003', 'dddd0004', 'gggg0007']);
});

test('w1575: a worker that comes back finds its folder intact: after a turn end, and after its request closed and was reopened', async (t) => {
  const { root, temp, session, guard } = world(t);
  const waits = session('aaaa0001'); // its turn ended: blocked on CI
  const closed = session('bbbb0002'); // its request closed; lothsahn reopens it 3 days later
  const old = session('cccc0003'); // closed 8 days ago: nobody can reopen it
  const start = Date.now();
  let now = start;
  const work = [
    item('w1', 'blocked', ['aaaa0001'], { updatedAt: new Date(start).toISOString() }),
    item('w2', 'done', ['bbbb0002'], { updatedAt: new Date(start).toISOString() }),
    item('w3', 'done', ['cccc0003'], { updatedAt: new Date(start - 8 * DAY).toISOString() }),
  ];
  const live = new Set<string>();
  const ids = ['aaaa0001', 'bbbb0002', 'cccc0003'];
  const res = () => resumableSessions(ids, work, now);
  const g = () => ({ ...guard, inUse: [...live].map((id) => sessionTempDir(temp, id)), resumable: res().map((id) => sessionTempDir(temp, id)) });
  const sw = new SessionSweeper({
    root,
    tempRoot: () => temp,
    sessions: () => ids.map((id) => ({ id, live: live.has(id), resumable: res().includes(id) })),
    dirOf: (id) => sessionTempDir(temp, id),
    guard: g,
    localWork: async () => false,
    now: () => now,
  });
  // Three days of sweeps and nightly passes while both are stopped.
  for (let h = 0; h < 72; h++) {
    now += 3_600_000;
    await sw.tick();
    if (h % 24 === 23) {
      const nightly = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [temp], guard: g(), now });
      await runCleanup(nightly.items, g());
    }
  }
  for (const d of [waits, closed]) assert.ok(fs.existsSync(path.join(d, 'f1920', 'before.mp4')) && fs.existsSync(path.join(d, 'player-build.log')), `${d} intact`);
  assert.ok(!fs.existsSync(path.join(old, 'f1920')), 'a session past the reopen window is swept');
  // CI comes back and lothsahn reopens w2: each worker is resumed into its own folder, as it left it.
  work[1] = { ...work[1], status: 'new', updatedAt: new Date(now).toISOString() };
  live.add('aaaa0001');
  live.add('bbbb0002');
  await sw.tick();
  for (const d of [waits, closed]) assert.equal(fs.readFileSync(path.join(d, 'f1920', 'before.mp4'), 'utf8'), 'clip');
});

test("w1097: the daily pass's stopped-session rule leaves a resumable session's folder", async (t) => {
  const { root, temp, session, guard } = world(t);
  const kept = session('aaaa0001');
  const gone = session('bbbb0002');
  const plan = await planInstallLeftovers({ root, sandboxes: [], tempRoots: [temp], guard: { ...guard, resumable: [kept] } });
  const paths = plan.items.map((i) => i.path);
  assert.ok(paths.includes(gone), JSON.stringify(plan.items));
  assert.ok(!paths.some((p) => p === kept || p.startsWith(kept + path.sep)), JSON.stringify(plan.items));
});

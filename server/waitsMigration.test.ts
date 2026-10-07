// w643: the migration of requests queued before Blocked existed, and its before and after table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockerFromNote, liveBefore, queueNote, runWaitsMigration } from './waitsMigration.ts';
import { workLiveAll } from '../shared/workState.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

const LOTH = { userId: 'lothsahn', displayName: 'Lothsahn' };
const T = '2026-10-07T10:00:00.000Z';
const item = (id: string, o: Partial<WorkItem> = {}): WorkItem => ({ id, title: `Request ${id}`, brief: '', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'active', createdAt: T, updatedAt: T, sessionIds: [], overlaps: [], asks: 0, log: [], ...o });

test("w643: a queue note naming what it waits on becomes that blocker; capacity, or nothing clear, stays Queued", () => {
  const work = [item('w633'), item('w634'), item('w641')];
  const ctx = { portalSha: 'abc1234', machines: ['lothdesktop', 'm5', 'beast'], work: (id: string) => work.find((w) => w.id === id) };
  assert.deepEqual(blockerFromNote(work[1], "Queued until w633 reports its timing table and its lab.lock is free.", ctx), { kind: 'request', ref: 'w633', on: 'report', what: "Queued until w633 reports its timing table and its lab.lock is free." });
  assert.deepEqual(blockerFromNote(work[2], 'Held until the next portal deploy.', ctx), { kind: 'deploy', what: 'Held until the next portal deploy.', sha: 'abc1234' });
  assert.deepEqual(blockerFromNote(work[2], 'Needs the M5, which is asleep until tonight.', ctx), { kind: 'machine', ref: 'm5', what: 'Needs the M5, which is asleep until tonight.' });
  assert.deepEqual(blockerFromNote(work[2], 'After the nightly run frees lab.lock.', ctx), { kind: 'lock', ref: 'lab.lock', what: 'After the nightly run frees lab.lock.' });
  assert.deepEqual(blockerFromNote(work[1], 'After w633 is done.', ctx), { kind: 'request', ref: 'w633', on: 'report', what: 'After w633 is done.' });
  assert.equal(blockerFromNote(work[1], 'Every sandbox is busy; start when one frees.', ctx), undefined, 'capacity: Queued');
  assert.equal(blockerFromNote(work[1], 'Later.', ctx), undefined);
  assert.equal(blockerFromNote(work[1], 'Same as w634, later.', ctx), undefined, 'only itself named');
  assert.equal(blockerFromNote(work[1], 'After w999 lands.', ctx), undefined, 'a request not in the ledger');
  assert.equal(queueNote(item('w1', { log: ['09:00 filed by Lothsahn', '09:05 dispatcher: queued: Queued until w633 reports'] })), 'Queued until w633 reports');
});

test('w643: the migration runs once, blocks what its notes name, and writes the before and after of every open and stalled request', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w643-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const work = [
    item('w633', { sessionIds: ['k1'] }),
    item('w634', { status: 'queued', log: ['09:05 dispatcher: queued: Queued until w633 reports its timing table and its lab.lock is free'] }),
    item('w641', { status: 'queued', log: ['09:06 dispatcher: queued: held for the next portal deploy'] }),
    item('w642', { status: 'queued', log: ['09:07 dispatcher: queued: every sandbox is busy'] }),
    item('w650', { status: 'new', approval: { state: 'pending' }, triage: { class: 'needs-human', reason: 'a design call' } }),
    item('w651', { status: 'new' }),
    item('w600', { status: 'done' }),
  ];
  const sessions: SessionInfo[] = [{ id: 'k1', kind: 'worker', title: 'w633', status: 'idle', permissionMode: 'default', createdAt: T, lastActivityAt: T, turns: 1, costUsd: 0, pendingPermissions: [], wakeAt: new Date(Date.now() + 3_600_000).toISOString(), wakeNote: 'CI on PR #210' }];
  const told: string[] = [];
  const run = () =>
    runWaitsMigration({
      dataDir: dir,
      items: () => work,
      block: (id, b) => Object.assign(work.find((w) => w.id === id)!, { status: 'blocked', blocked: b }),
      live: () => workLiveAll(work, { session: (id) => sessions.find((s) => s.id === id), now: Date.now() }),
      portalSha: 'abc1234',
      machines: ['lothdesktop'],
      tell: (x) => void told.push(x),
    });
  const table = run()!;
  assert.deepEqual(work.map((w) => w.status), ['active', 'blocked', 'blocked', 'queued', 'new', 'new', 'done']);
  assert.match(table, /\| w634 \| Request w634 \| queued \| Queued \(the dispatcher queued it for capacity\) \| blocked \| Blocked on w633 reporting \(Queued until w633 reports/);
  assert.match(table, /\| w641 \| Request w641 \| queued \| Queued \(the dispatcher queued it for capacity\) \| blocked \| Blocked on a portal deploy \(held for the next portal deploy/);
  assert.match(table, /\| w642 \| Request w642 \| queued \| Queued \(the dispatcher queued it for capacity\) \| queued \| Queued \(queued for capacity\) \|/);
  assert.match(table, /\| w650 \| Request w650 \| new \| Waiting on input on a reviewer \(an intake request waiting for a reviewer to approve or decline it\) \| new \| Waiting on input on a reviewer/);
  assert.match(table, /\| w651 \| Request w651 \| new \| Queued \(waiting for the dispatcher to decide it\) \| new \| Working \(the dispatcher has it to decide/);
  assert.match(table, /\| w633 \| Request w633 \| active \| Waiting \(k1 between turns: check-in [^|]*\) \| active \| Working \(k1 between turns/);
  assert.doesNotMatch(table, /w600/, 'closed ones are not in it');
  assert.match(told[0], /^\[ledger\] The ledger's states changed \(w643\).*Blocked from your own queue notes: w634, w641/s);
  assert.equal(run(), undefined, 'once');
  assert.equal(told.length, 1);
  assert.ok(liveBefore);
});

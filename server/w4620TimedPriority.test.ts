// w4620: strict priority on a computer's timed-run daemon. lothsahn, 2026-11-17: "Why is urgent work in a queue behind non
// urgent work? Please fix the factory so this doesn't happen. The factory should be using strict priority queues".
// tr_903bab15aa (w4591, urgent: the 1.0.0.50 release's last check) waited on LothDesktop's daemon behind tr_97b11ed6a4
// (w4587), which itself waited 40 minutes for the exclusive bench ticket; the daemon plays one run at a time, first come.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUMP_ANSWER_MS, TimedRuns, type TimedRunRecord } from './timedRuns.ts';
import { TIMED_DEFAULTS, type TimedRunOrder } from '../shared/timedRun.ts';
import type { AttachmentStore } from './attachments.ts';
import type { Machine, WorkPriority } from '../shared/types.ts';

const SAVE = '0'.repeat(64);
const START = Date.parse('2026-11-17T19:30:00Z');
const ago = (min: number) => new Date(START - min * 60_000).toISOString();

function setup(t: { after: (fn: () => void) => void }, runs: { id: string; request: string; state: string; sentAt?: string }[], prio: Record<string, WorkPriority>) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w4620-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const start = START;
  const clock = { ms: start };
  const at = (min: number) => new Date(start - min * 60_000).toISOString();
  const order = (id: string, request: string) => ({ id, what: request, requests: [request], session: `sess-${request}`, variants: [], save: { name: 'bench.zip', size: 1, sha256: SAVE, id: 'att_s' }, pieceIds: {}, settings: { ...TIMED_DEFAULTS } }) as unknown as TimedRunOrder;
  fs.mkdirSync(path.join(d, 'portal'));
  fs.writeFileSync(
    path.join(d, 'portal', 'timed-runs.json'),
    JSON.stringify({
      runs: runs.map((r, i) => ({ id: r.id, session: `sess-${r.request}`, requests: [r.request], what: r.request, from: 'beast', machine: 'lothdesktop', state: r.state, line: '', createdAt: at(60 - i), updatedAt: at(1), ...(r.sentAt ? { sentAt: r.sentAt } : {}), order: order(r.id, r.request), totalBytes: 1 })),
      pieces: { [SAVE]: { id: 'att_s', usedAt: at(1) } },
    }),
  );
  const posted: { type: string; id?: string; why?: string; order?: { id: string } }[] = [];
  const logs: string[] = [];
  const notes: { requests: string[]; line: string }[] = [];
  const tr = new TimedRuns({
    dataDir: path.join(d, 'portal'),
    store: { forget: () => {}, get: (id: string) => (id === 'att_s' ? { id, sha256: SAVE } : undefined), grant: () => {}, begin: () => ({ uploadId: 'up1', chunkBytes: 1 }) } as unknown as AttachmentStore,
    machines: () => [{ id: 'lothdesktop', platform: 'win32', playOnly: 'play only' } as unknown as Machine],
    isOnline: () => true,
    offers: () => true,
    post: (_id, msg) => (posted.push(msg as (typeof posted)[number]), true),
    deliver: async () => {},
    log: (l) => logs.push(l),
    note: (requests, line) => notes.push({ requests, line }),
    now: () => clock.ms,
    priorityOf: (r: TimedRunRecord) => prio[r.requests[0]] ?? 'low',
  });
  return { tr, clock, posted, logs, notes, at };
}

/** What the daemon does with a step-back of a run it holds: drops it and answers (machine/timedRunner.ts cancel). */
function answer(tr: TimedRuns, posted: { type: string; id?: string; why?: string }[]) {
  for (const p of posted.filter((x) => x.type === 'timed_run_cancel')) tr.onReport('lothdesktop', { type: 'timed_run_done', id: p.id, ok: false, error: `cancelled: ${p.why}`, summary: '', legs: [] });
}

test('w4620: an urgent timed run queued behind 3 normal and low ones on one daemon runs next; the others keep their order behind it', (t) => {
  const { tr, posted, logs, notes } = setup(
    t,
    [
      { id: 'tr_aaaaaaaaa1', request: 'w4587', state: 'sent', sentAt: ago(40) },
      { id: 'tr_aaaaaaaaa2', request: 'w4588', state: 'sent', sentAt: ago(39) },
      { id: 'tr_aaaaaaaaa3', request: 'w4589', state: 'sent', sentAt: ago(38) },
      { id: 'tr_903bab15aa', request: 'w4591', state: 'sent', sentAt: ago(37) },
    ],
    { w4587: 'normal', w4588: 'low', w4589: 'normal', w4591: 'urgent' },
  );
  // what LothDesktop's daemon says: the first waits for the exclusive ticket, the others wait behind it
  tr.onReport('lothdesktop', { type: 'timed_run_status', id: 'tr_aaaaaaaaa1', state: 'waiting', line: 'turn 1: exclusive ticket, place 4' });
  for (const id of ['tr_aaaaaaaaa2', 'tr_aaaaaaaaa3', 'tr_903bab15aa']) tr.onReport('lothdesktop', { type: 'timed_run_status', id, state: 'queued', line: 'queued behind tr_aaaaaaaaa1' });

  const cancels = posted.filter((p) => p.type === 'timed_run_cancel').map((p) => p.id);
  assert.deepEqual(cancels.sort(), ['tr_aaaaaaaaa1', 'tr_aaaaaaaaa2', 'tr_aaaaaaaaa3'], 'every run ahead of the urgent one steps back; none had held a turn');
  assert.ok(!cancels.includes('tr_903bab15aa'));
  const jump = logs.find((l) => l.startsWith('timed run tr_aaaaaaaaa1 '));
  assert.match(jump ?? '', /^timed run tr_aaaaaaaaa1 \(w4587, normal\) moved behind tr_903bab15aa \(w4591, urgent\) on lothdesktop's daemon: strict priority \(w4620\)/, 'the jump is logged, naming both');
  assert.ok(notes.some((n) => n.requests.includes('w4587') && n.requests.includes('w4591')), 'and noted on both requests');

  // the daemon drops them and answers; once every one answered they go again, the highest priority first, oldest first
  posted.length = 0;
  answer(tr, [
    { type: 'timed_run_cancel', id: 'tr_aaaaaaaaa1', why: 'x' },
    { type: 'timed_run_cancel', id: 'tr_aaaaaaaaa2', why: 'x' },
  ]);
  assert.equal(posted.filter((p) => p.type === 'timed_run').length, 0, 'none goes again while another still steps back');
  answer(tr, [{ type: 'timed_run_cancel', id: 'tr_aaaaaaaaa3', why: 'x' }]);
  assert.deepEqual(
    posted.filter((p) => p.type === 'timed_run').map((p) => p.order!.id),
    ['tr_aaaaaaaaa1', 'tr_aaaaaaaaa3', 'tr_aaaaaaaaa2'],
    'normal ones before the low one, each in its first order',
  );
  assert.equal(tr.get('tr_903bab15aa')?.state, 'sent');
  for (const id of ['tr_aaaaaaaaa1', 'tr_aaaaaaaaa2', 'tr_aaaaaaaaa3']) {
    assert.equal(tr.get(id)?.state, 'sent', `${id} is sent again, not failed`);
    assert.equal(tr.get(id)?.bumping, undefined);
  }
  // the urgent one now plays first: nothing more moves
  posted.length = 0;
  tr.onReport('lothdesktop', { type: 'timed_run_status', id: 'tr_903bab15aa', state: 'running', line: 'turn 1: holds the exclusive bench ticket t1' });
  tr.reprioritize();
  assert.equal(posted.filter((p) => p.type === 'timed_run_cancel').length, 0);
});

test('w4620: raising a priority while a run is queued reorders it; a run that held a turn is never moved', (t) => {
  const prio: Record<string, WorkPriority> = { w1: 'normal', w2: 'normal', w3: 'normal' };
  const { tr, posted } = setup(
    t,
    [
      { id: 'tr_bbbbbbbbb1', request: 'w1', state: 'running', sentAt: ago(30) },
      { id: 'tr_bbbbbbbbb2', request: 'w2', state: 'sent', sentAt: ago(29) },
      { id: 'tr_bbbbbbbbb3', request: 'w3', state: 'sent', sentAt: ago(28) },
    ],
    prio,
  );
  tr.reprioritize();
  assert.equal(posted.filter((p) => p.type === 'timed_run_cancel').length, 0, 'one priority: first come, first served');
  prio.w3 = 'high';
  tr.reprioritize();
  assert.deepEqual(
    posted.filter((p) => p.type === 'timed_run_cancel').map((p) => p.id),
    ['tr_bbbbbbbbb2'],
    'the raised run moves ahead of the waiting one, never ahead of the one whose turn is playing',
  );
});

test('w4620: the logs of a dropped try are not its result, and a daemon that never answers gets the run again', (t) => {
  const { tr, posted, clock } = setup(
    t,
    [
      { id: 'tr_ddddddddd1', request: 'w1', state: 'sent', sentAt: ago(10) },
      { id: 'tr_ddddddddd2', request: 'w2', state: 'sent', sentAt: ago(9) },
      { id: 'tr_ddddddddd3', request: 'w3', state: 'sent', sentAt: ago(8) },
    ],
    { w1: 'low', w2: 'low', w3: 'urgent' },
  );
  tr.reprioritize();
  // tr_1 answers with its packed logs: the upload opens under another name, the run goes again
  tr.onReport('lothdesktop', { type: 'timed_run_done', id: 'tr_ddddddddd1', ok: false, error: 'cancelled: moved', summary: '', legs: [], result: { name: 'timed-tr_ddddddddd1.tar.gz', size: 10, sha256: 'a'.repeat(64) } });
  assert.ok(posted.some((p) => p.type === 'timed_run_upload' && p.id === 'tr_ddddddddd1'));
  // its daemon's late result for the dropped try leaves the run waiting (here its upload failed)
  tr.onReport('lothdesktop', { type: 'timed_run_result', id: 'tr_ddddddddd1', error: 'the portal opened no upload for the results in 10 minutes' });
  assert.equal(tr.get('tr_ddddddddd1')?.state, 'queued', 'still waiting for tr_ddddddddd2 to answer before it goes again');
  // tr_2 never answers: after BUMP_ANSWER_MS the portal sends both again, in order
  posted.length = 0;
  clock.ms += BUMP_ANSWER_MS + 60_000;
  tr.tick();
  assert.deepEqual(posted.filter((p) => p.type === 'timed_run').map((p) => p.order!.id), ['tr_ddddddddd1', 'tr_ddddddddd2']);
  assert.equal(tr.get('tr_ddddddddd1')?.state, 'sent');
  assert.equal(tr.get('tr_ddddddddd2')?.state, 'sent');
});

test('w4620: a release run goes ahead of an urgent one; equal priorities stay first come', (t) => {
  const { tr, posted } = setup(
    t,
    [
      { id: 'tr_ccccccccc1', request: 'w1', state: 'sent', sentAt: ago(10) },
      { id: 'tr_ccccccccc2', request: 'w2', state: 'sent', sentAt: ago(9) },
      { id: 'tr_ccccccccc3', request: 'w3', state: 'sent', sentAt: ago(8) },
    ],
    { w1: 'urgent', w2: 'urgent', w3: 'frantic' },
  );
  tr.reprioritize();
  assert.deepEqual(posted.filter((p) => p.type === 'timed_run_cancel').map((p) => p.id).sort(), ['tr_ccccccccc1', 'tr_ccccccccc2']);
});


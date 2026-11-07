// w3405: a timed run queued behind another on its daemon says so. ben, 2026-11-07: "File it: show when a timed run is
// queued behind another". tr_97da01f124 (w3252) sat 'sent' on LothDesktop from 08:38Z behind w3335's tr_d039d7bdc5, whose
// bench tickets waited behind the nightly and an ffu soak and were never granted; its worker saw only "sent", thought it
// waited on nothing, and cancelled it at 10:04Z. machine/timedRunner.ts enqueue already reported "queued behind <id>".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimedRuns } from './timedRuns.ts';
import { TIMED_DEFAULTS, type TimedRunOrder } from '../shared/timedRun.ts';
import type { AttachmentStore } from './attachments.ts';
import type { Machine } from '../shared/types.ts';

const SAVE = '0'.repeat(64);
const A = 'tr_d039d7bdc5';
const B = 'tr_97da01f124';

function setup(t: { after: (fn: () => void) => void }, runs: { id: string; request: string; state: string }[]) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w3405-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const start = Date.parse('2026-11-07T08:40:00Z');
  const clock = { ms: start };
  const created = new Date(start - 60_000).toISOString();
  const order = (id: string, request: string) => ({ id, what: request, requests: [request], session: `sess-${request}`, variants: [], save: { name: 'bench.zip', size: 1, sha256: SAVE }, pieceIds: {}, settings: { ...TIMED_DEFAULTS } }) as unknown as TimedRunOrder;
  fs.mkdirSync(path.join(d, 'portal'));
  fs.writeFileSync(
    path.join(d, 'portal', 'timed-runs.json'),
    JSON.stringify({
      runs: runs.map((r) => ({ id: r.id, session: `sess-${r.request}`, requests: [r.request], what: r.request, from: 'beast', machine: 'lothlaptop', state: r.state, line: '', createdAt: created, updatedAt: created, order: order(r.id, r.request), totalBytes: 1 })),
      pieces: { [SAVE]: { id: 'att_s', usedAt: created } },
    }),
  );
  const posted: { id: string; type: string }[] = [];
  const tr = new TimedRuns({
    dataDir: path.join(d, 'portal'),
    store: { forget: () => {}, get: (id: string) => (id === 'att_s' ? { id, sha256: SAVE } : undefined), grant: () => {} } as unknown as AttachmentStore,
    machines: () => [{ id: 'lothlaptop', platform: 'win32', playOnly: 'play only' } as unknown as Machine, { id: 'desktop-coosego', platform: 'win32', playOnly: 'play only' } as unknown as Machine],
    isOnline: () => true,
    offers: () => true,
    post: (id, msg) => (posted.push({ id, type: (msg as { type: string }).type }), true),
    deliver: async () => {},
    log: () => {},
    now: () => clock.ms,
  });
  return { tr, clock, posted };
}

test('w3405: a second run on one daemon reads as queued behind the first, with what that one waits for and since when; past a turn a free computer is named', (t) => {
  const { tr, clock } = setup(t, [
    { id: A, request: 'w3335', state: 'sent' },
    { id: B, request: 'w3252', state: 'sent' },
  ]);
  // what LothDesktop's daemon said: the first run waits for the bench, the second waits behind it
  tr.onReport('lothlaptop', { type: 'timed_run_status', id: A, state: 'waiting', line: 'turn 1: exclusive ticket, place 3, waiting for t00004605 (ffu soak, w3330)' });
  clock.ms += 60_000;
  tr.onReport('lothlaptop', { type: 'timed_run_status', id: B, state: 'queued', line: `queued behind ${A}` });

  assert.equal(tr.get(B)?.state, 'sent', 'its state stays sent: dispatch, the hello and the stall check read it');
  assert.deepEqual(tr.get(B)?.behind, { id: A, since: '2026-11-07T08:41:00.000Z' });
  assert.match(tr.capacityLine() ?? '', new RegExp(`${A} sent, ${B} queued behind ${A}`), 'the Capacity block every worker reads says so too');
  const said = tr.statusText(B);
  assert.match(said, new RegExp(`^Timed run ${B} \\(w3252\\) on lothlaptop: queued behind ${A} \\(w3335\\) since 08:41Z \\(0 min\\), on its daemon, which plays one run at a time; it has no bench ticket yet`));
  assert.match(said, new RegExp(`${A} waits for lothlaptop's exclusive bench ticket since 08:40Z \\(1 min\\): turn 1: exclusive ticket, place 3, waiting for t00004605 \\(ffu soak, w3330\\)\\.`));
  assert.doesNotMatch(said, /longer than one exclusive turn/, 'within a turn it only says where it stands');
  assert.match(tr.statusText(A), /^Timed run tr_d039d7bdc5 \(w3335\) on lothlaptop: sent, waiting for lothlaptop's exclusive bench ticket since 08:40Z/);

  // new lines from the daemon keep both times: the wait started when it started
  clock.ms += 30 * 60_000;
  tr.onReport('lothlaptop', { type: 'timed_run_status', id: A, state: 'waiting', line: 'turn 1: exclusive ticket, place 2, waiting for t00004605 (ffu soak, w3330)' });
  tr.onReport('lothlaptop', { type: 'timed_run_status', id: B, state: 'queued', line: `queued behind ${A}` });
  assert.equal(tr.get(A)?.waitingSince, '2026-11-07T08:40:00.000Z');
  assert.equal(tr.get(B)?.behind?.since, '2026-11-07T08:41:00.000Z');
  const late = tr.statusText(B);
  assert.match(late, /since 08:40Z \(31 min\): turn 1: exclusive ticket, place 2/);
  assert.match(late, /longer than one exclusive turn \(30 minutes, w1832\): desktop-coosego takes timed runs and is free now\. To move, stop this run \(timed_place cancel "tr_97da01f124"\) and call timed_run again with machine "desktop-coosego"\./);

  // the first is granted and plays: no more "waiting"; when it ends and the second starts, nothing is behind
  tr.onReport('lothlaptop', { type: 'timed_run_status', id: A, state: 'running', line: 'turn 1: holds the exclusive bench ticket t00004610, legs in slot4\'s player slots: 8 legs left' });
  assert.equal(tr.get(A)?.waitingSince, undefined);
  assert.match(tr.statusText(B), /tr_d039d7bdc5 is running: turn 1: holds the exclusive bench ticket t00004610/);
  assert.doesNotMatch(tr.statusText(B), /longer than one exclusive turn/);
  tr.onReport('lothlaptop', { type: 'timed_run_status', id: B, state: 'fetching', line: 'fetching 3 of 40 pieces' });
  assert.equal(tr.get(B)?.behind, undefined);
  assert.match(tr.statusText(B), /^Timed run tr_97da01f124 \(w3252\) on lothlaptop: sent: fetching 3 of 40 pieces\.$/);
  assert.doesNotMatch(tr.capacityLine() ?? '', /queued behind/);
  assert.throws(() => tr.statusText('tr_0000000077'), /no timed run tr_0000000077 on the portal/);
});

test('w3405: a run handed to a daemon that already holds one is told at go() that it waits behind it', (t) => {
  const { tr, posted } = setup(t, [
    { id: A, request: 'w3335', state: 'sent' },
    { id: B, request: 'w3252', state: 'uploading' },
  ]);
  const text = tr.go('sess-w3252', { runId: B, uploaded: {}, sentBytes: 1 });
  assert.deepEqual(posted, [{ id: 'lothlaptop', type: 'timed_run' }]);
  assert.match(text, /lothlaptop plays one timed run at a time and holds tr_d039d7bdc5 \(w3335, sent\) first: this run waits behind it before it queues for the bench\. timed_place with status "tr_97da01f124" says where it stands\./);
  assert.match(text, / End your turn now with a wake_me/, 'the note sits before the check-in line the late-message rewrite cuts at');
});

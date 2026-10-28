// w2442: a worker stops a timed run (timed_place cancel). lothsahn, 2026-10-28: "Stop w2434's timing run on LothLaptop now";
// w2434's worker "found no way to cancel a timed run". A running run's daemon is told to end its leg's player and give its
// bench ticket back (machine/timedRunner.ts cancel, w2218), its worker gets a FAILED result with the reason, and a run of a
// request the asking worker's requests do not name is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimedRuns } from './timedRuns.ts';
import { TIMED_DEFAULTS, type TimedRunOrder } from '../shared/timedRun.ts';
import type { AttachmentStore } from './attachments.ts';
import type { Machine } from '../shared/types.ts';

test('w2442: a cancelled run ends: its daemon is told to stop it, its worker is told why, a run not yours is refused', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w2442-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const order = (id: string) => ({ id, what: 'w2434', requests: ['w2434'], session: 'sess-172ab5ee', variants: [], save: { id: 'att_s', name: 'bench.zip', size: 1, sha256: '0'.repeat(64) }, pieceIds: {}, settings: { ...TIMED_DEFAULTS } }) as unknown as TimedRunOrder;
  const run = (id: string, state: string) => ({ id, session: 'sess-172ab5ee', requests: ['w2434'], what: 'w2434', from: 'm3', machine: 'lothlaptop', state, line: 'turn 2: holds t00000281', createdAt: now, updatedAt: now, order: order(id) });
  fs.mkdirSync(path.join(d, 'portal'));
  fs.writeFileSync(path.join(d, 'portal', 'timed-runs.json'), JSON.stringify({ runs: [run('tr_225384a69f', 'running'), run('tr_00000000aa', 'queued')], pieces: {} }));
  const posted: { id: string; msg: { type: string; id: string; why: string } }[] = [];
  const told: { session: string; text: string }[] = [];
  const tr = new TimedRuns({
    dataDir: path.join(d, 'portal'),
    store: { forget: () => {}, get: () => undefined, grant: () => {} } as unknown as AttachmentStore,
    machines: () => [{ id: 'lothlaptop', platform: 'win32' } as unknown as Machine],
    isOnline: () => true,
    offers: () => true,
    post: (id, msg) => (posted.push({ id, msg: msg as never }), true),
    deliver: async (session, text) => void told.push({ session, text }),
    log: () => {},
  });
  const yes = () => undefined;

  assert.throws(() => tr.cancel('tr_225384a69f', 'lothsahn paused LothLaptop', () => 'not yours'), /not yours/);
  assert.equal(tr.get('tr_225384a69f')?.state, 'running', 'a refused cancel leaves the run alone');
  assert.throws(() => tr.cancel('tr_0000000077', 'x', yes), /no timed run tr_0000000077/);

  const out = tr.cancel('tr_225384a69f', 'lothsahn paused LothLaptop', yes);
  assert.match(out, /cancelled \(it was running on lothlaptop\): lothlaptop's daemon ends its leg's player and gives its bench ticket back now/);
  assert.equal(tr.get('tr_225384a69f')?.state, 'failed');
  assert.deepEqual(
    posted.filter((p) => p.msg.type === 'timed_run_cancel').map((p) => `${p.id} ${p.msg.id}: ${p.msg.why}`),
    ['lothlaptop tr_225384a69f: cancelled: lothsahn paused LothLaptop'],
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(told.length, 1);
  assert.equal(told[0].session, 'sess-172ab5ee');
  assert.match(told[0].text, /\[timed run tr_225384a69f on lothlaptop\] FAILED: .*cancelled: lothsahn paused LothLaptop/);

  // its daemon's own end of it after that changes nothing, and a second cancel says it already ended
  tr.onReport('lothlaptop', { type: 'timed_run_done', id: 'tr_225384a69f', ok: false, error: 'cancelled: lothsahn paused LothLaptop', legs: [] });
  assert.equal(tr.get('tr_225384a69f')?.state, 'failed');
  assert.match(tr.cancel('tr_225384a69f', 'again', yes), /already ended \(failed: cancelled: lothsahn paused LothLaptop\)/);

  // a run not yet sent just ends: its daemon holds nothing to stop
  assert.doesNotMatch(tr.cancel('tr_00000000aa', 'moved to lothdesktop', yes), /daemon/);
  assert.equal(tr.get('tr_00000000aa')?.state, 'failed');
  assert.equal(posted.filter((p) => p.msg.type === 'timed_run_cancel').length, 1);
});

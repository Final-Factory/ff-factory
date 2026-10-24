import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SpendStore, type SpendContext } from './spend.ts';
import { backfillSpend, repairSpend } from './spendJobs.ts';
import type { SessionInfo } from '../shared/types.ts';

/**
 * w2026: the spend jobs after a start never hold the event loop, whatever the transcripts grew to. On 2026-10-24 the backfill read
 * 35-57 transcripts with no turn whole and synchronously on every start (206-538 s), and the portal stopped answering its daemons
 * and /api/health. CI runs no timing tests (CONTRIBUTING.md "Performance"), so this pins the shape instead: no transcript is read
 * synchronously, the loop gets a turn at least every few megabytes parsed, a session read once is not read again on the next
 * start, and one too big is left alone. scripts/loop-lag-bench.ts measures the lag itself, locally.
 */

const T0 = Date.parse('2026-10-24T09:00:00Z');
const session = (id: string): SessionInfo =>
  ({ id, kind: 'worker', title: `w1: ${id}`, status: 'idle', permissionMode: 'default', createdAt: new Date(T0).toISOString(), lastActivityAt: new Date(T0).toISOString(), turns: 0, costUsd: 0, pendingPermissions: [], model: 'claude-opus-5-5' }) as SessionInfo;

/** A data folder of `n` sessions whose transcripts hold `mb` megabytes of tool output each and no result (the shape that blocked). */
function grown(n: number, mb: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-jobs-'));
  const store = new Store(dir);
  const line = JSON.stringify({ seq: 0, t: new Date(T0).toISOString(), kind: 'tool_result', id: 't', text: 'x'.repeat(16_000) });
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  for (let i = 0; i < n; i++) {
    const id = `s${i}`;
    store.sessions.set(id, session(id));
    const lines = Math.ceil((mb * 1048576) / line.length);
    fs.writeFileSync(path.join(dir, 'transcripts', `${id}.jsonl`), Array.from({ length: lines }, (_, k) => line.replace('"seq":0', `"seq":${k + 1}`)).join('\n') + '\n');
  }
  const ctx: SpendContext = { work: () => [], session: (id) => store.sessions.get(id), priorResults: () => 1 };
  return { dir, store, spend: new SpendStore(dir, ctx) };
}

/** Turns of the event loop while `run` goes, and the transcript bytes read synchronously meanwhile. */
async function watch<T>(run: () => Promise<T>) {
  let turns = 0;
  let on = true;
  const tick = () => {
    turns++;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  const orig = fs.readFileSync;
  let syncTranscriptReads = 0;
  (fs as { readFileSync: unknown }).readFileSync = (p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(p).includes(`${path.sep}transcripts${path.sep}`)) syncTranscriptReads++;
    return (orig as (...a: unknown[]) => unknown)(p, ...rest);
  };
  try {
    const value = await run();
    return { value, turns, syncTranscriptReads };
  } finally {
    on = false;
    (fs as { readFileSync: unknown }).readFileSync = orig;
  }
}

test('w2026: the spend backfill reads grown transcripts without holding the loop, and a session with no turn only once', async () => {
  const w = grown(6, 8);
  const first = await watch(() => backfillSpend(w.store, w.spend, { log: () => {}, warn: () => {} }));
  assert.equal(first.syncTranscriptReads, 0, 'no transcript read with readFileSync');
  assert.equal(first.value.sessions, 6);
  // 48 MB parsed: a turn of the loop at least every ~2 MB, and after each session
  assert.ok(first.turns >= 24, `the loop got ${first.turns} turns`);
  assert.equal(w.spend.backfillNone.size, 6);
  // the next start: nothing to read (before w2026 every start read them all again)
  const again = await backfillSpend(w.store, w.spend, { log: () => {}, warn: () => {} });
  assert.deepEqual(again, { sessions: 0, turns: 0, usd: 0, tooBig: 0 });
});

test('w2026: a transcript over the limit is left alone by the backfill and the repair, and marked so it is not looked at on every start', async () => {
  const w = grown(2, 3);
  const logs: string[] = [];
  const r = await backfillSpend(w.store, w.spend, { log: (l) => logs.push(l), warn: (l) => logs.push(l) }, 1024 * 1024);
  assert.equal(r.tooBig, 2);
  assert.match(logs.join('\n'), /2 transcript\(s\) over 1 MB left alone/);
  // a coordinator recorded live, with a transcript too big to replay: marked, not retried on every start
  w.store.sessions.set('s0', { ...session('s0'), kind: 'orchestrator' } as SessionInfo);
  w.spend.observe('s0', { seq: 1_000_000, t: new Date(T0 + 60_000).toISOString(), kind: 'result', ok: true, text: 'done', costUsd: 1, turns: 1, durationMs: 1000 });
  const rec = w.spend.session('s0')!;
  rec.fixV = undefined;
  rec.coordV = undefined;
  const repaired = await watch(() => repairSpend(w.store, w.spend, { log: () => {}, warn: () => {} }, 1024 * 1024));
  assert.equal(repaired.syncTranscriptReads, 0);
  assert.equal(w.spend.session('s0')!.fixV, 2);
});

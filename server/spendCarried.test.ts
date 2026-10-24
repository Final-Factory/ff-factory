import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { carriedTotals, listUsd, sumTok, zeroTok, type ModelTok, type TurnUsage } from '../shared/spend.ts';
import { SpendStore, backfillTurnUsd, estimateTurn, type SpendContext } from './spend.ts';
import { firstResultBase } from './sessions.ts';
import { Store } from './store.ts';
import type { Requester, SessionInfo, TranscriptEvent, WorkItem } from '../shared/types.ts';

/**
 * w2007: a resumed CLI's older saved totals (the whole running total) were billed as one turn. Ben's orchestrator's four turns
 * named w1737 on 2026-10-22 read 925M cache tokens and $425; a coordinator's turn reads at most a few million (spend_report and
 * portal_logs coordinator_context, 2026-10-24).
 */

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const T0 = Date.parse('2026-10-22T10:00:00Z'); // after RULES_FROM_MS: the current rules recorded it live
const iso = (ms: number) => new Date(ms).toISOString();
const OPUS = 'claude-opus-5-5';
const item = (id: string): WorkItem =>
  ({ id, title: `Request ${id}`, brief: 'Do it.', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: iso(T0), updatedAt: iso(T0), sessionIds: [], overlaps: [], asks: 0, log: [] }) as unknown as WorkItem;
const coordinator = (id: string, patch: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, kind: 'orchestrator', orchestratorRole: 'personal', requestedBy: BEN, title: 'Ben', status: 'idle', permissionMode: 'default', createdAt: iso(T0), lastActivityAt: iso(T0), turns: 0, costUsd: 0, pendingPermissions: [], model: OPUS, ...patch }) as SessionInfo;
const tok = (o: Partial<ModelTok[string]>) => ({ ...zeroTok(), ...o });

function world(items: WorkItem[], sessions: SessionInfo[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-carried-'));
  const ctx: SpendContext = { work: () => items, session: (id) => sessions.find((s) => s.id === id), priorResults: () => 1, now: () => T0 + 3_600_000 };
  return { dir, spend: new SpendStore(dir, ctx) };
}
let seq = 0;
const result = (t: number, usage: TurnUsage | undefined, costUsd: number): TranscriptEvent => ({ seq: ++seq, t: iso(t), kind: 'result', ok: true, text: 'done', costUsd, turns: 3, durationMs: 30_000, ...(usage ? { usage } : {}) });
const user = (t: number, text: string): TranscriptEvent => ({ seq: ++seq, t: iso(t), kind: 'user', text, from: 'orchestrator' });
async function* each(events: TranscriptEvent[]) {
  for (const e of events) yield e;
}

// The running total of an orchestrator, and the same totals as the CLI saved them a few turns back (one count lower).
const RUNNING = { [OPUS]: tok({ in: 600_000, out: 4_000_000, cr: 900_000_000, cw: 19_000_000, usd: 400 }) };
const CARRIED = { [OPUS]: tok({ in: 599_000, out: 3_999_000, cr: 899_000_000, cw: 18_990_000, usd: 399.4 }) };
const MAIN = { in: 40, out: 1_500, cr: 900_000, cw: 20_000 }; // this turn: about 12 calls at 75k

test('carriedTotals (w2007): an older saved running total dwarfs the turn; a count that began again holds about the turn', () => {
  assert.equal(carriedTotals(918e6, 920_040, 399.4, 400), true);
  // a fresh process: its totals are this turn (and its subagents)
  assert.equal(carriedTotals(1_100_000, 920_040, 6, 10), false);
  // a young session whose fresh turn cost more than half its past: still this turn
  assert.equal(carriedTotals(3_000_000, 2_500_000, 6, 10), false);
  // no main-loop usage (an older daemon): the rule before
  assert.equal(carriedTotals(918e6, undefined, 399.4, 400), false);
  // fell below half: began again
  assert.equal(carriedTotals(918e6, 920_040, 150, 400), false);
});

test('w2007: a resumed process flagged restarted whose totals are its older save bills the turn its own usage, not the running total', () => {
  const w = world([item('w1737')], [coordinator('o')]);
  w.spend.observe('o', user(T0, '[worker update] w1737 "Regression check"'));
  w.spend.observe('o', result(T0 + 60_000, { cum: RUNNING }, 400));
  const before = w.spend.request('w1737')!.total;
  w.spend.observe('o', user(T0 + 120_000, '[worker update] w1737 "Regression check": DONE'));
  w.spend.observe('o', result(T0 + 180_000, { restarted: true, cum: CARRIED, main: MAIN }, 399.4));
  const r = w.spend.request('w1737')!;
  const turn = r.total.usd - before.usd;
  assert.ok(Math.abs(turn - listUsd(OPUS, MAIN)) < 1e-6, `the turn added $${turn}`);
  assert.ok(turn < 1, 'not the $399 running total');
  assert.equal(r.total.cr - before.cr, MAIN.cr);
  assert.ok(r.estimated.usd > 0, 'labelled an estimate');
  // and the turn after it is the rise from the carried totals
  w.spend.observe('o', user(T0 + 200_000, '[worker update] w1737 "Regression check"'));
  w.spend.observe('o', result(T0 + 240_000, { cum: { [OPUS]: tok({ ...CARRIED[OPUS], cr: CARRIED[OPUS].cr + 800_000, usd: 399.9 }) } }, 399.9));
  assert.ok(Math.abs(w.spend.request('w1737')!.total.usd - before.usd - turn - 0.5) < 1e-6);
});

test('w2007: a new process whose totals began again still counts its first turn in full, with its main-loop usage beside it', () => {
  const w = world([item('w1')], [coordinator('o')]);
  w.spend.observe('o', user(T0, '[work request] w1 "x"'));
  w.spend.observe('o', result(T0 + 60_000, { cum: { [OPUS]: tok({ in: 10, out: 100, cr: 1_000_000, cw: 50_000, usd: 10 }) } }, 10));
  w.spend.observe('o', user(T0 + 120_000, '[work request] w1 "x"'));
  w.spend.observe('o', result(T0 + 180_000, { restarted: true, cum: { [OPUS]: tok({ in: 5, out: 80, cr: 700_000, cw: 40_000, usd: 6 }) }, main: { in: 5, out: 80, cr: 650_000, cw: 40_000 } }, 6));
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 16) < 1e-9);
});

test('firstResultBase (w2007): a first total below the last one that is the older save keeps the session figure; one that began again adds in full', () => {
  assert.deepEqual(firstResultBase(600, 400, 399.4, true), { base: 600 - 399.4, restarted: false });
  assert.deepEqual(firstResultBase(600, 400, 0.7, false), { base: 600, restarted: true });
});

test('backfillTurnUsd (w2007): a drop to no less than half is the older saved total and reads nothing', () => {
  assert.equal(backfillTurnUsd(5, undefined), 5);
  assert.equal(backfillTurnUsd(201, 200), 1);
  assert.equal(backfillTurnUsd(199, 200), 0);
  assert.equal(backfillTurnUsd(0.7, 200), 0.7);
});

test('correctCarried (w2007): a live turn billed the running total is taken back to its own usage, on the same request and day, once', async () => {
  const w = world([item('w1737'), item('w9')], [coordinator('o')]);
  const events = [user(T0, '[worker update] w1737 "x"'), result(T0 + 60_000, { cum: RUNNING }, 400), user(T0 + 120_000, '[worker update] w1737 "x"'), result(T0 + 180_000, { restarted: true, cum: CARRIED, main: MAIN }, 399.4)];
  w.spend.observe('o', events[0]);
  w.spend.observe('o', events[1]);
  // the record as the rule before w2007 left it: the carried totals as the turn
  const s = w.spend.session('o')!;
  s.carriedV = undefined;
  w.spend.add({ s, at: events[3].t, models: CARRIED, total: sumTok(Object.values(CARRIED)), estimated: false, allocs: [{ id: 'w1737', weight: 1, how: 'message' }] });
  assert.ok(Math.abs(w.spend.request('w1737')!.total.usd - 799.4) < 1e-6);
  const r = await w.spend.correctCarried('o', each(events), coordinator('o'));
  assert.equal(r.turns, 1, JSON.stringify(r));
  assert.ok(Math.abs(r.removedUsd - (399.4 - listUsd(OPUS, MAIN))) < 1e-6);
  const req = w.spend.request('w1737')!;
  assert.ok(Math.abs(req.total.usd - 400 - listUsd(OPUS, MAIN)) < 1e-6, `w1737 holds $${req.total.usd}`);
  assert.equal(req.turns, 2);
  assert.ok(Math.abs(req.days['2026-10-22'].usd - req.total.usd) < 1e-6);
  const coordDay = Object.values(req.coordDays!['o'])[0];
  assert.ok(Math.abs(coordDay.usd - req.total.usd) < 1e-6, 'its coordination moves with it');
  assert.ok(Math.abs(w.spend.session('o')!.total.usd - req.total.usd) < 1e-6);
  assert.equal(w.spend.request('w9'), undefined);
  // once
  assert.deepEqual(await w.spend.correctCarried('o', each(events), coordinator('o')), { removedUsd: 0, turns: 0 });
});

test('correctCarried (w2007): a backfilled turn whose cost total dropped a little is taken out (w863, w788: $67 each, 335M cache reads)', async () => {
  const w = world([item('w863')], [coordinator('d', { orchestratorRole: 'dispatcher', title: 'Dispatcher', costUsd: 500 })]);
  const t = Date.parse('2026-10-10T12:00:00Z');
  const events = [user(t, '[work request] w863 "x"'), result(t + 60_000, undefined, 200), user(t + 120_000, '[work request] w863 "x"'), result(t + 180_000, undefined, 199)];
  // the backfill as it was: 200, then the dropped total 199 again, its tokens estimated
  w.spend.add({ s: (w.spend as unknown as { sessionRec: (id: string, i: SessionInfo, at: string) => never }).sessionRec('d', coordinator('d', { orchestratorRole: 'dispatcher' }), events[1].t), at: events[1].t, models: { [OPUS]: estimateTurn(OPUS, 200, 0, 0) }, total: estimateTurn(OPUS, 200, 0, 0), estimated: true, allocs: [{ id: 'w863', weight: 1, how: 'message' }] });
  const s = w.spend.session('d')!;
  s.liveFrom = undefined;
  s.carriedV = undefined;
  w.spend.add({ s, at: events[3].t, models: { [OPUS]: estimateTurn(OPUS, 199, 0, 0) }, total: estimateTurn(OPUS, 199, 0, 0), estimated: true, allocs: [{ id: 'w863', weight: 1, how: 'message' }] });
  const r = await w.spend.correctCarried('d', each(events), coordinator('d', { orchestratorRole: 'dispatcher', costUsd: 500 }));
  assert.equal(r.turns, 1, JSON.stringify(r));
  assert.ok(Math.abs(w.spend.request('w863')!.total.usd - 200) < 1e-6);
});

test('correctCarried (w2007): the turns the carried-totals rule recorded itself (the resumes at the deploy) are left alone', async () => {
  const w = world([item('w1')], [coordinator('o')]);
  const events = [user(T0, '[worker update] w1 "x"'), result(T0 + 60_000, { cum: RUNNING }, 400), user(T0 + 120_000, '[worker update] w1 "x"'), result(T0 + 180_000, { restarted: true, cum: CARRIED, main: MAIN }, 399.4)];
  w.spend.observe('o', events[0]);
  w.spend.observe('o', events[1]);
  w.spend.session('o')!.carriedV = undefined; // a session from before w2007
  w.spend.observe('o', events[2]);
  w.spend.observe('o', events[3]); // the first turn after the deploy: recorded right, and marked
  assert.equal(w.spend.session('o')!.carriedFrom, events[3].seq);
  const r = await w.spend.correctCarried('o', each(events), coordinator('o'));
  assert.deepEqual(r, { removedUsd: 0, turns: 0 });
  assert.ok(Math.abs(w.spend.request('w1')!.total.usd - 400 - listUsd(OPUS, MAIN)) < 1e-6);
});

test('Store.scanTranscript (w2007): the lines it keeps, in order, from the file or its .gz, read in pieces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  const store = new Store(dir);
  store.append('a', { kind: 'user', text: 'first', from: 'orchestrator' });
  store.append('a', { kind: 'tool_result', toolUseId: 't', isError: false, text: 'x'.repeat(5 * 1024 * 1024) }); // longer than a read
  store.append('a', { kind: 'result', ok: true, text: 'done', costUsd: 1, turns: 1, durationMs: 1 });
  store.flush?.();
  const keep = (l: string) => l.includes('"kind":"result"') || l.includes('"kind":"user"');
  const kinds = async () => {
    const out: string[] = [];
    for await (const e of store.scanTranscript('a', keep)) out.push(e.kind);
    return out;
  };
  assert.deepEqual(await kinds(), ['user', 'result']);
  const f = path.join(dir, 'transcripts', 'a.jsonl');
  fs.writeFileSync(`${f}.gz`, zlib.gzipSync(fs.readFileSync(f)));
  fs.rmSync(f);
  assert.deepEqual(await kinds(), ['user', 'result']);
  const none: string[] = [];
  for await (const e of store.scanTranscript('nobody', keep)) none.push(e.kind);
  assert.deepEqual(none, []);
});

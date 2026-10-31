// w2653: the per-session record of model and effort, the turn log, the backfill's labels and spend_export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zeroTok, type ModelTok, type TurnUsage } from '../shared/spend.ts';
import { SpendStore, inferredEffort, WORKER_MEDIUM_FROM, type SpendContext, type TurnLine } from './spend.ts';
import { readTurns, spendExport } from './spendExport.ts';
import type { Requester, SessionInfo, TranscriptEvent, WorkItem } from '../shared/types.ts';

const T0 = Date.parse('2026-10-30T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const BEN: Requester = { userId: 'ben', displayName: 'Ben' } as Requester;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

const item = (id: string, patch: Partial<WorkItem> = {}): WorkItem =>
  ({ id, title: `Request ${id}`, brief: 'Do it.', priority: 'normal', keys: [], requestedBy: BEN, requesters: [BEN], humanAsked: true, status: 'active', createdAt: iso(T0 - 3_600_000), updatedAt: iso(T0), sessionIds: [], overlaps: [], asks: 0, log: [], ...patch }) as WorkItem;
const session = (id: string, patch: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, kind: 'worker', title: `w1: ${id}`, status: 'idle', permissionMode: 'default', createdAt: iso(T0), lastActivityAt: iso(T0), turns: 0, costUsd: 0, pendingPermissions: [], model: OPUS, ...patch }) as SessionInfo;
const tok = (o: Partial<ModelTok[string]>) => ({ ...zeroTok(), ...o });

let seq = 0;
const result = (t: number, usage: TurnUsage, costUsd: number): TranscriptEvent => ({ seq: ++seq, t: iso(t), kind: 'result', ok: true, text: 'done', costUsd, turns: 3, durationMs: 30_000, usage });

function world(items: WorkItem[], sessions: SessionInfo[], extra: Partial<SpendContext> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-export-test-'));
  const ctx: SpendContext = { work: () => items, session: (id) => sessions.find((s) => s.id === id), priorResults: () => 1, now: () => T0 + 86_400_000, ...extra };
  return { dir, spend: new SpendStore(dir, ctx) };
}

/** Rows of a CSV page, by its header line (the first line not starting with #). */
function rows(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((l) => !l.startsWith('#'));
  const split = (l: string) => {
    let out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q && c === '"' && l[i + 1] === '"') [cur, i] = [cur + '"', i + 1];
      else if (c === '"') q = !q;
      else if (c === ',' && !q) [out, cur] = [[...out, cur], ''];
      else cur += c;
    }
    return [...out, cur];
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

test('w2653: a turn records the model and effort the process ran on; a change adds a run; the turn log holds each turn', () => {
  const items = [item('w1', { sessionIds: ['s1', 'c1'], links: { s1: { at: iso(T0), how: 'sent' } } })];
  const sessions = [session('s1', { sandboxId: 'slot2', machineId: 'beast' }), session('c1', { kind: 'orchestrator', orchestratorRole: 'personal', title: 'Ben', model: SONNET })];
  const { dir, spend } = world(items, sessions);
  spend.observe('s1', result(T0 + 60_000, { cum: { [OPUS]: tok({ out: 1000, usd: 1 }) }, run: { model: OPUS, effort: 'medium' } }, 1));
  spend.observe('s1', result(T0 + 120_000, { cum: { [OPUS]: tok({ out: 1500, usd: 1.5 }) }, run: { model: OPUS, effort: 'medium' } }, 1.5));
  const s = spend.session('s1')!;
  assert.deepEqual(s.runs, [{ at: iso(T0 + 60_000), model: OPUS, effort: 'medium', src: 'recorded', from: 'process' }], 'one run while nothing changes');
  assert.equal(s.sandbox, 'slot2');
  // A coordinator moves model per turn (w1158): a second run.
  spend.observe('c1', result(T0 + 60_000, { cum: { [SONNET]: tok({ out: 10, usd: 0.1 }) }, run: { model: SONNET, effort: 'medium' } }, 0.1));
  spend.observe('c1', result(T0 + 180_000, { cum: { [SONNET]: tok({ out: 10, usd: 0.1 }), [OPUS]: tok({ out: 50, usd: 0.4 }) }, run: { model: OPUS, effort: 'medium' } }, 0.5));
  assert.deepEqual(
    spend.session('c1')!.runs!.map((r) => [r.model, r.effort, r.src]),
    [
      [SONNET, 'medium', 'recorded'],
      [OPUS, 'medium', 'recorded'],
    ],
  );
  const lines = fs
    .readFileSync(path.join(dir, 'spend-turns', '2026-10.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TurnLine);
  assert.equal(lines.length, 4);
  assert.deepEqual(
    { s: lines[1].s, role: lines[1].role, sb: lines[1].sb, m: lines[1].m, model: lines[1].model, effort: lines[1].effort, src: lines[1].src, req: lines[1].req, out: lines[1].models[OPUS].out },
    { s: 's1', role: 'worker', sb: 'slot2', m: 'beast', model: OPUS, effort: 'medium', src: 'recorded', req: [['w1', 1]], out: 500 },
  );
  assert.equal(JSON.stringify(lines).includes('account'), false, 'no account in the log');
});

test('w2653: without the process\'s word, a session\'s own effort is recorded and a default one is inferred', () => {
  const sessions = [session('s1', { effort: 'xhigh' }), session('s2'), session('s3')];
  const { spend } = world([item('w1', { sessionIds: ['s1', 's2', 's3'] })], sessions, { effortDefault: (role) => (role === 'worker' ? 'medium' : undefined) });
  spend.observe('s1', result(T0, { cum: { [OPUS]: tok({ usd: 1 }) } }, 1));
  spend.observe('s2', result(T0, { cum: { [OPUS]: tok({ usd: 1 }) } }, 1));
  // A process that passed a model but no effort ran on the CLI's own default: inferred.
  spend.observe('s3', result(T0, { cum: { [OPUS]: tok({ usd: 1 }) }, run: { model: OPUS } }, 1));
  assert.deepEqual(spend.session('s1')!.runs![0], { at: iso(T0), model: OPUS, effort: 'xhigh', src: 'recorded', from: 'session' });
  assert.deepEqual(spend.session('s2')!.runs![0], { at: iso(T0), model: OPUS, effort: 'medium', src: 'inferred', from: 'default' });
  assert.deepEqual(spend.session('s3')!.runs![0], { at: iso(T0), model: OPUS, effort: 'medium', src: 'inferred', from: 'default' });
});

test('w2653: the backfill marks each past session recorded or inferred, by the defaults as they were, once', () => {
  const sessions = [session('kept', { effort: 'high' }), session('keptNoEffort')];
  const { spend } = world([], sessions);
  const before = '2026-10-20T10:00:00Z';
  const after = '2026-10-25T10:00:00Z';
  const past = (id: string, role: 'worker' | 'personal' | 'ops', at: string, models: ModelTok) =>
    spend.sessions.set(id, { id, role, title: id, firstAt: at, lastAt: at, turns: 1, total: zeroTok(), models, estimated: zeroTok(), requests: {}, cats: {}, calls: 0, ctxMax: 0, compactions: 0, transcript: { state: 'full' } });
  past('kept', 'worker', before, { [OPUS]: tok({ usd: 1 }) });
  past('keptNoEffort', 'worker', after, { [OPUS]: tok({ usd: 1 }) });
  past('gone', 'worker', before, { [SONNET]: tok({ usd: 0.2 }), [OPUS]: tok({ usd: 3 }) });
  past('goneAfter', 'worker', after, { [OPUS]: tok({ usd: 3 }) });
  past('coord', 'personal', before, { [SONNET]: tok({ usd: 1 }) });
  assert.equal(spend.backfillRuns(), 5);
  const run = (id: string) => spend.session(id)!.runs![0];
  assert.deepEqual(run('kept'), { at: before, model: OPUS, effort: 'high', src: 'recorded', from: 'backfill: model recorded, effort recorded' });
  // A value taken from a default is inferred, even when the model was recorded.
  assert.deepEqual(run('keptNoEffort'), { at: after, model: OPUS, effort: 'medium', src: 'inferred', from: 'backfill: model recorded, effort default' });
  assert.deepEqual(run('gone'), { at: before, model: OPUS, effort: 'high', src: 'inferred', from: 'backfill: model billed most, effort default' });
  assert.equal(run('goneAfter').effort, 'medium');
  assert.equal(run('coord').effort, 'medium');
  assert.equal(spend.backfillRuns(), 0, 'a second pass fills nothing');
  assert.equal(inferredEffort('worker', '2026-10-24T07:19:59Z'), 'high');
  assert.equal(inferredEffort('standing', WORKER_MEDIUM_FROM), 'medium');
  assert.equal(inferredEffort('ops', before), 'medium');
});

test('w2653: spend_export answers any range with workers\' and coordinators\' cost apart, sessions by model and effort, and no account', () => {
  const items = [
    item('w1', { sessionIds: ['a', 'c'], status: 'done', links: { a: { at: iso(T0), how: 'sent' } } }),
    item('w2', { sessionIds: ['b'], status: 'done', title: 'Two, with "quotes", and commas', links: { b: { at: iso(T0), how: 'sent' } } }),
    item('w3', { sessionIds: ['d'], status: 'cancelled', links: { d: { at: iso(T0), how: 'sent' } } }),
  ];
  const sessions = [
    session('a', { ranAs: 'vault-secret-label-1', account: 'acct-key-9' } as Partial<SessionInfo>),
    session('b', { ranAs: 'vault-secret-label-1' } as Partial<SessionInfo>),
    session('c', { kind: 'orchestrator', orchestratorRole: 'personal', title: 'Ben', model: SONNET }),
    session('d'),
  ];
  const { spend } = world(items, sessions, { accountLabel: () => 'account acct-key-9' });
  const run = { model: OPUS, effort: 'medium' };
  spend.observe('a', result(T0 + 60_000, { cum: { [OPUS]: tok({ out: 1000, usd: 4 }) }, run }, 4));
  spend.observe('b', result(T0 + 60_000, { cum: { [OPUS]: tok({ out: 3000, usd: 2 }) }, run: { model: OPUS, effort: 'high' } }, 2));
  spend.observe('d', result(T0 + 60_000, { cum: { [OPUS]: tok({ out: 9, usd: 9 }) }, run }, 9));
  // The coordinator's turn names w1: coordination, not the workers' cost.
  spend.observe('c', { seq: ++seq, t: iso(T0 + 90_000), kind: 'user', text: 'about w1', from: 'human' } as TranscriptEvent);
  spend.observe('c', result(T0 + 120_000, { cum: { [SONNET]: tok({ out: 5, usd: 0.5 }) }, run: { model: SONNET, effort: 'medium' } }, 0.5));
  // A turn a day later, outside the range below.
  spend.observe('a', result(T0 + 86_400_000, { cum: { [OPUS]: tok({ out: 1100, usd: 5 }) }, run }, 5));
  spend.syncWork();
  const since = iso(T0);
  const until = iso(T0 + 3_600_000);

  const req = rows(spendExport(spend, { view: 'requests', since, until: iso(T0 + 2 * 86_400_000) }));
  const w1 = req.find((r) => r.id === 'w1')!;
  assert.equal(w1.status, 'done');
  assert.equal(Number(w1.worker_usd), 5);
  assert.equal(Number(w1.coord_usd), 0.5);
  assert.equal(Number(w1.total_usd), 5.5);
  assert.equal(w1.worker_runs, `${OPUS}/medium (recorded)`);
  assert.equal(w1.filed_at, iso(T0 - 3_600_000));
  assert.equal(req.find((r) => r.id === 'w2')!.title, 'Two, with "quotes", and commas', 'CSV quoting holds');

  const sum = spendExport(spend, { view: 'summary', since, until: iso(T0 + 2 * 86_400_000) });
  const done = rows(sum).find((r) => r.section === 'done_requests' && r.kind === '(all)')!;
  assert.equal(done.count, '2', 'the cancelled one is not a finished request');
  assert.equal(Number(done.worker_usd_sum), 7);
  assert.equal(Number(done.worker_usd_mean), 3.5);
  assert.match(sum, /\nsessions,worker,claude-opus-5-5,medium,2,2,0,1109,555,555,14,7,7$/);
  assert.match(sum, /\nsessions,worker,claude-opus-5-5,high,1,1,0,3000,3000,3000,2,2,2/);

  const ss = rows(spendExport(spend, { view: 'sessions', since, until, role: 'worker' }));
  assert.deepEqual(ss.map((r) => [r.session, r.model, r.effort, r.src]).sort(), [
    ['a', OPUS, 'medium', 'recorded'],
    ['b', OPUS, 'high', 'recorded'],
    ['d', OPUS, 'medium', 'recorded'],
  ]);

  // The turn log cuts exactly: a's second turn is outside the hour.
  const byReq = rows(spendExport(spend, { view: 'turns', since, until }));
  assert.equal(Number(byReq.find((r) => r.request === 'w1')!.usd), 4.5);
  const byEffort = rows(spendExport(spend, { view: 'turns', group_by: 'effort', since, until: iso(T0 + 2 * 86_400_000) }));
  assert.equal(Number(byEffort.find((r) => r.effort === 'medium')!.usd), 14.5);
  assert.equal(readTurns(spend.turnDir, T0, T0 + 3_600_000).length, 4);

  for (const view of ['summary', 'requests', 'sessions', 'turns'] as const) {
    const out = spendExport(spend, { view, since: '2026-10-01', until: '2026-11-02', group_by: 'none' });
    assert.equal(/vault-secret|acct-key/.test(out), false, `${view}: no account in the export`);
  }
  assert.throws(() => spendExport(spend, { since: '2026-10-30T12:00:00' }), /needs a zone/);
  assert.throws(() => spendExport(spend, { since: until, until: since }), /must come before/);
});

test('w2653: a page stops at its limit and says where the next starts', () => {
  const items = Array.from({ length: 5 }, (_, i) => item(`w${i + 1}`, { status: 'done', sessionIds: [`s${i}`], links: { [`s${i}`]: { at: iso(T0), how: 'sent' } } }));
  const { spend } = world(items, items.map((_, i) => session(`s${i}`)));
  items.forEach((_, i) => spend.observe(`s${i}`, result(T0 + 60_000, { cum: { [OPUS]: tok({ usd: 1 }) }, run: { model: OPUS, effort: 'medium' } }, 1)));
  spend.syncWork();
  const p1 = spendExport(spend, { view: 'requests', since: iso(T0), limit: 2 }, T0 + 86_400_000);
  assert.equal(rows(p1).length, 2);
  assert.match(p1, /# rows 1-2 of 5; the next page: offset 2$/);
  assert.match(spendExport(spend, { view: 'requests', since: iso(T0), offset: 4 }, T0 + 86_400_000), /# rows 5-5 of 5, the last page$/);
});

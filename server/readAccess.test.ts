import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleOn, ReadScope, type ReadPolicy } from './readAccess.ts';
import { privacyGuardsOn } from './config.ts';
import type { ReportSummary, SessionInfo, WorkItem } from '../shared/types.ts';

const ben = { userId: 'ben', displayName: 'Ben' };
const cassidy = { userId: 'cassidy', displayName: 'Cassidy' };
const dana = { userId: 'dana', displayName: 'Dana' };

const session = (id: string, over: Partial<SessionInfo> = {}) => ({ id, kind: 'worker', ...over }) as SessionInfo;
const work = (id: string, over: Partial<WorkItem> = {}) => ({ id, requestedBy: ben, requesters: [ben], sessionIds: [], ...over }) as WorkItem;

const ledger = [
  work('w1', { requestedBy: cassidy, requesters: [cassidy], sessionIds: ['wk-c'], reviewTopics: ['lens-stills'], attachments: [{ id: 'att_onrequest01' } as never] }),
  work('w2', { sessionIds: ['wk-b'], reviewTopics: ['ben-private'] }),
  work('w3', { sessionIds: ['wk-q'], question: { text: 'which lens?', at: '', for: [dana] } }),
];
const roles: Record<string, 'owner' | 'member'> = { ben: 'owner', cassidy: 'member', dana: 'member' };
const policy = (on = true): ReadPolicy => ({ on, roleOf: (u) => roles[u], work: () => ledger });

const sessions: Record<string, SessionInfo> = {
  'orch-ben': session('orch-ben', { kind: 'orchestrator', orchestratorRole: 'personal', requestedBy: ben }),
  'orch-cassidy': session('orch-cassidy', { kind: 'orchestrator', orchestratorRole: 'personal', requestedBy: cassidy }),
  dispatcher: session('dispatcher', { kind: 'orchestrator', orchestratorRole: 'dispatcher' }),
  ops: session('ops', { kind: 'ops' }),
  'wk-c': session('wk-c'),
  'wk-b': session('wk-b', { requestedBy: ben }),
  'wk-q': session('wk-q'),
  'wk-asked': session('wk-asked', { lastRequestedBy: cassidy }),
};
const info = (id: string) => sessions[id];

test('an owner reads every session, report and file', () => {
  const s = new ReadScope(policy(), 'ben');
  assert.equal(s.all, true);
  for (const x of Object.values(sessions)) assert.equal(s.session(x), true, x.id);
  assert.equal(s.reviewTopic('anything'), true);
  assert.equal(s.attachment({ id: 'att_x' }, info), true);
});

test("a member reads their own orchestrator and their requests' workers, nobody else's", () => {
  const s = new ReadScope(policy(), 'Cassidy');
  assert.equal(s.all, false);
  const readable = Object.values(sessions).filter((x) => s.session(x)).map((x) => x.id);
  assert.deepEqual(readable.sort(), ['orch-cassidy', 'wk-asked', 'wk-c']);
  assert.equal(s.session(undefined), false);
});

test("whom a request's question waits on reads its workers", () => {
  const s = new ReadScope(policy(), 'dana');
  assert.equal(s.session(sessions['wk-q']), true);
  assert.equal(s.workItem(ledger[2]), true);
  assert.equal(s.workItem(ledger[0]), false);
  assert.deepEqual([...peopleOn(ledger[2])].sort(), ['ben', 'dana']);
});

test('a member reads the reports, attachments and review topics of their requests only', () => {
  const s = new ReadScope(policy(), 'cassidy');
  const report = (workId: string, requesters = [ben], sessionId?: string) => ({ id: 'r1', workId, requesters, sessionId, attachments: [] }) as unknown as ReportSummary;
  assert.equal(s.report(report('w1', [])), true);
  assert.equal(s.report(report('w9', [cassidy])), true);
  assert.equal(s.report(report('w2')), false);
  assert.equal(s.report(report('w9', [ben], 'wk-c'), info), true);

  assert.equal(s.attachment({ id: 'att_mine0000001', uploadedBy: 'cassidy' }, info), true);
  assert.equal(s.attachment({ id: 'att_onrequest01' }, info), true);
  assert.equal(s.attachment({ id: 'att_published1', session: 'wk-c' }, info), true);
  assert.equal(s.attachment({ id: 'att_bens000001', uploadedBy: 'ben' }, info), false);
  const filed = { ...report('w2'), attachments: [{ id: 'att_inreport01' }] } as unknown as ReportSummary;
  assert.equal(s.attachment({ id: 'att_inreport01' }, info, () => [filed]), false);
  assert.equal(s.attachment({ id: 'att_inreport01' }, info, () => [{ ...filed, workId: 'w1' }]), true);

  assert.equal(s.reviewTopic('lens-stills'), true);
  assert.equal(s.reviewTopic('ben-private'), false);
  assert.equal(s.delegation({ workId: 'w1' }), true);
  assert.equal(s.delegation({}), false);
});

test('with the guards off every login reads everything, as before w17', () => {
  const s = new ReadScope(policy(false), 'cassidy');
  assert.equal(s.all, true);
  assert.equal(s.session(sessions.dispatcher), true);
  assert.equal(s.reviewTopic('ben-private'), true);
});

test('the guards are off for Final Factory and on for the other factories unless config says', () => {
  assert.equal(privacyGuardsOn({}), false);
  assert.equal(privacyGuardsOn({ project: { name: 'Final Factory' } }), false);
  assert.equal(privacyGuardsOn({ project: { name: 'Lens Scout' } }), true);
  assert.equal(privacyGuardsOn({ project: { name: 'Lens Scout' }, privacyGuards: false }), false);
  assert.equal(privacyGuardsOn({ privacyGuards: true }), true);
});

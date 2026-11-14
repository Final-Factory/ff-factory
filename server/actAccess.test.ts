import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActScope, peopleOn, type ActPolicy } from '../shared/actAccess.ts';
import { privacyGuardsOn } from './config.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

const ben = { userId: 'ben', displayName: 'Ben' };
const cassidy = { userId: 'cassidy', displayName: 'Cassidy' };
const dana = { userId: 'dana', displayName: 'Dana' };

const session = (id: string, over: Partial<SessionInfo> = {}) => ({ id, kind: 'worker', ...over }) as SessionInfo;
const work = (id: string, over: Partial<WorkItem> = {}) => ({ id, requestedBy: ben, requesters: [ben], sessionIds: [], ...over }) as WorkItem;

const ledger = [
  work('w1', { requestedBy: cassidy, requesters: [cassidy], sessionIds: ['wk-c'] }),
  work('w2', { sessionIds: ['wk-b'] }),
  work('w3', { sessionIds: ['wk-q'], question: { text: 'which lens?', at: '', for: [dana] } }),
];
const roles: Record<string, 'owner' | 'member'> = { ben: 'owner', cassidy: 'member', dana: 'member' };
const policy: ActPolicy = { roleOf: (u) => roles[u], work: () => ledger };

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

test('an owner acts on every session, and so does the portal itself', () => {
  for (const who of ['ben', undefined]) {
    const s = new ActScope(policy, who);
    assert.equal(s.all, true);
    for (const x of Object.values(sessions)) assert.equal(s.session(x), true, x.id);
  }
});

test("a member acts on their own orchestrator and their requests' workers, nobody else's", () => {
  const s = new ActScope(policy, 'Cassidy');
  assert.equal(s.all, false);
  const acted = Object.values(sessions).filter((x) => s.session(x)).map((x) => x.id);
  assert.deepEqual(acted.sort(), ['orch-cassidy', 'wk-asked', 'wk-c']);
  assert.equal(s.session(undefined), false);
});

test("whom a request's question waits on acts on its workers", () => {
  const s = new ActScope(policy, 'dana');
  assert.equal(s.session(sessions['wk-q']), true);
  assert.equal(s.session(sessions['wk-c']), false);
  assert.deepEqual([...peopleOn(ledger[2])].sort(), ['ben', 'dana']);
});

test('privacyGuards (the worker guard) is off for Final Factory and on for the other factories unless config says', () => {
  assert.equal(privacyGuardsOn({}), false);
  assert.equal(privacyGuardsOn({ project: { name: 'Final Factory' } }), false);
  assert.equal(privacyGuardsOn({ project: { name: 'Lens Scout' } }), true);
  assert.equal(privacyGuardsOn({ project: { name: 'Lens Scout' }, privacyGuards: false }), false);
  assert.equal(privacyGuardsOn({ privacyGuards: true }), true);
});

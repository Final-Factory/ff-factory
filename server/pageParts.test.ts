import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../shared/types.ts';
import { dropKeptParts, fillKeptParts, HASH_MEMO_CHARS, hashOf, hashText, partsHave, PARTS_HAVE_MAX, readPartsHave } from '../shared/pageParts.ts';

/** A state with the parts a reconnect may keep, as plain JSON values (what the page parses). */
function stateOf(work: { id: string; title: string }[], machineNote = 'up'): AppState {
  return {
    sessions: [],
    standingAgents: [{ id: 'sa1', name: 'nightly' }],
    delegations: [{ id: 'd1', status: 'open' }],
    machines: [{ id: 'beast', note: machineNote }, { id: 'm5', note: 'up' }],
    accounts: [{ id: 'a1', pct: 40 }],
    reports: [{ id: 'r1', title: 'design' }],
    work,
    me: { userId: 'lothsahn' },
  } as unknown as AppState;
}

/** Over the wire, both ways: what the page holds is what JSON gives back. */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The page's state after a reconnect: its copy, the server's answer to its hashes laid on it. */
function reconnect(page: AppState, server: AppState): { got: AppState; sent: AppState } {
  const sent = wire(dropKeptParts(server, partsHave(page)));
  const got = fillKeptParts(page, sent);
  assert.ok(got, 'the page could lay the answer on its copy');
  return { got, sent };
}

test('w6336: a reconnect resends only the parts and requests that changed, and the page ends with what a fresh load shows', () => {
  const before = stateOf([{ id: 'w2', title: 'two' }, { id: 'w1', title: 'one' }, { id: 'w4', title: 'four' }]);
  const page = wire(before);
  // Meanwhile: w1 changed and moved first, w3 is new, w2 aged off the page's list, and beast's note changed.
  const now = stateOf([{ id: 'w1', title: 'one, edited' }, { id: 'w3', title: 'three' }, { id: 'w4', title: 'four' }], 'busy');
  const { got, sent } = reconnect(page, now);
  assert.deepEqual(sent.partsKept, ['reports', 'delegations', 'accounts', 'standingAgents']);
  assert.equal(sent.machines.length, 2, 'machines changed: sent whole');
  assert.deepEqual(sent.workDelta, { ids: ['w1', 'w3', 'w4'] });
  assert.deepEqual(sent.work?.map((w) => w.id), ['w1', 'w3'], 'the unchanged w4 is not resent');
  assert.deepEqual(wire(got), wire(now), 'the same state a fresh load gets');
});

test('w6336: nothing changed: every whole part and every request stays the page’s own', () => {
  const now = stateOf([{ id: 'w1', title: 'one' }]);
  const { got, sent } = reconnect(wire(now), now);
  assert.equal(sent.reports, undefined);
  assert.equal(sent.machines, undefined);
  assert.deepEqual(sent.work, []);
  assert.deepEqual(wire(got), wire(now));
});

test('w6336: a part the live events left behind on the page is sent again, not kept', () => {
  const now = stateOf([{ id: 'w1', title: 'one' }]);
  const page = wire(now);
  page.reports = [{ id: 'r1', title: 'an older title' }] as unknown as AppState['reports'];
  page.work = [{ id: 'w1', title: 'stale' }] as unknown as AppState['work'];
  const { got, sent } = reconnect(page, now);
  assert.ok(sent.reports?.length);
  assert.equal(sent.work?.length, 1);
  assert.deepEqual(wire(got), wire(now));
});

test('w6336: no hashes, malformed or unknown ones: the whole state goes', () => {
  const now = stateOf([{ id: 'w1', title: 'one' }]);
  for (const raw of [undefined, null, '', 'nonsense', 'secrets:abc', 'reports:NOT-HASH', `work:${'x'.repeat(PARTS_HAVE_MAX)}`]) {
    const sent = dropKeptParts(now, raw);
    assert.equal(sent, now, `raw ${String(raw).slice(0, 20)}`);
  }
  assert.deepEqual(readPartsHave('reports:abc;work:w1=x1,bad pair,w2=y2').work, new Map([['w1', 'x1'], ['w2', 'y2']]));
});

test('w6336: an answer the page cannot lay on its copy asks for the whole state', () => {
  const now = stateOf([{ id: 'w1', title: 'one' }]);
  const sent = wire(dropKeptParts(now, partsHave(wire(now))));
  assert.equal(fillKeptParts(null, sent), undefined, 'no copy');
  const page = wire(now);
  page.work = [];
  assert.equal(fillKeptParts(page, sent), undefined, 'a kept request the page has not got');
  const full = stateOf([]);
  assert.equal(fillKeptParts(null, full), full, 'a whole state needs nothing');
});

test('w6336: the hash is stable, short and tells different JSON apart', () => {
  assert.equal(hashText('{"a":1}'), hashText('{"a":1}'));
  assert.notEqual(hashText('{"a":1}'), hashText('{"a":2}'));
  assert.match(hashText('x'.repeat(10_000)), /^[a-z0-9]{1,12}$/);
  // 100 requests' hashes fit the URL budget with the whole parts.
  const work = Array.from({ length: 100 }, (_, i) => ({ id: `w${6000 + i}`, title: `t${i}` }));
  const have = partsHave(wire(stateOf(work)));
  assert.ok(have && have.length < PARTS_HAVE_MAX && have.includes('work:'), `parts ${have?.length}`);
});

test('w6382: a part hashed again gives what its JSON hashes to, before and after the memo empties', () => {
  const a = { id: 'r1', text: 'one' };
  assert.equal(hashOf(a), hashText(JSON.stringify(a)));
  assert.equal(hashOf(a), hashText(JSON.stringify(a)));
  a.text = 'two';
  assert.equal(hashOf(a), hashText(JSON.stringify(a)));
  assert.equal(hashOf(undefined), hashText('null'));
  // Past its size the memo starts again; the hashes stay the same.
  const big = 'x'.repeat(HASH_MEMO_CHARS / 2 + 1);
  for (const v of [big, `${big}y`, big]) assert.equal(hashOf(v), hashText(JSON.stringify(v)));
  assert.equal(hashOf(a), hashText(JSON.stringify(a)));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, SessionInfo } from '../shared/types.ts';
import { applyState, bootFrom, bootQuery, cacheRecord, holdsOwnCopy, PAGE_CACHE_SHOW_MS } from '../shared/pageCache.ts';
import { dropKeptParts } from '../shared/pageParts.ts';
import { PageSessionsCache, pageSessions, SessionRevs, sessionsPart } from './pageState.ts';

const NOW = Date.parse('2026-11-28T12:00:00Z');
const BUILD = 'web-abc';

function session(id: string, idleMs: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  const at = new Date(NOW - idleMs).toISOString();
  return { id, kind: 'worker', title: id, status: 'stopped', permissionMode: 'bypassPermissions', createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, pendingPermissions: [], ...extra } as SessionInfo;
}

/** Over the wire and through IndexedDB: what the page holds is plain JSON values (a key set to undefined is no key). */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A portal with sessions and the parts a page may keep, building the first state the way server/index.ts's /ws does. */
function portal() {
  const store = new Map<string, SessionInfo>();
  const revs = new SessionRevs('runa');
  const cache = new PageSessionsCache();
  cache.onCopy = (id, withResult) => void revs.pageCopy(id, withResult);
  let machines = [{ id: 'beast', note: 'up' }];
  const work = [{ id: 'w1', title: 'one' }, { id: 'w2', title: 'two' }];
  const put = (s: SessionInfo) => {
    store.set(s.id, s);
    revs.note({ type: 'session', session: s });
    cache.note({ type: 'session', session: s });
  };
  const open = (user: string, q: { have?: string; parts?: string; u?: string } = {}): AppState => {
    const own = holdsOwnCopy(q.u, user);
    const part = sessionsPart(pageSessions(store.values(), new Set(), NOW, cache).sessions, revs, revs.since(own ? q.have : undefined));
    const whole = { ...part, machines, work, reports: [{ id: 'r1' }], accounts: [{ id: 'a1' }], delegations: [], standingAgents: [], me: { userId: user, displayName: user, role: 'owner' } } as unknown as AppState;
    return wire(dropKeptParts(whole, own ? q.parts : null));
  };
  return {
    put,
    open,
    remove(id: string) {
      store.delete(id);
      revs.note({ type: 'session_removed', id });
      cache.note({ type: 'session_removed', id });
    },
    setMachines(m: { id: string; note: string }[]) {
      machines = m;
    },
    setWork(id: string, title: string) {
      work.find((w) => w.id === id)!.title = title;
    },
  };
}

/** The page's state from a fresh load with no saved copy: the whole first state. */
function freshLoad(p: ReturnType<typeof portal>, user: string): AppState {
  const got = applyState(null, p.open(user), new Set());
  assert.ok(got);
  assert.deepEqual(got.missing, []);
  return got.app;
}

test('w6763: a fresh load drawn from the saved copy gets only what changed, and lands where a fresh load does', () => {
  const p = portal();
  for (let i = 0; i < 40; i++) p.put(session(`s${i}`, 1000, { lastResult: `report ${i}` }));
  // The page runs, then saves what it shows (IndexedDB keeps plain values, as the wire does).
  const saved = wire(cacheRecord(freshLoad(p, 'lothsahn'), BUILD, NOW));
  assert.ok(saved);
  // While the page is closed: two sessions change, one goes, one is new, a machine and a request change.
  p.put(session('s1', 0, { title: 'changed' }));
  p.put(session('s2', 0, { status: 'running' }));
  p.remove('s3');
  p.put(session('new', 0));
  p.setMachines([{ id: 'beast', note: 'down' }]);
  p.setWork('w2', 'two, renamed');
  // The next load: the copy is drawn at once, and the first socket sends its rev and hashes.
  const boot = bootFrom(saved, BUILD, NOW + 3600_000);
  assert.ok(boot?.show, "this build's copy from an hour ago is drawn");
  const q = bootQuery(boot);
  assert.equal(q.u, 'lothsahn');
  const first = p.open('lothsahn', q);
  assert.ok(first.sessionsDelta, 'the first state is a delta');
  assert.deepEqual(first.sessions.map((s) => s.id).sort(), ['new', 's1', 's2']);
  assert.ok(first.partsKept?.includes('reports'), 'unchanged parts stay the copy’s');
  assert.ok(!first.partsKept?.includes('machines'), 'a changed part is sent');
  const got = applyState(boot.base, first, new Set());
  assert.ok(got);
  assert.deepEqual(got.missing, []);
  assert.deepEqual(wire(got.app), wire(freshLoad(p, 'lothsahn')), 'the page shows what a fresh load shows');
});

test('w6763: another build’s copy is not drawn, but the first state still lands on it as a delta', () => {
  const p = portal();
  for (let i = 0; i < 10; i++) p.put(session(`s${i}`, 1000));
  const saved = wire(cacheRecord(freshLoad(p, 'ben'), 'web-old', NOW));
  p.put(session('s4', 0, { title: 'changed' }));
  const boot = bootFrom(saved, BUILD, NOW + 60_000);
  assert.ok(boot);
  assert.equal(boot.show, false);
  const first = p.open('ben', bootQuery(boot));
  assert.deepEqual(first.sessions.map((s) => s.id), ['s4']);
  assert.deepEqual(wire(applyState(boot.base, first, new Set())?.app), wire(freshLoad(p, 'ben')));
});

test('w6763: a copy of another person’s is never the base: the server sends the whole state', () => {
  const p = portal();
  for (let i = 0; i < 5; i++) p.put(session(`s${i}`, 1000));
  const boot = bootFrom(wire(cacheRecord(freshLoad(p, 'ben'), BUILD, NOW)), BUILD, NOW);
  assert.ok(boot);
  const first = p.open('lothsahn', bootQuery(boot));
  assert.equal(first.sessionsDelta, undefined);
  assert.equal(first.partsKept, undefined);
  assert.deepEqual(wire(applyState(boot.base, first, new Set())?.app), wire(freshLoad(p, 'lothsahn')));
  assert.equal(holdsOwnCopy(null, 'ben'), true, 'a page’s own state (no u) is its own');
  assert.equal(holdsOwnCopy('ben', 'lothsahn'), false);
});

test('w6763: a saved copy is used only when it is whole and this page’s', () => {
  const p = portal();
  p.put(session('s0', 0));
  const rec = wire(cacheRecord(freshLoad(p, 'ben'), BUILD, NOW))!;
  assert.equal(bootFrom(rec, BUILD, NOW + PAGE_CACHE_SHOW_MS + 1)?.show, false, 'too old to draw');
  assert.equal(bootFrom(rec, BUILD, NOW - 1)?.show, false, 'saved in the future (a clock moved): not drawn');
  assert.equal(bootFrom(rec, undefined, NOW)?.show, false, 'a dev page (no build) draws none');
  assert.equal(bootFrom({ ...rec, v: 2 }, BUILD, NOW), undefined);
  assert.equal(bootFrom({ ...rec, user: 'lothsahn' }, BUILD, NOW), undefined, 'a copy whose state is someone else’s');
  assert.equal(bootFrom({ ...rec, app: { ...rec.app, sessions: undefined } }, BUILD, NOW), undefined);
  assert.equal(bootFrom('junk', BUILD, NOW), undefined);
  assert.equal(bootFrom(undefined, BUILD, NOW), undefined);
  // Only a live state is saved: one without a rev or a signed-in person is not.
  assert.equal(cacheRecord({ ...rec.app, sessionsRev: undefined } as AppState, BUILD, NOW), undefined);
  assert.equal(cacheRecord({ ...rec.app, me: undefined } as AppState, BUILD, NOW), undefined);
  assert.equal(cacheRecord(rec.app, undefined, NOW), undefined);
});

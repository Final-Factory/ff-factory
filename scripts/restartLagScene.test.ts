// w3843: the post-restart speed-ups place exactly as before. The drain's memo scope, the claims memo's grouped sessions and
// agentOnly, the occupants index, the ledger index of workLive and the release pass's held waitLive change how often
// placement is computed, never what it decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restartScene } from './restartLagScene.ts';
import { Store } from '../server/store.ts';
import { PlaceAgain, placeFor, occupiedIn, type PlaceFacts } from '../server/placeAgain.ts';
import { holdsOf, holdsIndex } from '../shared/workState.ts';
import { useFakeVault } from '../server/testVault.ts';
import type { MachineSandbox, SessionInfo, WorkItem } from '../shared/types.ts';

useFakeVault();
const NOW = Date.parse('2026-11-09T13:03:30Z');

/** A small seeded random source, so a failure repeats. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function quietly<T>(fn: () => T): T {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** One post-restart minute of the scene: a drain, the release pass, a drain again, and the computers, as plain data. */
function minute(memos: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3843-scene-'));
  try {
    return quietly(() => {
      const s = restartScene({ sessions: 1200, work: 400, queue: 16, pressure: 4, now: NOW, dir });
      const pa = (s.agents as unknown as { placeAgain: PlaceAgain }).placeAgain;
      if (!memos) {
        // As before w3843: no drain-wide memo, each machine's sessions filtered and agentOnly read at every ask.
        const hooks = s.sessions as unknown as Record<string, unknown>;
        delete hooks.placementPass;
        delete hooks.placementFree;
        delete hooks.placementChanged;
        const own = pa as unknown as Record<string, unknown>;
        const d = (pa as unknown as { d: { sessions: () => Iterable<SessionInfo>; agentOnly?: (x: SessionInfo) => boolean } }).d;
        own.sessionsOn = (machineId: string) => [...d.sessions()].filter((x) => x.machineId === machineId && x.machineSandbox);
        own.agentOnly = (x: SessionInfo) => !!d.agentOnly?.(x);
      }
      const drained = s.sessions.drain(NOW);
      const tick = pa.tick();
      const again = s.sessions.drain(NOW);
      const places = s.agents.places().map((p) => ({ id: p.id, sandboxes: JSON.stringify(p) }));
      const queue = s.sessions.queued().map((q) => ({ id: q.id, why: q.why, on: q.on, parked: !!q.parked }));
      const placing = [...(pa as unknown as { placing: Map<string, unknown> }).placing];
      // The scene's own workers (the boot adds an orchestrator with a new id each time).
      const sessions = [...s.store.sessions.values()].filter((x) => /^sd{6}$/.test(x.id)).map((x) => [x.id, x.status, x.machineId, x.machineSandbox, x.placeReleased?.sandbox ?? '', x.placeReleased?.why ?? ''].join('|'));
      s.agents.orchestrators.close();
      s.sessions.stopAll();
      return { drained, tick, again, places, queue, placing, sessions };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('w3843: a drain, the release pass and a drain again decide the same with and without the placement memos', () => {
  const plain = minute(false);
  const memo = minute(true);
  // The scene places something: workers moved for room, resumes held for it.
  assert.ok(plain.placing.length > 0 || plain.queue.some((q) => /free/.test(q.why)), JSON.stringify(plain.queue.slice(0, 3)));
  assert.deepEqual(memo.drained, plain.drained);
  assert.deepEqual(memo.tick, plain.tick);
  assert.deepEqual(memo.again, plain.again);
  assert.deepEqual(memo.queue, plain.queue);
  assert.deepEqual(memo.placing, plain.placing);
  assert.deepEqual(memo.sessions, plain.sessions);
  assert.deepEqual(memo.places, plain.places);
});

test('w3843: holdsOf over a session\'s own requests with every request by id is holdsOf over the whole ledger', () => {
  const r = rng(3843);
  const sids = Array.from({ length: 30 }, (_, i) => `s${i}`);
  const statuses: WorkItem['status'][] = ['new', 'queued', 'blocked', 'active', 'stalled', 'done', 'closed' as WorkItem['status']];
  const iso = (ms: number) => new Date(ms).toISOString();
  const items: WorkItem[] = Array.from({ length: 200 }, (_, i) => {
    const mine = [...new Set(Array.from({ length: 1 + Math.floor(r() * 4) }, () => sids[Math.floor(r() * sids.length)]))];
    const w = { id: `w${i}`, status: statuses[Math.floor(r() * statuses.length)], sessionIds: r() < 0.1 ? [...mine, mine[0]] : mine, createdAt: iso(NOW - i * 60_000), links: {}, setAside: {}, done: {} } as unknown as WorkItem;
    for (const sid of mine) {
      if (r() < 0.8) w.links![sid] = { at: iso(NOW - Math.floor(r() * 50) * 60_000), how: r() < 0.7 ? 'sent' : 'linked' };
      // A pause names a request the worker may not be on (byId must hold every request).
      if (r() < 0.3) w.setAside![sid] = { at: iso(NOW - Math.floor(r() * 50) * 60_000), kind: r() < 0.7 ? 'paused' : 'released', ...(r() < 0.8 ? { for: `w${Math.floor(r() * 200)}` } : {}) };
      if (r() < 0.15) w.done![sid] = { at: iso(NOW), report: 'DONE' };
    }
    return w;
  });
  const index = holdsIndex(items);
  for (const sid of [...sids, 'nobody']) {
    const all = holdsOf(sid, items);
    const fast = holdsOf(sid, index.of.get(sid) ?? [], index.byId);
    assert.deepEqual([...fast.served], [...all.served], sid);
    assert.deepEqual([...fast.held], [...all.held], sid);
    assert.deepEqual([...fast.paused], [...all.paused], sid);
  }
});

test('w3843: placeFor reads the same sandbox with the occupants indexed as with every session looked through', () => {
  const r = rng(91);
  const statuses: SessionInfo['status'][] = ['running', 'starting', 'idle', 'stopped', 'error'];
  for (let round = 0; round < 200; round++) {
    const sandboxes = Array.from({ length: 2 + Math.floor(r() * 6) }, (_, i) => ({ id: `slot${i + 1}`, status: r() < 0.9 ? 'ready' : 'busy', branch: `sandbox/slot${i + 1}`, unity: { state: r() < 0.5 ? 'stopped' : 'running' }, git: { branch: r() < 0.2 ? 'feature/x' : `sandbox/slot${i + 1}`, dirty: r() < 0.1 ? 1 : 0 } })) as unknown as MachineSandbox[];
    const pick = () => sandboxes[Math.floor(r() * sandboxes.length)].id;
    const sessions = Array.from({ length: 5 + Math.floor(r() * 30) }, (_, i) => ({ id: `s${i}`, kind: 'worker', status: statuses[Math.floor(r() * statuses.length)], machineId: 'm', machineSandbox: pick(), pendingPermissions: r() < 0.05 ? [{ id: 'p' }] : [], turns: 2, createdAt: new Date(NOW - 3_600_000).toISOString(), lastActivityAt: new Date(NOW - Math.floor(r() * 7_200_000)).toISOString(), ...(r() < 0.3 ? { placeReleased: { at: new Date(NOW - 600_000).toISOString(), sandbox: pick(), branch: r() < 0.3 ? 'feature/x' : `feature/s${i}`, why: 'far' } } : {}) })) as unknown as SessionInfo[];
    const liveSet = new Set(sessions.filter(() => r() < 0.3).map((s) => s.id));
    const f: PlaceFacts = { sessions, live: (id) => liveSet.has(id), unityHolders: r() < 0.3 ? [`sandbox:${pick()}`] : [], now: NOW };
    const indexed: PlaceFacts = { ...f, occupied: occupiedIn(f) };
    const m = { id: 'm', sandboxes };
    for (const s of sessions.filter((x) => x.placeReleased)) {
      const taken = new Map(r() < 0.5 ? [[pick(), 'other']] : []);
      assert.deepEqual(JSON.stringify(placeFor(s, m, indexed, taken)), JSON.stringify(placeFor(s, m, f, taken)), `round ${round} ${s.id}`);
    }
  }
});

test('w3843: a release pass longer than 5 s reads the ledger\'s live state once, not again for every worker after the 5th second', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3843-wait-'));
  const realNow = Date.now;
  try {
    quietly(() => {
      const s = restartScene({ sessions: 600, work: 300, queue: 4, pressure: 0, now: NOW, dir });
      const agents = s.agents as unknown as { workLive: () => unknown; liveForWait: (now: number) => unknown; waitOn: (i: SessionInfo) => unknown; placeAgain: PlaceAgain };
      let reads = 0;
      let asks = 0;
      const workLive = agents.workLive.bind(agents);
      agents.workLive = () => (reads++, workLive());
      const liveForWait = agents.liveForWait.bind(agents);
      agents.liveForWait = (now: number) => (asks++, liveForWait(now));
      // A slow host: every clock read is 6 s after the last.
      let t = realNow();
      Date.now = () => (t += 6000);
      agents.placeAgain.tick();
      assert.ok(asks > 1, `the pass asked waitLive ${asks} time(s)`);
      assert.equal(reads, 1);
      // Outside a pass it is read again once older than 5 s, as before.
      reads = 0;
      const worker = [...s.store.work.values()].filter((w) => w.status === 'blocked').map((w) => s.store.sessions.get(w.sessionIds[0])).find((x) => x && x.kind === 'worker' && agents.waitOn(x) !== undefined);
      if (worker) {
        reads = 0;
        agents.waitOn(worker);
        agents.waitOn(worker);
        assert.equal(reads, 2);
      }
      s.agents.orchestrators.close();
      s.sessions.stopAll();
    });
  } finally {
    Date.now = realNow;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w3843: a drain asked for inside a drain runs after its round, not inside it, and the queue file is written once per drain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3843-drain-'));
  try {
    quietly(() => {
      const s = restartScene({ sessions: 600, work: 200, queue: 8, pressure: 0, now: NOW, dir });
      const sm = s.sessions as unknown as { writeQueue: () => void; drainSoon: () => void; saveQueue: () => void; drainOnce: (now: number) => number };
      let rounds = 0;
      const once = sm.drainOnce.bind(sm);
      sm.drainOnce = (now: number) => (rounds++, once(now));
      let writes = 0;
      const write = sm.writeQueue.bind(sm);
      sm.writeQueue = () => (writes++, write());
      let soon = 0;
      sm.drainSoon = () => void soon++;
      let nested: number | undefined;
      const save = sm.saveQueue.bind(sm);
      sm.saveQueue = () => {
        save();
        // A queue change inside the drain asks for another drain (a send that fails synchronously did, 2026-11-09).
        if (nested === undefined) nested = s.sessions.drain(NOW);
      };
      s.sessions.drain(NOW);
      assert.equal(nested, 0, 'the nested drain did nothing itself');
      assert.equal(rounds, 2, 'the outer drain ran a second round for it');
      assert.equal(soon, 0, 'nothing was left for later');
      assert.ok(writes <= 1, `${writes} queue writes in one drain`);
      s.agents.orchestrators.close();
      s.sessions.stopAll();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w3843: a machine connected when the portal stopped is offline from the restart, not from its last report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3843-seen-'));
  try {
    const hourAgo = new Date(Date.now() - 3_660_000).toISOString();
    quietly(() => {
      const a = new Store(dir);
      a.machines.set('biscuit', { id: 'biscuit', online: true, lastSeen: hourAgo } as never);
      a.machines.set('m3', { id: 'm3', online: false, lastSeen: hourAgo } as never);
      (a as unknown as { saveNow?: () => void }).saveNow?.();
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify((a as unknown as { persisted: () => unknown }).persisted()));
    });
    const before = Date.now();
    const b = quietly(() => new Store(dir));
    const biscuit = b.machines.get('biscuit')!;
    assert.equal(biscuit.online, false);
    assert.ok(Date.parse(biscuit.lastSeen!) >= before - 1000, `offline since ${biscuit.lastSeen}`);
    // One already offline keeps when it went.
    assert.equal(b.machines.get('m3')!.lastSeen, hourAgo);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

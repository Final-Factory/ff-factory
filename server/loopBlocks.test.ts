// w6381: the event-loop blocks left after w6336 (stall profiles, 2026-11-27 10:42-11:20Z). Each fix keeps its answer and
// its data; these tests hold that, and that the work is done once where it was done many times. CI runs no timing tests:
// scripts/bench-loop-blocks.ts measures the times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { joinedPieces, stringifyPrettyPieces, stringifyPrettySliced, textPieces, writeFileDurableAsync } from './durable.ts';
import { setup, setupOnMachine, putRequests, startedFor, until, LOTH } from './orchestratorsTestKit.ts';
import type { BenchPriority, SessionInfo } from '../shared/types.ts';

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

const odd = Object.assign(Object.create(null), { a: 1, b: [1, 'two', null] });
const SAMPLES: unknown[] = [
  {},
  [],
  { a: undefined, b: 1, c: () => 1, d: Symbol('x') },
  [undefined, () => 1, 2],
  { empty: {}, list: [], nested: { x: [[], {}, [1, [2, { y: 3 }]]] } },
  { at: new Date(0), own: { toJSON: () => ({ made: true }) }, map: new Map([[1, 2]]), set: new Set([1]) },
  odd,
  { s: 'line\nbreak "quoted" \\ back sep \u{1F680} rocket \t tab', k: { 'odd "key"\n': 1 } },
  { n: [NaN, Infinity, -0, 1e21, 0.1], b: [true, false], z: null },
  { seq: 9, items: Array.from({ length: 50 }, (_, i) => ({ id: `w${i}`, log: [`line ${i}`, `more\n${i}`], deep: { a: { b: { c: [i] } } } })) },
  'just a string',
  42,
  null,
  [[[[1]]]],
];

test('w6381: stringifyPrettyPieces and stringifyPrettySliced write JSON.stringify(v, null, 2) byte for byte, at any depth', async () => {
  for (const v of SAMPLES) {
    for (const depth of [0, 1, 2, 3, 6]) {
      assert.equal((await stringifyPrettyPieces(v, 0, depth)).join(''), pretty(v), `depth ${depth}: ${pretty(v)?.slice(0, 80)}`);
    }
    assert.equal(await stringifyPrettySliced(v, 0), pretty(v));
  }
});

test('w6381: stringifyPrettyPieces lets the event loop run between records, and throws where JSON.stringify does', async () => {
  const v = { seq: 1, items: Array.from({ length: 20 }, (_, i) => ({ id: i })) };
  let turns = 0;
  const tick = setInterval(() => turns++, 0);
  const immediates: number[] = [];
  const spin = () => setImmediate(() => (immediates.push(1), immediates.length < 1000 && spin()));
  spin();
  await stringifyPrettyPieces(v, 0);
  clearInterval(tick);
  assert.ok(immediates.length >= 10, `the loop ran ${immediates.length} times during the serialize`);
  const loop: Record<string, unknown> = { a: 1 };
  loop.self = { back: loop };
  await assert.rejects(stringifyPrettyPieces({ x: loop }, 0), TypeError);
  await assert.rejects(stringifyPrettyPieces({ x: [1n] }, 0), TypeError);
});

test('w6381: a big text goes to disk in pieces that never split a surrogate pair, and the file is the same bytes', async (t) => {
  const text = `${'a'.repeat(5)}\u{1F680}${'b'.repeat(4)}\u{1F680}\u{1F680}é`;
  for (const size of [1, 2, 3, 5, 6, 7, 64]) {
    const pieces = [...textPieces(text, size)];
    assert.equal(pieces.join(''), text, `size ${size}`);
    for (const p of pieces) {
      assert.ok(!/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p), `size ${size}: a pair split at ${JSON.stringify(p)}`);
      assert.ok(p.length <= Math.max(size, 2), `size ${size}: piece of ${p.length}`);
    }
    const joined = [...joinedPieces(['xy', text, '', 'z', text], size)];
    assert.equal(joined.join(''), `xy${text}z${text}`);
    for (const p of joined) assert.ok(!/[\ud800-\udbff]$/.test(p), `joined, size ${size}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6381-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const v = { seq: 3, items: Array.from({ length: 3000 }, (_, i) => ({ id: `w${i}`, brief: `\u{1F680} ${'x'.repeat(400)} é ${i}` })) };
  const file = path.join(dir, 'work.json');
  await writeFileDurableAsync(file, await stringifyPrettyPieces(v, 0));
  assert.equal(fs.readFileSync(file, 'utf8'), pretty(v), 'pieces');
  const big = pretty(v).repeat(2);
  await writeFileDurableAsync(file, big);
  assert.equal(fs.readFileSync(file, 'utf8'), big, 'one text above WRITE_PIECE_CHARS');
});

test('w6381: the store\'s background saves write the same state.json and work.json as a flush', async (t) => {
  const { store } = setup(t);
  putRequests(store, [{ id: 'w1', title: 'Belt tooltip', brief: 'Fix it.\n\u{1F680}' }, { id: 'w2', title: 'Other', brief: 'Not "its".' }]);
  const s = store as unknown as { stateFile: { serializeAsync?: () => Promise<string | readonly string[]>; serialize: () => string }; workFile: { serializeAsync?: () => Promise<string | readonly string[]>; serialize: () => string } };
  for (const f of [s.stateFile, s.workFile]) {
    const out = await f.serializeAsync!();
    assert.equal(typeof out === 'string' ? out : out.join(''), f.serialize());
  }
});

test('w6381: FREE of a machine\'s sandboxes computes its claims once, with the same answers as one at a time', async (t) => {
  const env = await setupOnMachine(t, {}, { sandboxes: ['alpha', 'beta', 'gamma', 'delta'] });
  const { agents, store } = env;
  const sbs = store.machines.get('pc')!.sandboxes!;
  assert.equal(sbs.length, 4);
  const one = sbs.map((sb) => agents.sandboxFree('pc', sb));
  const pa = agents.placeAgain;
  let c0 = pa.claimsMade;
  const all = agents.sandboxesFree('pc', sbs);
  assert.deepEqual(all, one);
  assert.equal(pa.claimsMade - c0, 1, 'claims once for the machine');
  c0 = pa.claimsMade;
  agents.describeAllSandboxes();
  assert.ok(pa.claimsMade - c0 <= store.machines.size, `describeAllSandboxes: claims ${pa.claimsMade - c0} times for ${store.machines.size} machine(s)`);
  c0 = pa.claimsMade;
  agents.placementRead(() => {
    for (let i = 0; i < 5; i++) agents.benchPriorities('pc');
  });
  assert.ok(pa.claimsMade - c0 <= 1, `bench priorities in one pass: claims ${pa.claimsMade - c0} times`);
  // Outside a memo nothing is kept: each ask computes afresh.
  c0 = pa.claimsMade;
  agents.sandboxFree('pc', sbs[0]);
  agents.sandboxFree('pc', sbs[0]);
  assert.ok(pa.claimsMade - c0 >= 2);
});

test('w6381: pushBenchPriorities reads every machine in one pass, then sends', async (t) => {
  const { machines } = await setupOnMachine(t);
  const inPass: boolean[] = [];
  let passes = 0;
  let open = false;
  machines.benchPass = (fn) => {
    passes++;
    open = true;
    try {
      return fn();
    } finally {
      open = false;
    }
  };
  machines.benchPrioritiesFor = () => (inPass.push(open), {} as Record<string, BenchPriority>);
  const sent: { id: string; open: boolean }[] = [];
  const m = machines as unknown as { post: (id: string, msg: { type: string }, must?: boolean) => void };
  const post0 = m.post.bind(machines);
  m.post = (id, msg, must) => {
    if (msg.type === 'bench_priorities') sent.push({ id, open });
    post0(id, msg as never, must);
  };
  machines.pushBenchPriorities();
  assert.equal(passes, 1);
  assert.deepEqual(inPass, [true], 'the connected machine read inside the pass');
  assert.deepEqual(sent, [{ id: 'pc', open: false }], 'sent after the pass');
});

test('w6381: warmBoardTexts works out every request\'s concepts ahead, so the first board check makes none and answers the same', async (t) => {
  const { store, o } = setup(t);
  const now = new Date().toISOString();
  for (let i = 0; i < 30; i++) {
    store.putWork({ id: `w${100 + i}`, title: i === 7 ? 'Conveyor belts jam at the splitter' : `Request number ${i} about turret ammo ${i}`, brief: `Brief ${i}: the turret runs out of ammo near the base.`, priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'active', createdAt: now, updatedAt: now, sessionIds: [], overlaps: [], asks: 0, log: [] } as never);
  }
  const made = await o.warmBoardTexts(30, 0);
  assert.equal(made, 30);
  assert.equal(o.boardTextsMade, 30);
  const q = { keys: [], title: 'belts jam at a splitter', summary: 'The conveyor belt jams where it splits.' };
  const warm = o.boardCheck(q, 30);
  assert.equal(o.boardTextsMade, 30, 'the first check made none');
  assert.equal(warm.matches[0]?.id, 'w107', JSON.stringify(warm));
  (o as unknown as { boardTexts: Map<string, unknown> }).boardTexts.clear();
  assert.deepEqual(o.boardCheck(q, 30), warm, 'the same answer as from a cold cache');
  assert.equal(await o.warmBoardTexts(30, 0), 0, 'a second warm-up makes none');
});

test('w6381: switch_branch reads its sandbox\'s agent seats from one holds index, not a ledger scan per session', async (t) => {
  const env = await setupOnMachine(t, {}, { sandboxes: ['alpha'] });
  const { agents, store } = env;
  const sb = store.machines.get('pc')!.sandboxes!.find((s) => s.id === 'alpha')!;
  const T0 = new Date().toISOString();
  const ids = Array.from({ length: 20 }, (_, i) => `seat${i}`);
  for (const [i, id] of ids.entries()) {
    store.putSession({ id, kind: 'worker', title: `w${900 + i}: leg`, status: 'stopped', permissionMode: 'bypassPermissions', createdAt: T0, lastActivityAt: T0, turns: 1, costUsd: 0, pendingPermissions: [], requestedBy: LOTH, machineId: 'pc', machineSandbox: 'alpha' } as never);
    store.putWork({ id: `w${900 + i}`, title: `leg ${i}`, brief: '', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], status: 'active', needs: i % 2 ? 'agent' : 'game', createdAt: T0, updatedAt: T0, sessionIds: [id], overlaps: [], asks: 0, log: [] } as never);
  }
  sb.sessionIds = [...ids];
  const a = agents as unknown as { holdsIndexNow: () => unknown; onAgentSeat: (id: string) => boolean };
  const seatsAlone = ids.filter((id) => a.onAgentSeat(id));
  assert.equal(seatsAlone.length, 10, 'the agent-work half sits on agent seats');
  const real = a.holdsIndexNow.bind(agents);
  const built = new Set<unknown>();
  let outside = 0;
  a.holdsIndexNow = () => {
    const ix = real();
    if (ix) built.add(ix);
    else outside++;
    return ix;
  };
  agents.switchChecked({ sandbox: 'pc/alpha', branch: 'feature/x' });
  assert.equal(outside, 0, 'every seat check ran inside a pass');
  assert.equal(built.size, 1, 'one holds index for the whole sandbox');
  // The same seats as one at a time: seated agents are left out of the busy check and sent to the daemon.
  a.holdsIndexNow = real;
  assert.deepEqual(agents.workInSandbox('pc', 'alpha').requests, [], 'no live workers there');
  assert.deepEqual(ids.filter((id) => a.onAgentSeat(id)), seatsAlone);
});

test('w6381: a drain delivers a message with no fresh start due inside its memo, emptying it only for the send', async (t) => {
  const env = await setupOnMachine(t);
  const { store, sessions } = env;
  putRequests(store, [{ id: 'w1', by: LOTH, status: 'active' }]);
  const a = await startedFor(env, 'w1');
  sessions.sessions.get(a.id)!.stop(true);
  await until('its process stopped', () => !sessions.sessions.get(a.id)?.live);
  const s = sessions as unknown as { placementFree: <T>(fn: () => T) => T; freshStart: (...x: unknown[]) => boolean; freshStartMaybe: (...x: unknown[]) => boolean };
  assert.equal(s.freshStartMaybe(sessions.sessions.get(a.id)!, { text: 'x' }), false, 'nothing merged: none due');
  const free0 = s.placementFree;
  let frees = 0;
  s.placementFree = (fn) => (frees++, free0(fn));
  const fresh0 = s.freshStart;
  let freshAsked = 0;
  s.freshStart = (...x) => (freshAsked++, fresh0(...x));
  // Queued while its computer is full, then the drain delivers it once room is back.
  const full = sessions as unknown as { placeFull?: (s: unknown) => string | undefined };
  const placeFull = full.placeFull;
  full.placeFull = () => 'no sandbox on pc is free';
  sessions.send(a.id, 'carry on.');
  full.placeFull = placeFull;
  assert.equal(sessions.queued().filter((q) => q.id === a.id).length, 1, 'queued');
  freshAsked = 0;
  frees = 0;
  sessions.drain();
  await until('delivered', () => !!sessions.sessions.get(a.id)?.live);
  assert.equal(freshAsked, 0, 'freshStart, which empties the memo, is not asked when none is due');
  assert.equal(frees, 1, 'the memo emptied once, for the send');
});

test('w6381: a drain checks a held computer\'s pause for each message inside its memo, emptying it only for a drop', async (t) => {
  const env = await setupOnMachine(t);
  const { store, sessions } = env;
  putRequests(store, [
    { id: 'w1', by: LOTH, status: 'active' },
    { id: 'w2', by: LOTH, status: 'active' },
    { id: 'w3', by: LOTH, status: 'active' },
  ]);
  const a = await startedFor(env, 'w1');
  const b = await startedFor(env, 'w2');
  const c = await startedFor(env, 'w3');
  for (const x of [a, b, c]) sessions.sessions.get(x.id)!.stop(true);
  await until('their processes stopped', () => [a, b, c].every((x) => !sessions.sessions.get(x.id)?.live));
  const s = sessions as unknown as {
    placementFree: <T>(fn: () => T) => T;
    machineHold?: (h: unknown) => string | undefined;
    pauseHeld?: (h: unknown, text: string) => boolean;
    roomMove?: unknown;
  };
  const free0 = s.placementFree;
  let frees = 0;
  s.placementFree = (fn) => (frees++, free0(fn));
  s.machineHold = () => 'pc is on hold (a test hold)';
  s.roomMove = undefined;
  let asked = 0;
  let paused = false;
  s.pauseHeld = (_h, text) => (asked++, paused && /^\[FF Factory\] PAUSE:/.test(text));
  sessions.send(a.id, 'carry on.');
  sessions.send(b.id, 'carry on too.');
  assert.equal(sessions.queued().filter((q) => q.id === a.id || q.id === b.id).length, 2, 'both held');
  asked = 0;
  frees = 0;
  sessions.drain();
  assert.equal(asked, 2, 'each held message had its pause checked');
  assert.equal(frees, 0, 'no check emptied the memo');
  assert.equal(sessions.queued().filter((q) => q.id === a.id || q.id === b.id).length, 2, 'both still wait for the hold');
  // A pause notice queued before the pause began is dropped by the drain, and only that drop empties the memo.
  sessions.send(c.id, '[FF Factory] PAUSE: pc is paused.');
  assert.equal(sessions.queued().filter((q) => q.id === c.id).length, 1, 'the notice is held too');
  paused = true;
  frees = 0;
  sessions.drain();
  assert.equal(frees, 1, 'the drop emptied it once');
  assert.equal(sessions.queued().filter((q) => q.id === c.id).length, 0, 'the notice went');
  assert.equal(sessions.queued().filter((q) => q.id === a.id || q.id === b.id).length, 2, 'the others still wait');
});

test('w6428: a page build\'s placement (pageRead) works out each sandbox\'s FREE once, with the same answers and room', async (t) => {
  const env = await setupOnMachine(t, {}, { sandboxes: ['alpha', 'beta', 'gamma', 'delta'] });
  const { agents, store } = env;
  const sbs = store.machines.get('pc')!.sandboxes!;
  const read = () => ({ free: agents.sandboxesFree('pc', sbs), room: agents.roomNow(), extras: agents.roomExtras() });
  let f0 = agents.freeMade;
  const before = agents.withPlacesOnce(() => agents.placeAgain.withClaimsMemo(read));
  const askedBefore = agents.freeMade - f0;
  f0 = agents.freeMade;
  const after = agents.pageRead(read);
  assert.deepEqual(after.free, before.free);
  assert.deepEqual(after.room, before.room);
  assert.deepEqual(after.extras, before.extras);
  assert.equal(agents.freeMade - f0, sbs.length, `once per sandbox (${askedBefore} times outside pageRead)`);
  assert.ok(askedBefore > sbs.length, `outside pageRead each sandbox was asked more than once (${askedBefore})`);
  // A sandbox the daemon reported again is a new object: asked afresh, not answered from the memo.
  agents.pageRead(() => {
    agents.sandboxesFree('pc', sbs);
    f0 = agents.freeMade;
    agents.sandboxesFree('pc', sbs.map((sb) => ({ ...sb })));
    assert.equal(agents.freeMade - f0, sbs.length);
  });
  // Outside pageRead nothing is kept.
  f0 = agents.freeMade;
  agents.sandboxFree('pc', sbs[0]);
  agents.sandboxFree('pc', sbs[0]);
  assert.equal(agents.freeMade - f0, 2);
});

test('w6428: page builds keep each worker\'s requests until a request is saved or dropped', async (t) => {
  const env = await setupOnMachine(t, {}, { sandboxes: ['alpha'] });
  const { agents, store } = env;
  const at = new Date().toISOString();
  const info = { id: 'k1', kind: 'worker', title: 'w6001: a worker', status: 'stopped', permissionMode: 'default', createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, pendingPermissions: [] } as unknown as SessionInfo;
  const put = (id: string, status: string) => store.putWork({ id, title: id, brief: '', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], status, createdAt: at, updatedAt: at, sessionIds: ['k1'], overlaps: [], asks: 0, log: [] } as never);
  const ids = () => agents.pageRead(() => (agents as unknown as { workIdsOf: (s: SessionInfo) => string[] }).workIdsOf(info)).sort();
  put('w6002', 'active');
  assert.deepEqual(ids(), ['w6001', 'w6002']);
  const kept = (agents as unknown as { pageKept?: { work: Map<string, unknown>; holds?: unknown } }).pageKept;
  assert.ok(kept?.work.has('k1') && kept.holds, 'kept after the build');
  assert.deepEqual(ids(), ['w6001', 'w6002']);
  assert.equal((agents as unknown as { pageKept?: unknown }).pageKept, kept, 'the next build reads the same');
  put('w6003', 'active');
  assert.deepEqual(ids(), ['w6001', 'w6002', 'w6003'], 'a saved request is read at the next build');
  put('w6002', 'done');
  assert.deepEqual(ids(), ['w6001', 'w6003'], 'and a closed one goes');
  store.dropWork(['w6003']);
  assert.deepEqual(ids(), ['w6001'], 'and a dropped one');
  // Its title names another request: read again although the ledger is unchanged.
  info.title = 'w6009: renamed';
  assert.deepEqual(ids(), ['w6009']);
});

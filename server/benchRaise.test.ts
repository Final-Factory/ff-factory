import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchLockDir, pidAlive, readPassedMarks, writeBenchPriorities } from '../machine/benchLock.ts';
import { BenchTicket, benchQueueDir, findBenchQueueScript, queueTickets, rulesVersion, type QueueTicket } from '../machine/benchQueue.ts';
import { editorBenchSession, editorSessions, passedShared, raisedSessions, sandboxOfPath } from '../machine/benchRaise.ts';
import type { BenchPriority } from '../shared/types.ts';

/**
 * w1962 (lothsahn: "a shared bench-queue ticket (an editor start, a build) must not wait for hours behind one exclusive
 * timed ticket after another"): the daemon marked a shared ticket an exclusive turn had passed, and raised its session in
 * priorities.json. w4620 (lothsahn: "The factory should be using strict priority queues"): nothing is raised across
 * priorities any more; a ticket counts as passed only by a holder of its own priority or lower, a mark that is a display.
 * With FF_GAME_REPO set to a checkout with the script, the real-queue tests run it (an old copy: one from before w4620).
 */

const GAME = process.env.FF_GAME_REPO;
const NOW = new Date('2026-10-24T01:31:00Z');

const tk = (ticket: string, mode: 'shared' | 'exclusive', what: string, o: Partial<QueueTicket> = {}): QueueTicket => ({ ticket, mode, what, pid: 1, ...o });
const granted = { at: '2026-10-24T01:07:41Z', ts: 1792803061 };

/** LothDesktop at 01:31Z on 2026-10-24 (measured: the queue's ticket folders): w1853's urgent timed A/B holds the lock,
 * w1789's high one, slot1's and slot4's editor starts and w1905's build wait. */
const lothdesktop = (): QueueTicket[] => [
  tk('t00000933', 'exclusive', 'w1789 A/B UI fixes', { session: 's1789', sandbox: 'slot5' }),
  tk('t00000934', 'shared', 'running editor slot1', { session: editorBenchSession('slot1'), sandbox: 'slot1' }),
  tk('t00000935', 'shared', 'running editor slot4', { session: editorBenchSession('slot4'), sandbox: 'slot4' }),
  tk('t00000936', 'exclusive', 'w1853 w1155 open cost A/B 1 (master, fix)', { session: 's1853', sandbox: 'slot3', granted }),
  tk('t00000937', 'shared', 'unity: build_player win 8e88b213', { session: 's1905', sandbox: 'slot2', requests: ['w1905'] }),
];
const portal: Record<string, BenchPriority> = {
  s1789: { priority: 'high', requests: ['w1789'] },
  s1853: { priority: 'urgent', requests: ['w1853'] },
  s1905: { priority: 'normal', requests: ['w1905'] },
  s1937: { priority: 'normal', requests: ['w1937'] },
  s1941: { priority: 'urgent', requests: ['w1941'] },
};

test('w4620: on LothDesktop\'s queue only the waiting ticket of the urgent timed turn\'s own priority is passed, and nothing is raised', () => {
  const q = lothdesktop();
  const editors = editorSessions([{ session: 's1937', sandbox: 'slot1' }, { session: 's1941', sandbox: 'slot4' }], portal);
  const sessions = { ...editors, ...portal };
  // the urgent holder (w1853) is higher than slot1's normal start and w1905's normal build: strict priority, no mark
  const passed = passedShared(q, {}, NOW, sessions);
  assert.deepEqual(Object.keys(passed), ['t00000935'], 'slot4\'s start is urgent too (w1941): the same priority, so it waited behind the holder');
  assert.deepEqual(passed.t00000935, { by: 't00000936', since: NOW.toISOString() });
  const r = raisedSessions(sessions, q, passed);
  assert.deepEqual(r.raised, []);
  assert.deepEqual(r.sessions, sessions, 'priorities.json carries the portal\'s priorities unchanged');
  assert.deepEqual(r.sessions['editor:slot1'], { priority: 'normal', requests: ['w1937'] });
  assert.equal(r.sessions.s1905.priority, 'normal');
});

test('w4620: an exclusive holder of the same priority passes a normal shared ticket, which is marked and raised to nothing', () => {
  const q = [tk('t1', 'exclusive', 'normal leg', { session: 'sA', granted }), tk('t2', 'shared', 'unity: build', { session: 'sB' }), tk('t3', 'shared', 'unity: compile', { session: 'sC' })];
  const sessions: Record<string, BenchPriority> = { sA: { priority: 'normal', requests: [] }, sB: { priority: 'normal', requests: ['w2'] }, sC: { priority: 'low', requests: ['w3'] } };
  const passed = passedShared(q, {}, NOW, sessions);
  assert.deepEqual(passed, { t2: { by: 't1', since: NOW.toISOString() } }, 'the low ticket is below the holder: not passed');
  const r = raisedSessions(sessions, q, passed);
  assert.deepEqual(r.raised, []);
  assert.deepEqual(r.sessions, sessions);
  // a lower-priority holder passes both; a release holder passes none; sessions priorities.json does not name are all low
  assert.deepEqual(Object.keys(passedShared(q, {}, NOW, { ...sessions, sA: { priority: 'low', requests: [] } })), ['t2', 't3']);
  assert.deepEqual(passedShared(q, {}, NOW, { ...sessions, sA: { priority: 'urgent', level: 'release', requests: [] } }), {}, 'level release outranks every shared ticket');
  assert.deepEqual(Object.keys(passedShared(q, {}, NOW, {})), ['t2', 't3'], 'nothing named: all low, one priority');
});

test('w1962: a mark lasts while its ticket waits, between timed turns too, and goes when it is granted or gone', () => {
  const q = lothdesktop();
  const first = passedShared(q, {}, NOW); // no session named: all low, one priority
  // t936's turn ends and w1853's next leg has not been granted yet: the marks stay, so the raise stays
  const between = q.filter((t) => t.ticket !== 't00000936');
  const kept = passedShared(between, first, new Date(NOW.getTime() + 60_000));
  assert.deepEqual(kept, first);
  const after = between.map((t) => (t.ticket === 't00000934' ? { ...t, granted } : t)).filter((t) => t.ticket !== 't00000937');
  assert.deepEqual(Object.keys(passedShared(after, kept, NOW)), ['t00000935']);
  assert.deepEqual(raisedSessions(portal, after, passedShared(after, kept, NOW)).raised, [], 'w4620: nothing is raised');
});

test('w1962: nothing waiting while no timed leg holds the lock is passed; an editor start in the holder\'s own sandbox rides along', () => {
  assert.deepEqual(passedShared(lothdesktop().filter((t) => t.ticket !== 't00000936'), {}, NOW), {});
  const own = [tk('t1', 'exclusive', 'w1853 leg', { session: 's1853', sandbox: 'slot3', granted }), tk('t2', 'shared', 'running editor slot3', { session: editorBenchSession('slot3'), sandbox: 'slot3' })];
  assert.deepEqual(passedShared(own, {}, NOW), {});
});

test('w4620: a session with a live timed leg of its own and a ticket with no session are passed and raised to nothing', () => {
  const q = [
    tk('t1', 'exclusive', 'leg', { session: 'sA', granted }),
    tk('t2', 'shared', 'unity: build', { session: 'sB' }),
    tk('t3', 'exclusive', 'next leg', { session: 'sB' }),
    tk('t4', 'shared', 'unity: compile'),
  ];
  const passed = passedShared(q, {}, NOW);
  assert.deepEqual(Object.keys(passed), ['t2', 't4']);
  const sB: Record<string, BenchPriority> = { sB: { priority: 'normal', requests: [] } };
  assert.deepEqual(raisedSessions(sB, q, passed), { sessions: sB, raised: [] });
});

/** LothDesktop at 04:04Z on 2026-10-24 (measured): no timed leg holds the lock; a shared group runs (w1977's repro,
 * slot6's urgent game player, slot1's editor); w1789's high timed leg, taken after w1905's build, waits behind it. */
const lothdesktop0404 = (): QueueTicket[] => [
  tk('t00000937', 'shared', 'unity: build_player win 8e88b213', { session: 's1905', sandbox: 'slot2', requests: ['w1905'] }),
  tk('t00000974', 'shared', 'w1977 MP-trailer-raid-fleets witness repro', { session: 's1977', sandbox: 'slot4', granted }),
  tk('t00000982', 'exclusive', 'w1789 A/B UI fixes', { session: 's1789', sandbox: 'slot5' }),
  tk('t00000987', 'shared', 'running player pid 34504 slot 6-0', { session: 's1782', sandbox: 'slot6', granted }),
  tk('t00000988', 'shared', 'running editor slot1', { session: editorBenchSession('slot1'), sandbox: 'slot1', granted }),
];

test('w4620: a shared ticket that a later exclusive ticket outranks is not marked, nor raised, with no timed leg holding the lock', () => {
  const q = lothdesktop0404();
  const prios = { ...portal, s1977: { priority: 'high', requests: ['w1977'] }, s1782: { priority: 'urgent', requests: ['w1782'] } } as Record<string, BenchPriority>;
  // w1789's high leg, taken after w1905's normal build, goes first: lothsahn's "strict priority queues", the order working
  assert.deepEqual(passedShared(q, {}, NOW), {});
  assert.deepEqual(passedShared(q, {}, NOW, prios), {});
  assert.deepEqual(raisedSessions(prios, q, {}), { sessions: prios, raised: [] });
});

test('w1962: an editor start waits at the highest priority of the workers in its sandbox', () => {
  const e = editorSessions([{ session: 'a', sandbox: 'slot1' }, { session: 'b', sandbox: 'slot1' }, { session: 'c' }, { session: 'gone', sandbox: 'slot2' }], {
    a: { priority: 'normal', requests: ['w1'] },
    b: { priority: 'high', requests: ['w2'] },
    c: { priority: 'urgent', requests: ['w3'] },
  });
  assert.deepEqual(e, { 'editor:slot1': { priority: 'high', requests: ['w2', 'w1'] } });
  // w4620: a release worker in the sandbox outranks an urgent one, and its start carries the level
  const r = editorSessions([{ session: 'a', sandbox: 'slot1' }, { session: 'b', sandbox: 'slot1' }, { session: 'c', sandbox: 'slot1' }], {
    a: { priority: 'urgent', requests: ['w1'] },
    b: { priority: 'urgent', level: 'release', requests: ['w2'] },
    c: { priority: 'urgent', requests: ['w3'] },
  });
  assert.deepEqual(r, { 'editor:slot1': { priority: 'urgent', level: 'release', requests: ['w2', 'w1', 'w3'] } });
});

test('w1962: the passed marks are written into priorities.json and read back after a restart', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1962-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const passed = { t00000934: { by: 't00000936', since: NOW.toISOString() } };
  const file = writeBenchPriorities(root, portal, NOW, false, undefined, undefined, passed)!;
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(f.passed, passed);
  assert.equal(f.sessions.s1853.priority, 'urgent');
  assert.deepEqual(readPassedMarks(root), passed);
  writeBenchPriorities(root, portal, NOW, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).passed, undefined, 'no marks: no key');
  assert.deepEqual(readPassedMarks(undefined), {});
});

test('w1984: the portal\'s away mark reaches priorities.json through the daemon\'s own marks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1984-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const away = { why: 'its worker 2e29f29e was stopped on purpose' };
  const sessions: Record<string, BenchPriority> = { s1789: { priority: 'normal', requests: ['w1789'], away } };
  const { sessions: out } = raisedSessions({ ...editorSessions([{ session: 's1789', sandbox: 'slot5' }], sessions), ...sessions }, [], {});
  const file = writeBenchPriorities(root, out, NOW, false)!;
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(f.sessions.s1789.away, away, 'bench_queue.py reads it from here');
  assert.equal(f.sessions['editor:slot5'].away, undefined, 'its sandbox editor\'s life ticket is not parked');
});

const waitFor = async (ok: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (!ok() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return ok();
};

test('w4620: against the real bench_queue.py, the daemon marks nothing and raises nothing for a normal build behind an urgent holder', { skip: !GAME || !findBenchQueueScript([GAME]) ? 'FF_GAME_REPO not set to a checkout with scripts/bench/bench_queue.py' : false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1962-'));
  const helpers: BenchTicket[] = [];
  t.after(async () => {
    // the helpers let go and end first (on Windows a folder a live process has open cannot be removed)
    for (const h of helpers) h.release();
    await waitFor(() => helpers.every((h) => h.state().kind === 'failed'), 15_000);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const lock = benchLockDir(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const script = findBenchQueueScript([GAME])!;
  const env: NodeJS.ProcessEnv = { ...process.env, BENCH_POLL_S: '0.1', BENCH_LEGACY_GRACE_S: '0' };
  for (const k of ['FF_BENCH_TICKET', 'FF_SANDBOX_ID', 'FF_SESSION_ID', 'FF_BENCH_SESSION']) delete env[k];
  const sessions: Record<string, BenchPriority> = { sU: { priority: 'urgent', requests: ['w1853'] }, sN: { priority: 'normal', requests: ['w1905'] } };
  writeBenchPriorities(root, sessions, new Date(), false);
  const ex = new BenchTicket({ script, lock, mode: 'exclusive', what: 'w1853 urgent timed leg', tempDir: root, env: { ...env, FF_SESSION_ID: 'sU' } }).take();
  helpers.push(ex);
  const g = await ex.wait(15_000);
  assert.equal(g.kind, 'granted');
  const holder = path.join(benchQueueDir(lock), g.kind === 'granted' ? g.ticket : '');
  const sh = new BenchTicket({ script, lock, mode: 'shared', what: 'unity: build_player', tempDir: root, env: { ...env, FF_SESSION_ID: 'sN' } }).take();
  helpers.push(sh);
  assert.equal((await sh.wait(1500)).kind, 'waiting', 'the build waits for the timed leg');
  const has = (f: string) => fs.existsSync(path.join(holder, f));
  // Before: with the portal's priorities only, a copy with the w1860 hold and without w1962's rules lets the urgent leg
  // keep the lock (keep.json, no deadline) for as long as it runs, the build being lower-priority work.
  const text = fs.readFileSync(script, 'utf8');
  if (rulesVersion(script) === 0 && text.includes('def _keep(')) {
    assert.ok(await waitFor(() => has('keep.json'), 10_000), 'this copy holds the lock against the build');
    assert.equal(has('limit.json'), false, 'no deadline: the build waits for as long as the leg runs');
  }
  // The daemon's look (w4620): the build is lower than the urgent leg, so the leg passes nothing and nothing is raised.
  const q = queueTickets(lock, pidAlive);
  const passed = passedShared(q, {}, new Date(), sessions);
  assert.deepEqual(passed, {});
  const r = raisedSessions(sessions, q, passed);
  assert.deepEqual(r.raised, []);
  writeBenchPriorities(root, r.sessions, new Date(), false, undefined, undefined, passed);
  assert.equal((await sh.wait(1500)).kind, 'waiting', 'the exclusive leg keeps the machine to itself until its turn ends');
  ex.release();
  assert.equal((await sh.wait(15_000)).kind, 'granted');
});

test('w4620: against the real bench_queue.py, a normal build waits behind a later high timed leg and the daemon raises nothing', { skip: !GAME || !findBenchQueueScript([GAME]) ? 'FF_GAME_REPO not set to a checkout with scripts/bench/bench_queue.py' : false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1962-'));
  const helpers: BenchTicket[] = [];
  t.after(async () => {
    for (const h of helpers) h.release();
    await waitFor(() => helpers.every((h) => h.state().kind === 'failed'), 15_000);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const lock = benchLockDir(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const script = findBenchQueueScript([GAME])!;
  const env: NodeJS.ProcessEnv = { ...process.env, BENCH_POLL_S: '0.1', BENCH_LEGACY_GRACE_S: '0' };
  for (const k of ['FF_BENCH_TICKET', 'FF_SANDBOX_ID', 'FF_SESSION_ID', 'FF_BENCH_SESSION']) delete env[k];
  const sessions: Record<string, BenchPriority> = { sP: { priority: 'urgent', requests: ['w1782'] }, sX: { priority: 'urgent', requests: ['w1853'] }, sH: { priority: 'high', requests: ['w1789'] }, sN: { priority: 'normal', requests: ['w1905'] } };
  writeBenchPriorities(root, sessions, new Date(), false);
  const take = (mode: 'shared' | 'exclusive', what: string, s: string) => {
    const b = new BenchTicket({ script, lock, mode, what, tempDir: root, env: { ...env, FF_SESSION_ID: s } }).take();
    helpers.push(b);
    return b;
  };
  const player = take('shared', 'running player pid 1 slot 6-0', 'sP');
  assert.equal((await player.wait(15_000)).kind, 'granted');
  // an urgent timed leg waits first, so the build, taken next, waits too and is ahead of w1789's leg in taking order
  const first = take('exclusive', 'w1853 urgent leg', 'sX');
  assert.equal((await first.wait(1500)).kind, 'waiting');
  const build = take('shared', 'unity: build_player', 'sN');
  assert.equal((await build.wait(1000)).kind, 'waiting');
  const leg = take('exclusive', 'w1789 A/B UI fixes', 'sH');
  assert.equal((await leg.wait(1000)).kind, 'waiting');
  first.release();
  // The leg, taken later, outranks the build and waits behind the urgent group; the build waits behind the leg
  assert.equal((await build.wait(2000)).kind, 'waiting', 'the build waits behind the later, higher leg');
  assert.equal((await leg.wait(500)).kind, 'waiting');
  // The daemon's look (w4620): strict priority, so the build is neither marked nor raised
  const q = queueTickets(lock, pidAlive);
  const passed = passedShared(q, {}, new Date(), sessions);
  assert.deepEqual(passed, {});
  const r = raisedSessions(sessions, q, passed);
  assert.deepEqual(r.raised, []);
  writeBenchPriorities(root, r.sessions, new Date(), false, undefined, undefined, passed);
  assert.equal((await build.wait(2000)).kind, 'waiting', 'the build still waits behind the higher leg');
  assert.equal((await leg.wait(500)).kind, 'waiting', 'the timed leg still never runs beside shared work');
});

test('w2413: the holder\'s own editor rides along by its checkout and its session\'s placement, never another sandbox\'s', () => {
  // biscuit, 2026-10-27: worker edc18110 (w2338), placed again in slot2 after slot3; its tickets named slot3
  const ed = tk('t2', 'shared', 'running editor slot2', { session: editorBenchSession('slot2'), sandbox: 'slot2' });
  const moved = tk('t1', 'exclusive', 'Leech probe', { session: 'edc18110', sandbox: 'slot3', cwd: 'F:\\ffw\\Sandboxes\\Slot2\\scripts', granted });
  assert.deepEqual(passedShared([moved, ed], {}, NOW), {}, 'its checkout is in slot2');
  const timedRun = tk('t1', 'exclusive', 'timed run r1', { session: 'edc18110', cwd: '/home/ben-ryding/ffw', granted });
  assert.deepEqual(Object.keys(passedShared([timedRun, ed], {}, NOW)), ['t2'], 'no sandbox, no placement: passed, as before');
  assert.deepEqual(passedShared([timedRun, ed], {}, NOW, {}, { edc18110: 'slot2' }), {}, 'its session is placed in slot2');
  const ed22 = tk('t3', 'shared', 'running editor slot22', { session: editorBenchSession('slot22'), sandbox: 'slot22' });
  assert.deepEqual(Object.keys(passedShared([timedRun, ed22], {}, NOW, {}, { edc18110: 'slot2' })), ['t3'], 'slot22 is not slot2');
  assert.equal(sandboxOfPath('/r/ffw/sandboxes/slot22/Assets'), 'slot22');
  assert.equal(sandboxOfPath('V:\\ffw\\SANDBOXES\\Slot2'), 'slot2');
  assert.equal(sandboxOfPath('/r/ffw/sandboxes'), '');
});

test('w2413: the sessions\' placement is written into priorities.json for bench_queue.py own_sandboxes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2413-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = writeBenchPriorities(root, {}, NOW, false, undefined, undefined, undefined, { edc18110: 'slot2' })!;
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).placed, { edc18110: 'slot2' });
  writeBenchPriorities(root, {}, NOW, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).placed, undefined, 'none placed: no key');
});

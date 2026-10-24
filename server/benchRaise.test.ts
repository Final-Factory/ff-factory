import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchLockDir, pidAlive, readPassedMarks, writeBenchPriorities } from '../machine/benchLock.ts';
import { BenchTicket, benchQueueDir, findBenchQueueScript, queueTickets, rulesVersion, type QueueTicket } from '../machine/benchQueue.ts';
import { editorBenchSession, editorSessions, passedShared, raisedSessions } from '../machine/benchRaise.ts';
import type { BenchPriority } from '../shared/types.ts';

/**
 * w1962 (lothsahn: "a shared bench-queue ticket (an editor start, a build) must not wait for hours behind one exclusive
 * timed ticket after another"): the daemon raises a shared ticket an exclusive turn has passed in priorities.json, which
 * every copy of the game repo's bench_queue.py reads, an old branch's too. With FF_GAME_REPO set to a checkout with the
 * script, the last test runs the real queue (an old copy: the one in a branch from before w1962).
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

test('w1962: on LothDesktop\'s queue every waiting shared ticket is passed by the urgent timed turn and raised to the top; the timed legs are not', () => {
  const q = lothdesktop();
  const passed = passedShared(q, {}, NOW);
  assert.deepEqual(Object.keys(passed), ['t00000934', 't00000935', 't00000937']);
  assert.deepEqual(passed.t00000934, { by: 't00000936', since: NOW.toISOString() });
  const editors = editorSessions([{ session: 's1937', sandbox: 'slot1' }, { session: 's1941', sandbox: 'slot4' }], portal);
  const { sessions, raised } = raisedSessions({ ...editors, ...portal }, q, passed);
  assert.deepEqual(raised, ['t00000934', 't00000937'], 'slot4\'s start is urgent already (w1941\'s priority)');
  assert.deepEqual(sessions['editor:slot1'], { priority: 'urgent', requests: ['w1937'], raisedFrom: 'normal', raisedFor: 't00000934' });
  assert.deepEqual(sessions['editor:slot4'], { priority: 'urgent', requests: ['w1941'] });
  assert.equal(sessions.s1905.priority, 'urgent');
  assert.equal(sessions.s1905.raisedFrom, 'normal');
  assert.deepEqual(sessions.s1789, portal.s1789, 'a timed leg is never raised');
  assert.deepEqual(sessions.s1853, portal.s1853);
});

test('w1962: a mark lasts while its ticket waits, between timed turns too, and goes when it is granted or gone', () => {
  const q = lothdesktop();
  const first = passedShared(q, {}, NOW);
  // t936's turn ends and w1853's next leg has not been granted yet: the marks stay, so the raise stays
  const between = q.filter((t) => t.ticket !== 't00000936');
  const kept = passedShared(between, first, new Date(NOW.getTime() + 60_000));
  assert.deepEqual(kept, first);
  const after = between.map((t) => (t.ticket === 't00000934' ? { ...t, granted } : t)).filter((t) => t.ticket !== 't00000937');
  assert.deepEqual(Object.keys(passedShared(after, kept, NOW)), ['t00000935']);
  assert.deepEqual(raisedSessions(portal, after, passedShared(after, kept, NOW)).raised, ['t00000935'], 'a session the portal does not name counts as normal, and is raised');
});

test('w1962: nothing waiting while no timed leg holds the lock is passed; an editor start in the holder\'s own sandbox rides along', () => {
  assert.deepEqual(passedShared(lothdesktop().filter((t) => t.ticket !== 't00000936'), {}, NOW), {});
  const own = [tk('t1', 'exclusive', 'w1853 leg', { session: 's1853', sandbox: 'slot3', granted }), tk('t2', 'shared', 'running editor slot3', { session: editorBenchSession('slot3'), sandbox: 'slot3' })];
  assert.deepEqual(passedShared(own, {}, NOW), {});
});

test('w1962: a session with a live timed leg of its own is not raised, nor a ticket with no session', () => {
  const q = [
    tk('t1', 'exclusive', 'leg', { session: 'sA', granted }),
    tk('t2', 'shared', 'unity: build', { session: 'sB' }),
    tk('t3', 'exclusive', 'next leg', { session: 'sB' }),
    tk('t4', 'shared', 'unity: compile'),
  ];
  const passed = passedShared(q, {}, NOW);
  assert.deepEqual(Object.keys(passed), ['t2', 't4']);
  assert.deepEqual(raisedSessions({ sB: { priority: 'normal', requests: [] } }, q, passed).raised, []);
});

test('w1962: an editor start waits at the highest priority of the workers in its sandbox', () => {
  const e = editorSessions([{ session: 'a', sandbox: 'slot1' }, { session: 'b', sandbox: 'slot1' }, { session: 'c' }, { session: 'gone', sandbox: 'slot2' }], {
    a: { priority: 'normal', requests: ['w1'] },
    b: { priority: 'high', requests: ['w2'] },
    c: { priority: 'urgent', requests: ['w3'] },
  });
  assert.deepEqual(e, { 'editor:slot1': { priority: 'high', requests: ['w2', 'w1'] } });
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

test('w1962: against the real bench_queue.py, a raised build ends an urgent holder\'s turn where the priority hold kept the lock', { skip: !GAME || !findBenchQueueScript([GAME]) ? 'FF_GAME_REPO not set to a checkout with scripts/bench/bench_queue.py' : false }, async (t) => {
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
  // The daemon's look: the build is passed by the leg's turn and its session raised to the top.
  const q = queueTickets(lock, pidAlive);
  const passed = passedShared(q, {}, new Date());
  const build = q.find((x) => x.mode === 'shared')!.ticket;
  assert.deepEqual(Object.keys(passed), [build]);
  const r = raisedSessions(sessions, q, passed);
  assert.deepEqual(r.raised, [build]);
  writeBenchPriorities(root, r.sessions, new Date(), false, undefined, undefined, passed);
  assert.ok(await waitFor(() => has('limit.json') && !has('keep.json'), 10_000), 'the raised build ends the turn at its limit: a deadline, no hold');
  const lim = JSON.parse(fs.readFileSync(path.join(holder, 'limit.json'), 'utf8'));
  assert.ok((lim.waiters ?? [lim.by]).includes(build), `the deadline is the build's: ${JSON.stringify(lim)}`);
  assert.equal((await sh.wait(1000)).kind, 'waiting', 'the exclusive leg keeps the machine to itself until its turn ends');
  ex.release();
  assert.equal((await sh.wait(15_000)).kind, 'granted');
});

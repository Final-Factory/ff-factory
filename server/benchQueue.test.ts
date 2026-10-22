import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readBenchLock } from '../machine/benchLock.ts';
import { BenchTicket, benchQueueDir, benchTicketFor, findBenchQueueScript, heldTicket, queueTickets } from '../machine/benchQueue.ts';

/**
 * w1615: the bench queue is the game repo's scripts/bench/bench_queue.py (its own tests kill holders and waiters with
 * SIGKILL, scripts/tests/test_bench_queue.py). Here: what FF Factory reads of it and how it runs its helper. With
 * FF_GAME_REPO set to a checkout that has the script, the last test runs the real queue too.
 */

const tmp = (t: { after(fn: () => void): void }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w1615-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** A ticket folder as bench_queue.py writes it. */
function ticket(lock: string, name: string, info: object, granted?: number, revoked = false) {
  const d = path.join(benchQueueDir(lock), name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'info.json'), JSON.stringify({ ticket: name, mode: 'exclusive', what: 'probe A', ...info }));
  if (granted) fs.writeFileSync(path.join(d, 'granted'), JSON.stringify({ at: new Date(granted * 1000).toISOString(), ts: granted }));
  if (revoked) fs.writeFileSync(path.join(d, 'revoked'), JSON.stringify({ at: 'x', why: 'held 61 min, over the 60 min bound' }));
}

test('w1615: readBenchLock counts a queue holder while its helper lives, however old its dir; never a gone, waiting or revoked one', (t) => {
  const root = tmp(t);
  const lock = path.join(root, 'tmp', 'bench.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), 'BEAST pid 4121 worker 21:04:10 probe A round 2 [t00000007] (/f/ffw/sandboxes/slot4)\n');
  const old = Date.now() / 1000 - 3 * 3600;
  fs.utimesSync(lock, old, old);
  const alive = new Set([555]);
  const isAlive = (pid: number) => alive.has(pid);
  ticket(lock, 't00000007', { pid: 555 }, old + 60);
  const held = readBenchLock(root, Date.now(), isAlive)!;
  assert.match(held.owner, /\[t00000007\] \(\/f\/ffw\/sandboxes\/slot4\)$/, 'the (folder) stays last for benchLockIn');
  assert.equal(held.since, new Date((old + 60) * 1000).toISOString(), 'since its grant');
  alive.delete(555);
  assert.equal(readBenchLock(root, Date.now(), isAlive), undefined, 'its helper is gone: not held');
  alive.add(555);
  fs.rmSync(path.join(benchQueueDir(lock), 't00000007', 'granted'));
  assert.equal(readBenchLock(root, Date.now(), isAlive), undefined, 'not granted: not held');
  ticket(lock, 't00000007', { pid: 555 }, old, true);
  assert.equal(readBenchLock(root, Date.now(), isAlive), undefined, 'revoked: not held');
  // An old-style line (no ticket) keeps the 40-minute rule: its Git Bash pid cannot be checked from here.
  fs.writeFileSync(path.join(lock, 'owner'), 'BEAST pid 4121 worker 21:04:10 probe A round 2 (/f/ffw/sandboxes/slot4)\n');
  fs.utimesSync(lock, old, old);
  assert.equal(readBenchLock(root, Date.now(), isAlive), undefined);
  const now = Date.now() / 1000;
  fs.utimesSync(lock, now, now);
  assert.equal(readBenchLock(root, Date.now(), isAlive)?.owner, 'BEAST pid 4121 worker 21:04:10 probe A round 2 (/f/ffw/sandboxes/slot4)');
});

test('w1615: queueTickets lists live tickets in order; heldTicket only a granted, unrevoked one named by FF_BENCH_TICKET', (t) => {
  const root = tmp(t);
  const lock = path.join(root, 'bench.lock');
  const alive = (pid: number) => pid !== 9;
  ticket(lock, 't00000002', { pid: 1, mode: 'shared', what: 'unity: build' });
  ticket(lock, 't00000001', { pid: 2 }, 1000);
  ticket(lock, 't00000003', { pid: 9 }, 1000);
  ticket(lock, 't00000004', { pid: 3 }, 1000, true);
  assert.deepEqual(queueTickets(lock, alive).map((x) => `${x.ticket} ${x.mode}`), ['t00000001 exclusive', 't00000002 shared', 't00000004 exclusive']);
  assert.equal(heldTicket(lock, { FF_BENCH_TICKET: 't00000001' }, alive)?.ticket, 't00000001');
  assert.equal(heldTicket(lock, { FF_BENCH_TICKET: 't00000002' }, alive), undefined, 'waiting');
  assert.equal(heldTicket(lock, { FF_BENCH_TICKET: 't00000003' }, alive), undefined, 'its helper is dead');
  assert.equal(heldTicket(lock, { FF_BENCH_TICKET: 't00000004' }, alive), undefined, 'revoked');
  assert.equal(heldTicket(lock, {}, alive), undefined);
});

/**
 * A stand-in for `bench_queue.py hold`: says waiting, then granted when the test writes <status>.grant, then released on
 * <status>.release. It also ends when the test's folder is gone: a test that fails before its release would otherwise
 * leave it running, and its stderr pipe holds the test file's process open until the run's deadline (w1758: the Windows
 * daily run of 2026-10-22 hung 15 min on one).
 */
const FAKE = `
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2); const st = a[a.indexOf('--status') + 1];
const say = (l) => fs.writeFileSync(st, l + '\\n');
say('waiting t00000002: shared ticket, place 2, waiting for t00000001 exclusive probe');
if (process.env.FAKE_FAIL) process.exit(3);
let granted = false;
const iv = setInterval(() => {
  if (!fs.existsSync(path.dirname(st))) process.exit(0);
  if (!granted && fs.existsSync(st + '.grant')) { granted = true; say('granted t00000002 shared pid ' + process.pid); }
  else if (granted && fs.existsSync(st + '.release')) { say('released t00000002'); clearInterval(iv); }
}, 20);
`;

test('w1615: BenchTicket runs the helper for this process, hears its place, its grant and its failure, and releases through the file', async (t) => {
  const dir = tmp(t);
  const script = path.join(dir, 'fake.cjs');
  fs.writeFileSync(script, FAKE);
  const lines: string[] = [];
  const k = new BenchTicket({ script, lock: path.join(dir, 'bench.lock'), mode: 'shared', what: 'unity: build', python: process.execPath, tempDir: dir }).take();
  // Its first line, however long its node takes to start (w1758: over 50 ms on Windows, where a fixed wait read
  // 'taking a ticket'), and granted only once the test has heard it.
  const started = Date.now() + 10_000;
  while (k.state().line === 'taking a ticket' && Date.now() < started) await new Promise((r) => setTimeout(r, 20));
  assert.equal(k.state().kind, 'waiting');
  const granted = k.wait(10_000, (l) => lines.push(l));
  fs.writeFileSync(`${k.status}.grant`, '');
  const s = await granted;
  assert.deepEqual(s.kind === 'granted' && s.ticket, 't00000002');
  assert.match(lines[0], /place 2, waiting for t00000001/);
  k.release();
  const deadline = Date.now() + 5000;
  while (!fs.readFileSync(k.status, 'utf8').startsWith('released') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.match(fs.readFileSync(k.status, 'utf8'), /^released t00000002/);
  const bad = new BenchTicket({ script, lock: path.join(dir, 'bench.lock'), mode: 'shared', what: 'x', python: process.execPath, tempDir: dir, env: { ...process.env, FAKE_FAIL: '1' } }).take();
  assert.equal((await bad.wait(10_000)).kind, 'failed', 'a helper that dies before its grant fails the ticket: the caller goes on without');
  const none = new BenchTicket({ script, lock: 'x', mode: 'shared', what: 'x', python: path.join(dir, 'no-such-python'), tempDir: dir }).take();
  assert.equal((await none.wait(10_000)).kind, 'failed', 'no python: fails open');
});

test('w1615: benchTicketFor finds the queue script in a checkout or above it, and says why when there is none', (t) => {
  const dir = tmp(t);
  assert.match(benchTicketFor({ mode: 'shared', what: 'x', checkouts: [dir], root: dir }).why ?? '', /no scripts\/bench\/bench_queue\.py/);
  fs.mkdirSync(path.join(dir, 'scripts', 'bench'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'bench', 'bench_queue.py'), '');
  fs.mkdirSync(path.join(dir, 'Assets', 'Scripts'), { recursive: true });
  assert.equal(findBenchQueueScript([undefined, path.join(dir, 'Assets', 'Scripts')]), path.join(dir, 'scripts', 'bench', 'bench_queue.py'));
});

const GAME = process.env.FF_GAME_REPO;
test('w1615: against the real bench_queue.py, a shared ticket waits for an exclusive one ahead and gets it when it goes', { skip: !GAME || !findBenchQueueScript([GAME]) ? 'FF_GAME_REPO not set to a checkout with scripts/bench/bench_queue.py' : false }, async (t) => {
  const dir = tmp(t);
  const lock = path.join(dir, 'bench.lock');
  const script = findBenchQueueScript([GAME])!;
  const env: NodeJS.ProcessEnv = { ...process.env, BENCH_POLL_S: '0.1', BENCH_LEGACY_GRACE_S: '0' };
  delete env.FF_BENCH_TICKET;
  const ex = new BenchTicket({ script, lock, mode: 'exclusive', what: 'probe A', tempDir: dir, env }).take();
  assert.equal((await ex.wait(15_000)).kind, 'granted');
  assert.ok(fs.existsSync(path.join(lock, 'owner')), 'the exclusive holder makes the old-style lock dir');
  const sh = new BenchTicket({ script, lock, mode: 'shared', what: 'unity: build', tempDir: dir, env }).take();
  const waiting = await sh.wait(1500);
  assert.equal(waiting.kind, 'waiting', 'the build waits for the timed run');
  assert.match(waiting.line, /waiting for t00000001 exclusive probe A/);
  ex.release();
  assert.equal((await sh.wait(15_000)).kind, 'granted');
  sh.release();
  // A child process that holds a ticket and is killed frees it (the helper sees its owner gone).
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  t.after(() => owner.kill('SIGKILL'));
  const helper = spawn(process.env.FF_PYTHON || 'python3', [script, '--lock', lock, 'hold', '--mode', 'exclusive', '--what', 'killed', '--owner-pid', String(owner.pid), '--status', path.join(dir, 'k')], { env, stdio: 'ignore' });
  t.after(() => helper.kill('SIGKILL'));
  const until = Date.now() + 15_000;
  while (!(fs.existsSync(path.join(dir, 'k')) && fs.readFileSync(path.join(dir, 'k'), 'utf8').startsWith('granted')) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  owner.kill('SIGKILL');
  const next = new BenchTicket({ script, lock, mode: 'exclusive', what: 'next', tempDir: dir, env }).take();
  assert.equal((await next.wait(15_000)).kind, 'granted', 'the killed owner\'s ticket is let go');
  next.release();
});

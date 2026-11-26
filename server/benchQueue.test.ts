import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readBenchLock } from '../machine/benchLock.ts';
import { BenchTicket, benchQueueDir, benchStatusDir, benchTicketFor, sweepBenchStatus, findBenchQueueScript, heldTicket, newestBenchQueueScript, queueTickets, rulesVersion } from '../machine/benchQueue.ts';

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
  const lock = path.join(root, 'daemon', 'bench.lock');
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
  // w5905: the helper lets go on the release file and exits, and its status files go with it (not 20 s later).
  const deadline = Date.now() + 5000;
  while (fs.existsSync(k.status) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.existsSync(k.status), false, 'the status file is removed once the helper exits');
  assert.equal(fs.existsSync(`${k.status}.release`), false, 'and the release file with it');
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

test('w5834: a ticket\'s status file goes inside the worker root, and a folder that cannot be made falls back without refusing', async (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'scripts', 'bench'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'bench', 'bench_queue.py'), FAKE);
  const r = benchTicketFor({ mode: 'shared', what: 'x', checkouts: [dir], root: dir, python: process.execPath });
  assert.equal(r.why, undefined, 'unity-slot run reads any why as a refusal');
  assert.equal(path.dirname(r.ticket!.status), path.join(dir, 'tmp', 'bench-status'));
  r.ticket!.release();
  assert.deepEqual(benchStatusDir(dir), { dir: path.join(dir, 'tmp', 'bench-status') });
  const no = benchStatusDir(dir, () => {
    throw new Error('EACCES');
  });
  assert.equal(no.dir, os.tmpdir());
  assert.match(no.why ?? '', /could not make .*bench-status \(EACCES\)/);
  assert.equal(benchStatusDir(undefined).dir, os.tmpdir());
});

const GAME = process.env.FF_GAME_REPO;
test('w1615: against the real bench_queue.py, a shared ticket waits for an exclusive one ahead and gets it when it goes', { skip: !GAME || !findBenchQueueScript([GAME]) ? 'FF_GAME_REPO not set to a checkout with scripts/bench/bench_queue.py' : false }, async (t) => {
  const dir = tmp(t);
  const lock = path.join(dir, 'bench.lock');
  const script = findBenchQueueScript([GAME])!;
  const env: NodeJS.ProcessEnv = { ...process.env, BENCH_POLL_S: '0.1', BENCH_LEGACY_GRACE_S: '0' };
  delete env.FF_BENCH_TICKET;
  // w5974: run inside a worker, the tickets would carry its session, and since w2605 (the game repo's own_turn) a
  // session's shared ticket rides its own running exclusive turn: granted at once, not waiting. Take them as nobody's.
  delete env.FF_SESSION_ID;
  delete env.FF_BENCH_SESSION;
  // w5974: a failed assertion left the helpers holding the run open until it was killed; let every ticket go.
  const tickets: BenchTicket[] = [];
  t.after(() => tickets.forEach((k) => k.release()));
  const ex = new BenchTicket({ script, lock, mode: 'exclusive', what: 'probe A', tempDir: dir, env }).take();
  tickets.push(ex);
  assert.equal((await ex.wait(15_000)).kind, 'granted');
  assert.ok(fs.existsSync(path.join(lock, 'owner')), 'the exclusive holder makes the old-style lock dir');
  const sh = new BenchTicket({ script, lock, mode: 'shared', what: 'unity: build', tempDir: dir, env }).take();
  tickets.push(sh);
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
  tickets.push(next);
  assert.equal((await next.wait(15_000)).kind, 'granted', 'the killed owner\'s ticket is let go');
  next.release();
});

test('w1962: a ticket runs under the copy of bench_queue.py with the newest rules on the machine, its own checkout first on a tie', (t) => {
  const root = tmp(t);
  const put = (dir: string, text: string) => {
    fs.mkdirSync(path.join(dir, 'scripts', 'bench'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'bench', 'bench_queue.py'), text);
    return path.join(dir, 'scripts', 'bench', 'bench_queue.py');
  };
  const stale = put(path.join(root, 'sandboxes', 'slot5'), '# from before w1962\n');
  const fresh = put(path.join(root, 'sandboxes', 'slot3'), 'X = 1\nRULES_VERSION = 2\n');
  const other = put(path.join(root, 'sandboxes', 'slot1'), 'RULES_VERSION = 2\n');
  assert.equal(rulesVersion(stale), 0);
  assert.equal(rulesVersion(fresh), 2);
  assert.equal(newestBenchQueueScript([path.join(root, 'sandboxes', 'slot5')], root), other, "slot5's stale copy loses to the newest rules (the first sandbox of them)");
  assert.equal(newestBenchQueueScript([path.join(root, 'sandboxes', 'slot3')], root), fresh, 'a tie keeps the checkout\'s own copy');
  assert.equal(newestBenchQueueScript([undefined], root), other);
  assert.equal(newestBenchQueueScript([undefined], undefined), undefined);
});

test('w5905: a ticket from benchTicketFor keeps its status files in <root>/tmp/bench-status, never the OS temp folder, and removes them on release', async (t) => {
  const root = tmp(t);
  const checkout = path.join(root, 'sandboxes', 'slot1');
  fs.mkdirSync(path.join(checkout, 'scripts', 'bench'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'scripts', 'bench', 'bench_queue.py'), FAKE);
  const { BENCH_LOCK: _l, FF_WORKER_ROOT: _r, ...env } = process.env;
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`ff-bench-${process.pid}-`)));
  const { ticket: k, why } = benchTicketFor({ mode: 'shared', what: 'running editor slot1', checkouts: [checkout], root, python: process.execPath, env });
  if (!k) throw new Error(why);
  assert.equal(path.dirname(k.status), benchStatusDir(root).dir);
  assert.equal(benchStatusDir(root).dir, path.join(root, 'tmp', 'bench-status'));
  const until = Date.now() + 10_000;
  while (k.state().line === 'taking a ticket' && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(`${k.status}.grant`, '');
  assert.equal((await k.wait(10_000)).kind, 'granted');
  fs.writeFileSync(`${k.status}.warn`, 'the helper\'s warning (review w5945 F1)');
  k.release();
  const gone = Date.now() + 5000;
  while (fs.readdirSync(benchStatusDir(root).dir).some((n) => n.startsWith('ff-bench-') && !n.endsWith('.grant')) && Date.now() < gone) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fs.readdirSync(benchStatusDir(root).dir).filter((n) => n.startsWith('ff-bench-') && !n.endsWith('.grant')), [], 'nothing of the ticket is left after its release');
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`ff-bench-${process.pid}-`) && !before.has(n));
  assert.deepEqual(after, [], 'nothing new in the OS temp folder');
});

test('w5905: sweepBenchStatus removes the status files of a gone holder and keeps its own, a live one and anything else', (t) => {
  const dir = tmp(t);
  const names = ['ff-bench-111-28b4c907', 'ff-bench-111-28b4c907.release', 'ff-bench-111-aa.tmp', 'ff-bench-111-28b4c907.warn', 'ff-bench-111-28b4c907.warn.tmp', 'ff-bench-222-0f', 'ff-bench-222-0f.warn', 'ff-bench-333-0e', 'ff-bench-333-0e.release', 'notes.txt', 'ff-bench-x-1'];
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'granted t00000071 shared pid 4028549');
  const gone = sweepBenchStatus(dir, { selfPid: 222, alive: (pid) => pid === 333 });
  assert.deepEqual(gone, ['ff-bench-111-28b4c907', 'ff-bench-111-28b4c907.release', 'ff-bench-111-28b4c907.warn', 'ff-bench-111-28b4c907.warn.tmp', 'ff-bench-111-aa.tmp']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ff-bench-222-0f', 'ff-bench-222-0f.warn', 'ff-bench-333-0e', 'ff-bench-333-0e.release', 'ff-bench-x-1', 'notes.txt']);
  assert.deepEqual(sweepBenchStatus(path.join(dir, 'none')), [], 'a folder not made yet: nothing to sweep');
});

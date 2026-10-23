import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchTurn, BUILD_LOOK_MS, type BenchTurnDeps, type Holder, type TurnBuild } from '../machine/benchTurn.ts';
import { EXIT_NO_TICKET, EXIT_NO_TIMED_RUNS, EXIT_REVOKED, main, stopTree } from '../machine/unitySlots.ts';

/**
 * w1860 (lothsahn, 2026-10-23: "Make the shutdown of builds for the exclusive lock urgent"): while another worker's exclusive
 * ticket holds the machine, no build, test run or batch compile of another sandbox runs. The daemon's turn stops a stray
 * one (it held no ticket, or its ticket was revoked and it went on), and `unity-slot run` itself ends its command when its
 * ticket is revoked under it (its helper is a service owner that stops nothing).
 */

const T0 = Date.parse('2026-10-23T09:00:00Z');

function holder(over: Partial<Holder> = {}): Holder {
  return { ticket: 't00000042', mode: 'exclusive', what: 'justplay fps A', pid: 900, host: 'lothdesktop', sandbox: 'slot3', session: 'dec9a619', requests: ['w1785'], granted: { at: 'x', ts: T0 / 1000 }, maxMin: 60, ownerPid: 800, until: T0 + 30 * 60_000, ...over };
}

function harness(builds: TurnBuild[], procs: { pid: number; ppid: number }[]) {
  const s = { holder: undefined as Holder | undefined, now: T0, builds, procCalls: 0, stopped: [] as string[], notes: [] as [string, string][], log: [] as string[] };
  const d: BenchTurnDeps = {
    holder: () => s.holder,
    editors: () => [],
    closed: () => [],
    players: () => [],
    procs: async () => {
      s.procCalls++;
      return procs.map((p) => ({ ...p, cmd: '' }));
    },
    closeEditor: async () => ({ closed: true, text: 'closed' }),
    reopenEditor: async () => 'started',
    closePlayer: async () => 'asked',
    builds: () => s.builds,
    exemptSandbox: (id) => id === 'slot6',
    stopBuild: async (pid, sandbox, why) => {
      s.stopped.push(`${pid} ${sandbox} ${why}`);
      s.builds = s.builds.filter((b) => b.pid !== pid);
      return `ended batch Unity pid ${pid}`;
    },
    noteSandbox: (id, text) => s.notes.push([id, text]),
    writeClosed: () => undefined,
    log: (l) => s.log.push(l),
    now: () => s.now,
  };
  return { s, turn: new BenchTurn(d) };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('w1860: during a turn another sandbox batch Unity is stopped and its workers told; the holder own, its owner tree, an exempt worker are left; the look repeats every BUILD_LOOK_MS, not every tick', async () => {
  const { s, turn } = harness(
    [
      { pid: 501, sandbox: 'slot1' }, // another worker's player build: stopped
      { pid: 502, sandbox: 'slot3' }, // the holder's own sandbox
      { pid: 503, sandbox: 'slot5' }, // started by the holder's ticket owner (pid 800)
      { pid: 504, sandbox: 'slot6' }, // the nightly's sandbox (exempt)
    ],
    [
      { pid: 501, ppid: 1 },
      { pid: 502, ppid: 1 },
      { pid: 503, ppid: 801 },
      { pid: 801, ppid: 800 },
      { pid: 504, ppid: 1 },
    ],
  );
  await turn.tick();
  assert.equal(s.procCalls, 0, 'no turn: no listing');
  s.holder = holder();
  await turn.tick();
  await settle();
  assert.equal(s.stopped.length, 1);
  assert.match(s.stopped[0], /^501 slot1 a timed run on lothdesktop\/slot3 \(w1785\) holds this machine's exclusive bench ticket t00000042/);
  assert.deepEqual(s.notes.map((n) => n[0]), ['slot1']);
  assert.match(s.notes[0][1], /batch Unity run \(pid 501.*stopped at 09:00Z.*Your files are as they were.*unity-slot run.*by 09:30Z at the latest/);
  assert.ok(s.log.some((l) => /sandbox slot1: batch Unity pid 501: ended/.test(l)));
  // Within BUILD_LOOK_MS no listing for builds (it costs CPU the timed run measures); after it, a new stray one is stopped.
  const calls = s.procCalls;
  s.now += 5_000;
  s.builds.push({ pid: 505, sandbox: 'slot2' });
  await turn.tick();
  assert.equal(s.procCalls, calls);
  s.now += BUILD_LOOK_MS;
  await turn.tick();
  await settle();
  assert.deepEqual(s.stopped.map((x) => x.split(' ').slice(0, 2).join(' ')), ['501 slot1', '505 slot2']);
  // No turn: nothing is stopped.
  s.holder = undefined;
  s.builds.push({ pid: 506, sandbox: 'slot2' });
  s.now += BUILD_LOOK_MS;
  await turn.tick();
  await settle();
  assert.equal(s.stopped.length, 2);
});

test('w1860: stopTree ends the whole tree at once on Windows (/T /F: a batch Unity has no window to ask)', () => {
  const calls: string[][] = [];
  stopTree(4321, 'win32', 20_000, (c, a) => (calls.push([c, ...a]), ''));
  assert.deepEqual(calls, [['taskkill', '/T', '/F', '/PID', '4321']]);
});

test('w1860: unity-slot run ends its command and exits 75 when its bench ticket is revoked under it', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1860-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'sandboxes', 'slot1');
  fs.mkdirSync(path.join(checkout, 'scripts', 'bench'), { recursive: true });
  // A stand-in for bench_queue.py's `hold` (run by node through FF_PYTHON): granted at once, revoked a moment later.
  fs.writeFileSync(
    path.join(checkout, 'scripts', 'bench', 'bench_queue.py'),
    `const fs = require('fs'); const a = process.argv; const st = a[a.indexOf('--status') + 1];
     fs.writeFileSync(st, 'granted t00000007 shared pid ' + process.pid + '\\n');
     setTimeout(() => { fs.writeFileSync(st, 'revoked t00000007 at x: its turn is over (w1832)\\n'); process.exit(1); }, 1500);`,
  );
  const started = Date.now();
  const code = await main(['run', '--label', 'test build', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    ...process.env,
    FF_PYTHON: process.execPath,
    FF_SANDBOX_PATH: checkout,
    FF_WORKER_ROOT: root,
    FF_UNITY_SLOTS: path.join(root, 'slots'),
    BENCH_LOCK: path.join(root, 'tmp', 'bench.lock'),
    FF_BENCH_TICKET: '',
    FF_UNITY_SLOT_HELD: '',
    FF_BENCH_TICKETS: '',
  });
  assert.equal(code, EXIT_REVOKED);
  assert.ok(Date.now() - started < 20_000, 'the command was stopped, not waited out');
});

/** A worker root with one sandbox whose bench_queue.py is `helper` (node, run through FF_PYTHON), and unity-slot run's env. */
function fakeQueue(t: { after: (f: () => void) => void }, helper?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1860-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'sandboxes', 'slot1');
  fs.mkdirSync(path.join(checkout, 'scripts', 'bench'), { recursive: true });
  if (helper !== undefined) fs.writeFileSync(path.join(checkout, 'scripts', 'bench', 'bench_queue.py'), helper);
  const ran = path.join(root, 'ran.txt');
  const env = { ...process.env, FF_PYTHON: process.execPath, FF_SANDBOX_PATH: checkout, FF_WORKER_ROOT: root, FF_UNITY_SLOTS: path.join(root, 'slots'), BENCH_LOCK: path.join(root, 'tmp', 'bench.lock'), FF_BENCH_TICKET: '', FF_UNITY_SLOT_HELD: '', FF_BENCH_TICKETS: '', FF_UNITY_SLOT_BENCH: '' };
  // The command writes a file when it runs: it must not, without a ticket.
  const cmd = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ran)}, 'ran')`];
  return { root, env, cmd, ran, cwd: checkout };
}

test('w1860: unity-slot run --bench exclusive refused by the queue (a machine that takes no timed runs, w1861) does not run its command: exits 77 with the refusal', { timeout: 30_000 }, async (t) => {
  const q = fakeQueue(
    t,
    `const fs = require('fs'); const a = process.argv; const st = a[a.indexOf('--status') + 1];
     fs.writeFileSync(st, 'gave up: this machine takes no timed runs or other exclusive tickets (Ben runs stuff on it; w1861), so no exclusive ticket here.\\n');
     process.exitCode = 77;`,
  );
  const code = await main(['run', '--bench', 'exclusive', '--label', 'timed leg', '--', ...q.cmd], q.env);
  assert.equal(code, EXIT_NO_TIMED_RUNS);
  assert.equal(fs.existsSync(q.ran), false, 'the timed run went ahead with no ticket');
});

test('w1860: unity-slot run whose bench helper fails (exclusive or shared) does not run its command: exits 69', { timeout: 30_000 }, async (t) => {
  for (const mode of ['exclusive', 'shared'] as const) {
    const q = fakeQueue(t, `process.stderr.write('Traceback: boom\\n'); process.exit(1);`);
    const code = await main(['run', '--bench', mode, '--label', `${mode} job`, '--', ...q.cmd], q.env);
    assert.equal(code, EXIT_NO_TICKET, mode);
    assert.equal(fs.existsSync(q.ran), false, `${mode}: the run went ahead with no ticket`);
  }
});

test('w1860: unity-slot run with no bench queue to take a ticket from does not run its command; FF_BENCH_TICKETS=off still runs it', { timeout: 30_000 }, async (t) => {
  const q = fakeQueue(t);
  assert.equal(await main(['run', '--label', 'build', '--', ...q.cmd], { ...q.env, FF_SANDBOX_PATH: path.join(q.root, 'nowhere') }), EXIT_NO_TICKET);
  assert.equal(fs.existsSync(q.ran), false, 'the build went ahead with no ticket');
  assert.equal(await main(['run', '--label', 'build', '--', ...q.cmd], { ...q.env, FF_SANDBOX_PATH: path.join(q.root, 'nowhere'), FF_BENCH_TICKETS: 'off' }), 0);
  assert.equal(fs.existsSync(q.ran), true, 'FF_BENCH_TICKETS=off is the way to run without one');
});

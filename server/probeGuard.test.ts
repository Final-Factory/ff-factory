import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOffThread } from './hostProbe.ts';
import { lingeringProbes, MAX_LINGERING, probeBegin, probeLabel, resetProbeGuardForTest, RETRY_EVERY_MS, useProbeGuard } from './probeGuard.ts';
import { run } from './proc.ts';
import { useSpawnThread } from './spawnThread.ts';

// w6784: on BEAST a WMI hang left PowerShell probes stuck past their timeout's kill and the daemon's timers piled up more.
// A program that ignores SIGTERM (execFile's timeout kill) lingers past its kill the same way, on macOS and Linux; on
// Windows that kill is TerminateProcess, which it cannot ignore, so these run elsewhere.
const posix = process.platform !== 'win32';
const node = process.execPath;
const STUBBORN = ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"];
const QUICK = ['-e', "process.stdout.write('ok')"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setUp(mode: 'warn' | 'enforce' | 'off') {
  const lines: string[] = [];
  resetProbeGuardForTest(200);
  useProbeGuard(mode, (l) => lines.push(l));
  return lines;
}

/** Waits until a probe lingers, answers its pid. */
async function lingering(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const l = lingeringProbes();
    if (l.length && l[0].pid) return l[0].pid;
    await sleep(50);
  }
  throw new Error('no probe lingered');
}

function end(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone already.
  }
}

for (const thread of [false, true]) {
  const where = thread ? 'on the spawn thread' : 'on the calling thread';

  test(`w6784: warn only: a probe stuck past its kill is said, and another of its kind still starts (${where})`, { skip: !posix }, async () => {
    const lines = setUp('warn');
    useSpawnThread(thread, () => {});
    let pid = 0;
    try {
      const stuck = run(node, STUBBORN, { timeoutMs: 200, probe: 'w6784 test probe' });
      pid = await lingering();
      assert.ok(lines.some((l) => /w6784 test probe \(pid \d+\).*it lingers \(w6784\)/.test(l)), lines.join('\n'));
      const next = await run(node, QUICK, { timeoutMs: 5000, probe: 'w6784 test probe' });
      assert.equal(next.code, 0);
      assert.equal(next.stdout, 'ok');
      assert.ok(lines.some((l) => /probe guard \(warn only\): 1 earlier w6784 test probe .*would not be under FF_PROBE_GUARD=enforce/.test(l)), lines.join('\n'));
      end(pid);
      const r = await stuck;
      assert.equal(r.timedOut, true);
      assert.ok(lines.some((l) => /has ended after all/.test(l)), lines.join('\n'));
      assert.deepEqual(lingeringProbes(), []);
    } finally {
      end(pid);
      useSpawnThread(false);
      useProbeGuard('warn');
    }
  });

  test(`w6784: enforce: a probe stuck past its kill answers its caller, and the next of its kind is not started (${where})`, { skip: !posix }, async () => {
    const lines = setUp('enforce');
    useSpawnThread(thread, () => {});
    let pid = 0;
    try {
      const t0 = Date.now();
      const stuck = run(node, STUBBORN, { timeoutMs: 200, probe: 'w6784 test probe' });
      pid = await lingering();
      // Answered as timed out though the program is still there: a caller awaiting it is not left waiting for good.
      const r = await stuck;
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - t0 < 5000);
      assert.ok(lingeringProbes().length === 1, 'still tracked until it really ends');
      const refused = await run(node, QUICK, { timeoutMs: 5000, probe: 'w6784 test probe' });
      assert.equal(refused.code, -1);
      assert.match(refused.stderr, /not started: 1 earlier w6784 test probe .*still running past its 0 s timeout's kill/);
      // Another kind is not held up.
      assert.equal((await run(node, QUICK, { timeoutMs: 5000, probe: 'another w6784 probe' })).code, 0);
      end(pid);
      for (let i = 0; i < 100 && lingeringProbes().length; i++) await sleep(50);
      assert.deepEqual(lingeringProbes(), []);
      assert.equal((await run(node, QUICK, { timeoutMs: 5000, probe: 'w6784 test probe' })).code, 0, 'runs again once the stuck one ended');
    } finally {
      end(pid);
      useSpawnThread(false);
      useProbeGuard('warn');
    }
  });
}

test('w6784: enforce lets one retry through every RETRY_EVERY_MS while fewer than MAX_LINGERING linger', async () => {
  setUp('enforce');
  try {
    const t0 = Date.now();
    const a = probeBegin({ cmd: 'x', args: [], timeoutMs: 1, probe: 'k' });
    assert.ok(a.ticket);
    await sleep(400);
    assert.equal(lingeringProbes().length, 1);
    assert.ok(probeBegin({ cmd: 'x', args: [], timeoutMs: 1, probe: 'k', now: t0 + 1000 }).refused);
    const later = Date.now() + RETRY_EVERY_MS + 1;
    const b = probeBegin({ cmd: 'x', args: [], timeoutMs: 1, probe: 'k', now: later });
    assert.ok(b.ticket, 'one retry');
    assert.ok(probeBegin({ cmd: 'x', args: [], timeoutMs: 1, probe: 'k', now: later + 1 }).refused, 'only one');
    a.ticket!.done();
    b.ticket!.done();
    assert.deepEqual(lingeringProbes(), []);
    // MAX_LINGERING of a kind: no retry at all.
    const tickets = Array.from({ length: MAX_LINGERING }, () => probeBegin({ cmd: 'x', args: [], timeoutMs: 1, probe: 'k' }).ticket!);
    await sleep(400);
    assert.equal(lingeringProbes().length, MAX_LINGERING);
    assert.ok(probeBegin({ cmd: 'x', args: [], timeoutMs: 1, probe: 'k', now: Date.now() + 10 * RETRY_EVERY_MS }).refused);
    for (const t of tickets) t.done();
  } finally {
    resetProbeGuardForTest();
    useProbeGuard('warn');
  }
});

test('w6784: off tracks nothing, and a program without a timeout is no probe', async () => {
  setUp('off');
  try {
    probeBegin({ cmd: 'x', args: [], timeoutMs: 1, probe: 'k' });
    useProbeGuard('enforce');
    probeBegin({ cmd: 'x', args: [], probe: 'k' });
    probeBegin({ cmd: 'x', args: [], timeoutMs: 0, probe: 'k' });
    await sleep(400);
    assert.deepEqual(lingeringProbes(), []);
  } finally {
    resetProbeGuardForTest();
    useProbeGuard('warn');
  }
});

test('w6784: the host probe thread is guarded too: enforce answers a lingering kind at once, timed out', async () => {
  setUp('enforce');
  try {
    const t = probeBegin({ cmd: 'nvidia-smi', args: [], timeoutMs: 1, probe: 'gpu' }).ticket!;
    await sleep(400);
    const r = await runOffThread('nvidia-smi', ['-q'], 5000, { probe: 'gpu' });
    assert.equal(r.code, -1);
    assert.equal(r.timedOut, true);
    assert.match(r.stderr, /not started/);
    t.done();
  } finally {
    resetProbeGuardForTest();
    useProbeGuard('warn');
  }
});

test('w6784: a probe is named in the log by its program and the start of its script', () => {
  const enc = Buffer.from('Get-CimInstance Win32_Process -Filter "Name=\'Unity.exe\'"', 'utf16le').toString('base64');
  assert.equal(probeLabel('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-EncodedCommand', enc]), 'powershell.exe "Get-CimInstance Win32_Process -Filter "Name=\'Unity.exe\'""');
  assert.equal(probeLabel('powershell.exe', ['-NoProfile', '-Command', `(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples`]), `powershell.exe "(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples"`);
  assert.match(probeLabel('schtasks', ['/Query', '/TN', 'FFFactoryDaemon']), /^schtasks "\/Query \/TN FFFactoryDaemon"$/);
  assert.ok(probeLabel('powershell.exe', ['-Command', 'x'.repeat(200)]).endsWith('..."'));
});

test('w6784 (w6785\'s review): a probe the host probe thread cannot take ends its ticket, so its kind does not linger for good', async () => {
  setUp('enforce');
  try {
    // A function in env cannot be cloned to the thread: postMessage throws (DataCloneError).
    const r = await runOffThread(node, QUICK, 1, { probe: 'uncloneable', env: { X: (() => 1) as unknown as string } });
    assert.equal(r.code, -1);
    assert.match(r.stderr, /the probe thread could not take it/);
    await sleep(400);
    assert.deepEqual(lingeringProbes(), []);
    assert.ok(probeBegin({ cmd: 'x', args: [], timeoutMs: 1000, probe: 'uncloneable' }).ticket?.done() === undefined, 'not refused');
  } finally {
    resetProbeGuardForTest();
    useProbeGuard('warn');
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { StallProfiler, summarizeProfile, type CpuProfile } from './stallProfile.ts';

function busyLoopForStallTest(ms: number) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  return x;
}

test('w2026: a stall profile names the function that held the loop, by own time and among the portal functions', async () => {
  const s = new Session();
  s.connect();
  const post = <T>(m: string, p?: object) => new Promise<T>((ok, no) => s.post(m, p ?? {}, (e, r) => (e ? no(e) : ok(r as T))));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 1000 });
  await post('Profiler.start');
  busyLoopForStallTest(400);
  const { profile } = await post<{ profile: CpuProfile }>('Profiler.stop');
  s.disconnect();
  const sum = summarizeProfile(profile);
  assert.ok(sum.totalMs >= 200, `CPU time ${sum.totalMs} ms`);
  const mine = sum.under.find((x) => x.fn.startsWith('busyLoopForStallTest (server/stallProfile.test.ts:'));
  assert.ok(mine && mine.ms >= 200, JSON.stringify(sum));
});

test('w2044: a block\'s own line counts only the samples taken in it, not the rest of the minute', () => {
  const frame = (functionName: string, lineNumber: number) => ({ functionName, url: 'file:///srv/fff/server/agents.ts', lineNumber, columnNumber: 0 });
  // A state save at 1-3 ms, then placement at 4-9 ms: one sample a millisecond (timeDeltas are microseconds).
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 }, children: [2, 3] },
      { id: 2, callFrame: frame('save', 10) },
      { id: 3, callFrame: frame('places', 20) },
    ],
    startTime: 0,
    endTime: 10_000,
    samples: [2, 2, 2, 3, 3, 3, 3, 3, 3],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  };
  const block = summarizeProfile(profile, 6, [[3.5, 10]]);
  assert.deepEqual(block.under.map((x) => x.fn), ['places (server/agents.ts:21)']);
  const minute = summarizeProfile(profile);
  assert.equal(block.totalMs, minute.totalMs - 3, 'the save\'s three samples are left out');
  assert.deepEqual(minute.under.map((x) => x.fn).sort(), ['places (server/agents.ts:21)', 'save (server/agents.ts:11)']);
});

test('w6382: a slow state build gets a line of its own from its samples, with no stall in the window', () => {
  const frame = (functionName: string, lineNumber: number) => ({ functionName, url: 'file:///srv/fff/server/agents.ts', lineNumber, columnNumber: 0 });
  // Placement at 0-4 ms of the window, then the build's accounts at 5-9 ms (one sample a millisecond).
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 }, children: [2, 3] },
      { id: 2, callFrame: frame('places', 20) },
      { id: 3, callFrame: frame('accountsNow', 30) },
    ],
    startTime: 0,
    endTime: 10_000,
    samples: [2, 2, 2, 2, 3, 3, 3, 3, 3],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  };
  const lines: string[] = [];
  const p = new StallProfiler({ dataDir: '.', worstLagSince: () => 0, log: (l) => lines.push(l) });
  const from = Date.parse('2026-11-27T12:00:00Z');
  p.logSpans(profile, from, [{ what: 'state build', end: from + 10, ms: 5.5 }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^stall profile: state build of 6 ms ending 2026-11-27T12:00:00\.010Z\. Own time: accountsNow \(server\/agents\.ts:31\) \d+ ms\. In the portal's functions: accountsNow/);
  assert.doesNotMatch(lines[0], /places/);
  // A span under PROFILE_SLOW_SPAN_MS, or one noted while the profiler is off, is not kept.
  p.noteSpan('state build', 10_000);
  assert.equal((p as unknown as { spans: unknown[] }).spans.length, 0);
});

// Its own functions: one an earlier test ran under another session's profiler is named by its caller here (measured).
function firstWindowBusyLoop(ms: number) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 1);
  return x;
}

function secondWindowBusyLoop(ms: number) {
  const end = Date.now() + ms;
  let x = 0;
  while (Date.now() < end) x += Math.sqrt(x + 2);
  return x;
}

test('w6416: windows overlap, so a roll starts the next profile warm, and each window still names its own block', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-w6416-'));
  const lines: string[] = [];
  let block: [number, number] = [0, 0];
  const p = new StallProfiler({ dataDir: dir, worstLagSince: () => block[1], blocksSince: () => [block], log: (l) => lines.push(l) }).start();
  try {
    assert.equal(p.overlap, true, 'this Node gives console profiles back to the session');
    const t0 = Date.now();
    firstWindowBusyLoop(400);
    block = [Date.now(), Date.now() - t0 + 1000];
    p.roll();
    assert.ok(p.lastRoll && p.lastRoll.nodes > 1 && p.lastRoll.samples > 0, JSON.stringify(p.lastRoll));
    const first = lines.find((l) => l.startsWith('stall profile: block of'));
    assert.match(first ?? '', /firstWindowBusyLoop \(server\/stallProfile\.test\.ts:\d+\)/, lines.join('\n'));
    // The next window is its own: its block names the second function, not the first window's.
    lines.length = 0;
    const t1 = Date.now();
    secondWindowBusyLoop(400);
    block = [Date.now(), Date.now() - t1 + 1000];
    p.roll();
    const second = lines.find((l) => l.startsWith('stall profile: block of'));
    assert.match(second ?? '', /secondWindowBusyLoop/, lines.join('\n'));
    assert.doesNotMatch(second ?? '', /firstWindowBusyLoop/);
  } finally {
    p.stop();
    await new Promise((ok) => setTimeout(ok, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

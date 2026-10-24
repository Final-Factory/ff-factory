import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { summarizeProfile, type CpuProfile } from './stallProfile.ts';

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

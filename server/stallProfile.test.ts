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

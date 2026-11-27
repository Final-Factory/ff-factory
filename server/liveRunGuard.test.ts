import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { holdParts, nightsIn } from '../machine/switchHolds.ts';
import { liveRunGuardModeOf, liveRunWarning } from '../machine/liveRunGuard.ts';
import type { UnityPlatform } from '../machine/unity.ts';
import { until, repos, pool, ready } from './machineSandboxesTestKit.ts';

/**
 * w6378: a release or clean-up that hits a sandbox while a run of its worker still lives there (machine/liveRunGuard.ts).
 * The w6357 case: on 2026-11-27 the nightly e2e waited for its bench turn in lothdesktop/slot2 when its worker's idle host
 * was restarted on new code (10:00:56 UTC); the pool saw no live agent there and trimmed slot2 and swept its build output
 * under the night. Warn only: a WARNING line, and everything goes ahead exactly as before.
 */

const PLATFORM = process.platform as UnityPlatform;
const NIGHT_PID = 58536;

/** A nightly-history folder whose 2026-11-27 night runs in `sandbox` (its builds in <sandbox>/Builds/cache), as on 11-27. */
function historyFor(sandbox: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-w6378-'));
  fs.mkdirSync(path.join(root, 'state'));
  const started = Date.now() / 1000 - 2 * 3600;
  const night = { tag: '2026-11-27', date: '2026-11-27', status: 'running', started, attempt: 2, step: 'run', request: 'w6357', mode: 'sandbox', builds: path.join(sandbox, 'Builds', 'cache'), pid: NIGHT_PID };
  fs.writeFileSync(path.join(root, 'state', '2026-11-27.json'), JSON.stringify(night));
  return root;
}

/** The daemon's look (Daemon.liveRunIn) with a stand-in for the unity-slot holds: the nights in the sandbox's tree. */
const nightLook = (root: string, alive: () => boolean) => async (_id: string, sandboxPath: string) =>
  holdParts({ nights: nightsIn({ roots: [root], checkout: sandboxPath, platform: PLATFORM, alive, now: Date.now() }), runs: [], batch: [] });

test('w6378: the w6357 case: the last agent leaves a sandbox its night still runs in: a WARNING names the night, and the trim and release sweep go ahead as before (warn only)', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let live = 1;
  let nightAlive = true;
  const logs: string[] = [];
  const swept: string[] = [];
  let root = '';
  const { p, statuses } = pool(r, {
    liveAgents: () => live,
    log: (l) => logs.push(l),
    liveRun: (id, sb) => nightLook(root, () => nightAlive)(id, sb),
    releaseSweep: async (sb) => {
      swept.push(`${path.basename(sb)}:${p.list()[0].status}`);
      return { files: 2, bytes: 3 * 1024 ** 3 };
    },
  });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  root = historyFor(path.join(r.sbRoot, 'sb1'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await p.tick();
  assert.equal(p.liveRunLooks.size, 0, 'an agent lives there: nothing is looked at');
  live = 0; // its idle host closed for a restart on new code (w1166), as 0e4d75cd's at 10:00:56 UTC
  await p.tick();
  assert.equal(p.list()[0].status, 'cleanup', 'warn only: cleanup at once, as before');
  const said = await p.liveRunLooks.get('sb1');
  assert.match(said ?? '', /^WARNING sandbox sb1: Library cache trim \(released\) while a run of its worker still lives there: the nightly run of 2026-11-27 \(request w6357, attempt 2, step run\) runs in it since \d\d:\d\d UTC, pid 58536\. liveRunGuard warn: it goes ahead as before \(w6378\)/);
  assert.ok(logs.includes(said!), 'the line is in the daemon log');
  await until('the trim to end', () => p.list()[0].status === 'ready');
  assert.deepEqual(swept, ['sb1:cleanup'], 'the release sweep ran all the same (warn only)');
  assert.deepEqual(statuses.filter((s) => s.startsWith('sb1:')), ['sb1:creating', 'sb1:ready', 'sb1:cleanup', 'sb1:ready'], 'the same states, in the same order, as with no run there');

  // The night gone (its process ended): the next release says nothing.
  nightAlive = false;
  live = 1;
  await p.tick();
  live = 0;
  await p.tick();
  await until('the second trim to end', () => p.list()[0].status === 'ready' && swept.length === 2);
  assert.equal(await p.liveRunLooks.get('sb1'), undefined, 'no run there: no line');
  assert.equal(logs.filter((l) => l.startsWith('WARNING')).length, 1);
});

test('w6378: a look that fails or never answers holds nothing up: the trim runs and ends, and a failure is said', async (t) => {
  const r = repos();
  t.after(r.cleanup);
  let live = 1;
  const logs: string[] = [];
  let mode: 'throw' | 'hang' = 'throw';
  const { p } = pool(r, {
    liveAgents: () => live,
    log: (l) => logs.push(l),
    liveRun: async () => {
      if (mode === 'throw') throw new Error('holds unreadable');
      return new Promise<string[]>(() => {});
    },
  });
  await p.create({ id: 'sb1', branch: 'sandbox/sb1', base: 'origin/master', seedLibrary: false, startUnity: false });
  await ready(p, 'sb1');
  await p.tick();
  live = 0;
  await p.tick();
  assert.equal(p.list()[0].status, 'cleanup');
  assert.equal(await p.liveRunLooks.get('sb1'), undefined);
  assert.ok(logs.some((l) => /the live-run look before its Library cache trim \(released\) failed \(holds unreadable\); it goes ahead as before/.test(l)), logs.join(' | '));
  await until('the trim to end', () => p.list()[0].status === 'ready');

  mode = 'hang';
  live = 1;
  await p.tick();
  live = 0;
  await p.tick();
  await until('the trim to end with the look still out', () => p.list()[0].status === 'ready' && logs.filter((l) => /Library cache trim \(released\): removed/.test(l)).length === 2);
});

test("w6378: a release or delete of a sandbox with its worker's run there warns, and is done as before", async (t) => {
  const r = repos();
  t.after(r.cleanup);
  const logs: string[] = [];
  const { p } = pool(r, { log: (l) => logs.push(l), liveRun: async (id) => [`the unity-slot run "nightly build" holds 1 Unity slot(s) for it (holder sandbox:${id}, pid 40100)`] });
  for (const id of ['sb1', 'sb2']) {
    await p.create({ id, branch: `sandbox/${id}`, base: 'origin/master', seedLibrary: false, startUnity: false });
    await ready(p, id);
  }
  assert.match(p.release('sb1'), /^Released sandbox sb1/);
  assert.match((await p.liveRunLooks.get('sb1')) ?? '', /^WARNING sandbox sb1: release while a run of its worker still lives there: the unity-slot run "nightly build"/);
  assert.equal(p.list().some((s) => s.id === 'sb1'), false, 'released all the same');
  await p.remove('sb2');
  assert.match((await p.liveRunLooks.get('sb2')) ?? '', /^WARNING sandbox sb2: delete while a run of its worker still lives there/);
  assert.equal(p.list().some((s) => s.id === 'sb2'), false, 'deleted all the same');
});

test('w6378: liveRunGuard is warn unless daemon.json says off; no holders, no line', () => {
  assert.equal(liveRunGuardModeOf(undefined), 'warn');
  assert.equal(liveRunGuardModeOf('warn'), 'warn');
  assert.equal(liveRunGuardModeOf('off'), 'off');
  for (const v of ['on', 'OFF', 'enforce', '', 1]) assert.equal(liveRunGuardModeOf(v), 'warn', `${String(v)}: the default, which changes nothing`);
  assert.equal(liveRunWarning('slot2', 'release', []), undefined);
});

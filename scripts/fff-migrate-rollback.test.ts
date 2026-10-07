// fffctl migrate --cut-over (scripts/fff-migrate.ts, w499) when it cannot finish: the VM's portal does not come up, or
// BEAST's portal is too old to relocate. Linux only, with pwsh; the synthetic BEAST and VM are in fff-migrate.world.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lanIp, migration, skip, world } from './fff-migrate.world.ts';

test('fffctl migrate --cut-over: a portal here that does not come up puts everything back, BEAST\'s task started again', { skip: skip ?? (lanIp() ? undefined : 'no network address'), timeout: 300_000 }, async (t) => {
  const w = await world(t);
  await w.beastPortal.start();
  await w.beastPortal.healthy();
  await w.vmPortal.start();
  await w.vmPortal.healthy();
  const vmCfgBefore = fs.readFileSync(w.vmCfgFile, 'utf8');
  w.sys.answers = ['CUT OVER'];
  // The start after the install does nothing: no portal answers here.
  const realStart = w.sys.startPortal.bind(w.sys);
  let starts = 0;
  w.sys.startPortal = async () => {
    starts++;
    if (starts === 1) return;
    await realStart();
  };
  const m = migration(w, 'cut-over', { healthSeconds: 5 });
  assert.equal(await m.cutOver(), 1);
  const report = m.report.join('\n');
  t.diagnostic(report);
  assert.match(report, /this portal is not healthy within 5 s: rolling back/);
  assert.match(report, /rolled back: this VM's portal has its own data again/);
  assert.deepEqual(fs.readFileSync(path.join(w.base, 'schtasks.log'), 'utf8').trim().split('\n'), ['/Change /TN ffsb-server /DISABLE', '/Change /TN ffsb-server /ENABLE', '/Run /TN ffsb-server']);
  assert.equal(fs.readFileSync(w.vmCfgFile, 'utf8'), vmCfgBefore, "this VM's own config back");
  assert.equal((await w.vmPortal.healthy()).ok, true, 'and its portal up');
  const state = JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'state.json'), 'utf8'));
  assert.ok(!(state.machines ?? []).some((x: { id: string }) => x.id === 'beast'));
});


test('fffctl migrate --cut-over: a BEAST portal too old to relocate is left running, and nothing here changes', { skip: skip ?? (lanIp() ? undefined : 'no network address'), timeout: 300_000 }, async (t) => {
  const w = await world(t);
  await w.beastPortal.start();
  await w.beastPortal.healthy();
  await w.vmPortal.start();
  await w.vmPortal.healthy();
  const vmCfgBefore = fs.readFileSync(w.vmCfgFile, 'utf8');
  fs.writeFileSync(path.join(w.base, 'old-beast'), '');
  w.sys.answers = ['CUT OVER'];
  const m = migration(w, 'cut-over');
  assert.equal(await m.cutOver(), 1);
  const report = m.report.join('\n');
  t.diagnostic(report);
  assert.match(report, /drained but wrote no relocate result: it runs code from before w499 \(2\/3\)/);
  assert.ok(!fs.existsSync(path.join(w.base, 'schtasks.log')), 'its task untouched');
  assert.ok(w.beastPortal.child, "BEAST's portal still runs (held, then on by itself)");
  assert.equal(fs.readFileSync(w.vmCfgFile, 'utf8'), vmCfgBefore);
  assert.equal((await w.vmPortal.healthy()).ok, true, "this VM's portal is up again");
});

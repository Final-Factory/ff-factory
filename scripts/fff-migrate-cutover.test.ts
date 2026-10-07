// fffctl migrate --cut-over (scripts/fff-migrate.ts, w499): BEAST's portal drains and its daemon follows to the VM.
// Linux only, with pwsh; the synthetic BEAST and VM are in fff-migrate.world.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Daemon, type DaemonConfig } from '../machine/daemon.ts';
import { claudeProjectFolder } from '../server/vmMigration.ts';
import { BEAST_TOKEN, FAKE_TOKEN, PROBES, lanIp, migration, skip, treeHash, until, world } from './fff-migrate.world.ts';

test('fffctl migrate --cut-over: BEAST\'s portal drains, sends its daemon here and stops; the copy starts here for real and the daemon says hello', { skip: skip ?? (lanIp() ? undefined : 'no network address for the daemon to dial'), timeout: 300_000 }, async (t) => {
  const w = await world(t);
  await w.beastPortal.start();
  await w.beastPortal.healthy();
  await w.vmPortal.start();
  await w.vmPortal.healthy();
  // BEAST's own daemon, as on BEAST: dialling BEAST's portal at loopback.
  const daemonDir = path.join(w.base, 'daemon');
  fs.mkdirSync(daemonDir);
  const configFile = path.join(daemonDir, 'daemon.json');
  const dc: DaemonConfig = { portalUrl: `http://127.0.0.1:${w.beastPortal.port}`, id: 'beast', token: w.machineToken, repoPath: w.beastBase, appDir: daemonDir, claude: 'no-such-claude', maxSessions: 2, maxEventsFile: null };
  fs.writeFileSync(configFile, JSON.stringify(dc, null, 2));
  const daemon = new Daemon({ ...dc, configFile, agentHosts: false }, undefined, PROBES);
  t.after(() => daemon.shutdown());
  daemon.start();
  await until("the daemon at BEAST's portal", () => /machine beast connected/.test(w.beastPortal.log()));

  // A typed "no" first: nothing on BEAST changes.
  const beastBefore = treeHash(w.beastRoot + '/scripts');
  w.sys.answers = ['no'];
  const no = migration(w, 'cut-over');
  assert.equal(await no.cutOver(), 3);
  assert.match(no.report.join('\n'), /stopped: nothing on BEAST was touched/);
  assert.ok(!fs.existsSync(path.join(w.base, 'schtasks.log')));
  assert.ok(w.beastPortal.child, "BEAST's portal still runs");
  assert.deepEqual(treeHash(w.beastRoot + '/scripts'), beastBefore);

  w.sys.answers = ['CUT OVER'];
  const m = migration(w, 'cut-over');
  const code = await m.cutOver();
  const report = m.report.join('\n');
  t.diagnostic(report);
  assert.equal(code, 0, `${report}\n--- BEAST:\n${w.beastPortal.log().slice(-2000)}\n--- VM:\n${w.vmPortal.log().slice(-2000)}`);
  assert.match(report, /relocated: beast/);
  assert.match(report, /BEAST portal: stopped/);
  assert.match(report, /connected here: beast/);
  // FFBox's link (w537): the exact commands, from BEAST's URL (its config.json's publicUrl) to this portal's.
  assert.ok(report.includes(`its connector still dials http://127.0.0.1:`), report);
  assert.ok(report.includes(`|"url": "${w.publicUrl}"|' ~/.config/ffbox/config.json`), report);
  assert.match(report, /sh scripts\/06-services\.sh --check +# units differ \.\.\.: fffconnector\.service, and no other/);
  assert.match(report, /sudo sh scripts\/06-services\.sh --install/);
  assert.match(report, /sign in, add the phone app again/);
  assert.deepEqual(fs.readFileSync(path.join(w.base, 'schtasks.log'), 'utf8').trim().split('\n'), ['/Change /TN ffsb-server /DISABLE']);
  assert.ok(!w.beastPortal.child, "BEAST's portal stopped");
  assert.deepEqual(w.beastPortal.exits, [0], 'cleanly');
  assert.match(w.beastPortal.log(), /relocate to http:\/\/[\d.]+:\d+: 1 of 1 connected daemon\(s\) took it/);
  // The daemon follows: daemon.json says so, and it is connected here.
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).portalUrl, w.publicUrl);
  assert.match(w.vmPortal.log(), /machine beast connected/);
  const h = await w.vmPortal.healthy();
  assert.equal(h.dryRun, undefined, 'for real');
  const state = JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'state.json'), 'utf8'));
  const beast = state.machines.find((x: { id: string }) => x.id === 'beast');
  assert.equal(beast.host, 'rydin@beast');
  // What BEAST's portal wrote at its stop came over (its resume file); its data is otherwise as it was.
  assert.ok(fs.existsSync(path.join(w.vm, 'migrate')));
  assert.ok(fs.existsSync(path.join(w.vm, 'home', '.claude', 'projects', claudeProjectFolder(w.vmBase), 'sdk-disp-1.jsonl')));
  assert.doesNotMatch(report, new RegExp(`${FAKE_TOKEN}|${BEAST_TOKEN}`));
});

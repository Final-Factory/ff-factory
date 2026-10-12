import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_GUARD_DEFAULTS, hostSoftFreeGB, withDefaults, type Config } from './config.ts';
import { diskLevel } from './hostHealth.ts';
import { normalizeSetting, setAppConfig } from './appConfig.ts';
import { hostHealthLines } from './agents.ts';

/**
 * w1101, lothsahn 2026-10-12: "The portal should be considered to be low below 40GB free, not 120GB. Please update that.
 * And it's not beast anymore, it's a dedicated process.", "Critical level for the portal should be 10GB", then "Let's just
 * set the warning to 20GB both in code and in config." The portal's
 * own host guard (hostGuard.*): its dedicated VM had 90 GB free of 115 GB on 2026-10-12 and must not count as low.
 */

test('the portal is low below 20 GB and critical below 10 GB, and its soft clean-up starts at the low level (w1101)', () => {
  assert.equal(HOST_GUARD_DEFAULTS.warnFreeGB, 20);
  assert.equal(HOST_GUARD_DEFAULTS.criticalFreeGB, 10);
  assert.ok(HOST_GUARD_DEFAULTS.criticalFreeGB < HOST_GUARD_DEFAULTS.warnFreeGB);
  const g = withDefaults({}).hostGuard;
  assert.equal(hostSoftFreeGB(g), 20, 'the soft threshold is the low level, not warn + 40');
  // Today's 90 GB free: fine, and above the soft threshold (no 15-minute passes, server/cleanup.ts "low-space").
  assert.equal(diskLevel(90, 'ok', g), 'ok');
  assert.ok(90 >= hostSoftFreeGB(g));
  assert.equal(diskLevel(19, 'ok', g), 'warn');
  assert.equal(diskLevel(9, 'warn', g), 'critical');
  // A config that sets the levels itself keeps them (the live portal's says 20 and 10): set_app_config changes them.
  assert.equal(withDefaults({ hostGuard: { warnFreeGB: 30, criticalFreeGB: 5 } }).hostGuard.warnFreeGB, 30);
});

test('set_app_config sets the portal\'s levels live, critical always below warn (w1101)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ hostGuard: { warnFreeGB: 20, criticalFreeGB: 10 } }));
  const cfg = withDefaults(JSON.parse(fs.readFileSync(file, 'utf8'))) as Config;
  setAppConfig(file, cfg, 'hostGuard.warnFreeGB', 40);
  setAppConfig(file, cfg, 'hostGuard.criticalFreeGB', 10);
  assert.equal(cfg.hostGuard.warnFreeGB, 40, 'live');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hostGuard, { warnFreeGB: 40, criticalFreeGB: 10 });
  assert.equal(hostSoftFreeGB(cfg.hostGuard), 40);
  assert.throws(() => normalizeSetting('hostGuard.criticalFreeGB', 40, cfg), /must be below hostGuard\.warnFreeGB \(40\)/);
  assert.throws(() => normalizeSetting('hostGuard.warnFreeGB', 10, cfg), /must be above hostGuard\.criticalFreeGB \(10\)/);
  assert.throws(() => normalizeSetting('hostGuard.warnFreeGB', 'lots', cfg), /whole number of GB/);
  // null: back to the default.
  setAppConfig(file, cfg, 'hostGuard.warnFreeGB', null);
  assert.equal(cfg.hostGuard.warnFreeGB, HOST_GUARD_DEFAULTS.warnFreeGB);
});

test("system_status names the portal's levels in effect, so a changed one shows at once (w1101)", () => {
  const h = { level: 'ok', disks: [{ path: '/', freeBytes: 90 * 2 ** 30, level: 'ok' }] } as never;
  assert.match(hostHealthLines(h, withDefaults({}).hostGuard)[0], /^Host guard \(ok; low below 20 GB, critical below 10 GB, soft clean-up below 20 GB\): \/ 90 GB free$/);
});

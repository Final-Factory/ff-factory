import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONF_PORTAL_KEYS, confGet, confSet } from './appConfigCli.ts';
import { autoCompactSettings } from './autoCompact.ts';
import { withDefaults } from './config.ts';

/**
 * w1538: `fffctl conf` reaches the portal's orchestrator.compactIdleSeconds and orchestrator.compactHardAtTokens (lothsahn:
 * "Those two new settings should be something the new setting tool can change"), through set_app_config's own check. A
 * change is what the portal's start then reads (withDefaults, autoCompactSettings); any other key is refused, and no
 * refused value is echoed.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OAT = `sk-ant-oat01-${'A'.repeat(60)}`;

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-confcli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 8787, orchestrator: { compactAtTokens: 80_000 }, providers: { ffbox: { enabled: true, tokenSha256File: '/x' } } }, null, 2) + '\n');
  return { dir, file };
}

/** What the portal's start reads from the file: its orchestrator settings in force. */
const atStart = (file: string) => autoCompactSettings(withDefaults(JSON.parse(fs.readFileSync(file, 'utf8'))));

test('fffctl conf portal keys: exactly the two quiet-compaction settings, with the defaults the compactor uses', () => {
  assert.deepEqual(CONF_PORTAL_KEYS, { 'orchestrator.compactIdleSeconds': 120, 'orchestrator.compactHardAtTokens': 100_000 });
  // fffctl and fff-ops-priv name the same keys.
  const fffctl = fs.readFileSync(path.join(REPO, 'deploy/vm/guest/fffctl'), 'utf8');
  const priv = fs.readFileSync(path.join(REPO, 'deploy/vm/guest/fff-ops-priv'), 'utf8');
  assert.equal(/^CONF_PORTAL_KEYS='([^']+)'$/m.exec(fffctl)?.[1], Object.keys(CONF_PORTAL_KEYS).join(' '));
  assert.equal(/^\s+CONF_PORTAL='([^']+)'$/m.exec(priv)?.[1], Object.keys(CONF_PORTAL_KEYS).join(' '));
});

test('confSet on each setting: one line, old -> new, config.json.prev kept, and the portal reads it at its start', (t) => {
  const { file } = fixture(t);
  const before = fs.readFileSync(file, 'utf8');
  assert.deepEqual(confGet(file), ['orchestrator.compactIdleSeconds=120 (default)', 'orchestrator.compactHardAtTokens=100000 (default)']);
  assert.equal(confSet(file, 'orchestrator.compactIdleSeconds', '90'), `orchestrator.compactIdleSeconds: 120, the default -> 90 (takes effect at the portal's next start (a deploy, or fffctl restart); nothing restarts; the file before is ${file}.prev)`);
  assert.equal(fs.readFileSync(file + '.prev', 'utf8'), before);
  assert.match(confSet(file, 'orchestrator.compactHardAtTokens', '150000'), /^orchestrator.compactHardAtTokens: 100000, the default -> 150000 \(takes effect/);
  assert.deepEqual(atStart(file), { atTokens: 80_000, atTurnUsd: 1, idleSeconds: 90, hardAtTokens: 150_000 });
  assert.deepEqual(confGet(file, 'orchestrator.compactIdleSeconds'), [`orchestrator.compactIdleSeconds=90 (set in ${file})`]);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.providers, { ffbox: { enabled: true, tokenSha256File: '/x' } }, 'the rest kept');
  // The same value: nothing written. '' or default: back to the default.
  const now = fs.readFileSync(file, 'utf8');
  assert.equal(confSet(file, 'orchestrator.compactIdleSeconds', '90'), 'orchestrator.compactIdleSeconds: no change (90)');
  assert.equal(fs.readFileSync(file, 'utf8'), now);
  assert.match(confSet(file, 'orchestrator.compactIdleSeconds', ''), /^orchestrator.compactIdleSeconds: 90 -> 120, the default \(takes effect/);
  assert.match(confSet(file, 'orchestrator.compactHardAtTokens', 'default'), /^orchestrator.compactHardAtTokens: 150000 -> 100000, the default/);
  assert.equal(confSet(file, 'orchestrator.compactHardAtTokens', ''), 'orchestrator.compactHardAtTokens: no change (100000, the default)');
  assert.deepEqual(atStart(file), { atTokens: 80_000, atTurnUsd: 1, idleSeconds: 120, hardAtTokens: 100_000 });
});

test('confSet refuses any other key and a value set_app_config refuses, writes nothing and echoes no value', (t) => {
  const { file } = fixture(t);
  const before = fs.readFileSync(file, 'utf8');
  for (const [key, value] of [['providers.ffbox.token', OAT], ['ownerName', 'x'], ['orchestrator.compactAtTokens', '90000'], ['FFF_ROOT', '/tmp'], [OAT, '1']]) {
    assert.throws(() => confSet(file, key, value), (e: Error) => /is not a portal setting fffctl conf may read or change/.test(e.message) && !e.message.includes(OAT), `${key.slice(0, 30)}`);
  }
  assert.throws(() => confGet(file, 'providers.ffbox.token'), /not a portal setting/);
  for (const value of ['3601', '-1', '1.5', 'soon', OAT]) {
    assert.throws(() => confSet(file, 'orchestrator.compactIdleSeconds', value), (e: Error) => /whole number of seconds up to 3,600 \(nothing changed\)/.test(e.message) && !e.message.includes(OAT), value.slice(0, 20));
  }
  assert.throws(() => confSet(file, 'orchestrator.compactHardAtTokens', '49999'), /from 50,000 to 900,000 \(nothing changed\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written');
  assert.equal(fs.existsSync(file + '.prev'), false);
});

// The whole path, as the orchestration worker runs it: fffctl conf (FFF_TEST_NOROOT: no root, no runuser) into this
// checkout's server/appConfigCli.ts. POSIX only: fffctl is the Linux VM's.
test('fffctl conf get and set on each portal setting take effect in config.json, and other keys still go to fff.conf', { skip: process.platform === 'win32' && "fffctl is the Linux VM's" }, (t) => {
  const { dir, file } = fixture(t);
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.renameSync(file, path.join(root, 'config', 'config.json'));
  const cfg = path.join(root, 'config', 'config.json');
  fs.symlinkSync(REPO, path.join(root, 'app', 'current'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'logger'), `#!/bin/sh\necho "$*" >>"${dir}/logger"\n`, { mode: 0o755 });
  const conf = path.join(dir, 'fff.conf');
  fs.writeFileSync(conf, `FFF_ROOT=${root}\nHEALTH_START_GRACE_SEC=120\n`);
  const ctl = (...args: string[]) => {
    const r = spawnSync('bash', [path.join(REPO, 'deploy/vm/guest/fffctl'), 'conf', ...args], {
      encoding: 'utf8',
      env: { ...process.env, FFF_TEST_NOROOT: '1', FFF_LIB: path.join(REPO, 'deploy/vm/guest'), FFF_CONF: conf, FFF_PATH_PREFIX: `${bin}:${path.dirname(process.execPath)}`, NODE_NO_WARNINGS: '1' },
    });
    return { code: r.status, out: (r.stdout + r.stderr).trim() };
  };
  assert.deepEqual(ctl('get', 'orchestrator.compactIdleSeconds'), { code: 0, out: 'orchestrator.compactIdleSeconds=120 (default)' });
  const idle = ctl('set', 'orchestrator.compactIdleSeconds', '90');
  assert.equal(idle.code, 0, idle.out);
  assert.match(idle.out, /^orchestrator.compactIdleSeconds: 120, the default -> 90 \(takes effect at the portal's next start/);
  assert.equal(idle.out.split('\n').length, 1, 'only the setting that changed');
  const hard = ctl('set', 'orchestrator.compactHardAtTokens', '150000');
  assert.equal(hard.code, 0, hard.out);
  assert.match(hard.out, /^orchestrator.compactHardAtTokens: 100000, the default -> 150000 \(takes effect/);
  assert.deepEqual(atStart(cfg), { atTokens: 80_000, atTurnUsd: 1, idleSeconds: 90, hardAtTokens: 150_000 }, "what the portal's start reads");
  const got = ctl('get', 'orchestrator.compactHardAtTokens');
  assert.equal(got.code, 0, got.out);
  assert.match(got.out, /^orchestrator.compactHardAtTokens=150000 \(set in \S+config\.json\)$/);
  // Refused: a bad value, nothing written, no value echoed.
  const before = fs.readFileSync(cfg, 'utf8');
  const bad = ctl('set', 'orchestrator.compactIdleSeconds', OAT);
  assert.equal(bad.code, 1, bad.out);
  assert.ok(!bad.out.includes(OAT), bad.out);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before);
  // fff.conf's own settings are untouched by this and still go to fff.conf.
  assert.match(ctl('set', 'HEALTH_START_GRACE_SEC', '300').out, /^HEALTH_START_GRACE_SEC: 120 -> 300/);
  assert.match(fs.readFileSync(conf, 'utf8'), /^HEALTH_START_GRACE_SEC=300$/m);
  assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).HEALTH_START_GRACE_SEC, undefined);
  assert.ok(!fs.readFileSync(path.join(dir, 'logger'), 'utf8').includes(OAT), 'no secret logged');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { daemonJson, instanceOptions, layoutOf, manifestFor, parseArgs, type InstallOptions } from './worker/worker.ts';

const WR = path.win32.join('F:/', 'ffw', 'lens-factory', 'root');
const BASE = { root: WR, portalUrl: 'http://127.0.0.1:8892', maxSandboxes: 2, maxAgentsPerSandbox: 2, maxUnity: 0, token: 'x', repoUrl: 'x', service: 'FFFactoryDaemon', firewall: false } as InstallOptions;

test('install --instance: its own service, firewall groups, slots mailbox and Claude folder; cleans nothing; no ssh', () => {
  const w = instanceOptions('lens', WR, {}, 'win32');
  assert.deepEqual(w, {
    instance: 'lens',
    service: 'FFFactoryDaemon-lens',
    firewallSuffix: 'lens',
    unitySlotsDir: path.win32.join(WR, 'unity-slots'),
    noCleanup: true,
    ssh: false,
    env: { CLAUDE_CONFIG_DIR: path.win32.join(WR, 'claude') },
  });
  const m = instanceOptions('light-tree', '/Users/b/ben-factory/root', {}, 'darwin');
  assert.equal(m.service, 'com.fffactory.daemon.light-tree');
  assert.equal(m.env?.CLAUDE_CONFIG_DIR, '/Users/b/ben-factory/root/claude');
});

test('install --instance: what the command line sets wins', () => {
  const { opts } = parseArgs(['install', '--instance', 'lens', '--service', 'com.bryding.lensscout.daemon', '--claude-config-dir', '/Users/b/lens-factory/claude-worker', '--firewall-suffix', 'LS']);
  const o = instanceOptions(opts.instance, '/Users/b/lens-factory/root', opts, 'darwin');
  assert.equal(o.service, 'com.bryding.lensscout.daemon');
  assert.equal(o.firewallSuffix, 'LS');
  assert.deepEqual(o.env, { CLAUDE_CONFIG_DIR: '/Users/b/lens-factory/claude-worker' });
});

test('install --instance: a name is short, lower case', () => {
  for (const bad of ['', 'Lens', 'lens scout', '-x', 'a'.repeat(40)]) assert.throws(() => instanceOptions(bad, WR, {}, 'win32'), /--instance/, bad);
});

test('install --instance: root.json keeps the instance across updates; daemon.json carries its env', () => {
  const root = path.join(os.tmpdir(), `ffw-inst-${process.pid}`);
  const o = { ...BASE, root, ...instanceOptions('lens', root, {}, 'win32') };
  const m = manifestFor(undefined, o, 'beast', root, '2026-11-14T20:00:00Z', 'win32');
  assert.equal(m.instance, 'lens');
  assert.equal(m.service, 'FFFactoryDaemon-lens');
  assert.equal(m.firewallSuffix, 'lens');
  // An update passes the options it re-derives (no instance): the record keeps it.
  assert.equal(manifestFor(m, { ...BASE, service: m.service }, 'beast', root, '2026-11-15T00:00:00Z', 'win32').instance, 'lens');
  const j = daemonJson(o, layoutOf(root), 'beast', undefined);
  assert.deepEqual(j.env, { CLAUDE_CONFIG_DIR: path.win32.join(root, 'claude') });
  assert.equal(j.leftovers, false);
  assert.equal(j.tray, false);
  // An update keeps the env daemon.json already has (it carries the old file).
  assert.deepEqual(daemonJson({ ...BASE, root, carry: { env: { CLAUDE_CONFIG_DIR: 'X' } } }, layoutOf(root), 'beast', undefined).env, { CLAUDE_CONFIG_DIR: 'X' });
});

test('install without --instance: daemon.json and root.json have no instance fields', () => {
  const root = path.join(os.tmpdir(), `ffw-plain-${process.pid}`);
  const j = daemonJson({ ...BASE, root }, layoutOf(root), 'beast', undefined);
  assert.equal('env' in j, false);
  assert.equal('instance' in manifestFor(undefined, BASE, 'beast', root, '2026-11-14T20:00:00Z', 'win32'), false);
});

// w6287: an agent host keeps the environment it was launched with (w1745), so a sharedLock switch (off -> warn, a daemon
// restart that adopts the running hosts, w605) left worker 95c5d71d on LothDesktop (2026-11-27 03:53Z) with the off
// environment: FF_PLAYER_BROKER unset and UV_CACHE_DIR / npm_config_cache on the shared V:\ffw\cache, not slot2's clones.
// These tests stand a host in with its files only (no process), as hostCreds.test.ts does: the host records the shared-lock
// environment it started on (lockenv.sha), and an idle agent whose host started on another one is restaged between turns
// (hostRestage "on") or only logged (the default, warn), so its next turn runs in a new host on the new mode's environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { HostedSession, hostFiles, lockEnvOf, restageModeOf, type HostDeps, type HostStart, type RestageMode } from '../machine/agentHost.ts';
import type { SessionInfo } from '../shared/types.ts';

const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const info = (id: string, status: SessionInfo['status'] = 'idle'): SessionInfo => ({ id, kind: 'worker', title: `w6287 ${id}`, status, permissionMode: 'default', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), turns: 1, costUsd: 0, pendingPermissions: [] });

/** The off mode's run environment, and the warn mode's: slot2's clones and the broker (Daemon.lockEnvFor). */
const SHARED = { UV_CACHE_DIR: 'V:\\ffw\\cache\\uv', npm_config_cache: 'V:\\ffw\\cache\\npm' };
const WARN = { UV_CACHE_DIR: 'V:\\ffw\\cache\\slots\\slot2\\uv', npm_config_cache: 'V:\\ffw\\cache\\slots\\slot2\\npm', FF_DETERMINISM_AUDIT_DIR: 'V:\\ffw\\cache\\slots\\slot2\\audit', FF_PLAYER_BROKER: '1' };

function rig(id: string, mode: RestageMode | undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w6287-restage-'));
  let lock: Record<string, string> = {};
  const launched: HostStart[] = [];
  const logs: string[] = [];
  const deps: HostDeps = {
    root,
    out: () => undefined,
    events: new EventEmitter(),
    handlers: () => ({}),
    // As runSpec builds it: the shared caches, overridden by the shared lock's own variables.
    spec: () => ({ cwd: root, sandbox: 'slot2', env: { GH_TOKEN: 'fake-gh-token', ...SHARED, ...lock } }) as never,
    lockEnv: () => lock,
    ...(mode ? { restageMode: () => mode } : {}),
    editorUp: () => undefined,
    changed: () => undefined,
    log: (l) => logs.push(l),
    launch: (_dir, start) => {
      launched.push(start);
      return 0;
    },
  };
  const s = new HostedSession(info(id), 0, deps);
  const f = hostFiles(path.join(root, id));
  const commands = () => (fs.existsSync(f.in) ? fs.readFileSync(f.in, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { op: string; text?: string; n: number }) : []);
  const hostSays = (m: object) => fs.appendFileSync(f.out, JSON.stringify(m) + '\n');
  /** The daemon restarted with sharedLock warn: what its runs get from now on. */
  const switchToWarn = () => (lock = { ...WARN });
  return { root, s, f, launched, logs, commands, hostSays, switchToWarn };
}

/** The host's agent reports a state, as its host's out.jsonl line does; the daemon's poll reads it. */
const say = async (r: ReturnType<typeof rig>, status: SessionInfo['status'], live: boolean, id: string) => {
  const before = r.commands().length;
  r.hostSays({ op: 'state', info: info(id, status), live, lastFrom: 'system' });
  await until(`the session reads ${status}`, () => r.s.info.status === status && r.s.live === live);
  // The same status as before reads at once: a few of the daemon's polls (100 ms) so this line is read too.
  await new Promise((res) => setTimeout(res, 400));
  return before;
};

test('w6287: a host records the shared-lock environment it started on, as a hash', { timeout: 30_000 }, async (t) => {
  const r = rig('h0', 'on');
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.s.send('first turn', 'system');
  assert.equal(fs.readFileSync(r.f.lockEnv, 'utf8'), lockEnvOf({}));
  assert.notEqual(lockEnvOf({}), lockEnvOf(WARN));
  assert.equal(lockEnvOf({ b: '2', a: '1' }), lockEnvOf({ a: '1', b: '2' }), 'the order of the variables does not count');
  assert.equal(restageModeOf(undefined), 'warn');
  assert.equal(restageModeOf('enforce'), 'warn');
  assert.equal(restageModeOf('on'), 'on');
});

test('w6287: hostRestage on: after a switch an idle agent is restaged, never mid-turn, and its next turn runs in a new host on the new mode', { timeout: 30_000 }, async (t) => {
  const r = rig('h1', 'on');
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.s.send('first turn', 'system');
  assert.equal(r.launched.length, 1);
  assert.equal(r.launched[0].spec.env?.UV_CACHE_DIR, SHARED.UV_CACHE_DIR);
  assert.equal(r.launched[0].spec.env?.FF_PLAYER_BROKER, undefined);
  // The same mode: its turns end and nothing is restaged.
  await say(r, 'idle', true, 'h1');
  assert.deepEqual(r.commands().map((c) => c.op), ['send']);
  // The switch lands mid-turn (95c5d71d was running): nothing is sent while the turn runs.
  await say(r, 'running', true, 'h1');
  r.switchToWarn();
  await say(r, 'running', true, 'h1');
  assert.deepEqual(r.commands().map((c) => c.op), ['send'], 'never a restage mid-turn');
  // Its turn ends: the host is told to restage, once.
  await say(r, 'idle', true, 'h1');
  assert.deepEqual(r.commands().map((c) => c.op), ['send', 'restage']);
  await say(r, 'idle', true, 'h1');
  assert.deepEqual(r.commands().map((c) => c.op), ['send', 'restage'], 'asked once per idle stretch');
  assert.ok(r.logs.some((l) => /h1: .*another shared-lock environment.*ends now/.test(l)), r.logs.join('\n'));
  // The host stopped the agent and closed; the next message starts a new host on the warn environment.
  await say(r, 'stopped', false, 'h1');
  r.hostSays({ op: 'closed', consumed: 2 });
  await until('the old host is gone', () => !r.s.live && r.commands().length === 0);
  r.s.send('next turn', 'system');
  await until('a new host started', () => r.launched.length === 2);
  const env = r.launched[1].spec.env ?? {};
  assert.equal(env.UV_CACHE_DIR, WARN.UV_CACHE_DIR);
  assert.equal(env.npm_config_cache, WARN.npm_config_cache);
  assert.equal(env.FF_PLAYER_BROKER, '1');
  assert.equal(r.launched[1].info.id, 'h1', 'the same session (its conversation goes on)');
  assert.equal(fs.readFileSync(r.f.lockEnv, 'utf8'), lockEnvOf(WARN));
  // On the new mode it is left alone.
  await say(r, 'idle', true, 'h1');
  assert.deepEqual(r.commands().map((c) => c.op), ['send']);
});

test('w6287: a restage the host skipped (a turn had started) is asked again at the next turn end', { timeout: 30_000 }, async (t) => {
  const r = rig('h2', 'on');
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.s.send('first turn', 'system');
  await say(r, 'idle', true, 'h2');
  r.switchToWarn();
  await say(r, 'idle', true, 'h2');
  assert.deepEqual(r.commands().map((c) => c.op), ['send', 'restage']);
  // A message the host read before the restage started a turn: the host skipped it.
  await say(r, 'running', true, 'h2');
  await say(r, 'idle', true, 'h2');
  assert.deepEqual(r.commands().map((c) => c.op), ['send', 'restage', 'restage']);
});

test('w6287: hostRestage warn (the default) only logs an agent on the old environment, once, and never stops it', { timeout: 30_000 }, async (t) => {
  const r = rig('h3', undefined);
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.s.send('first turn', 'system');
  r.switchToWarn();
  await say(r, 'idle', true, 'h3');
  await say(r, 'running', true, 'h3');
  await say(r, 'idle', true, 'h3');
  assert.deepEqual(r.commands().map((c) => c.op), ['send']);
  const lines = r.logs.filter((l) => /h3: .*hostRestage warn/.test(l));
  assert.equal(lines.length, 1, `one line per host, never a stop:\n${r.logs.join('\n')}`);
});

test('w6287: a host from before w6287 (no lockenv.sha) is left alone', { timeout: 30_000 }, async (t) => {
  const r = rig('h4', 'on');
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.s.send('first turn', 'system');
  fs.rmSync(r.f.lockEnv);
  r.switchToWarn();
  await say(r, 'idle', true, 'h4');
  assert.deepEqual(r.commands().map((c) => c.op), ['send']);
});

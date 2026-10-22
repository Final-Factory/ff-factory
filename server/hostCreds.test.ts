// w1745: an agent host keeps the environment it was launched with. On 2026-10-22 worker 568cd4d4 hit vault-ben-1's weekly
// limit; the portal moved it to another token of its pool (the process was stopped, the next message built a run on the new
// token), yet its daemon handed that message to the agent host that was still closing, which started the agent again
// inside itself on vault-ben-1, and the turn ended on "You've hit your weekly limit" straight away. These tests stand a
// host in with its files only (no process): what the daemon writes to in.jsonl and when it launches a new host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { HostedSession, credsOf, hostFiles, type HostDeps, type HostStart } from '../machine/agentHost.ts';
import type { SessionInfo } from '../shared/types.ts';

const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const info = (id: string): SessionInfo => ({ id, kind: 'worker', title: `w1745 ${id}`, status: 'idle', permissionMode: 'default', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), turns: 1, costUsd: 0, pendingPermissions: [] });

/** Fake tokens only. */
const TOKEN_OUT = 'fake-oauth-token-out-0001';
const TOKEN_ROOM = 'fake-oauth-token-room-0002';

function rig(id: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w1745-creds-'));
  let env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_OUT, GH_TOKEN: 'fake-gh-token' };
  const launched: HostStart[] = [];
  const deps: HostDeps = {
    root,
    out: () => undefined,
    events: new EventEmitter(),
    handlers: () => ({}),
    spec: () => ({ cwd: root, env }) as never,
    editorUp: () => undefined,
    changed: () => undefined,
    log: () => undefined,
    // No process: a pid nothing runs as, so its end is immediate and only its folder goes.
    launch: (_dir, start) => {
      launched.push(start);
      return 0;
    },
  };
  const s = new HostedSession(info(id), 0, deps);
  const f = hostFiles(path.join(root, id));
  const commands = () => (fs.existsSync(f.in) ? fs.readFileSync(f.in, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { op: string; text?: string; n: number }) : []);
  /** The host writes a line, as the real one does to out.jsonl. */
  const hostSays = (m: object) => fs.appendFileSync(f.out, JSON.stringify(m) + '\n');
  return { root, s, f, launched, commands, hostSays, setToken: (t: string) => (env = { ...env, CLAUDE_CODE_OAUTH_TOKEN: t }) };
}

test('w1745: a message for another token while the host is closing starts a new host on that token, never the agent again in the old one', { timeout: 30_000 }, async (t) => {
  const r = rig('m1');
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.s.send('first turn', 'system');
  assert.equal(r.launched.length, 1);
  assert.equal(r.launched[0].spec.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN_OUT);
  assert.equal(fs.readFileSync(r.f.creds, 'utf8'), credsOf({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_OUT, GH_TOKEN: 'fake-gh-token' }));
  assert.ok(!fs.readFileSync(r.f.creds, 'utf8').includes(TOKEN_OUT), 'the host folder keeps a hash, never the token');
  // The turn ended on the limit and the portal stopped the process: the host says its agent is not live, and is closing.
  r.hostSays({ op: 'state', info: { ...info('m1'), status: 'stopped' }, live: false, lastFrom: 'system' });
  await until('the session reads not live', () => !r.s.live);
  // The portal built the next run on a token with room: that message must not reach the old host.
  r.setToken(TOKEN_ROOM);
  r.s.send('resumed on a token with room', 'system');
  const after = r.commands();
  assert.deepEqual(after.map((c) => c.op), ['send', 'stop'], 'the old host gets a stop, not the message');
  assert.equal(r.launched.length, 1, 'no new host while the old one still runs');
  // A second message meanwhile waits behind the first, in order.
  r.s.send('and another', 'system');
  assert.deepEqual(r.commands().map((c) => c.op), ['send', 'stop']);
  // The old host closes (it carried out the first turn and the stop): a new host starts on the new token with both messages.
  r.hostSays({ op: 'closed', consumed: 2 });
  await until('a new host started', () => r.launched.length === 2);
  assert.equal(r.launched[1].spec.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN_ROOM);
  assert.deepEqual(r.commands().filter((c) => c.op === 'send').map((c) => c.text), ['resumed on a token with room', 'and another']);
  assert.equal(fs.readFileSync(r.f.creds, 'utf8'), credsOf({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_ROOM, GH_TOKEN: 'fake-gh-token' }));
});

test('w1745: the same token keeps today\'s path: a message while the host closes goes to it (its close hands any it did not carry out to a new host)', { timeout: 30_000 }, async (t) => {
  const r = rig('m2');
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.s.send('first turn', 'system');
  r.hostSays({ op: 'state', info: { ...info('m2'), status: 'idle' }, live: false, lastFrom: 'system' });
  await until('the session reads not live', () => !r.s.live);
  r.s.send('next turn', 'system');
  assert.deepEqual(r.commands().map((c) => c.op), ['send', 'send']);
  assert.equal(r.launched.length, 1);
});

test('w1745: a host an older daemon started (no creds.sha), taken back across the update, gets no message once its agent ended: a new host on the new token carries it', { timeout: 30_000 }, async (t) => {
  // Worker 9888f324 on Biscuit, 2026-10-22: its host predated the daemon fix, so its credentials were unknown, and at
  // 19:10:37Z the resume went into it and ran on vault-ben-1 again. A process stands in for the old host (alive, its own pid).
  const r = rig('m4');
  const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => {
    old.kill();
    fs.rmSync(r.root, { recursive: true, force: true });
  });
  fs.mkdirSync(r.f.dir, { recursive: true });
  fs.writeFileSync(r.f.host, JSON.stringify({ hostProtocol: 1, sessionId: 'm4', pid: old.pid, startedAt: new Date().toISOString() }));
  fs.writeFileSync(r.f.beat, '');
  fs.writeFileSync(r.f.state, JSON.stringify({ op: 'state', info: { ...info('m4'), status: 'stopped' }, live: false, lastFrom: 'system' }));
  assert.ok(!fs.existsSync(r.f.creds), 'an older daemon wrote no creds.sha');
  assert.equal(r.s.adopt(), true);
  assert.equal(r.s.live, false, 'its agent has ended (the portal stopped it to move it)');
  r.setToken(TOKEN_ROOM);
  r.s.send('resumed on a token with room', 'system');
  assert.deepEqual(r.commands().map((c) => c.op), ['attach', 'stop'], 'the old host gets a stop, not the message');
  assert.equal(r.launched.length, 0);
  r.hostSays({ op: 'closed', consumed: r.commands().length });
  await until('a new host started', () => r.launched.length === 1);
  assert.equal(r.launched[0].spec.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN_ROOM);
  assert.deepEqual(r.commands().filter((c) => c.op === 'send').map((c) => c.text), ['resumed on a token with room']);
});

test('w1745: a message the old host did not carry out goes to the new host ahead of one sent after the stop',{ timeout: 30_000 }, async (t) => {
  const r = rig('m3');
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.s.send('first turn', 'system');
  // A message reached the old host while its agent ran; then its agent ended and the run moved to another token.
  r.s.send('sent before the move', 'system');
  r.hostSays({ op: 'state', info: { ...info('m3'), status: 'stopped' }, live: false, lastFrom: 'system' });
  await until('the session reads not live', () => !r.s.live);
  r.setToken(TOKEN_ROOM);
  r.s.send('sent after the move', 'system');
  // The old host carried out only the first turn.
  r.hostSays({ op: 'closed', consumed: 1 });
  await until('a new host started', () => r.launched.length === 2);
  assert.equal(r.launched[1].spec.env?.CLAUDE_CODE_OAUTH_TOKEN, TOKEN_ROOM);
  assert.deepEqual(r.commands().filter((c) => c.op === 'send').map((c) => c.text), ['sent before the move', 'sent after the move']);
});

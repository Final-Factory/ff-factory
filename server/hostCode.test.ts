// w2625: an agent host keeps the FF Factory code it loaded and the launch spec it started with (w605: it outlives daemon
// updates). On 2026-10-30 w2618's worker bcd8d4e5 on beast had a host started at 19:51:45 MDT, during the daemon update
// (done 19:52:09), on the code from before PR #773; at 19:54:19 the portal stopped its process to start it again on the new
// code (w1166), and the daemon handed the next message to the old host, still closing, which started the agent again
// inside itself: the tool the update added stayed missing. These tests stand an adopted host in with its files and a
// process of its own (as hostCreds.test.ts does for w1745) and read what the daemon writes to in.jsonl and when it
// launches a new host. The whole race with real daemon and host processes: agentHost.test.ts, "w2625".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { HostedSession, LOADED_CODE, credsOf, hostFiles, toolsOf, type HostDeps, type HostRecord, type HostStart } from '../machine/agentHost.ts';
import type { LaunchSpec } from './launch.ts';
import type { SessionInfo } from '../shared/types.ts';

const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const info = (id: string): SessionInfo => ({ id, kind: 'worker', title: `w2625 ${id}`, status: 'idle', permissionMode: 'default', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), turns: 1, costUsd: 0, pendingPermissions: [] }) as SessionInfo;

const ENV = { CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token-0001', GH_TOKEN: 'fake-gh-token' };
const OLD_TOOLS: NonNullable<LaunchSpec['mcp']> = { server: 'machine', tools: [{ name: 'wake_me', description: 'Come back later.' }] };
const NEW_TOOLS: NonNullable<LaunchSpec['mcp']> = { server: 'machine', tools: [...OLD_TOOLS.tools, { name: 'list_ffbox_files', description: 'Bug threads too.' }] };

/**
 * A host the daemon before this one started, whose agent has ended (the portal stopped it to start it again on the new
 * code), adopted by this daemon. `host` is what its host.json says beside its pid; the run now has `mcp`.
 */
function adopted(t: { after: (fn: () => void) => void }, id: string, host: Partial<HostRecord>, mcp: LaunchSpec['mcp']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w2625-code-'));
  const launched: HostStart[] = [];
  const deps: HostDeps = {
    root,
    out: () => undefined,
    events: new EventEmitter(),
    handlers: () => ({}),
    spec: () => ({ cwd: root, env: ENV, mcp }) as never,
    editorUp: () => undefined,
    changed: () => undefined,
    log: () => undefined,
    // No process for a new host: a pid nothing runs as.
    launch: (_dir, start) => {
      launched.push(start);
      return 0;
    },
  };
  const s = new HostedSession(info(id), 0, deps);
  const f = hostFiles(path.join(root, id));
  const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => {
    old.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(f.host, JSON.stringify({ hostProtocol: 1, sessionId: id, pid: old.pid, startedAt: new Date().toISOString(), ...host }));
  fs.writeFileSync(f.beat, '');
  fs.writeFileSync(f.creds, credsOf(ENV));
  fs.writeFileSync(f.state, JSON.stringify({ op: 'state', info: { ...info(id), status: 'stopped' }, live: false, lastFrom: 'system' }));
  assert.equal(s.adopt(), true);
  assert.equal(s.live, false, 'its agent has ended');
  const commands = () => fs.readFileSync(f.in, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { op: string; text?: string });
  const hostSays = (m: object) => fs.appendFileSync(f.out, JSON.stringify(m) + '\n');
  return { s, launched, commands, hostSays };
}

/** The old host gets a stop, not the message; once it has closed, a new host starts from the run now with the message. */
async function startsANewHost(r: ReturnType<typeof adopted>, mcp: LaunchSpec['mcp']) {
  r.s.send('#tools', 'system');
  assert.deepEqual(r.commands().map((c) => c.op), ['attach', 'stop'], 'the old host gets a stop, not the message');
  assert.equal(r.launched.length, 0, 'no new host while the old one still runs');
  r.hostSays({ op: 'closed', consumed: r.commands().length });
  await until('a new host started', () => r.launched.length === 1);
  assert.deepEqual(r.launched[0].spec.mcp, mcp);
  assert.deepEqual(r.commands().filter((c) => c.op === 'send').map((c) => c.text), ['#tools']);
}

test('w2625: a host on other FF Factory code, adopted across the update, gets no message once its agent ended: a new host on the new code carries it', { timeout: 30_000 }, async (t) => {
  const r = adopted(t, 'c1', { code: `${LOADED_CODE}0ld`, tools: toolsOf({ mcp: NEW_TOOLS }) }, NEW_TOOLS);
  await startsANewHost(r, NEW_TOOLS);
});

test('w2625: a host serving another tool list (the spec it started with lacked a tool) gets no message once its agent ended: a new host serves the tool', { timeout: 30_000 }, async (t) => {
  const r = adopted(t, 'c2', { code: LOADED_CODE, tools: toolsOf({ mcp: OLD_TOOLS }) }, NEW_TOOLS);
  await startsANewHost(r, NEW_TOOLS);
});

test('w2625: a host from before w2625 (its host.json says neither code nor tools) counts as other code: a new host carries the message', { timeout: 30_000 }, async (t) => {
  // bcd8d4e5's host on beast itself: started by the daemon before this fix, so it recorded neither.
  const r = adopted(t, 'c3', {}, NEW_TOOLS);
  await startsANewHost(r, NEW_TOOLS);
});

test("w2625: the same code, tools and credentials keep today's path: the message goes to the closing host", { timeout: 30_000 }, async (t) => {
  const r = adopted(t, 'c4', { code: LOADED_CODE, tools: toolsOf({ mcp: NEW_TOOLS }) }, NEW_TOOLS);
  r.s.send('#tools', 'system');
  assert.deepEqual(r.commands().map((c) => c.op), ['attach', 'send']);
  assert.equal(r.launched.length, 0);
});

test('w2625: toolsOf is the tools a host serves: a tool its code does not know is left out, as buildOptions does, and order does not count', () => {
  const unknown = { server: 'machine', tools: [...OLD_TOOLS.tools, { name: 'no_such_tool', description: 'x' }] } as never;
  assert.equal(toolsOf({ mcp: unknown }), toolsOf({ mcp: OLD_TOOLS }));
  assert.equal(toolsOf({ mcp: { server: 'machine', tools: [...NEW_TOOLS.tools].reverse() } }), toolsOf({ mcp: NEW_TOOLS }));
  assert.notEqual(toolsOf({ mcp: OLD_TOOLS }), toolsOf({ mcp: NEW_TOOLS }));
  assert.notEqual(toolsOf({ mcp: { server: 'machine', tools: [{ name: 'wake_me', description: 'Another description.' }] } }), toolsOf({ mcp: OLD_TOOLS }), 'a changed description is another tool list');
});

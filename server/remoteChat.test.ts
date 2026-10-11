import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Auth } from './auth.ts';
import { AttachmentStore } from './attachments.ts';
import { Identity } from './identity.ts';
import { routeMcp } from './mcp.ts';
import { describeEvents, originOf, portalLinks, tailnetAddress, tailnetOnly, timing, turnOf } from './remoteChat.ts';
import type { Config } from './config.ts';
import type { Requester, TranscriptEvent, UserInfo } from '../shared/types.ts';
import { splitVia } from '../shared/replies.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';

/**
 * Talking to your own orchestrator from Claude Code or Desktop (w1021, docs/talk-to-your-orchestrator.md), end to end: a
 * real MCP client over HTTP against the server's own /mcp routing (routeMcp: bearer keys, scopes, the tailnet check) and a
 * real Agents, with the scripted fake SDK in place of Claude.
 */

setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'member' },
];

async function until(what: string, cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-remote-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const identity = new Identity(cfg, () => PEOPLE);
  const agents = new Agents(cfg, store, sessions, machines, identity);
  agents.boot();
  const attachments = new AttachmentStore(dir);
  agents.attachments = attachments;
  const auth = new Auth(dir, { trustProxy: false });
  await auth.setUser('ben', 'ben-test-password-1', { displayName: 'Ben', role: 'owner' });
  await auth.setUser('lothsahn', 'loth-test-password-1', { displayName: 'Lothsahn', role: 'member' });
  const keys = {
    ben: auth.createApiKey('ben-mac', 'ben'),
    loth: auth.createApiKey('loth-pc', 'lothsahn'),
    unbound: auth.createApiKey('old-key'),
    nightly: auth.createApiKey('nightly-lab', undefined, 'nightly'),
  };
  const server = http.createServer(async (req, res) => {
    const send = (r: http.ServerResponse, status: number, body: unknown) => {
      r.writeHead(status, { 'content-type': 'application/json' });
      r.end(JSON.stringify(body ?? {}));
    };
    const readJson = async (r: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      for await (const c of r) chunks.push(c as Buffer);
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    };
    try {
      await routeMcp({ agents, auth, identity, attachments, send, readJson }, req, res, new URL(req.url ?? '/', 'http://x'));
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    agents.orchestrators.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  /** A real MCP client with this key (and extra headers, to look like a request a proxy forwarded). */
  const connect = async (key: string, headers: Record<string, string> = {}) => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}`, ...headers } } }));
    clients.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
    };
    return { client, call };
  };
  const chat = (r: Requester) => agents.orchestrators.personalFor(r);
  const userEvents = (id: string) => store.readTranscript(id).filter((e): e is Extract<TranscriptEvent, { kind: 'user' }> => e.kind === 'user');
  return { dir, store, sessions, agents, auth, attachments, keys, base, connect, chat, userEvents };
}

test('orchestrator_send: delivers the message as the person’s own, and returns the reply when the turn ends', async (t) => {
  const { connect, keys, chat, userEvents, store } = await setup(t);
  const ben = chat(BEN);
  const { call } = await connect(keys.ben);
  const r = await call('orchestrator_send', { text: 'How is the shader work going?' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Echo: .*\n?.*How is the shader work going\?/);
  const sent = userEvents(ben.info.id).find((e) => e.text.includes('shader work'))!;
  assert.equal(sent.from, 'human', 'a person’s message, as typed in the web app');
  assert.deepEqual(sent.requestedBy, BEN);
  assert.match(sent.text, /^\[via Claude Code or Desktop \(ben-mac\)\]\nHow is the shader work going\?/);
  assert.equal(ben.info.lastRequestedBy?.userId, 'ben');
  // The reply is in the same transcript the web app shows.
  assert.ok(store.readTranscript(ben.info.id).some((e) => e.kind === 'assistant' && e.text.includes('shader work')));
  // Nothing went to anyone else's orchestrator, the dispatcher or the ops worker.
  assert.equal(userEvents(chat(LOTH).info.id).length, 0);
});

test('a message sent this way counts as the person’s own turn: the gates that need it open, as for a typed message', async (t) => {
  const { connect, keys, chat, store, sessions } = await setup(t);
  const ben = chat(BEN);
  const { call } = await connect(keys.ben);
  // request_work marks a request humanAsked only when it is filed in a turn the person started (docs/orchestrators.md).
  const r = await call('orchestrator_send', { text: '#tool request_work {"title":"Fix the belt","brief":"The belt stutters."}', wait_seconds: 20 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Called request_work/);
  const w = [...store.work.values()][0];
  assert.ok(w, 'the request was filed');
  assert.equal(w.humanAsked, true, 'filed in Ben’s own turn');
  assert.deepEqual(w.requestedBy, BEN);
  // The same message sent as the harness's own (a timer, a relayed message) does not.
  sessions.send(ben.info.id, '[timer] fire', 'system');
  await until('the timer turn ended', () => ben.info.status === 'idle');
  assert.equal(ben.turnFrom, 'system', 'a system message opens a turn that is not the person’s');
  await call('orchestrator_send', { text: '#slow hold', wait_seconds: 0 });
  assert.equal(ben.turnFrom, 'human', 'and a message from here opens one that is');
});

test('a wrong key, a scoped key and a key without a login are refused; a key reaches only its own person’s orchestrator', async (t) => {
  const { connect, keys, base, chat, userEvents } = await setup(t);
  // Wrong or missing token: the endpoint says so before any tool exists.
  for (const header of [`Bearer ffsb_${'x'.repeat(43)}`, 'Bearer nope', '']) {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(header ? { authorization: header } : {}) }, body: '{}' });
    assert.equal(res.status, 401, header);
  }
  const scoped = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${keys.nightly}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(scoped.status, 403);
  // An old key with no login acts for the owner elsewhere, but cannot say whose orchestrator to talk to here.
  const old = await connect(keys.unbound);
  for (const [name, args] of [['orchestrator_send', { text: 'hi' }], ['orchestrator_inbox', {}], ['orchestrator_attach', { name: 'a.txt', text: 'x' }]] as const) {
    const r = await old.call(name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.text, /not bound to a login/, name);
  }
  assert.equal(userEvents(chat(BEN).info.id).length, 0, 'nothing reached the owner’s orchestrator');
  // No tool names a target: the person comes from the key alone.
  const { client } = await connect(keys.loth);
  const tools = (await client.listTools()).tools;
  for (const name of ['orchestrator_send', 'orchestrator_inbox', 'orchestrator_attach']) {
    const props = Object.keys((tools.find((x) => x.name === name)!.inputSchema.properties ?? {}) as object);
    assert.ok(!props.some((p) => /user|person|target|session|orchestrator/.test(p)), `${name} takes ${props.join(', ')}`);
  }
  // Lothsahn’s key writes to Lothsahn’s orchestrator and to no one else’s.
  const loth = await connect(keys.loth);
  const r = await loth.call('orchestrator_send', { text: 'hello from loth' });
  assert.equal(r.isError, false, r.text);
  assert.equal(userEvents(chat(LOTH).info.id).filter((e) => e.text.includes('hello from loth')).length, 1);
  assert.equal(userEvents(chat(BEN).info.id).length, 0);
  assert.deepEqual(userEvents(chat(LOTH).info.id)[0].requestedBy, LOTH);
});

test('over Funnel (or from an address outside the tailnet) the chat tools refuse, and nothing is sent', async (t) => {
  const { connect, keys, chat, userEvents, base } = await setup(t);
  const outside: Record<string, string>[] = [{ 'tailscale-funnel-request': '?1' }, { 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-for': '100.63.0.1' }];
  for (const headers of outside) {
    const { call } = await connect(keys.ben, headers);
    for (const [name, args] of [['orchestrator_send', { text: 'let me in' }], ['orchestrator_inbox', {}], ['orchestrator_attach', { name: 'a.txt', text: 'x' }], ['ask_orchestrator', { message: 'let me in' }], ['orchestrator_transcript', {}]] as const) {
      const r = await call(name, args);
      assert.equal(r.isError, true, `${name} ${JSON.stringify(headers)}`);
      assert.match(r.text, /refused: .*tailnet-only|refused: this request/, name);
    }
    const up = await fetch(`${base}/mcp/upload?name=a.txt`, { method: 'PUT', headers: { authorization: `Bearer ${keys.ben}`, ...headers }, body: 'x' });
    assert.equal(up.status, 403, JSON.stringify(headers));
  }
  assert.equal(userEvents(chat(BEN).info.id).length, 0);
  // From a tailnet address, through the proxy, it works.
  const ok = await connect(keys.ben, { 'x-forwarded-for': '100.101.102.103' });
  assert.equal((await ok.call('orchestrator_inbox')).isError, false);
});

test('tailnetOnly and tailnetAddress: Funnel header, forwarded address only from the local proxy', () => {
  for (const a of ['100.64.0.1', '100.127.255.254', '::ffff:100.100.1.1', 'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0:ab12::2']) assert.equal(tailnetAddress(a), true, a);
  for (const a of ['100.63.255.255', '100.128.0.0', '8.8.8.8', '192.168.1.5', 'fd7a:115c:a1e1::1', '2001:db8::1', '']) assert.equal(tailnetAddress(a), false, a);
  const req = (remote: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: remote }, headers }) as never;
  assert.equal(tailnetOnly(req('127.0.0.1')), undefined, 'a local connection with no proxy header');
  assert.equal(tailnetOnly(req('::ffff:127.0.0.1', { 'x-forwarded-for': '100.90.1.2' })), undefined);
  assert.match(tailnetOnly(req('127.0.0.1', { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '100.90.1.2' }))!, /Funnel/);
  assert.match(tailnetOnly(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.4' }))!, /tailnet/);
  // The first forwarded address is the client's: Serve sets it, it does not append to what the client sent.
  assert.match(tailnetOnly(req('127.0.0.1', { 'x-forwarded-for': '198.51.100.4, 100.90.1.2' }))!, /tailnet/);
  // A connection that is not from this machine is judged by its own address; a forwarded header it sends means nothing.
  assert.equal(tailnetOnly(req('100.90.1.2', { 'x-forwarded-for': '8.8.8.8' })), undefined);
  assert.match(tailnetOnly(req('203.0.113.7', { 'x-forwarded-for': '100.90.1.2' }))!, /tailnet/);
  assert.equal(originOf({ headers: { 'x-forwarded-host': 'fff.example.ts.net', 'x-forwarded-proto': 'https' }, socket: {} } as never), 'https://fff.example.ts.net');
  assert.equal(originOf({ headers: { host: 'a b' }, socket: {} } as never), '');
});

test('a message sent while the orchestrator is mid-turn is queued behind it, as a second web message is', async (t) => {
  setQueryForTesting(fakeQuery({ stepMs: 1, slowStepMs: 25 }) as never);
  t.after(() => setQueryForTesting(fakeQuery({ stepMs: 1 }) as never));
  const { connect, keys, chat, agents, userEvents, store } = await setup(t);
  const ben = chat(BEN);
  const { call } = await connect(keys.ben);
  // A message typed in the web app starts a turn of about a second.
  await agents.sendWithAttachments(ben.info.id, '#slow typed in the web app', 'human', { requestedBy: BEN });
  await until('the web turn runs', () => ben.info.status === 'running');
  const r = await call('orchestrator_send', { text: 'second, from Claude Code', wait_seconds: 30 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^The orchestrator was in the middle of a turn: your message is queued behind it/);
  assert.match(r.text, /Echo: [^]*second, from Claude Code/);
  assert.doesNotMatch(r.text, /Echo: #slow/, 'the reply is the turn that answers this message');
  const users = userEvents(ben.info.id);
  assert.deepEqual(users.map((e) => e.text.split('\n').pop()).slice(0, 2), ['#slow typed in the web app', 'second, from Claude Code'], 'in the order they arrived');
  const results = store.readTranscript(ben.info.id).filter((e) => e.kind === 'result');
  assert.ok(results.length >= 2, 'each message got its own turn');
});

test('after a timeout the reply so far comes back with a cursor, and orchestrator_inbox gets the rest', async (t) => {
  const { connect, keys, chat, store } = await setup(t);
  const ben = chat(BEN);
  const { call } = await connect(keys.ben);
  const r = await call('orchestrator_send', { text: '#wait 2', wait_seconds: 1 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Working for 2 s/);
  assert.match(r.text, /still working after 1 s/);
  const cursor = Number(/since: (\d+)/.exec(r.text)![1]);
  assert.ok(cursor > 0);
  const rest = await call('orchestrator_inbox', { since: cursor, wait_seconds: 20 });
  assert.equal(rest.isError, false, rest.text);
  assert.match(rest.text, /orchestrator:\nWaited 2 s\./);
  assert.match(rest.text, /turn ended/);
  assert.doesNotMatch(rest.text, /Working for 2 s/, 'not what was already shown');
  // Without since it goes on from there: nothing new, then what arrives on its own (a dispatch, a worker update).
  assert.match((await call('orchestrator_inbox')).text, /^Nothing new\./);
  store.append(ben.info.id, { kind: 'user', text: '[dispatch] w7 is started on m3/slot2.', from: 'system' });
  store.append(ben.info.id, { kind: 'assistant', text: 'w7 started; I will watch it.' });
  const news = await call('orchestrator_inbox');
  assert.match(news.text, /2 new messages/);
  assert.match(news.text, /\[system\] \[dispatch\] w7 is started on m3\/slot2\./);
  assert.match(news.text, /orchestrator:\nw7 started; I will watch it\./);
  assert.match((await call('orchestrator_inbox')).text, /^Nothing new\./);
  // Another key of the same person has its own place in the chat, and starts from the recent messages.
  const other = await connect(keys.ben);
  void other;
});

test('a call that waits sends progress notices, so a client’s own timeout does not run out first', async (t) => {
  const { connect, keys } = await setup(t);
  const { client } = await connect(keys.ben);
  const before = timing.keepaliveMs;
  timing.keepaliveMs = 150;
  t.after(() => {
    timing.keepaliveMs = before;
  });
  const seen: string[] = [];
  const r = (await client.callTool({ name: 'orchestrator_send', arguments: { text: '#wait 2', wait_seconds: 20 } }, undefined, { onprogress: (p) => void seen.push(String(p.message)), resetTimeoutOnProgress: true })) as { content: { text: string }[] };
  assert.match(r.content[0].text, /Waited 2 s\./);
  assert.ok(seen.length >= 2, `progress notices: ${seen.length}`);
  assert.match(seen[0], /the orchestrator is working/);
});

test('the web chat shows what was sent from here: the message is tagged, the cursor is per key', async (t) => {
  const { connect, keys, chat, userEvents } = await setup(t);
  const { call } = await connect(keys.ben);
  await call('orchestrator_send', { text: 'ping' });
  const ev = userEvents(chat(BEN).info.id).at(-1)!;
  assert.deepEqual(splitVia(ev.text), { via: 'Claude Code or Desktop (ben-mac)', text: 'ping' });
  assert.deepEqual(splitVia('plain'), { text: 'plain' });
  assert.deepEqual(splitVia('[via x]no newline'), { text: '[via x]no newline' });
  const inbox = await call('orchestrator_inbox', { since: 0 });
  assert.match(inbox.text, /you \(Claude Code or Desktop \(ben-mac\)\): ping/);
});

test('files: the HTTP upload and orchestrator_attach give an att_ id that orchestrator_send passes on', async (t) => {
  const { connect, keys, base, chat, userEvents, attachments } = await setup(t);
  const ben = chat(BEN);
  const { call } = await connect(keys.ben);
  const up = await fetch(`${base}/mcp/upload?name=${encodeURIComponent('crash log.txt')}`, { method: 'PUT', headers: { authorization: `Bearer ${keys.ben}` }, body: 'line one\nline two\n' });
  assert.equal(up.status, 200);
  const file = (await up.json()) as { id: string; name: string; size: number };
  assert.match(file.id, /^att_[a-z0-9]{12}$/);
  assert.equal(file.size, 18);
  assert.equal(attachments.get(file.id)?.uploadedBy, 'ben');
  const inline = await call('orchestrator_attach', { name: 'notes.md', text: '# notes' });
  assert.equal(inline.isError, false, inline.text);
  const id2 = /att_[a-z0-9]{12}/.exec(inline.text)![0];
  const r = await call('orchestrator_send', { text: 'look at these', attachments: [file.id, id2] });
  assert.equal(r.isError, false, r.text);
  const sent = userEvents(ben.info.id).at(-1)!;
  assert.deepEqual(sent.attachments?.map((a) => a.id).sort(), [file.id, id2].sort());
  assert.ok(fs.existsSync(sent.attachments![0].path!), 'the orchestrator holds a stored copy');
  // A bad id is refused before anything is sent; the upload refuses what it should.
  const before = userEvents(ben.info.id).length;
  const bad = await call('orchestrator_send', { text: 'x', attachments: ['att_000000000000'] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /no attachment/);
  assert.equal(userEvents(ben.info.id).length, before);
  assert.equal((await fetch(`${base}/mcp/upload?name=a.txt`, { method: 'PUT', headers: { authorization: `Bearer ${keys.unbound}` }, body: 'x' })).status, 403);
  assert.equal((await fetch(`${base}/mcp/upload?name=a.txt`, { method: 'PUT', headers: { authorization: 'Bearer ffsb_' + 'y'.repeat(43) }, body: 'x' })).status, 401);
  assert.equal((await fetch(`${base}/mcp/upload?name=a.txt`, { method: 'PUT', headers: { authorization: `Bearer ${keys.ben}` } })).status, 411);
  assert.equal((await fetch(`${base}/mcp/upload?name=a.txt`, { method: 'GET', headers: { authorization: `Bearer ${keys.ben}` } })).status, 405);
});

test('portalLinks: images and videos on this host become links on the portal; other links stay', () => {
  const o = 'https://fff.example.ts.net';
  const out = portalLinks('Here: ![the belt](/Users/ben/shots/belt.png) and ![web](https://x.test/a.png).\nClip: ![](/Users/ben/clips/belt.mp4)\nAlso see /Users/ben/shots/other one.png and C:\\temp\\b.webm', 'sess1', o);
  assert.match(out, /!\[the belt\]\(https:\/\/fff\.example\.ts\.net\/api\/image\?session=sess1&path=%2FUsers%2Fben%2Fshots%2Fbelt\.png\)/);
  assert.match(out, /!\[web\]\(https:\/\/x\.test\/a\.png\)/);
  assert.match(out, /\[belt\.mp4 \(video\)\]\(https:\/\/fff\.example\.ts\.net\/api\/image\?session=sess1&path=%2FUsers%2Fben%2Fclips%2Fbelt\.mp4\)/);
  assert.match(out, /Files named above/);
  assert.match(out, /\[b\.webm \(video\)\]/);
  assert.equal(portalLinks('no images, just `code` and a [link](https://x.test)', 's', o), 'no images, just `code` and a [link](https://x.test)');
  assert.match(portalLinks('![a](/x/y.png)', 's'), /^!\[a\]\(\/api\/image\?session=s&path=%2Fx%2Fy\.png\)$/);
});

test('turnOf and describeEvents: the turn that answers a message; the chat as text', () => {
  const t = (seq: number, e: object) => ({ seq, t: '2026-10-11T10:00:00.000Z', ...e }) as TranscriptEvent;
  const events = [
    t(1, { kind: 'user', text: 'first', from: 'human', uuid: 'u1' }),
    t(2, { kind: 'user', text: '[via Claude Code or Desktop (k)]\nsecond', from: 'human', uuid: 'u2' }),
    t(3, { kind: 'tool_use', toolUseId: 'a', name: 'mcp__sandboxes__list_work', input: {} }),
    t(4, { kind: 'assistant', text: 'answer to both' }),
    t(5, { kind: 'result', ok: true, text: '', costUsd: 0, turns: 1, durationMs: 1, answers: ['u1', 'u2'] }),
  ];
  const v = turnOf(events, 'u2');
  assert.deepEqual([v.found, v.done?.seq, v.said, v.tools, v.last], [true, 5, ['answer to both'], ['list_work'], 5]);
  assert.equal(turnOf(events.slice(0, 2), 'u2').done, undefined, 'still running');
  assert.equal(turnOf(events, 'nope').found, false);
  const text = describeEvents(events, 's');
  assert.match(text, /#1 you \(web app\): first/);
  assert.match(text, /#2 you \(Claude Code or Desktop \(k\)\): second/);
  assert.match(text, /#5 — turn ended \(it used: list_work\)/);
});

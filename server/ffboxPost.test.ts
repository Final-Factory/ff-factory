import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderManager } from './providers.ts';
import { PROVIDER_QUERIES, QUERY_LIMITS, mintProviderToken, tokenSha256 } from './providerProtocol.ts';
import { POST_CHANNELS, postArgs, postAsMax } from './ffboxPost.ts';
import { CATALOG } from './launch.ts';
import { MockConnector } from '../e2e/mockConnector.ts';
import { CliEventSchema } from './maxEvents.ts';
import type { Config } from './config.ts';

const GUILD = '530867164866150410';
const CHANNEL = '1069745561672106088';

async function setup(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffbox-post-'));
  const token = mintProviderToken();
  const cfg = { dataDir, providers: { ffbox: { enabled: true, tokenSha256: tokenSha256(token) } } } as unknown as Config;
  const pm = new ProviderManager(cfg);
  pm.statusPollMs = 0;
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => pm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const c = new MockConnector(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, token);
  await c.hello({ protocol: 2 });
  t.after(() => {
    c.close();
    pm.close();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { pm, c };
}

type Q = { id: string; what: string; args?: Record<string, string> };
function onQuery(c: MockConnector, answer: (q: Q) => void) {
  const timer = setInterval(() => {
    for (let i = c.received.findIndex((m) => m.type === 'query'); i >= 0; i = c.received.findIndex((m) => m.type === 'query')) answer(c.received.splice(i, 1)[0] as Q);
  }, 10);
  return () => clearInterval(timer);
}

const posted = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'query_result',
  id,
  what: 'post_message',
  ok: true,
  at: '2026-10-10T18:00:00Z',
  data: { posted: true, duplicate: false, channel: 'agent_testing', channel_id: CHANNEL, thread: null, message_id: '1558176042089447001', link: `https://discord.com/channels/${GUILD}/${CHANNEL}/1558176042089447001`, chars: 12, key: 't-1', posted_at: '2026-10-10T18:00:00Z', ...over },
});

test('post_message is a query the portal asks, waits 20 s for, and never keeps an answer of', () => {
  assert.ok((PROVIDER_QUERIES as readonly string[]).includes('post_message'));
  assert.equal(QUERY_LIMITS.timeoutMsByQuery.post_message, 20_000);
});

test('the worker tool takes a channel of the allowlist, text or a file, a thread and a key, and no bug channel', () => {
  assert.deepEqual(Object.keys(CATALOG.post_as_max).sort(), ['channel', 'file', 'key', 'skip_lines', 'text', 'thread']);
  assert.deepEqual([...POST_CHANNELS], ['dev_patch_notes', 'dev_chat', 'agent_testing']);
  for (const bug of ['bug_reports', 'dev_bug_reports']) {
    assert.ok(!CATALOG.post_as_max.channel.safeParse(bug).success, `${bug} is not a channel this tool posts into`);
    assert.match(String((postArgs({ channel: bug, text: 'x' }) as { error: string }).error), /belong to FFBox/);
  }
});

test('postArgs: the same rules as FFBox, as sentences', () => {
  const ok = postArgs({ channel: 'dev_patch_notes', text: '**Build 94** notes\r\nline', key: '0.50.0.94', by: 'w863' });
  assert.deepEqual(ok, { args: { channel: 'dev_patch_notes', text: '**Build 94** notes\nline', key: '0.50.0.94', by: 'w863' } });
  const bad = (i: Parameters<typeof postArgs>[0], re: RegExp) => assert.match((postArgs(i) as { error: string }).error ?? '', re);
  bad({ channel: 'dev_patch_notes', text: 'notes' }, /key: required for dev_patch_notes/);
  bad({ channel: 'dev_chat', text: '   ' }, /nothing to post/);
  bad({ channel: 'dev_chat', text: 'x'.repeat(2001) }, /2001 characters/);
  for (const t of ['hi @everyone', '@here', 'thanks @ben', '<@226123456789012345>', '<#123456789012345678>', '<@&123456789012345678>']) bad({ channel: 'dev_chat', text: t }, /mentions someone/);
  bad({ channel: 'dev_chat', text: 'a\u0000b' }, /control characters/);
  bad({ channel: 'dev_chat', text: 'x', key: 'bad key' }, /key:/);
  bad({ channel: 'dev_chat', text: 'x', thread: 'abc' }, /thread:/);
  assert.equal((postArgs({ channel: 'dev_chat', text: 'e-mail me: a@b.c' }) as { error?: string }).error?.slice(0, 5), 'text:', 'an @ before a word is a mention to FFBox, an address included');
  assert.ok('args' in postArgs({ channel: 'agent_testing', text: 'line one\nline two 😀' }), 'newlines and emoji are text');
});

test('postAsMax: the query goes out with the args, the answer is the link, and a Max event is made', async (t) => {
  const { pm, c } = await setup(t);
  const seen: Q[] = [];
  const stop = onQuery(c, (q) => {
    seen.push(q);
    c.send(posted(q.id));
  });
  t.after(stop);
  const r = await postAsMax(pm, { channel: 'agent_testing', text: 'hello Max', key: 't-1', by: 'w901' }, 'sess1', () => new Date('2026-10-10T18:00:01Z'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].what, 'post_message');
  assert.deepEqual(seen[0].args, { channel: 'agent_testing', text: 'hello Max', key: 't-1', by: 'w901' });
  assert.match(r.text, new RegExp(`Posted as Max by FFBox: https://discord.com/channels/${GUILD}/${CHANNEL}/1558176042089447001 \\(#agent-testing`));
  const ev = CliEventSchema.parse(r.event);
  assert.equal(ev.action, 'post');
  assert.equal(ev.ok, true);
  assert.equal(ev.channel_id, CHANNEL);
  assert.equal(ev.message_id, '1558176042089447001');
  assert.equal(ev.guild_id, GUILD);
  assert.equal(ev.session, 'sess1');
  assert.equal(ev.text, 'hello Max');
});

test('a repeat key answers the first link and makes no event', async (t) => {
  const { pm, c } = await setup(t);
  t.after(onQuery(c, (q) => c.send(posted(q.id, { duplicate: true }))));
  const r = await postAsMax(pm, { channel: 'agent_testing', text: 'again', key: 't-1' }, 'sess1');
  assert.match(r.text, /^Already posted, nothing was sent again: https:\/\/discord\.com\/channels\//);
  assert.equal(r.event, undefined);
});

test('a refusal throws with FFBox\'s reason; an answer that did not come says it may have posted', async (t) => {
  const { pm, c } = await setup(t);
  let mode: 'refused' | 'timeout' = 'refused';
  t.after(
    onQuery(c, (q) => {
      if (mode === 'refused') c.send({ type: 'query_result', id: q.id, what: 'post_message', ok: false, error: 'refused', reason: 'the text carries a GitHub token; nothing was posted' });
      else c.send({ type: 'query_result', id: q.id, what: 'post_message', ok: false, error: 'timeout' });
    }),
  );
  await assert.rejects(postAsMax(pm, { channel: 'dev_chat', text: 'x' }), (e: Error) => /FFBox did not post it: refused \(the text carries a GitHub token; nothing was posted\)\.$/.test(e.message));
  mode = 'timeout';
  await assert.rejects(postAsMax(pm, { channel: 'dev_chat', text: 'y' }), (e: Error) => /timeout/.test(e.message) && /may have been posted: ask again with the same key/.test(e.message));
});

test('a call the checks refuse never reaches FFBox', async (t) => {
  const { pm, c } = await setup(t);
  let asked = 0;
  t.after(onQuery(c, () => asked++));
  await assert.rejects(postAsMax(pm, { channel: 'dev_chat', text: 'hi @everyone' }), /mentions someone/);
  await assert.rejects(postAsMax(pm, { channel: 'dev_patch_notes', text: 'notes' }), /key: required/);
  assert.equal(asked, 0);
});

test('the answer to a post is never kept as a last known one', async (t) => {
  const { pm, c } = await setup(t);
  const stop = onQuery(c, (q) => c.send(posted(q.id)));
  await postAsMax(pm, { channel: 'agent_testing', text: 'one', key: 'k1' });
  stop();
  c.close();
  await new Promise((r) => setTimeout(r, 50));
  const after = await pm.query('post_message', { channel: 'agent_testing', text: 'two' });
  assert.equal(after.live, false);
  assert.equal(after.data, undefined, 'no earlier post\'s link stands in for this one');
});

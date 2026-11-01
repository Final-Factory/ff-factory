import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderManager } from './providers.ts';
import { PROVIDER_QUERIES, QUERY_LIMITS, mintProviderToken, tokenSha256 } from './providerProtocol.ts';
import { POST_CHANNELS, POST_RETRY, POST_TARGETS, postArgs, postAsMax, postImages, type PostImage } from './ffboxPost.ts';
import { createHash } from 'node:crypto';
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

test('the worker tool takes a channel of the allowlist, text or a file, a thread, a conversation and a key, and no bug channel', () => {
  assert.deepEqual(Object.keys(CATALOG.post_as_max).sort(), ['channel', 'conversation', 'file', 'images', 'key', 'new_thread', 'skip_lines', 'text', 'thread']);
  assert.deepEqual([...POST_CHANNELS], ['dev_patch_notes', 'dev_chat', 'agent_testing']);
  for (const bug of ['bug_reports', 'dev_bug_reports']) {
    assert.ok(!CATALOG.post_as_max.channel.safeParse(bug).success, `${bug} is not a channel this tool posts into`);
    assert.match(String((postArgs({ channel: bug, text: 'x' }) as { error: string }).error), /use channel "conversation" with its thread/);
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
  await assert.rejects(postAsMax(pm, { channel: 'dev_chat', text: 'y' }, undefined, undefined, { ...POST_RETRY, budgetMs: 0 }), (e: Error) => /timeout/.test(e.message) && /may have been posted: ask again with the same key/.test(e.message));
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

const THREAD = '1562003559732486144';

test('w1640: channel conversation takes the conversation id, and sends it as a string with the text', () => {
  assert.deepEqual(postArgs({ channel: 'conversation', conversation: '1163', text: 'Please attach the save.', key: 'c-1', by: 'w1640' }), {
    args: { channel: 'conversation', conversation: '1163', text: 'Please attach the save.', key: 'c-1', by: 'w1640' },
  });
  assert.deepEqual(POST_TARGETS, [...POST_CHANNELS, 'conversation']);
  assert.ok(CATALOG.post_as_max.channel.safeParse('conversation').success);
  assert.ok(Object.keys(CATALOG.post_as_max).includes('conversation'));
});

test('w1640: the thread of a conversation is an id, a thread link or a message link in it, and arrives as the thread id', () => {
  const thread = (t: string) => (postArgs({ channel: 'conversation', thread: t, text: 'hi' }) as { args: Record<string, string> }).args;
  assert.deepEqual(thread(THREAD), { channel: 'conversation', thread: THREAD, text: 'hi' });
  assert.equal(thread(`https://discord.com/channels/${GUILD}/${THREAD}`).thread, THREAD);
  assert.equal(thread(`https://discord.com/channels/${GUILD}/${THREAD}/1558176042089447001`).thread, THREAD, 'a message link names its thread (the second id)');
  assert.equal(thread(` https://discord.com/channels/${GUILD}/${THREAD} `).thread, THREAD);
  assert.match((postArgs({ channel: 'conversation', thread: 'https://example.com/channels/1/2', text: 'hi' }) as { error: string }).error, /thread:/);
  // Other channels keep the snowflake-only check: a link is no thread id there.
  assert.match((postArgs({ channel: 'dev_chat', thread: `https://discord.com/channels/${GUILD}/${THREAD}`, text: 'hi' }) as { error: string }).error, /thread:/);
  const both = postArgs({ channel: 'conversation', conversation: '7', thread: THREAD, text: 'hi' }) as { args: Record<string, string> };
  assert.equal(both.args.conversation, '7');
  assert.equal(both.args.thread, THREAD);
});

test('w1640: channel conversation needs the conversation or the thread, and the conversation id is digits', () => {
  assert.equal((postArgs({ channel: 'conversation', text: 'hi' }) as { error: string }).error, 'conversation: give the FFBox conversation id or the Discord thread (its id or URL)');
  assert.match((postArgs({ channel: 'conversation', conversation: 'abc', text: 'hi' }) as { error: string }).error, /^conversation:/);
  assert.match((postArgs({ channel: 'conversation', conversation: '1234567890123', text: 'hi' }) as { error: string }).error, /^conversation:/, 'at most 12 digits');
  assert.match((postArgs({ channel: 'conversation', conversation: 'abc', thread: THREAD, text: 'hi' }) as { error: string }).error, /^conversation:/);
});

test('w1640: the bug channels are still no channel, and the refusal says to use conversation with its thread', () => {
  for (const bug of ['bug_reports', 'dev_bug_reports']) {
    const e = (postArgs({ channel: bug, text: 'x' }) as { error: string }).error;
    assert.ok(e.startsWith(`channel: one of dev_patch_notes, dev_chat, agent_testing, conversation (got "${bug}").`), e);
    assert.ok(e.endsWith('To post in a thread of #bug-reports or dev_bug_reports, use channel "conversation" with its thread.'), e);
    assert.ok(!CATALOG.post_as_max.channel.safeParse(bug).success);
  }
  assert.ok(!/bug-reports/.test((postArgs({ channel: 'nowhere', text: 'x' }) as { error: string }).error), 'the hint is for the bug channels only');
});

test('w1640: a conversation post goes out with its args and the answer names FFBox\'s conversation, not a channel', async (t) => {
  const { pm, c } = await setup(t);
  const seen: Q[] = [];
  t.after(
    onQuery(c, (q) => {
      seen.push(q);
      c.send(posted(q.id, { channel: 'conversation 1163', thread: THREAD, channel_id: THREAD }));
    }),
  );
  const r = await postAsMax(pm, { channel: 'conversation', conversation: '1163', thread: `https://discord.com/channels/${GUILD}/${THREAD}`, text: 'Could you attach the save?', by: 'orchestrator: ben' }, 'sess1');
  assert.deepEqual(seen[0].args, { channel: 'conversation', conversation: '1163', thread: THREAD, text: 'Could you attach the save?', by: 'orchestrator: ben' });
  assert.match(r.text, /\(FFBox conversation 1163, thread 1562003559732486144, /);
  assert.ok(!/#conversation/.test(r.text));
  assert.equal(CliEventSchema.parse(r.event).channel, 'conversation 1163');
});

const noWait = (budgetMs: number) => ({ askMs: 10, budgetMs, pauseMs: 0, sleep: async () => {} });

test('w1664: a post whose answer came late is asked again with the same key and answers posted, with the link and an event', async (t) => {
  // The 1.0.0.3 patch notes (lothsahn: "The patch notes uploaded to discord but the worker thought they didn't"): FFBox
  // posted, its answer did not come in time; the same key asked again answers the post it made.
  const { pm, c } = await setup(t);
  const seen: Q[] = [];
  t.after(
    onQuery(c, (q) => {
      seen.push(q);
      if (seen.length === 1) c.send({ type: 'query_result', id: q.id, what: 'post_message', ok: false, error: 'timeout' });
      else c.send(posted(q.id, { duplicate: true, channel: 'dev_patch_notes', key: '1.0.0.3', posted_at: '2026-10-21T06:58:10Z' }));
    }),
  );
  const r = await postAsMax(pm, { channel: 'dev_patch_notes', text: 'notes', key: '1.0.0.3' }, 'sess1', () => new Date('2026-10-21T06:58:00Z'), noWait(60_000));
  assert.equal(seen.length, 2, 'asked twice');
  assert.deepEqual(seen[1].args, seen[0].args, 'the same args, so the same key');
  assert.match(r.text, /^Posted as Max by FFBox: https:\/\/discord\.com\/channels\/\d+\/\d+\/1558176042089447001 \(#dev-patch-notes/);
  assert.match(r.text, /first answer came late; asked again with the same key, it answered the post it had made/);
  assert.ok(!/may have been posted/.test(r.text));
  assert.equal(CliEventSchema.parse(r.event).action, 'post', 'this call made the post: a Max event');
});

test('w1664: a post an earlier call made is still "Already posted" after a late answer', async (t) => {
  const { pm, c } = await setup(t);
  let n = 0;
  t.after(onQuery(c, (q) => (++n === 1 ? c.send({ type: 'query_result', id: q.id, what: 'post_message', ok: false, error: 'timeout' }) : c.send(posted(q.id, { duplicate: true, posted_at: '2026-10-20T06:00:00Z' })))));
  const r = await postAsMax(pm, { channel: 'agent_testing', text: 'x', key: 'old' }, 's', () => new Date('2026-10-21T06:58:00Z'), noWait(60_000));
  assert.match(r.text, /^Already posted, nothing was sent again/);
  assert.equal(r.event, undefined);
});

test('w1664: asks again only inside its budget, and then says how often it asked', async (t) => {
  const { pm, c } = await setup(t);
  let n = 0;
  t.after(onQuery(c, (q) => (n++, c.send({ type: 'query_result', id: q.id, what: 'post_message', ok: false, error: 'timeout' }))));
  let clock = Date.parse('2026-10-21T06:58:00Z');
  const now = () => new Date((clock += 15_000));
  await assert.rejects(postAsMax(pm, { channel: 'agent_testing', text: 'x', key: 'k' }, 's', now, { ...noWait(75_000), askMs: 20_000 }), (e: Error) => /timeout/.test(e.message) && /asked \d+ times in \d+ s/.test(e.message) && /may have been posted/.test(e.message));
  assert.ok(n >= 2 && n <= 4, `asked ${n} times within 75 s`);
  assert.equal(POST_RETRY.budgetMs + POST_RETRY.askMs <= 95_000 && POST_RETRY.budgetMs < 90_000, true, "the asks fit inside the daemon's 90 s for the call");
});

test('w1664: a refusal is never asked again', async (t) => {
  const { pm, c } = await setup(t);
  let n = 0;
  t.after(onQuery(c, (q) => (n++, c.send({ type: 'query_result', id: q.id, what: 'post_message', ok: false, error: 'refused', reason: 'no' }))));
  await assert.rejects(postAsMax(pm, { channel: 'agent_testing', text: 'x', key: 'k' }, 's', undefined, noWait(60_000)), /refused/);
  assert.equal(n, 1);
});

// --- w2723: images on a post ------------------------------------------------------------------------------------------

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n: number, fill = 7) => Buffer.concat([PNG_HEAD, Buffer.alloc(n - PNG_HEAD.length, fill)]);
const jpg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, 3)]);
const wire = (name: string, b: Buffer) => ({ name, data: b.toString('base64') });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** FFBox's connector as post_file_put sees it (ffbox scripts/fffconnector.py): a part only at the offset it holds. */
function connectorFiles(c: MockConnector, opts: { drop?: (q: Q) => boolean; unsupported?: boolean } = {}) {
  const held = new Map<string, Buffer>();
  const done = new Set<string>();
  const seen: Q[] = [];
  const stop = onQuery(c, (q) => {
    seen.push(q);
    if (q.what === 'post_message') return c.send(posted(q.id));
    if (opts.unsupported) return c.send({ type: 'query_result', id: q.id, what: q.what, ok: false, error: 'unsupported' });
    const a = q.args as unknown as { file: string; bytes: number; offset: number; data: string };
    const answer = () => c.send({ type: 'query_result', id: q.id, what: q.what, ok: true, data: { file: a.file, have: done.has(a.file) ? a.bytes : (held.get(a.file)?.length ?? 0), bytes: a.bytes, complete: done.has(a.file) } });
    if (opts.drop?.(q) || done.has(a.file)) return answer();
    const have = held.get(a.file) ?? Buffer.alloc(0);
    if (a.offset === have.length) {
      const next = Buffer.concat([have, Buffer.from(a.data, 'base64')]);
      held.set(a.file, next);
      if (next.length === a.bytes && sha(next) === a.file) done.add(a.file);
    }
    answer();
  });
  return { held, done, seen, stop };
}

test('w2723: the worker tool takes up to 4 image paths, and an orchestrator\'s post_as_max none', () => {
  assert.ok(CATALOG.post_as_max.images.safeParse(['a.png', 'b.jpg']).success);
  assert.ok(!CATALOG.post_as_max.images.safeParse(['1.png', '2.png', '3.png', '4.png', '5.png']).success);
});

test('w2723: postImages takes PNG and JPEG by their first bytes, within the caps, and says what is wrong otherwise', () => {
  const ok = postImages([wire('power.png', png(1000)), wire('heat.jpg', jpg(500))]) as { images: PostImage[] };
  assert.deepEqual(ok.images.map((i) => [i.name, i.bytes.length, i.sha256]), [['power.png', 1000, sha(png(1000))], ['heat.jpg', 500, sha(jpg(500))]]);
  assert.deepEqual(postImages(undefined), { images: [] });
  assert.deepEqual(postImages([]), { images: [] });
  const bad = (raw: unknown, re: RegExp) => assert.match((postImages(raw) as { error: string }).error ?? '', re);
  bad(['Temp/a.png'], /older than the images option/);
  bad([1, 2, 3, 4, 5].map((n) => wire(`${n}.png`, png(100, n))), /at most 4/);
  bad([wire('big.png', png(4 * 1024 * 1024 + 1))], /at most 4 MB/);
  bad([wire('a.png', png(3 * 1024 * 1024, 1)), wire('b.png', png(3 * 1024 * 1024, 2)), wire('c.png', png(3 * 1024 * 1024, 3))], /more than 8 MB together/);
  bad([wire('fake.png', Buffer.from('not an image at all'))], /not a PNG image/);
  bad([wire('swap.png', jpg(100))], /not a PNG image/);
  bad([wire('notes.txt', png(100))], /not an image file name/);
  bad([wire('../x.png', png(100))], /not an image file name/);
  bad([wire('a.png', png(100)), wire('b.png', png(100))], /same image/);
  bad([{ name: 'a.png' }], /without its bytes/);
});

test('w2723: postArgs sends the images as files, SHA-256 and name, to a channel and to a conversation', () => {
  const images = (postImages([wire('a.png', png(100, 1)), wire('b.jpg', jpg(80))]) as { images: PostImage[] }).images;
  const files = `${sha(png(100, 1))}:a.png,${sha(jpg(80))}:b.jpg`;
  assert.deepEqual(postArgs({ channel: 'agent_testing', text: 'shots', images }), { args: { channel: 'agent_testing', text: 'shots', files } });
  assert.deepEqual(postArgs({ channel: 'conversation', conversation: '940', text: 'shots', images }), { args: { channel: 'conversation', text: 'shots', conversation: '940', files } });
  assert.match((postArgs({ channel: 'agent_testing', text: ' ', images }) as { error: string }).error, /nothing to post/, 'a post with images still needs its text');
  assert.match((postArgs({ channel: 'bug_reports', text: 'x', images }) as { error: string }).error, /use channel "conversation"/, 'images change no channel rule');
});

test('w2723: each image goes to FFBox in parts before the post, and the post names them', async (t) => {
  const { pm, c } = await setup(t);
  const conn = connectorFiles(c);
  t.after(conn.stop);
  const a = png(100_000, 1);
  const b = jpg(1_000);
  const images = (postImages([wire('power.png', a), wire('heat.jpg', b)]) as { images: PostImage[] }).images;
  const r = await postAsMax(pm, { channel: 'conversation', conversation: '940', text: 'The panels from your save.', key: 'w2723-shots', images }, 'sess1', () => new Date('2026-10-10T18:00:01Z'));
  assert.ok(conn.done.has(sha(a)) && conn.done.has(sha(b)), 'FFBox holds both images whole');
  assert.ok(conn.held.get(sha(a))!.equals(a));
  const puts = conn.seen.filter((q) => q.what === 'post_file_put');
  assert.ok(puts.every((q) => String(q.args!.data).length <= 60_000), 'every part fits a frame');
  const post = conn.seen.filter((q) => q.what === 'post_message');
  assert.equal(post.length, 1);
  assert.ok(conn.seen.indexOf(post[0]) > conn.seen.indexOf(puts[puts.length - 1]), 'the post comes after the parts');
  assert.equal(post[0].args!.files, `${sha(a)}:power.png,${sha(b)}:heat.jpg`);
  assert.match(r.text, /Posted as Max by FFBox: .*2 images\)/);
});

test('w2723: a part FFBox did not write is sent again from where it stands', async (t) => {
  const { pm, c } = await setup(t);
  let dropped = false;
  const conn = connectorFiles(c, { drop: (q) => q.what === 'post_file_put' && Number(q.args!.offset) === 45_000 && !dropped && (dropped = true) });
  t.after(conn.stop);
  const a = png(200_000, 2);
  const images = (postImages([wire('signal.png', a)]) as { images: PostImage[] }).images;
  await postAsMax(pm, { channel: 'agent_testing', text: 'x', key: 'w2723-resend', images }, 'sess1');
  assert.ok(dropped);
  assert.ok(conn.held.get(sha(a))!.equals(a), 'the image arrives whole, in order');
});

test('w2723: an FFBox without images posts nothing and says so', async (t) => {
  const { pm, c } = await setup(t);
  const conn = connectorFiles(c, { unsupported: true });
  t.after(conn.stop);
  const images = (postImages([wire('a.png', png(100))]) as { images: PostImage[] }).images;
  await assert.rejects(postAsMax(pm, { channel: 'agent_testing', text: 'x', images }, 'sess1'), /FFBox does not take images yet.*nothing was posted/);
  assert.equal(conn.seen.filter((q) => q.what === 'post_message').length, 0);
});

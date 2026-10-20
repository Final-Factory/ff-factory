import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { HELD_MARK } from '../shared/conditional.ts';
import { ASK_TOOL, CHAT_MORE_LABEL, DESCRIPTION_CHARS, QUESTION_CHARS, answerOf, askExcerpt, checkAsk, isAskTool, mediaMarkdown, questionOf, splitMedia } from '../shared/ask.ts';
import { REPLY_MARK, replyText, splitReply } from '../shared/replies.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';
import { useFakeVault } from './testVault.ts';

// Every Claude process runs on a vault token (w1078): these tests start orchestrators.
useFakeVault();

/** w1397: questions the orchestrator asks with buttons (ask_person, shared/ask.ts, Orchestrators.answerWords). */

const input: string[] = [];
const fake = fakeQuery({ stepMs: 1 });
setQueryForTesting(((args: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: never }) => {
  const prompt = (async function* () {
    for await (const m of args.prompt) {
      const c = m.message.content;
      input.push(typeof c === 'string' ? c : (c as { type: string; text?: string }[]).map((b) => b.text ?? '').join(' '));
      yield m;
    }
  })();
  return fake({ ...args, prompt } as never);
}) as never);

const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const PEOPLE: UserInfo[] = [
  { ...BEN, role: 'owner' },
  { ...LOTH, role: 'member' },
];
const T0 = new Date().toISOString();

async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-ask-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'develop',
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: true },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
    intake: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  const o = agents.orchestrators;
  t.after(async () => {
    o.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const call = async (info: SessionInfo, name: string, args: Record<string, unknown>) => {
    const tool = agents.orchestratorBelt(info).find((x) => x.name === name);
    if (!tool) throw new Error(`${info.title} has no ${name}`);
    const r = await tool.handler(args);
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { dir, store, o, agents, sessions, call };
}

const QUESTION = {
  question: 'Approve w5, the belt fix from FFBox?',
  options: [
    { label: 'Decline w5', description: 'Drop it; nothing is filed.' },
    { label: 'Approve w5', description: 'File it for the dispatcher now.', recommended: true },
    { label: 'Approve w5 and w6 together', description: 'They touch the same belts.' },
  ],
};

const pending = (id: string) =>
  ({ id, title: id, brief: 'x', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: false, status: 'new', createdAt: T0, updatedAt: T0, sessionIds: [], overlaps: [], asks: 0, log: [], approval: { state: 'pending' }, source: { kind: 'ffbox' } }) as unknown as WorkItem;

/** Ben's orchestrator with a question it asked through the tool (the call stays in the transcript as a tool_use). */
async function asked(t: Parameters<typeof setup>[0]) {
  const env = setup(t);
  const ben = env.o.personalFor(BEN);
  const id = ben.info.id;
  env.store.append(id, { kind: 'assistant', text: 'w5 is waiting for you.' });
  const answerText = await env.call(ben.info, ASK_TOOL, QUESTION);
  const ask = env.store.append(id, { kind: 'tool_use', toolUseId: 'tu-ask', name: `mcp__sandboxes__${ASK_TOOL}`, input: QUESTION });
  env.store.putWork(pending('w5'));
  env.store.workSeq = 5;
  return { ...env, ben, id, ask, answerText };
}

/** What the route does with a click: the words from the server, sent as the person's own message. */
async function click(env: Awaited<ReturnType<typeof asked>>, choice: number, by: Requester = BEN) {
  const before = input.length;
  const words = env.o.answerWords(env.id, env.ask.seq, choice);
  await env.agents.sendWithAttachments(env.id, words, 'human', { requestedBy: by });
  await until('handed', () => input.length > before);
  await until('the turn ends', () => env.sessions.get(env.id).info.status === 'idle');
  return input[before];
}

// ---------------------------------------------------------------- the question

test('w1397: a question is 2 to 4 options, the recommended one first; nothing else is accepted', () => {
  const ok = checkAsk(QUESTION);
  assert.ok('ask' in ok);
  if ('ask' in ok) {
    assert.deepEqual(ok.ask.options.map((o) => o.label), ['Approve w5', 'Decline w5', 'Approve w5 and w6 together'], 'recommended first, the rest in order');
    assert.equal(ok.ask.options[0].recommended, true);
  }
  const two = (extra: object = {}) => ({ question: 'Q?', options: [{ label: 'A', description: '' }, { label: 'B', description: '', ...extra }] });
  assert.ok('ask' in checkAsk(two()), 'none recommended is fine');
  assert.ok('problem' in checkAsk({ question: 'Q?', options: [{ label: 'A', description: '' }] }), 'one option');
  assert.ok('problem' in checkAsk({ question: 'Q?', options: [1, 2, 3, 4, 5].map((n) => ({ label: `o${n}`, description: '' })) }), 'five options');
  assert.ok('problem' in checkAsk({ question: '  ', options: two().options }), 'no question');
  assert.ok('problem' in checkAsk({ question: 'Q?', options: [{ label: 'A', description: '', recommended: true }, { label: 'B', description: '', recommended: true }] }), 'two picks');
  assert.ok('problem' in checkAsk({ question: 'Q?', options: [{ label: 'A', description: '' }, { label: 'a', description: '' }] }), 'the same label twice');
  assert.ok('problem' in checkAsk({ question: 'Q?', options: [{ label: 'A', description: '' }, { label: CHAT_MORE_LABEL, description: '' }] }), 'the page adds "chat more" itself');
  assert.ok('problem' in checkAsk('nonsense'));
  if ('ask' in ok) assert.equal(questionOf(askExcerpt(ok.ask)), 'Approve w5, the belt fix from FFBox?', 'a quote of it shows the question alone');
  assert.equal(questionOf('Shall I start w900?\n1. a\nnot a list'), undefined, 'any other message is quoted whole');
  assert.ok(isAskTool('ask_person') && isAskTool('mcp__sandboxes__ask_person') && !isAskTool('mcp__x__ask_personal') && !isAskTool('message_person'));
});

test("w1397: the answer reads back from the person's messages: only a click on a label settles it", () => {
  const ok = checkAsk(QUESTION);
  assert.ok('ask' in ok);
  if (!('ask' in ok)) return;
  const q = (words: string, seq = 7) => ({ text: replyText(words, { seq, from: 'the orchestrator', at: '2026-10-16T01:00:00.000Z', excerpt: askExcerpt(ok.ask) }) });
  assert.equal(answerOf(ok.ask, 7, []), undefined);
  assert.deepEqual(answerOf(ok.ask, 7, [q('Decline w5')]), { chosen: 1 });
  assert.equal(answerOf(ok.ask, 7, [q('actually, hold on')]), undefined, 'a typed reply to it leaves it open');
  assert.equal(answerOf(ok.ask, 7, [q('Decline w5', 9)]), undefined, 'a click on another question is not this one');
  assert.equal(answerOf(ok.ask, 7, [{ text: 'Decline w5' }]), undefined, 'the same words typed, quoting nothing, are not a click');
  assert.deepEqual(answerOf(ok.ask, 7, [q('hmm'), { text: `${q('Approve w5').text}\n\n${HELD_MARK}\nCalls a gate refused…` }], HELD_MARK), { chosen: 0 });
});

// ---------------------------------------------------------------- the tool and the click

test("w1397: ask_person is a person's orchestrator tool: it checks the question and tells the model to end its turn; the dispatcher has none", async (t) => {
  const env = setup(t);
  const ben = env.o.personalFor(BEN);
  const ok = await env.call(ben.info, ASK_TOOL, QUESTION);
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /Shown to Ben as 3 buttons, Approve w5 recommended, and a last "Chat more about this" that only opens their reply box\. End your turn now/);
  const bad = await env.call(ben.info, ASK_TOOL, { question: 'Q?', options: [{ label: 'A', description: '', recommended: true }, { label: 'B', description: '', recommended: true }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /ONE option recommended/);
  const dispatcher = env.sessions.get(env.o.dispatcherId!);
  assert.equal(env.agents.orchestratorBelt(dispatcher.info).some((x) => x.name === ASK_TOOL), false);
});

test("w1397: a click is the person's own message: their label, then the question quoted; it is their turn, so it approves what they clicked", async (t) => {
  const env = await asked(t);
  const seen = await click(env, 0);
  // What the orchestrator was handed: attributed to Ben, his words are the label, the question is quoted as data.
  assert.match(seen, new RegExp(`^\\[from Ben\\]\\nApprove w5\\n\\n${REPLY_MARK.replace(/[[\]]/g, '\\$&')}\\n#${env.ask.seq} · the orchestrator · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\n> Approve w5, the belt fix from FFBox\\?\\n> 1\\. Approve w5 \\(Recommended\\) - File it for the dispatcher now\\.\\n> 2\\. Decline w5`), seen);
  const sent = env.store.readTranscript(env.id).find((e) => e.kind === 'user' && e.text.startsWith('Approve w5\n\n'));
  assert.ok(sent && sent.kind === 'user');
  if (sent && sent.kind === 'user') {
    assert.equal(sent.from, 'human', 'a message of the person, not the harness');
    assert.deepEqual(sent.requestedBy, BEN, 'attributed to Ben');
    assert.equal(splitReply(sent.text, HELD_MARK).words, 'Approve w5');
    assert.equal(splitReply(sent.text, HELD_MARK).quote?.seq, env.ask.seq);
  }
  assert.equal(env.ben.turnFrom, 'human', 'their own turn, as if typed');
  // So the call that needs their own words goes through, with no reaction involved.
  const approve = await env.call(env.ben.info, 'update_work', { id: 'w5', approve: true });
  assert.equal(approve.isError, false, approve.text);
  assert.equal(env.store.work.get('w5')?.approval?.state, 'approved');
});

test('w1397: the buttons lock after one choice: a second click, on the same option or another, is refused and sends nothing', async (t) => {
  const env = await asked(t);
  assert.throws(() => env.o.answerWords(env.id, env.ask.seq, -1), /choice: 0 to 2/);
  assert.throws(() => env.o.answerWords(env.id, env.ask.seq, 3), /choice: 0 to 2/, '"Chat more" is the page\'s, not an option');
  await click(env, 1);
  const n = input.length;
  assert.throws(() => env.o.answerWords(env.id, env.ask.seq, 1), /already answered: "Decline w5"/);
  assert.throws(() => env.o.answerWords(env.id, env.ask.seq, 0), /already answered: "Decline w5"/);
  assert.equal(input.length, n, 'the orchestrator was handed nothing more');
  // Only a question of the chat can be answered, and only in a person's own orchestrator.
  assert.throws(() => env.o.answerWords(env.id, 1, 0), /is not a question with buttons/);
  assert.throws(() => env.o.answerWords(env.id, 9999, 0), /is not a question with buttons/);
  assert.throws(() => env.o.answerWords(env.o.dispatcherId!, env.ask.seq, 0), /person's own orchestrator chat/);
});

test('w1397: "Chat more about this" sends nothing and settles nothing: it is a reply to the question, and the buttons stay', async (t) => {
  const env = await asked(t);
  const n = input.length;
  // The page's "Chat more" only starts a reply in the composer; nothing reaches the server or the orchestrator.
  assert.equal(input.length, n);
  // The words the person types then go with the question quoted (a normal reply), and do not answer it.
  const before = input.length;
  await env.agents.sendWithAttachments(env.id, env.o.replyWords(env.id, 'what does w6 touch?', env.ask.seq), 'human', { requestedBy: BEN });
  await until('handed', () => input.length > before);
  await until('the turn ends', () => env.sessions.get(env.id).info.status === 'idle');
  assert.match(input[before], new RegExp(`^\\[from Ben\\]\\nwhat does w6 touch\\?\\n\\n${REPLY_MARK.replace(/[[\]]/g, '\\$&')}\\n#${env.ask.seq} · the orchestrator · .*\\n> Approve w5, the belt fix from FFBox\\?`));
  // Still open: a click works afterwards.
  assert.match(env.o.answerWords(env.id, env.ask.seq, 0), /^Approve w5\n\n/);
  // And a reply quoting a tool call that is no question is refused as before.
  assert.throws(() => env.o.replyWords(env.id, 'x', env.store.append(env.id, { kind: 'tool_use', toolUseId: 'tu2', name: 'list_work', input: {} }).seq), /is not a message of this chat/);
});

test('w1397: the brief tells the orchestrator to ask every question this way, and a [needs you] to carry the options', async (t) => {
  const env = setup(t);
  const ben = env.o.personalFor(BEN);
  const prompt = (env.agents.orchestratorOptions(ben.info) as { systemPrompt: { append: string } }).systemPrompt.append;
  assert.match(prompt, /Ask every question to Ben with ask_person/);
  assert.match(prompt, /one recommended option/);
  assert.ok(prompt.includes("ask it with ask_person (the worker's options as buttons)"));
});

test('w1419: a question’s and an option’s stills and clips are kept whole, apart from the words the limits count', () => {
  const still = '/srv/fff/review/w1386-save-blueprint-options/2-option-A-left-of-item-rows-1280.png';
  const clip = '/srv/fff/review/w1386-save-blueprint-options/option-B.mp4';
  assert.deepEqual(splitMedia(`Left of the hotbar. ![Option A at 1280](<${still}>) Recommended.`), {
    text: 'Left of the hotbar. Recommended.',
    media: [{ alt: 'Option A at 1280', url: still }],
  });
  assert.equal(mediaMarkdown([{ alt: 'a', url: still }, { alt: 'b', url: clip }]), `![a](<${still}>)\n\n![b](<${clip}>)`);
  // The words are clipped to the limit; the media path is never cut (w1384's ".jp"), whatever its length.
  const long = `${'x'.repeat(300)} ![Option A at 1280](<${still}>)`;
  const r = checkAsk({ question: `Where should it go? ![Today](<${still}>)`, options: [{ label: 'A', description: long, recommended: true }, { label: 'B', description: `Above the hint ![B](<${clip}>)` }] });
  assert.ok('ask' in r, JSON.stringify(r));
  if (!('ask' in r)) return;
  assert.equal(r.ask.options[0].description, `${'x'.repeat(DESCRIPTION_CHARS)} ![Option A at 1280](<${still}>)`);
  assert.equal(r.ask.question, `Where should it go? ![Today](<${still}>)`);
  // The words of a question count, not its media: 600 characters of words with a still is a question; 601 is not.
  assert.ok('ask' in checkAsk({ question: `${'q'.repeat(QUESTION_CHARS)} ![x](<${still}>)`, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }));
  assert.ok('problem' in checkAsk({ question: `${'q'.repeat(QUESTION_CHARS + 1)}`, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }));
  assert.ok('problem' in checkAsk({ question: `![only a still](<${still}>)`, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }), 'a question has words');
  // The quote of an answer has the words only.
  assert.equal(askExcerpt(r.ask).split('\n')[0], 'Where should it go?');
  assert.doesNotMatch(askExcerpt(r.ask), /!\[|srv\/fff/);
});

// ---------------------------------------------------------------- previews in the card (w1602)

/** A review folder of a request in the test's review root, files oldest first (their mtimes differ). */
function reviewFolder(env: ReturnType<typeof setup>, topic: string, names: string[]) {
  const dir = path.join(env.dir, '_review', topic);
  fs.mkdirSync(dir, { recursive: true });
  names.forEach((n, i) => {
    const f = path.join(dir, n);
    fs.writeFileSync(f, 'x');
    const at = new Date(Date.now() - (names.length - i) * 60_000);
    fs.utimesSync(f, at, at);
  });
  return dir.replace(/\\/g, '/');
}

const WARDEN = {
  question: 'Is the Warden halo right as it is?',
  options: [
    { label: 'OK as is', description: 'Ship the halo from w77 unchanged.', recommended: true },
    { label: 'Add beads to the halo', description: 'Re-record w77 with beads.' },
  ],
};

test("w1602: a question that names a request with review media and carries none is refused, listing the newest files; the same call again goes through", async (t) => {
  const env = setup(t);
  const dir = reviewFolder(env, 'w77-warden', ['old.mp4', 'mid.png', 'new.mp4']);
  reviewFolder(env, 'w78-other', ['unrelated.png']);
  const ben = env.o.personalFor(BEN);
  const first = await env.call(ben.info, ASK_TOOL, WARDEN);
  assert.equal(first.isError, true);
  assert.match(first.text, /Not shown yet: your question names w77/);
  assert.match(first.text, /in the card/);
  assert.ok(first.text.includes(`![new.mp4](<${dir}/new.mp4>)`), first.text);
  assert.ok(first.text.indexOf('new.mp4') < first.text.indexOf('mid.png') && first.text.indexOf('mid.png') < first.text.indexOf('old.mp4'), 'newest first');
  assert.doesNotMatch(first.text, /unrelated/);
  // Nothing was shown, and the same call again (the media is not for this question) is shown as it is.
  const again = await env.call(ben.info, ASK_TOOL, WARDEN);
  assert.equal(again.isError, false, again.text);
  assert.match(again.text, /Shown to Ben as 2 buttons/);
});

test('w1602: media in the question or in any option lets the call through at once; so does a request without review media', async (t) => {
  const env = setup(t);
  const dir = reviewFolder(env, 'w77', ['clip.mp4']);
  const ben = env.o.personalFor(BEN);
  const inQuestion = await env.call(ben.info, ASK_TOOL, { ...WARDEN, question: `Is the Warden halo of w77 right? ![clip](<${dir}/clip.mp4>)` });
  assert.equal(inQuestion.isError, false, inQuestion.text);
  const inOption = await env.call(ben.info, ASK_TOOL, { question: 'Is the halo of w77 right?', options: [{ label: 'OK as is', description: `Ship it. ![clip](<${dir}/clip.mp4>)` }, { label: 'Re-record', description: 'Beads.' }] });
  assert.equal(inOption.isError, false, inOption.text);
  const noFolder = await env.call(ben.info, ASK_TOOL, { question: 'Merge w999?', options: [{ label: 'Merge w999', description: 'Now.' }, { label: 'Hold w999', description: 'Later.' }] });
  assert.equal(noFolder.isError, false, noFolder.text);
  // A question that names no request is no business of the review folders.
  assert.equal((await env.call(ben.info, ASK_TOOL, QUESTION)).isError, false);
});

test('w1602: the brief tells the orchestrator a visual question carries its previews in the card', async (t) => {
  const env = setup(t);
  const ben = env.o.personalFor(BEN);
  const prompt = (env.agents.orchestratorOptions(ben.info) as { systemPrompt: { append: string } }).systemPrompt.append;
  assert.match(prompt, /A visual question carries its stills and clips in the question field/);
});

test('w1602: a refused call is no question: its click is refused too, whatever its card shows', async (t) => {
  const env = await asked(t);
  env.store.append(env.id, { kind: 'tool_result', toolUseId: 'tu-ask', isError: true, text: 'Not shown yet: …' });
  assert.throws(() => env.o.answerWords(env.id, env.ask.seq, 0), /refused when it was asked/);
});

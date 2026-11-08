import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { TEMP_CHECK_EVERY_MS, TEMP_WARN_BYTES, TEMP_WARN_STEP_BYTES, measureTemp, tempSizeHook, tempSizeLedgerLine, tempSizeNote, tempStep, type TempMeasure, type TempSizeReport } from './tempSizeHook.ts';
import { AgentSession, setQueryForTesting } from './sessions.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import { Store } from './store.ts';
import type { SessionInfo } from '../shared/types.ts';

/**
 * w3686: a worker's own process measures its temp folder and, over 15 GB, tells the worker on its next tool call and writes one
 * line into the request's ledger log. The numbers rest on the measurement in server/tempSizeHook.ts.
 */

const GB = 1e9;
const big = [
  { name: 'ff-game', bytes: 36.5 * GB },
  { name: 'cargo-target', bytes: 7.3 * GB },
  { name: 'notes', bytes: 0.1 * GB },
];

test('tempSizeNote: silent under 15 GB, one note from 15 GB, another at each further 10 GB', () => {
  assert.equal(TEMP_WARN_BYTES, 15e9);
  assert.equal(TEMP_WARN_STEP_BYTES, 10e9);
  assert.equal(tempSizeNote(14.9 * GB, big, 0), null);
  assert.equal(tempSizeNote(15 * GB, big, 0)?.step, 1);
  assert.equal(tempSizeNote(26 * GB, big, 1)?.step, 2);
  assert.equal(tempSizeNote(20 * GB, big, 1), null, 'step 1 was told');
  assert.equal(tempSizeNote(24.9 * GB, big, 1), null);
  assert.equal(tempSizeNote(25 * GB, big, 1)?.step, 2);
  assert.equal(tempSizeNote(100 * GB, big, 2)?.step, 9);
  assert.deepEqual([0, 14.99, 15, 24.99, 25, 35].map((g) => tempStep(g * GB)), [0, 0, 1, 1, 2, 3]);
});

test('tempSizeNote: the paragraph names the size, the threshold of its step and the three biggest, with the delete command', () => {
  const one = tempSizeNote(43.9 * GB, big, 2)!;
  assert.equal(
    one.note,
    'your temp folder ($TMPDIR) holds 43.9 GB, over 35 GB (w3686): biggest ff-game 36.5 GB, cargo-target 7.3 GB, notes 0.1 GB. ' +
      'Before you go on, delete what you no longer need, each with its path written out: rm -rf "$TMPDIR/<name>" (a delete under $TMPDIR asks nobody). ' +
      'Keep a clone that holds unpushed work; a Unity Library or a cargo target you still build in may stay.',
  );
  assert.ok(!one.note.includes('\n'), 'one paragraph');
  assert.match(tempSizeNote(26 * GB, big, 1)!.note, /holds 26\.0 GB, over 25 GB \(w3686\)/);
  assert.match(tempSizeNote(15 * GB, [], 0)!.note, /over 15 GB \(w3686\)\. Before you go on/, 'no children to name');
});

test('tempSizeLedgerLine: one line with the session, the size, the threshold and the biggest; a wire arg that is no report gives none', () => {
  assert.equal(
    tempSizeLedgerLine('0a1b2c3d-1111-2222', { total: 43.9 * GB, biggest: big, step: 1 }),
    'worker 0a1b2c3d: temp folder 43.9 GB, over 15 GB (w3686): ff-game 36.5 GB, cargo-target 7.3 GB, notes 0.1 GB',
  );
  assert.match(tempSizeLedgerLine('s', { total: 26 * GB, biggest: [], step: 2 })!, /^worker s: temp folder 26\.0 GB, over 25 GB \(w3686\)$/);
  for (const bad of [undefined, null, 'x', {}, { total: 1, step: 0, biggest: [] }, { total: 1, step: 1 }]) assert.equal(tempSizeLedgerLine('s', bad), undefined);
});

const post = (extra: Partial<{ agent_id: string }> = {}): HookInput =>
  ({ hook_event_name: 'PostToolUse', session_id: 's', transcript_path: 't', cwd: '.', tool_name: 'Bash', tool_input: {}, tool_response: '', tool_use_id: 'u', prompt_id: 'p1', ...extra }) as HookInput;
const run = async (h: ReturnType<typeof tempSizeHook>, input: HookInput = post()) => {
  const out = (await h(input, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { additionalContext?: string } };
  return out.hookSpecificOutput?.additionalContext;
};
const settle = () => new Promise((r) => setImmediate(r));

test('the hook never waits: a measurement that never finishes still lets the call return at once', async () => {
  let started = 0;
  const h = tempSizeHook('d', () => assert.fail('nothing was measured'), () => 0, () => (started++, new Promise<TempMeasure>(() => undefined)));
  assert.equal(await run(h), undefined);
  assert.equal(await run(h), undefined);
  assert.equal(started, 1, 'one in flight, so no second start however late');
});

test('the hook: the first call measures; the call after a crossing carries the note once and reports once', async () => {
  let clock = 0;
  const reports: TempSizeReport[] = [];
  const sizes = [{ total: 20 * GB, biggest: big }];
  const h = tempSizeHook('d', (r) => reports.push(r), () => clock, async () => sizes[0]);
  assert.equal(await run(h), undefined, 'the call that started the measurement has nothing yet');
  await settle();
  assert.equal(reports.length, 0, 'told at the next call, not when measured');
  const note = await run(h);
  assert.match(note ?? '', /^your temp folder \(\$TMPDIR\) holds 20\.0 GB, over 15 GB \(w3686\): biggest ff-game 36\.5 GB/);
  assert.equal(reports.length, 1);
  assert.deepEqual({ total: reports[0].total, step: reports[0].step, biggest: reports[0].biggest.map((c) => c.name) }, { total: 20 * GB, step: 1, biggest: ['ff-game', 'cargo-target', 'notes'] });
  assert.equal(reports[0].note, note);
  assert.equal(await run(h), undefined, 'once');
  assert.equal(reports.length, 1);
});

test('the hook: no new measurement before TEMP_CHECK_EVERY_MS, one after; a step already told is not told again, the next step is', async () => {
  assert.equal(TEMP_CHECK_EVERY_MS, 600_000);
  let clock = 1_000;
  let total = 16 * GB;
  let started = 0;
  const reports: TempSizeReport[] = [];
  const h = tempSizeHook('d', (r) => reports.push(r), () => clock, async () => (started++, { total, biggest: big }));
  await run(h);
  await settle();
  assert.equal(started, 1);
  assert.ok(await run(h), 'step 1 told');
  clock += TEMP_CHECK_EVERY_MS - 1;
  await run(h);
  assert.equal(started, 1, 'not yet');
  clock += 1;
  await run(h);
  assert.equal(started, 2, 'ten minutes after the last start');
  await settle();
  assert.equal(await run(h), undefined, 'still step 1: not told again');
  assert.equal(started, 2);
  clock += TEMP_CHECK_EVERY_MS;
  total = 26 * GB;
  await run(h);
  await settle();
  assert.match((await run(h)) ?? '', /holds 26\.0 GB, over 25 GB/);
  assert.deepEqual(reports.map((r) => r.step), [1, 2]);
  // cleaned up under 15 GB, then grown again: told again
  clock += TEMP_CHECK_EVERY_MS;
  total = 3 * GB;
  await run(h);
  await settle();
  clock += TEMP_CHECK_EVERY_MS;
  total = 17 * GB;
  await run(h);
  await settle();
  assert.match((await run(h)) ?? '', /holds 17\.0 GB/);
  assert.deepEqual(reports.map((r) => r.step), [1, 2, 1]);
});

test("the hook: a subagent's calls neither measure nor carry the note; a failed measurement is tried again at the next interval", async () => {
  let clock = 0;
  let started = 0;
  let fail = true;
  const h = tempSizeHook('d', () => undefined, () => clock, async () => {
    started++;
    if (fail) throw new Error('walk failed');
    return { total: 30 * GB, biggest: big };
  });
  assert.equal(await run(h, post({ agent_id: 'explore-1' })), undefined);
  assert.equal(started, 0);
  assert.equal(await run(h, post({ agent_id: 'explore-1' })), undefined);
  assert.equal(await run(h), undefined);
  await settle();
  assert.equal(started, 1);
  fail = false;
  clock += TEMP_CHECK_EVERY_MS;
  await run(h);
  await settle();
  assert.equal(started, 2);
  assert.equal(await run(h, post({ agent_id: 'explore-1' })), undefined, 'the note waits for the main thread');
  assert.match((await run(h)) ?? '', /holds 30\.0 GB/);
  assert.equal(await run(h, { ...post(), hook_event_name: 'PreToolUse' } as never), undefined);
});

test('measureTemp: sums the direct children (files and folders) and names the three biggest in order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-temp-size-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, bytes: number) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), Buffer.alloc(bytes));
  };
  put('clone/Library/a.bin', 5000);
  put('clone/src/b.cs', 700);
  put('cargo/target/c.o', 3000);
  put('log.txt', 400);
  put('tiny/x', 10);
  fs.mkdirSync(path.join(dir, 'empty'));
  const m = await measureTemp(dir);
  assert.equal(m.total, 5000 + 700 + 3000 + 400 + 10);
  assert.deepEqual(m.biggest, [
    { name: 'clone', bytes: 5700 },
    { name: 'cargo', bytes: 3000 },
    { name: 'log.txt', bytes: 400 },
  ]);
  assert.deepEqual(await measureTemp(path.join(dir, 'missing')), { total: 0, biggest: [] });
});

test('AgentSession: a worker in an ffa-<session> temp folder gets the watch beside its other PostToolUse hooks; an orchestrator or another folder gets none', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-temp-size-s-'));
  const store = new Store(dir);
  t.after(() => {
    setQueryForTesting(fakeQuery() as never);
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  type Seen = { hooks?: { PostToolUse?: { hooks: unknown[] }[] } };
  let seen = undefined as Seen | undefined;
  setQueryForTesting((({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Seen }) => {
    seen = options;
    void (async () => {
      for await (const _ of prompt) void _;
    })();
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'conv-3686', model: 'm', uuid: 'init' };
    })();
  }) as never);
  const sessionDir = path.join(dir, 'tmp', 'ffa-abc');
  fs.mkdirSync(sessionDir, { recursive: true });
  const info = (id: string, kind: SessionInfo['kind']): SessionInfo => ({ id, kind, title: 't', status: 'idle', permissionMode: 'bypassPermissions', createdAt: 'x', lastActivityAt: 'x', turns: 0, costUsd: 0, pendingPermissions: [] });
  let n = 0;
  const hooksFor = async (kind: SessionInfo['kind'], tmp: string | undefined, prior: boolean) => {
    seen = undefined as Seen | undefined;
    const s = new AgentSession(info(`s-3686-${++n}`, kind), store, () => ({ env: tmp ? { TMPDIR: tmp } : {}, ...(prior ? { hooks: { PostToolUse: [{ hooks: [async () => ({})] }] } } : {}) }), new EventEmitter());
    store.putSession(s.info);
    s.send('go');
    await new Promise((r) => setTimeout(r, 30));
    return { post: (seen as Seen | undefined)?.hooks?.PostToolUse };
  };
  const worker = await hooksFor('worker', sessionDir, true);
  assert.equal(worker.post?.length, 2, 'the existing hook stays, the watch is added');
  assert.equal(worker.post?.[0].hooks.length, 1);
  assert.equal((await hooksFor('worker', sessionDir, false)).post?.length, 1);
  assert.equal((await hooksFor('orchestrator', sessionDir, false)).post, undefined);
  assert.equal((await hooksFor('ops', sessionDir, false)).post, undefined);
  assert.equal((await hooksFor('worker', path.join(dir, 'tmp', 'other'), false)).post, undefined, 'only an ffa-<session> folder is a worker temp folder');
  assert.equal((await hooksFor('worker', undefined, false)).post, undefined);
});

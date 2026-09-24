import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStopCommand, speakableText, speechChunks } from '../shared/speech.ts';

test('speakableText: markdown reads naturally', () => {
  const md = [
    '## Status',
    '',
    '**Sandbox** `shader-blackhole` is *running* → see [the PR](https://github.com/x/y/pull/12).',
    '- Unity: ready',
    '- Tests: 108 passed',
    '',
    'Commit 506bb31 is on `main`; the file is `server/voice.ts:123`.',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    'Done 🎉 — details at https://example.com/very/long.',
  ].join('\n');
  assert.equal(
    speakableText(md),
    'Status. Sandbox shader-blackhole is running to see the PR. Unity: ready. Tests: 108 passed. Commit is on main; the file is voice.ts. Code block omitted. Table omitted. Done — details at link.',
  );
});

test('speakableText: long replies are cut at a sentence and say so', () => {
  const md = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const s = speakableText(md, 200);
  assert.ok(s.length < 260, s);
  assert.ok(s.endsWith('here. The rest is on screen.'), s);
  assert.equal(speakableText('Short.', 200), 'Short.');
});

test('speakableText: ids, uuids and inline noise are dropped', () => {
  assert.equal(speakableText('Session 3f2a9c1e-1b2c-4d5e-8f90-123456789abc started, sha 9f3e2d1c0b, words like defaced stay.'), 'Session started, sha, words like defaced stay.');
  assert.equal(speakableText('Run `npm run voice-setup` now'), 'Run npm run voice-setup now.');
  assert.equal(speakableText(''), '');
});

test('speechChunks: a short first chunk, then sentences grouped up to the limit', () => {
  const text = 'First one. Second sentence here! Third? Fourth sentence goes on a bit. Fifth.';
  const c = speechChunks(text, 40);
  assert.equal(c[0], 'First one.');
  assert.ok(
    c.every((x) => x.length <= 40),
    JSON.stringify(c),
  );
  assert.equal(c.join(' '), text);
  const long = speechChunks(`${'word, '.repeat(80)}end.`, 100);
  assert.ok(long.length > 3 && long.every((x) => x.length <= 101), JSON.stringify(long));
  assert.deepEqual(speechChunks(''), []);
  assert.deepEqual(speechChunks('No final punctuation'), ['No final punctuation']);
});

test('isStopCommand', () => {
  const yes = ['Stop.', 'stop', 'Cancel!', 'Okay, stop.', 'Stop listening.', 'Exit voice mode', 'Voice mode off.', 'Never mind.', 'That’s all, thanks.', "That's all.", 'Goodbye.'];
  for (const t of yes) assert.ok(isStopCommand(t), t);
  const no = ['Stop the Unity editor in shader-blackhole.', 'Cancel the build and restart it', "Don't stop.", 'What is the status?', ''];
  for (const t of no) assert.ok(!isStopCommand(t), t);
});

test('turnReply: the last assistant message of the first turn that finished after the mark', async () => {
  const { turnReply } = await import('../shared/speech.ts');
  const ev = [
    { seq: 1, kind: 'assistant', text: 'old' },
    { seq: 2, kind: 'result', ok: true, text: 'old' },
    { seq: 3, kind: 'user', text: 'status?' },
    { seq: 4, kind: 'assistant', text: 'Let me check.' },
    { seq: 5, kind: 'tool_use' },
    { seq: 6, kind: 'assistant', text: 'All three sandboxes are idle.' },
    { seq: 7, kind: 'result', ok: true, text: 'All three sandboxes are idle.' },
  ];
  assert.equal(turnReply(ev.slice(0, 6), 2), undefined);
  assert.deepEqual(turnReply(ev, 2), { text: 'All three sandboxes are idle.', ok: true });
  assert.deepEqual(turnReply([{ seq: 3, kind: 'user' }, { seq: 4, kind: 'result', ok: false, text: '' }], 2), { text: 'The turn ended with an error.', ok: false });
  assert.deepEqual(turnReply([{ seq: 4, kind: 'result', ok: true, text: 'Only a result.' }], 2), { text: 'Only a result.', ok: true });
});

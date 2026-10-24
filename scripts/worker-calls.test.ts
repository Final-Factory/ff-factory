import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseText, requestOf, sessionPhases } from './worker-calls.ts';

/** w2018: a session's dollars by the phase each call ran in, and its pushes (the same rules as the portal's meter). */
test('sessionPhases: a call is charged to the phase it ran in; its tools move the phase for the next call', () => {
  const r = sessionPhases([
    { usd: 1, tools: [{ name: 'Read', input: { file_path: 'a' }, id: '1' }] },
    { usd: 2, tools: [{ name: 'Edit', input: { file_path: 'a' }, id: '2' }] },
    { usd: 3, tools: [{ name: 'Bash', input: { command: 'ff-pr push --base main' }, id: '3' }] },
    { usd: 4, tools: [{ name: 'Edit', input: { file_path: 'a' }, id: '4' }, { name: 'Bash', input: { command: 'git push' }, id: '5' }] },
    { usd: 5, tools: [] },
  ]);
  assert.deepEqual(r, { usd: { research: 3, implement: 3, 'after-push': 9 }, pushes: 2 });
  assert.equal(phaseText({ usd: r.usd, sessions: 1, pushes: 2, pushesMedian: 2, pushesP90: 2 }), 'research before the first edit $3 (20%), implementing $3 (20%), after the first push $9 (60%); 1 sessions, 2 pushes (a session: median 2, p90 2)');
});

test('requestOf: the brief\'s Request line, an [about] line, else the first request id it names', () => {
  assert.equal(requestOf('[from the orchestrator, for x]\nDo it.\nRequest: w2018'), 'w2018');
  assert.equal(requestOf('[about w77] see w12'), 'w77');
  assert.equal(requestOf("[from the orchestrator, for ben]\nGoal (Ben's request w1908, filed text"), 'w1908');
  assert.equal(requestOf('no id here, www12x'), undefined);
});

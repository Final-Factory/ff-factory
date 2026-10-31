// w2625: what a worker that waits for someone to restart its agent host or tools is told (Agents.restartWaitNudge), and its
// system prompt's line: neither sends it to an orchestrator or a person for a restart, and both route a tool still missing to
// blocked_on with a deploy (w2618's worker bcd8d4e5 sat 2 h "waiting on the orchestrator to restart my agent host").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartWaitNotice } from './agents.ts';

test('w2625: the restart-wait notice says nobody restarts an agent host by hand and routes a missing tool to blocked_on with a deploy', () => {
  const n = restartWaitNotice('w2618', 'w2618: still open: waiting on the orchestrator to restart my agent host on beast so the new tool list loads');
  assert.match(n, /Nobody restarts those by hand, and no orchestrator or person can/);
  assert.match(n, /blocked_on with deploys \[your machine's id\] \(its daemon update\) or \["portal"\]/);
  assert.doesNotMatch(n, /\bask (?:the|your|an) (?:orchestrator|person|dispatcher)\b/i);
});

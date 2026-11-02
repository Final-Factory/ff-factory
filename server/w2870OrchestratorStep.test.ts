// w2870: a worker that ends its turn waiting on its orchestrator for a step workers have no tool for. w2833's worker a53036df
// reported four times from 05:24 UTC "still open: the orchestrator runs the live ffbox_activity demo for conversations 1487
// and 1488 and sends the results to worker c6e1d6f2; workers don't have those tools"; the ledger read "Merged, follow-up
// pending" and nobody was told until a sweep timer noticed at 07:57. It now reads Waiting on input on the requester's
// orchestrator (shared/workState.ts orchestratorAskIn, workLive), and that orchestrator is sent [orchestrator step] once
// (Orchestrators.orchestratorStep; its message flow is in orchestrators.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestratorAskIn, workLive } from '../shared/workState.ts';
import { orchestratorStepText } from './orchestrators.ts';
import type { Requester, SessionInfo, WorkItem } from '../shared/types.ts';

const NOW = Date.parse('2026-11-02T06:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const LOTH: Requester = { userId: 'lothsahn', displayName: 'lothsahn' };
const W2833_LINE =
  "w2833: still open: the orchestrator runs the live ffbox_activity demo for conversations 1487 and 1488 and sends the results to worker c6e1d6f2; workers don't have those tools";

const item = (o: Partial<WorkItem> = {}): WorkItem => ({
  id: 'w2833',
  title: "FFBox connector: let orchestrators read a run's files",
  brief: 'Do it.',
  priority: 'normal',
  keys: [],
  requestedBy: LOTH,
  requesters: [LOTH],
  humanAsked: true,
  status: 'active',
  createdAt: ago(600),
  updatedAt: ago(40),
  sessionIds: ['a53036df'],
  overlaps: [],
  asks: 0,
  log: [],
  prs: [{ repo: 'Final-Factory/ff-factory', number: 797, url: 'https://github.com/Final-Factory/ff-factory/pull/797', state: 'merged', at: ago(40) }],
  ...o,
});
const worker = (lastResult: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'a53036df',
  kind: 'worker',
  title: 'w2833: FFBox run files',
  status: 'idle',
  permissionMode: 'default',
  createdAt: ago(600),
  lastActivityAt: ago(30),
  lastResultAt: ago(30),
  lastResult,
  turns: 9,
  costUsd: 1,
  pendingPermissions: [],
  ...o,
});
const live = (w: WorkItem, s: SessionInfo) => workLive(w, { items: [w], session: (id) => (id === s.id ? s : undefined), now: NOW });

test('w2870: orchestratorAskIn reads a step only the orchestrator takes, and not own work, a restart, a pair run or a person', () => {
  assert.ok(orchestratorAskIn(W2833_LINE), 'the orchestrator as the one who acts');
  assert.ok(orchestratorAskIn('w1: still open: waiting on the orchestrator to send me the run files of d1487t1'));
  assert.ok(orchestratorAskIn("w1: still open: lothsahn's orchestrator must fetch the FFBox report and pass it to me"));
  assert.ok(!orchestratorAskIn('w1: still open: waiting on the orchestrator to run the two-machine check'), 'its own work (w1685)');
  assert.ok(!orchestratorAskIn('w1: still open: waiting on the orchestrator to restart my agent host on beast so the new tool list loads'), 'no restart by hand (w2625)');
  assert.ok(!orchestratorAskIn('w1: still open: waiting on the orchestrator to start a pair worker on m3'), 'a pair run is request_pair');
  assert.ok(!orchestratorAskIn('w1: still open: waiting on Ben to pick the look'), 'a person');
  assert.ok(!orchestratorAskIn('w1: still open: waiting on the dispatcher to decide w2'), 'the dispatcher keeps its own line');
  assert.ok(!orchestratorAskIn('w1: still open: I run the scenario three more times'));
});

test('w2870: a merged request whose worker waits on the orchestrator for its step is Waiting on that orchestrator, not "Merged, follow-up pending"', () => {
  const report = `PR #797 merged and deployed.\n\n${W2833_LINE}`;
  const l = live(item(), worker(report));
  assert.equal(l?.state, 'waiting', l?.why);
  assert.equal(l?.orchestrator, true);
  assert.deepEqual(l?.waitsOn, ["lothsahn's orchestrator"]);
  assert.equal(l?.worker, 'a53036df');
  assert.match(l!.why, /^a53036df waits on the orchestrator for a step workers have no tool for \(sent to it once\): "w2833: still open: the orchestrator runs the live ffbox_activity demo/);

  // A check-in the worker set does not make it Working: no wake-up runs the orchestrator's step.
  const sleeping = live(item(), worker(report, { status: 'stopped', wakeAt: ago(-30) }));
  assert.equal(sleeping?.state, 'waiting', sleeping?.why);

  // The requester's note after the line (their orchestrator recorded the step's result) settles it.
  const noted = live(item({ notes: [{ at: ago(10), by: 'lothsahn', text: 'Ran the demo; results sent to c6e1d6f2.' }] }), worker(report));
  assert.equal(noted?.state, 'followup', noted?.why);

  // Without the wait it is what it was.
  assert.equal(live(item(), worker('PR #797 merged.\n\nw2833: still open: the cleanup checks the deploy'))?.state, 'followup');
});

test('w2870: the [orchestrator step] message says what to run, that it is no question for the person, and how to hand it back', () => {
  const t = orchestratorStepText(item(), 'a53036df', W2833_LINE, 'lothsahn');
  assert.match(t, /^\[orchestrator step\] w2833 "FFBox connector: let orchestrators read a run's files"\n/);
  assert.match(t, /Its worker a53036df ended its turn waiting on you, lothsahn's orchestrator, for a step workers have no tool for/);
  assert.ok(t.includes(W2833_LINE));
  assert.match(t, /Run it yourself now with your own tools \(this is no question for lothsahn/);
  assert.match(t, /message_agent/);
  assert.match(t, /Sent once for this wait/);
});

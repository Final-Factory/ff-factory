import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchLockDir } from '../machine/benchLock.ts';
import { benchQueueDir } from '../machine/benchQueue.ts';
import { checkoutState, readBenchWarnings } from '../machine/benchWarnings.ts';
import { BenchWarner, benchWarningText } from './benchWarnings.ts';
import { agentCap } from './machines.ts';
import type { BenchWarning, SessionInfo } from '../shared/types.ts';

/**
 * w1832: a holder warned that its bench turn ends (the game repo's bench_queue.py writes limit.json with `warned`) is
 * reported by its daemon and messaged once per deadline, told to push its work. lothsahn: "At 25 minutes, the holder gets
 * a warning it will actually see, both in its command output and as a message to the worker"; "Workers should be
 * encouraged to push their uncommitted work at the warning threshold so they can be scheduled on other machines".
 */

const tmp = (t: { after(fn: () => void): void }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w1832-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

function ticket(root: string, name: string, info: object, files: Record<string, object>) {
  const d = path.join(benchQueueDir(benchLockDir(root)), name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'info.json'), JSON.stringify({ ticket: name, ...info }));
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, f), JSON.stringify(v));
}

test('w1832: the daemon reports only warned holders with a session, with their checkout state', (t) => {
  const root = tmp(t);
  const deadline = 1_800_000_300;
  ticket(root, 't00000001', { mode: 'exclusive', what: 'probe A round 2', pid: 1, session: 's1', cwd: '/w/slot1' }, { granted: { at: 'x', ts: 1_800_000_000 }, 'limit.json': { deadline, warned: 1_800_000_000, why: 'the 30-minute exclusive turn' } });
  ticket(root, 't00000002', { mode: 'shared', what: 'a build', pid: 1, session: 's2' }, { granted: { at: 'x', ts: 1 }, 'limit.json': { deadline, set: 1 } });
  ticket(root, 't00000003', { mode: 'exclusive', what: 'no session', pid: 1 }, { granted: { at: 'x', ts: 1 }, 'limit.json': { deadline, warned: 1 } });
  ticket(root, 't00000004', { mode: 'exclusive', what: 'revoked', pid: 1, session: 's4' }, { granted: { at: 'x', ts: 1 }, revoked: { at: 'x', why: 'limit' }, 'limit.json': { deadline, warned: 1 } });
  ticket(root, 't00000005', { mode: 'exclusive', what: 'its helper is gone', pid: 999, session: 's5' }, { granted: { at: 'x', ts: 1 }, 'limit.json': { deadline, warned: 1 } });
  const asked: (string | undefined)[] = [];
  const state = (cwd: string | undefined) => (asked.push(cwd), { dirty: 3, unpushed: 1, branch: 'w1832-x' });
  const got = readBenchWarnings(root, (pid) => pid === 1, state);
  assert.deepEqual(got, [{ ticket: 't00000001', session: 's1', mode: 'exclusive', what: 'probe A round 2', deadline: deadline * 1000, why: 'the 30-minute exclusive turn', dirty: 3, unpushed: 1, branch: 'w1832-x' }]);
  readBenchWarnings(root, (pid) => pid === 1, state);
  assert.deepEqual(asked, ['/w/slot1'], 'git is read once per warning, not every stats tick');
  assert.deepEqual(readBenchWarnings(undefined), []);
});

test('w1832: a checkout state from git, and none when git cannot say', () => {
  const git = (args: string[]) => {
    if (args[0] === 'status') return ' M a.cs\n?? b.cs\n';
    if (args[0] === 'rev-parse') return 'w1832-x\n';
    throw new Error('no upstream');
  };
  assert.deepEqual(checkoutState('/w', git), { dirty: 2, branch: 'w1832-x' });
  assert.equal(checkoutState(undefined), undefined);
  assert.equal(
    checkoutState('/w', () => {
      throw new Error('not a repo');
    }),
    undefined,
  );
});

test('w1832: each warning goes to its worker once per deadline, and tells it to push its work', () => {
  const sent: [string, string][] = [];
  const now = 1_800_000_000_000;
  const w = new BenchWarner({ session: (id) => (id === 'gone' ? undefined : ({ id } as SessionInfo)), send: (id, text) => sent.push([id, text]), now: () => now });
  const warning: BenchWarning = { ticket: 't00000001', session: 's1', mode: 'exclusive', what: 'probe A round 2', deadline: now + 5 * 60_000, why: 'the 30-minute exclusive turn', dirty: 2, unpushed: 0, branch: 'w1832-x' };
  w.handle('m5', [warning]);
  w.handle('m5', [warning]);
  assert.equal(sent.length, 1, 'once');
  assert.equal(sent[0][0], 's1');
  assert.match(sent[0][1], /^Bench lock warning \(w1832\): your exclusive ticket t00000001 on m5 \("probe A round 2"\) ends at \d\d:\d\dZ, in 5 min: the 30-minute exclusive turn\./);
  assert.match(sent[0][1], /Commit and push your work-in-progress branch now, so the work can go on on another machine if this turn ends\. Your checkout is on w1832-x with 2 uncommitted files and 0 unpushed commits\./);
  assert.match(sent[0][1], /take a new ticket: it goes to the back of the queue\.$/);
  w.handle('m5', [{ ...warning, deadline: now + 20 * 60_000 }]);
  assert.equal(sent.length, 2, 'a new deadline (a new waiter after a cancel) is a new warning');
  w.handle('m5', [{ ...warning, ticket: 't00000009', session: 'gone' }]);
  assert.equal(sent.length, 2, 'no message to a session the portal does not know');
});

test('w1832: an urgent release warning says the release has no cap', () => {
  const now = 1_800_000_000_000;
  const text = benchWarningText('beast', { ticket: 't00000002', session: 's', mode: 'shared', what: 'a build', deadline: now + 5 * 60_000, why: 'an urgent release takes the machine', release: true }, now);
  assert.match(text, /An urgent release takes the machine then: its build has no cap, so run your leg again after it is done\.$/);
  assert.doesNotMatch(text, /Your checkout/, 'no checkout state read: none said');
});

test('w1832: a machine that hosts a single worker is the one whose agent cap is 1', () => {
  const pool = (o: object) => ({ sandboxRoot: '/w', maxSandboxes: 1, maxAgentsPerSandbox: 1, ...o }) as Parameters<typeof agentCap>[0];
  assert.equal(agentCap(pool({})), 1);
  assert.equal(agentCap(pool({ maxSandboxes: 3, maxAgentsPerSandbox: 3, maxSandboxAgents: 1 })), 1);
  assert.equal(agentCap(pool({ maxSandboxes: 2 })), 2);
});

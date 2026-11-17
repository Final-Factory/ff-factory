import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptWhy, releaseStep, type PlaceFacts } from './placeAgain.ts';
import { resumeWhereLine, stopWhereLine } from './resumeWhere.ts';
import type { MachineSandbox, SessionInfo } from '../shared/types.ts';

// lothdesktop/slot2 at 17:33Z on 2026-11-17 (w4608): w4591's timed leg 5d876a0b stopped on purpose, w4397's FFU agent
// 663add42 mid-turn beside it on an agent seat (its work is not the game's, w1098).
const NOW = Date.parse('2026-11-17T17:33:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const worker = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  machineId: 'lothdesktop',
  machineSandbox: 'slot2',
  title: id,
  status: 'stopped',
  permissionMode: 'default',
  createdAt: iso(NOW - 3600_000),
  lastActivityAt: iso(NOW - 2 * 60_000),
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  ...over,
});
const slot2: MachineSandbox = {
  id: 'slot2',
  branch: 'sandbox/slot2-w4591',
  base: 'origin/master',
  path: 'V:/ffw/sandboxes/slot2',
  purpose: 'slot2',
  status: 'ready',
  createdAt: iso(NOW - 86_400_000),
  unity: { state: 'stopped' },
  sessionIds: ['5d876a0b', '663add42'],
  git: { branch: 'sandbox/slot2-w4591', dirty: 0, untracked: 0, at: iso(NOW - 60_000) },
};
const timedLeg = worker('5d876a0b', { releaseDue: { at: iso(NOW - 60_000), why: 'it was stopped on purpose', workedAt: iso(NOW - 2 * 60_000) } });
const ffu = worker('663add42', { status: 'running' });
const facts = (agentOnly: (s: SessionInfo) => boolean): PlaceFacts => ({ sessions: [timedLeg, ffu], live: (id) => id === '663add42', unityHolders: [], now: NOW, agentOnly });

test('w4608: an agent on a seat beside a stopped game worker keeps nothing, so its sandbox is released; a game agent there still keeps it', () => {
  const seated = facts((s) => s.id === '663add42');
  assert.equal(keptWhy(timedLeg, slot2, seated), undefined, 'the seated FFU agent works in its own clone');
  assert.equal(releaseStep(timedLeg, slot2, seated)?.do, 'release');
  const game = facts(() => false);
  assert.match(keptWhy(timedLeg, slot2, game) ?? '', /agent 663add42 works there too/, 'game work beside it shares the tree: kept');
  assert.equal(releaseStep(timedLeg, slot2, game), undefined);
});

const pathOf = (sb?: string) => (sb ? `V:/ffw/sandboxes/${sb}` : undefined);

test('w4608: message_agent says where a worker between turns resumes, and never a move that has not happened', () => {
  // What happened at 17:33Z: not released, so it ran in slot2 again. The reply now says so, and why.
  const stayed = resumeWhereLine({ sandbox: 'slot2', released: false, stay: 'agent 663add42 works there too, on the same branch' }, { machine: 'lothdesktop', sandbox: 'slot2', pathOf, released: false });
  assert.match(stayed, /resumes in lothdesktop\/slot2 \(V:\/ffw\/sandboxes\/slot2\), the sandbox it was in, NOT another: that sandbox was never released \(agent 663add42 works there too/);
  assert.match(resumeWhereLine({ sandbox: 'slot2', released: false }, { machine: 'lothdesktop', sandbox: 'slot2', pathOf, released: false }), /never released \(its release had not run yet\)/);
  // A move under way is not a move: it says where the worker still is.
  const moving = resumeWhereLine({ sandbox: 'slot2', released: true }, { machine: 'lothdesktop', sandbox: 'slot2', pathOf, released: true, placing: { machine: 'lothdesktop', sandbox: 'slot6' } });
  assert.match(moving, /^ Not moved yet: it is being placed again in lothdesktop\/slot6, and is still recorded in lothdesktop\/slot2/);
  assert.doesNotMatch(moving, /now runs in/);
  assert.match(resumeWhereLine({ sandbox: 'slot2', released: true }, { machine: 'lothdesktop', sandbox: 'slot2', pathOf, released: true }), /^ Not moved yet: it released lothdesktop\/slot2 .*waits to be placed again/);
  // Only a worker recorded in the new sandbox is reported there.
  assert.equal(resumeWhereLine({ sandbox: 'slot2', released: true }, { machine: 'lothdesktop', sandbox: 'slot6', pathOf, released: false }), ' Where: it now runs in lothdesktop/slot6 (V:/ffw/sandboxes/slot6) (it was in lothdesktop/slot2).');
  assert.match(resumeWhereLine({ sandbox: 'slot2', released: true }, { machine: 'lothdesktop', sandbox: 'slot2', pathOf, released: false }), /back in its own sandbox lothdesktop\/slot2/);
  assert.equal(resumeWhereLine({ released: false }, { machine: 'lothdesktop', pathOf, released: false }), '');
});

test('w4608: stop_agent says whether the sandbox is released, and that a message before then resumes it there', () => {
  assert.match(stopWhereLine('lothdesktop', 'slot2', false, 'agent 1c3019b6 works there too, on the same branch'), /not released: agent 1c3019b6 .*resumes it in lothdesktop\/slot2, not in another sandbox/);
  assert.match(stopWhereLine('lothdesktop', 'slot2', false, undefined), /released by the next release pass .*a message before resumes it in lothdesktop\/slot2/);
  assert.match(stopWhereLine('lothdesktop', 'slot2', true, undefined), /had released lothdesktop\/slot2/);
  assert.equal(stopWhereLine(undefined, undefined, false, undefined), '');
});

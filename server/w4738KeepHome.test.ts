import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_MARK, HOME_WAIT_MS, ONE_EDITOR, homeWait, moveDecision, type MoveFacts, type MoveRequest } from './resumeMove.ts';
import { needsUi } from '../shared/capacity.ts';
import type { Computer } from './placement.ts';
import type { WorkItem } from '../shared/types.ts';

// w4738 (r290 fix 4): w4488's next step moved lothdesktop -> m5 at 14:11:46Z and m5 -> biscuit at 15:34:27Z on 2026-11-17, each
// a w2046 room move 31 to 43 s after its message, of a worker released while it waited (a pair run's partner, then CI).
const NOW = Date.parse('2026-11-17T15:34:27Z');
const MIN = 60_000;

test('a worker released while it waited waits up to HOME_WAIT_MS for its own computer, then moves as before', () => {
  const queued = NOW - 31_000;
  const line = homeWait({ wait: true }, queued, NOW);
  assert.ok(line?.startsWith(HOME_MARK), line ?? 'no line');
  assert.match(line!, /\(w4738\)/, 'the ledger reads the mark: not WRONG');
  assert.match(line!, /at 15:48Z/, 'it names when it moves');
  assert.equal(homeWait({ wait: true }, queued, queued + HOME_WAIT_MS), undefined, 'past the wait it moves');
  assert.equal(homeWait({ wait: true }, queued, queued + HOME_WAIT_MS - 1) !== undefined, true);
  // Released idle or with a far check-in (no wait flag), or never released: the move goes at once, as before (w2046).
  assert.equal(homeWait({}, queued, NOW), undefined);
  assert.equal(homeWait(undefined, queued, NOW), undefined);
  // 15 min covers every sandbox that freed on the computer a move left that day (1 to 12.1 min, the portal journal).
  assert.equal(HOME_WAIT_MS, 15 * MIN);
});

const pc = (id: string, over: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 3, maxSandboxes: 3, freeSandboxes: 1, platform: 'win32', maxEditors: 3, ...over });
// 15:34Z on 2026-11-17: m5 full, biscuit (one Unity slot) with a free sandbox.
const M5 = pc('m5', { platform: 'darwin', freeSandboxes: 0, maxEditors: 2 });
const BISCUIT = pc('biscuit', { sandboxes: 2, maxSandboxes: 2, maxAgents: 4, maxEditors: 1 });
const LOTH = pc('lothdesktop');
const req = (over: Partial<MoveRequest> = {}): MoveRequest => ({ id: 'w4488', priority: 'high', kind: 'game', ...over });
const facts = (over: Partial<MoveFacts> = {}): MoveFacts => ({
  machine: 'm5',
  released: true,
  branch: 'w4488-stills',
  canSave: true,
  requests: [req({ ui: true })],
  places: [M5, BISCUIT, LOTH],
  prefs: { prefer: ['m5', 'biscuit', 'lothdesktop'] },
  ...over,
});

test('UI-heavy work moves past a one-Unity-slot computer to one that fits, even when that one is preferred first', () => {
  const d = moveDecision(facts());
  assert.ok('move' in d, JSON.stringify(d));
  assert.equal(d.move.to, 'lothdesktop');
});

test('UI-heavy work waits rather than moving to a one-Unity-slot computer that alone has room, and says why', () => {
  const d = moveDecision(facts({ places: [M5, BISCUIT, { ...LOTH, freeSandboxes: 0 }] }));
  assert.ok('none' in d, JSON.stringify(d));
  assert.match(d.none, new RegExp(`biscuit: ${ONE_EDITOR.replace(/[()]/g, '\\$&')}`));
  assert.match(d.none, /\(w4738\)/);
});

test('work that is not UI-heavy still moves to a one-Unity-slot computer, and an away computer\'s UI work may when nothing else fits', () => {
  const plain = moveDecision(facts({ requests: [req()], places: [M5, BISCUIT, { ...LOTH, freeSandboxes: 0 }] }));
  assert.ok('move' in plain && plain.move.to === 'biscuit', JSON.stringify(plain));
  const away = moveDecision(facts({ away: 'm5 (offline 6 min)', places: [M5, BISCUIT, { ...LOTH, freeSandboxes: 0 }] }));
  assert.ok('move' in away && away.move.to === 'biscuit', JSON.stringify(away));
  // Agent-slot work runs no editor: the rule is game work's.
  const agent = moveDecision(facts({ requests: [req({ kind: 'agent', ui: true })], places: [M5, BISCUIT, { ...LOTH, freeSandboxes: 0, live: 6 }] }));
  assert.ok('move' in agent && agent.move.to === 'biscuit', JSON.stringify(agent));
});

const item = (over: Partial<WorkItem>) => ({ title: '', brief: '', notes: [], ...over }) as Pick<WorkItem, 'needs' | 'liveView' | 'title' | 'brief' | 'notes'>;

test('needsUi: stills, the UI gate\'s tools, play mode, a Live view or "UI" in capitals on game work; not agent work, nor "ui" in a word', () => {
  // w4488's brief (2026-11-17) named stills, ui_look/ui_layout and the ui-critic.
  assert.equal(needsUi(item({ title: 'w4488: research panel', brief: 'take stills with ui_look/ui_layout and run a fresh ui-critic' })), true);
  assert.equal(needsUi(item({ brief: 'verify it in play mode' })), true);
  assert.equal(needsUi(item({ brief: 'the build menu UI overlaps' })), true);
  assert.equal(needsUi(item({ liveView: { at: '2026-11-17T15:00:00Z', session: 'c1da3cb0', machine: 'lothdesktop' } })), true);
  assert.equal(needsUi(item({ brief: 'fix the save upgrade step' })), false);
  assert.equal(needsUi(item({ brief: 'edit server/guide.ts and its build' })), false);
  assert.equal(needsUi(item({ needs: 'agent', brief: 'take stills of the portal' })), false);
});

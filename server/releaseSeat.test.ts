import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEAT_GIVE_UP_MS, SEAT_GRACE_MS, seatAction, seatNotice, type Seat, type SeatFacts } from './releaseSeat.ts';
import type { MachineSandbox, SessionInfo } from '../shared/types.ts';

/**
 * w1668, lothsahn: "Let's make sure that urgent builds always get scheduled in slot1 on whatever machine they run in so that it
 * uses caches as warm as possible." The builder moves into slot1; slot1's other game work goes to other sandboxes.
 */

const T0 = Date.parse('2026-10-21T08:00:00Z');

const sess = (id: string, sandbox: string, o: Partial<SessionInfo> = {}) =>
  ({ id, kind: 'worker', machineId: 'lothdesktop', machineSandbox: sandbox, status: 'idle', pendingPermissions: [], turns: 3, createdAt: '2026-10-21T06:00:00Z', lastActivityAt: '2026-10-21T07:59:00Z', ...o }) as unknown as SessionInfo;

const slot1 = (o: Partial<MachineSandbox> = {}) =>
  ({ id: 'slot1', status: 'ready', sessionIds: [], unity: { state: 'stopped' }, git: { branch: 'w1650-nightly', dirty: 0, untracked: 0 }, ...o }) as unknown as MachineSandbox;

function facts(o: { builder?: SessionInfo; target?: MachineSandbox | null; others?: SessionInfo[]; live?: string[]; mid?: string[]; agentOnly?: string[]; holders?: string[]; seat?: Partial<Seat>; now?: number } = {}): SeatFacts {
  return {
    builder: o.builder ?? sess('builder', 'slot3'),
    target: o.target === null ? undefined : (o.target ?? slot1()),
    others: o.others ?? [],
    live: (id) => (o.live ?? []).includes(id),
    midTurn: (s) => (o.mid ?? []).includes(s.id),
    agentOnly: (s) => (o.agentOnly ?? []).includes(s.id),
    unityHolders: o.holders ?? [],
    seat: { sandbox: 'slot1', since: T0, told: {}, ...o.seat },
    now: o.now ?? T0,
  };
}

test('w1668: a builder already in slot1, or a computer without one, has nothing to move', () => {
  assert.deepEqual(seatAction(facts({ builder: sess('builder', 'slot1') })), { do: 'done', why: 'the builder is in lothdesktop/slot1' });
  assert.match((seatAction(facts({ target: null })) as { why: string }).why, /^there is no slot1 on lothdesktop: the build runs where its builder is$/);
});

test('w1668: slot1 empty and the builder stopped: it is moved; live between turns it is stopped first; mid-turn it is waited for', () => {
  assert.deepEqual(seatAction(facts()), { do: 'move' });
  assert.deepEqual(seatAction(facts({ live: ['builder'] })), { do: 'stop-builder' });
  assert.deepEqual(seatAction(facts({ live: ['builder'], mid: ['builder'] })), { do: 'wait', why: 'the builder is mid-turn: it moves once its turn ends' });
});

test('w1668: the busy-slot1 case: a worker mid-turn there is asked first, stopped after the grace; one between turns is stopped; a stopped one is released, its work saved', () => {
  const nightly = sess('nightly', 'slot1', { status: 'running' });
  // Mid-turn: asked once to commit, push and end its turn; nothing moves yet.
  let a = seatAction(facts({ others: [nightly], live: ['nightly'], mid: ['nightly'] }));
  assert.deepEqual(a, { do: 'clear', steps: [{ do: 'tell', id: 'nightly' }], why: 'nightly is mid-turn there' });
  // Within the grace it is waited for; past it, stopped (lothsahn, w1656: "It was supposed to kick work off the machine").
  a = seatAction(facts({ others: [nightly], live: ['nightly'], mid: ['nightly'], seat: { told: { nightly: T0 } }, now: T0 + SEAT_GRACE_MS - 1000 }));
  assert.equal(a.do, 'wait');
  a = seatAction(facts({ others: [nightly], live: ['nightly'], mid: ['nightly'], seat: { told: { nightly: T0 } }, now: T0 + SEAT_GRACE_MS }));
  assert.deepEqual(a.do === 'clear' && a.steps, [{ do: 'interrupt', id: 'nightly' }]);
  // Between turns with its process up: stopped at once.
  a = seatAction(facts({ others: [sess('nightly', 'slot1')], live: ['nightly'] }));
  assert.deepEqual(a.do === 'clear' && a.steps, [{ do: 'stop', id: 'nightly' }]);
  // Stopped: its sandbox is released for it, its uncommitted work saved on its branch first.
  a = seatAction(facts({ others: [sess('nightly', 'slot1', { status: 'stopped' })], target: slot1({ git: { branch: 'w1650-nightly', dirty: 2, untracked: 1 } } as Partial<MachineSandbox>) }));
  assert.deepEqual(a, { do: 'clear', steps: [{ do: 'release', id: 'nightly', branch: 'w1650-nightly', save: true }], why: 'emptying it' });
  // Released already: slot1 counts as empty, and the builder moves.
  assert.deepEqual(seatAction(facts({ others: [sess('nightly', 'slot1', { status: 'stopped', placeReleased: { at: '', sandbox: 'slot1', branch: 'w1650-nightly', why: 'x' } })] })), { do: 'move' });
});

test('w1668: work that needs only an agent seat stays beside the build; a Unity batch run in slot1 is waited for, and after 10 minutes the builder builds where it is', () => {
  const ffw = sess('ffwork', 'slot1', { status: 'running' });
  assert.deepEqual(seatAction(facts({ others: [ffw], live: ['ffwork'], mid: ['ffwork'], agentOnly: ['ffwork'] })), { do: 'move' });
  assert.deepEqual(seatAction(facts({ holders: ['sandbox:slot1'] })), { do: 'wait', why: 'a Unity batch run of slot1 is in flight' });
  assert.deepEqual(seatAction(facts({ holders: ['sandbox:slot2'] })), { do: 'move' });
  const late = seatAction(facts({ holders: ['sandbox:slot1'], now: T0 + SEAT_GIVE_UP_MS }));
  assert.deepEqual(late, { do: 'give-up', why: 'slot1 was not free after 10 min: a Unity batch run of slot1 is in flight' });
  // A sandbox being trimmed or made is not switched under.
  assert.match((seatAction(facts({ target: slot1({ status: 'cleanup', statusDetail: 'trimming the Library caches (released)' } as Partial<MachineSandbox>) })) as { why: string }).why, /^slot1 is cleanup \(trimming the Library caches/);
});

test('w1668: the notice to a worker in slot1 names the build, the grace and where it resumes', () => {
  const n = seatNotice('lothdesktop', 'slot1', '1.0.0.5 urgent release');
  assert.match(n, /^\[FF Factory\] URGENT RELEASE \(w1668\): 1\.0\.0\.5 urgent release builds in lothdesktop\/slot1, this sandbox/);
  assert.match(n, /end your turn within 2 minutes; after that FF Factory stops you/);
  assert.match(n, /you resume in another sandbox on lothdesktop, on your branch/);
});

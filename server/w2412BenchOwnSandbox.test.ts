import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BenchTurn, holderSandboxes, holdsSandbox, type BenchTurnDeps, type Holder, type TurnEditor, type TurnPlayer } from '../machine/benchTurn.ts';
import { BenchWarner } from './benchWarnings.ts';
import type { BenchWarning, SessionInfo } from '../shared/types.ts';

/**
 * w2412 (lothsahn, 2026-10-27: "during a worker's own exclusive bench ticket, FF Factory must leave that worker's own sandbox
 * editor open"): on biscuit worker edc18110 (w2338), placed again in slot2 after slot3 (w2046), had its own slot2 editor
 * closed at the grant of its exclusive tickets t00002451 and t00002458. The holder's own sandboxes are its ticket's, the one
 * its checkout (cwd) is in, and the one its worker session runs in now.
 */

const T0 = Date.parse('2026-10-27T12:37:59Z');
const SANDBOXES = [1, 2, 3, 4].map((n) => ({ id: `slot${n}`, path: `/home/ben-ryding/ffw/sandboxes/slot${n}` }));

test('w2412: the holder owns the sandbox its checkout is in and the one its session runs in, besides its ticket sandbox', () => {
  assert.deepEqual(holderSandboxes({ sandbox: 'slot3', cwd: '/home/ben-ryding/ffw/sandboxes/slot2/scripts', session: 'edc18110' }, SANDBOXES, []), ['slot2'], 'the checkout it took the ticket in');
  assert.deepEqual(holderSandboxes({ sandbox: 'slot3', session: 'edc18110' }, SANDBOXES, [{ session: 'edc18110', sandbox: 'slot2' }, { session: 'other', sandbox: 'slot4' }]), ['slot2'], 'where its session runs now; not another worker sandbox');
  assert.deepEqual(holderSandboxes({ sandbox: undefined, session: 'edc18110' }, SANDBOXES, [{ session: 'edc18110', sandbox: 'slot2' }]), ['slot2'], 'a ticket taken with no sandbox (timed_run)');
  assert.deepEqual(holderSandboxes({ sandbox: 'slot2', cwd: '/home/ben-ryding/ffw/sandboxes/slot2', session: 'edc18110' }, SANDBOXES, [{ session: 'edc18110', sandbox: 'slot2' }]), [], 'nothing besides its ticket sandbox');
  assert.deepEqual(holderSandboxes({ cwd: '/home/ben-ryding/ffw/sandboxes/slot22' }, SANDBOXES, []), [], 'slot22 is not inside slot2');
  assert.deepEqual(holderSandboxes({ cwd: 'F:\\ffw\\Sandboxes\\slot2\\Assets' }, [{ id: 'slot2', path: 'F:/ffw/sandboxes/slot2/' }], []), ['slot2'], 'Windows: any case, either slash');
  assert.equal(holdsSandbox({ sandbox: 'slot3', own: ['slot2'] }, 'slot2'), true);
  assert.equal(holdsSandbox({ sandbox: 'slot3', own: ['slot2'] }, 'slot3'), true);
  assert.equal(holdsSandbox({ sandbox: 'slot3', own: ['slot2'] }, 'slot1'), false);
  assert.equal(holdsSandbox({ sandbox: undefined }, undefined), false);
});

function harness(editors: TurnEditor[], players: TurnPlayer[]) {
  const s = { holder: undefined as Holder | undefined, now: T0, editors, players, closed: new Map<string, { at: number; ticket: string }>(), calls: [] as string[], marks: [] as Record<string, string>[] };
  const d: BenchTurnDeps = {
    holder: () => s.holder,
    editors: () => s.editors,
    closed: () => [...s.closed].map(([id, c]) => ({ id, ...c, starting: false })),
    players: () => s.players,
    procs: async () => s.players.map((p) => ({ pid: p.pid, ppid: 1, cmd: '' })),
    closeEditor: async (id, _by, ticket) => {
      s.calls.push(`close ${id}`);
      s.closed.set(id, { at: s.now, ticket });
      s.editors = s.editors.map((e) => (e.id === id ? { ...e, running: false, pid: undefined } : e));
      return { closed: true, text: 'closed' };
    },
    reopenEditor: async (id) => {
      s.calls.push(`reopen ${id}`);
      s.closed.delete(id);
      return 'Queued';
    },
    closePlayer: async (pid) => {
      s.calls.push(`quit player ${pid}`);
      return 'asked';
    },
    notePlayer: () => {},
    writeClosed: (m) => s.marks.push(m),
    log: () => {},
    now: () => s.now,
  };
  return { s, turn: new BenchTurn(d) };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

function moved(over: Partial<Holder> = {}): Holder {
  // its ticket names slot3, the sandbox it started in; it works in slot2 now
  return { ticket: 't00002451', mode: 'exclusive', what: 'w2338 Leech probe', pid: 900, host: 'biscuit', sandbox: 'slot3', session: 'edc18110', requests: ['w2338'], granted: { at: 'x', ts: T0 / 1000 }, ownerPid: 800, until: T0 + 30 * 60_000, own: ['slot2'], ...over };
}

test('w2412: a holder placed again in another sandbox keeps its own editor and players; the other workers ones are still quieted', async () => {
  const { s, turn } = harness(
    [
      { id: 'slot1', running: true, pid: 101 }, // another worker's
      { id: 'slot2', running: true, pid: 102 }, // the holder's own, where it works now
      { id: 'slot3', running: true, pid: 103 }, // the sandbox it left: another worker's now
      { id: 'slot4', running: true, pid: 104 },
    ],
    [
      { pid: 201, session: 'aa11', sandbox: 'slot1', slot: 'slot1-0' },
      { pid: 202, sandbox: 'slot2', slot: 'slot2-0' }, // the holder's timed player, from its slot2 checkout
      { pid: 203, session: 'bb22', sandbox: 'slot3', slot: 'slot3-0' },
    ],
  );
  s.holder = moved({ sandbox: undefined, own: ['slot2'] }); // a ticket with no sandbox: owns only where it runs
  await turn.tick();
  await settle();
  assert.deepEqual(s.calls.sort(), ['close slot1', 'close slot3', 'close slot4', 'quit player 201', 'quit player 203'].sort(), 'slot2 and its player are left');
  s.now += 5_000;
  await turn.tick();
  assert.deepEqual(Object.keys(s.marks.at(-1)!).sort(), ['slot1', 'slot3', 'slot4'], "no refusal of the holder's own editor's Unity MCP calls");
});

test("w2412: a holder's own editor closed by an earlier turn (before it moved there) reopens for its own run", async () => {
  const { s, turn } = harness([{ id: 'slot1', running: true, pid: 101 }, { id: 'slot2', running: false }], []);
  s.closed.set('slot2', { at: T0 - 60_000, ticket: 't00002451' });
  s.holder = moved();
  await turn.tick();
  await settle();
  assert.deepEqual(s.calls.sort(), ['close slot1', 'reopen slot2'].sort());
});

test('w2412: without the session placement the old rule stands: a ticket naming another sandbox closes this one (the bug)', async () => {
  const { s, turn } = harness([{ id: 'slot2', running: true, pid: 102 }], []);
  s.holder = moved({ own: undefined });
  await turn.tick();
  await settle();
  assert.deepEqual(s.calls, ['close slot2'], 'what biscuit did at 06:38 (-06:00) to t00002451');
});

test("w2412: an editor's own life ticket (editor:<sandbox>) is warned with no 'no session' line and no message", () => {
  const sent: string[] = [];
  const log: string[] = [];
  const now = T0;
  const w = new BenchWarner({ session: () => ({ id: 'x' }) as SessionInfo, send: (id) => sent.push(id), log: (l) => log.push(l), now: () => now });
  const life: BenchWarning = { ticket: 't00002454', session: 'editor:slot2', mode: 'shared', what: 'running editor slot2', deadline: now + 5 * 60_000, why: 'an exclusive ticket waits' };
  w.handle('biscuit', [life]);
  w.handle('biscuit', [life]);
  assert.deepEqual(sent, []);
  assert.equal(log.length, 1, 'logged once');
  assert.match(log[0], /t00002454 on biscuit: it is the slot2 editor's own ticket \(w1962\)/);
});

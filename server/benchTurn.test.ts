import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { timedHolder } from '../machine/benchLock.ts';
import { askPlayerToQuit, BenchTurn, closedRefusalFor, descendsFrom, holderText, PLAYER_ASK_AGAIN_MS, TURN_RETRY_MS, writeClosedFile, type BenchTurnDeps, type Holder, type TurnEditor, type TurnPlayer } from '../machine/benchTurn.ts';
import { sandboxGuard } from './guard.ts';

/**
 * w1829 (lothsahn, 2026-10-23: "When the exclusive lock is held, only that worker should be running. Players, editors, and
 * other work should shutdown to allow for proper timing"; "The locking should be a positive control that manages the worker
 * and it's slots"): while another worker's exclusive ticket holds the lock, the daemon closes the other sandboxes' editors
 * (saved through the editor, never killed) and asks the other workers' players to quit, keeps the closed editors' Unity MCP
 * calls refused with the reason, and reopens them when the ticket goes: released, its holder killed, or past its bound.
 */

const T0 = Date.parse('2026-10-23T09:00:00Z');

function holder(over: Partial<Holder> = {}): Holder {
  return { ticket: 't00000042', mode: 'exclusive', what: 'justplay fps A', pid: 900, host: 'lothdesktop', sandbox: 'slot3', session: 'dec9a619', requests: ['w1785'], granted: { at: 'x', ts: T0 / 1000 }, maxMin: 60, ownerPid: 800, until: T0 + 60 * 60_000, ...over };
}

function harness(o: { editors: TurnEditor[]; players?: TurnPlayer[]; procs?: { pid: number; ppid: number }[] }) {
  const s = {
    holder: undefined as Holder | undefined,
    now: T0,
    editors: o.editors,
    players: o.players ?? [],
    closed: new Map<string, { at: number; ticket: string; reopenAt?: number }>(),
    /** What the next close of each sandbox answers. */
    closeAnswer: new Map<string, { closed: boolean; text: string }>(),
    reopenFails: new Set<string>(),
    /** Sandboxes whose start is asked for but whose editor does not run yet (the mark stays), and those queued or booting. */
    reopenStays: new Set<string>(),
    starting: new Set<string>(),
    /** Players gone from a fresh listing (their pid may be another program's now). */
    gone: new Set<number>(),
    procCalls: 0,
    calls: [] as string[],
    marks: [] as Record<string, string>[],
    notes: [] as [string, string][],
    log: [] as string[],
  };
  const d: BenchTurnDeps = {
    holder: () => s.holder,
    editors: () => s.editors,
    closed: () => [...s.closed].map(([id, c]) => ({ id, ...c, starting: s.starting.has(id) })),
    players: () => s.players,
    procs: async () => {
      s.procCalls++;
      return [...(o.procs ?? []), ...s.players.filter((p) => !s.gone.has(p.pid)).map((p) => ({ pid: p.pid, ppid: 1 }))].map((p) => ({ ...p, cmd: '' }));
    },
    closeEditor: async (id, by, ticket) => {
      s.calls.push(`close ${id} for ${by}`);
      const a = s.closeAnswer.get(id) ?? { closed: true, text: 'closed (nothing unsaved in its scenes; assets saved)' };
      if (a.closed) {
        s.closed.set(id, { at: s.now, ticket });
        s.editors = s.editors.map((e) => (e.id === id ? { ...e, running: false, pid: undefined } : e));
      }
      return a;
    },
    reopenEditor: async (id) => {
      s.calls.push(`reopen ${id}`);
      if (s.reopenFails.has(id)) throw new Error('not started: disk space is low');
      if (s.reopenStays.has(id)) s.closed.set(id, { ...s.closed.get(id)!, reopenAt: s.now });
      else s.closed.delete(id); // the next look sees it run
      return 'Queued (w1615): ...';
    },
    closePlayer: async (pid) => {
      s.calls.push(`quit player ${pid}`);
      return 'its window was asked to close';
    },
    notePlayer: (session, text) => s.notes.push([session, text]),
    writeClosed: (m) => s.marks.push(m),
    log: (l) => s.log.push(l),
    now: () => s.now,
  };
  return { s, turn: new BenchTurn(d) };
}

/** Let the closes the tick started (each on its own) finish. */
const settle = () => new Promise((r) => setTimeout(r, 10));

test('w1829: a granted exclusive ticket closes every other sandbox editor and asks the other workers players to quit; the holder, what its script started and a persons game are left', async () => {
  const { s, turn } = harness({
    editors: [
      { id: 'slot1', running: true, pid: 101 },
      { id: 'slot2', running: true, pid: 102 },
      { id: 'slot3', running: true, pid: 103 }, // the holder's own sandbox
      { id: 'slot4', running: false }, // stopped: nothing to close
      { id: 'slot5', running: true, pid: 105 }, // started by the holder's script (a peer editor of its run)
    ],
    players: [
      { pid: 201, session: 'aa11', sandbox: 'slot1', slot: 'slot1-0' },
      { pid: 202, sandbox: 'slot3', slot: 'slot3-0' }, // the holder's timed player
      { pid: 203 }, // no slot, no session: a person's game
      { pid: 204, session: 'dec9a619' }, // the holder's session
      { pid: 205, slot: 'slot2-1' },
    ],
    procs: [
      { pid: 105, ppid: 801 },
      { pid: 801, ppid: 800 },
    ],
  });
  await turn.tick();
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.marks, [{}], 'no turn: the guard file says nothing is closed');
  s.holder = holder();
  await turn.tick();
  await settle();
  const by = 'a timed run on lothdesktop/slot3 (w1785)';
  assert.equal(holderText(s.holder), by);
  assert.deepEqual(s.calls.sort(), [`close slot1 for ${by}`, `close slot2 for ${by}`, 'quit player 201', 'quit player 205'].sort());
  assert.deepEqual(s.notes.map((n) => n[0]), ['aa11'], "the player's worker hears why at its next message");
  assert.match(s.notes[0][1], /asked to quit at 09:00Z for a timed run on lothdesktop\/slot3 \(w1785\)/);
  // The next look writes the guard's refusals for the closed editors, and asks nothing twice.
  s.calls.length = 0;
  s.now += 5_000;
  await turn.tick();
  assert.deepEqual(s.calls, []);
  assert.deepEqual(Object.keys(s.marks.at(-1)!).sort(), ['slot1', 'slot2']);
  assert.match(s.marks.at(-1)!.slot1, /^Your sandbox's Unity editor was closed at 09:00Z for a timed run on lothdesktop\/slot3 \(w1785\).*by 10:00Z at the latest/);
  // A player that still runs after PLAYER_ASK_AGAIN_MS is asked again (never forced).
  s.now += PLAYER_ASK_AGAIN_MS;
  await turn.tick();
  assert.deepEqual(s.calls.sort(), ['quit player 201', 'quit player 205']);
  assert.ok(s.log.some((l) => /player pid 201 .*still runs, asked to quit again/.test(l)));
});

test('w1829: an editor that comes up during the turn is closed too; a skipped close is tried again after TURN_RETRY_MS', async () => {
  const { s, turn } = harness({ editors: [{ id: 'slot1', running: true, pid: 101 }] });
  s.holder = holder();
  s.closeAnswer.set('slot1', { closed: false, text: 'skipped: it is compiling or importing' });
  await turn.tick();
  await settle();
  assert.deepEqual(s.calls, ['close slot1 for a timed run on lothdesktop/slot3 (w1785)']);
  s.now += 5_000;
  await turn.tick();
  await settle();
  assert.equal(s.calls.length, 1, 'not again before the retry time');
  s.closeAnswer.delete('slot1');
  s.now += TURN_RETRY_MS;
  await turn.tick();
  await settle();
  assert.equal(s.calls.length, 2, 'tried again, and closed');
  assert.deepEqual([...s.closed.keys()], ['slot1']);
  // Started again meanwhile (a start that did not queue): the positive control closes it once more.
  s.editors = [{ id: 'slot1', running: true, pid: 111 }];
  s.closed.delete('slot1');
  s.calls.length = 0;
  s.now += 5_000;
  await turn.tick();
  await settle();
  assert.deepEqual(s.calls, ['close slot1 for a timed run on lothdesktop/slot3 (w1785)']);
});

test('w1829: when the ticket goes, every editor the turn closed starts again; a start that fails is tried again, and the guard file is emptied', async () => {
  const { s, turn } = harness({ editors: [{ id: 'slot1', running: true, pid: 101 }, { id: 'slot2', running: true, pid: 102 }] });
  s.holder = holder();
  await turn.tick();
  await settle();
  await turn.tick();
  assert.deepEqual([...s.closed.keys()].sort(), ['slot1', 'slot2']);
  s.holder = undefined; // released, its holder killed, or past its bound: timedHolder answers undefined for all three
  s.reopenFails.add('slot2');
  s.calls.length = 0;
  await turn.tick();
  assert.deepEqual(s.calls, ['reopen slot1', 'reopen slot2']);
  assert.deepEqual(s.marks.at(-1), {}, 'the guard lets Unity MCP calls through again');
  assert.deepEqual([...s.closed.keys()], ['slot2']);
  s.calls.length = 0;
  s.now += 5_000;
  await turn.tick();
  assert.deepEqual(s.calls, [], 'not again before the retry time');
  s.reopenFails.clear();
  s.now += TURN_RETRY_MS;
  await turn.tick();
  assert.deepEqual(s.calls, ['reopen slot2']);
  assert.equal(s.closed.size, 0, 'nothing is left closed');
  assert.ok(s.log.some((l) => /bench turn: t00000042 ended: reopening/.test(l)));
});

test('w1829: a daemon restarted with editors still marked closed and no turn reopens them at its first look', async () => {
  const { s, turn } = harness({ editors: [{ id: 'slot1', running: false }] });
  s.closed.set('slot1', { at: T0 - 60_000, ticket: 't00000041' }); // kept in sandboxes.json across the restart
  await turn.tick();
  assert.deepEqual(s.calls, ['reopen slot1']);
});

test('w1829: the next timed run granted before a look saw the lock free ends the last turn: its editors are reopened (queued behind it), and the new holder own sandbox is never kept closed for its own run', async () => {
  const { s, turn } = harness({ editors: [{ id: 'slot1', running: true, pid: 101 }, { id: 'slot2', running: true, pid: 102 }] });
  s.holder = holder(); // A, on slot3
  await turn.tick();
  await settle();
  assert.deepEqual([...s.closed.keys()].sort(), ['slot1', 'slot2']);
  s.reopenStays.add('slot1').add('slot2'); // their starts queue behind B: not running yet
  s.holder = holder({ ticket: 't00000043', sandbox: 'slot1', session: 'bb22', requests: ['w1900'], ownerPid: 810 }); // B, slot1's own run
  s.calls.length = 0;
  await turn.tick();
  await settle();
  assert.deepEqual(s.calls, ['reopen slot1', 'reopen slot2']);
  assert.deepEqual(Object.keys(s.marks.at(-1)!), ['slot2'], "B's holder can call its own editor; slot2 stays refused until it runs");
  assert.match(s.marks.at(-1)!.slot2, /for a timed run on lothdesktop\/slot1 \(w1900\)/);
  // Queued: not asked again while it waits; a start not made (no longer queued, still not running) is asked again.
  s.starting.add('slot2');
  s.calls.length = 0;
  s.now += TURN_RETRY_MS + 1;
  await turn.tick();
  assert.deepEqual(s.calls.filter((c) => c.startsWith('reopen')), ['reopen slot1'], 'slot1 (not queued in this stand-in) is asked again; queued slot2 is not');
  s.starting.delete('slot2');
  s.calls.length = 0;
  s.now += TURN_RETRY_MS + 1;
  await turn.tick();
  assert.deepEqual(s.calls.sort(), ['reopen slot1', 'reopen slot2']);
});

test('w1829: a holder with no worker session asks no player to quit (its own were started detached); a player gone from a fresh listing is not asked; nothing to handle lists no processes', async () => {
  const { s, turn } = harness({ editors: [], players: [{ pid: 201, session: 'aa11', sandbox: 'slot1', slot: 'slot1-0' }, { pid: 206, slot: 'repo-0' }] });
  s.holder = holder({ session: undefined, sandbox: undefined, host: 'lothdesktop' });
  await turn.tick();
  assert.deepEqual(s.calls, []);
  assert.equal(s.procCalls, 0, 'no editor and no player to handle: no process listing beside the timed run');
  assert.ok(s.log.some((l) => /has no worker session: other players are left running/.test(l)));
  s.holder = holder({ ticket: 't00000044' });
  s.gone.add(201);
  await turn.tick();
  assert.deepEqual(s.calls, ['quit player 206'], 'pid 201 is no game player any more');
});

function queue(t: { after: (f: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1829-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const qdir = path.join(root, 'tmp', 'bench.queue');
  const add = (name: string, info: Record<string, unknown>, grantedTs?: number) => {
    fs.mkdirSync(path.join(qdir, name), { recursive: true });
    fs.writeFileSync(path.join(qdir, name, 'info.json'), JSON.stringify({ ticket: name, mode: 'exclusive', pid: 4242, max_min: 60, ...info }));
    if (grantedTs !== undefined) fs.writeFileSync(path.join(qdir, name, 'granted'), JSON.stringify({ at: 'x', ts: grantedTs }));
  };
  return { root, qdir, add };
}

test('w1829: timedHolder: a granted exclusive ticket whose helper lives, inside its bound; a killed holder, a revoked or overdue one, a waiting or shared one is none', (t) => {
  const q = queue(t);
  const now = T0 + 10 * 60_000;
  q.add('t00000001', { mode: 'shared', session: 'aa' }, T0 / 1000);
  q.add('t00000002', { session: 'dec9a619', sandbox: 'slot3', host: 'lothdesktop', owner_pid: 7000, owner_check_pid: 7001 });
  assert.equal(timedHolder(q.root, now, () => true), undefined, 'a shared hold and a waiting timed ticket are no turn');
  fs.writeFileSync(path.join(q.qdir, 't00000002', 'granted'), JSON.stringify({ at: 'x', ts: T0 / 1000 }));
  const h = timedHolder(q.root, now, () => true);
  assert.equal(h?.ticket, 't00000002');
  assert.equal(h?.ownerPid, 7001, "the Windows pid of a Git Bash script's owner");
  assert.equal(h?.until, T0 + 60 * 60_000);
  assert.equal(timedHolder(q.root, now, () => false), undefined, 'its holder killed: the helper dies with it, and the turn ends');
  assert.equal(timedHolder(q.root, T0 + 60 * 60_000, () => true), undefined, 'past its bound');
  fs.writeFileSync(path.join(q.qdir, 't00000002', 'revoked'), JSON.stringify({ at: 'x', why: 'over the bound' }));
  assert.equal(timedHolder(q.root, now, () => true), undefined, 'revoked');
  assert.equal(timedHolder(undefined, now, () => true), undefined, 'no worker root');
});

test('w1829: the guard refuses a Unity MCP call into an editor a turn keeps closed, with the reason, from the file the daemon writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1829g-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hook = sandboxGuard({ sandboxId: 'slot1', sandboxPath: '/v/ffw/sandboxes/slot1', protectedPaths: [], benchClosed: () => closedRefusalFor(root, 'slot1') });
  const ask = (tool_name: string, tool_input: Record<string, unknown>) =>
    hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: '/v/ffw/sandboxes/slot1', session_id: 's', transcript_path: '' } as never, undefined, { signal: new AbortController().signal }) as Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
  const pin = { instance: 'slot1@f54708e0' };
  assert.notEqual((await ask('mcp__UnityMCP__set_active_instance', pin)).hookSpecificOutput?.permissionDecision, 'deny', 'no file: nothing closed');
  writeClosedFile(root, { slot1: "Your sandbox's Unity editor was closed at 09:00Z for a timed run on lothdesktop/slot3 (w1785) ..." });
  const r = await ask('mcp__UnityMCP__refresh_unity', {});
  assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(r.hookSpecificOutput?.permissionDecisionReason ?? '', /closed at 09:00Z for a timed run on lothdesktop\/slot3/);
  assert.notEqual((await ask('Bash', { command: 'git status' })).hookSpecificOutput?.permissionDecision, 'deny', "the worker's own shell keeps running");
  writeClosedFile(root, { slot2: 'x' });
  assert.notEqual((await ask('mcp__UnityMCP__refresh_unity', {})).hookSpecificOutput?.permissionDecision, 'deny', "another sandbox's mark is not this one's");
  writeClosedFile(root, {});
  assert.equal(closedRefusalFor(root, 'slot1'), undefined);
});

test('w1829: a player is asked to quit the way a person closes it: taskkill without /F on Windows, SIGTERM elsewhere; a refusal leaves it running', async () => {
  const calls: string[][] = [];
  const ok = await askPlayerToQuit(4321, 'win32', async (c, a) => (calls.push([c, ...a]), { code: 0, stdout: 'SUCCESS: Sent termination signal to the process with PID 4321.', stderr: '' }));
  assert.deepEqual(calls, [['taskkill', '/PID', '4321']], 'never /F');
  assert.match(ok, /^its window was asked to close/);
  const no = await askPlayerToQuit(4321, 'win32', async () => ({ code: 128, stdout: '', stderr: 'ERROR: The process with PID 4321 could not be terminated. Reason: This process can only be terminated forcefully (with /F option).' }));
  assert.match(no, /^left running: it could not be asked to close/);
  assert.match(await askPlayerToQuit(2 ** 30, 'linux'), /^left running:/, 'a pid that is gone');
});

test('w1829: descendsFrom follows the parent pids, and never loops', () => {
  const procs = [
    { pid: 3, ppid: 2 },
    { pid: 2, ppid: 1 },
    { pid: 9, ppid: 9 },
  ];
  assert.equal(descendsFrom(3, 1, procs), true);
  assert.equal(descendsFrom(3, 5, procs), false);
  assert.equal(descendsFrom(9, 5, procs), false);
  assert.equal(descendsFrom(3, undefined, procs), false);
});

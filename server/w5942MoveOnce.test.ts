import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, type QueuedSend, type SessionHandle } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { HOME_WAIT_MS, MOVE_AFTER_MS, MoveGuard, REFUSED_FOR_MS, WARM_MARK, warmWait } from './resumeMove.ts';
import { latestWorker } from '../shared/blockers.ts';
import type { Computer } from './placement.ts';
import type { Config } from './config.ts';
import type { Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

/**
 * w5942: tonight's bouncing (2026-11-25, the portal journal 06:00-06:50Z). Biscuit was at its agent cap of 4; beast's portal
 * count said 2 of 6 mid-turn while its daemon, back from a stuck update, counted 6 live and refused every start.
 *
 * - aa98e369 (w5869), a worker with its conversation, was placed again in its own biscuit sandbox (which ends the w4738 wait),
 *   waited "4 agents mid-turn on biscuit (cap 4)" and moved 20 to 30 s later to beast (81122653).
 * - beast's daemon refused 81122653 at its cap (06:37:34); the dispatcher put aa98e369 back in biscuit/slot3, which moved
 *   again 29 s later, to lothdesktop (19889673): three workers for one request in under 20 min.
 * - The message waiting for 81122653 was then dropped (06:38:50, "taken off worker 81122653: not moved").
 * - w5932's fresh workers 60a433cb and d4f2c3ca (turns 0) were refused by beast's daemon count in turn.
 */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'lothsahn' };
const PEOPLE: UserInfo[] = [{ ...LOTH, role: 'owner' }];
const OLD = new Date(Date.now() - 3 * 3600_000).toISOString();
const BISCUIT_FULL = '4 agents mid-turn on biscuit, in sandboxes and standing agents together (its agent cap 4)';
const BEAST_REFUSED = "6 agents mid-turn on beast by its daemon's count (it refused the start: already 6 agents running in this machine's sandboxes (max_sandbox_agents 6))";
const pc = (id: string, over: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 6, maxSandboxes: 6, freeSandboxes: 3, platform: 'win32', ...over });

type Internals = {
  roomMove: (h: SessionHandle, q: QueuedSend, hold: string, now: number) => true | string | undefined;
  startMoved: (info: SessionInfo, w: WorkItem, to: string, why: string, hold: string, branch: string | undefined, lead: string | undefined, hb: Parameters<Agents['orchestrators']['movedForRoom']>[2]) => Promise<string>;
  places: () => Computer[];
};

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w5942-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/master',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  t.after(async () => {
    agents.orchestrators.close();
    clearInterval(agents.placeAgainTick);
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const x = agents as unknown as Internals;
  // Biscuit full; beast and lothdesktop with room by the portal's count.
  x.places = () => [pc('biscuit', { maxAgents: 4, midTurn: 4, sandboxes: 4, maxSandboxes: 4, freeSandboxes: 0 }), pc('beast', { midTurn: 2 }), pc('lothdesktop')];
  const starts: string[] = [];
  x.startMoved = async (info, w, to, _why, _hold, _branch, _lead, hb) => {
    const id = `new${starts.length + 1}`;
    starts.push(`${to}:${id}`);
    agents.orchestrators.movedForRoom(w, info, hb);
    // A fresh session: no turn yet.
    const s: SessionInfo = { id, kind: 'worker', title: info.title, status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 0, costUsd: 0, pendingPermissions: [], machineId: to, machineSandbox: 'slot3' };
    store.putSession(s);
    agents.orchestrators.linkWorker(w.id, s, `started worker ${id} in ${to}/slot3: moved from worker ${info.id}`);
    return `${to}/slot3 as worker ${id}`;
  };
  const worker = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => {
    const s: SessionInfo = { id, kind: 'worker', title: 'w5869: FF Factory fix', status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 7, costUsd: 0, pendingPermissions: [], ...o };
    store.putSession(s);
    return s;
  };
  const request = (sessionIds: string[]): WorkItem => {
    const w: WorkItem = { id: 'w5869', title: 'FF Factory fix', brief: 'Do it.', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [], humanAsked: true, status: 'active', createdAt: OLD, updatedAt: OLD, sessionIds, overlaps: [], asks: 0, log: [] } as unknown as WorkItem;
    store.putWork(w);
    store.workSeq = Math.max(store.workSeq, 5869);
    return w;
  };
  const queued = (id: string, text: string, at: number, from: QueuedSend['from'] = 'orchestrator'): QueuedSend => ({ uuid: `u-${id}-${text}`, id, text, from, at: new Date(at).toISOString(), why: BISCUIT_FULL });
  const roomMove = (info: SessionInfo, q: QueuedSend, hold: string, now: number) => x.roomMove({ info } as SessionHandle, q, hold, now);
  const settled = async (id: string) => {
    for (let n = 0; n < 200 && agents.isMoving(id); n++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(agents.isMoving(id), false, 'the move finished');
  };
  // What reached each worker's send (a delivery to a worker of another computer is SessionManager's business, tested there).
  const sent: { id: string; text: string; from: string }[] = [];
  sessions.send = ((id: string, text: string, from: 'human' | 'orchestrator' | 'system' = 'human') => {
    sent.push({ id, text, from });
    return 'queued';
  }) as SessionManager['send'];
  return { store, agents, machines, starts, worker, request, queued, roomMove, settled, sent };
}

test('w5942: warmWait keeps a worker with its conversation on its own computer for a seat, up to HOME_WAIT_MS; a fresh one moves as before', () => {
  const at = Date.parse('2026-11-25T06:37:00Z');
  const line = warmWait(7, BISCUIT_FULL, at, at + 30_000);
  assert.ok(line?.startsWith(WARM_MARK), line ?? 'no line');
  assert.match(line!, /\(w5942\)/, 'the ledger reads the mark: not WRONG');
  assert.match(line!, /at 06:52Z/);
  assert.match(warmWait(7, BEAST_REFUSED, at, at + 30_000) ?? '', /\(w5942\)/, "the daemon's count is a seat wait too");
  assert.equal(warmWait(7, BISCUIT_FULL, at, at + HOME_WAIT_MS), undefined, 'past the wait it moves');
  assert.equal(warmWait(0, BISCUIT_FULL, at, at + 30_000), undefined, 'a worker that never ran a turn has nothing to keep');
  assert.equal(warmWait(undefined, BISCUIT_FULL, at, at + 30_000), undefined);
  assert.equal(warmWait(7, 'no sandbox on biscuit is free', at, at + 30_000), undefined, 'a sandbox wait is w4738 and w2046, unchanged');
});

test('w5942: MoveGuard remembers a move for HOME_WAIT_MS and a cap refusal for REFUSED_FOR_MS', () => {
  const g = new MoveGuard();
  const t0 = Date.parse('2026-11-25T06:37:00Z');
  g.noteMove(['w5869'], 'beast', t0);
  assert.match(g.movedLately(['w5869'], t0 + 29_000) ?? '', /\(w5942\): w5869 moved to beast 0 min ago and moves at most once per wait; it moves again at 06:52Z/);
  assert.equal(g.movedLately(['w5895'], t0 + 29_000), undefined, 'another request moves as before');
  assert.equal(g.movedLately(['w5869'], t0 + HOME_WAIT_MS), undefined, 'a wait past HOME_WAIT_MS may move again');
  g.noteRefusal('beast', 'already 6 agents running', t0);
  assert.match(g.refusals(t0 + 60_000).beast ?? '', /refused a start at its agent cap 60 s ago \(w5942\)/);
  assert.deepEqual(g.refusals(t0 + REFUSED_FOR_MS), {}, 'it is a target again after REFUSED_FOR_MS');
});

test("w5942: tonight's w5869 sequence replayed moves the request once: a warm worker waits for its seat, the moved copy waits where it went, and a message for the old worker reaches the new one", async (t) => {
  const { store, agents, machines, starts, worker, request, queued, roomMove, settled, sent } = await setup(t);
  // aa98e369, placed again in its own biscuit sandbox (no placeReleased), with its conversation.
  // Released idle before (no wait flag, so no w4738 wait), its branch pushed.
  const aa = worker('aa98e369', { machineId: 'biscuit', machineSandbox: 'slot3', placeReleased: { at: OLD, sandbox: 'slot3', branch: 'w5869-fix', why: 'idle' } });
  request(['aa98e369']);
  // Real times: the move is noted at the wall clock (moveForRoom).
  const t0 = Date.now() - HOME_WAIT_MS - 2000;
  const q1 = queued('aa98e369', 'CI on #1290 is green', t0);

  // 06:37:00: 30 s after its message. Before the fix it moved here.
  const kept = roomMove(aa, q1, BISCUIT_FULL, t0 + MOVE_AFTER_MS + 10_000);
  assert.equal(typeof kept, 'string', 'it waits');
  assert.match(kept as string, /\(w5942\)/, 'its Queued line says why, marked for the ledger');
  assert.deepEqual(starts, []);

  // Fifteen minutes on with biscuit still full, it moves once, and beast's daemon refuses the copy's start there.
  const tMove = Date.now();
  assert.equal(roomMove(aa, q1, BISCUIT_FULL, tMove), true, 'past the wait it moves');
  await settled('aa98e369');
  assert.equal(starts.length, 1, starts.join(', '));
  const [to, id] = String(starts[0]).split(':') as [string, string];
  if (to === 'beast') machines.capRefused?.('beast', 'already 6 agents running in this machine\'s sandboxes (max_sandbox_agents 6)');
  const copy = store.sessions.get(id)!;
  const hold = to === 'beast' ? BEAST_REFUSED : `6 agents mid-turn on ${to}, in sandboxes and standing agents together (its agent cap 6)`;

  // The copy (turns 0) waits for its seat there: before the fix its 20 s move went on to the next computer.
  const q2 = queued(id, 'resume', tMove + 5000);
  const again = roomMove(copy, q2, hold, tMove + 5000 + MOVE_AFTER_MS + 9000);
  assert.equal(typeof again, 'string', 'the moved copy does not move again within the wait');
  assert.match(again as string, /\(w5942\): w5869 moved to \w+ \d+ min ago and moves at most once per wait/);

  // 06:38: the dispatcher's message for the old worker. Before the fix it was dropped (w2079); now it goes to the copy.
  const q3 = queued('aa98e369', 'lothsahn asks: also check the BEAST restarts', tMove + 60_000, 'human');
  assert.equal(roomMove(aa, q3, BISCUIT_FULL, tMove + 60_000 + MOVE_AFTER_MS + 1000), true, 'it is not delivered to the old worker');
  await settled('aa98e369');
  assert.equal(starts.length, 1, `one move in all: ${starts.join(', ')}`);
  const fwd = sent.filter((s) => s.id === id);
  assert.equal(fwd.length, 1, `the message reached the new worker once (${JSON.stringify(sent)})`);
  assert.match(fwd[0]!.text, /^\[forwarded, w5942\] This message was queued for worker aa98e369 on biscuit\/slot3/);
  assert.match(fwd[0]!.text, /lothsahn asks: also check the BEAST restarts$/);
  assert.equal(fwd[0]!.from, 'human', 'it keeps its sender');
  const w = store.work.get('w5869')!;
  assert.equal(latestWorker(w), id);
  assert.match(w.log.join('\n'), new RegExp(`went to its worker ${id} \\(w5942\\)`));
  assert.equal(w.log.filter((l) => /moved from biscuit\/slot3 to /.test(l)).length, 1, `one move in the log: ${w.log.join(' | ')}`);
  void agents;
});

test("w5942: a computer whose daemon refused a start at its cap is no move target for a while, whatever the portal's count", async (t) => {
  const { starts, worker, request, queued, roomMove, settled, machines } = await setup(t);
  // w5932's 60a433cb: a fresh worker on biscuit; beast's daemon has just refused d4f2c3ca.
  machines.capRefused?.('beast', "already 6 agents running in this machine's sandboxes (max_sandbox_agents 6)");
  const s = worker('60a433cb', { machineId: 'biscuit', machineSandbox: 'slot2', turns: 0, placeReleased: { at: OLD, sandbox: 'slot2', branch: 'w5932-gh', why: 'idle' } });
  request(['60a433cb']);
  const t0 = Date.now() - 60_000;
  assert.equal(roomMove(s, queued('60a433cb', 'start', t0), BISCUIT_FULL, Date.now()), true);
  await settled('60a433cb');
  assert.deepEqual(starts, ['lothdesktop:new1'], 'beast, which refused, is skipped');
});

test('w5942: a message for a worker whose request another live worker carries goes to that worker instead of being dropped', async (t) => {
  const { store, starts, worker, request, queued, roomMove, settled, sent } = await setup(t);
  const old = worker('81122653', { machineId: 'beast', machineSandbox: 'slot2', turns: 0 });
  worker('19889673', { status: 'running', machineId: 'lothdesktop', machineSandbox: 'slot4' });
  const w = request(['81122653', '19889673']);
  w.links = { '81122653': { at: OLD, how: 'linked' }, '19889673': { at: new Date().toISOString(), how: 'sent' } } as WorkItem['links'];
  store.putWork(w);
  const q = queued('81122653', 'the gh login on beast answers 401 again', Date.now() - 60_000, 'orchestrator');
  assert.equal(roomMove(old, q, BEAST_REFUSED, Date.now()), true);
  await settled('81122653');
  assert.deepEqual(starts, [], 'no moved copy starts (w2079)');
  assert.deepEqual(sent.map((s) => s.id), ['19889673'], 'the message went to the worker on the request');
  assert.match(sent[0]!.text, /the gh login on beast answers 401 again$/);
  assert.match(store.work.get('w5869')!.log.join('\n'), /went to its worker 19889673 \(w5942\)/);
  // A gate resume is the old worker's own wait: still dropped.
  const r = { ...queued('81122653', 'CI cleared', Date.now() - 60_000, 'system'), resumeOf: { work: 'w5869', note: 'CI cleared' } };
  roomMove(old, r, BEAST_REFUSED, Date.now());
  assert.equal(sent.length, 1, 'a gate resume is not forwarded');
});

test('w5942 (warn only): a worker whose work moved elsewhere and that its daemon still runs, or that a resume would wake, is reported, not stopped', async (t) => {
  const { machines } = await setup(t);
  const reports: string[] = [];
  machines.report = (text: string) => void reports.push(text);
  const m = machines as unknown as { handle: (sid: string) => unknown; warnMovedAway: (id: string, sids: string[], what: string) => void };
  m.handle = (sid: string) => ({ info: { id: sid, movedAway: { machine: 'beast', to: 'biscuit', at: '2026-11-25T06:09:46.000Z' } } });
  m.warnMovedAway('beast', ['d732483b', '847ebd50'], 'still runs');
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /^\[machines\] beast: 2 worker\(s\) whose work moved elsewhere: still runs: d732483b \(its work moved to biscuit at 06:09:46Z\), 847ebd50 .*\(w5942, warn only\)\.$/);
});

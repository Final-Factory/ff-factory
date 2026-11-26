import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { Agents } from './agents.ts';
import { Identity } from './identity.ts';
import { movedAwayMode, movedAwayVerdict, startedHeir, type HeirFacts } from './movedAwayEnforce.ts';
import { setAppConfig } from './appConfig.ts';
import type { Config } from './config.ts';
import type { Machine, Requester, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

/**
 * w5950: enforcing w5942's moved-away check (server/movedAwayEnforce.ts). The case replayed: on 2026-11-25 beast came back
 * at 06:20:26Z still running d732483b, whose w5869 had moved to biscuit at 06:09:46Z (to 0b7e41c2 there), so w5869 had two
 * live workers. Conditions (a)-(e) are the w5949 review's.
 */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'lothsahn' };
const PEOPLE: UserInfo[] = [{ ...LOTH, role: 'owner' }];
const OLD = new Date(Date.now() - 3 * 3600_000).toISOString();
const MOVED = { machine: 'beast', to: 'biscuit', at: '2026-11-25T06:09:46.000Z' };

const heir = (o: Partial<HeirFacts> = {}): HeirFacts => ({ id: '0b7e41c2', live: true, turns: 3, midTurn: true, status: 'running', sameSandbox: false, ...o });

test('w5950: the setting reads "warn" unless it is "off" or "on"', () => {
  assert.equal(movedAwayMode(undefined), 'warn');
  assert.equal(movedAwayMode('nonsense'), 'warn');
  assert.equal(movedAwayMode('off'), 'off');
  assert.equal(movedAwayMode('on'), 'on');
});

test('w5950 (a): a worker its requests still list is undone (w3425), never enforced', () => {
  const v = movedAwayVerdict({ stillHolds: ['w5869'], moving: false, moved: [{ id: 'w5869', heirs: [heir()] }] });
  assert.equal(v.act, 'undo');
});

test('w5950 (b): a move whose new session never started (handed back, no worker) keeps the old worker', () => {
  const v = movedAwayVerdict({ stillHolds: [], moving: false, moved: [{ id: 'w5869', heirs: [] }] });
  assert.equal(v.act, 'keep');
  assert.match((v as { why: string }).why, /has no other worker .*only copy/);
});

test('w5950 (c): only a started new worker in another sandbox counts; a fresh, errored, stopped or same-sandbox one keeps the old worker', () => {
  for (const h of [heir({ live: false, turns: 0, midTurn: false, status: 'stopped' }), heir({ status: 'error' }), heir({ stoppedOnPurpose: true }), heir({ sameSandbox: true })]) {
    assert.equal(startedHeir(h), false, JSON.stringify(h));
    assert.equal(movedAwayVerdict({ stillHolds: [], moving: false, moved: [{ id: 'w5869', heirs: [h] }] }).act, 'keep');
  }
  // Between turns (on CI, say) a new worker that ran a turn still holds the request.
  assert.equal(startedHeir(heir({ live: false, midTurn: false, status: 'stopped', turns: 2 })), true);
  // One request without a started heir keeps the worker, even when another has one.
  assert.equal(movedAwayVerdict({ stillHolds: [], moving: false, moved: [{ id: 'w5869', heirs: [heir()] }, { id: 'w5870', heirs: [] }] }).act, 'keep');
  // A live heir is preferred over one that is only between turns.
  const v = movedAwayVerdict({ stillHolds: [], moving: false, moved: [{ id: 'w5869', heirs: [heir({ id: 'idle', live: false, midTurn: false, status: 'stopped' }), heir({ id: 'live1' })] }] });
  assert.deepEqual(v, { act: 'enforce', heirs: [{ request: 'w5869', heir: 'live1' }] });
  assert.equal(movedAwayVerdict({ stillHolds: [], moving: true, moved: [{ id: 'w5869', heirs: [heir()] }] }).act, 'keep', 'a move under way decides');
});

test('w5950: movedAwayWorkers is an owner-only setting, "on" | "warn" | "off", null puts back the default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w5950c-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{}');
    const cfg = {} as Config;
    setAppConfig(file, cfg, 'movedAwayWorkers', 'on');
    assert.equal(cfg.movedAwayWorkers, 'on');
    setAppConfig(file, cfg, 'movedAwayWorkers', 'off');
    assert.equal(cfg.movedAwayWorkers, 'off');
    setAppConfig(file, cfg, 'movedAwayWorkers', null);
    assert.equal(cfg.movedAwayWorkers, undefined);
    assert.equal(movedAwayMode(cfg.movedAwayWorkers), 'warn');
    assert.throws(() => setAppConfig(file, cfg, 'movedAwayWorkers', 'yes'), /movedAwayWorkers is "warn"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type FakeHandle = { info: SessionInfo; live: boolean; stop: (hard?: boolean) => void; stops: number };

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w5950-'));
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
  const fakes: string[] = [];
  t.after(async () => {
    for (const id of fakes) sessions.sessions.delete(id);
    agents.orchestrators.close();
    clearInterval(agents.placeAgainTick);
    agents.close(); // w6152: Agents' timers stop before the folder goes (w5915: a release pass wrote into a removed transcript, ENOENT).
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const reports: string[] = [];
  machines.report = (text: string) => void reports.push(text);
  const sent: { id: string; text: string }[] = [];
  sessions.send = ((id: string, text: string) => {
    sent.push({ id, text });
    return 'queued';
  }) as SessionManager['send'];
  const saves: { sandbox: string; branch: string; holdPush?: string }[] = [];
  const m = machines as unknown as { canSaveWork: (id: string) => boolean; saveWork: (...a: unknown[]) => Promise<unknown> };
  m.canSaveWork = () => true;
  m.saveWork = async (_id: unknown, sandbox: unknown, branch: unknown, _msg: unknown, _tok: unknown, holdPush: unknown) => {
    saves.push({ sandbox: sandbox as string, branch: branch as string, holdPush: holdPush as string | undefined });
    return { sha: 'abcdef1234567890', files: 2, pushed: true, notes: [], sideRef: 'ff-saved/w5869-abcdef1' };
  };
  (agents as unknown as { branchNow: () => string }).branchNow = () => 'sandbox/w5869';
  const worker = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => {
    const s: SessionInfo = { id, kind: 'worker', title: 'w5869: FF Factory fix', status: 'stopped', permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 7, costUsd: 0, pendingPermissions: [], ...o };
    store.putSession(s);
    return s;
  };
  const live = (info: SessionInfo): FakeHandle => {
    const h: FakeHandle = { info, live: true, stops: 0, stop() { h.live = false; h.stops++; } };
    sessions.sessions.set(info.id, h as never);
    fakes.push(info.id);
    return h;
  };
  const request = (sessionIds: string[], movedOff: Record<string, string> = {}): WorkItem => {
    const w = { id: 'w5869', title: 'FF Factory fix', brief: 'Do it.', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [], humanAsked: true, status: 'active', createdAt: OLD, updatedAt: OLD, sessionIds, movedOff, overlaps: [], asks: 0, log: [] } as unknown as WorkItem;
    store.putWork(w);
    store.workSeq = Math.max(store.workSeq, 5869);
    return w;
  };
  const sandbox = (machine: string, id: string, sessionIds: string[]) => {
    const old = store.machines.get(machine);
    const mc = (old ?? { id: machine, host: machine, portalUrl: 'x', sessionIds: [] }) as Machine;
    mc.sandboxes = [...(mc.sandboxes ?? []).filter((s) => s.id !== id), { id, sessionIds } as never];
    store.putMachine(mc);
  };
  const liveOn = (id: string) => [...sessions.sessions.values()].filter((h) => (h as unknown as FakeHandle).live && h.info.id === id).length;
  const settle = async (f: () => boolean) => {
    for (let n = 0; n < 200 && !f(); n++) await new Promise((r) => setTimeout(r, 10));
  };
  return { store, agents, machines, reports, sent, saves, worker, live, request, sandbox, liveOn, settle };
}

test("w5950: the 2026-11-25 case replayed with \"on\": beast's still-running d732483b is stopped, its sandbox saved to a side branch, and w5869 is left with one live worker that is told", async (t) => {
  const { store, agents, reports, sent, saves, worker, live, request, sandbox, settle } = await setup(t);
  const oldInfo = worker('d732483b', { status: 'running', machineId: 'beast', machineSandbox: 'slot2', movedAway: MOVED });
  const newInfo = worker('0b7e41c2', { status: 'running', machineId: 'biscuit', machineSandbox: 'slot3', turns: 2 });
  const oldH = live(oldInfo);
  live(newInfo);
  sandbox('beast', 'slot2', ['d732483b']);
  request(['0b7e41c2'], { d732483b: MOVED.at });
  const taken = agents.enforceMovedAway('beast', ['d732483b'], 'live');
  assert.deepEqual([...taken], [['d732483b', ['0b7e41c2']]]);
  await settle(() => sent.length > 0);
  assert.equal(oldH.stops, 1, 'the old worker is stopped');
  const w = store.work.get('w5869')!;
  const liveWorkers = w.sessionIds.filter((id) => (agents as unknown as { sessions: SessionManager }).sessions.sessions.get(id)?.live);
  assert.deepEqual(liveWorkers, ['0b7e41c2'], 'one live worker on w5869');
  assert.equal(oldH.live, false);
  assert.deepEqual(saves.map((s) => s.sandbox), ['slot2']);
  assert.match(saves[0]!.holdPush ?? '', /0b7e41c2/, 'saved with holdPush: only a side branch, never onto the branch the new worker carries (d)');
  assert.deepEqual(sent.map((s) => s.id), ['0b7e41c2']);
  assert.match(sent[0]!.text, /^\[forwarded, w5942\] .*\[w5950\] Your request's old worker d732483b on beast\/slot2 ran on .*side branch ff-saved\/w5869-abcdef1/s);
  assert.match(reports.join('\n'), /beast: 1 worker\(s\) whose work moved elsewhere were still running and are stopped: d732483b \(its requests are with 0b7e41c2\)/);
});

test('w5950 (b) at the agents level: the new copy never started (handed back, no worker): the old worker keeps the work and is not stopped', async (t) => {
  const { agents, reports, sent, saves, worker, live, request } = await setup(t);
  const oldH = live(worker('d732483b', { status: 'running', machineId: 'beast', machineSandbox: 'slot2', movedAway: MOVED }));
  request([], { d732483b: MOVED.at });
  assert.equal(agents.enforceMovedAway('beast', ['d732483b'], 'live').size, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(oldH.stops, 0);
  assert.deepEqual(saves, []);
  assert.deepEqual(sent, []);
  assert.match(reports.join('\n'), /d732483b \(its work moved to biscuit at 06:09:46Z\): kept, w5869 has no other worker/);
});

test('w5950 (c) at the agents level: a new worker that has not started (turns 0, not live) keeps the old one', async (t) => {
  const { agents, worker, live, request } = await setup(t);
  const oldH = live(worker('d732483b', { status: 'running', machineId: 'beast', machineSandbox: 'slot2', movedAway: MOVED }));
  worker('0b7e41c2', { machineId: 'biscuit', machineSandbox: 'slot3', turns: 0 });
  request(['0b7e41c2'], { d732483b: MOVED.at });
  assert.equal(agents.enforceMovedAway('beast', ['d732483b'], 'live').size, 0);
  assert.equal(oldH.stops, 0);
});

test('w5950 (a) at the agents level: a worker its request still lists has its away mark cleared, and is not stopped', async (t) => {
  const { store, agents, worker, live, request } = await setup(t);
  const oldH = live(worker('d732483b', { status: 'running', machineId: 'beast', machineSandbox: 'slot2', movedAway: MOVED }));
  request(['d732483b']);
  assert.equal(agents.enforceMovedAway('beast', ['d732483b'], 'live').size, 0);
  assert.equal(oldH.stops, 0);
  assert.equal(store.sessions.get('d732483b')!.movedAway, undefined, 'the w3425 check undid the mark');
});

test('w5950 (d): another agent in the old sandbox: the old worker is stopped but its sandbox is not saved', async (t) => {
  const { agents, sent, saves, worker, live, request, sandbox, settle } = await setup(t);
  const oldH = live(worker('d732483b', { status: 'running', machineId: 'beast', machineSandbox: 'slot2', movedAway: MOVED }));
  live(worker('0b7e41c2', { status: 'running', machineId: 'biscuit', machineSandbox: 'slot3', turns: 2 }));
  live(worker('5ca1ab1e', { status: 'running', machineId: 'beast', machineSandbox: 'slot2', title: 'w6000: other' }));
  sandbox('beast', 'slot2', ['d732483b', '5ca1ab1e']);
  request(['0b7e41c2'], { d732483b: MOVED.at });
  assert.equal(agents.enforceMovedAway('beast', ['d732483b'], 'live').size, 1);
  await settle(() => sent.length > 0);
  assert.equal(oldH.stops, 1);
  assert.deepEqual(saves, []);
  assert.match(sent[0]!.text, /was not saved: agent 5ca1ab1e works there too/);
});

/** Machines.resumeCutOff for beast's drop, with d732483b (moved away) and 847ebd50 (not) cut off mid-turn. */
async function resumeLeg(t: Parameters<typeof setup>[0], mode: 'off' | 'warn' | 'on' | undefined, ageMs = 60_000) {
  const s = await setup(t);
  const cfg = (s.machines as unknown as { cfg: Config }).cfg;
  if (mode) cfg.movedAwayWorkers = mode;
  s.worker('0b7e41c2', { status: 'running', machineId: 'biscuit', machineSandbox: 'slot3', turns: 2 });
  s.request(['0b7e41c2'], { d732483b: MOVED.at });
  const infos: Record<string, SessionInfo> = {
    d732483b: s.worker('d732483b', { machineId: 'beast', machineSandbox: 'slot2', movedAway: MOVED }),
    '847ebd50': s.worker('847ebd50', { machineId: 'beast', machineSandbox: 'slot4', title: 'w5871: other' }),
  };
  const m = s.machines as unknown as { handle: (sid: string) => unknown; outdated: () => boolean; cutOff: Map<string, unknown>; resumeCutOff: (id: string, live: Set<string>) => void };
  m.handle = (sid: string) => (infos[sid] ? { info: s.store.sessions.get(sid) ?? infos[sid] } : undefined);
  m.outdated = () => false;
  m.cutOff.set('beast', { at: Date.now() - ageMs, why: 'dropped', sessions: ['d732483b', '847ebd50'] });
  m.resumeCutOff('beast', new Set());
  return s;
}

test('w5950: resumeCutOff with "on" skips the moved-away worker and tells its new worker; the other is resumed', async (t) => {
  const { sent, settle } = await resumeLeg(t, 'on');
  await settle(() => sent.some((x) => x.id === '0b7e41c2'));
  assert.deepEqual(sent.map((x) => x.id).sort(), ['0b7e41c2', '847ebd50']);
  assert.match(sent.find((x) => x.id === '0b7e41c2')!.text, /\[w5950\] Your request's old worker d732483b .* does not resume it/);
});

test('w5950: resumeCutOff with "warn" (the default) resumes both as before, with the w5942 warn line', async (t) => {
  const { sent, reports } = await resumeLeg(t, undefined);
  assert.deepEqual(sent.map((x) => x.id).sort(), ['847ebd50', 'd732483b']);
  assert.match(reports.join('\n'), /whose work moved elsewhere: would not resume \(it resumes for now\): d732483b/);
});

test('w5950: resumeCutOff with "off" resumes both and says nothing about the move (the recovery switch)', async (t) => {
  const { sent, reports } = await resumeLeg(t, 'off');
  assert.deepEqual(sent.map((x) => x.id).sort(), ['847ebd50', 'd732483b']);
  assert.doesNotMatch(reports.join('\n'), /moved elsewhere/);
});

test('w5950 (e): past RESUME_WITHIN_MS the report says to message only the workers whose work did not move', async (t) => {
  const { reports, sent } = await resumeLeg(t, 'warn', 7 * 3600_000);
  assert.deepEqual(sent, []);
  const r = reports.find((x) => /is back; .*too long ago/.test(x))!;
  assert.match(r, /Message 847ebd50 to continue\. d732483b \(its work moved to biscuit at 06:09:46Z: message the worker its request is with now, not this one\)\./);
});

test('w5950 (the w5975 review, finding 1): a second hello while the worker is being retired neither stops, saves nor tells again', async (t) => {
  const { agents, sent, saves, worker, live, request, sandbox, settle } = await setup(t);
  const oldH = live(worker('d732483b', { status: 'running', machineId: 'beast', machineSandbox: 'slot2', movedAway: MOVED }));
  live(worker('0b7e41c2', { status: 'running', machineId: 'biscuit', machineSandbox: 'slot3', turns: 2 }));
  sandbox('beast', 'slot2', ['d732483b']);
  request(['0b7e41c2'], { d732483b: MOVED.at });
  const first = agents.enforceMovedAway('beast', ['d732483b'], 'live');
  const again = agents.enforceMovedAway('beast', ['d732483b'], 'resume');
  assert.deepEqual([...again], [...first], 'still taken, so the resume skips it too');
  await settle(() => sent.length > 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(oldH.stops, 1);
  assert.equal(saves.length, 1);
  assert.equal(sent.length, 1);
});

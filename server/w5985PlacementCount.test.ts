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
import { CENSUS_FRESH_MS, CENSUS_GRACE_MS, CensusWatch, placementCountMode, placementCountOf, type AgentCensus, type PortalCounted, type PortalSeen } from './agentCensus.ts';
import { agentBusyReasons, type Computer } from './placement.ts';
import { OWNER_ONLY_KEYS, setAppConfig } from './appConfig.ts';
import type { Config } from './config.ts';
import type { Machine, Requester, SessionInfo, UserInfo } from '../shared/types.ts';

/**
 * w5985, the enforce stage of w5972: with config placementAgentCount "on", placement counts a machine's agents as capFull
 * does and takes the larger of that and its daemon's fresh census. The case replayed is beast's, 2026-11-26: placement
 * counted it at "2 of 6 agents mid-turn" at 06:35:09Z and sent w5892 there; its daemon refused at 06:37:34 because it
 * counted six (the fixture of server/w5972AgentCensus.test.ts: daemon.log lines 18801-18808 as quoted in w5938's worker
 * f305bf10's transcript).
 */

const beast: AgentCensus = {
  midTurn: [
    { id: '11a84ee9', sandbox: 'slot1', status: 'running', live: true },
    { id: '716b6111', sandbox: 'slot2', status: 'running', live: true },
    { id: '828bacfa', sandbox: 'slot5', status: 'running', live: true },
    { id: '847ebd50', sandbox: 'slot4', status: 'running', live: true },
    { id: '9a8691c5', sandbox: 'slot6', status: 'running', live: true },
    { id: 'd732483b', sandbox: 'slot3', status: 'running', live: false },
  ],
};
const portal: PortalCounted[] = [
  { id: '11a84ee9', sandbox: 'slot1', status: 'running', live: true, starting: false },
  { id: '828bacfa', sandbox: 'slot5', status: 'running', live: true, starting: false },
  { id: 'c1e9dd0c', sandbox: 'slot4', status: 'idle', live: false, starting: true },
];
const seen = (id: string): PortalSeen => (id === '716b6111' ? { machine: 'biscuit', status: 'running', live: true } : id === '9a8691c5' ? { machine: 'beast', status: 'idle', live: true } : { machine: 'beast', status: 'stopped', live: false });

const LOTH: Requester = { userId: 'lothsahn', displayName: 'lothsahn' };
const PEOPLE: UserInfo[] = [{ ...LOTH, role: 'owner' }];
const OLD = new Date(Date.now() - 3 * 3600_000).toISOString();
const SLOTS = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6'];

test('w5985: the setting reads "off" unless it is "on"; owner-only, null puts back "off"', () => {
  assert.equal(placementCountMode(undefined), 'off');
  assert.equal(placementCountMode('warn'), 'off');
  assert.equal(placementCountMode('on'), 'on');
  assert.ok(OWNER_ONLY_KEYS.has('placementAgentCount'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w5985-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{}');
    const cfg = {} as Config;
    setAppConfig(file, cfg, 'placementAgentCount', 'on');
    assert.equal(cfg.placementAgentCount, 'on');
    setAppConfig(file, cfg, 'placementAgentCount', 'off');
    assert.equal(cfg.placementAgentCount, 'off');
    setAppConfig(file, cfg, 'placementAgentCount', null);
    assert.equal(cfg.placementAgentCount, undefined);
    assert.throws(() => setAppConfig(file, cfg, 'placementAgentCount', 'warn'), /placementAgentCount is "on"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('w5985: placementCountOf takes the larger of the portal count and a fresh census, per sandbox too; a stale one is ignored', () => {
  const now = Date.parse('2026-11-26T06:35:09Z');
  const mine = { midTurn: 3, inSandbox: new Map(SLOTS.map((s) => [s, s === 'slot1' || s === 'slot5' || s === 'slot4' ? 1 : 0])) };
  const c = placementCountOf(mine, { at: now - 10_000, census: beast }, now);
  assert.equal(c.midTurn, 6, 'beast: its daemon counts 6, which it refuses at');
  assert.equal(c.daemon, 6);
  assert.deepEqual([...c.inSandbox].filter(([, n]) => n > 0).map(([s]) => s).sort(), SLOTS, 'each slot of beast holds one the daemon counts');
  assert.equal(placementCountOf(mine, { at: now - CENSUS_FRESH_MS, census: beast }, now), mine, 'a census 45 s old is stale');
  assert.equal(placementCountOf(mine, undefined, now), mine, 'a daemon before w5972 sends none');
  assert.equal(placementCountOf(mine, { at: now + 5_000, census: beast }, now), mine, 'a census from the future (a clock step) is not trusted');
  // The portal counting more (lothdesktop's warnings, 2026-11-26/27: turns sent, not yet reported) keeps its count.
  assert.equal(placementCountOf({ midTurn: 4, inSandbox: new Map() }, { at: now, census: { midTurn: [] } }, now).midTurn, 4);
});

test('w5985: the warning says placement counts the larger with "on", and names w5950\'s mode beside a moved request\'s copy', () => {
  const run = (opts: Parameters<CensusWatch['note']>[5]) => {
    const w = new CensusWatch();
    const t0 = Date.parse('2026-11-26T06:35:00Z');
    w.note('beast', beast, portal, seen, t0, opts);
    return w.note('beast', beast, portal, seen, t0 + CENSUS_GRACE_MS, opts)!;
  };
  const off = run(undefined);
  assert.match(off, /2 reported mid-turn, which placement counts, and 1 sent/);
  assert.match(off, /warn only: nothing is stopped or placed by it \(w5972\)$/);
  assert.match(off, /716b6111 \(slot2, running\) \[on biscuit for the portal\]; .*w5950's movedAwayWorkers is "warn": with "on" it would stop/);
  const on = run({ placement: 'on', movedAway: 'on' });
  assert.doesNotMatch(on, /which placement counts/);
  assert.match(on, /movedAwayWorkers is "on": it stops a moved request's old worker at its daemon's next hello/);
  assert.match(on, /placement counts the larger of the two \(placementAgentCount "on", w5985\); nothing is stopped by it$/);
  // No copy held elsewhere: no word of w5950.
  const w = new CensusWatch();
  const solo: AgentCensus = { midTurn: [{ id: 'a', sandbox: 's1', status: 'running', live: true }] };
  w.note('m5', solo, [], () => undefined, 0);
  assert.doesNotMatch(w.note('m5', solo, [], () => undefined, CENSUS_GRACE_MS)!, /movedAwayWorkers/);
});

type FakeHandle = { info: SessionInfo; live: boolean; stop: (hard?: boolean) => void; stops: number };

async function setup(t: { after: (fn: () => void | Promise<void>) => void }, mode?: 'on' | 'off') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w5985-'));
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
    ...(mode ? { placementAgentCount: mode } : {}),
  } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => PEOPLE));
  agents.boot();
  const fakes: FakeHandle[] = [];
  t.after(async () => {
    for (const h of fakes) sessions.sessions.delete(h.info.id);
    agents.orchestrators.close();
    clearInterval(agents.placeAgainTick);
    agents.close();
    sessions.stopAll();
    await new Promise((r) => setTimeout(r, 60));
    store.flush();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const sent: string[] = [];
  sessions.send = ((id: string) => (sent.push(id), 'queued')) as SessionManager['send'];
  // beast: six sandboxes, its agent cap six (max_sandbox_agents 6, as its refusal said).
  store.putMachine({ id: 'beast', host: 'beast', portalUrl: 'x', sessionIds: [], sandboxRoot: 'F:/ffw/sandboxes', maxSandboxes: 6, maxAgentsPerSandbox: 2, maxSandboxAgents: 6, sandboxes: SLOTS.map((id) => ({ id, sessionIds: [], unity: { state: 'stopped' } })) } as unknown as Machine);
  const live = (id: string, sandbox: string, status: SessionInfo['status']) => {
    const info: SessionInfo = { id, kind: 'worker', title: `${id}: work`, status, permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 3, costUsd: 0, pendingPermissions: [], machineId: 'beast', machineSandbox: sandbox };
    store.putSession(info);
    const h: FakeHandle = { info, live: true, stops: 0, stop() { h.live = false; h.stops++; } };
    sessions.sessions.set(id, h as never);
    fakes.push(h);
    return h;
  };
  // What the portal held at 06:35: two reported mid-turn, and w5892's start sent and not yet reported (c1e9dd0c).
  live('11a84ee9', 'slot1', 'running');
  live('828bacfa', 'slot5', 'running');
  live('c1e9dd0c', 'slot4', 'idle');
  const m = machines as unknown as { starting: Map<string, unknown>; noteCensus: (id: string, raw: unknown) => void; census: { lastOf: (id: string) => { at: number } | undefined } };
  m.starting.set('c1e9dd0c', { at: Date.now(), text: 'go', from: 'orchestrator', uuid: 'u', images: [], attachments: [] });
  const beastNow = () => (agents as unknown as { placesNow: () => Computer[] }).placesNow().find((c) => c.id === 'beast')!;
  return { machines, m, fakes, sent, beastNow };
}

test('w5985: "off" (the default) counts beast as placement did at 06:35, 2 of 6, whatever its daemon says', async (t) => {
  const s = await setup(t);
  s.m.noteCensus('beast', beast);
  const p = s.beastNow();
  assert.equal(p.midTurn, 2);
  assert.equal(p.maxAgents, 6);
  assert.deepEqual(agentBusyReasons({ ...p, online: true }), [], 'it had room, so w5892 went there and was refused');
  assert.equal(s.machines.placementCount('beast', SLOTS), undefined);
});

test('w5985: "on" counts beast at 6 of 6 from its fresh census, so placement sends nothing there; nothing is stopped', async (t) => {
  const s = await setup(t, 'on');
  s.m.noteCensus('beast', beast);
  const p = s.beastNow();
  assert.equal(p.midTurn, 6);
  assert.match(agentBusyReasons({ ...p, online: true }).join('; '), /6 agents mid-turn of 6/);
  assert.equal(p.agentSeats, SLOTS.length, 'each slot holds one of its max_agents_per_sandbox 2');
  // Lockout rule: counting never ends an agent, the stale copies the daemon counts (d732483b, 716b6111) included.
  assert.deepEqual(s.fakes.map((h) => [h.info.id, h.live, h.stops]), [['11a84ee9', true, 0], ['828bacfa', true, 0], ['c1e9dd0c', true, 0]]);
  assert.deepEqual(s.sent, []);
});

test('w5985: "on" without a fresh census counts as capFull does (the start sent, not yet reported, too): 3 of 6', async (t) => {
  const s = await setup(t, 'on');
  assert.equal(s.beastNow().midTurn, 3, 'no census yet');
  s.m.noteCensus('beast', beast);
  const last = s.m.census.lastOf('beast')!;
  last.at -= CENSUS_FRESH_MS + 1_000; // its daemon stopped reporting: recovery needs nobody at beast
  assert.equal(s.beastNow().midTurn, 3);
  assert.equal(s.machines.placementCount('beast', SLOTS)!.inSandbox.get('slot4'), 1, 'the start sent to slot4 holds a seat there');
});

test('w5985: turning it "off" again (the recovery switch) puts back the old count at once', async (t) => {
  const s = await setup(t, 'on');
  s.m.noteCensus('beast', beast);
  assert.equal(s.beastNow().midTurn, 6);
  (s.machines as unknown as { cfg: Config }).cfg.placementAgentCount = undefined;
  assert.equal(s.beastNow().midTurn, 2);
});

test('w6381: midTurnTotal and placementCount count in one pass what runningIn counts per sandbox and for standing agents', async (t) => {
  const s = await setup(t, 'on');
  const store = (s.machines as unknown as { store: Store }).store;
  const sessions = (s.machines as unknown as { sessions: SessionManager }).sessions;
  const add = (id: string, machineId: string, sandbox: string | undefined, status: SessionInfo['status']) => {
    const info = { id, kind: sandbox ? 'worker' : 'standing', title: id, status, permissionMode: 'default', createdAt: OLD, lastActivityAt: OLD, turns: 1, costUsd: 0, pendingPermissions: [], machineId, ...(sandbox ? { machineSandbox: sandbox } : {}) } as SessionInfo;
    store.putSession(info);
    const h = { info, live: true, stops: 0, stop() {} };
    sessions.sessions.set(id, h as never);
    s.fakes.push(h as never);
  };
  add('st1', 'beast', undefined, 'running'); // a standing agent mid-turn: the cap counts it, no sandbox does
  add('st2', 'beast', undefined, 'idle');
  add('w2', 'beast', 'slot1', 'running');
  add('other', 'm5', 'slot1', 'running'); // another computer's
  const old = (id: string) => s.machines.runningIn(id, '*') + s.machines.runningIn(id, undefined);
  for (const id of ['beast', 'm5', 'nowhere']) assert.equal(s.machines.midTurnTotal(id), old(id), id);
  assert.equal(s.machines.midTurnTotal('beast'), 5, '11a84ee9, 828bacfa, the start sent to c1e9dd0c, st1 and w2');
  const p = s.machines.placementCount('beast', SLOTS)!;
  for (const sb of SLOTS) assert.equal(p.inSandbox.get(sb), s.machines.runningIn('beast', sb), sb);
  assert.equal(p.inSandbox.get('slot1'), 2);
});

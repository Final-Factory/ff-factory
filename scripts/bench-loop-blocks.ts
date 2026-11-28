/**
 * The portal's remaining event-loop blocks (w6381), measured on a synthetic portal of a real one's size: each path the
 * stall profiles named, timed as the portal runs it. Local only: CI runs no timing tests (CONTRIBUTING.md "Performance").
 *
 *   node --import ./scripts/testEnv.ts scripts/bench-loop-blocks.ts [--sessions 977] [--work 6400] [--machines 6] [--sandboxes 8]
 *     [--released 900] [--queued 900] [--running 14] [--openWork 3000] [--queuedWork 8] [--heavy 5] [--online 1]
 *     [--placeOnly 1] [--count 1] [--placeRounds 300]
 *
 * w6428: a page's placement cost depends on more than the ledger's and the store's size: the released workers whose message
 * waits (--released, of which --queued have one in the send queue), the requests those workers hold (--openWork, of which --heavy
 * workers hold many each), the game work Queued for a sandbox (--queuedWork: reclaimPressure, which makes claims() ask
 * yieldsTo), sessions mid-turn with a process (--running) and computers that are online with their daemon's stats (--online 1).
 * The defaults make the page's 'place{...}' line come near the live one of 2026-11-27 18:04Z (1033 sessions, ~6400 requests, 6
 * computers, ~39 sandboxes: places 45ms x1 free 62ms x39 claims 49ms x6). The live counts of released workers, queued sends and
 * open requests were not read from it, so they are the numbers that make the cost match, not measured ones: compare the
 * 'placement shape:' line with the live state. --placeOnly 1 skips every other row; --count 1 prints how often one page build
 * calls queued, agentOnly, priorityOf and workIdsOf; --placeRounds K runs the page build K times and exits (node --cpu-prof).
 *
 * The portal VM's two shared vCPUs are slower than a workstation: read the numbers as a ratio.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../server/store.ts';
import { SessionManager } from '../server/sessions.ts';
import { MachineManager } from '../server/machines.ts';
import { Agents } from '../server/agents.ts';
import { Identity } from '../server/identity.ts';
import { stringifyPrettyPieces, writeFileDurableAsync } from '../server/durable.ts';
import type { Config } from '../server/config.ts';
import { costMark, costSince } from '../server/placeCost.ts';
import type { SessionHandle } from '../server/sessions.ts';
import type { Machine, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const N = arg('sessions', 977);
const W = arg('work', 6400);
const M = arg('machines', 6);
const SB = arg('sandboxes', 8);
const RELEASED = arg('released', 900);
const QUEUED = arg('queued', 900);
const RUNNING = arg('running', 14);
const OPEN = arg('openWork', 3000);
const QUEUED_WORK = arg('queuedWork', 8);
const HEAVY = arg('heavy', 5);
const ONLINE = arg('online', 1) > 0;
const PLACE_ROUNDS = arg('placeRounds', 0);
const PLACE_ONLY = arg('placeOnly', 0) > 0;
const T = new Date(Date.now() - 86_400_000).toISOString();
const PRIORITIES = ['low', 'normal', 'normal', 'normal', 'high', 'urgent'] as const;

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'loop-blocks-'));
const cfg = {
  dataDir: dir,
  sandboxRoot: dir,
  standingRoot: path.join(dir, '_agents'),
  repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
  defaultBase: 'origin/main',
  models: ['opus'],
  defaultModel: 'opus',
  protectedPaths: [],
  limits: { maxSessions: 30, maxUnity: 2, maxSandboxes: 4, minFreeGB: 0, minFreeRamGB: 0 },
  orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
  worker: { permissionMode: 'bypassPermissions', effort: 'low' },
  unity: {},
} as unknown as Config;
const store = new Store(dir);
const words = 'belt splitter desync join catch-up portal reconnect state build sandbox placement bench ticket unity editor crash save load ship cargo drone mining turret research tree'.split(' ');
const text = (i: number, n: number) => Array.from({ length: n }, (_, k) => words[(i * 7 + k * 13) % words.length]).join(' ');
const sessions: SessionInfo[] = [];
// Spread over the sessions, not a stride that lines up with the machine count (i % M).
const spread = (count: number, of: number) => new Set(Array.from({ length: Math.min(count, of) }, (_, k) => Math.floor((k * of) / count)));
const releasedAt = spread(RELEASED, N);
const runningAt = spread(RUNNING, N);
for (let i = 0; i < N; i++) {
  const m = `m${i % M}`;
  const sb = `slot${(i >> 3) % SB}`;
  const released = releasedAt.has(i);
  // i + 1: a running session is never a released one.
  const running = !released && runningAt.has(i + 1);
  sessions.push({
    id: `s${i.toString(16).padStart(7, '0')}`,
    kind: 'worker',
    title: `w${6000 + (i % 400)}: ${text(i, 8)}`,
    status: running ? 'running' : i % 25 === 0 ? 'idle' : 'stopped',
    permissionMode: 'bypassPermissions',
    createdAt: T,
    lastActivityAt: T,
    turns: 12,
    costUsd: 3.21,
    pendingPermissions: [],
    sdkSessionId: `0f8c${i}-aaaa-bbbb-cccc-1234567890ab`,
    lastResult: `${text(i, 60)}\n`.repeat(4),
    machineId: m,
    machineSandbox: sb,
    ...(released ? { placeReleased: { sandbox: sb, branch: `sandbox/${sb}-w${i}`, at: T, why: "its check-in is far" } } : {}),
    ...(i % 31 === 0 || released ? { wakeAt: new Date(Date.now() + 3_600_000).toISOString() } : {}),
  } as unknown as SessionInfo);
}
for (const s of sessions) store.sessions.set(s.id, s);
for (let k = 0; k < M; k++) {
  const sbs = Array.from({ length: SB }, (_, j) => ({
    id: `slot${j}`,
    branch: `sandbox/slot${j}`,
    path: `/sb/m${k}/slot${j}`,
    status: 'ready',
    createdAt: T,
    unity: { state: j % 3 === 0 ? 'running' : 'stopped' },
    sessionIds: sessions.filter((s) => s.machineId === `m${k}` && s.machineSandbox === `slot${j}`).map((s) => s.id),
    git: { branch: `sandbox/slot${j}`, dirty: 0, untracked: 0, ahead: 0, behind: 0, at: new Date().toISOString() },
  }));
  store.machines.set(`m${k}`, { id: `m${k}`, host: `m${k}`, purpose: 'work', status: 'ready', online: true, repoPath: '/r', home: '/h', portalUrl: 'http://x', sandboxRoot: '/sb', maxSandboxes: SB, sessionIds: [], createdAt: T, sandboxes: sbs } as unknown as Machine);
}
const byId = new Map(sessions.map((s) => [s.id, s]));
const releasedIds = sessions.filter((s) => s.placeReleased).map((s) => s.id);
// Workers that hold many requests (a long-lived worker is sent a request after another), as holdsOf reads them.
const heavyIds = Array.from({ length: Math.min(HEAVY, N) }, (_, k) => sessions[Math.floor((k * N) / HEAVY)].id);
for (let i = 0; i < W; i++) {
  // The last OPEN requests are open and held by released workers first (they wait to resume), the last QUEUED_WORK are Queued
  // game work nobody holds yet; every other is closed, held by a session round-robin (and by a heavy one every 8th).
  const fromEnd = W - 1 - i;
  const queuedWork = fromEnd < QUEUED_WORK;
  const open = !queuedWork && fromEnd < QUEUED_WORK + OPEN;
  const s = open && releasedIds.length ? byId.get(releasedIds[i % releasedIds.length])! : i % 8 === 0 && heavyIds.length ? byId.get(heavyIds[i % heavyIds.length])! : sessions[i % N];
  const created = new Date(Date.now() - 86_400_000 + i * 1000).toISOString();
  store.work.set(`w${i}`, {
    id: `w${i}`,
    title: text(i, 10),
    brief: `${text(i, 200)}\n`.repeat(3),
    status: queuedWork ? 'queued' : open ? (i % 5 === 0 ? 'blocked' : 'active') : 'done',
    priority: PRIORITIES[(i * 7) % PRIORITIES.length],
    createdAt: created,
    updatedAt: created,
    keys: [`ref:${i}`],
    sessionIds: queuedWork ? [] : [s.id],
    ...(queuedWork ? {} : { links: { [s.id]: { at: created, how: 'sent' } } }),
    requesters: [{ userId: "lothsahn", displayName: "lothsahn" }],
    humanAsked: true,
    prs: [],
    log: Array.from({ length: 40 }, (_, k) => `10:${String(k).padStart(2, '0')} worker ${s.id}: ${text(i + k, 14)}`),
    findings: `${text(i, 120)}\n`.repeat(2),
    requestedBy: { userId: 'lothsahn', displayName: 'lothsahn' },
  } as unknown as WorkItem);
}
const people: UserInfo[] = [{ userId: 'lothsahn', displayName: 'lothsahn', role: 'owner' } as UserInfo];
const sm = new SessionManager(cfg, store);
const machines = new MachineManager(cfg, store, sm);
// Released workers with a message waiting (the live portal had dozens): their resumes are what claims() places.
const waiting = [...spread(QUEUED, releasedIds.length)].map((k) => releasedIds[k]);
(sm as unknown as { queue: unknown[] }).queue.push(...waiting.map((id, i) => ({ uuid: `q${i}`, id, text: 'go on', from: 'orchestrator', at: T, why: 'capacity' })));
// Every session has a handle, as the portal restores them (SessionManager.restore); a running one has its process.
for (const s of sessions) sm.sessions.set(s.id, { info: s, live: s.status === 'running', lastFrom: 'system', stop: () => {} } as unknown as SessionHandle);
// Computers online with their daemon's report (MachineManager.links and stats): placement reads both, and an offline one is no room.
if (ONLINE) {
  const m = machines as unknown as { links: Map<string, unknown>; stats: Map<string, unknown> };
  for (const k of store.machines.keys()) {
    m.links.set(k, { ws: {}, lastPong: Date.now(), since: Date.now() });
    m.stats.set(k, { at: T, hostname: k, platform: 'win32', cpuModel: 'x', cpuCount: 16, loadPct: 20, memTotalBytes: 64e9, memFreeBytes: 32e9, unity: { limit: 2, used: 1, interactive: 1, batch: 0, outside: 0, players: 0, overLimit: false, ramLimitPct: 90, waiting: [], granted: [{ label: 'editor', count: 1, holder: 'sandbox:slot0', since: T }], at: T } });
  }
}
const agents = new Agents(cfg, store, sm, machines, new Identity(cfg, () => people));

// The release pass reads the queued game work's pressure each minute and leaves it for claims() until the next pass (PlaceAgain.reclaimPass).
{
  const pa = agents.placeAgain as unknown as { pressureNow: unknown[]; pairsNow: unknown[]; d: { pressure(): unknown[]; pairWants(): unknown[] } };
  agents.placementRead(() => {
    pa.pressureNow = pa.d.pressure();
    pa.pairsNow = pa.d.pairWants();
  });
}

const time = (label: string, fn: () => unknown, rounds = 5) => {
  if (PLACE_ONLY) return;
  fn();
  const ms: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    fn();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  console.log(`${label.padEnd(58)} median ${ms[rounds >> 1].toFixed(1).padStart(8)} ms  max ${ms.at(-1)!.toFixed(1).padStart(8)} ms`);
};
const ms = [...store.machines.values()];
console.log(`synthetic portal: ${N} sessions, ${W} requests, ${M} machines x ${SB} sandboxes`);
// w6428: a page's state build, its 'machines' and 'room' phases (server/index.ts appStateIn): each machine's view, then the
// room and its extras. Before: places once and one claims memo; after: pageRead, each sandbox's FREE once as well.
const pagePlacement = () => {
  ms.map((m) => agents.sandboxesFree(m.id, m.sandboxes!));
  agents.roomNow();
  agents.roomExtras();
};
// w6513: a daemon disconnect (15:44Z on 2026-11-27, lothdesktop: a 5.0 s block under drain > withClaimsMemo): m0 goes offline
// and the drain walks every queued send, those for m0's workers held on it. --drainRounds K: only that drain, K times (a CPU profile).
const DRAIN_ROUNDS = arg('drainRounds', 0);
const disconnect = () => {
  const m = machines as unknown as { links: Map<string, unknown> };
  m.links.delete('m0');
  store.machines.get('m0')!.online = false;
};
if (DRAIN_ROUNDS > 0) {
  // --held N: N of m0's workers that sit stopped in their sandbox (not released), each on an open request, get a send. Nothing
  // holds them before the send itself, which throws as MachineManager.dispatchSend does while m0's daemon is away.
  // --others 0: the bench's other waiting sends are left out (default: kept, as the live queue has them).
  const HELD = arg('held', 60);
  const q = (sm as unknown as { queue: unknown[] }).queue;
  if (arg('others', 1) <= 0) q.splice(0, Infinity);
  // m0's workers mid-turn are idle once its daemon is gone (the live case: nothing there runs), so its sends reach the send.
  for (const s of sessions.filter((x) => x.machineId === 'm0' && x.status === 'running')) {
    s.status = 'stopped';
    (sm.sessions.get(s.id) as unknown as { live: boolean }).live = false;
  }
  const onM0 = sessions.filter((s) => s.machineId === 'm0' && !s.placeReleased && s.status !== 'running').slice(0, HELD);
  // --full N: N sends for m1's stopped workers too, m1 online with every sandbox at max_agents_per_sandbox (two mid-turn in
  // each), interleaved with m0's: each is held by placeFull, which reads claims and places.
  const FULL = arg('full', 0);
  const onM1: SessionInfo[] = [];
  if (FULL > 0) {
    for (const sb of store.machines.get('m1')!.sandboxes!) {
      const here = sessions.filter((s) => s.machineId === 'm1' && s.machineSandbox === sb.id && !s.placeReleased);
      for (const s of here.slice(0, 2)) {
        s.status = 'running';
        (sm.sessions.get(s.id) as unknown as { live: boolean }).live = true;
      }
      onM1.push(...here.slice(2).filter((s) => s.status !== 'running'));
    }
    onM1.splice(FULL);
  }
  const mix = onM0.flatMap((s, i) => (onM1[i] ? [s, onM1[i]] : [s])).concat(onM1.slice(onM0.length));
  mix.forEach((s, i) => {
    const id = `wh${i}`;
    store.work.set(id, { ...store.work.get(`w${W - 1}`)!, id, status: 'active', queuedFor: undefined, sessionIds: [s.id], links: { [s.id]: { at: T, how: 'sent' } } } as unknown as WorkItem);
    q.push({ uuid: `h${i}`, id: s.id, text: 'go on', from: 'orchestrator', at: new Date().toISOString(), why: 'capacity' });
    const h = sm.sessions.get(s.id) as unknown as { send: () => string };
    h.send = () => {
      if (!(machines as unknown as { links: Map<string, unknown> }).links.has(s.machineId!)) throw new Error(`machine ${s.machineId} is offline (asleep, or its daemon is not running)`);
      return 'sent';
    };
  });
  disconnect();
  for (let r = 0; r < DRAIN_ROUNDS; r++) {
    const marks = [costMark(agents.placeCost.free), costMark(agents.placeCost.places), costMark(agents.placeAgain.claimsCost)] as const;
    const t0 = performance.now();
    sm.drain();
    const place = `${costSince('places', agents.placeCost.places, marks[1])}${costSince('free', agents.placeCost.free, marks[0])}${costSince('claims', agents.placeAgain.claimsCost, marks[2])}`.trim();
    console.log(`drain after m0's daemon disconnected, run ${r + 1}: ${(performance.now() - t0).toFixed(1)} ms, ${sm.queued().length} still queued  place{${place}}`);
  }
  if (arg('why', 0) > 0) {
    const left = new Set(sm.queued().map((x) => x.id));
    for (const s of onM0.filter((x) => !left.has(x.id)).slice(0, 3)) console.log('gone', s.id, s.status, JSON.stringify(store.readTranscript(s.id).slice(-2)).slice(0, 400));
    for (const x of sm.queued().slice(0, 3)) console.log('held', x.id, (x as { why?: string }).why);
  }
  process.exit(0);
}
// w6769: the release pass (PlaceAgain.tick) and the blocker watch's look (BlockerWatch.tick), the portal's two largest causes of
// blocks on 2026-11-28 (267 s and 169 s of 653 s blocked from 05Z to 12Z). --tickRounds K: each K times with its place{} line;
// --callers 1 also counts where each placesNow was asked from.
const TICK_ROUNDS = arg('tickRounds', 0);
if (TICK_ROUNDS > 0) {
  const { BlockerWatch } = await import('../server/blockerWatch.ts');
  const callers = new Map<string, number>();
  if (arg('callers', 0) > 0) {
    const a = agents as unknown as { placesNow: () => unknown };
    const real = a.placesNow.bind(agents);
    a.placesNow = () => {
      const at = (new Error().stack ?? '').split('\n').slice(2).filter((l) => !/placesNow|withClaimsMemo|places \(|withPlacesOnce/.test(l)).slice(0, 3).map((l) => l.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ');
      callers.set(at, (callers.get(at) ?? 0) + 1);
      return real();
    };
  }
  const watch = new BlockerWatch({
    store,
    orchestrators: agents.orchestrators,
    room: () => agents.roomNow(),
    roomFacts: () => agents.roomFacts(),
    legacyPairs: () => agents.recheckLegacyPairs(),
    ...(arg('before', 0) > 0 ? {} : { placementOnce: <T>(fn: () => T) => agents.placementRead(fn), placementChanged: () => agents.placementReadChanged() }),
    queued: (id: string) => sm.queued().some((q) => q.id === id),
    benchResume: () => agents.resumeBenchWaits(),
    awayMove: () => agents.moveAwayWork(),
  } as unknown as ConstructorParameters<typeof BlockerWatch>[0]);
  const line = async (label: string, fn: () => unknown) => {
    for (let r = 0; r < TICK_ROUNDS; r++) {
      const marks = [costMark(agents.placeCost.free), costMark(agents.placeCost.places), costMark(agents.placeAgain.claimsCost)] as const;
      const t0 = performance.now();
      await fn();
      const place = `${costSince('places', agents.placeCost.places, marks[1])}${costSince('free', agents.placeCost.free, marks[0])}${costSince('claims', agents.placeAgain.claimsCost, marks[2])}`.trim();
      console.log(`${label}, run ${r + 1}: ${(performance.now() - t0).toFixed(1)} ms  place{${place}}`);
    }
  };
  await line('release pass (placeAgain.tick)', () => agents.placeAgain.tick());
  await line('blocker watch (BlockerWatch.tick)', () => watch.tick());
  for (const [at, n] of [...callers].sort((x, y) => y[1] - x[1])) console.log(`placesNow x${n}: ${at}`);
  process.exit(0);
}
// --placeRounds K: only the page placement, K times, for a CPU profile (node --cpu-prof) that is mostly placement.
if (PLACE_ROUNDS > 0) {
  for (let r = 0; r < PLACE_ROUNDS; r++) agents.pageRead(pagePlacement);
  process.exit(0);
}
// machineView (server/index.ts): FREE for each sandbox of one machine, as one machine event is sent.
time('machine event: FREE of each sandbox, one machine (bare)', () => ms[0].sandboxes!.map((sb) => agents.sandboxFree(ms[0].id, sb)));
time('machine event: FREE of each sandbox, one machine (memo)', () => agents.placeAgain.withClaimsMemo(() => ms[0].sandboxes!.map((sb) => agents.sandboxFree(ms[0].id, sb))));
time('machine event: sandboxesFree, one machine (w6381)', () => agents.sandboxesFree(ms[0].id, ms[0].sandboxes!));
time('5 s FREE resend: every machine (bare)', () => ms.map((m) => m.sandboxes!.map((sb) => agents.sandboxFree(m.id, sb))));
time('5 s FREE resend: every machine (one memo, w6381)', () => agents.placeAgain.withClaimsMemo(() => ms.map((m) => agents.sandboxesFree(m.id, m.sandboxes!))));
time('pushBenchPriorities: every machine (bare)', () => ms.map((m) => agents.benchPriorities(m.id)));
time('pushBenchPriorities: every machine (one pass)', () => agents.withPlacesOnce(() => agents.placeAgain.withClaimsMemo(() => ms.map((m) => agents.benchPriorities(m.id)))));
time('describeAllSandboxes (places once only, before)', () => agents.withPlacesOnce(() => (agents as unknown as { describeAllSandboxesNow(d: boolean): string }).describeAllSandboxesNow(false)));
time('describeAllSandboxes (w6381)', () => agents.describeAllSandboxes());
time('page build machines + room (one pass, before)', () => agents.withPlacesOnce(() => agents.placeAgain.withClaimsMemo(pagePlacement)));
time('page build machines + room (pageRead, w6428)', () => agents.pageRead(pagePlacement));
// The page line's 'place{...}' (server/index.ts, 'page socket open'): live 2026-11-27 18:04Z, one build: places 45ms x1 free 62ms x39 claims 49ms x6.
for (let r = 0; r < 4; r++) {
  const marks = [costMark(agents.placeCost.free), costMark(agents.placeCost.places), costMark(agents.placeAgain.claimsCost)] as const;
  const t0 = performance.now();
  agents.pageRead(pagePlacement);
  const took = performance.now() - t0;
  const place = `${costSince('places', agents.placeCost.places, marks[1])}${costSince('free', agents.placeCost.free, marks[0])}${costSince('claims', agents.placeAgain.claimsCost, marks[2])}`.trim();
  console.log(`${`page build machines + room, run ${r + 1}${r ? '' : ' (cold)'}`.padEnd(58)} ${took.toFixed(1).padStart(8)} ms  place{${place}}`);
}
{
  const pa = agents.placeAgain as unknown as { pressureNow: { priority: string; machines: string[] }[]; pairsNow: unknown[] };
  const waitingNow = agents.pageRead(() => ms.reduce((n, m) => n + agents.placeAgain.waiting(m.id).length + agents.placeAgain.claims(m.id).size, 0));
  console.log(`placement shape: ${[...store.sessions.values()].filter((s) => s.placeReleased).length} released, ${(sm as unknown as { queue: unknown[] }).queue.length} queued sends, pressure ${pa.pressureNow.length} (${pa.pressureNow.filter((p) => p.machines.length).length} with a computer), ${waitingNow} waiting or claimed, ${[...store.work.values()].filter((w) => w.status === 'queued').length} queued requests, ${[...store.work.values()].filter((w) => w.status === 'active' || w.status === 'blocked').length} active or blocked`);
}
{
  const sbCount = ms.reduce((n, m) => n + m.sandboxes!.length, 0);
  let f0 = agents.freeMade;
  agents.withPlacesOnce(() => agents.placeAgain.withClaimsMemo(pagePlacement));
  const before = agents.freeMade - f0;
  f0 = agents.freeMade;
  agents.pageRead(pagePlacement);
  console.log(`page build machines + room: free() worked out ${before} times before, ${agents.freeMade - f0} with pageRead, for ${sbCount} sandboxes`);
}
// --count 1: how many times one page build calls what claims() and places() lean on (the wrapped calls stay wrapped after).
if (arg('count', 0) > 0) {
  const counts = new Map<string, number>();
  const wrap = (o: Record<string, unknown>, name: string, label = name) => {
    const fn = o[name] as (...a: unknown[]) => unknown;
    if (typeof fn !== 'function') return;
    o[label === name ? name : name] = (...a: unknown[]) => (counts.set(label, (counts.get(label) ?? 0) + 1), fn.apply(o, a));
  };
  const d = (agents.placeAgain as unknown as { d: Record<string, unknown> }).d;
  for (const name of ['queued', 'agentOnly', 'priorityOf', 'workOver', 'ciWait', 'waitOn', 'unityHolders', 'order', 'isLive', 'sessions']) wrap(d, name, `d.${name}`);
  wrap(sm as unknown as Record<string, unknown>, 'queued', 'SessionManager.queued');
  wrap(agents as unknown as Record<string, unknown>, 'workIdsOf', 'Agents.workIdsOf');
  wrap(agents as unknown as Record<string, unknown>, 'openWorkOf', 'Agents.openWorkOf');
  agents.pageRead(pagePlacement);
  console.log(`calls in one page build: ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
if (PLACE_ONLY) process.exit(0);
const persisted = () => ({ sandboxes: [], sessions: [...store.sessions.values()], machines: [...store.machines.values()], settings: store.settings });
const work = () => ({ seq: W, items: [...store.work.values()] });
time('state.json JSON.stringify(.., null, 2)', () => JSON.stringify(persisted(), null, 2), 3);
time('work.json JSON.stringify(.., null, 2)', () => JSON.stringify(work(), null, 2), 3);
console.log(`state.json ${(JSON.stringify(persisted(), null, 2).length / 1e6).toFixed(1)} MB, work.json ${(JSON.stringify(work(), null, 2).length / 1e6).toFixed(1)} MB`);
// A snapshot's background save as SnapshotFile runs it, before (one JSON.stringify, the string written whole) and after (w6381:
// stringifyPrettyPieces, written in pieces): the longest the event loop went without a turn (what a stall profile sees).
const longestHold = async (fn: () => Promise<unknown>) => {
  let worst = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);
  const t0 = performance.now();
  await fn();
  const total = performance.now() - t0;
  clearInterval(tick);
  worst = Math.max(worst, performance.now() - last);
  return `longest hold ${worst.toFixed(1).padStart(8)} ms  total ${total.toFixed(0)} ms`;
};
for (const [label, v] of [['state.json', persisted()], ['work.json', work()]] as const) {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'save-')), label);
  console.log(`${`${label} save, one go (before)`.padEnd(58)} ${await longestHold(() => writeFileDurableAsync(file, JSON.stringify(v, null, 2)))}`);
  console.log(`${`${label} save, in pieces (w6381)`.padEnd(58)} ${await longestHold(async () => writeFileDurableAsync(file, await stringifyPrettyPieces(v)))}  same: ${fs.readFileSync(file, 'utf8') === JSON.stringify(v, null, 2)}`);
}
{
  (agents.orchestrators as unknown as { boardTexts: Map<string, unknown> }).boardTexts.clear();
  const made = await agents.orchestrators.warmBoardTexts(30);
  const t0 = performance.now();
  agents.orchestrators.boardCheck({ keys: [], title: 'belt splitter desync on join', summary: text(3, 40) }, 30);
  console.log(`${'board check, first after warmBoardTexts (w6381)'.padEnd(58)} ${(performance.now() - t0).toFixed(1).padStart(8)} ms  (${made} made by the warm-up)`);
}
time('board check, cold concepts cache (first after a start)', () => {
  (agents.orchestrators as unknown as { boardTexts: Map<string, unknown> }).boardTexts.clear();
  agents.orchestrators.boardCheck({ keys: [], title: 'belt splitter desync on join', summary: text(3, 40) }, 30);
}, 3);
time('board check, warm', () => agents.orchestrators.boardCheck({ keys: [], title: 'belt splitter desync on join', summary: text(3, 40) }, 30));
agents.orchestrators.close();
agents.close();
sm.stopAll();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);

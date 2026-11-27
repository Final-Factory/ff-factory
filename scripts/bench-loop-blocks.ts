/**
 * The portal's remaining event-loop blocks (w6381), measured on a synthetic portal of a real one's size: each path the
 * stall profiles named, timed as the portal runs it. Local only: CI runs no timing tests (CONTRIBUTING.md "Performance").
 *
 *   node --import ./scripts/testEnv.ts scripts/bench-loop-blocks.ts [--sessions 977] [--work 6400] [--machines 6] [--sandboxes 8]
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
import type { Machine, SessionInfo, UserInfo, WorkItem } from '../shared/types.ts';

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const N = arg('sessions', 977);
const W = arg('work', 6400);
const M = arg('machines', 6);
const SB = arg('sandboxes', 8);
const T = new Date(Date.now() - 86_400_000).toISOString();

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
for (let i = 0; i < N; i++) {
  const m = `m${i % M}`;
  const sb = `slot${(i >> 3) % SB}`;
  const released = i % 9 === 0;
  sessions.push({
    id: `s${i.toString(16).padStart(7, '0')}`,
    kind: 'worker',
    title: `w${6000 + (i % 400)}: ${text(i, 8)}`,
    status: i % 25 === 0 ? 'idle' : 'stopped',
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
    ...(i % 31 === 0 ? { wakeAt: new Date(Date.now() + 3_600_000).toISOString() } : {}),
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
    unity: { state: 'stopped' },
    sessionIds: sessions.filter((s) => s.machineId === `m${k}` && s.machineSandbox === `slot${j}`).map((s) => s.id),
    git: { branch: `sandbox/slot${j}`, dirty: 0, untracked: 0, ahead: 0, behind: 0, at: new Date().toISOString() },
  }));
  store.machines.set(`m${k}`, { id: `m${k}`, host: `m${k}`, purpose: 'work', status: 'ready', online: true, repoPath: '/r', home: '/h', portalUrl: 'http://x', sandboxRoot: '/sb', maxSandboxes: SB, sessionIds: [], createdAt: T, sandboxes: sbs } as unknown as Machine);
}
for (let i = 0; i < W; i++) {
  const s = sessions[i % N];
  store.work.set(`w${i}`, {
    id: `w${i}`,
    title: text(i, 10),
    brief: `${text(i, 200)}\n`.repeat(3),
    status: i > W - 120 ? 'active' : 'done',
    priority: 'normal',
    createdAt: T,
    updatedAt: T,
    keys: [`ref:${i}`],
    sessionIds: [s.id],
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
(sm as unknown as { queue: unknown[] }).queue.push(...sessions.filter((s, i) => s.placeReleased && i % 2 === 0).map((s, i) => ({ uuid: `q${i}`, id: s.id, text: 'go on', from: 'orchestrator', at: T, why: 'capacity' })));
const agents = new Agents(cfg, store, sm, machines, new Identity(cfg, () => people));

const time = (label: string, fn: () => unknown, rounds = 5) => {
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

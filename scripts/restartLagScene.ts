/**
 * w3843: the synthetic fleet and data folder of scripts/restart-lag-bench.ts, after a restart: the real Store, SessionManager,
 * MachineManager and Agents over every session ever kept, the ledger, and released workers whose resumes wait for room.
 * The bench times it; restartLagScene.test.ts checks the drain and the release pass place the same with and without the
 * placement memos. Log quietly around it (it logs as the portal does).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.ts';
import { SessionManager } from '../server/sessions.ts';
import { MachineManager } from '../server/machines.ts';
import { Agents } from '../server/agents.ts';
import { Identity } from '../server/identity.ts';
import type { Config } from '../server/config.ts';
import type { Machine, SessionInfo, WorkItem } from '../shared/types.ts';

export interface SceneOptions {
  /** Sessions ever kept (each computer's sandboxes take the workers in turn). */
  sessions: number;
  /** Requests in the ledger (the newest 300 open). */
  work: number;
  /** Released workers whose resume message waits for room. */
  queue: number;
  /** Queued game requests with no sandbox (the release pass's reclaim reads the room for them). */
  pressure: number;
  /** The scene's clock (default: now). */
  now?: number;
  /** Its data folder (default: a new one in TMPDIR). */
  dir?: string;
}

export function restartScene(o: SceneOptions) {
  const N = o.sessions;
  const W = o.work;
  const Q = o.queue;
  const P = o.pressure;
  const NOW = o.now ?? Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const dir = o.dir ?? fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'restart-lag-'));
  const cfg = {
    dataDir: dir,
    sandboxRoot: dir,
    standingRoot: path.join(dir, '_agents'),
    repo: { url: path.join(dir, 'base'), basePath: path.join(dir, 'base') },
    defaultBase: 'origin/master',
    models: ['opus'],
    defaultModel: 'opus',
    protectedPaths: [],
    limits: { maxSessions: 30, maxUnity: 3, maxSandboxes: 10, minFreeGB: 0, minFreeRamGB: 0 },
    orchestrator: { model: 'opus', effort: 'low', notifyOnWorkerEvents: false },
    worker: { permissionMode: 'bypassPermissions', effort: 'low' },
    unity: {},
  } as unknown as Config;

  // Six computers of 4 to 10 sandboxes, as the fleet was on 2026-11-09.
  const fleet: [string, number][] = [['beast', 10], ['lothdesktop', 8], ['lothlaptop', 4], ['m5', 6], ['biscuit', 6], ['m3', 4]];
  const store = new Store(dir);
  const sbOf = (m: string, i: number, ids: string[]) => ({ id: `slot${i + 1}`, branch: `sandbox/slot${i + 1}`, base: 'origin/master', path: `/${m}/slot${i + 1}`, purpose: 'work', status: 'ready', createdAt: iso(NOW - 30 * 86_400_000), unity: { state: 'stopped' }, sessionIds: ids, git: { branch: `sandbox/slot${i + 1}`, dirty: 0, untracked: 0, at: iso(NOW) } });
  const slots = fleet.flatMap(([m, n]) => Array.from({ length: n }, (_, i) => ({ m, sb: `slot${i + 1}` })));
  const sessionIds = new Map<string, string[]>();
  const ids: string[] = [];
  const released: string[] = [];
  const occupants: string[] = [];
  for (let i = 0; i < N; i++) {
    const id = `s${String(i).padStart(6, '0')}`;
    ids.push(id);
    const orch = i % 12 === 11;
    const slot = slots[i % slots.length];
    const recent = i >= N - slots.length; // the newest worker in each sandbox: mid-turn there now
    const rel = !orch && !recent && i >= N - slots.length - Q * 3 && i % 3 === 0;
    const info = {
      id,
      kind: orch ? 'orchestrator' : 'worker',
      title: `w${i % 4000}: work ${i}`,
      status: 'stopped',
      permissionMode: 'bypassPermissions',
      createdAt: iso(NOW - (N - i) * 300_000),
      lastActivityAt: iso(NOW - (recent ? 60_000 : rel ? 3_600_000 : (N - i) * 300_000)),
      turns: 4,
      costUsd: 1,
      pendingPermissions: [],
      sdkSessionId: `sdk-${id}`,
      ...(orch ? {} : { machineId: slot.m, machineSandbox: slot.sb }),
      ...(rel ? { placeReleased: { at: iso(NOW - 1_800_000), sandbox: slot.sb, branch: `feature/${id}`, why: 'its check-in is far' } } : {}),
    } as unknown as SessionInfo;
    store.sessions.set(id, info);
    if (rel) released.push(id);
    if (recent) occupants.push(id);
    if (!orch) {
      const k = `${slot.m}/${slot.sb}`;
      sessionIds.set(k, [...(sessionIds.get(k) ?? []), id]);
    }
  }
  for (const [m, n] of fleet) {
    const rec = { id: m, host: m, purpose: 'work', status: 'ready', online: true, lastSeen: iso(NOW - 120_000), repoPath: '/r', home: '/h', portalUrl: 'http://x', maxSessions: 6, sandboxRoot: '/s', sessionIds: [], createdAt: iso(NOW - 60 * 86_400_000), sandboxes: Array.from({ length: n }, (_, i) => sbOf(m, i, (sessionIds.get(`${m}/slot${i + 1}`) ?? []).slice(-40))) } as unknown as Machine;
    store.machines.set(m, rec);
  }
  for (let i = 0; i < W; i++) {
    const open = i >= W - 300;
    const sids = [ids[(i * 5) % N], ids[(i * 5 + 1) % N], ids[(i * 5 + 2) % N]];
    const r = open ? released[i % Math.max(1, released.length)] : undefined;
    if (r) sids.push(r);
    const w = { id: `w${i}`, title: `w${i}`, brief: 'b', keys: [], status: open ? (i % 3 ? 'blocked' : 'working') : 'done', priority: 'normal', requestedBy: { userId: 'ben', displayName: 'Ben' }, requesters: [], humanAsked: true, sessionIds: [...new Set(sids)], links: Object.fromEntries(sids.map((s, k) => [s, { at: iso(NOW - (4 - k) * 60_000), how: 'sent' }])), log: [], createdAt: iso(NOW - (W - i) * 600_000), updatedAt: iso(NOW - (W - i) * 600_000), ...(open && i % 3 ? { blocked: { kind: 'pr', ref: 'o/r#1', at: iso(NOW), by: `worker ${sids[0]}` } } : {}) } as unknown as WorkItem;
    store.work.set(w.id, w);
  }
  // Queued game work with no room: the release pass's reclaim reads places() for it (Agents.reclaimPressure).
  for (let i = 0; i < P; i++) {
    const w = { id: `wq${i}`, title: `wq${i}`, brief: 'b', keys: [], status: 'queued', priority: i % 2 ? 'high' : 'normal', requestedBy: { userId: 'ben', displayName: 'Ben' }, requesters: [], humanAsked: true, sessionIds: [], links: {}, log: [], createdAt: iso(NOW - 600_000), updatedAt: iso(NOW - 600_000) } as unknown as WorkItem;
    store.work.set(w.id, w);
  }

  const sessions = new SessionManager(cfg, store);
  const machines = new MachineManager(cfg, store, sessions);
  const agents = new Agents(cfg, store, sessions, machines, new Identity(cfg, () => []));
  agents.boot();
  // After the restart every daemon is back: online, with no process the portal can reach (a send throws and stays queued).
  const online = new Set(fleet.map(([m]) => m));
  (machines as unknown as { isOnline: (id: string) => boolean }).isOnline = (id) => online.has(id);
  // A placement's branch switch goes to the daemon and is answered later (PlaceAgain.move awaits it), as on a connected machine.
  (machines as unknown as { switchBranch: () => Promise<never> }).switchBranch = () => new Promise(() => {});
  // Each sandbox's newest worker is mid-turn there (its sandbox is not free), so a released worker's resume waits for room.
  for (const id of occupants) store.sessions.get(id)!.status = 'running';
  // Released workers whose message waits for a sandbox on their own computer, queued two minutes ago (past MOVE_AFTER_MS).
  const queue = (sessions as unknown as { queue: unknown[] }).queue;
  for (const id of released.slice(0, Q)) {
    const m = store.sessions.get(id)!.machineId!;
    queue.push({ uuid: `q-${id}`, id, text: 'Your check-in is due.', from: 'system', at: iso(NOW - 120_000), why: `no sandbox on ${m} is free`, on: 'capacity' });
  }
  return { dir, cfg, store, sessions, machines, agents, fleet, slots, released, occupants, NOW };
}

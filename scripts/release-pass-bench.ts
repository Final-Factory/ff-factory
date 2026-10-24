// w2026 bench: one release pass (PlaceAgain.tick) with the real Agents methods (workOver, ciWait, waitOn, resumeOrder) over a
// synthetic production-sized ledger. Local only (CONTRIBUTING.md "Performance"). Usage: node scripts/release-pass-bench.ts [repo dir] [sessions] [requests] [released]
import path from 'node:path';
const repo = process.argv[2] ?? path.join(import.meta.dirname, '..');
const S = Number(process.argv[3] ?? 4000);
const W = Number(process.argv[4] ?? 2100);
const R = Number(process.argv[5] ?? 150);
const { PlaceAgain } = await import(path.join(repo, 'server/placeAgain.ts'));
const agentsMod = await import(path.join(repo, 'server/agents.ts'));
const { Agents } = agentsMod;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const machines = ['beast', 'lothdesktop', 'lothlaptop', 'm5', 'biscuit'];
const sb = (id: string) => ({ id, branch: `sandbox/${id}`, base: 'origin/master', path: `/sb/${id}`, purpose: id, status: 'ready', createdAt: iso(NOW - 86_400_000), unity: { state: 'stopped' }, sessionIds: [], git: { branch: `sandbox/${id}`, dirty: 0, untracked: 0, at: iso(NOW) } });
const mach = new Map(machines.map((m) => [m, { id: m, sandboxes: Array.from({ length: 6 }, (_, i) => sb(`slot${i + 1}`)) }]));
const sessions = new Map<string, any>();
for (let i = 0; i < S; i++) {
  const id = `s${String(i).padStart(5, '0')}`;
  const rel = i < R;
  sessions.set(id, { id, kind: i % 10 === 9 ? 'orchestrator' : 'worker', machineId: machines[i % 5], machineSandbox: `slot${(i % 6) + 1}`, title: `w${i}: x`, status: 'stopped', permissionMode: 'default', createdAt: iso(NOW - 5 * 86_400_000), lastActivityAt: iso(NOW - (rel ? 3_600_000 : 3 * 86_400_000)), turns: 1, costUsd: 0, pendingPermissions: [], ...(rel ? { placeReleased: { at: iso(NOW - 600_000), sandbox: `slot${(i % 6) + 1}`, branch: `feature/${id}`, why: 'far' }, wakeAt: iso(NOW + 3_600_000) } : {}) });
}
const ids = [...sessions.keys()];
const work = new Map<string, any>();
for (let i = 0; i < W; i++) {
  const sids = [ids[(i * 2) % S], ids[(i * 2 + 1) % S], ids[(i * 7) % S]];
  const open = i > W - 300;
  work.set(`w${i}`, { id: `w${i}`, title: 't', brief: 'b', status: open ? (i % 3 ? 'blocked' : 'working') : 'done', priority: 'normal', sessionIds: [...new Set(sids)], links: Object.fromEntries(sids.map((s, k) => [s, { at: iso(NOW - (3 - k) * 60_000) }])), ...(open && i % 3 ? { blocked: { kind: 'pr', ref: 'o/r#1', at: iso(NOW), by: `worker ${sids[0]}` } } : {}), createdAt: iso(NOW - 86_400_000), updatedAt: iso(NOW - 86_400_000) });
}
const self: any = Object.create(Agents.prototype);
self.store = { work, sessions, machines: mach };
self.workLive = () => new Map();
self.liveHub = undefined;
const deps: any = {
  sessions: () => sessions.values(),
  machine: (id: string) => mach.get(id),
  isLive: () => false,
  online: () => true,
  unityHolders: () => [],
  workOver: (i: any) => self.workOver(i),
  order: (a: any, b: any) => self.resumeOrder(a, b),
  ciWait: (i: any) => self.ciWait(i),
  waitOn: (i: any) => self.waitOn(i),
  keepLive: () => undefined,
  queued: (id: string) => sessions.get(id)?.placeReleased !== undefined,
  stopLive: () => undefined,
  stopEditor: async () => undefined,
  switchBranch: async () => ({ notes: [] }),
  save: () => undefined,
  saveMachine: () => undefined,
  note: () => undefined,
  drain: () => undefined,
  now: () => NOW,
};
if (agentsMod.workByWorker) {
  deps.pass = (run: () => unknown) => {
    self.workByWorker = agentsMod.workByWorker(work.values());
    try {
      return run();
    } finally {
      self.workByWorker = undefined;
    }
  };
}
const log = console.log;
console.log = () => {};
const p = new PlaceAgain(deps);
const t0 = performance.now();
p.tick();
const ms = performance.now() - t0;
console.log = log;
console.log(`${path.basename(repo)}: ${S} sessions, ${W} requests, ${R} released: one release pass held the loop ${ms.toFixed(0)} ms`);

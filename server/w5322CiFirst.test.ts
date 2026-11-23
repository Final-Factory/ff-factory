import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BISCUIT_CI_FIRST, CI_FIRST, CiFirst, parseScopeList, parseScopeShow, type CiFirstDeps, type ScopeInfo } from '../machine/ciFirst.ts';
import type { RunnerCensus } from '../machine/benchRunners.ts';

/**
 * w5322: biscuit's ffu runner units run at Nice=10, CPUWeight=50 (w2896), so FF Factory's scopes, at the default weight 100
 * and nice 0, took the CPU ahead of the `check` job. The daemon lowers its own scopes below them; no real unit is touched.
 */
const AGENT = '/user.slice/user-1000.slice/user@1000.service/app.slice/ffw-agent-w5322-mi1abc1.scope';
const UNITY = '/user.slice/user-1000.slice/user@1000.service/app.slice/ffw-unity-slot2-mi1abc2.scope';
const R2 = '/home/ben-ryding/ffw/ffu-runners/ffu-biscuit-2';

function rig(o: { scopes?: ScopeInfo[]; census?: RunnerCensus; settings?: CiFirstDeps['settings'] | null } = {}) {
  const nice = new Map<number, number>([
    [100, 0],
    [101, 0],
    [102, 19],
    [200, 0],
    [900, 10],
  ]);
  const tasks: Record<number, number[]> = { 100: [100, 101], 102: [102], 200: [200] };
  const procs: Record<string, number[]> = { [AGENT]: [100, 102], [UNITY]: [200] };
  const set: string[] = [];
  const lines: string[] = [];
  let census: RunnerCensus = o.census ?? { listeners: [], workers: [], leftovers: [] };
  let scopes: ScopeInfo[] = o.scopes ?? [
    { unit: 'ffw-agent-w5322-mi1abc1.scope', cgroup: AGENT },
    { unit: 'ffw-unity-slot2-mi1abc2.scope', cgroup: UNITY, cpuWeight: 5, ioWeight: 10 },
  ];
  const d: CiFirstDeps = {
    settings: o.settings === null ? undefined : (o.settings ?? BISCUIT_CI_FIRST),
    scopes: async () => scopes,
    setWeights: async (unit, cpu, io) => {
      set.push(`${unit} ${cpu} ${io}`);
      scopes = scopes.map((x) => (x.unit === unit ? { ...x, cpuWeight: cpu, ioWeight: io } : x));
    },
    pids: (cg) => procs[cg] ?? [],
    tasks: (pid) => tasks[pid] ?? [],
    niceOf: (tid) => nice.get(tid),
    setNice: (tid, n) => (nice.set(tid, n), true),
    census: async () => census,
    cgroupWeightOf: (pid) => (pid === 900 ? '50' : '-'),
    cgroupWeight: () => '5',
    log: (l) => void lines.push(l),
  };
  return {
    cf: new CiFirst(d),
    nice,
    set,
    lines,
    setCensus: (c: RunnerCensus) => void (census = c),
    setScopes: (s: ScopeInfo[]) => void (scopes = s),
  };
}

test('biscuit is a CI-first machine, below its runners (Nice=10, CPUWeight=50) on both', () => {
  assert.equal(CI_FIRST.biscuit, BISCUIT_CI_FIRST);
  assert.ok(BISCUIT_CI_FIRST.nice > 10 && BISCUIT_CI_FIRST.nice <= 19);
  assert.ok(BISCUIT_CI_FIRST.cpuWeight < 50);
  assert.equal(CI_FIRST.beast, undefined);
});

test('every thread of every FF Factory scope goes to nice 19 and each scope to the low weights, once', async () => {
  const r = rig();
  const res = await r.cf.tick();
  assert.deepEqual(r.set, ['ffw-agent-w5322-mi1abc1.scope 5 10']);
  assert.equal(res?.lowered, 3);
  for (const t of [100, 101, 102, 200]) assert.equal(r.nice.get(t), 19);
  assert.equal(r.nice.get(900), 10, 'the runner is never touched');
  assert.match(r.lines.join('\n'), /lowered 1 scope\(s\) to CPUWeight=5 IOWeight=10 .* and 3 thread\(s\) to nice 19/);
  r.setScopes([
    { unit: 'ffw-agent-w5322-mi1abc1.scope', cgroup: AGENT, cpuWeight: 5, ioWeight: 10 },
    { unit: 'ffw-unity-slot2-mi1abc2.scope', cgroup: UNITY, cpuWeight: 5, ioWeight: 10 },
  ]);
  const again = await r.cf.tick();
  assert.equal(again?.lowered, 0);
  assert.equal(r.set.length, 1);
  assert.equal(r.lines.length, 1, 'nothing to say when nothing changed');
});

test('a unit that is not one of the daemon\'s scopes is left alone', async () => {
  const r = rig({ scopes: [{ unit: 'ffu-biscuit-2.service', cgroup: AGENT }, { unit: 'session-2.scope', cgroup: UNITY }] });
  const res = await r.cf.tick();
  assert.equal(res?.scopes, 0);
  assert.deepEqual(r.set, []);
  assert.equal(r.nice.get(100), 0);
});

test('a CI job starting and ending is logged with both sides\' priorities', async () => {
  const r = rig();
  await r.cf.tick();
  r.setCensus({ listeners: [{ pid: 899, root: R2, busy: true }], workers: [{ pid: 900, root: R2 }], leftovers: [] });
  await r.cf.tick();
  const start = r.lines.at(-1) ?? '';
  assert.match(start, /CI job\(s\) running: ffu-biscuit-2 \(worker 900: nice 10, cpu\.weight 50\); FF Factory's 2 scope\(s\) at cpu\.weight 5, 4 thread\(s\), the highest at nice 19/);
  const n = r.lines.length;
  await r.cf.tick();
  assert.equal(r.lines.length, n, 'the same job is said once');
  r.setCensus({ listeners: [{ pid: 899, root: R2, busy: false }], workers: [], leftovers: [] });
  await r.cf.tick();
  assert.equal(r.lines.at(-1), 'ci first: no CI job running now');
});

test('off on a machine that is not CI-first', async () => {
  const r = rig({ settings: null });
  assert.equal(r.cf.enabled, false);
  assert.equal(await r.cf.tick(), undefined);
  assert.equal(r.nice.get(100), 0);
});

test('systemctl output parses into scopes and weights', () => {
  assert.deepEqual(parseScopeList('ffw-agent-w1-abc.scope loaded active running ffw-agent-w1-abc.scope\nffw-unity-s1-x.scope loaded active running y\nother.scope loaded active running z\n'), ['ffw-agent-w1-abc.scope', 'ffw-unity-s1-x.scope']);
  assert.deepEqual(parseScopeShow(`Id=ffw-agent-w1-abc.scope\nControlGroup=${AGENT}\nCPUWeight=[not set]\nIOWeight=[not set]\n\nId=ffw-unity-s1-x.scope\nControlGroup=${UNITY}\nCPUWeight=5\nIOWeight=10\n`), [
    { unit: 'ffw-agent-w1-abc.scope', cgroup: AGENT, cpuWeight: undefined, ioWeight: undefined },
    { unit: 'ffw-unity-s1-x.scope', cgroup: UNITY, cpuWeight: 5, ioWeight: 10 },
  ]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Deps, type InstanceList, listProblem, readState, settingsDiff, stableTarget, tick } from './instance/update-all.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const LEAD = 'https://lead.test';

/** A computer with instances: each portal answers its commit on its port; git moves HEAD; the portal drains on request. */
function world(names: string[], o: { headOf?: Record<string, string>; failBuild?: (sha: string) => boolean; noHealth?: Set<string>; onMain?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-'));
  const port: Record<string, number> = {};
  const head: Record<string, string> = {};
  const up: Record<string, boolean> = {};
  const calls: string[] = [];
  const log: string[] = [];
  let now = Date.parse('2026-11-14T20:00:00Z');
  let lead: string | undefined = B.slice(0, 7);
  const list: InstanceList = { version: 1, leader: { url: LEAD, stableMinutes: 5 }, drainMinutes: 1, healthMinutes: 1, instances: [] };
  names.forEach((n, k) => {
    const dir = path.join(root, n);
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'));
    port[n] = 9000 + k;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: port[n], dataDir: path.join(dir, 'data'), trustProxy: false }));
    head[n] = o.headOf?.[n] ?? A;
    up[n] = true;
    list.instances.push({ name: n, dir, portalTask: `ff${n}-portal`, expect: { trustProxy: true } });
  });
  const byApp = (cwd: string) => names.find((n) => path.join(root, n, 'app') === cwd)!;
  const byPort = (url: string) => names.find((n) => url === `http://127.0.0.1:${port[n]}`)!;
  const d: Deps = {
    now: () => now,
    async health(url) {
      if (url === LEAD) return lead;
      const n = byPort(url);
      return up[n] && !o.noHealth?.has(n) ? head[n].slice(0, 7) : undefined;
    },
    git(cwd, args) {
      const n = byApp(cwd);
      calls.push(`${n}: git ${args.filter((a) => !a.startsWith('-') && a !== 'advice.detachedHead=false').join(' ')}`);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, out: head[n] + '\n' };
      if (args[0] === 'rev-parse') return { code: 0, out: (args[3].startsWith('b') ? B : A) + '\n' };
      if (args[0] === 'merge-base') return { code: o.onMain === false ? 1 : 0, out: '' };
      if (args[0] === 'status') return { code: 0, out: '' };
      if (args.includes('checkout')) head[n] = args[args.length - 1];
      return { code: 0, out: '' };
    },
    build(app) {
      const n = byApp(app);
      calls.push(`${n}: build ${head[n].slice(0, 1)}`);
      if (o.failBuild?.(head[n])) throw new Error('npm ci failed: boom');
    },
    async stop(i) {
      calls.push(`${i.name}: stop`);
      assert.equal(fs.readFileSync(path.join(i.dataDir, 'restart.request'), 'utf8'), '', 'stopped only after the plain request');
      up[i.name] = false;
    },
    start(i) {
      calls.push(`${i.name}: start`);
      up[i.name] = true;
    },
    async sleep(ms) {
      now += ms;
      // The portal: a drain request is answered by drain.done.
      for (const i of list.instances) {
        const data = path.join(i.dir, 'data');
        const req = path.join(data, 'restart.request');
        if (fs.existsSync(req) && fs.readFileSync(req, 'utf8').includes('"drain"')) fs.writeFileSync(path.join(data, 'drain.done'), '');
      }
    },
    log: (l) => log.push(l),
  };
  return {
    root, list, d, calls, log, head, port,
    setLead: (s: string | undefined) => (lead = s),
    advance: (min: number) => (now += min * 60_000),
    data: (n: string) => path.join(root, n, 'data'),
  };
}

test('list: names, dirs and tasks are checked', () => {
  const ok: InstanceList = { version: 1, leader: { url: 'https://fff.example' }, instances: [{ name: 'lens', dir: 'F:/x', portalTask: 't' }] };
  assert.equal(listProblem(ok), undefined);
  assert.match(listProblem({ ...ok, leader: { url: 'fff' } })!, /leader\.url/);
  assert.match(listProblem({ ...ok, instances: [...ok.instances, ...ok.instances] })!, /twice/);
  assert.match(listProblem({ ...ok, instances: [{ name: 'Lens Scout', dir: 'x', portalTask: 't' }] })!, /lower case/);
  assert.match(listProblem({ ...ok, instances: [{ name: 'lens', dir: 'x', portalTask: 't', daemonInApp: true }] })!, /daemonTask/);
});

test('settings: dotted paths that differ from the list are named', () => {
  assert.deepEqual(settingsDiff({ deviceApproval: 'members', machines: { keepAgentsOnRestart: true } }, { deviceApproval: 'members', 'machines.keepAgentsOnRestart': true }), []);
  assert.deepEqual(settingsDiff({ trustProxy: false }, { trustProxy: true, 'machines.keepAgentsOnRestart': true }), [
    'trustProxy: false, expected true',
    'machines.keepAgentsOnRestart: unset, expected true',
  ]);
});

test('target: the lead\'s commit only once it has held for stableMinutes', () => {
  const s = readState('/no/such/file');
  const t0 = Date.parse('2026-11-14T20:00:00Z');
  assert.equal(stableTarget('bbbbbbb', s, t0, 5), undefined);
  assert.equal(stableTarget('bbbbbbb', s, t0 + 4 * 60_000, 5), undefined);
  assert.equal(stableTarget('bbbbbbb', s, t0 + 5 * 60_000, 5), 'bbbbbbb');
  // A deploy that rolled back: the old commit again starts the clock again.
  assert.equal(stableTarget('ccccccc', s, t0 + 6 * 60_000, 5), undefined);
  assert.equal(stableTarget(undefined, s, t0 + 20 * 60_000, 5), undefined);
  assert.equal(stableTarget('not-a-sha', s, t0 + 20 * 60_000, 5), undefined);
});

test('roll: each instance in turn is drained, stopped, updated, started, verified, and told to update its daemons', async () => {
  const w = world(['demo', 'lens'], { headOf: { lens: B } });
  const s = readState(path.join(w.root, 'none.json'));
  assert.deepEqual((await tick(w.list, s, w.d)).rolled, [], 'a new lead commit waits for stableMinutes');
  w.advance(6);
  const r = await tick(w.list, s, w.d);
  assert.deepEqual(r.rolled, ['demo'], 'lens is on the target already');
  assert.equal(w.head.demo, B);
  assert.deepEqual(w.calls.filter((c) => c.startsWith('demo') && !c.includes('git rev-parse') && !c.includes('merge-base') && !c.includes('status')), [
    'demo: git fetch origin',
    'demo: stop',
    `demo: git checkout ${B}`,
    'demo: build b',
    'demo: start',
  ]);
  const verified = JSON.parse(fs.readFileSync(path.join(w.data('demo'), 'update.verified.json'), 'utf8'));
  assert.deepEqual([verified.sha, verified.previous], [B, A], 'the portal\'s machine rollout starts from this marker');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.data('demo'), 'update.result.json'), 'utf8')).ok, true);
  assert.equal(fs.existsSync(path.join(w.data('demo'), 'drain.done')), false);
  assert.ok(s.last.demo.ok);
  assert.deepEqual(s.settings.demo, ['trustProxy: false, expected true']);
  // Nothing more to do on the next pass.
  w.calls.length = 0;
  assert.deepEqual((await tick(w.list, s, w.d)).rolled, []);
  assert.deepEqual(w.calls, []);
});

test('roll: a build that fails puts the old commit back, stops the batch, and that commit is not tried again', async () => {
  const w = world(['demo', 'lens'], { failBuild: (sha) => sha === B });
  const s = readState(path.join(w.root, 'none.json'));
  await tick(w.list, s, w.d);
  w.advance(6);
  const r = await tick(w.list, s, w.d);
  assert.equal(r.failed, 'demo');
  assert.deepEqual(r.rolled, []);
  assert.equal(w.head.demo, A, 'back on the previous commit');
  assert.equal(w.head.lens, A, 'the instance after it is untouched');
  assert.ok(!w.calls.some((c) => c.startsWith('lens: stop')));
  const res = JSON.parse(fs.readFileSync(path.join(w.data('demo'), 'update.result.json'), 'utf8'));
  assert.equal(res.ok, false);
  assert.match(res.error, /npm ci failed/);
  assert.equal(fs.existsSync(path.join(w.data('demo'), 'update.verified.json')), false, 'no daemon rollout for a failed commit');
  assert.ok(s.failed[B]);
  w.calls.length = 0;
  await tick(w.list, s, w.d);
  assert.ok(!w.calls.some((c) => c.includes('stop')), 'the failed commit is not retried');
});

test('roll: a portal that does not come up on the new commit is rolled back', async () => {
  const w = world(['demo']);
  const s = readState(path.join(w.root, 'none.json'));
  await tick(w.list, s, w.d);
  w.advance(6);
  // The new commit starts but never answers: only the old one does.
  const health = w.d.health;
  w.d.health = async (url) => {
    const sha = await health(url);
    return url !== LEAD && sha === B.slice(0, 7) ? undefined : sha;
  };
  const r = await tick(w.list, s, w.d);
  assert.equal(r.failed, 'demo');
  assert.equal(w.head.demo, A);
  assert.match(s.last.demo.note, /did not report .* rolled back/);
});

test('roll: no lead, a portal that does not answer, or a commit off main: nothing is touched', async () => {
  for (const [what, o, lead] of [
    ['lead down', {}, undefined],
    ['instance down', { noHealth: new Set(['demo']) }, B.slice(0, 7)],
    ['not on main', { onMain: false }, B.slice(0, 7)],
  ] as const) {
    const w = world(['demo'], o);
    w.setLead(lead);
    const s = readState(path.join(w.root, 'none.json'));
    await tick(w.list, s, w.d);
    w.advance(6);
    await tick(w.list, s, w.d);
    assert.ok(!w.calls.some((c) => c.includes('stop')), what);
    assert.equal(w.head.demo, A, what);
  }
});

test('roll: a dry run says what it would do and does nothing', async () => {
  const w = world(['demo']);
  const s = readState(path.join(w.root, 'none.json'));
  await tick(w.list, s, w.d);
  w.advance(6);
  await tick(w.list, s, w.d, { dryRun: true });
  assert.ok(w.log.some((l) => /would roll/.test(l)));
  assert.ok(!w.calls.some((c) => c.includes('stop')));
});

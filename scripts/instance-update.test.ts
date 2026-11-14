import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Deps, type InstanceList, followSelf, listProblem, readState, settingsDiff, stableTarget, tick } from './instance/update-all.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const LEAD = 'https://lead.test';

/** A computer with instances: each portal answers its commit on its port; git moves HEAD; the portal drains on request. */
function world(names: string[], o: { headOf?: Record<string, string>; failBuild?: (sha: string) => boolean; noHealth?: Set<string>; onMain?: boolean; ahead?: Set<string>; noControl?: Set<string> } = {}) {
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
      // An instance updated ahead of the lead: its HEAD is not an ancestor of the lead's commit.
      if (args[0] === 'merge-base' && o.ahead?.has(n) && args[2] === head[n]) return { code: 1, out: '' };
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
    control(i) {
      calls.push(`${i.name}: control`);
      return o.noControl?.has(i.name) ? `this user cannot disable its task ${i.portalTask} (Access is denied.)` : undefined;
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
    'demo: control',
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

test('w14: an instance updated ahead of the lead by hand is not rolled back, and that is said once', async () => {
  const C = 'c'.repeat(40);
  const w = world(['demo', 'lens'], { headOf: { lens: C }, ahead: new Set(['lens']) });
  const s = readState(path.join(w.root, 'none.json'));
  await tick(w.list, s, w.d);
  w.advance(6);
  const r = await tick(w.list, s, w.d);
  assert.deepEqual(r.rolled, ['demo']);
  assert.equal(w.head.demo, B);
  assert.equal(w.head.lens, C, 'lens keeps its newer commit');
  assert.ok(!w.calls.some((c) => c.startsWith('lens: stop') || c.startsWith('lens: build')));
  w.advance(5);
  await tick(w.list, s, w.d);
  assert.equal(w.log.filter((l) => l.includes('lens: it runs ccccccccc') && l.includes('not rolled back')).length, 1, w.log.join(' | '));
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

test('w14: the updater follows the lead forward only, and only to a commit that carries it', () => {
  // main: OLD (before the updater) <- MINE (the updater's own checkout) <- NEW; BARE is on main but lacks the script.
  const [OLD, MINE, NEW, BARE] = ['1', '2', '3', '4'].map((c) => c.repeat(40));
  const order = [OLD, MINE, NEW, BARE];
  const fresh = () => {
    let head = MINE;
    const d = {
      git(_cwd: string, args: string[]) {
        const [verb, a, b] = args[0] === '-c' ? args.slice(2) : args;
        if (verb === 'rev-parse' && a === 'HEAD') return { code: 0, out: head };
        if (verb === 'fetch') return { code: 0, out: '' };
        if (verb === 'rev-parse') return { code: 0, out: order.find((s) => s.startsWith(args[3].replace('^{commit}', ''))) ?? '' };
        if (verb === 'merge-base') {
          const x = order.indexOf(args[2]);
          const y = args[3] === 'origin/main' ? order.length : order.indexOf(args[3]);
          return { code: x >= 0 && x <= y ? 0 : 1, out: '' };
        }
        if (verb === 'cat-file') return { code: b.startsWith(BARE) ? 1 : 0, out: '' };
        if (verb === 'checkout') {
          head = args[args.length - 1];
          return { code: 0, out: '' };
        }
        return { code: 1, out: '' };
      },
      log() {},
    } as unknown as Deps;
    return { d, head: () => head };
  };
  for (const [lead, moves] of [
    [OLD, false],
    [MINE, false],
    [NEW, true],
    [BARE, false],
  ] as const) {
    const w = fresh();
    assert.equal(followSelf('/updater', lead.slice(0, 7), w.d, 'main'), moves, `lead on ${lead[0]}`);
    assert.equal(w.head(), moves ? lead : MINE);
  }
});

test('roll: an instance whose task this user cannot disable is not drained or stopped, and is rolled once it can be (w4218)', async () => {
  const noControl = new Set(['lens']);
  const w = world(['lens', 'demo'], { noControl });
  const s = readState(path.join(w.root, 'none.json'));
  await tick(w.list, s, w.d);
  w.advance(6);
  let r = await tick(w.list, s, w.d);
  assert.deepEqual(r.skipped, ['lens']);
  assert.deepEqual(r.rolled, ['demo'], 'the instances after it still roll');
  assert.equal(fs.existsSync(path.join(w.data('lens'), 'restart.request')), false, 'no drain asked of it');
  assert.ok(!w.calls.some((c) => c.startsWith('lens: stop') || c.startsWith('lens: git checkout')));
  assert.equal(w.head.lens, A);
  assert.equal(s.failed[B], undefined, 'not recorded as a failed commit');
  assert.equal(w.log.filter((l) => l.includes('lens: not touched: this user cannot disable')).length, 1);
  await tick(w.list, s, w.d);
  assert.equal(w.log.filter((l) => l.includes('lens: not touched: this user cannot disable')).length, 1, 'said once');
  noControl.clear();
  r = await tick(w.list, s, w.d);
  assert.deepEqual(r.rolled, ['lens']);
  assert.equal(w.head.lens, B);
  assert.equal(s.blocked?.lens, undefined);
});

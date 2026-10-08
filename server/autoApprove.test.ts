import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { StandingAgents, type SessionLike, type SessionPort } from './standing.ts';
import { normalizeAutoApprove, DEFAULT_AUTO, personOnlyReason } from './schedule.ts';
import { stallCandidate } from './ledgerRules.ts';
import { Store } from './store.ts';
import type { Config } from './config.ts';
import type { DelegationFiling } from './orchestrators.ts';
import type { DelegationRequest, Machine, Requester, SessionInfo, WorkItem } from '../shared/types.ts';

/**
 * Standing agents' delegations (w527, docs/standing-agents.md "Delegations"): the auto-approve rules and the
 * person-only gate decide whether one needs a click; approved, it is filed in the ledger for the agent's owner and the
 * dispatcher takes it from there. Nothing here picks a sandbox, starts a worker or expires. The ledger is faked: the
 * flow through the real one, the dispatcher and a worker is in orchestrators.test.ts.
 */

const now0 = new Date('2026-09-24T03:00:00');
const BEN: Requester = { userId: 'ben', displayName: 'Ben' };
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };

function setup(t: { after: (fn: () => void) => void }, opts: { ledger?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-auto-'));
  const cfg = {
    dataDir: path.join(tmp, 'data'),
    sandboxRoot: path.join(tmp, 'sb'),
    standingRoot: path.join(tmp, 'sb', '_agents'),
    protectedPaths: [],
    repo: { url: 'x', basePath: path.join(tmp, 'sb', '_base') },
    limits: { maxSessions: 6 },
    models: ['opus', 'sonnet'],
    defaultModel: 'opus',
    worker: { permissionMode: 'bypassPermissions', effort: 'high' },
  } as unknown as Config;
  const store = new Store(cfg.dataDir);
  const events = new EventEmitter();
  const infos = new Map<string, SessionInfo>();
  const port: SessionPort = {
    events,
    create: (o) => {
      const info = { id: `s${infos.size + 1}`, kind: o.kind, title: o.title, status: 'stopped', permissionMode: o.permissionMode, standingId: o.standingId, createdAt: '', lastActivityAt: '', turns: 0, costUsd: 0, pendingPermissions: [] } as SessionInfo;
      infos.set(info.id, info);
      return { info, live: false, stop() {} } as SessionLike;
    },
    get: (id) => ({ info: infos.get(id)!, live: false, stop() {} }),
    send: () => 'u',
    remove: () => undefined,
  };
  // A fake ledger: what was filed, and bumps. A repeat is the same title filed before.
  const filed: DelegationFiling[] = [];
  const items = new Map<string, WorkItem>();
  const bumped: { id: string; by: Requester }[] = [];
  const notes: { text: string; by?: Requester }[] = [];
  const clock = { now: now0 };
  // w510: standing agents run on machines; m1 is an online one whose sessions are the port's.
  const m1 = { id: 'm1', platform: 'linux', appDir: '/home/u/.fff', repoPath: '/home/u/game', maxSessions: 6, status: 'ready', purpose: 'x', sessionIds: [] } as unknown as Machine;
  const machines = { list: () => [m1], get: (id: string) => (id === 'm1' ? m1 : undefined), isOnline: () => true, liveCount: () => 0, createSession: (_m: string, o: Parameters<SessionPort['create']>[0]) => port.create(o) };
  const st = new StandingAgents({
    cfg,
    store,
    sessions: port,
    systemPayer: () => BEN,
    notify: (text, by) => notes.push({ text, by }),
    ledger:
      opts.ledger === false
        ? undefined
        : {
            file: (f) => {
              const same = [...items.values()].find((w) => w.title === f.title);
              if (same) return { item: same, repeat: true };
              filed.push(f);
              const w = { id: `w${filed.length}`, title: f.title, status: 'new', priority: 'normal', requestedBy: f.owner } as WorkItem;
              items.set(w.id, w);
              return { item: w, repeat: false };
            },
            get: (id) => items.get(id),
            bump: (id, by) => {
              bumped.push({ id, by });
              return Object.assign(items.get(id)!, { priority: 'urgent' });
            },
          },
    machines: machines as never, now: () => clock.now,
  });
  const agent = st.create({ name: 'Nightly sentry', charter: 'Triage develop.', trigger: { kind: 'manual' }, tools: ['delegate'], autoApprove: { enabled: true }, owner: BEN, machineId: 'm1' });
  t.after(() => {
    store.flush();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { st, store, filed, items, bumped, notes, agent, clock, events };
}

test('auto-approve: defaults are Sonnet, high effort, 3 per run and per day; the old placement fields are dropped', () => {
  const a = normalizeAutoApprove({ enabled: true }, undefined, ['opus', 'sonnet']);
  assert.deepEqual(a, { ...DEFAULT_AUTO, enabled: true });
  assert.equal(a.model, 'sonnet');
  assert.equal(a.effort, 'high');
  const old = { enabled: true, maxPerRun: 2, maxPerDay: 5, model: 'opus', effort: 'high', targets: 'sandboxes', expiryHours: 8, exclude: ['mp-r2'] } as never;
  assert.deepEqual(Object.keys(normalizeAutoApprove({}, old, ['opus'])).sort(), ['effort', 'enabled', 'maxPerDay', 'maxPerRun', 'model']);
  assert.throws(() => normalizeAutoApprove({ effort: 'extreme' as never }, undefined, ['opus', 'sonnet']), /effort/);
  assert.throws(() => normalizeAutoApprove({ model: 'gpt' }, undefined, ['opus', 'sonnet']), /model/);
  assert.equal(normalizeAutoApprove({ maxPerRun: 9, maxPerDay: 2 }, undefined, ['opus', 'sonnet']).maxPerRun, 2, 'per run never above per day');
});

test('the person-only gate: money, publishing, settings, releases and master; not the words a regression brief uses', () => {
  for (const [text, why] of [
    ['Buy a second Steam key for the test account', 'spends money'],
    ['Raise the budget to $50 a day', 'spends money'],
    ['Post the patch notes to Discord', 'publishes'],
    ['Publish the agent kit', 'publishes'],
    ['Change the portal settings so the intake is on', 'changes a setting'],
    ['Call set_app_config to raise maxSessions', 'changes a setting'],
    ['Move the Steam branch to the new build', 'changes a setting'],
    ['Cut a release once this is fixed', 'releases'],
    ['Bump the version and run ci-release', 'releases'],
    ['Deploy the portal', 'releases'],
    ['Merge the fix into master', 'touches master'],
  ] as const) {
    assert.match(personOnlyReason(text) ?? '(none)', new RegExp(why), text);
  }
  for (const text of [
    'Verify suspected regressions from PRs #1105, #1024, #1065: run MP-belt-items-after-load-join on develop, bisect if it fails, fix with a test, PR into develop.',
    'The scenario failed on the nightly of 2026-10-06 (develop 98995630a, in release 0.50.0.47). No Discord posts. Hand the logs over with publish_attachment.',
    'Add a test guard for the belt deletion regression; master is untouched.',
  ]) {
    assert.equal(personOnlyReason(text), undefined, text);
  }
});

test("auto-approved: filed in the ledger at once for the agent's owner, its task verbatim, and the owner's orchestrator hears it", (t) => {
  const { st, filed, notes, agent } = setup(t);
  const task = 'Check commit 1a2b3c.\n\nRun the fast suite; open a PR into develop with a test.';
  const d = st.requestDelegation(agent.id, 'Verify 1a2b3c', task);
  assert.equal(d.status, 'approved');
  assert.equal(d.autoApproved, true);
  assert.equal(d.workId, 'w1');
  assert.deepEqual(d.requestedBy, BEN);
  assert.equal(d.sandboxId, undefined, 'it picks no sandbox of its own');
  assert.deepEqual({ ...filed[0] }, { delegationId: d.id, agentId: agent.id, agentName: 'Nightly sentry', title: 'Verify 1a2b3c', task, owner: BEN, approvedBy: undefined, model: 'sonnet', effort: 'high' });
  assert.match(d.log!.at(-1)!, /auto-approved: filed as w1 for Ben; the dispatcher queues and places it/);
  assert.deepEqual(notes.at(-1)!.by, BEN);
  assert.match(notes.at(-1)!.text, /^\[auto-delegation\] "Nightly sentry" filed w1 "Verify 1a2b3c" for Ben \(auto-approved under its rules\)/);
});

test('auto-approve rules: the per-run and per-day limits, the person-only gate and auto-approve off each leave it for a click', (t) => {
  const { st, filed, notes, agent, store } = setup(t);
  const ds = ['1', '2', '3', '4'].map((n) => st.requestDelegation(agent.id, `T${n}`, `task ${n}`));
  assert.deepEqual(
    ds.map((d) => d.status),
    ['approved', 'approved', 'approved', 'pending'],
  );
  assert.match(ds[3].log!.at(-1)!, /not auto-approved: already 3 today; waiting for the user/);
  assert.match(notes.at(-1)!.text, /^\[standing agent\] "Nightly sentry" asks for work \(delegation request \w+\): "T4"\. It waits for Ben's approval/);
  assert.equal(filed.length, 3);

  // A new day: the gate still stops a release, whatever the rules say.
  store.delegations.clear();
  const rel = st.requestDelegation(agent.id, 'Ship it', 'Fix the belt and then cut a release.');
  assert.equal(rel.status, 'pending');
  assert.match(rel.log!.at(-1)!, /not auto-approved: it releases or deploys, which only a person approves/);

  // Auto-approve off: every request waits.
  st.update(agent.id, { autoApprove: { enabled: false } });
  assert.equal(st.requestDelegation(agent.id, 'Other', 'task').status, 'pending');
  assert.equal(filed.length, 3);
});

test('approve: the button files it in the queue without any free slot; Start now approves and bumps; a second approve is refused', (t) => {
  const { st, filed, bumped, agent, items } = setup(t);
  st.update(agent.id, { autoApprove: { enabled: false } });
  const d = st.requestDelegation(agent.id, 'Do it', 'task');
  assert.equal(d.status, 'pending');
  st.approveDelegation(d.id, { approvedBy: LOTH, model: 'sonnet', effort: 'max' });
  assert.equal(d.status, 'approved');
  assert.equal(d.workId, 'w1');
  assert.deepEqual([filed[0].owner, filed[0].approvedBy, filed[0].model, filed[0].effort], [BEN, LOTH, 'sonnet', 'max']);
  assert.match(d.log!.at(-1)!, /approved by Lothsahn: filed as w1 for Ben/);
  assert.throws(() => st.approveDelegation(d.id), /already approved \(w1\)/);

  // Start now on an approved one: its request goes urgent.
  st.bumpDelegation(d.id, LOTH);
  assert.deepEqual(bumped, [{ id: 'w1', by: LOTH }]);
  assert.equal(items.get('w1')!.priority, 'urgent');

  // Start now on a pending one: approved by whoever pressed it, then bumped.
  const e = st.requestDelegation(agent.id, 'Another', 'task');
  st.bumpDelegation(e.id, BEN);
  assert.equal(e.status, 'approved');
  assert.deepEqual(e.approvedBy, BEN);
  assert.deepEqual(bumped.at(-1), { id: 'w2', by: BEN });
  const r = st.requestDelegation(agent.id, 'Third', 'task');
  st.rejectDelegation(r.id, 'no');
  assert.throws(() => st.bumpDelegation(r.id, BEN), /is rejected: nothing to start/);
});

test('de-dup: the same work again links to the request already filed instead of a second one', (t) => {
  const { st, filed, notes, agent } = setup(t);
  const a = st.requestDelegation(agent.id, 'Verify 1a2b3c', 'Check it.');
  const b = st.requestDelegation(agent.id, 'Verify 1a2b3c', 'Check it again.');
  assert.equal(filed.length, 1);
  assert.equal(b.workId, a.workId);
  assert.equal(b.repeat, true);
  assert.match(b.log!.at(-1)!, /auto-approved: the same as w1 \(new\), not filed again/);
  assert.match(notes.at(-1)!.text, /asked again for w1 "Verify 1a2b3c" \(new\); not filed twice/);
});

test('no expiry: an auto-approved request stays filed however long it waits, and a queued delegation request never stalls', (t) => {
  const { st, store, agent, clock } = setup(t);
  const d = st.requestDelegation(agent.id, 'Verify', 'task');
  for (const days of [1, 3, 9]) {
    clock.now = new Date(now0.getTime() + days * 86_400_000);
    st.tick();
    assert.equal(store.delegations.get(d.id)!.status, 'approved');
    assert.equal(store.delegations.get(d.id)!.expiresAt, undefined);
  }
  const base = { status: 'queued', delegation: { id: d.id, agentId: agent.id, agentName: 'Nightly sentry', auto: true } } as WorkItem;
  assert.equal(stallCandidate(base), false, 'queued on purpose: it waits for capacity');
  assert.equal(stallCandidate({ ...base, status: 'new' }), true, 'one nobody decided on still stalls');
  assert.equal(stallCandidate({ ...base, delegation: undefined }), true, "a person's queued request: the rule as before");
});

test('without a ledger nothing is filed: it waits for a person', (t) => {
  const { st, agent } = setup(t, { ledger: false });
  const d = st.requestDelegation(agent.id, 'Verify', 'task');
  assert.equal(d.status, 'pending');
  assert.match(d.log!.at(-1)!, /no work ledger here/);
});

test("migration: an old auto-queued request is filed on the first tick, today's four handled by hand link to w524, the sentry gets auto-approve", (t) => {
  const { st, store, filed, agent } = setup(t);
  const old = (id: string, extra: Partial<DelegationRequest>): DelegationRequest => ({ id, agentId: agent.id, agentName: agent.name, title: `old ${id}`, task: 'x', createdAt: now0.toISOString(), status: 'pending', log: [], ...extra });
  store.putDelegation(old('q1', { auto: 'queued', expiresAt: now0.toISOString(), requestedBy: BEN }));
  store.putDelegation(old('2c70e0fa', { status: 'rejected', note: 'started by hand under w524 as worker abc' }));
  // The sentry, with no auto-approve setting of its own; and one a person switched off, which stays off.
  const sentry = st.create({ name: 'nightly-regression-sentry', charter: 'x', trigger: { kind: 'manual' }, tools: ['delegate'], machineId: 'm1' });
  const off = st.create({ name: 'Other sentry', charter: 'x', trigger: { kind: 'manual' }, tools: ['delegate'], autoApprove: { enabled: false }, machineId: 'm1' });
  assert.equal(sentry.autoApprove, undefined);
  st.tick();
  const q = store.delegations.get('q1')!;
  assert.deepEqual([q.status, q.workId, q.auto, q.expiresAt], ['approved', 'w1', undefined, undefined]);
  assert.equal(filed.length, 1);
  const h = store.delegations.get('2c70e0fa')!;
  assert.deepEqual([h.status, h.workId], ['rejected', 'w524']);
  assert.match(h.log!.at(-1)!, /handled under w524/);
  assert.equal(st.require(sentry.id).autoApprove?.enabled, true);
  assert.equal(st.require(off.id).autoApprove?.enabled, false);
  // Once per start: a second tick files nothing more.
  st.tick();
  assert.equal(filed.length, 1);
});

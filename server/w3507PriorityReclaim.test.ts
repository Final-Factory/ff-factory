// w3507 (lothsahn): game sandboxes go out by priority. Queued game work with no room frees a sandbox from strictly lower
// work: an idle holder is released (its work kept on its branch), and urgent work asks a mid-turn low or normal worker to
// yield at a safe point. server/priorityReclaim.ts, server/placeAgain.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaceAgain, type PairWant } from './placeAgain.ts';
import { RECLAIM_PROTECT_MS, pickReclaim, type Pressure, type SandboxHolders } from './priorityReclaim.ts';
import type { Machine, MachineSandbox, SessionInfo, WorkPriority } from '../shared/types.ts';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const worker = (id: string, sandbox: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id,
  kind: 'worker',
  machineId: 'm5',
  machineSandbox: sandbox,
  title: id,
  status: 'stopped',
  permissionMode: 'default',
  createdAt: iso(NOW - 3600_000),
  lastActivityAt: iso(NOW - 5 * MIN),
  turns: 3,
  costUsd: 1,
  pendingPermissions: [],
  ...over,
});

const sandbox = (id: string, git: Partial<NonNullable<MachineSandbox['git']>> = {}, over: Partial<MachineSandbox> = {}): MachineSandbox => ({
  id,
  branch: `sandbox/${id}`,
  base: 'origin/master',
  path: `/sb/${id}`,
  purpose: id,
  status: 'ready',
  createdAt: iso(NOW - 86_400_000),
  unity: { state: 'stopped' },
  sessionIds: [],
  git: { branch: `sandbox/${id}-work`, dirty: 0, untracked: 0, at: iso(NOW - MIN), ...git },
  ...over,
});

const pressure = (work: string, priority: WorkPriority, o: Partial<Pressure> = {}): Pressure => ({ work, title: `${work} title`, priority, room: false, machines: ['m5'], preemptOn: priority === 'urgent' ? ['m5'] : [], ...o });

/** A PlaceAgain over m5 with `sbs`, the workers `sessions` and their priorities, and what it told and recorded. */
function rig(sessions: SessionInfo[], sbs: MachineSandbox[], prio: Record<string, WorkPriority | undefined>, o: { pressure?: () => Pressure[]; pairWants?: () => PairWant[]; live?: string[]; hold?: (s: SessionInfo) => string | undefined; pairHold?: (s: SessionInfo) => string | undefined; unityHolders?: string[]; saveWork?: boolean } = {}) {
  const told: { id: string; text: string }[] = [];
  const events: { work: string; sandbox: string; preempt: boolean; released: boolean; sessions: string[] }[] = [];
  const none: Record<string, string | undefined> = {};
  const switched: string[] = [];
  const saves: string[] = [];
  let pr = o.pressure ?? (() => [] as Pressure[]);
  const live = new Set(o.live ?? []);
  const machine = { id: 'm5', sandboxes: sbs } as unknown as Machine;
  const p = new PlaceAgain({
    sessions: () => sessions,
    machine: () => machine,
    machines: () => [machine],
    isLive: (id) => live.has(id),
    online: () => true,
    unityHolders: () => o.unityHolders ?? [],
    workOver: () => undefined,
    keepLive: () => undefined,
    queued: (id) => !!sessions.find((s) => s.id === id)?.queuedSend,
    stopLive: (id) => live.delete(id),
    stopEditor: async () => undefined,
    switchBranch: async (_m, branch, sb) => (switched.push(`${sb}:${branch}`), { notes: [`switched to ${branch}`] }),
    save: () => undefined,
    saveMachine: () => undefined,
    note: () => undefined,
    drain: () => undefined,
    now: () => NOW,
    ...(o.pairHold ? { pairHold: o.pairHold } : {}),
    ...(o.saveWork ? { canSave: () => true, saveWork: async (_m: string, sb: string, branch: string) => (saves.push(`${sb}:${branch}`), { sha: 'abc1234', files: 2, pushed: true, notes: ['committed abc1234 and pushed'] }) } : {}),
    pressure: () => pr(),
    ...(o.pairWants ? { pairWants: o.pairWants } : {}),
    priorityOf: (s) => prio[s.id],
    reclaimHold: (s) => o.hold?.(s),
    requestsOf: (s) => [`req-${s.id}`],
    reclaimed: (e) => events.push({ work: e.work, sandbox: e.sandbox, preempt: e.preempt, released: e.released, sessions: e.sessions.map((s) => s.id) }),
    reclaimNone: (work, why) => void (none[work] = why),
    tell: (id, text) => void told.push({ id, text }),
  });
  return { p, told, events, none, switched, saves, live, setPressure: (f: () => Pressure[]) => void (pr = f) };
}

const holders = (o: Partial<SandboxHolders> & { machine?: string; sandbox: string }): SandboxHolders => ({ machine: 'm5', sessions: [], priority: 'normal', midTurn: false, activeAt: NOW - 10 * MIN, editorStopped: true, ...o });

test('w3507: pickReclaim takes the lowest, longest-idle strictly lower holder; equal never; only urgent pre-empts, and only low or normal', () => {
  const lowIdle = holders({ sandbox: 'slot1', priority: 'low', activeAt: NOW - 2 * MIN });
  const normalIdle = holders({ sandbox: 'slot2', priority: 'normal', activeAt: NOW - 50 * MIN });
  assert.deepEqual(pickReclaim(pressure('wH', 'high'), [normalIdle, lowIdle]), { reclaim: lowIdle }, 'the lowest priority goes first');
  // Equal priority never takes.
  const high = holders({ sandbox: 'slot3', priority: 'high' });
  const eq = pickReclaim(pressure('wH', 'high'), [high]);
  assert.ok('none' in eq && /its work is high, not lower than high/.test(eq.none), JSON.stringify(eq));
  // Mid-turn: urgent pre-empts normal, not high; high pre-empts nobody.
  const midNormal = holders({ sandbox: 'slot1', priority: 'normal', midTurn: true });
  const midHigh = holders({ sandbox: 'slot2', priority: 'high', midTurn: true });
  assert.deepEqual(pickReclaim(pressure('wU', 'urgent'), [midHigh, midNormal]), { preempt: midNormal });
  const onlyHigh = pickReclaim(pressure('wU', 'urgent'), [midHigh]);
  assert.ok('none' in onlyHigh && /only low or normal/.test(onlyHigh.none), JSON.stringify(onlyHigh));
  const highOnNormal = pickReclaim(pressure('wH', 'high'), [midNormal]);
  assert.ok('none' in highOnNormal && /only urgent work pre-empts/.test(highOnNormal.none), JSON.stringify(highOnNormal));
  // An idle one is always taken before a turn is pre-empted.
  assert.deepEqual(pickReclaim(pressure('wU', 'urgent'), [midNormal, normalIdle]), { reclaim: normalIdle });
  // Blocked holders and computers the work may not use are never taken.
  const blocked = pickReclaim(pressure('wU', 'urgent'), [holders({ sandbox: 'slot1', priority: 'low', blocked: 'w9 is a pair run' })]);
  assert.ok('none' in blocked && /w9 is a pair run/.test(blocked.none));
  assert.ok('none' in pickReclaim(pressure('wU', 'urgent', { machines: [], preemptOn: [] }), [lowIdle]), 'held, paused or offline computers are not in machines');
});

test('w3507: an idle lower-priority holder is reclaimed: stopped, then released on its own branch, with both sides told', () => {
  const a = worker('a', 'slot1', { status: 'idle' });
  const sbs = [sandbox('slot1', {}, { sessionIds: ['a'] })];
  const r = rig([a], sbs, { a: 'normal' }, { pressure: () => [pressure('wH', 'high')], live: ['a'] });
  // Idle 5 min, no check-in: today's rule (RELEASE_AFTER_MS) keeps it; high queued work stops it now.
  const first = r.p.tick();
  assert.ok(first.some((l) => /taking m5\/slot1 of a \(normal\) for high wH/.test(l)), first.join('\n'));
  assert.ok(first.some((l) => /^stopped a \(taken for high queued work wH/.test(l)), first.join('\n'));
  assert.equal(r.live.has('a'), false);
  assert.ok(a.releaseDue);
  assert.deepEqual(r.events, [{ work: 'wH', sandbox: 'slot1', preempt: false, released: false, sessions: ['a'] }]);
  a.status = 'stopped';
  const second = r.p.tick();
  assert.ok(second.some((l) => /^released m5\/slot1 of a/.test(l)), second.join('\n'));
  assert.equal(a.placeReleased?.branch, 'sandbox/slot1-work', 'its own branch is kept');
  assert.equal(a.reclaimed?.for, 'wH');
  assert.equal(a.reclaimed?.count, 1, 'the bounce count');
  assert.equal(r.events.at(-1)?.released, true);
  assert.equal(r.none.wH, undefined);
});

test('w3507: an equal-priority holder is not reclaimed, and the Queued line says why', () => {
  const a = worker('a', 'slot1', { status: 'idle' });
  const r = rig([a], [sandbox('slot1', {}, { sessionIds: ['a'] })], { a: 'high' }, { pressure: () => [pressure('wH', 'high')], live: ['a'] });
  assert.deepEqual(r.p.tick(), []);
  assert.equal(r.live.has('a'), true);
  assert.equal(a.releaseDue, undefined);
  assert.match(r.none.wH ?? '', /m5\/slot1: its work is high, not lower than high/);
});

test('w3507: urgent pre-empts a mid-turn normal worker at a safe point (told, never stopped), not a high one; it resumes on its branch', () => {
  const n = worker('n', 'slot1', { status: 'running' });
  const h = worker('h', 'slot2', { status: 'running' });
  const sbs = [sandbox('slot1', {}, { sessionIds: ['n'] }), sandbox('slot2', {}, { sessionIds: ['h'] })];
  const r = rig([n, h], sbs, { n: 'normal', h: 'high' }, { pressure: () => [pressure('wU', 'urgent')], live: ['n', 'h'] });
  r.p.tick();
  assert.equal(r.told.length, 1, 'once, and only the normal worker');
  assert.equal(r.told[0].id, 'n');
  assert.match(r.told[0].text, /PRE-EMPTED \(w3507\): urgent work wU/);
  assert.match(r.told[0].text, /never stop in the middle of a git command, a merge, a push or a release step/);
  assert.match(r.told[0].text, /req-n: paused for urgent wU/);
  assert.equal(n.preempted?.for, 'wU');
  assert.equal(r.live.has('n'), true, 'never interrupted');
  assert.equal(h.preempted, undefined);
  r.p.tick();
  assert.equal(r.told.length, 1, 'not told again');
  // It reaches its safe point and ends its turn: stopped, then released, and a message waits to resume it.
  n.status = 'idle';
  r.p.tick();
  assert.equal(r.live.has('n'), false);
  n.status = 'stopped';
  r.p.tick();
  assert.equal(n.placeReleased?.branch, 'sandbox/slot1-work');
  assert.equal(n.preempted, undefined);
  assert.equal(n.reclaimed?.preempted, true);
  assert.match(r.told.at(-1)?.text ?? '', /Carry on \(w3507\): you were paused for urgent wU/);
  assert.equal(r.live.has('h'), true, 'the high worker is untouched');
});

test('w3507: the reclaimed worker loses nothing (uncommitted work saved on its branch) and resumes on its own branch once higher work no longer waits', async () => {
  // Stopped with a check-in 10 min ahead: it holds its sandbox today (near check-in), higher queued work takes it now.
  const a = worker('a', 'slot1', { lastActivityAt: iso(NOW - 5 * MIN), wakeAt: iso(NOW + 10 * MIN) });
  const own = sandbox('slot1', { dirty: 3 }, { sessionIds: ['a'] });
  const r = rig([a], [own], { a: 'low' }, { pressure: () => [pressure('wH', 'high')], saveWork: true });
  const did = r.p.tick();
  assert.ok(did.some((l) => /saving the uncommitted work in m5\/slot1 of a/.test(l)), did.join('\n'));
  await Promise.all([...r.p.pending]);
  assert.deepEqual(r.saves, ['slot1:sandbox/slot1-work'], 'committed and pushed on its own branch');
  assert.equal(a.savedWork?.sha, 'abc1234');
  assert.equal(a.placeReleased?.branch, 'sandbox/slot1-work');
  assert.equal(a.reclaimed?.count, 1);
  // The higher work took the sandbox onto its own branch.
  own.git = { branch: 'sandbox/slot1-wH', dirty: 0, untracked: 0, at: iso(NOW) };
  own.sessionIds = [];
  // While the higher work still waits for this computer, the released worker does not take a sandbox back.
  assert.match(r.p.answer(a) ?? '', /higher-priority queued work wH \(high\) takes the next free sandbox on m5 first/);
  // It has started (no longer queued): the worker goes back to its own branch.
  r.setPressure(() => []);
  r.p.tick();
  assert.match(r.p.answer(a) ?? '', /being placed again in m5\/slot1 \(switching it to its branch sandbox\/slot1-work\)/);
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(r.switched, ['slot1:sandbox/slot1-work']);
  assert.equal(a.placeReleased, undefined);
  assert.ok(a.reclaimed?.backAt, 'its protection counts from its return');
});

test('w3507: no reclaim while a pair run, a bench lock or a Unity batch run holds the sandbox, or while its worker is mid-turn (a merge or release happens in a turn)', () => {
  const cases: { name: string; o: Parameters<typeof rig>[3]; status?: SessionInfo['status']; prio?: WorkPriority; want: RegExp }[] = [
    { name: 'pair', o: { pairHold: () => 'a leg of pair w9' }, want: /a runs a pair leg/ },
    { name: 'bench', o: { hold: () => 'a timed run from it holds the bench lock' }, want: /bench lock/ },
    { name: 'release lane', o: { hold: () => 'a is the urgent release lane or the nightly' }, want: /release lane/ },
    { name: 'batch', o: { unityHolders: ['sandbox:slot1'] }, want: /Unity batch run/ },
    { name: 'merge mid-turn, high work', o: {}, status: 'running', want: /only urgent work pre-empts a turn/ },
  ];
  for (const c of cases) {
    const a = worker('a', 'slot1', { status: c.status ?? 'idle' });
    const r = rig([a], [sandbox('slot1', {}, { sessionIds: ['a'] })], { a: 'low' }, { ...c.o, pressure: () => [pressure('wH', c.prio ?? 'high')], live: ['a'] });
    r.p.tick();
    assert.equal(r.live.has('a'), true, c.name);
    assert.equal(a.releaseDue, undefined, c.name);
    assert.equal(r.told.length, 0, c.name);
    assert.match(r.none.wH ?? '', c.want, c.name);
  }
});

test('w3507: no thrash: a worker moved for higher work is protected after it is back, and a standing reclaim is not repeated', () => {
  const a = worker('a', 'slot1', { status: 'idle', reclaimed: { at: iso(NOW - 40 * MIN), for: 'w1', count: 2, backAt: iso(NOW - 10 * MIN) } });
  const r = rig([a], [sandbox('slot1', {}, { sessionIds: ['a'] })], { a: 'low' }, { pressure: () => [pressure('wH', 'high')], live: ['a'] });
  r.p.tick();
  assert.equal(r.live.has('a'), true);
  assert.match(r.none.wH ?? '', /protected until 12:20Z/);
  assert.equal(RECLAIM_PROTECT_MS, 30 * MIN);
  // Two requests, one sandbox: one reclaim, the other says none qualifies.
  const b = worker('b', 'slot1', { status: 'idle' });
  const r2 = rig([b], [sandbox('slot1', {}, { sessionIds: ['b'] })], { b: 'low' }, { pressure: () => [pressure('wH', 'high'), pressure('wU', 'urgent')], live: ['b'] });
  r2.p.tick();
  r2.p.tick();
  assert.deepEqual(r2.events.map((e) => e.work), ['wU'], 'urgent first, once');
  assert.match(r2.none.wH ?? '', /no occupied sandbox|no sandbox it may take/);
});

test('w3507: queued work with room frees nothing, but holds lower released workers back from the sandbox it would take', () => {
  const a = worker('a', 'slot1', { status: 'idle' });
  const r = rig([a], [sandbox('slot1', {}, { sessionIds: ['a'] })], { a: 'low' }, { pressure: () => [pressure('wH', 'high', { room: true })], live: ['a'] });
  r.p.tick();
  assert.equal(r.live.has('a'), true);
  assert.deepEqual(r.events, []);
});

test('w3588: a released worker whose check-in is near yields a sandbox that starts a Queued pair run of at least its priority, and holds it again once the pair has gone', () => {
  // Live, 2026-11-08: beast/slot1 released at 05:34:53Z, w3562 (high) holding biscuit for one leg and fitting beast for the
  // other; at 05:35:15Z d3f81fb1 held beast/slot1 again for its check-in, and the pair waited 32 more minutes.
  const released = () => worker('d3', 'slot1', { wakeAt: iso(NOW + 10 * MIN), placeReleased: { at: iso(NOW - 30 * MIN), sandbox: 'slot1', branch: 'sandbox/slot1-work', why: 'its check-in is 40 min away' } });
  const sbs = [sandbox('slot1')];
  let wants: PairWant[] = [{ work: 'w3562', priority: 'high', machines: ['m5'] }];
  for (const mine of ['normal', 'high'] as const) {
    const a = released();
    const r = rig([a], sbs, { d3: mine }, { pairWants: () => wants });
    assert.deepEqual(r.p.tick().filter((l) => /again/.test(l)), [], `a ${mine} worker yields to the high pair`);
    assert.ok(a.placeReleased, 'it stays released: the sandbox is the pair\'s');
    assert.match(r.p.answer(a) ?? '', /^Queued pair run w3562 \(high\) starts with the next free sandbox on m5, so it takes it first \(w3588\)/);
    // A worker whose message waits claims nothing there meanwhile.
    a.queuedSend = 'resume';
    assert.equal(r.p.claims('m5').size, 0);
  }
  // Urgent work does not yield to a high pair; a pair that one more sandbox here would not start holds nothing back.
  const u = released();
  assert.deepEqual(rig([u], sbs, { d3: 'urgent' }, { pairWants: () => wants }).p.tick(), ['d3 holds m5/slot1 again: its check-in is near']);
  const elsewhere = released();
  assert.deepEqual(rig([elsewhere], sbs, { d3: 'normal' }, { pairWants: () => [{ work: 'w3562', priority: 'high', machines: ['beast'] }] }).p.tick(), ['d3 holds m5/slot1 again: its check-in is near']);
  // The pair started (or left the queue): the next pass holds it again.
  const b = released();
  const r = rig([b], sbs, { d3: 'normal' }, { pairWants: () => wants });
  assert.deepEqual(r.p.tick().filter((l) => /again/.test(l)), []);
  wants = [];
  assert.deepEqual(r.p.tick(), ['d3 holds m5/slot1 again: its check-in is near']);
});

// w6754, stage 2 of w6687 (lothsahn: "Yes, file it: machine exclusions must cite a live hold and expire with it"): the
// false positives the warn lines showed (portal journal 2026-11-28 05:44Z to 08:45Z, 75 lines, none a pair avoid or a crash
// hold), the w6697 review's findings, and enforce behind config placement.exclusions (warn by default).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditExclusions, exclusionReason, liveCrashHoldList, needsUnreasoned, type ExclusionFacts } from './exclusionAudit.ts';
import type { Computer, PlacementPrefs } from './placement.ts';
import type { Requester, WorkItem } from '../shared/types.ts';
import { unfitWhy } from '../shared/capacity.ts';
import { normalizeSetting } from './appConfig.ts';
import { setup } from './orchestratorsTestKit.ts';

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const T = '2026-11-26T18:39:00.000Z';

const pc = (id: string, extra: Partial<Computer> = {}): Computer =>
  ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 4, maxSandboxes: 5, freeSandboxes: 2, platform: 'win32', ...extra }) as Computer;
const COMPUTERS = [pc('beast'), pc('lothdesktop'), pc('lothlaptop')];

const work = (id: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  title: `Pair run for w6673: ${id}`,
  brief: 'Run MP-W6673-guardian-midfight-join. No game player on BEAST (crash hold).',
  priority: 'normal',
  keys: [],
  requestedBy: LOTH,
  requesters: [LOTH],
  humanAsked: false,
  status: 'queued',
  queuedFor: { at: T },
  createdAt: T,
  updatedAt: T,
  sessionIds: [],
  needs: 'game',
  overlaps: [],
  asks: 0,
  log: [],
  ...extra,
});

/** The request the pair runs are for, with its crash hold on BEAST (cleared, or live). */
const parent = (cleared?: string): WorkItem =>
  work('w6673', { title: 'Guardian mount save fix', status: 'active', queuedFor: undefined, crashHolds: [{ machine: 'beast', at: T, worker: 'c7bb04a5', why: 'running player pid 400216', ...(cleared ? { cleared, clearedBy: 'the worker ran on' } : {}) }] });

const facts = (open: WorkItem[], prefs: PlacementPrefs = {}, computers = COMPUTERS, config: PlacementPrefs = prefs): ExclusionFacts => ({ crashHolds: liveCrashHoldList(open), prefs, config, computers });

/** An Orchestrators whose audit reads `f()` (the kit's own deps have no machines). */
function kit(t: Parameters<typeof setup>[0], f: () => ExclusionFacts) {
  const s = setup(t);
  (s.o as unknown as { d: { exclusionFacts: () => ExclusionFacts } }).d.exclusionFacts = f;
  return s;
}

const ENFORCE: PlacementPrefs = { exclusions: 'enforce' };

test('w6754 enforce: a request excluding BEAST for a crash hold is placed on BEAST again when the hold clears', (t) => {
  let hold = parent();
  const pair = work('w6678', { pair: { legs: 2, for: 'w6673', avoid: ['beast'] } });
  const { o, store } = kit(t, () => facts([...store.work.values()], ENFORCE));
  store.putWork(hold);
  store.putWork(pair);
  assert.deepEqual(o.auditExclusions(), [], 'kept while the hold is live');
  assert.match(unfitWhy(store.work.get('w6678')!, 'beast', undefined) ?? '', /beast is where an earlier leg/, 'BEAST is off its computers');
  hold = parent('2026-11-26T18:55:00.000Z');
  store.putWork(hold);
  assert.deepEqual(o.auditExclusions(), ['w6678']);
  const w = store.work.get('w6678')!;
  assert.deepEqual(w.pair!.avoid, []);
  assert.equal(w.status, 'queued', 'it stays Queued: the room flag in the same tick starts it');
  assert.equal(unfitWhy(w, 'beast', undefined), undefined, 'BEAST fits it again');
  assert.match(JSON.stringify(w.log.at(-1)), /w6754 enforced: dropped beast from its pair avoid: w6673's crash hold on beast \(18:39Z\) has cleared, so it is re-queued for beast/);
});

test('w6754 enforce: a free-text "not on beast" with no live hold is not applied, by the audit or by request_pair', (t) => {
  const pair = work('w6700', { pair: { legs: 2, for: 'w6673', avoid: ['beast'], avoidWhy: { beast: 'No game player on BEAST (crash hold)' } } });
  const { o, store } = kit(t, () => facts([...store.work.values()], ENFORCE));
  store.putWork(work('w6673', { status: 'active', queuedFor: undefined }));
  store.putWork(pair);
  assert.deepEqual(o.auditExclusions(), ['w6700']);
  assert.deepEqual(store.work.get('w6700')!.pair!.avoid, []);
  assert.match(JSON.stringify(store.work.get('w6700')!.log.at(-1)), /dropped beast from its pair avoid: nothing live names it .*it cited: \\"No game player on BEAST/);
  // request_pair's own check (filePair): the avoid is not applied, and its answer says why.
  const not = (o as unknown as { avoidNotApplied: (w: WorkItem, asked: string[], failed: string[], pair: object) => { machine: string; reason: string }[] }).avoidNotApplied;
  assert.deepEqual(not.call(o, store.work.get('w6673')!, ['BEAST'], [], { legs: 1 }).map((x) => x.machine), ['beast']);
  // A leg of the run it retries failed on BEAST: that is a reason (the w6697 review, 1).
  assert.deepEqual(not.call(o, store.work.get('w6673')!, ['beast'], ['beast'], { legs: 1 }), []);
});

test('w6754 warn (the default): nothing is dropped, and request_pair applies the avoid as asked', (t) => {
  const pair = work('w6700', { pair: { legs: 2, for: 'w6673', avoid: ['beast'] } });
  const { o, store } = kit(t, () => facts([...store.work.values()]));
  store.putWork(pair);
  assert.deepEqual(o.auditExclusions(), ['w6700']);
  assert.deepEqual(store.work.get('w6700')!.pair!.avoid, ['beast']);
  assert.match(JSON.stringify(store.work.get('w6700')!.log.at(-1)), /w6687 warn-only, nothing dropped: enforcing would drop beast/);
  const not = (o as unknown as { avoidNotApplied: (w: WorkItem, asked: string[], failed: string[], pair: object) => unknown[] }).avoidNotApplied;
  assert.deepEqual(not.call(o, work('w6673'), ['beast'], [], { legs: 1 }), []);
  // off: the audit does nothing at all.
  const off = kit(t, () => facts([...off.store.work.values()], { exclusions: 'off' }));
  off.store.putWork(work('w6701', { pair: { legs: 2, for: 'w6673', avoid: ['beast'] } }));
  assert.deepEqual(off.o.auditExclusions(), []);
});

test('w6754 enforce: an exclusion from a config rule stays, and a build or play hold is a machine hold, not config (review 4)', (t) => {
  const prefs: PlacementPrefs = { ...ENFORCE, avoid: { lothdesktop: 'lothsahn plays there evenings' }, hold: { lothlaptop: 'a build is coming (w1606)' } };
  const config: PlacementPrefs = { ...ENFORCE, avoid: { lothdesktop: 'lothsahn plays there evenings' } };
  const pair = work('w6701', { pair: { legs: 2, for: 'w6673', avoid: ['lothdesktop', 'lothlaptop'] } });
  const { o, store } = kit(t, () => facts([...store.work.values()], prefs, COMPUTERS, config));
  store.putWork(pair);
  assert.deepEqual(o.auditExclusions(), []);
  assert.deepEqual(store.work.get('w6701')!.pair!.avoid, ['lothdesktop', 'lothlaptop']);
  const v = auditExclusions(pair, facts([], prefs, COMPUTERS, config));
  assert.deepEqual(v.map((x) => [x.machine, x.kind]), [['lothdesktop', 'config'], ['lothlaptop', 'machine-hold']]);
});

test('w6754 (review 5): a crash hold keeps work off only for its own request or its pair runs, not for every request', () => {
  const other = work('w6168', { status: 'active', crashHolds: parent().crashHolds });
  const pair = work('w6678', { pair: { legs: 2, for: 'w6673', avoid: ['beast'] } });
  assert.equal(exclusionReason('beast', pair, facts([other])), undefined, "w6168's hold is not w6678's");
  assert.equal(exclusionReason('beast', pair, facts([parent()]))?.kind, 'crash-hold', "w6673's hold is its pair run's");
  assert.equal(exclusionReason('beast', work('w6673'), facts([parent()]))?.kind, 'crash-hold', 'and its own');
});

test('w6754 (review 1): a retry keeps off where the server saw a leg fail; an avoid_why that says so does not count', () => {
  const failed = work('w6702', { pair: { legs: 2, for: 'w6673', avoid: ['lothlaptop'], retryOf: 'w6690', failedOn: ['lothlaptop'] } });
  assert.deepEqual(auditExclusions(failed, facts([])).map((v) => [v.keep, v.kind]), [[true, 'failed-leg']]);
  const said = work('w6703', { pair: { legs: 2, for: 'w6673', avoid: ['lothlaptop'], avoidWhy: { lothlaptop: 'an earlier leg of w6690 failed there (w2041)' } } });
  assert.equal(auditExclusions(said, facts([]))[0].keep, false);
});

test('w6754 (a, b): a pin is kept when the work is about that machine or its worker set it with timed_place; others are only logged', (t) => {
  const f = facts([]);
  const firewall = work('w5581', { title: "Narrow BEAST's agent-node firewall rule to the tailnet", status: 'blocked', machinePin: { ids: ['beast'], why: "the dispatcher: w5581 has to run on BEAST: the rule is BEAST's" } });
  assert.deepEqual(auditExclusions(firewall, f).map((v) => [v.keep, v.kind]), [[true, 'subject']]);
  const screen = work('w4851', { title: 'Adaptive vSync player A/B', brief: "Measure on LothLaptop's own 240 Hz screen.", status: 'blocked', machinePin: { ids: ['lothlaptop'], why: 'the dispatcher: only its screen runs at 240 Hz' } });
  assert.equal(auditExclusions(screen, f)[0].kind, 'subject');
  const timed = work('w6739', { title: 'Bench the tick', status: 'blocked', machinePin: { ids: ['lothdesktop'], why: 'its worker named lothdesktop (timed_place machine)' } });
  assert.equal(auditExclusions(timed, f)[0].kind, 'subject');
  // The copied crash hold: a pin to LothDesktop because "BEAST has a crash hold". Its words name BEAST only as one to avoid.
  const copied = work('w6684', { title: 'Station-follow clip', brief: 'Record the clip. Not on BEAST (crash hold).', status: 'blocked', machinePin: { ids: ['lothdesktop'], why: 'the dispatcher: BEAST has a crash hold' } });
  assert.equal(auditExclusions(copied, f)[0].keep, false);
  // Even under enforce a pin is only logged, never dropped.
  const { o, store } = kit(t, () => facts([...store.work.values()], ENFORCE));
  store.putWork(copied);
  assert.deepEqual(o.auditExclusions(), ['w6684']);
  assert.deepEqual(store.work.get('w6684')!.machinePin?.ids, ['lothdesktop']);
  assert.match(JSON.stringify(store.work.get('w6684')!.log.at(-1)), /w6754 enforce, pins are only logged, nothing dropped: lothdesktop from its pin: /);
});

test('w6754 (c): needs that only repeat the pin are not judged once per computer they leave out', () => {
  const w = work('w6665', { title: 'Install the Windows worker helpers on LothLaptop', machinePin: { ids: ['lothlaptop'], why: 'the dispatcher: it can only run on LothLaptop' }, queuedFor: { at: T, needs: ['lothlaptop'] } });
  assert.deepEqual(auditExclusions(w, facts([])).map((v) => [v.source, v.machine, v.keep]), [['machinePin', 'lothlaptop', true]]);
});

test('w6754 (d, e): a restart or a computer that drops off and comes back logs nothing new', (t) => {
  let computers = COMPUTERS;
  const { o, store } = kit(t, () => facts([...store.work.values()], {}, computers));
  store.putWork(work('w6690', { title: 'Bench', queuedFor: { at: T, needs: ['lothlaptop'] } }));
  assert.deepEqual(o.auditExclusions(), ['w6690']);
  assert.equal(store.work.get('w6690')!.log.length, 2, 'beast and lothdesktop, once each');
  // (e) LothDesktop drops off (a machine hold keeps it out meanwhile) and comes back: no new line.
  computers = [pc('beast'), pc('lothdesktop', { online: false }), pc('lothlaptop')];
  assert.deepEqual(o.auditExclusions(), []);
  computers = COMPUTERS;
  assert.deepEqual(o.auditExclusions(), []);
  // (d) A restart forgets the in-memory verdicts; the request's own log already says it.
  const mem = o as unknown as { exclusionSeen: Map<string, unknown>; exclusionWarned: Set<string> };
  mem.exclusionSeen.clear();
  mem.exclusionWarned.clear();
  assert.deepEqual(o.auditExclusions(), []);
  assert.equal(store.work.get('w6690')!.log.length, 2);
});

test('w6754 enforce: needs with no reason are widened by the audit, and decide_work queue refuses them with the reason', (t) => {
  const rule = { avoid: { lothlaptop: 'lothsahn plays there evenings' } };
  let prefs: PlacementPrefs = { ...ENFORCE, ...rule };
  const { o, store } = kit(t, () => facts([...store.work.values()], prefs, COMPUTERS, rule));
  store.putWork(work('w6684', { title: 'Station-follow clip', queuedFor: { at: T, needs: ['lothdesktop'] } }));
  assert.deepEqual(o.auditExclusions(), ['w6684']);
  assert.deepEqual(store.work.get('w6684')!.queuedFor?.needs, ['lothdesktop', 'beast'], 'BEAST added; LothLaptop stays out by its config rule');
  assert.match(JSON.stringify(store.work.get('w6684')!.log.at(-1)), /w6754 enforced: added beast to its queue needs: left out of its needs/, 'w6758: added, not dropped');
  store.putWork(work('w6685', { title: 'Another clip', status: 'new', queuedFor: undefined }));
  assert.throws(() => o.decide({ id: 'w6685', action: 'queue', note: 'wait for room', needs: ['lothdesktop'] }), /needs lothdesktop leave out beast, and nothing live keeps w6685 off it \(w6754, config placement\.exclusions is enforce\)/);
  assert.equal(needsUnreasoned(work('w6685'), ['lothdesktop', 'beast'], facts([], prefs, COMPUTERS, rule)).length, 0);
  // Under warn the queue is not refused for it.
  prefs = rule;
  assert.doesNotThrow(() => o.decide({ id: 'w6685', action: 'queue', note: 'wait for room', needs: ['lothdesktop'] }));
});

test('w6754: config placement.exclusions takes warn, enforce or off, and nothing else', () => {
  assert.equal(normalizeSetting('placement.exclusions', 'enforce'), 'enforce');
  assert.equal(normalizeSetting('placement.exclusions', ' OFF '), 'off');
  assert.equal(normalizeSetting('placement.exclusions', 'warn'), undefined, 'warn is the default, so it is not stored');
  assert.throws(() => normalizeSetting('placement.exclusions', 'strict'), /placement\.exclusions is one of warn, enforce, off/);
});

test('w6758 (review 1): decide_work queue does not refuse a pair run\'s needs under enforce (its Steam and cross-OS needs are facts the audit cannot see)', (t) => {
  const { o, store } = kit(t, () => facts([...store.work.values()], ENFORCE));
  store.putWork(work('w6710', { title: 'Pair run for w6673: Steam lobby join', status: 'new', queuedFor: undefined, pair: { legs: 2, for: 'w6673', steam: 'a Steam lobby join' } }));
  assert.doesNotThrow(() => o.decide({ id: 'w6710', action: 'queue', note: 'two Steam accounts', needs: ['lothdesktop', 'lothlaptop'] }));
  assert.equal(store.work.get('w6710')!.queuedFor?.needs, undefined, 'an unstarted pair run takes no needs (its legs are placed by pairRoom)');
  assert.deepEqual(o.auditExclusions(), [], 'and the audit judges its avoid only, never its needs');
});

test('w6758 (review 3): a retry filed before w6754 keeps off where the server cited a failed leg; one filed since goes by failedOn alone', () => {
  const cite = 'an earlier leg of w6690 failed there (w2041)';
  const legacy = work('w6704', { pair: { legs: 2, for: 'w6673', retryOf: 'w6690', avoid: ['lothlaptop'], avoidWhy: { lothlaptop: cite } } });
  assert.deepEqual(auditExclusions(legacy, facts([])).map((v) => [v.keep, v.kind]), [[true, 'failed-leg']]);
  const since = work('w6705', { pair: { legs: 2, for: 'w6673', retryOf: 'w6690', failedOn: [], avoid: ['lothlaptop'], avoidWhy: { lothlaptop: cite } } });
  assert.equal(auditExclusions(since, facts([]))[0].keep, false, 'failedOn says no leg failed there: the asker copied the cite');
  const otherRun = work('w6706', { pair: { legs: 2, for: 'w6673', retryOf: 'w6691', avoid: ['lothlaptop'], avoidWhy: { lothlaptop: cite } } });
  assert.equal(auditExclusions(otherRun, facts([]))[0].keep, false, 'a cite naming another run than the one it retries is not the server\'s');
});

test('w6758 (review 5): a restart logs nothing again however long the log has grown, and a mark no longer carried is pruned', (t) => {
  const { o, store } = kit(t, () => facts([...store.work.values()]));
  store.putWork(work('w6690', { title: 'Bench', queuedFor: { at: T, needs: ['lothlaptop'] } }));
  assert.deepEqual(o.auditExclusions(), ['w6690']);
  const w = store.work.get('w6690')!;
  assert.deepEqual(w.exclusionsLogged, ['queuedFor.needs|beast', 'queuedFor.needs|lothdesktop']);
  // 40 later lines push the warnings out of the log; then a restart.
  w.log = Array.from({ length: 40 }, (_, i) => `2026-11-28T10:${String(i).padStart(2, '0')}:00Z: something else`);
  store.putWork(w);
  const mem = o as unknown as { exclusionSeen: Map<string, unknown>; exclusionWarned: Set<string> };
  mem.exclusionSeen.clear();
  mem.exclusionWarned.clear();
  assert.deepEqual(o.auditExclusions(), []);
  // Queued with no needs: the marks go.
  store.putWork({ ...store.work.get('w6690')!, queuedFor: { at: T } });
  assert.deepEqual(o.auditExclusions(), []);
  assert.equal(store.work.get('w6690')!.exclusionsLogged, undefined);
});

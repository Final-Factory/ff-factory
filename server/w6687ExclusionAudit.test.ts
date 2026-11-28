// w6687 (lothsahn: "Yes, file it: machine exclusions must cite a live hold and expire with it"): for over a day every
// built-player job was kept off BEAST by "No game player on BEAST (crash hold)", copied from brief to brief and into
// request_pair (avoid: ["beast"]), while the real crash hold had cleared 16 minutes after it was set (w6685). Stage 1 is
// warn-only: the audit logs what enforcing would drop, and drops nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditExclusions, crashHoldsLine, exclusionReason, liveCrashHoldList, type ExclusionFacts } from './exclusionAudit.ts';
import type { Computer, PlacementPrefs } from './placement.ts';
import type { Requester, WorkItem } from '../shared/types.ts';
import { citeAvoid } from './orchestrators.ts';
import { setup } from './orchestratorsTestKit.ts';

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const T = '2026-11-26T18:39:00.000Z';

const pc = (id: string, extra: Partial<Computer> = {}): Computer =>
  ({ id, online: true, live: 0, midTurn: 0, maxAgents: 6, sandboxes: 4, maxSandboxes: 5, freeSandboxes: 2, platform: 'win32', ...extra }) as Computer;

const COMPUTERS = [pc('beast'), pc('lothdesktop'), pc('m5', { platform: 'darwin', noTimedRuns: 'timing runs never on m5' })];

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

/** w6673, the request the pair runs are for, whose crash hold on BEAST was set at 18:39Z (w6754: only its own pair runs keep off BEAST for it). */
const holder = (cleared?: string): WorkItem =>
  work('w6673', { title: 'barge no-destination audit', status: 'active', crashHolds: [{ machine: 'beast', at: T, worker: 'c7bb04a5', why: 'running player pid 400216', ...(cleared ? { cleared, clearedBy: 'the worker ran on' } : {}) }] });

const facts = (open: WorkItem[], prefs: PlacementPrefs = {}, computers = COMPUTERS): ExclusionFacts => ({ crashHolds: liveCrashHoldList(open), prefs, config: prefs, computers });

test('w6687: an avoid of BEAST is kept while its crash hold is live, and enforcing would drop it once the hold clears', () => {
  const pair = work('w6678', { pair: { legs: 2, for: 'w6673', avoid: ['beast'] } });
  const live = auditExclusions(pair, facts([holder()]));
  assert.deepEqual(live.map((v) => [v.machine, v.keep, v.kind]), [['beast', true, 'crash-hold']]);
  assert.match(live[0].reason, /w6673's crash hold on beast \(18:39Z\)/);
  const cleared = auditExclusions(pair, facts([holder('2026-11-26T18:55:00.000Z')]));
  assert.deepEqual(cleared.map((v) => [v.machine, v.keep]), [['beast', false]]);
  // A closed request's hold is no live hold either.
  assert.equal(auditExclusions(pair, facts([{ ...holder(), status: 'done' }]))[0].keep, false);
});

test('w6687: a free-text "not on beast" with no live hold is not a reason, whatever the brief or avoid_why says', () => {
  const pair = work('w6678', { pair: { legs: 2, for: 'w6673', avoid: ['beast'], avoidWhy: { beast: 'No game player on BEAST (crash hold)' } } });
  const [v] = auditExclusions(pair, facts([]));
  assert.equal(v.keep, false);
  assert.match(v.reason, /nothing live names it \(no crash hold, machine hold or pause, config placement rule/);
  assert.match(v.reason, /it cited: "No game player on BEAST \(crash hold\)"/);
  // The dispatcher's "only on lothdesktop" (decide_work queue needs) leaves BEAST out with no reason: flagged the same way.
  const queued = work('w6684', { title: 'station-follow clip', queuedFor: { at: T, needs: ['lothdesktop'] } });
  const out = auditExclusions(queued, facts([]));
  assert.deepEqual(out.filter((x) => !x.keep).map((x) => x.machine), ['beast', 'm5']);
  // m5 left out of a game request's needs is a capability (a Mac) only for a pair run; here no rule names it, so it is flagged too.
  assert.equal(out.find((x) => x.machine === 'm5')?.keep, false);
});

test('w6687: an exclusion from a config rule stays, and so do holds, pauses, capabilities and a person\'s words', () => {
  const pair = (extra: Partial<WorkItem['pair'] & object> = {}) => work('w6678', { pair: { legs: 2, for: 'w6673', avoid: ['beast'], ...extra } });
  const cfgAvoid = exclusionReason('beast', pair(), facts([], { avoid: { beast: 'GPU under repair' } }));
  assert.deepEqual(cfgAvoid, { kind: 'config', reason: 'config placement.avoid.beast (GPU under repair)' });
  const cfgHold = exclusionReason('beast', pair(), facts([], { hold: { beast: 'Ben: kernel token leak' } }));
  assert.equal(cfgHold?.kind, 'config');
  assert.match(cfgHold!.reason, /placement\.hold\.beast/);
  const paused = exclusionReason('beast', pair(), facts([], { hold: { beast: 'paused from its tray app by lothsahn' } }));
  assert.equal(paused?.kind, 'machine-hold');
  const offline = exclusionReason('beast', pair(), facts([], {}, [pc('beast', { online: false })]));
  assert.equal(offline?.kind, 'machine-hold');
  // The Mac multiplayer-client guard (w3697) is a capability fact: a Mac on an avoid list stays.
  const mac = auditExclusions(pair({ avoid: ['m5'] }), facts([]));
  assert.deepEqual(mac.map((v) => [v.machine, v.keep, v.kind]), [['m5', true, 'capability']]);
  // A split run's host may be a Mac: then the Mac rule is no reason, and nothing else names m5.
  assert.equal(auditExclusions(pair({ avoid: ['m5'], split: 'pair relay' }), facts([]))[0].keep, false);
  // A person's own words on the request it is for.
  const parent = work('w6673', { status: 'active', notes: [{ at: T, by: 'lothsahn', text: 'Please keep this off beast tonight, I am gaming.' }] });
  const person = auditExclusions(pair(), facts([]), parent);
  assert.deepEqual(person.map((v) => [v.keep, v.kind]), [[true, 'person']]);
  // A pin set with a person's words stands; the dispatcher's own pin note is flagged.
  assert.equal(auditExclusions(work('w1', { machinePin: { ids: ['lothlaptop'], why: "a person's words, passed by the dispatcher: run it on my laptop" } }), facts([]))[0].keep, true);
  assert.equal(auditExclusions(work('w2', { machinePin: { ids: ['lothdesktop'], why: 'the dispatcher: BEAST has a crash hold' } }), facts([]))[0].keep, false);
});

test('w6687: citeAvoid records what the asker cited, by machine id', () => {
  const p = work('w6678', { pair: { legs: 2, for: 'w6673', avoid: ['beast'] } });
  citeAvoid(p, ['BEAST'], '  a leg  failed there ');
  citeAvoid(p, ['lothlaptop'], undefined);
  assert.deepEqual(p.pair!.avoidWhy, { beast: 'a leg failed there', lothlaptop: 'no reason given' });
});

test('w6687 warn-only: the minute audit logs once what enforcing would drop, re-logs when the hold clears, and changes no placement', (t) => {
  const { o, store } = setup(t);
  const hold = holder();
  const pair = work('w6678', { pair: { legs: 2, for: 'w6673', avoid: ['beast'] } });
  const stale = work('w6700', { pair: { legs: 2, for: 'w6673', avoid: ['biscuit'], avoidWhy: { biscuit: 'brief says crash hold' } } });
  const config = work('w6701', { pair: { legs: 2, for: 'w6673', avoid: ['lothdesktop'] } });
  for (const w of [hold, pair, stale, config]) store.putWork(w);
  const prefs: PlacementPrefs = { avoid: { lothdesktop: 'lothsahn plays there evenings' } };
  (o as unknown as { d: { exclusionFacts: () => ExclusionFacts } }).d.exclusionFacts = () => facts([...store.work.values()], prefs, [...COMPUTERS, pc('biscuit')]);
  // While w6673's crash hold is live, BEAST's avoid stands; only the avoid of biscuit (no live reason) is logged.
  assert.deepEqual(o.auditExclusions(), ['w6700']);
  assert.match(JSON.stringify(store.work.get("w6700")!.log.at(-1)), /w6687 warn-only, nothing dropped: enforcing would drop biscuit from its pair avoid: .*it cited: \\"brief says crash hold/);
  // Once per change: the next minute logs nothing new.
  assert.deepEqual(o.auditExclusions(), []);
  // The hold clears: w6678's avoid now cites nothing live, and its log says the hold it was kept for cleared.
  const h = store.work.get('w6673')!;
  h.crashHolds = h.crashHolds!.map((x) => ({ ...x, cleared: '2026-11-26T18:55:00.000Z', clearedBy: 'lothsahn' }));
  store.putWork(h);
  assert.deepEqual(o.auditExclusions(), ['w6678']);
  const line = JSON.stringify(store.work.get('w6678')!.log.at(-1));
  assert.match(line, /drop beast from its pair avoid: w6673's crash hold on beast \(18:39Z\) has cleared, so enforcing would re-queue it for beast/);
  // Warn-only: every avoid list is as it was, and the config rule's exclusion was never logged.
  assert.deepEqual(store.work.get('w6678')!.pair!.avoid, ['beast']);
  assert.deepEqual(store.work.get('w6700')!.pair!.avoid, ['biscuit']);
  assert.ok(!JSON.stringify(store.work.get('w6701')!.log).includes('w6687'));
});

test('w6687: the dispatcher\'s crash-hold line comes from the live list, so a cleared hold is gone from it', () => {
  assert.match(crashHoldsLine(liveCrashHoldList([holder()])), /: beast for w6673 \(since 18:39Z\)\./);
  assert.match(crashHoldsLine(liveCrashHoldList([holder('2026-11-26T18:55:00.000Z')])), /the live list; [^)]*\): none\./);
});

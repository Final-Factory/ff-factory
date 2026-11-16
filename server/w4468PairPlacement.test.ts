// w4468 (lothsahn, 2026-11-16: "How did those pair runs get stuck? Please find and fix how that happened."): five pair runs
// (w4441, w4334, w4462, w4460, w4207) sat Queued for capacity for hours at about 21:45 UTC while computers were idle. The
// causes, each with its case here: a person's game on lothdesktop re-queued w4460 and w4207 with lothdesktop avoided for
// good (w2304); "two-computer pair lab" and a person's "A Mac may host leg 1" did not count as spread peers (w3697), and the
// w3697 sentence request_pair wrote into the brief was itself read as one; nothing could take a computer off an avoid list
// (w4334: lothsahn's "drop the avoid"); the dispatcher's named needs [lothdesktop, beast] hid biscuit's room from w4462; and
// a pair no computers could take together showed Queued, not Stalled with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macRefusedScenario, macRuleWords, pairText, transientPairAvoids, unfitWhy } from '../shared/capacity.ts';
import type { Requester, WorkItem } from '../shared/types.ts';
import { queuedNeeds, workLive } from '../shared/workState.ts';
import { pairNoPlacement, type Computer } from './placement.ts';
import { remarkPair } from './orchestrators.ts';

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const T = '2026-11-16T18:00:00.000Z';

const pairRun = (extra: Partial<WorkItem> = {}): WorkItem => ({
  id: 'w4460',
  title: 'Pair run for w4440: MP-W4440-belt-split determinism check',
  brief: 'Run MP-W4440-belt-split with ffnightly.py; the scenario starts its host and its client on one computer.',
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
  pair: { legs: 2, for: 'w4440' },
  ...extra,
});

const FIT = { beast: { platform: 'win32' }, lothdesktop: { platform: 'win32' }, lothlaptop: { platform: 'win32' }, biscuit: { platform: 'linux' }, m3: { platform: 'darwin' }, m5: { platform: 'darwin' } };
const pc = (id: string, x: Partial<Computer> = {}): Computer => ({ id, online: true, live: 0, midTurn: 0, maxAgents: 4, sandboxes: 2, maxSandboxes: 4, freeSandboxes: 2, platform: FIT[id as keyof typeof FIT]?.platform, ...x });

test('w4468: a w2304 re-queue for a person\'s game avoids that computer only while it is held: the avoid it wrote is transient', () => {
  const w = pairRun({
    pair: { legs: 2, for: 'w4440', avoid: ['lothdesktop', 'biscuit'] },
    log: ['2026-11-16T19:02:00.000Z re-queued as a pair run (w2304, lothdesktop: Lothsahn started playing there; its 2 legs start fresh together, not on lothdesktop)'],
  });
  assert.deepEqual(transientPairAvoids(w), ['lothdesktop'], 'biscuit came from a w2041 retry, not a yield');
  assert.deepEqual(transientPairAvoids({ ...w, pair: { ...w.pair!, started: { at: T, legs: [] } } }), [], 'a started pair keeps its marks');
  assert.deepEqual(transientPairAvoids({ ...w, log: [] }), [], 'no yield line, nothing is transient');
  const two = { ...w, log: ['x re-queued as a pair run (w2304, held; its 2 legs start fresh together, not on lothdesktop or beast)'], pair: { legs: 2, avoid: ['beast', 'lothdesktop'] } };
  assert.deepEqual(transientPairAvoids(two), ['beast', 'lothdesktop']);
});

test('w4468: "two-computer pair lab" and a person\'s "A Mac may host" spread its peers, and a Mac may host it (w4460, w4334)', () => {
  const lab = pairRun({ brief: 'Run MP-W4440-belt-split as a two-computer pair lab: leg 1 hosts, leg 2 joins over direct IP.' });
  assert.equal(macRefusedScenario(lab), undefined);
  assert.equal(unfitWhy(lab, 'm5', FIT), undefined);
  const note = pairRun({ notes: [{ at: T, by: 'lothsahn', text: 'A Mac (m5 or m3) may host leg 1.' }] } as Partial<WorkItem>);
  assert.equal(macRefusedScenario(note), undefined, "lothsahn's note on w4334");
  const split = pairRun({ pair: { legs: 2, split: 'lab.pair-m5-beast.json spreads the peers' } });
  assert.equal(macRefusedScenario(split), undefined, 'pair.split, set by request_pair split or decide_work pair_split');
  assert.match(pairText(split.pair!), /its peers spread \(a Mac may host: lab\.pair-m5-beast\.json spreads the peers\)/);
  assert.equal(macRefusedScenario(pairRun()), 'MP-W4440-belt-split', 'a plain scenario run still takes no Mac');
});

test('w4468: the w3697 sentence request_pair wrote into a brief is not itself read as a pair lab', () => {
  const said = pairRun({ brief: `${pairRun().brief}\nNo leg goes on a Mac (w3697): each leg starts MP-W4440-belt-split's host and its client on its own computer, and .` });
  assert.doesNotMatch(macRuleWords(said), /w3697/);
  assert.equal(macRefusedScenario(said), 'MP-W4440-belt-split');
});

test('w4468: remarkPair allow takes computers off the avoid list and split sets or clears "a Mac may host" (w4334)', () => {
  const p = { legs: 2, for: 'w4300', avoid: ['biscuit', 'm3'] };
  const r = remarkPair(p, { allow: ['BISCUIT'] });
  assert.equal(r.changed, true);
  assert.deepEqual(r.pair.avoid, ['m3']);
  const all = remarkPair(r.pair, { allow: ['m3'], split: 'lothsahn: "A Mac may host leg 1"' });
  assert.equal(all.pair.avoid, undefined);
  assert.equal(all.pair.split, 'lothsahn: "A Mac may host leg 1"');
  assert.equal(remarkPair(all.pair, { split: 'none' }).pair.split, undefined);
  assert.equal(remarkPair(all.pair, { allow: ['beast'] }).changed, false);
});

test('w4468: the needs a dispatcher named when it queued a pair do not narrow where it may start (w4462 and biscuit)', () => {
  const w = pairRun({ queuedFor: { at: T, needs: ['lothdesktop', 'beast'] } });
  assert.equal(queuedNeeds(w), undefined);
  assert.deepEqual(queuedNeeds({ ...w, pair: undefined }), ['lothdesktop', 'beast'], 'work that is no pair keeps them');
  assert.deepEqual(queuedNeeds({ ...w, pair: { legs: 2, started: { at: T, legs: [] } } }), ['lothdesktop', 'beast']);
});

test('w4468: a pair no computers can take together is Stalled with why, not Queued (w4441 at 21:45 UTC)', () => {
  const w = pairRun({ id: 'w4441', pair: { legs: 2, for: 'w4400', avoid: ['biscuit'] } });
  const fleet = [pc('beast'), pc('lothdesktop'), pc('lothlaptop', { online: false }), pc('biscuit'), pc('m3'), pc('m5')];
  const prefs = { hold: { beast: 'Ben benchmarking' }, holdExcept: {} };
  // lothdesktop alone qualifies: BEAST held, LothLaptop offline, biscuit avoided, both Macs refuse the scenario's client.
  const why = pairNoPlacement(fleet, prefs, w) ?? '';
  assert.match(why, /^no placement possible: 2 legs need 2 computers it may run on, and only lothdesktop qualifies; /);
  assert.match(why, /beast: held \(Ben benchmarking\)/);
  assert.match(why, /lothlaptop: offline/);
  assert.match(why, /m5: m5 is a Mac/);
  assert.doesNotMatch(why, /; $/);
  const live = workLive(w, { items: [w], session: () => undefined, now: Date.parse(T), pairStuck: (x) => pairNoPlacement(fleet, prefs, x) })!;
  assert.equal(live.state, 'stalled');
  assert.match(live.why ?? '', /^queued, but no placement possible: .*It returns to Queued by itself when a hold lifts/);
  // The hold lifts: two qualify, so it is Queued again (and the capacity ping places it).
  assert.equal(pairNoPlacement(fleet, {}, w), undefined);
  assert.equal(workLive(w, { items: [w], session: () => undefined, now: Date.parse(T), pairStuck: (x) => pairNoPlacement(fleet, {}, x) })!.state, 'queued');
  // A fleet too small with nothing excluded for a reason stays Queued: a computer may still join.
  assert.equal(pairNoPlacement([pc('lothdesktop')], {}, w), undefined);
  // A hold that lets this request through counts as no hold.
  assert.equal(pairNoPlacement(fleet, { hold: { beast: 'Ben, except w4441' }, holdExcept: { beast: ['w4441'] } }, w), undefined);
});

// w3720 (lothsahn, 2026-11-08: "Please figure out why it looked for a time to run when it only needed to do a determinism
// check and we need to make sure we're not doing time runs when we shouldn't be"). w3705, the two-machine determinism pair
// run for PR #3451 and the last gate of the 1.0 release, was placed at 19:22 UTC as plain work. Then its orchestrator's note
// at 20:03 said it was NOT a timing run, but quoted LothLaptop's "bench lock ... held by w3639's vSync timed run", and the
// w1872 classifier (shared/capacity.ts needsTimed) read it as timed work; the 20:30 note ("m5 ... may be the host as a Mac")
// made it timed work on darwin. So m5 refused it as timed (journal 20:06:57Z) and biscuit as not a Mac (20:30:29Z), and it
// sat Queued beside free room. Now a pair run is timed only by request_pair's or decide_work's explicit timed, decide_work
// timed false clears any request, and a note that denies timing wins over older words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsTimed, timedDenial, unfitWhy } from '../shared/capacity.ts';
import type { WorkItem } from '../shared/types.ts';

const W3705_TITLE = 'Pair run for w3511: MP Sprawl determinism pair on PR #3451 (w3511)';
const W3705_BRIEF = `PR Final-Factory/FinalFactory#3451 (w3511, branch w3511-sprawl, head 7e01ca4e259c09f09ccc41592e98045364748cb1): a "Sprawl" term added to each station's NeededStability in StationGridCalculationSystem phase 1 (CalculateStabilityAndMass, runs only when grid.StructuresChanged), integer-only maths in StationStabilityRules.SprawlScoreMilli/SprawlStability; cache fields on StationGridInternal (SprawlTiles, SprawlScoreMilli, SprawlStability, SprawlRecalculations). Applies only to stations of 1000+ tiles whose shape score is over 2.0 (+50% cap at 10.0).

Goal: prove host and client compute the same NeededStability with Sprawl, before and after a structure change on a paying station, and after a forced resync.

Scenario (author it as scripts/nightly/scenarios/MP-W3511-sprawl.json modelled on scripts/nightly/scenarios/MP-W3510-stability-rule-a.json, run on both legs at the PR head):
- World: the save bigAmazingSaveForTrailer (the BAL-mid-trailer fixture; it has 11 paying stations, 5 at the cap). Station grid 205375 (+99 Sprawl, stable->unstable) and 205302 (+1) pay there; find one paying station's tiles in the editor (StationGridInternal.SprawlStability > 0) and pick a free tile adjacent to it.
- Host loads, client joins late; the host places a structure (e.g. a Strut or Connector joining the station) on a paying station, the client places one too; then desync.forceresync|all.
- Pass: observe.state structure on that station: data.stability needed/core/nonCore sameAcrossPeers before and after placements and after the resync; desync.stats on the host 0 diverged with samples compared (both phases); no desync report files. Also read StationGridInternal.SprawlStability on both peers if the harness exposes it (station.powerwatch TSV has sprawlTiles, sprawlScore, sprawlStability columns via StationPowerHarnessCommands).
- If the trailer save is not on the leg machines, use another fixture with a 1000+ tile station that pays Sprawl (JustPlay stations 486776 / 486784), and say which.

Result: post a comment on PR #3451 with heartbeats compared, diverged count, both phases, the machines/OSes and the commit; report "For w3511:" with the same. Do not merge or push to the PR branch except the new scenario file if it is worth keeping (then commit it to the PR branch with a plain merge-safe commit and say so).

FF Factory filed this for worker 45e1dfe9 on w3511 (w1945, request_pair): a pair run of 2 legs, on any computers, any OS (a Mac only as the host, leg 1). Its legs start together, one worker on each computer (start_agent with pair_sandboxes); each leg's first message says which leg it is and where the others are, and message_pair reaches them. w3511's worker is Blocked on this request's report: the host leg (leg 1) reports the result with a line "For w3511:" (what ran, the commit every leg ran, what the check compared and found, any desync report files), and every leg ends with DONE once the run is over. Do not merge w3511's pull request: its own worker does.`;
const W3705_NOTES: { at: string; by: string; text: string }[] = [
  { at: '2026-11-08T18:58:00Z', by: 'orchestrator', text: 'lothsahn: "Make w3705 urgent". It gates w3511, which is the last gate of the 1.0 release (w3614).' },
  { at: '2026-11-08T20:03:00Z', by: 'orchestrator', text: "Orchestrator, for the dispatcher: this pair run doesn't need exclusive use of a machine; it's a determinism check, not a timing run. But its client leg is on LothLaptop, whose bench lock is held by w3639's vSync timed run (tr_dadec6ac06, started about 19:50 UTC, about 106 min). The client launch waits out that lock with --bench-wait (up to 30 min), then fails. The host's second attempt just started on biscuit. This gates the 1.0 release (urgent, lothsahn: everything a release waits on is urgent). If the client launch is held by LothLaptop's lock, move leg 2 to another free computer now rather than wait for the timed run to end. Don't break the timed run." },
  { at: '2026-11-08T20:30:00Z', by: 'orchestrator', text: "Orchestrator, for the dispatcher (release-gate check, 21:xx UTC): w3705 is a determinism pair, not a timing run. It needs no bench lock and isn't timed work. It has been queued since 20:06. Room exists now. Biscuit has a free sandbox (2/3 in use). m5 also has room (2/3 in use) and may be the host as a Mac; m5 refuses only timing runs. Please place it now: leg 1 (host) on m5 or biscuit, leg 2 on the other one, or on BEAST when a slot frees there. LothDesktop is held and LothLaptop is paused by hand, so don't wait for either. This is urgent: it is the last gate of the 1.0 release (w3614)." },
];
const W3705_CONSTRAINTS = 'a pair run of 2 legs, on any computers, any OS (a Mac only as the host, leg 1), not on lothlaptop';

const work = (over: Partial<WorkItem> = {}): WorkItem => ({ title: W3705_TITLE, brief: W3705_BRIEF, constraints: W3705_CONSTRAINTS, notes: W3705_NOTES, needs: 'game', pair: { legs: 2, for: 'w3511', pr: 'Final-Factory/FinalFactory#3451' }, ...over }) as unknown as WorkItem;
const M5 = { platform: 'darwin', noTimedRuns: 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"' } as const;

test('w3720: w3705 as filed and with every note is no timed work, so m5 and biscuit both fit it', () => {
  const w = work();
  assert.equal(needsTimed(w), false, 'its words, notes included, never make a pair run timed');
  assert.equal(needsTimed(w, 'Run MP-W3511-sprawl.json on both legs; LothLaptop\'s bench lock is held by a timed run.'), false, "nor does the dispatcher's brief");
  // m5 as a Windows box, so only its no-timed-runs rule is in play (a Mac host is w3697's question: macRefusedScenario).
  assert.equal(unfitWhy(w, 'm5', { m5: { ...M5, platform: 'win32' } }), undefined, 'a computer that takes no timed runs fits it');
  assert.doesNotMatch(unfitWhy(w, 'm5', { m5: M5 }) ?? '', /timed/, 'what m5 says of it never names timing');
  assert.equal(unfitWhy(w, 'biscuit', { biscuit: { platform: 'linux' } }), undefined, 'biscuit fits it: no Mac was asked for');
});

test('w3720: a pair run is timed only when request_pair or decide_work said so', () => {
  assert.equal(needsTimed(work({ pair: { legs: 2, timed: true } })), 'any');
  assert.match(unfitWhy(work({ pair: { legs: 2, timed: true } }), 'm5', { m5: M5 }) ?? '', /m5 takes no timed runs/);
  assert.equal(needsTimed(work({ timedMark: { timed: true, at: '2026-11-08T21:00:00Z', by: 'dispatcher', note: 'p99 A/B' } })), 'any');
  assert.equal(needsTimed(work({ pair: { legs: 2, timed: true }, timedMark: { timed: false, at: '2026-11-08T21:00:00Z', by: 'dispatcher', note: 'a determinism check' } })), false, 'a mark of false beats the pair flag');
});

test('w3720: without the pair rule, the old reading of w3705 was timed on darwin; the denial in its notes now wins too', () => {
  // As single work (pair undefined) its words alone decide: the notes deny timing, so it is not timed.
  const single = work({ pair: undefined });
  assert.equal(needsTimed(single), false, '"not a timing run ... isn\'t timed work" is the newest word on timing');
  // The 20:03 note alone (its denial is "not a timing run") is not timed either.
  assert.equal(needsTimed(work({ pair: undefined, notes: W3705_NOTES.slice(0, 2) })), false);
  for (const no of ["it's a determinism check, not a timing run", "It needs no bench lock and isn't timed work.", 'This is not timed.', "this pair run doesn't need exclusive use of a machine", 'no timing work here'])
    assert.equal(timedDenial(no), true, no);
  for (const yes of ['Benchmark the belt cache before and after', 'Do the timed run on LothLaptop', 'not before the timed run ends', 'Profile it and fix the p99 frames'])
    assert.equal(timedDenial(yes), false, yes);
});

test('w3720: real timed work still reads as timed, and decide_work timed false clears it', () => {
  const t = (title: string, brief = '', notes: string[] = []) => ({ title, brief, notes: notes.map((text, i) => ({ text, at: `2026-11-08T2${i}:00:00Z` })), needs: 'game' }) as unknown as WorkItem;
  assert.equal(needsTimed(t('vSync drops after w3540: find and fix the rest', 'Measure frame times before/after on the same machine.')), 'any');
  assert.equal(needsTimed(t('Perf A/B of the belt cache on the Windows player')), 'win32');
  assert.equal(needsTimed(t('Benchmark the paste', '', ['It is not a timing run after all: just check it works.'])), false, 'a newer denial wins');
  assert.equal(needsTimed(t('Benchmark the paste', 'not a timing run, a check', ['Actually do benchmark it before/after.'])), 'any', 'a newer mention wins over an older denial');
  assert.equal(needsTimed({ ...t('Benchmark the paste'), timedMark: { timed: false, at: '2026-11-08T21:00:00Z', by: 'dispatcher', note: 'a functional check' } } as WorkItem), false);
});

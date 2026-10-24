// w1969: the ask before an exclusive bench ticket. lothsahn, 2026-10-24: "Why are these on the big machines and not
// scheduled for m3 or even biscuit? The scheduler should favor running exclusive locks on machines with a small number of
// slots", then "Maybe every time a worker needs an exclusive lock it should ask the dispatcher?"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkTimedAsk, decideTimedPlace, smallTimedRank, timedAskMark, timedTicketCommand, SMALL_TIMED_MAX_AGENTS, TIMED_LEG_WAIT_MS } from './timedAsk.ts';
import { readTimedAsk, writeBenchPriorities } from '../machine/benchLock.ts';
import type { Computer } from './placement.ts';

const GB = 1024 ** 3;
const box = (id: string, maxAgents: number, platform: string, o: Partial<Computer> = {}): Computer => ({ id, online: true, live: 1, midTurn: 0, maxAgents, sandboxes: 1, maxSandboxes: Math.max(1, Math.ceil(maxAgents / 2)), freeSandboxes: 1, memUsedBytes: 16 * GB, memTotalBytes: 64 * GB, editors: 0, maxEditors: 2, platform, ...o });
const NO = 'lothsahn, 2026-10-23: "The m5 should not be used for timing runs because Ben runs stuff on it personally"';
// The fleet of 2026-10-24 (the request's ledger read): BEAST 6 agents, LothDesktop 10, LothLaptop 1, m3 and biscuit small.
const fleet = () => [box('beast', 6, 'win32', { live: 6 }), box('lothdesktop', 10, 'win32', { live: 9 }), box('lothlaptop', 1, 'win32', { live: 0 }), box('m3', 2, 'darwin'), box('biscuit', 4, 'linux'), box('m5', 4, 'darwin', { live: 0, noTimedRuns: NO })];
const full = (c: Computer): Computer => ({ ...c, live: c.maxAgents, freeSandboxes: 0, sandboxes: c.maxSandboxes });
const ids = (cs: Computer[]) => cs.map((c) => c.id);
const at = (id: string) => fleet().find((c) => c.id === id)!;

test('w1969: the small computers rank by agent slots, those with room first; never m5, never a big one', () => {
  assert.equal(SMALL_TIMED_MAX_AGENTS, 4);
  assert.deepEqual(ids(smallTimedRank(fleet(), {}, undefined, 'beast')), ['lothlaptop', 'm3', 'biscuit']);
  // A busy LothLaptop still ranks, after the small ones with room: the leg queues there rather than going to a big one.
  const busy = fleet().map((c) => (c.id === 'lothlaptop' ? full(c) : c));
  assert.deepEqual(ids(smallTimedRank(busy, {}, undefined, 'beast')), ['m3', 'biscuit', 'lothlaptop']);
  assert.deepEqual(ids(smallTimedRank(fleet(), {}, 'win32', 'beast')), ['lothlaptop']);
  assert.deepEqual(ids(smallTimedRank(fleet(), {}, 'darwin', 'beast')), ['m3'], 'the Mac that takes timed runs, not m5');
  assert.deepEqual(ids(smallTimedRank(fleet(), { hold: { m3: 'Ben testing' }, avoid: { biscuit: 'reserved' } }, undefined, 'beast')), ['lothlaptop']);
  assert.deepEqual(ids(smallTimedRank(fleet().map((c) => (c.id === 'lothlaptop' ? { ...c, online: false } : c)), {}, 'win32', 'beast')), []);
});

test('w1969: a timed leg from BEAST or LothDesktop goes to the small computers; it queues on busy ones and says when a big one may take it', () => {
  const d = decideTimedPlace({ here: at('beast'), places: fleet() });
  assert.equal(d.verdict, 'elsewhere');
  assert.deepEqual(d.needs, ['lothlaptop', 'm3', 'biscuit']);
  assert.match(d.why, /^beast has 6 agent slots \(6 live now\): an exclusive turn there idles all the others; small computers take it: lothlaptop \(1 agent slot, 0 live, room now\) > m3 \(2 agent slots, 1 live, room now\) > biscuit \(4 agent slots, 1 live, room now\)$/);
  const busy = fleet().map((c) => (['lothlaptop', 'm3', 'biscuit'].includes(c.id) ? full(c) : c));
  const q = decideTimedPlace({ here: at('lothdesktop'), places: busy, platform: 'win32' });
  assert.deepEqual(q.needs, ['lothlaptop']);
  assert.match(q.why, /on Windows take it: lothlaptop \(1 agent slot, 1 live, no room now\); none has room now, so it queues there \(a big one only after 60 min\)$/);
  assert.equal(TIMED_LEG_WAIT_MS, 60 * 60_000);
});

test('w1969: the leg stays here on a small computer, with a same-machine reason, for the release lane and the nightly, and with no small computer online', () => {
  assert.equal(decideTimedPlace({ here: at('lothlaptop'), places: fleet() }).verdict, 'here');
  assert.match(decideTimedPlace({ here: at('m3'), places: fleet() }).why, /^m3 is a small computer \(2 agent slots, at most 4\)/);
  const same = decideTimedPlace({ here: at('beast'), places: fleet(), sameMachine: 'the base side ran here at 01:10Z' });
  assert.equal(same.verdict, 'here');
  assert.match(same.why, /its numbers must come from beast: "the base side ran here at 01:10Z" \(both sides of an A\/B stay on one machine\)/);
  assert.equal(decideTimedPlace({ here: at('beast'), places: fleet(), exempt: 'release' }).verdict, 'here');
  const none = decideTimedPlace({ here: at('beast'), places: fleet().filter((c) => c.maxAgents > 4 || c.noTimedRuns), platform: 'win32' });
  assert.equal(none.verdict, 'here');
  assert.match(none.why, /no small computer on Windows that takes timed runs is online \(never m5\): time here/);
  assert.equal(decideTimedPlace({ here: undefined, places: fleet() }).verdict, 'here');
});

test('w1969: m5 sends its timed leg to a small computer; a player A/B goes to an online play-only computer by timed_run when asked', () => {
  const m5 = decideTimedPlace({ here: at('m5'), places: fleet(), platform: 'darwin' });
  assert.equal(m5.verdict, 'elsewhere');
  assert.deepEqual(m5.needs, ['m3']);
  const tr = decideTimedPlace({ here: at('beast'), places: fleet(), via: 'timed_run', timedRun: ['lothdesk16'] });
  assert.equal(tr.timedRun, 'lothdesk16');
  assert.match(tr.why, /a Windows player A\/B goes to lothdesk16 by timed_run, built here \(w1946, w1996\)/);
  assert.equal(decideTimedPlace({ here: at('beast'), places: fleet(), via: 'timed_run', timedRun: [] }).timedRun, undefined, 'none up: a leg');
});

test('w1969: a big computer asks before an exclusive timing ticket; a small one and one that takes no timed runs do not', () => {
  assert.equal(timedAskMark(at('beast'))?.required, true);
  assert.equal(timedAskMark(at('lothdesktop'))?.required, true);
  assert.equal(timedAskMark(at('lothlaptop'))?.required, false);
  assert.equal(timedAskMark(at('m5')), undefined);
});

test('w1969: the commands that take an exclusive timing ticket, run, not read', () => {
  const yes: [string, string][] = [
    ['python scripts/bench/bench_queue.py timed --what "w1891 A/B" --minutes 20', 'bench_queue.py timed'],
    ['cd /f/ffw/sandboxes/slot3 && python -u scripts/bench/bench_queue.py run --mode exclusive --what x -- bash leg.sh', 'bench_queue.py run --mode exclusive'],
    ['python scripts/unity-bridge.py eval_file "$TMPDIR/bench.cs" --timed "belt cache"', 'unity-bridge.py --timed'],
    ['source scripts/bench/quiet_gate.sh; bench_lock --timing "probe base"', 'bench_lock --timing'],
    ['ROUNDS=4 bash scripts/bench/probe_ab_win.sh base fix', 'probe_ab_win.sh'],
    ['timeout -s TERM 3600 scripts/bench/cpu_budget_run.sh save.zip', 'cpu_budget_run.sh'],
    ['unity-slot run --label "perf" --bench exclusive -- Unity.exe -batchmode -runTests', 'unity-slot --bench exclusive'],
    ['unity-slot run --label perf -- bash scripts/bench/zoom_run.sh big.zip', 'zoom_run.sh'],
    ['bash -c "python scripts/bench/bench_queue.py timed --what probe"', 'bench_queue.py timed'],
  ];
  for (const [cmd, want] of yes) assert.equal(timedTicketCommand(cmd), want, cmd);
  const no = [
    'python scripts/bench/bench_queue.py timed --release',
    'python scripts/bench/bench_queue.py report',
    'python scripts/bench/bench_queue.py run --mode exclusive --reason machine -- bash wipe.sh',
    'python scripts/bench/bench_queue.py run --mode shared -- bash build.sh',
    'grep -n bench_lock scripts/bench/probe_ab_win.sh',
    'sed -n 1,40p scripts/bench/probe_ab_win.sh',
    'git diff -- scripts/bench/zoom_run.sh',
    'unity-slot run --bench shared -- Unity.exe -batchmode -buildTarget Win64',
    'unity-slot run --bench exclusive --bench-reason machine -- Unity.exe -batchmode',
    'python scripts/unity-bridge.py eval "1+1" --not-timing "a timeout"',
  ];
  for (const cmd of no) assert.equal(timedTicketCommand(cmd), undefined, cmd);
});

test('w1969: the guard refuses an exclusive timing ticket on a big computer until its worker asked, and names where the leg went', () => {
  const mark = timedAskMark(at('beast'))!;
  const cmd = 'python scripts/bench/bench_queue.py timed --what probe --minutes 20';
  const now = Date.parse('2026-10-24T03:00:00Z');
  const later = new Date(now + 3_600_000).toISOString();
  assert.equal(checkTimedAsk(cmd, undefined, now), undefined, 'no priorities file: fails open');
  assert.equal(checkTimedAsk(cmd, { mark: timedAskMark(at('lothlaptop')) }, now), undefined, 'a small computer asks nothing');
  assert.match(checkTimedAsk(cmd, { mark }, now)!, /^w1969: bench_queue\.py timed takes an exclusive bench ticket, and beast has 6 agent slots: .*Call timed_place \(what, brief, platform\) first/);
  assert.equal(checkTimedAsk(cmd, { mark, verdict: { verdict: 'here', why: 'x', until: later } }, now), undefined);
  assert.match(checkTimedAsk(cmd, { mark, verdict: { verdict: 'here', why: 'x', until: new Date(now - 1).toISOString() } }, now)!, /Call timed_place/, 'an old verdict asks again');
  const gone = checkTimedAsk(cmd, { mark, verdict: { verdict: 'elsewhere', why: 'beast has 6 agent slots', until: later, leg: 'w2001' } }, now)!;
  assert.match(gone, /the dispatcher sent this timed leg to w2001, the timed leg FF Factory filed for it, which runs on a small computer and reports to you \(beast has 6 agent slots\), so bench_queue\.py timed takes no exclusive ticket here\. If its numbers must come from this computer .* same_machine/);
  assert.equal(checkTimedAsk(cmd, { mark, exempt: 'release' }, now), undefined, 'the urgent release lane');
  assert.equal(checkTimedAsk('python scripts/bench/bench_queue.py timed --release', { mark }, now), undefined, 'letting go is never refused');
  assert.equal(checkTimedAsk('npm test', { mark }, now), undefined);
});

test('w1969: the mark and each session\'s verdict go through priorities.json to the guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1969-'));
  const until = new Date(Date.now() + 3_600_000).toISOString();
  writeBenchPriorities(root, { s1: { priority: 'normal', requests: ['w1891'], timed: { verdict: 'here', why: 'same machine', until } }, s2: { priority: 'urgent', requests: ['w1901'], exempt: 'release' } }, new Date(), false, undefined, timedAskMark(at('beast')));
  const s1 = readTimedAsk(root, 's1')!;
  assert.equal(s1.mark?.required, true);
  assert.equal(s1.verdict?.verdict, 'here');
  assert.equal(readTimedAsk(root, 's2')?.exempt, 'release');
  assert.equal(readTimedAsk(root, 'nobody')?.verdict, undefined);
  assert.equal(readTimedAsk(path.join(root, 'missing'), 's1'), undefined);
  // An older portal writes no mark: nothing is asked.
  writeBenchPriorities(root, { s1: { priority: 'normal', requests: ['w1891'] } });
  assert.equal(readTimedAsk(root, 's1')?.mark, undefined);
});

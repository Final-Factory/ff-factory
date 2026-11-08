// w3730: a person stops a machine's bench ticket from the dashboard or through their orchestrator (lothsahn, 2026-11-08:
// "Make sure that this situation can never happen again… get it fixed"). One rule says which tickets may be stopped
// (shared/benchStop.ts); BenchStops sends the daemon's bench_revoke with the person's name and tells the holding worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BENCH_STOP_REPEAT_MS, BenchStopError, BenchStops } from './benchStop.ts';
import { holderRevokeText } from './benchHolders.ts';
import { benchStopRefusal, benchStopWhy } from '../shared/benchStop.ts';
import type { BenchState, BenchTicketGlance, SessionInfo } from '../shared/types.ts';

const WORKER = 'a1b2c3d4e5f6a7b8';
const mine: BenchTicketGlance = { ticket: 't00000412', mode: 'exclusive', what: 'bench perf leg 3', session: WORKER, requests: ['w1243'], since: '2026-11-08T10:15:00Z' };
const editor: BenchTicketGlance = { ticket: 't00000089', mode: 'shared', what: 'editor boot', session: 'editor:slot1' };
const harness: BenchTicketGlance = { ticket: 't00000090', mode: 'shared', what: 'editor boot' };
const timed: BenchTicketGlance = { ticket: 't00000091', mode: 'exclusive', what: 'timed run w12 leg 1', session: WORKER };
const nightly: BenchTicketGlance = { ticket: 't00000088', mode: 'shared', what: 'nightly perf', session: 'nightly1', exempt: 'nightly' };
const release: BenchTicketGlance = { ticket: 't00000092', mode: 'exclusive', what: 'urgent release build', session: 'rel1', exempt: 'release', preempt: true };

function rig(over: { bench?: BenchState | undefined; online?: boolean; sessions?: string[]; sendThrows?: boolean } = {}) {
  const posts: { machine: string; msg: unknown }[] = [];
  const sent: { sid: string; text: string }[] = [];
  let now = Date.parse('2026-11-08T11:00:00Z');
  const bench: BenchState | undefined =
    'bench' in over ? over.bench : { mode: 'exclusive', running: [mine, editor, harness, timed, nightly, release], runningCount: 6, waiting: 1, waiters: [{ ticket: 't00000500', mode: 'shared', what: 'next leg', session: 'b0b0b0b0', ahead: 0 }] };
  const sessions = (over.sessions ?? [WORKER]).map((id) => ({ id }) as SessionInfo);
  const stops = new BenchStops({
    known: (id) => id === 'beast' || id === 'm3',
    machineIds: () => ['beast', 'm3'],
    online: (id) => id === 'beast' && over.online !== false,
    bench: (id) => (id === 'beast' ? bench : undefined),
    post: (machine, msg) => void posts.push({ machine, msg }),
    session: (sid) => sessions.find((s) => s.id.startsWith(sid)),
    send: (sid, text) => {
      if (over.sendThrows) throw new Error('not running');
      sent.push({ sid, text });
    },
    now: () => now,
  });
  return { stops, posts, sent, later: (ms: number) => void (now += ms) };
}

const refused = (fn: () => unknown, status: number, re: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof BenchStopError && e.status === status && re.test(e.message));

test("w3730: which tickets a person may stop: a worker's own, never an editor's, a timed run's, the nightly's or the release lane's", () => {
  assert.equal(benchStopRefusal(mine), undefined);
  assert.match(benchStopRefusal(editor)!, /editor's ticket \(a harness ticket\)/);
  assert.match(benchStopRefusal(harness)!, /editor's ticket/);
  assert.match(benchStopRefusal(timed)!, /timed run's leg .*timed_place cancel/);
  assert.match(benchStopRefusal(nightly)!, /the nightly's/);
  assert.match(benchStopRefusal(release)!, /urgent release lane's/);
  assert.match(benchStopRefusal({ ...mine, ticket: 'x1' })!, /not a bench ticket name/);
  assert.equal(benchStopWhy('Lothsahn', 'from the dashboard'), 'stopped by Lothsahn from the dashboard (w3730)');
});

test("w3730: a stop sends the machine's daemon bench_revoke with the person's name and tells the holding worker, once", () => {
  const { stops, posts, sent, later } = rig();
  const said = stops.stop('BEAST', 't00000412', 'Lothsahn', 'from the dashboard');
  assert.deepEqual(posts, [{ machine: 'beast', msg: { type: 'bench_revoke', ticket: 't00000412', session: WORKER, why: 'stopped by Lothsahn from the dashboard (w3730)' } }]);
  assert.match(said, /^Stopping beast's exclusive bench ticket t00000412 \("bench perf leg 3"\): beast's daemon writes its revoked file now/);
  assert.match(said, /Its worker a1b2c3d4 was told\.$/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sid, WORKER);
  assert.equal(sent[0].text, holderRevokeText('beast', mine, 'Lothsahn'));
  assert.match(sent[0].text, /^Bench lock \(w3730\): Lothsahn stopped your beast's exclusive bench ticket t00000412/);
  assert.match(sent[0].text, /Do not take a new ticket for this work until Lothsahn or your requester says so/);

  // A second press (the page, or a person and their orchestrator) does not send again while the first runs its course.
  later(60_000);
  assert.match(stops.stop('beast', 't00000412', 'Ben', 'through their orchestrator'), /was already asked to stop at 11:00Z/);
  assert.equal(posts.length, 1);
  assert.equal(sent.length, 1);
  later(BENCH_STOP_REPEAT_MS);
  stops.stop('beast', 't00000412', 'Ben', 'through their orchestrator');
  assert.equal(posts.length, 2, 'past the window, a ticket still reported is asked again');
});

test('w3730: a stop is refused with the reason: unknown machine, bad name, offline, no bench report, waiting, gone, harness and lane tickets', () => {
  const { stops, posts } = rig();
  refused(() => stops.stop('nowhere', 't00000412', 'L', 'x'), 404, /no machine "nowhere"/);
  refused(() => stops.stop('beast', '412', 'L', 'x'), 400, /not a bench ticket name/);
  refused(() => stops.stop('m3', 't00000412', 'L', 'x'), 409, /m3 is offline/);
  refused(() => stops.stop('beast', 't00000500', 'L', 'x'), 409, /not granted yet: it waits and holds nothing/);
  refused(() => stops.stop('beast', 't00000777', 'L', 'x'), 404, /beast holds no ticket t00000777 now: it may have ended already/);
  refused(() => stops.stop('beast', 't00000089', 'L', 'x'), 409, /editor's ticket/);
  refused(() => stops.stop('beast', 't00000091', 'L', 'x'), 409, /timed run's leg/);
  refused(() => stops.stop('beast', 't00000088', 'L', 'x'), 409, /the nightly's/);
  refused(() => stops.stop('beast', 't00000092', 'L', 'x'), 409, /urgent release lane's/);
  assert.equal(posts.length, 0, 'nothing refused reaches the daemon');
  refused(() => rig({ bench: undefined }).stops.stop('beast', 't00000412', 'L', 'x'), 409, /reports no bench queue/);
  const cut = rig({ bench: { mode: 'shared', running: [mine], runningCount: 9, waiting: 0 } });
  refused(() => cut.stops.stop('beast', 't00000999', 'L', 'x'), 404, /lists 1 of 9 holders/);
});

test('w3730: a ticket no worker of this portal holds is still stopped, and the answer says nobody was told', () => {
  const r = rig({ sessions: [] });
  assert.match(r.stops.stop('beast', 't00000412', 'L', 'x'), /No worker of this portal holds it \(session a1b2c3d4\), so nobody was told\.$/);
  assert.equal(r.posts.length, 1);
  const r2 = rig({ sendThrows: true });
  assert.match(r2.stops.stop('beast', 't00000412', 'L', 'x'), /could not be told now \(not running\)/);
  assert.equal(r2.posts.length, 1);
});

test('w3730: the list names only the tickets a person may stop, on one machine or every online one', () => {
  const { stops } = rig();
  const all = stops.list();
  assert.equal(all, 'Bench tickets that can be stopped on any online machine:\n- beast t00000412: exclusive, w1243, worker a1b2c3d4, held since 10:15Z: "bench perf leg 3"');
  assert.equal(stops.list('beast'), all.replace('any online machine', 'beast'));
  assert.match(stops.list('m3'), /^No worker's bench ticket can be stopped on m3 now/);
  refused(() => stops.list('nowhere'), 404, /no machine/);
});

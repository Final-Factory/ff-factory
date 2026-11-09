/**
 * w3843 bench: what holds the portal's event loop after a restart, with the real Store, SessionManager, MachineManager and
 * Agents over a synthetic production-sized data folder (every session ever kept, the ledger, released workers whose
 * resumes wait for room). Times the calls the 2026-11-09 stall profiles named: Agents.places, the release pass
 * (PlaceAgain.tick), SessionManager.drain (placeFull, roomMove, moveFacts) and the state snapshot's serialize, and counts
 * how often each drain recomputes places and the per-machine facts. Local only (CONTRIBUTING.md "Performance"):
 *
 *   node scripts/restart-lag-bench.ts [--sessions 15000] [--work 2000] [--queue 40] [--pressure 6] [--replay 20] [--json]
 *
 * --replay N: after the timed calls, N rounds of what follows a restart (a drain, the release pass, places(), a machine's
 * report reading workLive), each its own task, under a 20 ms beat like loopWatch.ts: prints the loop's worst lag.
 * --pressure: queued game requests waiting for a sandbox, so the release pass reads the room (PlaceAgain.reclaimPass).
 *
 * The portal VM's two shared vCPUs are slower than a workstation: read the numbers as a ratio.
 */
import { Agents } from '../server/agents.ts';
import { PlaceAgain } from '../server/placeAgain.ts';
import { useFakeVault } from '../server/testVault.ts';
import { restartScene } from './restartLagScene.ts';

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const N = arg('sessions', 15_000);
const W = arg('work', 2_000);
const Q = arg('queue', 40);
const P = arg('pressure', 6);
useFakeVault();

const log = console.log;
const warn = console.warn;
const quiet = () => {
  console.log = () => {};
  console.warn = () => {};
};
const loud = () => {
  console.log = log;
  console.warn = warn;
};
quiet();
const { store, sessions, agents, fleet, slots, released, NOW } = restartScene({ sessions: N, work: W, queue: Q, pressure: P });

// Count what one call does: places() recomputed, PlaceAgain.facts (one O(sessions) filter each), claims computed.
const callers = new Map<string, number>();
const counts = { places: 0, placesNow: 0, facts: 0, claims: 0 };
const wrap = (o: object, name: string, key: keyof typeof counts) => {
  const p = o as Record<string, (...a: unknown[]) => unknown>;
  const f = p[name];
  p[name] = function (this: unknown, ...a: unknown[]) {
    counts[key]++;
    // CALLERS=places (or facts, claims): which call paths ask, printed at the end.
    if (process.env.CALLERS === key) {
      const st = (new Error().stack ?? '').split('\n').slice(2, Number(process.env.DEPTH ?? 7)).map((l) => l.trim().replace(/^at /, '').replace(/ \(file:.*\/(server\/[^)]*)\)/, ' ($1)')).join(' < ');
      callers.set(st, (callers.get(st) ?? 0) + 1);
    }
    return f.apply(this, a);
  };
};
wrap(Agents.prototype, 'places', 'places');
wrap(Agents.prototype, 'placesNow', 'placesNow');
wrap(PlaceAgain.prototype, 'facts', 'facts');
wrap(PlaceAgain.prototype, 'claims', 'claims');
const timed = <T>(fn: () => T) => {
  for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] = 0;
  const t = performance.now();
  quiet();
  const out = fn();
  loud();
  return { ms: Math.round(performance.now() - t), ...counts, out };
};
const pa = (agents as unknown as { placeAgain: PlaceAgain }).placeAgain;
const places = timed(() => agents.places());
const tick = timed(() => pa.tick());
const drain = timed(() => sessions.drain(NOW));
const drain2 = timed(() => sessions.drain(NOW));
const ser = timed(() => JSON.stringify((store as unknown as { persisted: () => unknown }).persisted(), null, 2).length);
const result = {
  sessions: N,
  work: W,
  queued: Q,
  pressure: P,
  released: released.length,
  sandboxes: slots.length,
  places: { ms: places.ms, placesNow: places.placesNow, facts: places.facts },
  releasePass: { ms: tick.ms, places: tick.places, placesNow: tick.placesNow, facts: tick.facts, did: (tick.out as string[]).length },
  drain: { ms: drain.ms, places: drain.places, placesNow: drain.placesNow, facts: drain.facts, claims: drain.claims, sent: drain.out },
  drainAgain: { ms: drain2.ms, placesNow: drain2.placesNow, facts: drain2.facts },
  stateSerialize: { ms: ser.ms, mb: Math.round(((ser.out as number) / 1048576) * 10) / 10 },
};
if (process.argv.includes('--json')) log(JSON.stringify(result));
else {
  log(`${N} sessions, ${W} requests, ${slots.length} sandboxes on ${fleet.length} computers, ${released.length} released, ${Q} resumes waiting for room:`);
  log(`  places():          ${result.places.ms} ms (placesNow ${places.placesNow}, PlaceAgain.facts ${places.facts})`);
  log(`  release pass:      ${result.releasePass.ms} ms (places ${tick.places}, placesNow ${tick.placesNow}, facts ${tick.facts})`);
  log(`  drain (queue ${Q}):  ${result.drain.ms} ms (places ${drain.places}, placesNow ${drain.placesNow}, facts ${drain.facts}, claims ${drain.claims})`);
  log(`  drain again:       ${result.drainAgain.ms} ms (placesNow ${drain2.placesNow}, facts ${drain2.facts})`);
  log(`  state.json serialize: ${result.stateSerialize.ms} ms for ${result.stateSerialize.mb} MB`);
}
if (process.argv.includes('--replay')) {
  // The loop lag a client sees: a beat every 20 ms, late by however long the task in front of it held the loop.
  const R = arg('replay', 20);
  const BEAT = 20;
  let worst = 0;
  let last = performance.now();
  const beat = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last - BEAT);
    last = t;
  }, BEAT);
  const steps: [string, () => unknown][] = [
    ['drain', () => sessions.drain(NOW)],
    ['release pass', () => pa.tick()],
    ['places', () => agents.places()],
    ['workLive', () => agents.workLive()],
  ];
  const most = new Map<string, number>();
  quiet();
  for (let i = 0; i < R; i++)
    for (const [k, f] of steps) {
      await new Promise((r) => setTimeout(r, BEAT * 2));
      const t = performance.now();
      f();
      most.set(k, Math.max(most.get(k) ?? 0, performance.now() - t));
    }
  await new Promise((r) => setTimeout(r, BEAT * 2));
  loud();
  clearInterval(beat);
  log(`  replay, ${R} rounds: worst loop lag ${Math.round(worst)} ms; longest ${[...most].map(([k, v]) => `${k} ${Math.round(v)} ms`).join(', ')}`);
}
if (callers.size) for (const [k, v] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 12)) log(`  ${v} x ${k}`);
quiet();
agents.orchestrators.close();
sessions.stopAll();
process.exit(0);

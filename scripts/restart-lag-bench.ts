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
 * report reading workLive), each its own task, under a 20 ms beat like loopWatch.ts: prints the loop's worst lag. Then the
 * resume on connect (w3855): --resume K resumed orchestrators (default 6), each with an --mb M megabyte transcript (default 40),
 * sent one message each in one task as a daemon's turn end fans out to them; prints that task, the worst lag and when all launched.
 * --pressure: queued game requests waiting for a sandbox, so the release pass reads the room (PlaceAgain.reclaimPass).
 *
 * The portal VM's two shared vCPUs are slower than a workstation: read the numbers as a ratio.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { Agents } from '../server/agents.ts';
import { cliProjectsDir } from '../server/cliTranscript.ts';
import { sdkToolsNow } from '../server/keptTools.ts';
import * as sessionsModule from '../server/sessions.ts';
import { PlaceAgain } from '../server/placeAgain.ts';
import { useFakeVault } from '../server/testVault.ts';
import { restartScene } from './restartLagScene.ts';

const { setQueryForTesting } = sessionsModule;
// Absent before w3855 (the bench then measures the old start, which launched inside the task).
const launchesSettled = (sessionsModule as { launchesSettled?: () => Promise<void> }).launchesSettled;

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

  // w3855: the resume on connect. A daemon's first turn end after a restart fans out to every person's orchestrator in one task
  // (machines.ts onMessage -> Agents.onWorkerTurnEnd -> orchestrators.toPeople -> AgentSession.send -> start), each a resumed
  // conversation with a long Claude Code transcript and the real orchestrator tools. The agent process is a fake that spawns a
  // trivial child (the spawn the stall profile named), so what is timed is the portal's own work.
  const K = arg('resume', 6);
  const MB = arg('mb', 40);
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'resume-bench-'));
  const orch = [...store.sessions.values()].find((x) => x.kind === 'orchestrator')!;
  const base = agents.orchestratorOptions(orch);
  const tools = sdkToolsNow(base.mcpServers);
  const entries = [...tools].slice(0, 12).map(([name, v]) => ({ name, description: v.description, input_schema: v.input_schema }));
  const env = { ...(base.env ?? process.env), CLAUDE_CONFIG_DIR: dir };
  const project = path.join(cliProjectsDir(env), dir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  // A transcript of MB megabytes: assistant calls with usage (what rebuildMeter replays), a deferred_tools_record line every 200.
  const transcript = () => {
    const out: string[] = [];
    let size = 0;
    for (let i = 0; size < MB * 1048576; i++) {
      const l =
        i % 200 === 0
          ? JSON.stringify({ type: 'attachment', uuid: `r${i}`, attachment: { type: 'deferred_tools_record', entries } })
          : JSON.stringify({ type: 'assistant', uuid: `a${i}`, message: { id: `m${i}`, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x'.repeat(1500) }], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000 + i } } });
      out.push(l);
      size += l.length + 1;
    }
    return out.join('\n') + '\n';
  };
  const text = transcript();
  setQueryForTesting(((p: { options: Options }) => {
    spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }).unref();
    const ab = p.options.abortController!;
    const g = (async function* () {
      await new Promise((r) => ab.signal.addEventListener('abort', r));
    })();
    return Object.assign(g, { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => undefined });
  }) as never);
  const resumed = Array.from({ length: K }, (_, i) => {
    const sid = `bench-resume-${i}-${'0'.repeat(8)}`;
    fs.writeFileSync(path.join(project, `${sid}.jsonl`), text);
    const s = sessions.create({ kind: 'worker', title: `orchestrator ${i}`, permissionMode: 'bypassPermissions', options: () => ({ ...base, cwd: dir, env }) });
    s.info.sdkSessionId = sid;
    return s;
  });
  worst = 0;
  last = performance.now();
  const lag = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last - BEAT);
    last = t;
  }, BEAT);
  await new Promise((r) => setTimeout(r, BEAT * 2));
  quiet();
  const t0 = performance.now();
  for (const s of resumed) s.send('A worker ended its turn.', 'system');
  const fanOut = performance.now() - t0;
  // What the starts left to do after the task (w3855's launches; nothing before it).
  await (typeof launchesSettled === 'function' ? launchesSettled() : Promise.resolve());
  await new Promise((r) => setTimeout(r, BEAT * 3));
  const all = performance.now() - t0;
  loud();
  clearInterval(lag);
  log(`  resume on connect, ${K} orchestrators x ${MB} MB transcript: the fan-out task ${Math.round(fanOut)} ms; worst loop lag ${Math.round(worst)} ms; all launched in ${Math.round(all)} ms`);
  quiet();
  for (const s of resumed) s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (callers.size) for (const [k, v] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 12)) log(`  ${v} x ${k}`);
quiet();
agents.orchestrators.close();
sessions.stopAll();
process.exit(0);

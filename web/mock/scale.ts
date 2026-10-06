// The mock at a real portal's scale, for performance work (web/perf/bench.ts): thousands of stopped agents,
// a long orchestrator conversation, a big ledger, and live traffic from running agents.
//
//   MOCK_SCALE=7000            this many stopped workers besides the scenario's own (synthetic)
//   MOCK_TRANSCRIPT_EVENTS=8000  the orchestrator's conversation padded to this many events (synthetic)
//   MOCK_STATE_FILE=path       instead: a real portal's data/state.json (secrets stripped), its sessions added
//   MOCK_TRANSCRIPT_FILE=path  instead: a real transcript (.jsonl) as the orchestrator's conversation
//   MOCK_WORK_FILE=path        a real data/work.json, its items added to the ledger
//   MOCK_LIVE=<events/s>       running agents' tool calls and session updates at this rate (0: none)
import fs from 'node:fs';
import type { AppState, Machine, MachineSandbox, SessionInfo, TranscriptEvent, WorkItem } from '../../shared/types.ts';
import { localMachine } from './scenario.ts';
import type { World } from './scenario.ts';

const env = process.env;
const MIN = 60_000;

/** A small deterministic random (the same world on every run, so numbers compare). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS =
  'belt splitter desync fleet station miner lockstep heartbeat save fixture tutorial shader bloom camera drone recipe fabricator logistics junction power grid research reactor cargo turret enemy camp wave spawner audit peer join catch-up replay'.split(' ');

function sentence(r: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]);
  const s = out.join(' ');
  return s[0].toUpperCase() + s.slice(1) + '.';
}

function reply(r: () => number, i: number): string {
  // What an orchestrator's replies look like: a paragraph, a list, sometimes a code block or a table.
  const parts = [`**TL;DR:** ${sentence(r, 14)}`, '', sentence(r, 30), '', `- ${sentence(r, 8)}`, `- ${sentence(r, 10)} \`Assets/Scripts/FFSystems/Belt${i}.cs:${40 + i}\``, `- ${sentence(r, 6)}`];
  if (i % 3 === 0) parts.push('', '```bash', `git log --oneline -5 origin/develop`, `node --test server/belts.test.ts  # ${i}`, '```');
  if (i % 5 === 0) parts.push('', '| Leg | Before | After |', '|---|---|---|', `| p50 | ${i} ms | ${i % 7} ms |`, `| p95 | ${i * 2} ms | ${i % 11} ms |`);
  return parts.join('\n');
}

/** A sandbox as the portal's state.json held it before w510 (only what the mock carries over). */
interface LegacySandbox {
  id: string;
  branch: string;
  base: string;
  path: string;
  purpose: string;
  status: MachineSandbox['status'];
  statusDetail?: string;
  createdAt: string;
  unity?: { state?: string; pid?: number };
  git?: MachineSandbox['git'];
}

/** A scenario without a local machine (the fresh one) gets BEAST's, once real sandboxes are put on it. */
function addLocal(state: AppState, now: number): Machine {
  const m = localMachine(now);
  state.machines.unshift(m);
  return m;
}

/** The machine whose daemon runs on the portal's own host: its sandboxes are where most agents are. */
const localOf = (state: AppState): Machine | undefined => state.machines.find((m) => m.local);

/** Stopped workers, spread over the local machine's sandboxes and the other machines, as a portal collects them over weeks. */
function syntheticSessions(state: AppState, n: number, now: number): SessionInfo[] {
  const r = rng(7);
  const local = localOf(state);
  const sandboxes = (local?.sandboxes ?? []).map((s) => s.id);
  const machines = state.machines.filter((m) => !m.local).map((m) => m.id);
  const people = [
    { userId: 'ben', displayName: 'Ben' },
    { userId: 'lothsahn', displayName: 'Lothsahn' },
  ];
  const out: SessionInfo[] = [];
  for (let i = 0; i < n; i++) {
    // Most in one sandbox, as on a real portal (one there had 6,500 of its 7,200 agents), the rest spread out.
    const onMachine = machines.length && r() < 0.05;
    const at = new Date(now - (n - i) * 7 * MIN).toISOString();
    const who = people[i % people.length];
    const place = onMachine ? { machineId: machines[Math.floor(r() * machines.length)] } : { machineId: local?.id, machineSandbox: r() < 0.95 ? sandboxes[0] : sandboxes[Math.floor(r() * sandboxes.length)] };
    out.push({
      id: `z${i.toString(36).padStart(5, '0')}`,
      kind: 'worker',
      ...place,
      title: sentence(r, 6).slice(0, 60),
      status: 'stopped',
      model: 'opus',
      permissionMode: 'bypassPermissions',
      sdkSessionId: `sdk-${i}`,
      createdAt: at,
      lastActivityAt: at,
      turns: 1 + Math.floor(r() * 40),
      costUsd: Math.round(r() * 900) / 100,
      pendingPermissions: [],
      lastResult: sentence(r, 40),
      requestedBy: who,
      lastRequestedBy: who,
    });
  }
  return out;
}

/** The orchestrator's conversation: turns of a message in, tool calls, a reply and the turn's end. */
function syntheticTranscript(n: number, now: number): TranscriptEvent[] {
  const r = rng(11);
  const out: TranscriptEvent[] = [];
  let seq = 0;
  let turn = 0;
  const t = () => new Date(now - (n - seq) * 0.5 * MIN).toISOString();
  while (out.length < n) {
    turn++;
    out.push({ seq: ++seq, t: t(), kind: 'user', from: turn % 4 === 0 ? 'system' : 'human', text: sentence(r, 12 + (turn % 20)) } as TranscriptEvent);
    for (let k = 0; k < 2; k++) {
      const id = `tu${turn}-${k}`;
      out.push({ seq: ++seq, t: t(), kind: 'tool_use', toolUseId: id, name: k ? 'mcp__factory__list_agents' : 'Bash', input: { command: `git -C /work/${turn} status --short`, description: sentence(r, 4) } } as TranscriptEvent);
      out.push({ seq: ++seq, t: t(), kind: 'tool_result', toolUseId: id, isError: false, text: Array.from({ length: 12 }, () => sentence(r, 9)).join('\n') } as TranscriptEvent);
    }
    out.push({ seq: ++seq, t: t(), kind: 'assistant', text: reply(r, turn) } as TranscriptEvent);
    out.push({ seq: ++seq, t: t(), kind: 'result', ok: true, text: 'done', costUsd: 0.12, turns: 3, durationMs: 42_000 } as TranscriptEvent);
  }
  return out;
}

function readJsonl(file: string): TranscriptEvent[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TranscriptEvent);
}

/** Grows the scenario's world to the configured scale (nothing when no MOCK_* scale setting is set). */
export function scaleWorld(world: World, now = Date.now()) {
  const { state, transcripts } = world;
  const orch = state.orchestratorId;
  let extra: SessionInfo[] = [];
  if (env.MOCK_STATE_FILE) {
    // A state.json from before w510 holds the host's own `sandboxes` and its workers' `sandboxId`; they move to the local machine.
    const real = JSON.parse(fs.readFileSync(env.MOCK_STATE_FILE, 'utf8')) as { sessions?: SessionInfo[]; sandboxes?: LegacySandbox[] };
    const local = localOf(state) ?? addLocal(state, now);
    const localId = local.id;
    // Its orchestrators stay out: the page's own is the scenario's (with the real conversation, below).
    extra = (real.sessions ?? [])
      .filter((s) => s.kind !== 'orchestrator' && s.kind !== 'standing')
      .map((s) => {
        const { sandboxId, ...rest } = s;
        return { ...rest, ...(sandboxId ? { machineId: localId, machineSandbox: sandboxId } : {}), pendingPermissions: s.pendingPermissions ?? [] };
      });
    // Its sandboxes too, as they are (a sandbox the scenario also has is left to the scenario; its agents join it).
    for (const sb of real.sandboxes ?? [])
      if (!local.sandboxes!.some((x) => x.id === sb.id)) local.sandboxes!.push({ id: sb.id, branch: sb.branch, base: sb.base, path: sb.path, purpose: sb.purpose, status: sb.status, statusDetail: sb.statusDetail, createdAt: sb.createdAt, unity: { state: sb.unity?.state === 'running' || sb.unity?.state === 'starting' || sb.unity?.state === 'crashed' ? sb.unity.state : 'stopped', pid: sb.unity?.pid }, sessionIds: [], git: sb.git });
  } else if (Number(env.MOCK_SCALE) > 0) {
    extra = syntheticSessions(state, Number(env.MOCK_SCALE), now);
  }
  state.sessions.push(...extra);
  // Each place lists its agents by id (MachineSandbox.sessionIds, Machine.sessionIds), as the server keeps them.
  for (const s of extra) {
    const machine = s.machineId ? state.machines.find((x) => x.id === s.machineId) : undefined;
    machine?.sessionIds.push(s.id);
    if (s.machineSandbox) machine?.sandboxes?.find((x) => x.id === s.machineSandbox)?.sessionIds.push(s.id);
  }
  if (env.MOCK_TRANSCRIPT_FILE) transcripts[orch] = readJsonl(env.MOCK_TRANSCRIPT_FILE);
  else if (Number(env.MOCK_TRANSCRIPT_EVENTS) > 0) transcripts[orch] = syntheticTranscript(Number(env.MOCK_TRANSCRIPT_EVENTS), now);
  if (env.MOCK_WORK_FILE) {
    const w = JSON.parse(fs.readFileSync(env.MOCK_WORK_FILE, 'utf8')) as { items?: WorkItem[] } | WorkItem[];
    const items = Array.isArray(w) ? w : (w.items ?? []);
    state.work = [...(state.work ?? []), ...items];
  }
}

/**
 * Live traffic: running workers making tool calls. Each tick one running worker gets a tool call and its result
 * (two transcript events) and a session update, as the real server's store emits them.
 */
export function startLiveTraffic(world: World, broadcast: (ev: import('../../shared/types.ts').ServerEvent) => void, append: (sessionId: string, e: never) => TranscriptEvent) {
  const rate = Number(env.MOCK_LIVE);
  if (!(rate > 0)) return;
  const r = rng(3);
  let n = 0;
  setInterval(() => {
    const running = world.state.sessions.filter((s) => s.status === 'running' && s.kind === 'worker');
    if (!running.length) return;
    const s = running[Math.floor(r() * running.length)];
    const id = `live${++n}`;
    append(s.id, { kind: 'tool_use', toolUseId: id, name: 'Bash', input: { command: `ls -la /work/${n}`, description: 'List files' } } as never);
    append(s.id, { kind: 'tool_result', toolUseId: id, isError: false, text: sentence(r, 20) } as never);
    s.lastActivityAt = new Date().toISOString();
    s.activeTool = n % 2 ? { id, name: 'Bash', since: s.lastActivityAt } : undefined;
    broadcast({ type: 'session', session: s });
  }, 1000 / rate);
}

/**
 * w5222: where an agent's turns spent their wall time, from its persisted transcript (docs/orchestrators.md, "Turn timing").
 *
 * Each top-level event's `t` is when the portal persisted it (Store.append). Between two events the clock belongs to:
 * - **tools** while any tool call is still open (its tool_use seen, its tool_result not yet), split per tool by its own
 *   tool_use → tool_result time (parallel calls overlap, so the per-tool sums can exceed the wall share);
 * - **model** otherwise: the API call (time to first token and the output) and the SDK's own step overhead, which the
 *   transcript cannot tell apart (streaming deltas are not persisted).
 * A person's message that arrives mid-turn (its `t` is when the portal handed it to the session, server/sessions.ts send) is
 * measured to the turn's first assistant text after it ("person wait"), with the tool calls the turn started in between:
 * lothsahn's "What is w5194?" case (w5222). Subagent events (parentToolUseId) sit inside their Task call's tool time and are
 * left out of the walk.
 */
import type { TranscriptEvent } from '../shared/types.ts';

export interface ToolStat {
  calls: number;
  ms: number[];
}

export interface PersonWait {
  /** When the person's message reached the session. */
  at: string;
  /** Until the turn's first assistant text after it, or the turn's end when none came. */
  ms: number;
  /** Tool calls the turn started in between. */
  toolCalls: number;
  /** The words, cut short. */
  text: string;
}

export interface TurnTiming {
  start: string;
  end: string;
  wallMs: number;
  /** The SDK's own durationMs of the turn, when its result carried one. */
  sdkMs?: number;
  modelMs: number;
  toolMs: number;
  /** Model steps: one per API response (a run of assistant, thinking and tool_use events after a tool result or a message). */
  steps: number[];
  /** Characters the model wrote per step (text and tool input), the stand-in for output tokens. */
  stepChars: number[];
  tools: Record<string, ToolStat>;
  personWaits: PersonWait[];
  /** Messages from FF Factory (system, orchestrator) that arrived mid-turn and made it longer. */
  midTurnNotes: number;
  costUsd?: number;
}

const ms = (t: string) => Date.parse(t);
const charsOf = (e: TranscriptEvent) => (e.kind === 'assistant' || e.kind === 'thinking' ? e.text.length : e.kind === 'tool_use' ? JSON.stringify(e.input ?? '').length : 0);
const isModel = (e: TranscriptEvent) => e.kind === 'assistant' || e.kind === 'thinking' || e.kind === 'tool_use';
/** mcp__sandboxes__request_work → request_work */
export const shortToolName = (name: string) => name.replace(/^mcp__.+?__/, '');

/** The turns that end (a `result`) inside `events`, in order. A turn starts at the first event after the previous result. */
export function turnTimings(events: TranscriptEvent[]): TurnTiming[] {
  const out: TurnTiming[] = [];
  let cur: TranscriptEvent[] = [];
  let first = true;
  for (const e of events) {
    if ('parentToolUseId' in e && e.parentToolUseId) continue;
    cur.push(e);
    if (e.kind !== 'result') continue;
    // the window's first turn counts only when it opens on a message: one cut by the window's start would be split wrongly
    if (cur.length > 1 && !(first && cur[0].kind !== 'user')) out.push(timeTurn(cur));
    first = false;
    cur = [];
  }
  return out;
}

export function timeTurn(evs: TranscriptEvent[]): TurnTiming {
  const end = evs[evs.length - 1];
  const r: TurnTiming = { start: evs[0].t, end: end.t, wallMs: Math.max(0, ms(end.t) - ms(evs[0].t)), modelMs: 0, toolMs: 0, steps: [], stepChars: [], tools: {}, personWaits: [], midTurnNotes: 0 };
  if (end.kind === 'result') {
    if (end.durationMs) r.sdkMs = end.durationMs;
    r.costUsd = end.costUsd;
  }
  const open = new Map<string, { name: string; at: number }>();
  const waiting: { w: PersonWait; at: number }[] = [];
  let prev = ms(evs[0].t);
  let inStep = false;
  let stepStart = prev;
  let stepChars = 0;
  const closeStep = (at: number) => {
    if (!inStep) return;
    r.steps.push(at - stepStart);
    r.stepChars.push(stepChars);
    inStep = false;
  };
  for (let i = 1; i < evs.length; i++) {
    const e = evs[i];
    const now = ms(e.t);
    const gap = Math.max(0, now - prev);
    if (open.size) r.toolMs += gap;
    else r.modelMs += gap;
    if (isModel(e)) {
      if (!inStep) {
        // the step began when the clock last went to the model: the tool result or message before it
        inStep = true;
        stepStart = prev;
        stepChars = 0;
      }
      stepChars += charsOf(e);
    } else closeStep(prev);
    if (e.kind === 'tool_use') {
      open.set(e.toolUseId, { name: e.name, at: now });
      for (const p of waiting) p.w.toolCalls++;
    } else if (e.kind === 'tool_result') {
      const o = open.get(e.toolUseId);
      if (o) {
        open.delete(e.toolUseId);
        const stat = (r.tools[shortToolName(o.name)] ??= { calls: 0, ms: [] });
        stat.calls++;
        stat.ms.push(now - o.at);
      }
    } else if (e.kind === 'user') {
      if (e.from === 'human') {
        const w: PersonWait = { at: e.t, ms: 0, toolCalls: 0, text: e.text.slice(0, 80) };
        r.personWaits.push(w);
        waiting.push({ w, at: now });
      } else r.midTurnNotes++;
    } else if (e.kind === 'assistant' && e.text.trim()) {
      for (const p of waiting.splice(0)) p.w.ms = now - p.at;
    }
    prev = now;
  }
  closeStep(prev);
  for (const p of waiting) p.w.ms = ms(end.t) - p.at;
  return r;
}

export const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const sec = (n: number) => `${(n / 1000).toFixed(1)}s`;
const share = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '0%');
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** agent_transcript's answer with `timing: true`: a line per turn, then the window's totals, medians and worst cases. */
export function describeTurnTimings(turns: TurnTiming[], windowNote: string): string {
  if (!turns.length) return `No whole turn in ${windowNote} (a turn counts once its first message and its result are both in the window).`;
  const lines = [
    `Turn timing (w5222), ${turns.length} turn(s) in ${windowNote}. Measured from the transcript's event times (ms): model = the API call and the SDK's step overhead (time to first token is not stored); tools = any tool call open.`,
  ];
  for (const t of turns) {
    const top = Object.entries(t.tools)
      .map(([n, s]) => [n, sum(s.ms), s.calls] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n, total, calls]) => `${n} ${calls}x ${sec(total)}`)
      .join(', ');
    const waits = t.personWaits.map((w) => ` person waited ${sec(w.ms)} behind ${w.toolCalls} tool call(s) ("${w.text}")`).join(';');
    lines.push(
      `- ${t.start.slice(11, 19)}–${t.end.slice(11, 19)} wall ${sec(t.wallMs)}: model ${sec(t.modelMs)} (${share(t.modelMs, t.wallMs)}, ${t.steps.length} steps, median ${sec(percentile(t.steps, 50))}, ${sum(t.stepChars)} chars), tools ${sec(t.toolMs)} (${share(t.toolMs, t.wallMs)}${top ? `: ${top}` : ''})${t.midTurnNotes ? `, ${t.midTurnNotes} mid-turn note(s)` : ''}${t.costUsd !== undefined ? `, $${t.costUsd.toFixed(2)}` : ''}${waits ? `;${waits}` : ''}`,
    );
  }
  const wall = turns.map((t) => t.wallMs);
  const model = sum(turns.map((t) => t.modelMs));
  const tool = sum(turns.map((t) => t.toolMs));
  const total = sum(wall);
  const steps = turns.flatMap((t) => t.steps);
  const chars = turns.flatMap((t) => t.stepChars);
  lines.push('', `Totals: wall ${sec(total)}, model ${sec(model)} (${share(model, total)}), tools ${sec(tool)} (${share(tool, total)}). Turn wall median ${sec(percentile(wall, 50))}, p90 ${sec(percentile(wall, 90))}, worst ${sec(Math.max(...wall))}.`);
  if (steps.length) {
    // how much of a step its output explains: short writes against long ones
    const small = steps.filter((_, i) => chars[i] < 300);
    const big = steps.filter((_, i) => chars[i] >= 2000);
    const rate = sum(big) && sum(chars.filter((c) => c >= 2000)) ? Math.round(sum(chars.filter((c) => c >= 2000)) / (sum(big) / 1000)) : 0;
    lines.push(
      `Model steps: ${steps.length}, median ${sec(percentile(steps, 50))}, p90 ${sec(percentile(steps, 90))}, worst ${sec(Math.max(...steps))}; writing under 300 chars: median ${sec(percentile(small, 50))} (${small.length}); writing 2,000+ chars: median ${sec(percentile(big, 50))} (${big.length}${rate ? `, about ${rate} chars/s` : ''}).`,
    );
  }
  const byTool: Record<string, number[]> = {};
  for (const t of turns) for (const [n, s] of Object.entries(t.tools)) (byTool[n] ??= []).push(...s.ms);
  const rows = Object.entries(byTool).sort((a, b) => sum(b[1]) - sum(a[1]));
  if (rows.length) lines.push('Tools (calls, total, median, worst):', ...rows.slice(0, 15).map(([n, xs]) => `- ${n}: ${xs.length}, ${sec(sum(xs))}, ${sec(percentile(xs, 50))}, ${sec(Math.max(...xs))}`));
  const waits = turns.flatMap((t) => t.personWaits);
  if (waits.length) lines.push(`Person messages mid-turn: ${waits.length}, wait to the next answer median ${sec(percentile(waits.map((w) => w.ms), 50))}, worst ${sec(Math.max(...waits.map((w) => w.ms)))}.`);
  return lines.join('\n');
}

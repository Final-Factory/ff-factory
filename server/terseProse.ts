// Terse prose between tool calls, a pilot (w1480; docs/spend.md "Terse prose between tool calls"). lothsahn, 2026-10-18: "File it:
// measure the history, then pilot caveman and quieter tool output". Every model call reads the worker's whole conversation again,
// its own words included. Measured on beast's workers (2026-10-15..18, 52 sessions, 13.7k calls): the text a worker writes between
// tool calls is about 0.8% of what later calls re-read and 2.8% of its output tokens; its end-of-turn reports 0.5% and 3.5%.
// So this rule is small on its own; the pilot measures whether it also moves the rest of the output (thinking is 35%) and what it
// costs in readability. The rule covers only text between tool calls: reports and everything a person reads stay plain English.
// Pilot sessions are a share of worker sessions by a hash of the id, drawn apart from the compaction pilot's (autoCompact.ts
// inPilot), so the two can be told apart.
import type { Config } from './config.ts';
import { inPilot } from './autoCompact.ts';

/** The pilot's share of worker sessions, in percent, when worker.terseProsePilotPercent is not set. */
export const TERSE_PROSE_DEFAULT_PERCENT = 50;

/** Appended to a pilot worker's system prompt, after its Reporting rules. Its first line marks a pilot session in a transcript. */
export const TERSE_PROSE_RULE = `## Between tool calls (pilot)
Write nothing between routine tool calls. When something must be said, one short line: a finding, a change of plan, a warning. No recap of what a tool printed, no plan restated, no "Let me". Ids, paths, numbers and errors stay exact. This covers only text between tool calls: your end-of-turn report, PR descriptions, commit messages, DONE and still-open lines and anything else a person reads stay plain, full English under Reporting above.`;

/** The pilot's share in force (config worker.terseProsePilotPercent, 0-100; 0 is off). */
export function terseProsePercent(cfg: Partial<Pick<Config, 'worker'>>): number {
  const v = cfg.worker?.terseProsePilotPercent;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(100, v) : TERSE_PROSE_DEFAULT_PERCENT;
}

/** Whether this worker session writes terse prose between tool calls: a stable share of ids, apart from the compaction pilot's. */
export function inTerseProsePilot(sessionId: string, cfg: Partial<Pick<Config, 'worker'>>): boolean {
  return inPilot(`terse:${sessionId}`, terseProsePercent(cfg));
}

/** A worker's system prompt append: its brief, and the terse-prose rule when its session is in the pilot. */
export function withTerseProse(brief: string, sessionId: string, cfg: Partial<Pick<Config, 'worker'>>): string {
  return inTerseProsePilot(sessionId, cfg) ? `${brief}\n\n${TERSE_PROSE_RULE}` : brief;
}

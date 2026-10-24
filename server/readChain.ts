// The read-chain nudge's pilot arm (w2014; docs/spend.md "Read chains handed to a subagent, a pilot"). Half of worker sessions by
// default, by a hash of the session id drawn apart from the other pilots' (autoCompact.ts inPilot: the compaction pilot's
// `early:`, the terse-prose pilot's `terse:`), so each one's effect can be read apart. A pilot session's launch spec carries
// readChainNudge (the agent host adds the hook, server/readChainHook.ts) and its system prompt ends with READ_CHAIN_MARK, which
// marks the arm in its transcript (scripts/compact-compare.py --marker reads it).
import type { Config } from './config.ts';
import { inPilot } from './autoCompact.ts';

/** The pilot's share of worker sessions, in percent, when worker.readChainPilotPercent is not set. */
export const READ_CHAIN_DEFAULT_PERCENT = 50;

/** Appended to a pilot worker's system prompt: it marks the arm in the transcript. */
export const READ_CHAIN_MARK = '## Read chains (pilot)';

/** The pilot's share in force (config worker.readChainPilotPercent, 0-100; 0 is off). */
export function readChainPercent(cfg: Partial<Pick<Config, 'worker'>>): number {
  const v = cfg.worker?.readChainPilotPercent;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(100, v) : READ_CHAIN_DEFAULT_PERCENT;
}

/** Whether this worker session gets the read-chain nudge: a stable share of ids, apart from the other pilots'. */
export function inReadChainPilot(sessionId: string, cfg: Partial<Pick<Config, 'worker'>>): boolean {
  return inPilot(`readchain:${sessionId}`, readChainPercent(cfg));
}

/** A worker's system prompt append with the pilot's mark when its session is in the arm. */
export function withReadChainMark(brief: string, sessionId: string, cfg: Partial<Pick<Config, 'worker'>>): string {
  return inReadChainPilot(sessionId, cfg) ? `${brief}\n\n${READ_CHAIN_MARK}\nAfter five reads or searches in a row, a one-line note reminds you of the delegation rule.` : brief;
}

/**
 * w5885: a worker that builds ffu without a slot is told to wait for one (lothsahn: "Update instructions so workers block on
 * those slots instead of doing builds in temp directories to workaround and causing space issues").
 *
 * LothDesktop, 2026-11-25: five workers (w5478, w5475, w5589, w5775, w5788) built ffu in their temp folders while every slot was
 * held, as `ffu-slot take`'s old exit 3 told them to. This PostToolUse hook only warns (lothsahn's lockout rule: warn first,
 * enforce in a separate change): after a cargo build, test, check, clippy, run or bench that ran outside the machine's
 * ffu-sandboxes while the session holds no slot, the worker's next step carries FFU_SLOT_BUILD_NOTE, at most once per
 * FFU_SLOT_BUILD_NOTE_EVERY_MS. Machines with no ffu-sandboxes folder (no ffu-slot yet) are left alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { FFU_SLOTS_DIR, readSlotState } from '../machine/ffuSlots.ts';

/** How often one worker is told again (a guess: once per stretch of work, not on every leg). */
export const FFU_SLOT_BUILD_NOTE_EVERY_MS = 30 * 60_000;

export const FFU_SLOT_BUILD_NOTE =
  'w5885: that cargo command built ffu outside an ffu slot, and you hold none. Build ffu only in a slot: ' +
  '`eval "$(ffu-slot take --branch <your branch>)"`. If none is free (exit 4), wait for one (`ffu-slot take --wait 9 --branch ' +
  '<your branch>`, or a wake_me check-in, then take again); never build ffu in your temp folder or a clone of your own: their ' +
  'targets filled LothDesktop on 2026-11-25. A light clone with no cargo build is fine. (Warn-only for now; ff-factory docs/ffu-sandboxes.md.)';

const CARGO = /(?:^|[\s;&|(`'"])cargo(?:\.exe)?\s+(?:\+\S+\s+)?(?:build|test|check|clippy|run|bench|nextest)\b/;

const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Whether a command (run in cwd) builds with cargo outside the slot folder at slots. */
export function buildsOutsideSlots(cmd: string, cwd: string | undefined, slots: string): boolean {
  if (!CARGO.test(cmd)) return false;
  const s = key(slots);
  if (cwd && (key(cwd) === s || key(cwd).startsWith(s + '/'))) return false;
  // a command that names a slot (cd into it, its target) or sets one up builds there
  if (key(cmd).includes(s + '/') || /ffu-slot\s+(where|take)\b/.test(cmd)) return false;
  return true;
}

export interface FfuSlotBuildOpts {
  /** The machine's worker install folder (where ffu-sandboxes/ is). */
  root: string;
  /** The worker's session (a slot's holder). */
  session: string;
  now?: () => number;
}

/** The PostToolUse hook of one worker process (server/sessions.ts). */
export function ffuSlotBuildHook(o: FfuSlotBuildOpts): HookCallback {
  const slots = path.join(o.root, FFU_SLOTS_DIR);
  const now = o.now ?? Date.now;
  let last = -Infinity;
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return {};
    const cmd = (input.tool_input as { command?: unknown } | null)?.command;
    if (typeof cmd !== 'string' || !buildsOutsideSlots(cmd, input.cwd, slots)) return {};
    if (now() - last < FFU_SLOT_BUILD_NOTE_EVERY_MS) return {};
    try {
      if (!fs.existsSync(slots)) return {};
      if (readSlotState(o.root).slots.some((s) => s.holder === o.session)) return {};
    } catch {
      return {};
    }
    last = now();
    return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: FFU_SLOT_BUILD_NOTE } };
  };
}

// The temp folder size watch (w3686). Workers' temp folders (TMPDIR = <root>/tmp/ffa-<session>) grew to 36 GB each mid-run and filled
// machine disks; the clean-up passes only reach what is stale. This is the hook a worker's own process runs (server/sessions.ts
// AgentSession.start adds it): every TEMP_CHECK_EVERY_MS it measures its own folder, and over TEMP_WARN_BYTES the worker's next tool
// call carries one paragraph naming the biggest children, and `report` writes one line into its request's ledger log. Light on
// purpose: the walk runs beside the tool call, never in front of it.
import path from 'node:path';
import fs from 'node:fs';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { sizeOf } from './cleanup.ts';

/**
 * Over this the worker is told. Measured on LothDesktop 2026-11-08 16:44 UTC (w3686): 2 of 89 worker temp folders were above 15 GB
 * (a 36.5 GB and a 19.4 GB game clone with its Unity Library); the next was 7.3 GB, an FFU worker's cargo target, which the clean-up
 * already caps at 8 GB per worker (cargo-cap). So 15 GB flags a clone-with-Library or a runaway, not a normal worker.
 */
export const TEMP_WARN_BYTES = 15e9;

/** It says so again at each further step this size (a guess: one more clone or Library). */
export const TEMP_WARN_STEP_BYTES = 10e9;

/** The folder is measured at most this often (a guess: keeps the walk's disk cost small). */
export const TEMP_CHECK_EVERY_MS = 10 * 60_000;

/** Entries one child's walk may visit (a guess: a game clone with its Library holds some hundreds of thousands; sizeOf's own default is 2 million). */
export const TEMP_CHILD_BUDGET = 3_000_000;

/** How many of the biggest children the note names. */
const NAMED = 3;

export interface TempChild {
  name: string;
  bytes: number;
}
export interface TempMeasure {
  total: number;
  biggest: TempChild[];
}
/** What the hook reports once, with the note it gave the worker. */
export interface TempSizeReport extends TempMeasure {
  step: number;
  note: string;
}

/** Which warning step `total` is at: 0 under TEMP_WARN_BYTES, 1 from it, one more at each TEMP_WARN_STEP_BYTES. */
export function tempStep(total: number): number {
  return total >= TEMP_WARN_BYTES ? Math.floor((total - TEMP_WARN_BYTES) / TEMP_WARN_STEP_BYTES) + 1 : 0;
}

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/** The threshold, in GB, that warning step `step` (1 or more) stands for: 15, then 25, 35. */
const overGb = (step: number) => (TEMP_WARN_BYTES + (step - 1) * TEMP_WARN_STEP_BYTES) / 1e9;

/** The note for a folder at `total` bytes, or null while it is under the threshold or its step was already told (`warnedStep`). */
export function tempSizeNote(total: number, biggest: TempChild[], warnedStep: number): { note: string; step: number } | null {
  const step = tempStep(total);
  if (step <= warnedStep) return null;
  const over = overGb(step);
  const names = biggest.length ? `: biggest ${biggest.map((c) => `${c.name} ${gb(c.bytes)} GB`).join(', ')}` : '';
  return {
    step,
    note:
      `your temp folder ($TMPDIR) holds ${gb(total)} GB, over ${over} GB (w3686)${names}. Before you go on, delete what you no longer need, ` +
      'each with its path written out: rm -rf "$TMPDIR/<name>" (a delete under $TMPDIR asks nobody). Keep a clone that holds unpushed work; ' +
      'a Unity Library or a cargo target you still build in may stay.',
  };
}

/**
 * The request's ledger line for a 'tempSize' signal's `arg` (it crossed a machine link, so its shape is checked), or undefined when
 * it is not one.
 */
export function tempSizeLedgerLine(sessionId: string, arg: unknown): string | undefined {
  const a = arg as Partial<TempSizeReport> | null | undefined;
  if (!a || typeof a.total !== 'number' || typeof a.step !== 'number' || a.step < 1 || !Array.isArray(a.biggest)) return undefined;
  const names = a.biggest.filter((c) => c && typeof c.name === 'string' && typeof c.bytes === 'number').map((c) => `${c.name} ${gb(c.bytes)} GB`);
  return `worker ${sessionId.slice(0, 8)}: temp folder ${gb(a.total)} GB, over ${overGb(a.step)} GB (w3686)${names.length ? `: ${names.join(', ')}` : ''}`;
}

/** The bytes under each direct child of `dir` (a child that cannot be read counts 0), their sum, and the biggest children. */
export async function measureTemp(dir: string): Promise<TempMeasure> {
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    // gone or unreadable: nothing to count
  }
  const children: TempChild[] = [];
  // One after the other: a walk of a big clone is already a lot of disk reads.
  for (const name of names) {
    let bytes = 0;
    try {
      bytes = await sizeOf(path.join(dir, name), TEMP_CHILD_BUDGET);
    } catch {
      // counts 0
    }
    children.push({ name, bytes });
  }
  children.sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1));
  return { total: children.reduce((n, c) => n + c.bytes, 0), biggest: children.slice(0, NAMED) };
}

/**
 * The PostToolUse hook of one worker process, watching `dir`. A call starts a measurement when none runs and TEMP_CHECK_EVERY_MS
 * passed since the last start (the first call at once), and never waits for it. When a finished one says warn (tempSizeNote), the
 * next call returns the note as context, once, and calls `report`. A folder that shrank under a step is told again if it regrows.
 * A subagent's calls (agent_id set) neither start a measurement nor carry the note. `measure` is injectable for tests.
 */
export function tempSizeHook(
  dir: string,
  report: (r: TempSizeReport) => void,
  now: () => number = () => Date.now(),
  measure: (dir: string) => Promise<TempMeasure> = measureTemp,
): HookCallback {
  let lastStart = Number.NEGATIVE_INFINITY;
  let running = false;
  let warnedStep = 0;
  let pending: TempSizeReport | undefined;
  const start = () => {
    running = true;
    lastStart = now();
    void measure(dir).then(
      (m) => {
        running = false;
        warnedStep = Math.min(warnedStep, tempStep(m.total));
        const n = tempSizeNote(m.total, m.biggest, warnedStep);
        if (n) {
          warnedStep = n.step;
          pending = { ...m, ...n };
        }
      },
      () => {
        running = false;
      },
    );
  };
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse' || input.agent_id) return {};
    const told = pending;
    pending = undefined;
    if (!running && now() - lastStart >= TEMP_CHECK_EVERY_MS) start();
    if (!told) return {};
    try {
      report(told);
    } catch (e) {
      console.warn(`temp size: could not report: ${(e as Error).message}`);
    }
    return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: told.note } };
  };
}

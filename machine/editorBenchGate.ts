/**
 * w1628: an interactive editor's compiles, test runs and imports wait their turn in the machine's bench queue.
 *
 * lothsahn asked of #482 (build_plan no longer waiting for a free bench lock): "Won't builds use a ton of cpu and
 * invalidate runs?" A player build or batch run takes a shared ticket in the bench queue (w1615: unity-slot run, the game
 * repo's ff_unity_slot), so it never runs beside a timed leg. An editor that was already up did not: a worker's
 * `refresh_unity` or `run_tests` over the Unity MCP bridge compiled at once, beside whatever leg held the lock (one voided
 * a w1243 radius leg on BEAST, 2026-10-20 15:01 UTC: "build/compile processes 6.4 cores").
 *
 * This PreToolUse hook takes a shared ticket for the session's editor before a Unity MCP call that compiles, imports or
 * runs tests (EDITOR_LOAD_TOOL), and waits for it up to GATE_WAIT_MS inside the call. Granted: the call goes, and the
 * ticket is kept while the session keeps using its editor (any Unity MCP call, such as get_test_job polling, counts) and
 * let go GATE_IDLE_MS after the last. Still waiting: the call is refused with its place in line, and the ticket keeps
 * that place for GATE_KEEP_PLACE_MS, so the call made again goes as soon as its turn comes (first come, first served, as
 * lothsahn decided for w1615). No queue script or no python: the call goes (fail open, logged), as unity-slot run does.
 *
 * Deadlock: the hook holds nothing else while it waits, and waits at most GATE_WAIT_MS (Documentation/Bench-Lock.md in
 * the game repo: no long wait under the lock, one order).
 */
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { benchTicketFor, type TicketState } from './benchQueue.ts';
import { ownTimedHold } from './benchLock.ts';

/** Unity MCP tools that compile, import or run tests in the editor (mcp-for-unity's names). */
export const EDITOR_LOAD_TOOL =
  /^mcp__unitymcp__(?:refresh_unity|run_tests|execute_menu_item|create_script|delete_script|manage_script|script_apply_edits|apply_text_edits|manage_asset)$/i;
/** How long a call waits for its turn inside the hook (the hook's matcher allows GATE_HOOK_TIMEOUT_S). */
export const GATE_WAIT_MS = 150_000;
export const GATE_HOOK_TIMEOUT_S = 180;
/** A granted ticket is let go this long after the session's last Unity MCP call. */
export const GATE_IDLE_MS = 5 * 60_000;
/** A refused call's ticket keeps its place this long for the call made again. */
export const GATE_KEEP_PLACE_MS = 30 * 60_000;
/** A ticket granted while no call waited is kept this long for the call made again. */
export const GATE_GRANTED_UNUSED_MS = 2 * 60_000;

/**
 * One gate per sandbox and worker session in this process (the options are rebuilt per run). w2605: it was one per
 * sandbox, so a later worker placed in that sandbox reused the first one's gate, its tickets carried the first worker's
 * session (not the one that holds a timed ticket now), and a ticket granted to one session let another session's calls
 * through.
 */
const gates = new Map<string, ReturnType<typeof editorBenchGate>>();
/** A gate that holds no ticket and saw no call this long is closed and forgotten (one per session now, so they add up). */
export const GATE_FORGET_MS = 6 * 60 * 60_000;
export function editorBenchGateFor(o: EditorBenchGateOptions): ReturnType<typeof editorBenchGate> {
  const key = `${o.root ?? ''}|${o.sandboxPath}|${o.env?.FF_SESSION_ID ?? ''}`;
  for (const [k, old] of gates) {
    if (k !== key && old.idleMs() > GATE_FORGET_MS) {
      old.close();
      gates.delete(k);
    }
  }
  let g = gates.get(key);
  if (!g) gates.set(key, (g = editorBenchGate(o)));
  return g;
}

interface GateTicket {
  wait(ms?: number): Promise<TicketState>;
  state(): TicketState;
  release(): void;
}

export interface EditorBenchGateOptions {
  sandboxId: string;
  sandboxPath: string;
  /** The machine's worker install folder: the queue lives under <root>/tmp. Absent: no gate. */
  root?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** For tests: what takes a ticket (default benchTicketFor, a shared one). */
  ticketFor?: (what: string) => { ticket?: GateTicket; why?: string };
  log?: (line: string) => void;
  /** For tests: how long a call waits inside the hook. */
  waitMs?: number;
  /**
   * w2605: the granted exclusive (timed) ticket this gate's worker session holds, else undefined (default
   * machine/benchLock.ts ownTimedHold for env.FF_SESSION_ID). While it holds one, its own calls go without a ticket.
   */
  ownHold?: () => string | undefined;
}

export function editorBenchGate(o: EditorBenchGateOptions): { hook: HookCallback; tick(): void; close(): void; idleMs(): number } {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(`editor bench gate (${o.sandboxId}): ${l}`));
  const ownHold = o.ownHold ?? (() => ownTimedHold(o.root, o.env?.FF_SESSION_ID || undefined));
  const ticketFor =
    o.ticketFor ??
    ((what: string) => benchTicketFor({ mode: 'shared', what, checkouts: [o.sandboxPath], root: o.root, env: o.env, maxMin: 30 }));
  let ticket: GateTicket | undefined;
  let granted = false;
  let lastUse = 0;
  let lastAsk = 0;
  let lastCall = now();

  const drop = (why: string) => {
    if (!ticket) return;
    ticket.release();
    log(`let its ticket go: ${why}`);
    ticket = undefined;
    granted = false;
  };
  const tick = () => {
    if (!ticket) return;
    if (!granted && ticket.state().kind === 'granted') {
      // Its turn came while no call waited (it was refused and not made again yet): two minutes for that call, not
      // the whole idle time, so a ticket nobody uses does not hold timed legs back.
      granted = true;
      lastUse = now() - GATE_IDLE_MS + GATE_GRANTED_UNUSED_MS;
    }
    if (granted && now() - lastUse > GATE_IDLE_MS) drop(`no Unity MCP call for ${Math.round(GATE_IDLE_MS / 60_000)} minutes`);
    else if (!granted && now() - lastAsk > GATE_KEEP_PLACE_MS) drop('the refused call was not made again');
    else if (granted && ticket.state().kind === 'failed') drop(`its hold ended (${ticket.state().line})`);
  };
  const timer = setInterval(tick, 15_000);
  timer.unref?.();

  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || !o.root) return {};
    const tool = String(input.tool_name ?? '');
    if (!tool.toLowerCase().startsWith('mcp__unitymcp__')) return {};
    lastCall = now();
    if (ticket && granted) {
      lastUse = now();
      return {};
    }
    if (!EDITOR_LOAD_TOOL.test(tool)) return {};
    // w2605: the worker's own timed run. Its session holds the machine's running exclusive ticket, so no other timed leg
    // runs now and its own compile or test run can spoil only its own numbers. A shared ticket would wait behind that
    // exclusive one and refuse the call "Queued" (w2603: run_tests under t00000880). Other sessions still queue.
    const own = ownHold();
    if (own) {
      if (ticket && !granted) drop(`its session holds the timed ticket ${own}`);
      log(`its session holds the timed ticket ${own}; ${tool} goes ahead (w2605)`);
      return {};
    }
    if (!ticket) {
      const t = ticketFor(`editor compile/tests ${o.sandboxId}`);
      if (!t.ticket) {
        log(`no ticket (${t.why}); ${tool} goes ahead`);
        return {};
      }
      ticket = t.ticket;
    }
    lastAsk = now();
    const s = await ticket.wait(o.waitMs ?? GATE_WAIT_MS);
    if (s.kind === 'granted') {
      granted = true;
      lastUse = now();
      log(`${s.ticket} granted for ${tool}`);
      return {};
    }
    if (s.kind === 'failed') {
      log(`its ticket failed (${s.line}); ${tool} goes ahead`);
      ticket = undefined;
      return {};
    }
    const short = tool.replace(/^mcp__unitymcp__/i, '');
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason:
          `Queued (w1628): ${short} compiles, imports or runs tests in your editor, and this machine's bench queue has a ` +
          `timed run ahead of it (${s.line}). A compile beside a timed leg spoils its numbers, so your editor waits its turn; ` +
          `its place in line is kept for ${Math.round(GATE_KEEP_PLACE_MS / 60_000)} minutes. Do what needs no editor ` +
          `meanwhile, then call ${short} again (or wake_me 3 if nothing else is left): it goes as soon as its turn comes.`,
      },
    };
  };
  return {
    hook,
    tick,
    idleMs: () => (ticket ? 0 : now() - lastCall),
    close: () => {
      clearInterval(timer);
      drop('the session ended');
    },
  };
}

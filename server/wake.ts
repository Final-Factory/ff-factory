import fs from 'node:fs';
import type { SessionManager } from './sessions.ts';
import type { Store } from './store.ts';
import type { Sandbox, SessionInfo } from '../shared/types.ts';

const BUSY: SessionInfo['status'][] = ['running', 'starting', 'waiting_permission'];

/**
 * Timed wake-ups (docs: the wake_me tools). An agent that wants to check back later ends its turn;
 * after N minutes it gets a message with its own note. Plus the orchestrator's optional heartbeat:
 * while any worker is mid-turn, a short "who is busy" message every N minutes.
 * In memory: a server restart forgets pending wake-ups (the restart resumes busy sessions anyway).
 */
export class Waker {
  private readonly sessions: SessionManager;
  private readonly store: Store;
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; at: number; note: string }>();
  private lastBeat = 0;
  private busySince = 0;
  now: () => number = Date.now;

  constructor(sessions: SessionManager, store: Store) {
    this.sessions = sessions;
    this.store = store;
  }

  /** Message `sessionId` with `note` after `minutes` (one pending wake per session: a new one replaces it). */
  schedule(sessionId: string, minutes: number, note: string): string {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error('minutes must be between 1 and 1440');
    this.sessions.get(sessionId);
    this.cancel(sessionId);
    const at = this.now() + minutes * 60_000;
    const text = note.trim().slice(0, 2000);
    const timer = setTimeout(() => this.fire(sessionId), minutes * 60_000);
    timer.unref?.();
    this.timers.set(sessionId, { timer, at, note: text });
    return `I will message you at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${minutes} min) with your note. End your turn now; that message resumes you.`;
  }

  cancel(sessionId: string) {
    const t = this.timers.get(sessionId);
    if (!t) return false;
    clearTimeout(t.timer);
    this.timers.delete(sessionId);
    return true;
  }

  pending(sessionId: string) {
    const t = this.timers.get(sessionId);
    return t ? { at: new Date(t.at).toISOString(), note: t.note } : undefined;
  }

  private fire(sessionId: string) {
    const t = this.timers.get(sessionId);
    this.timers.delete(sessionId);
    if (!t || !this.sessions.sessions.has(sessionId)) return;
    try {
      this.sessions.send(sessionId, `[wake_me] Time is up. Your note: ${t.note || '(none)'}`, 'system');
    } catch (e) {
      // At the agent limit, or its machine is offline: say so where the user will see it.
      this.store.append(sessionId, { kind: 'system', text: `wake_me could not wake this session: ${(e as Error).message}` });
    }
  }

  // ---------------------------------------------------------------- the orchestrator's heartbeat

  /** Called every minute. Wakes the orchestrator with the busy list when a heartbeat is due. */
  heartbeat(orchestratorId: string | undefined, minutes: number | null | undefined, describe: (s: SessionInfo) => string) {
    const busy = [...this.store.sessions.values()].filter((s) => s.kind === 'worker' && BUSY.includes(s.status));
    const now = this.now();
    if (!busy.length) {
      this.busySince = 0;
      return;
    }
    if (!this.busySince) this.busySince = now;
    if (!minutes || !orchestratorId) return;
    const since = Math.max(this.lastBeat, this.busySince);
    if (now - since < minutes * 60_000) return;
    const orch = this.store.sessions.get(orchestratorId);
    if (!orch || BUSY.includes(orch.status)) return; // it is working already; next minute
    this.lastBeat = now;
    const lines = busy.map((s) => `- ${describe(s)}`);
    try {
      this.sessions.send(orchestratorId, `[heartbeat] ${busy.length} worker(s) busy:\n${lines.join('\n')}\nPost the user a one-line status (what each is doing, anything stuck or waiting on them). No tool calls needed unless something looks wrong.`, 'system');
    } catch {
      // the orchestrator could not be started; try at the next beat
    }
  }
}

/** One line per busy worker for the heartbeat: where, what, for how long, last word. */
export function describeBusy(s: SessionInfo, where: { sandbox?: Sandbox; machine?: string }, now = Date.now()): string {
  const place = where.sandbox ? `in ${where.sandbox.id}` : where.machine ? `on ${where.machine}` : '';
  const mins = Math.round((now - Date.parse(s.lastActivityAt)) / 60_000);
  const state = s.status === 'waiting_permission' ? 'WAITING FOR A PERMISSION' : `${s.status}${s.statusDetail ? ` (${s.statusDetail})` : ''}`;
  return `${s.id} "${s.title}" ${place}: ${state}, last activity ${mins} min ago, ${s.turns} turns, $${s.costUsd.toFixed(2)}`;
}

/**
 * Unity log markers for wait_for_unity. Unity 6 prints one of the "done" lines after every script
 * compile and domain reload, and the "failed" ones when the compile has errors.
 */
export const COMPILE_DONE = /Reloading assemblies after (?:successful|finishing) script compilation|Domain Reload Profiling|\*\*\* Tundra build success/;
export const COMPILE_FAILED = /error CS\d{4}|Scripts have compiler errors|\*\*\* Tundra build failed/;

/** Log text appended to `file` since byte `offset` (bounded to the last 2 MB). */
export function readSince(file: string, offset: number): { text: string; size: number } {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { text: '', size: 0 };
  }
  if (size < offset) offset = 0; // the log was rotated (editor restarted)
  const start = Math.max(offset, size - 2 * 1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), size };
  } finally {
    fs.closeSync(fd);
  }
}

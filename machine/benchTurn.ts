// A timed run's turn on its machine (w1829, docs/unity-lifecycle.md "The exclusive turn"). lothsahn, 2026-10-23: "When the
// exclusive lock is held, only that worker should be running. Players, editors, and other work should shutdown to allow for
// proper timing", and "The locking should be a positive control that manages the worker and it's slots". The bench queue
// (machine/benchQueue.ts) already keeps builds, batch compiles, editor boots, compiles and tests out of an exclusive turn,
// and the guard refuses new players and clips (w1750); what ran already kept running: other sandboxes' editors used 3 to 6
// cores through w1785's timed legs, whose quiet gate then never opened.
//
// So while another worker's exclusive ticket holds the machine's lock, the daemon closes every other sandbox's editor the
// way w1746 closes an idle one (machine/liveIdle.ts idleCloseEditor: out of play mode, scenes and assets saved through the
// editor, then quit; one compiling, importing or with an untitled dirty scene is left and tried again), and asks every
// other worker's game player to quit (its window's close, or SIGTERM: the game saves a running single-player game first,
// SaveGameManager.WaitForSaveBeforeQuit). Nothing is ever killed. When the ticket goes, by its release, its holder's death
// or the end of its hold bound, the editors it closed start again (a start takes a shared ticket, so they come back in the
// next shared turn) and their workers are told. The marks live in the pool's state file, so a daemon restart reopens them.
//
// Never touched: the holder's own sandbox and what its ticket's owner started, an editor the pool does not own (a person's
// own project) and a player no worker started (no slot, no session: a person's game).
import fs from 'node:fs';
import path from 'node:path';
import type { QueueTicket } from './benchQueue.ts';
import type { Proc } from './unity.ts';
import { run, type RunResult } from '../server/proc.ts';

export type Holder = QueueTicket & { until: number };

export interface TurnEditor {
  id: string;
  /** Up with its MCP bridge (the pool's `running`): the only state an editor can be closed cleanly from. */
  running: boolean;
  pid?: number;
}

export interface TurnPlayer {
  pid: number;
  session?: string;
  sandbox?: string;
  slot?: string;
}

export interface BenchTurnDeps {
  /** The timed run holding the lock now (machine/benchLock.ts timedHolder), or undefined. */
  holder(): Holder | undefined;
  editors(): TurnEditor[];
  /** The sandboxes whose editor a turn closed and that are not open again yet, and when (kept across daemon restarts). */
  closed(): { id: string; at: number }[];
  players(): TurnPlayer[];
  procs(): Promise<Proc[]>;
  /** Save and quit a sandbox's editor through the editor, and mark the sandbox closed for `by` (never a kill). */
  closeEditor(id: string, by: string): Promise<{ closed: boolean; text: string }>;
  /** Start a closed sandbox's editor again (it queues for its shared turn) and clear its mark; throws when it cannot. */
  reopenEditor(id: string): Promise<string>;
  /** Ask a player to quit (its window's close, SIGTERM); never forced. Answers what happened. */
  closePlayer(pid: number): Promise<string>;
  /** The note for a player's worker, given at its next message. */
  notePlayer?(session: string, text: string): void;
  /** The sandboxes closed now and why, for the guard's refusal of Unity MCP calls there; {} when no turn runs. */
  writeClosed(closed: Record<string, string>): void;
  log(text: string): void;
  now(): number;
}

/** A close that was skipped (compiling, an untitled scene) or a start that failed is tried again after this long. */
export const TURN_RETRY_MS = 30_000;
/** A player asked to quit is asked again after this long if it still runs (the game saves first; then it is left and logged). */
export const PLAYER_ASK_AGAIN_MS = 2 * 60_000;

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + 'Z';

/** Who holds the turn, for people: "a timed run on lothdesktop/slot3 (w1785)". */
export function holderText(h: Pick<QueueTicket, 'host' | 'sandbox' | 'requests' | 'session' | 'pid'>): string {
  const where = [h.host, h.sandbox].filter(Boolean).join('/') || (h.session ? `worker ${h.session}` : `pid ${h.pid}`);
  return `a timed run on ${where}${h.requests?.length ? ` (${h.requests.join(', ')})` : ''}`;
}

/** The sandbox line's and the panel's detail for an editor a turn closed. */
export function closedDetail(by: string, until?: number): string {
  return `closed for ${by}; reopens when it ends${until ? ` (by ${hhmm(until)} at the latest)` : ''}`;
}

/** What a worker hears when it calls its Unity editor while a turn keeps it closed (the guard's refusal). */
export function closedRefusal(by: string, at: number, until: number): string {
  return (
    `Your sandbox's Unity editor was closed at ${hhmm(at)} for ${by} (w1829: while another worker's exclusive bench ticket ` +
    `times a run, nothing else runs on this machine). Its scenes and assets were saved first; anything in play mode is gone. ` +
    `FF Factory starts it again when that run ends, by ${hhmm(until)} at the latest, in the next shared turn. Do what needs no ` +
    `editor meanwhile, or wake_me in 10 minutes; mcp__machine__unity status says when it is up.`
  );
}

/** Whether `pid` is `root` or started under it (by the listing's parent pids). */
export function descendsFrom(pid: number, root: number | undefined, procs: Pick<Proc, 'pid' | 'ppid'>[]): boolean {
  if (!root) return false;
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  let cur: number | undefined = pid;
  for (let i = 0; cur && i < 64; i++) {
    if (cur === root) return true;
    cur = parent.get(cur);
  }
  return false;
}

export class BenchTurn {
  private readonly d: BenchTurnDeps;
  private ticking = false;
  /** The turn seen last (its ticket), so its start and end are logged once. */
  private current?: string;
  private readonly closing = new Set<string>();
  /** When a close was skipped or a reopen failed, per sandbox: tried again after TURN_RETRY_MS. */
  private readonly retryAt = new Map<string, number>();
  private readonly asked = new Map<number, number>();
  /** What the guard's file says now, as JSON, so it is written only when it changes. */
  private written?: string;

  constructor(d: BenchTurnDeps) {
    this.d = d;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } catch (e) {
      this.d.log(`bench turn: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async step() {
    const now = this.d.now();
    const h = this.d.holder();
    if (h?.ticket !== this.current) {
      if (h) this.d.log(`bench turn: ${h.ticket} granted to ${holderText(h)}: closing the other editors and players here until it ends (by ${hhmm(h.until)} at the latest)`);
      else this.d.log(`bench turn: ${this.current} ended: reopening the editors it closed`);
      this.current = h?.ticket;
      this.asked.clear();
    }
    if (!h) {
      this.write({});
      for (const { id } of this.d.closed()) {
        if ((this.retryAt.get(id) ?? 0) > now) continue;
        try {
          const text = await this.d.reopenEditor(id);
          this.retryAt.delete(id);
          this.d.log(`bench turn: sandbox ${id}: its editor starts again: ${text}`);
        } catch (e) {
          this.retryAt.set(id, now + TURN_RETRY_MS);
          this.d.log(`bench turn: sandbox ${id}: its editor could not start again yet (tried again in ${TURN_RETRY_MS / 1000} s): ${(e as Error).message}`);
        }
      }
      return;
    }
    const by = holderText(h);
    const procs = await this.d.procs().catch(() => [] as Proc[]);
    const holderOwns = (pid: number | undefined) => pid !== undefined && descendsFrom(pid, h.ownerPid, procs);
    for (const e of this.d.editors()) {
      if (e.id === h.sandbox || !e.running || this.closing.has(e.id) || holderOwns(e.pid)) continue;
      if ((this.retryAt.get(e.id) ?? 0) > now) continue;
      this.closing.add(e.id);
      // Each close runs on its own: one leaving play mode takes up to 90 s, and the others need not wait for it.
      void this.d
        .closeEditor(e.id, by)
        .then(
          (r) => {
            this.d.log(`bench turn: sandbox ${e.id}: editor ${r.text}`);
            if (!r.closed) this.retryAt.set(e.id, this.d.now() + TURN_RETRY_MS);
          },
          (err) => {
            this.retryAt.set(e.id, this.d.now() + TURN_RETRY_MS);
            this.d.log(`bench turn: sandbox ${e.id}: could not close its editor: ${(err as Error).message}`);
          },
        )
        .finally(() => this.closing.delete(e.id));
    }
    for (const p of this.d.players()) {
      if (!p.slot && !p.session) continue; // a person's own game
      if ((h.sandbox && p.sandbox === h.sandbox) || (h.session && p.session === h.session) || holderOwns(p.pid)) continue;
      const last = this.asked.get(p.pid);
      if (last !== undefined && now - last < PLAYER_ASK_AGAIN_MS) continue;
      this.asked.set(p.pid, now);
      const said = await this.d.closePlayer(p.pid).catch((err) => `could not be asked to quit: ${(err as Error).message}`);
      const who = [p.sandbox, p.session && `worker ${p.session}`, p.slot && `slot ${p.slot}`].filter(Boolean).join(', ');
      this.d.log(`bench turn: player pid ${p.pid} (${who}): ${last === undefined ? 'asked to quit' : 'still runs, asked to quit again'}: ${said}`);
      if (p.session && last === undefined)
        this.d.notePlayer?.(p.session, `[bench turn] Your game player (pid ${p.pid}) was asked to quit at ${hhmm(now)} for ${by} (w1829: while another worker's exclusive bench ticket times a run, nothing else runs on this machine). A running single-player game saves first. Start it again after that run (player_slots.py --bench-wait waits for it).`);
    }
    const marks: Record<string, string> = {};
    for (const c of this.d.closed()) marks[c.id] = closedRefusal(by, c.at, h.until);
    this.write(marks);
  }

  private write(marks: Record<string, string>) {
    const j = JSON.stringify(marks);
    if (j === this.written) return;
    this.written = j;
    this.d.writeClosed(marks);
  }
}

/**
 * Ask a game player to quit the way a person closes it, never by force: on Windows `taskkill /PID` without /F, which posts
 * WM_CLOSE to its windows (a window-less player cannot be asked and is left running), elsewhere SIGTERM. The game saves a
 * running single-player game before it goes (SaveGameManager.WaitForSaveBeforeQuit, w1313).
 */
export async function askPlayerToQuit(pid: number, platform: NodeJS.Platform, runner: (cmd: string, args: string[]) => Promise<RunResult> = (c, a) => run(c, a, { timeoutMs: 30_000 })): Promise<string> {
  if (platform === 'win32') {
    const r = await runner('taskkill', ['/PID', String(pid)]);
    const said = `${r.stdout} ${r.stderr}`.replace(/\s+/g, ' ').trim().slice(0, 200);
    return r.code === 0 ? `its window was asked to close (${said})` : `left running: it could not be asked to close (${said})`;
  }
  try {
    process.kill(pid, 'SIGTERM');
    return 'sent SIGTERM';
  } catch (e) {
    return `left running: ${(e as Error).message}`;
  }
}

/** The guard's file of sandboxes a turn keeps closed: <root>/tmp/bench.queue/closed.json, {sandbox: refusal}. */
export const closedFile = (root: string) => path.join(root, 'tmp', 'bench.queue', 'closed.json');

/** Write it whole (a reader never sees half a file); errors are logged by the caller's log, never thrown. */
export function writeClosedFile(root: string, marks: Record<string, string>, log: (t: string) => void = () => undefined) {
  const file = closedFile(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marks));
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`bench turn: could not write ${file}: ${(e as Error).message}`);
  }
}

/** The refusal for a Unity MCP call into this sandbox's editor while a turn keeps it closed, or undefined. */
export function closedRefusalFor(root: string | undefined, sandbox: string): string | undefined {
  if (!root) return undefined;
  try {
    const marks = JSON.parse(fs.readFileSync(closedFile(root), 'utf8')) as Record<string, unknown>;
    const t = marks[sandbox];
    return typeof t === 'string' && t ? t : undefined;
  } catch {
    return undefined;
  }
}

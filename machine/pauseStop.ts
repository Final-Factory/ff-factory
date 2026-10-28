/**
 * What a paused machine's daemon ends itself (w2443). lothsahn, 2026-10-27: "Pausing a machine should stop existing runs on
 * that machine. They should terminate in a minute or two." and "The worker harness should be authoritative and if the worker
 * is nonresponsive, should kill the worker after a few minutes. There's no way it should keep running".
 *
 * The portal asks first (server/machinePause.ts): its workers are told to push and stop at once, interrupted at 60 s and
 * stopped at 75 s. The daemon does not rely on that, nor on the portal being reachable:
 *
 * - at the pause: every timed run here (machine/timedRunner.ts) is cancelled, its player ended and its bench ticket freed, and
 *   its worker told by the portal ("cancelled: <machine> was paused ..."); a timed run that arrives while paused is refused;
 * - PAUSE_EDITOR_CLOSE_MS (60 s) after it, when the portal interrupts its workers' turns: every sandbox's Unity editor is
 *   asked to quit (SIGTERM or WM_CLOSE, forced after 30 s). On LothLaptop's live check (2026-10-28, lothsahn: "I paused it
 *   and it took a while to close") the editor was first asked at 90 s and gone at 123 s;
 * - PAUSE_DAEMON_KILL_MS (90 s) after it, all at once: every worker's agent host still running is ended with its whole process
 *   tree (Windows: taskkill /T /F; a Mac or Linux: its process group and every descendant, SIGKILL; machine/hostWatch.ts
 *   killTree), every sandbox editor still up is force-killed, and every process FF Factory started that is left (game players,
 *   batch Unity, builds, servers, shells; machine/leftovers.ts) is ended with no grace. These ran one after another before, so
 *   on that check the player waited behind the editor's 30 s grace (gone at 117 s);
 * - then again every PAUSE_RESWEEP_MS while it stays paused, so nothing started meanwhile keeps running.
 *
 * Processes FF Factory did not start (a person's own game from Steam, Roblox, the main clone's editor) are never touched: the
 * leftover reaper ends only processes that carry a worker's FF_SESSION_ID, a player slot lease or a worker's temp folder, and
 * the editors closed are the sandboxes' own.
 */

export const PAUSE_EDITOR_CLOSE_MS = 60_000;
export const PAUSE_DAEMON_KILL_MS = 90_000;
export const PAUSE_RESWEEP_MS = 15_000;

export interface PauseStopDeps {
  machineId: string;
  /** The timed runs here, queued or running (TimedRunner.active). */
  timedRuns(): string[];
  /** Cancel one (TimedRunner.cancel): its player ended, its ticket released, the portal told. */
  cancelTimed(id: string, why: string): void;
  /** The worker sessions whose agent host runs here. */
  liveSessions(): string[];
  /** End a session now, its whole process tree (HostedSession.endNow). */
  endSession(id: string, why: string): Promise<void>;
  /** The sandboxes whose editor is up. */
  editors(): string[];
  /** Close a sandbox's editor (SandboxPool.unity stop): asked to quit first, or force-killed at once with `force`. */
  closeEditor(id: string, why: string, force: boolean): Promise<string>;
  /** End every process FF Factory started that is left, now (LeftoverReaper with pauseEnds set): what it ended, in words. */
  endLeftovers(): Promise<string[]>;
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  log(line: string): void;
  /** One line to the portal's sandbox events (the dashboard), when something was ended. */
  event?(text: string): void;
}

export class PauseStop {
  private since?: number;
  private why = '';
  private timer?: { cancel(): void };
  private editorTimer?: { cancel(): void };
  private sweeping?: Promise<void>;
  private readonly d: PauseStopDeps;

  constructor(d: PauseStopDeps) {
    this.d = d;
  }

  /** Paused since (ms), or undefined while it runs. */
  get pausedSince(): number | undefined {
    return this.since;
  }

  /** Why its leftovers end now: set once the deadline passed, while paused (LeftoverDeps.pauseEnds). */
  endsNow(): string | undefined {
    return this.since !== undefined && this.d.now() - this.since >= PAUSE_DAEMON_KILL_MS ? `${this.d.machineId} was paused from its tray app` : undefined;
  }

  /** A timed run that arrives while paused is refused with this; undefined while it runs. */
  refuseTimed(): string | undefined {
    return this.since !== undefined ? `cancelled: ${this.why}` : undefined;
  }

  /** The pause's state, on every change the PauseKeeper reports (and at the daemon's start): acts on its edges only. */
  update(paused: boolean, detail: string) {
    if (paused && this.since === undefined) this.paused(detail);
    else if (!paused && this.since !== undefined) this.unpaused();
  }

  private paused(detail: string) {
    this.since = this.d.now();
    this.why = `${this.d.machineId} was paused from its tray app (${detail}) (w2443): FF Factory stops what runs there`;
    const runs = this.d.timedRuns();
    this.d.log(`pause (w2443): ${this.d.machineId} paused (${detail}): ${runs.length ? `timed run(s) ${runs.join(', ')} cancelled; ` : ''}every worker, editor and player FF Factory started here ends in ${PAUSE_DAEMON_KILL_MS / 1000} s if still running`);
    for (const id of runs) this.d.cancelTimed(id, this.why);
    this.editorTimer = this.d.setTimer(() => {
      this.editorTimer = undefined;
      if (this.since !== undefined) void this.closeEditors(false);
    }, PAUSE_EDITOR_CLOSE_MS);
    this.arm(PAUSE_DAEMON_KILL_MS);
  }

  private unpaused() {
    this.d.log(`pause (w2443): ${this.d.machineId} runs again after ${Math.round((this.d.now() - this.since!) / 1000)} s paused`);
    this.since = undefined;
    this.timer?.cancel();
    this.timer = undefined;
    this.editorTimer?.cancel();
    this.editorTimer = undefined;
  }

  /** Close every sandbox editor that is up (asked to quit, or force-killed): what was done, in words. */
  private async closeEditors(force: boolean): Promise<string[]> {
    const why = this.endWhy();
    const done: string[] = [];
    await Promise.all(
      this.d.editors().map((id) =>
        this.d.closeEditor(id, why, force).then(
          (r) => void done.push(`editor of ${id} closed (${r.split('\n')[0]})`),
          (e) => void done.push(`editor of ${id}: closing it failed: ${(e as Error).message}`),
        ),
      ),
    );
    if (!force && done.length) {
      this.d.log(`pause (w2443): ${done.join('; ')}`);
      this.d.event?.(`Paused (w2443): ${done.join('; ')}`);
    }
    return done;
  }

  private endWhy() {
    return `Ended by FF Factory: ${this.d.machineId} was paused from its tray app ${Math.round((this.d.now() - this.since!) / 1000)} s ago and it still ran (w2443)`;
  }

  private arm(ms: number) {
    this.timer?.cancel();
    this.timer = this.d.setTimer(() => {
      this.timer = undefined;
      if (this.since === undefined) return;
      void this.sweep().finally(() => {
        if (this.since !== undefined) this.arm(PAUSE_RESWEEP_MS);
      });
    }, ms);
  }

  /** End everything FF Factory runs here now. Exposed for the tests; the timer calls it at the deadline and after. */
  sweep(): Promise<void> {
    this.sweeping ??= this.run().finally(() => (this.sweeping = undefined));
    return this.sweeping;
  }

  private async run() {
    if (this.since === undefined) return;
    const why = this.endWhy();
    const done: string[] = [];
    for (const id of this.d.timedRuns()) {
      this.d.cancelTimed(id, this.why);
      done.push(`timed run ${id} cancelled`);
    }
    const sessions = this.d.liveSessions();
    // All at once: a player must not wait behind an editor's close (w2443's live check on LothLaptop, 2026-10-28).
    await Promise.all([
      ...sessions.map((id) =>
        this.d.endSession(id, why).then(
          () => void done.push(`worker ${id} ended with its process tree`),
          (e) => void done.push(`worker ${id}: ending it failed: ${(e as Error).message}`),
        ),
      ),
      this.closeEditors(true).then((r) => void done.push(...r)),
      (async () => {
        // Twice: the reaper ends a process only once two looks have seen it (one odd listing never ends anything).
        for (let i = 0; i < 2; i++) {
          try {
            done.push(...(await this.d.endLeftovers()));
          } catch (e) {
            done.push(`leftovers: ${(e as Error).message}`);
          }
        }
      })(),
    ]);
    if (!done.length) return;
    this.d.log(`pause (w2443): ${done.join('; ')}`);
    this.d.event?.(`Paused (w2443): ${done.join('; ')}`);
  }
}

/**
 * Several failed child starts in a row (w6784, warn-only). On BEAST on 2026-11-28 agent hosts failed to start three
 * times (07:32:15, 07:34:50, 07:37:32Z) and `uv cache prune` timed out on its lock (07:29:19Z) before the daemon froze at
 * 07:41:20Z: process creation was stalling across the machine (ben and lothsahn asked for this early warning). The
 * daemon counts its agent hosts' starts across all sandboxes; STREAK failures in a row without one success log one
 * warning line, and a success after a warning says the streak ended. It only logs: nothing is restarted or refused.
 */

export const START_STREAK = 3;

export type StreakNote = string | undefined;

export class StartStreak {
  private fails: { what: string; why: string; at: number }[] = [];
  private warned = false;
  private count = 0;

  private readonly n: number;
  private readonly now: () => number;

  constructor(n = START_STREAK, now: () => number = Date.now) {
    this.n = n;
    this.now = now;
  }

  /** A child that did not start: answers the warning line to log when this failure makes the streak. */
  failed(what: string, why: string): StreakNote {
    this.fails.push({ what, why, at: this.now() });
    // A streak of days stays small: the first failure (its time) and the latest ones are what the line names.
    if (this.fails.length > 50) this.fails.splice(1, 1);
    this.count++;
    if (this.count < this.n) return undefined;
    const first = this.fails[0];
    const span = Math.round((this.now() - first.at) / 1000);
    const whats = [...new Set(this.fails.map((f) => f.what))].join(', ');
    const line =
      `early warning (w6784, warn-only): ${this.count} child starts failed in a row over ${span} s (${whats}); ` +
      `the last: ${why}. Process creation on this machine may be stalling (BEAST froze minutes after such a run); ` +
      `nothing was restarted.`;
    if (!this.warned) {
      this.warned = true;
      return line;
    }
    // Once warned, one more line every n further failures, so a long streak is not silent but does not flood.
    return this.count % this.n === 0 ? line : undefined;
  }

  /** A child that started: ends the streak, and answers a line when it had warned. */
  started(what: string): StreakNote {
    const had = this.count;
    this.count = 0;
    const warned = this.warned;
    this.fails = [];
    this.warned = false;
    return warned ? `early warning cleared (w6784): ${what} started after ${had} failed starts in a row` : undefined;
  }
}

/** The daemon's one counter, shared by every sandbox's agent hosts. */
export const childStarts = new StartStreak();

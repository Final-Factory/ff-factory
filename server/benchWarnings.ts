// A bench-queue holder's turn warning, sent to its worker as a message (w1832). The game repo's bench_queue.py warns a
// holder five minutes before its turn ends (another worker waits behind it, or an urgent release takes the machine); the
// daemon reports the warning with its stats (machine/benchWarnings.ts) and this sends it once per ticket and deadline.
// lothsahn, 2026-10-23: "At 25 minutes, the holder gets a warning it will actually see, both in its command output and
// as a message to the worker"; "Workers should be encouraged to push their uncommitted work at the warning threshold so
// they can be scheduled on other machines".
import type { BenchWarning, SessionInfo } from '../shared/types.ts';

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + 'Z';

/** The message a warned worker gets. */
export function benchWarningText(machineId: string, w: BenchWarning, now = Date.now()): string {
  const mins = Math.max(0, Math.round((w.deadline - now) / 60_000));
  const where = w.branch
    ? ` Your checkout is on ${w.branch} with ${w.dirty ?? 0} uncommitted file${w.dirty === 1 ? '' : 's'} and ${w.unpushed === undefined ? 'no upstream (never pushed)' : `${w.unpushed} unpushed commit${w.unpushed === 1 ? '' : 's'}`}.`
    : '';
  return [
    `Bench lock warning (w1832): your ${w.mode} ticket ${w.ticket} on ${machineId} ("${w.what.slice(0, 120)}") ends at ${hhmm(w.deadline)}, in ${mins} min: ${w.why || 'another worker waits'}.`,
    `Commit and push your work-in-progress branch now, so the work can go on on another machine if this turn ends.${where}`,
    w.release
      ? 'An urgent release takes the machine then: its build has no cap, so run your leg again after it is done.'
      : 'Finish or checkpoint the leg or build by then. At that time the ticket is revoked and what runs under it is stopped; for more, take a new ticket: it goes to the back of the queue.',
  ].join(' ');
}

export interface BenchWarnerDeps {
  session: (id: string) => SessionInfo | undefined;
  send: (sessionId: string, text: string) => void;
  log?: (line: string) => void;
  now?: () => number;
}

/** Sends each warning once: a ticket warned again with a new deadline (a new waiter after a cancel) is a new message. */
export class BenchWarner {
  private readonly sent = new Map<string, number>();
  private readonly d: BenchWarnerDeps;

  constructor(d: BenchWarnerDeps) {
    this.d = d;
  }

  handle(machineId: string, warnings: BenchWarning[]): void {
    const now = this.d.now?.() ?? Date.now();
    for (const [k, at] of this.sent) if (now - at > 6 * 3_600_000) this.sent.delete(k);
    for (const w of warnings) {
      if (!w?.ticket || !w.session || typeof w.deadline !== 'number') continue;
      const key = `${machineId}:${w.ticket}:${w.deadline}`;
      if (this.sent.has(key)) continue;
      // w2412: an editor's own life ticket ("running editor <sandbox>", session editor:<sandbox>, w1962) is warned when an
      // exclusive ticket waits behind it; no worker holds it (the turn closes that editor and tells its worker, w1829).
      if (w.session.startsWith('editor:')) {
        this.sent.set(key, now);
        this.d.log?.(`bench warning for ${w.ticket} on ${machineId}: it is the ${w.session.slice(7)} editor's own ticket (w1962), held while that editor runs; no worker to tell`);
        continue;
      }
      const info = this.d.session(w.session);
      if (!info) {
        this.sent.set(key, now);
        this.d.log?.(`bench warning for ${w.ticket} on ${machineId}: no session ${w.session} here`);
        continue;
      }
      try {
        this.d.send(w.session, benchWarningText(machineId, w, now));
      } catch (e) {
        this.d.log?.(`bench warning for ${w.ticket} on ${machineId} not sent, tried again on the next report: ${(e as Error).message}`);
        continue;
      }
      this.sent.set(key, now);
      this.d.log?.(`bench warning: told ${w.session} its ${w.mode} ticket ${w.ticket} on ${machineId} ends at ${hhmm(w.deadline)}`);
    }
  }
}

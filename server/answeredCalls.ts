// The portal's side of held machine-tool calls (w2422, machine/portalCalls.ts): a daemon sends a call that sets a
// request's wait again after a link that dropped before the answer came, with the same id.

/** How long an answered call id is kept: twice the daemon's hold (machine/portalCalls.ts HELD_CALL_MS, 15 min). */
export const ANSWERED_KEEP_MS = 30 * 60_000;

/** The portal's memory of the call ids it answered lately (w2422): a held call sent again after a dropped link gets the
 * first answer, and is not applied twice. */
export class AnsweredCalls<T> {
  private readonly seen = new Map<string, { at: number; reply: Promise<T> }>();
  private readonly keepMs: number;
  constructor(keepMs = ANSWERED_KEEP_MS) {
    this.keepMs = keepMs;
  }

  once(id: string, run: () => Promise<T>, now = Date.now()): Promise<T> {
    for (const [k, v] of this.seen) {
      if (now - v.at <= this.keepMs) break;
      this.seen.delete(k);
    }
    const had = this.seen.get(id);
    if (had) return had.reply;
    const reply = run();
    this.seen.set(id, { at: now, reply });
    return reply;
  }
}

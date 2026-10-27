// A session's machine-tool calls to the portal (w2422). Most answer at once or fail at once. The calls that set what a
// request waits on (blocked_on, waiting_on_person, wake_me, cancel_wake) are the last thing a worker does before it
// ends its turn, so one lost while the portal is unreachable left its request Stalled for hours (w2335, 2026-10-27: a
// blocked_on made during the 10:05-10:20 UTC portal restart was never recorded, and nothing resumed the worker when
// w2338 closed). Those calls are held here instead: sent the moment the link is back, in the order they were made,
// and sent again after a link that dropped before the portal answered. They are idempotent on the portal (each sets
// the same wait again), and the portal answers a call id it has already answered from its own memory, so a call sent
// twice is applied once. A call still unanswered after HELD_CALL_MS fails with words that say it was NOT recorded.

/** The tools whose calls are held across a portal outage: idempotent, and each one decides how the ledger shows a stopped worker. */
export const HELD_TOOLS: ReadonlySet<string> = new Set(['blocked_on', 'waiting_on_person', 'wake_me', 'cancel_wake']);

/** How long a held call waits for the portal (the agent host gives the daemon 20 min: RPC_ANSWER_MS). The portal's
 * health check restarts a hung portal after about 4 to 8 min, and a restart takes under a minute (the journal, w2422). */
export const HELD_CALL_MS = 15 * 60_000;

export type RpcMessage = { type: 'rpc'; id: string; sessionId: string; method: string; args: Record<string, unknown> };

/** The words of a call that could not reach the portal: loud, so the worker never ends its turn assuming it took. */
export function unreachableError(method: string, held: boolean, minutes?: number): Error {
  const what = held
    ? `${method} was NOT recorded: the portal stayed unreachable for ${minutes} min`
    : `${method} was NOT done: the portal is unreachable right now`;
  return new Error(
    `${what}. Do not end your turn as if it had worked. Wait a few minutes in the shell (until-loop, not a bare sleep) and ` +
      `call ${method} again; if it fails again, put "${method} failed: the portal is unreachable" in the first line of your ` +
      `report, so your orchestrator records it.`,
  );
}

export type PortalLink = { open: () => boolean; send: (msg: RpcMessage) => void; log?: (line: string) => void };

type Pending = { msg: RpcMessage; resolve: (t: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; held: boolean; sent: boolean };

/** The pending calls of every session on this machine, keyed by call id; insertion order is the order they were made. */
export class PortalCalls {
  private readonly pending = new Map<string, Pending>();

  private readonly link: PortalLink;
  private readonly heldMs: number;

  constructor(link: PortalLink, heldMs = HELD_CALL_MS) {
    this.link = link;
    this.heldMs = heldMs;
  }

  call(msg: RpcMessage, timeoutMs: number): Promise<string> {
    const held = HELD_TOOLS.has(msg.method);
    return new Promise<string>((resolve, reject) => {
      if (!held && !this.link.open()) return reject(unreachableError(msg.method, false));
      const wait = held ? Math.max(timeoutMs, this.heldMs) : timeoutMs;
      const timer = setTimeout(() => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (held) {
          this.link.log?.(`held ${msg.method} for session ${msg.sessionId} given up after ${Math.round(wait / 60_000)} min: the portal never answered`);
          reject(unreachableError(msg.method, true, Math.round(wait / 60_000)));
        } else reject(new Error(`the portal did not answer ${msg.method} in ${timeoutMs / 1000} s; it may or may not have been done: check, then call it again if not`));
      }, wait);
      timer.unref?.();
      const p: Pending = { msg, resolve, reject, timer, held, sent: false };
      this.pending.set(msg.id, p);
      if (this.link.open()) this.sendUnsent();
      else this.link.log?.(`${msg.method} for session ${msg.sessionId} held: the portal is unreachable; sent when the link is back`);
    });
  }

  /** The link is up again: every held call not answered yet goes out, oldest first. */
  linkUp() {
    this.sendUnsent();
  }

  /** The link dropped: a held call sent on it may never be answered, so it goes again on the next link. Other calls fail
   * now rather than at their timeout: the portal that took them may have restarted. */
  linkDown() {
    for (const [id, p] of this.pending) {
      if (p.held) p.sent = false;
      else if (p.sent) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(`the link to the portal dropped before it answered ${p.msg.method}; it may or may not have been done: check, then call it again if not`));
      }
    }
  }

  answer(id: string, ok: boolean, text: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(text);
    else p.reject(new Error(text));
  }

  /** Held calls not answered yet (tests, the daemon's status). */
  held(): RpcMessage[] {
    return [...this.pending.values()].filter((p) => p.held).map((p) => p.msg);
  }

  private sendUnsent() {
    for (const p of this.pending.values()) {
      if (p.sent) continue;
      if (!this.link.open()) return;
      p.sent = true;
      this.link.send(p.msg);
    }
  }
}

// The live view's newest-wins frame pump (w1601, docs/live-view.md "Flow control"): one per hop that can fall behind,
// the daemon's link to the portal and each page the portal feeds. Before w1601 a hop sent whenever its WebSocket's own
// buffer held under a cap (256 KB on the daemon, 1 MB per page), and everything past that cap sat in the operating
// system's socket buffers: on a slow link to a page the frames queued there and the view ran seconds behind the game.
//
// Now the far end answers with how many frames it has taken off this socket (a text message "a<count>"), and the pump
// keeps only as many bytes unanswered as the link carries in one round trip, the way BBR sizes its window: the fastest
// delivery rate it measured from the answers times the shortest round trip it has seen, plus one frame. A frame that
// would overfill it waits, and a newer one replaces it. So the view lags by about one round trip and one frame,
// whatever the link's speed, and a fast link still carries every frame. A far end that never answers (an older portal
// or page) keeps the old buffer cap. The count is cumulative, so a frame sent before the far end's first answer is
// counted the same on both ends.
//
// Pure logic: the caller passes how to send and how much its socket still buffers.

export interface FramePumpDeps {
  /** Sends one frame now. */
  send(frame: Uint8Array): void;
  /** Bytes the socket has not handed to the operating system yet (ws's bufferedAmount); -1 when it is not open. */
  buffered(): number;
  now(): number;
  /** Runs `fn` once after `ms` (the legacy cap's retry while the socket drains). */
  later(fn: () => void, ms: number): void;
}

/** Before the far end answers: send while the socket buffers at most this many bytes (the pre-w1601 rule). */
export const LEGACY_BUFFER_BYTES = 256 * 1024;
/** With answers: never more frames unanswered than this, whatever the window says. */
export const MAX_UNACKED_FRAMES = 8;
/** How long a delivery-rate sample counts toward the window: a link that slows down is seen within this. */
export const RATE_WINDOW_MS = 2000;
/** How long the shortest round trip counts: a route that changes is seen within this. */
export const MIN_RTT_WINDOW_MS = 10_000;

/** The far end's answer: "a" and how many frames it has taken off this socket; undefined for any other text. */
export function parseAck(text: string): number | undefined {
  const m = /^a(\d{1,12})$/.exec(text);
  return m ? Number(m[1]) : undefined;
}

interface Sent {
  at: number;
  bytes: number;
  /** Bytes answered when it was sent (BBR's delivered count). */
  deliveredAtSend: number;
}

export interface FramePumpStats {
  acking: boolean;
  sent: number;
  acked: number;
  /** Frames the pump replaced before it could send them. */
  skipped: number;
  unacked: number;
  /** The newest answer's round trip, ms (0 before one). */
  rttMs: number;
  /** The shortest recent round trip, ms (0 before one). */
  minRttMs: number;
  /** The fastest recent delivery rate, bytes a second (0 before one). */
  rateBps: number;
  /** The window it allows now, bytes. */
  windowBytes: number;
}

export class FramePump {
  private readonly deps: FramePumpDeps;
  private readonly legacyBytes: number;
  private latest: Uint8Array | undefined;
  /** Frames sent and not yet answered, by their number on this socket (1-based); the oldest first. */
  private inFlight = new Map<number, Sent>();
  private delivered = 0;
  private rates: { at: number; bps: number }[] = [];
  private rtts: { at: number; ms: number }[] = [];
  private lastRtt = 0;
  private maxFrame = 0;
  private waiting = false;
  acking = false;
  /** Frames sent on this socket. */
  sent = 0;
  /** Frames the far end has answered on this socket. */
  acked = 0;
  skipped = 0;

  constructor(deps: FramePumpDeps, legacyBytes = LEGACY_BUFFER_BYTES) {
    this.deps = deps;
    this.legacyBytes = legacyBytes;
  }

  /** A new frame: it replaces one still waiting, and goes out as soon as the link has room. */
  push(frame: Uint8Array) {
    if (this.latest) this.skipped++;
    this.latest = frame;
    this.maxFrame = Math.max(frame.byteLength, Math.round(this.maxFrame * 0.9));
    this.pump();
  }

  /** The far end has taken `count` frames off this socket. From its first answer on, the pump keeps to its window. */
  ack(count: number) {
    if (!Number.isFinite(count) || count <= this.acked) return;
    const now = this.deps.now();
    this.acking = true;
    const upTo = Math.min(count, this.sent);
    for (let n = this.acked + 1; n <= upTo; n++) {
      const f = this.inFlight.get(n);
      this.inFlight.delete(n);
      if (!f) continue;
      this.delivered += f.bytes;
      this.lastRtt = Math.max(0, now - f.at);
      this.rtts.push({ at: now, ms: this.lastRtt });
      if (this.lastRtt > 0) this.rates.push({ at: now, bps: ((this.delivered - f.deliveredAtSend) * 1000) / this.lastRtt });
    }
    this.acked = upTo;
    while (this.rtts.length && now - this.rtts[0].at > MIN_RTT_WINDOW_MS) this.rtts.shift();
    while (this.rates.length && now - this.rates[0].at > RATE_WINDOW_MS) this.rates.shift();
    this.pump();
  }

  /** A new socket: nothing in flight, counts from zero, no answers yet. */
  reset() {
    this.inFlight.clear();
    this.acking = false;
    this.sent = 0;
    this.acked = 0;
  }

  /** The window: the fastest recent delivery rate times the shortest recent round trip, plus one frame. */
  windowBytes(): number {
    const frame = Math.max(1, this.maxFrame);
    if (!this.rtts.length || !this.rates.length) return 2 * frame;
    const minRtt = Math.min(...this.rtts.map((r) => r.ms));
    const rate = Math.max(...this.rates.map((r) => r.bps));
    return Math.max(frame, Math.round((rate * minRtt) / 1000)) + frame;
  }

  get stats(): FramePumpStats {
    return {
      acking: this.acking,
      sent: this.sent,
      acked: this.acked,
      skipped: this.skipped,
      unacked: this.acking ? this.sent - this.acked : 0,
      rttMs: Math.round(this.lastRtt),
      minRttMs: this.rtts.length ? Math.round(Math.min(...this.rtts.map((r) => r.ms))) : 0,
      rateBps: this.rates.length ? Math.round(Math.max(...this.rates.map((r) => r.bps))) : 0,
      windowBytes: this.windowBytes(),
    };
  }

  /** Sends the waiting frame if the link has room (a socket that just opened). */
  flush() {
    this.pump();
  }

  private pump() {
    const frame = this.latest;
    if (!frame) return;
    const buffered = this.deps.buffered();
    if (buffered < 0) return;
    if (this.acking) {
      const unacked = this.sent - this.acked;
      if (unacked >= MAX_UNACKED_FRAMES) return;
      let unackedBytes = 0;
      for (const f of this.inFlight.values()) unackedBytes += f.bytes;
      // The next answer pumps again; one frame always may go when nothing is in flight.
      if (unacked > 0 && unackedBytes + frame.byteLength > this.windowBytes()) return;
    } else if (buffered > this.legacyBytes) {
      if (!this.waiting) {
        this.waiting = true;
        this.deps.later(() => {
          this.waiting = false;
          this.pump();
        }, 20);
      }
      return;
    }
    this.latest = undefined;
    this.sent++;
    this.inFlight.set(this.sent, { at: this.deps.now(), bytes: frame.byteLength, deliveredAtSend: this.delivered });
    // A far end that never answers (an older one): keep only the frames it could still answer.
    if (this.inFlight.size > 4 * MAX_UNACKED_FRAMES) this.inFlight.delete(this.inFlight.keys().next().value!);
    this.deps.send(frame);
  }
}

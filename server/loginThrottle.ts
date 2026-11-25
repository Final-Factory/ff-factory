import { createHash, randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * The login throttle's parts (w5521, finding 14 of the w5452 audit). Failed logins are counted per attempted username
 * and per client address (IPv4 per address, IPv6 per /64); there is no global counter, so failures from anywhere cannot
 * lock every person out.
 *
 * Memory is bounded (lothsahn, w5521: "Make sure the per username throttle can't cause a huge memory leak and be
 * susceptible to a DOS attack"): each FailureTable holds at most `cap` exact entries with keys of at most KEY_MAX
 * characters, and a fixed array of hashed buckets. When the map is full the least recently failed entry is evicted, and
 * its count is folded into its bucket (keyed by a random per-process salt, so an attacker cannot aim collisions). A
 * lookup takes the larger of the exact entry and its bucket, so flooding the map with made-up names evicts a targeted
 * username's entry but not its backoff: the bucket still holds it (the count-min idea, one row). The cost of a shared
 * bucket is that an innocent name in the same bucket inherits a hot name's backoff, which is bounded (at most
 * USER_BACKOFF_MAX_MS) and rare (65536 buckets).
 */

/** Longest key kept: a username or address is cut to this before it is used as a key (valid usernames are <= 32). */
export const KEY_MAX = 64;
/** Failures a username may have before its backoff starts: twice what one address may, so a single address (a person
 * mistyping) meets only its own limit, and the backoff starts when several addresses work one name. */
export const USER_FREE_FAILURES = 10;
/** First backoff once a username is past its free failures; it doubles on each further failure. */
export const USER_BACKOFF_BASE_MS = 1_000;
/** The most a username's backoff grows to: its real owner gets in after at most this wait. */
export const USER_BACKOFF_MAX_MS = 60_000;
/** Failures from one address (or IPv6 /64) before it is refused. */
export const ADDRESS_MAX_FAILURES = 5;
/** How long an address stays refused after its last counted failure, and how long any entry is remembered. */
export const FAILURE_TTL_MS = 15 * 60_000;
/** Exact entries per table. */
export const TABLE_CAP = 10_000;
/** Hashed buckets per table that keep an evicted entry's count. */
export const TABLE_BUCKETS = 65_536;
/** How often expired entries are swept. */
export const SWEEP_MS = 60_000;

type Entry = { fails: number; last: number };

export class FailureTable {
  private readonly entries = new Map<string, Entry>();
  private readonly bucketFails: Uint32Array;
  private readonly bucketLast: Float64Array;
  private readonly salt = randomBytes(16);

  private readonly opts: { cap?: number; buckets?: number; ttlMs?: number; now?: () => number };

  constructor(opts: { cap?: number; buckets?: number; ttlMs?: number; now?: () => number } = {}) {
    this.opts = opts;
    const n = opts.buckets ?? TABLE_BUCKETS;
    this.bucketFails = new Uint32Array(n);
    this.bucketLast = new Float64Array(n);
  }

  private get cap() {
    return this.opts.cap ?? TABLE_CAP;
  }

  private get ttl() {
    return this.opts.ttlMs ?? FAILURE_TTL_MS;
  }

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private bucket(key: string) {
    return createHash('sha256').update(this.salt).update(key).digest().readUInt32LE(0) % this.bucketFails.length;
  }

  /** The failures remembered for `key` and when the last one was, or undefined when none is live. */
  state(rawKey: string): Entry | undefined {
    const key = rawKey.slice(0, KEY_MAX);
    const now = this.now();
    const e = this.entries.get(key);
    const exact = e && now - e.last < this.ttl ? e : undefined;
    const b = this.bucket(key);
    const spilled = this.bucketFails[b] && now - this.bucketLast[b] < this.ttl ? { fails: this.bucketFails[b], last: this.bucketLast[b] } : undefined;
    if (!spilled) return exact;
    if (!exact) return spilled;
    return spilled.fails > exact.fails ? spilled : exact;
  }

  /** Count a failure for `key`; returns its new count. */
  fail(rawKey: string): number {
    const key = rawKey.slice(0, KEY_MAX);
    const fails = (this.state(key)?.fails ?? 0) + 1;
    // Delete and set again, so the map's order is least recently failed first.
    this.entries.delete(key);
    this.entries.set(key, { fails, last: this.now() });
    while (this.entries.size > this.cap) {
      const [oldKey, old] = this.entries.entries().next().value as [string, Entry];
      this.entries.delete(oldKey);
      this.spill(oldKey, old);
    }
    return fails;
  }

  private spill(key: string, e: Entry) {
    const b = this.bucket(key);
    const live = this.bucketFails[b] && this.now() - this.bucketLast[b] < this.ttl;
    this.bucketFails[b] = Math.max(live ? this.bucketFails[b] : 0, e.fails);
    this.bucketLast[b] = Math.max(live ? this.bucketLast[b] : 0, e.last);
  }

  /** Forget `key`'s exact entry (a success). Its bucket is left: it may hold another name's failures. */
  clear(rawKey: string) {
    this.entries.delete(rawKey.slice(0, KEY_MAX));
  }

  /** Drop expired entries and buckets; returns how many entries went. */
  sweep(): number {
    const now = this.now();
    let n = 0;
    for (const [k, e] of this.entries) if (now - e.last >= this.ttl && this.entries.delete(k)) n++;
    for (let i = 0; i < this.bucketFails.length; i++) {
      if (this.bucketFails[i] && now - this.bucketLast[i] >= this.ttl) {
        this.bucketFails[i] = 0;
        this.bucketLast[i] = 0;
      }
    }
    return n;
  }

  get size() {
    return this.entries.size;
  }
}

/** How long a username with `fails` failures (its last at `last`) is refused from `now`, in ms; 0 when it is not. */
export function userWaitMs(s: Entry | undefined, now: number): number {
  if (!s || s.fails < USER_FREE_FAILURES) return 0;
  const backoff = Math.min(USER_BACKOFF_BASE_MS * 2 ** Math.min(s.fails - USER_FREE_FAILURES, 30), USER_BACKOFF_MAX_MS);
  return Math.max(0, s.last + backoff - now);
}

/** Whether an address with this record is refused. */
export function addressRefused(s: Entry | undefined): boolean {
  return !!s && s.fails >= ADDRESS_MAX_FAILURES;
}

/**
 * The throttle key of a client address: an IPv4 address as itself (an IPv4-mapped IPv6 one too), an IPv6 address as its
 * /64 ("2001:db8:1:2::/64"), since one host is commonly given a whole /64. Anything else (a malformed forwarded header)
 * is kept as it is, cut to KEY_MAX.
 */
export function addressKey(ip: string): string {
  let a = ip.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  a = a.split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (isIPv4(a)) return a;
  if (!isIPv6(a)) return ip.slice(0, KEY_MAX);
  const groups = expandIPv6(a);
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address. */
function expandIPv6(a: string): number[] {
  let s = a;
  // An IPv4 tail ("::1.2.3.4") becomes two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
}

/**
 * A value from a request, safe for one log line: quoted, and every character outside printable ASCII (a newline, an
 * ANSI escape, U+2028) or a quote or backslash escaped, so a made-up username cannot forge log lines. Cut to KEY_MAX.
 */
export function quoteForLog(v: string): string {
  const esc = v.slice(0, KEY_MAX).replace(/[^\x20-\x7e]|["\\]/g, (c) => (c === '"' || c === '\\' ? `\\${c}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  return `"${esc}"${v.length > KEY_MAX ? '...' : ''}`;
}

/**
 * The fixed login time (lothsahn, w5521: "Make sure every login has a fixed time so people can't determine valid vs
 * invalid username and password based on timing", and "The fixed time should be as short as possible"). Every login
 * answer waits on a timer (never a busy loop) until FLOOR after it started. The floor follows what this machine
 * measures: the slowest of the last WINDOW failed and the last WINDOW successful logins (the password check and the work
 * around it), plus MARGIN. Before any login it is the time the dummy hash took to make, which runs the same scrypt cost.
 */
export class LoginTimer {
  static readonly WINDOW = 32;
  /** Over the slowest measured path: a tenth more, and 3 ms for the timer's own lateness. */
  static readonly MARGIN = (ms: number) => ms * 1.1 + 3;
  /** A sample this slow (a stalled machine) is not let raise the floor above it. */
  static readonly CEILING_MS = 5_000;
  private readonly fails: number[] = [];
  private readonly oks: number[] = [];

  /** Record how long a login that ran the password check took, in ms. */
  observe(ms: number, ok: boolean) {
    const w = ok ? this.oks : this.fails;
    w.push(Math.min(ms, LoginTimer.CEILING_MS));
    if (w.length > LoginTimer.WINDOW) w.shift();
  }

  /** The time every login answer is held to, in ms. */
  floorMs(): number {
    const slowest = Math.max(0, ...this.fails, ...this.oks);
    return slowest ? LoginTimer.MARGIN(slowest) : 0;
  }

  /** Wait until the floor after `started` (a performance.now() value). */
  async pad(started: number): Promise<void> {
    const left = this.floorMs() - (performance.now() - started);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
  }
}

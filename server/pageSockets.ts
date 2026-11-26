// One log line per page WebSocket (/ws) opening and closing, and a count of each person's dropped sockets (w4723).
// lothsahn kept seeing "Connection lost" and the log said nothing about why: the server never logged a page's socket.
// Each line names the person, the address and the path in (Funnel, tailnet or this machine), why the page reconnected
// (it says so in the URL: web/src/api.ts), and on close the code, the reason, who closed it and how long it was open.
// Never per message, never a token. docs/portal-logs.md, "Connection lost".
import type http from 'node:http';
import { tailnetAddress } from './remoteChat.ts';
import { clientAddress, directAddress, isLoopback } from './clientAddress.ts';

/** Who ended a socket: the page (a close frame), the server (its ping went unanswered), or nobody (1006: the network). */
/** The most a page may send in one message (w5527: ws's default is 100 MiB). The page sends none on /ws; ws closes the socket with 1009 above this, and the page reconnects with its backoff. */
export const PAGE_MAX_PAYLOAD = 1024 * 1024;

export type ClosedBy = 'page' | 'ping-timeout' | 'network';
export type Via = 'funnel' | 'tailnet' | 'local' | 'other';

/** Why the page opened this socket; anything else it sends is logged as 'other'. Kept in step with web/src/api.ts. */
export const RECONNECT_REASONS = ['first', 'stale', 'visible', 'online', 'closed', 'error', 'timeout'] as const;

interface Open {
  user: string;
  addr: string;
  via: Via;
  at: number;
  serverClose?: ClosedBy;
}

/** A drop is a socket ended by the server's ping timeout or the network, or one the page gave up on as silent ('stale'). */
const DROP_WINDOW_MS = 3_600_000;

export function viaOf(req: Pick<http.IncomingMessage, 'headers' | 'socket'>): { addr: string; via: Via } {
  const addr = clientAddress(req);
  if (req.headers['tailscale-funnel-request'] !== undefined) return { addr, via: 'funnel' };
  if (isLoopback(addr)) return { addr, via: 'local' };
  return { addr, via: tailnetAddress(addr) ? 'tailnet' : 'other' };
}

/** A request from this machine itself (fffctl status's curl), not one Tailscale Serve proxied in: it may see people's logins. */
export function fromThisMachine(req: Pick<http.IncomingMessage, 'headers' | 'socket'>): boolean {
  return isLoopback(directAddress(req)) && req.headers['x-forwarded-for'] === undefined && req.headers['tailscale-funnel-request'] === undefined;
}

/**
 * What the page said in its URL: `why` (one of RECONNECT_REASONS), `code` (the close code its last socket saw), `gap` (ms since it
 * closed), `tries` (attempts that failed or hung since then, w5318: a long gap with few tries is a page that waited, many a path that failed).
 */
export function reconnectOf(url: string | undefined): string {
  let q: URLSearchParams;
  try {
    q = new URL(url ?? '', 'http://x').searchParams;
  } catch {
    return 'why=?';
  }
  const why = q.get('why');
  const out = [`why=${why === null ? '?' : (RECONNECT_REASONS as readonly string[]).includes(why) ? why : 'other'}`];
  const code = Number(q.get('code'));
  if (q.has('code') && Number.isInteger(code) && code >= 0 && code < 5000) out.push(`pageSawCode=${code}`);
  const gap = Number(q.get('gap'));
  if (q.has('gap') && Number.isFinite(gap) && gap >= 0) out.push(`gap=${secs(gap)}`);
  const tries = Number(q.get('tries'));
  if (q.has('tries') && Number.isInteger(tries) && tries > 0 && tries < 1e6) out.push(`tries=${tries}`);
  return out.join(' ');
}

const secs = (ms: number) => `${Math.round(ms / 100) / 10}s`;
/** A close reason is the peer's text: printable ASCII only, short, so a line stays one line. */
const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 60);

export class PageSockets<S extends object> {
  private open = new Map<S, Open>();
  /** Each person's drops: their times in the last hour, and the count since the portal started. */
  private drops = new Map<string, { recent: number[]; total: number }>();

  private log: (line: string) => void;
  private now: () => number;

  constructor(log: (line: string) => void = console.log, now: () => number = Date.now) {
    this.log = log;
    this.now = now;
  }

  /** `stateMs`/`stateBytes`: what building and sending the page its first full state took (the page's open waits on it). */
  opened(ws: S, user: string, req: Pick<http.IncomingMessage, 'headers' | 'socket' | 'url'>, state?: { ms: number; bytes: number }) {
    const { addr, via } = viaOf(req);
    this.open.set(ws, { user, addr, via, at: this.now() });
    const why = reconnectOf(req.url);
    if (/^why=stale\b/.test(why)) this.countDrop(user);
    this.log(`page socket open: ${user} from ${addr} via ${via}, ${why}${state ? `, state ${Math.round(state.ms)}ms ${Math.round(state.bytes / 1024)}KB` : ''} (${this.open.size} open)`);
  }

  /**
   * The first state is all in the kernel's send buffer, `ms` after the open began (w5861). Logged only when slow: on a
   * fast path it follows the open line within milliseconds and says nothing new.
   */
  sent(ws: S, ms: number) {
    const o = this.open.get(ws);
    if (o && ms >= 1000) this.log(`page socket first state sent: ${o.user} via ${o.via}, ${Math.round(ms)}ms after the open`);
  }

  /** The server is about to end this socket itself (call before terminate/close), so its close line says so. */
  serverClosing(ws: S, by: 'ping-timeout') {
    const o = this.open.get(ws);
    if (o) o.serverClose = by;
  }

  closed(ws: S, code: number, reason: string) {
    const o = this.open.get(ws);
    if (!o) return;
    this.open.delete(ws);
    const by: ClosedBy = o.serverClose ?? (code === 1006 ? 'network' : 'page');
    if (by === 'ping-timeout' || by === 'network') this.countDrop(o.user);
    const r = clean(reason);
    this.log(`page socket closed: ${o.user} from ${o.addr} via ${o.via}, code ${code}${r ? ` "${r}"` : ''}, by ${by}, open ${secs(this.now() - o.at)}${this.dropNote(o.user)}`);
  }

  private countDrop(user: string) {
    const d = this.drops.get(user) ?? { recent: [], total: 0 };
    d.total++;
    d.recent.push(this.now());
    this.prune(d);
    this.drops.set(user, d);
  }

  private prune(d: { recent: number[] }) {
    const since = this.now() - DROP_WINDOW_MS;
    while (d.recent.length && d.recent[0] < since) d.recent.shift();
  }

  private dropNote(user: string) {
    const d = this.drops.get(user);
    if (!d) return '';
    this.prune(d);
    return d.recent.length ? `; ${user}'s drops: ${d.recent.length} in the last hour, ${d.total} since start` : '';
  }

  /** For /api/health: open sockets and drops in the last hour, by person only when `byUser` (a request from this machine). */
  health(byUser: boolean): { open: number; dropsLastHour: number; dropsSinceStart: number; byUser?: Record<string, { lastHour: number; sinceStart: number }> } {
    let lastHour = 0;
    let total = 0;
    const per: Record<string, { lastHour: number; sinceStart: number }> = {};
    for (const [user, d] of this.drops) {
      this.prune(d);
      lastHour += d.recent.length;
      total += d.total;
      per[user] = { lastHour: d.recent.length, sinceStart: d.total };
    }
    return { open: this.open.size, dropsLastHour: lastHour, dropsSinceStart: total, ...(byUser && this.drops.size ? { byUser: per } : {}) };
  }
}

// One log line per page WebSocket (/ws) opening and closing, and a count of each person's dropped sockets (w4723).
// lothsahn kept seeing "Connection lost" and the log said nothing about why: the server never logged a page's socket.
// Each line names the person, the address and the path in (Funnel, tailnet or this machine), why the page reconnected
// (it says so in the URL: web/src/api.ts), and on close the code, the reason, who closed it and how long it was open.
// Never per message, never a token. docs/portal-logs.md, "Connection lost".
import type http from 'node:http';
import { tailnetAddress } from './remoteChat.ts';
import { clientAddress, directAddress, isLoopback } from './clientAddress.ts';

/** Who ended a socket: the page (a close frame), the server (its ping went unanswered), or nobody (1006: the network). */
/** The most a page may send in one message (w5527: ws's default is 100 MiB). The page sends only its ready line on /ws (w6336); ws closes the socket with 1009 above this, and the page reconnects with its backoff. */
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
  /** What the server spent on the first state (w6336: the ready line sets the page's phases beside it). */
  state?: FirstState;
  /** The page has said its first state is on screen (once per socket). */
  ready?: boolean;
  /** w6762: where the handoff went (connectTiming.ts), told on the sent and ready lines. */
  handoff?: Handoff;
}

/**
 * w6762: a connect's handoff, measured. `pageAt`: the page's clock when its attempt began (its URL's `at`); `arrivedAt`:
 * the server's clock when the upgrade arrived; `sentAt`: when the first state's last byte was in the kernel (all
 * Date.now()). `pool`: the thread pool's lag at the open; `deflate`: ws's deflate of the first state (none under its
 * 16 KB threshold); `cpu`: the VM's CPU from the open to that hand-off (CpuSampler.between); `sentPerf`: the hand-off's
 * performance.now(), beside the deflate's `doneAt`.
 */
export interface Handoff {
  pageAt?: number;
  arrivedAt?: number;
  sentAt?: number;
  sentMs?: number;
  sentPerf?: number;
  pool?: { poolMs: number; loopMs: number };
  deflate?: { queuedMs?: number; ranMs?: number; doneAt?: number; inBytes?: number; outBytes?: number; chunks?: number };
  cpu?: string;
}

/** Building the first state, in parts: appState, JSON.stringify, and the whole. */
/** `kept`: the whole parts the page kept its own of; `work`: requests sent of all (w6336, shared/pageParts.ts). */
export interface FirstState { ms: number; bytes: number; sessions?: number; delta?: boolean; buildMs?: number; jsonMs?: number; kept?: string[]; checked?: number; work?: { sent: number; of: number }; phases?: readonly (readonly [string, number])[]; place?: string }

/**
 * What a page says once its first state is on screen (w6336, web/src/api.ts): each phase of its connect in ms, as the
 * page measured it. `load`: since the page itself began loading (first connect only: HTML, scripts and all).
 */
/** script: when its script began; shell: when its saved copy was on screen, both since the page began loading (w6763). */
export interface PageReady { open: number; state: number; parse: number; render: number; load?: number; openEpoch?: number; stateEpoch?: number; script?: number; shell?: number }

/** ", kept reports,machines, 3 of 100 requests changed": what a reconnect did not resend. */
/**
 * w6382: where a state's build went, its slowest phases first (server/index.ts appStateIn): " [sessions 310, work 120]".
 * A phase under PHASE_LOG_MIN_MS is left out, so a fast build's line stays short.
 */
export const PHASE_LOG_MIN_MS = 5;
function phasesOf(s: FirstState): string {
  const shown = [...(s.phases ?? [])].filter(([, ms]) => ms >= PHASE_LOG_MIN_MS).sort((a, b) => b[1] - a[1]).slice(0, 6);
  // w6428: and what placement cost inside them (server/placeCost.ts): " place{places 40ms x1 free 30ms x48 claims 25ms x8}".
  const place = s.place ? ` place{${s.place}}` : '';
  return shown.length ? ` [${shown.map(([k, ms]) => `${k} ${Math.round(ms)}`).join(', ')}]${place}` : place;
}

function keptOf(s: FirstState): string {
  const parts = s.kept?.length ? `, kept ${s.kept.join(',')}` : '';
  return `${parts}${s.work ? `, ${s.work.sent} of ${s.work.of} requests changed` : ''}`;
}

const PHASE_MAX_MS = 3_600_000;
/** A page's ready message, or undefined: only these numbers, each a finite ms within an hour. */
export function readyOf(raw: unknown): PageReady | undefined {
  if (typeof raw !== 'string' || raw.length > 512) return undefined;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!m || typeof m !== 'object' || (m as { type?: unknown }).type !== 'ready') return undefined;
  const o = m as Record<string, unknown>;
  const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= PHASE_MAX_MS ? Math.round(v) : undefined);
  const open = ms(o.open), state = ms(o.state), parse = ms(o.parse), render = ms(o.render);
  if (open === undefined || state === undefined || parse === undefined || render === undefined) return undefined;
  const load = ms(o.load), shell = ms(o.shell), script = ms(o.script);
  // w6762: the page's own clock (Date.now()) at its open and at its first state, set beside the server's on the ready line.
  const epoch = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 1e12 && v < 1e14 ? Math.round(v) : undefined);
  const openEpoch = epoch(o.openEpoch), stateEpoch = epoch(o.stateEpoch);
  return { open, state, parse, render, ...(load !== undefined ? { load } : {}), ...(openEpoch !== undefined ? { openEpoch } : {}), ...(stateEpoch !== undefined ? { stateEpoch } : {}), ...(shell !== undefined ? { shell } : {}), ...(script !== undefined ? { script } : {}) };
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

/** w6762: the page's clock when its attempt began (its URL's `at`, Date.now()), or undefined. */
export function pageAtOf(url: string | undefined): number | undefined {
  try {
    const at = Number(new URL(url ?? '', 'http://x').searchParams.get('at'));
    return Number.isFinite(at) && at > 1e12 && at < 1e14 ? Math.round(at) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * w6762: " (deflate queued 2ms, ran 3900ms in 37 chunks 998KB to 160KB; kernel 150ms; pool lag 2400ms, loop turn 40ms;
 * cpu{...})": the sent time split into ws's deflate (its limiter, then zlib on the thread pool), the kernel write after
 * it, and what the pool, the loop and the CPU were doing meanwhile.
 */
export function handoffOf(h: Handoff | undefined): string {
  if (!h) return '';
  const parts: string[] = [];
  const d = h.deflate;
  if (d?.ranMs !== undefined) {
    const sizes = d.inBytes !== undefined && d.outBytes !== undefined ? ` ${Math.round(d.inBytes / 1024)}KB to ${Math.round(d.outBytes / 1024)}KB` : '';
    parts.push(`deflate queued ${Math.round(d.queuedMs ?? 0)}ms, ran ${Math.round(d.ranMs)}ms${d.chunks !== undefined ? ` in ${d.chunks} chunks` : ''}${sizes}`);
    if (h.sentPerf !== undefined && d.doneAt !== undefined) parts.push(`kernel ${Math.round(h.sentPerf - d.doneAt)}ms`);
  } else parts.push('not deflated');
  if (h.pool) parts.push(`pool lag ${Math.round(h.pool.poolMs)}ms, loop turn ${Math.round(h.pool.loopMs)}ms`);
  if (h.cpu) parts.push(h.cpu);
  return ` (${parts.join('; ')})`;
}

/**
 * w6762: "; clocks: upgrade in 3100ms after the page began, open seen 40ms after it, in+back 3140ms, state sent 4100ms
 * after it, at the page 200ms after that". Each step crosses the page's and the server's clocks and is off by their skew
 * (one way going in, the other coming back); "in+back" is the round trip with the skew cancelled.
 */
export function clocksOf(h: Handoff | undefined, r: PageReady): string {
  if (!h || h.arrivedAt === undefined) return '';
  const parts: string[] = [];
  const up = h.pageAt !== undefined ? h.arrivedAt - h.pageAt : undefined;
  const back = r.openEpoch !== undefined ? r.openEpoch - h.arrivedAt : undefined;
  if (up !== undefined) parts.push(`upgrade in ${up}ms after the page began`);
  if (back !== undefined) parts.push(`open seen ${back}ms after it`);
  if (up !== undefined && back !== undefined) parts.push(`in+back ${up + back}ms`);
  if (h.sentAt !== undefined) {
    parts.push(`state sent ${h.sentAt - h.arrivedAt}ms after it`);
    if (r.stateEpoch !== undefined) parts.push(`at the page ${r.stateEpoch - h.sentAt}ms after that`);
  }
  return parts.length ? `; clocks: ${parts.join(', ')}` : '';
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
  opened(ws: S, user: string, req: Pick<http.IncomingMessage, 'headers' | 'socket' | 'url'>, state?: FirstState, handoff?: Handoff) {
    const { addr, via } = viaOf(req);
    this.open.set(ws, { user, addr, via, at: this.now(), state, handoff: handoff ? { ...handoff, pageAt: pageAtOf(req.url) } : undefined });
    const why = reconnectOf(req.url);
    if (/^why=stale\b/.test(why)) this.countDrop(user);
    this.log(`page socket open: ${user} from ${addr} via ${via}, ${why}${state ? `, state ${Math.round(state.ms)}ms${state.buildMs !== undefined && state.jsonMs !== undefined ? ` (build ${Math.round(state.buildMs)}ms${phasesOf(state)} json ${Math.round(state.jsonMs)}ms)` : ''} ${Math.round(state.bytes / 1024)}KB${state.sessions !== undefined ? ` ${state.sessions} sessions${state.delta ? ' changed' : ''}` : ''}${state.checked !== undefined ? ` (${state.checked} checked)` : ''}${keptOf(state)}` : ''} (${this.open.size} open)`);
  }

  /**
   * The first state is all in the kernel's send buffer, `ms` after the open began (w5861). Logged only when slow: on a
   * fast path it follows the open line within milliseconds and says nothing new.
   */
  sent(ws: S, ms: number, sentPerf?: number) {
    const o = this.open.get(ws);
    if (!o) return;
    // w6762: kept for the ready line, which says where the handoff went beside the page's phases.
    if (o.handoff) Object.assign(o.handoff, { sentAt: this.now(), sentMs: ms, sentPerf });
    if (ms >= 1000) this.log(`page socket first state sent: ${o.user} via ${o.via}, ${Math.round(ms)}ms after the open${handoffOf(o.handoff)}`);
  }

  /** w6762: what the thread-pool probe found at this socket's open (it answers after the open line). */
  pool(ws: S, lag: { poolMs: number; loopMs: number }) {
    const o = this.open.get(ws);
    if (o?.handoff) o.handoff.pool = lag;
  }

  /** w6762: the CPU over this socket's handoff (CpuSampler.between), set just before sent(). */
  cpu(ws: S, line: string) {
    const o = this.open.get(ws);
    if (o?.handoff && line) o.handoff.cpu = line;
  }

  /**
   * The page's first state is on screen (w6336): one line per connect with every phase, the page's (open: the attempt
   * began to open; state: open to the whole first state in; parse; render: to the next frame after applying it) and the
   * server's (build). Once per socket; anything else a page sends is ignored.
   */
  ready(ws: S, raw: unknown) {
    const o = this.open.get(ws);
    const r = o && !o.ready ? readyOf(raw) : undefined;
    if (!o || !r) return;
    o.ready = true;
    const total = r.open + r.state + r.parse + r.render;
    const server = o.state ? `, server build ${Math.round(o.state.ms)}ms ${Math.round(o.state.bytes / 1024)}KB` : '';
    this.log(`page socket ready: ${o.user} via ${o.via}, ${total}ms: open ${r.open}ms, first state ${r.state}ms, parse ${r.parse}ms, render ${r.render}ms${server}${r.load !== undefined ? `; ${r.load}ms since the page began loading` : ''}${r.script !== undefined ? `, script at ${r.script}ms` : ''}${r.shell !== undefined ? `, saved copy on screen at ${r.shell}ms` : ''}${clocksOf(o.handoff, r)}${o.handoff && o.handoff.sentMs !== undefined && o.handoff.sentMs < 1000 ? handoffOf(o.handoff) : ''}`);
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

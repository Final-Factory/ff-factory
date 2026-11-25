import type http from 'node:http';

/**
 * The one way the portal takes a request's client address (w5535, finding 27 of the w5452 audit). Every caller (the login
 * throttle, join codes, the /provider, /machine and /machine/live sockets, page sockets, the tailnet-only checks, logs)
 * uses it, so a spoof that works on one cannot work on another.
 *
 * X-Forwarded-For is believed only when trustProxy is on and the connection itself came from a trusted proxy: this machine
 * (loopback, where Tailscale Serve and Funnel connect from) or an address in the configured proxy list. Even then only its
 * LAST entry is taken: a proxy appends the address it saw, so every entry to its left came from the client and is
 * whatever the client chose to write. Tailscale Serve replaces the header with one entry (it proxies with httputil's
 * Rewrite, which strips the inbound X-Forwarded-For, then SetXForwarded), so there the last entry is the only one.
 * Anything else is judged by the connection's own address.
 */

type Req = Pick<http.IncomingMessage, 'headers' | 'socket'>;

let trustProxyNow: () => boolean = () => true;
let proxiesNow: () => readonly string[] = () => [];

/** Wire the live settings in once at start-up (index.ts): trustProxy as config has it now, and any further proxy addresses. */
export function configureClientAddress(opts: { trustProxy: () => boolean; proxies?: () => readonly string[] }) {
  trustProxyNow = opts.trustProxy;
  proxiesNow = opts.proxies ?? (() => []);
}

/** An address without its IPv4-mapped prefix, brackets or zone: '::ffff:127.0.0.1' is '127.0.0.1'. */
export function plainAddress(ip: string): string {
  let a = ip.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  return a.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
}

/** Whether an address is this machine (127.0.0.0/8 or ::1). */
export function isLoopback(ip: string): boolean {
  const a = plainAddress(ip);
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/** The connection's own address, plain. */
export function directAddress(req: Req): string {
  return plainAddress(req.socket.remoteAddress ?? '');
}

/** Whether this request's X-Forwarded-For is believed: trustProxy on, and the connection came from a trusted proxy. */
export function fromTrustedProxy(req: Req, opts: { trustProxy?: boolean } = {}): boolean {
  if (!(opts.trustProxy ?? trustProxyNow())) return false;
  const direct = directAddress(req);
  return isLoopback(direct) || proxiesNow().some((p) => plainAddress(p) === direct);
}

/** The last X-Forwarded-For entry (the one the proxy itself added), plain, or '' when there is none. */
export function lastForwarded(req: Req): string {
  const raw = req.headers['x-forwarded-for'];
  const all = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).split(',');
  return plainAddress(all[all.length - 1] ?? '');
}

/** The client's address: the last X-Forwarded-For entry from a trusted proxy, else the connection's own. */
export function clientAddress(req: Req, opts: { trustProxy?: boolean } = {}): string {
  const direct = directAddress(req);
  if (!fromTrustedProxy(req, opts)) return direct;
  return lastForwarded(req) || direct;
}

/** A connection from this machine that carries a proxy's header the portal is told not to believe (trustProxy off): its
 * real client is unknown, so a check that lets this machine in must not let it in. */
export function untrustedProxied(req: Req, opts: { trustProxy?: boolean } = {}): boolean {
  return isLoopback(directAddress(req)) && req.headers['x-forwarded-for'] !== undefined && !fromTrustedProxy(req, opts);
}

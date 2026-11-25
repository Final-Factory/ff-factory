// The portal hosts a daemon follows (w5576, docs/portal-pin.md): a taken-over portal must not move a worker machine to an
// address it chose. The hosts a daemon trusts ship in this file, so they change only with an update of the daemon's own
// code, and an update installs only a commit published on GitHub's ff-factory main (w5516, machine/selfUpdate.ts
// checkPublished). A daemon.json `pinnedPortalHosts` adds hosts on one machine: a person or the ops worker edits it by hand
// over ssh (no installer flag writes it; an installer update, a reinstall or a migration keeps it; a full install rerun drops it), and nothing sent over the link can (patchDaemonConfig takes only the relocate fields).
//
// Stage 1, warn (w5576): what pinning would refuse was logged, kept in portal-pin.json beside daemon.json and reported in
// the hello (`portalPin`, list_machines shows it), and went ahead. Stage 2, enforce (w5715, this file's PORTAL_PIN_MODE),
// shipped once every machine reported clean: a relocate to an unpinned host is refused (relocate_result ok:false) and a
// portal fetch that a redirect took to an unpinned host is refused (its answer is not used). What is never refused, so a
// machine can never be locked out of updates by this file: the daemon always dials daemon.json's portalUrl, and
// previousPortalUrl as its fallback, pinned or not (a person or the ops worker set them by hand); an unpinned one is only
// logged, kept and reported.
//
// No npm imports: the update job (scripts/worker/linkJob.ts) may load modules from a checkout without node_modules.
import fs from 'node:fs';
import path from 'node:path';

export type PortalPinMode = 'warn' | 'enforce';

/** Stage 2 (w5715): enforce. Back to 'warn' is the one-line rollback (docs/portal-pin.md). */
export const PORTAL_PIN_MODE: PortalPinMode = 'enforce';

/**
 * The portal hosts every daemon follows, by DNS name (the tailnet's MagicDNS name; its HTTPS certificate is checked by
 * Node as for any site). A new portal host is added here, merged and rolled out to every machine BEFORE the portal moves
 * there, and the old one is dropped only after every machine has moved (docs/portal-pin.md, "Moving the portal").
 * - fff: the portal VM on the FFBox host (docs/portal-on-ffbox-host.md).
 * - beast: the portal's host before the VM, and the rollback (docs/portal-on-ffbox-host.md 7.3).
 */
export const PINNED_PORTAL_HOSTS: readonly string[] = ['fff.tailedfcad.ts.net', 'beast.tailedfcad.ts.net'];

/** Loopback is the machine itself: the portal's own host dials it, and so do the tests. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The host of a URL, lower case, without port or a trailing dot (`fff.tailedfcad.ts.net.` is the same host); undefined when it is no URL. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One `pinnedPortalHosts` entry as a host (w5726 review): a bare host, `host:port` or a whole URL all name the same host,
 * lower case, without a trailing dot. Undefined when it names none.
 */
export function pinnedHostOf(entry: string): string | undefined {
  const e = entry.trim();
  if (!e) return undefined;
  return hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `http://${e}`);
}

/** The hosts this daemon follows: the built-in list and daemon.json's `pinnedPortalHosts`, normalised by pinnedHostOf. */
export function pinnedHosts(extra?: unknown): string[] {
  const more = Array.isArray(extra) ? extra.filter((h): h is string => typeof h === 'string') : [];
  return [...new Set([...PINNED_PORTAL_HOSTS, ...more].map(pinnedHostOf).filter((h): h is string => !!h))];
}

/** Whether `url` names a pinned host (or loopback). */
export function isPinned(url: string, hosts: readonly string[]): boolean {
  const h = hostOf(url);
  return !!h && (LOOPBACK.has(h) || hosts.includes(h));
}

export interface PortalPinWarning {
  at: string;
  /** What was not pinned: `dial` (never refused), `relocate` or `redirect` (refused in enforce mode). */
  kind: 'dial' | 'relocate' | 'redirect';
  what: string;
}

/** What a daemon reports in its hello (w5576): an older portal ignores it. */
export interface PortalPinStatus {
  mode: PortalPinMode;
  /** The host it dials now, and whether it is pinned. */
  host: string;
  pinned: boolean;
  hosts: string[];
  /** The last warnings (newest last), kept across restarts. */
  warnings: PortalPinWarning[];
}

const KEEP = 20;

/** One daemon's pin state: the hosts, and the warnings, kept in `file` (portal-pin.json beside daemon.json). */
export class PortalPin {
  readonly mode: PortalPinMode;
  private readonly hosts: string[];
  private readonly file: string | undefined;
  private readonly log: (line: string) => void;
  private warnings: PortalPinWarning[] = [];

  constructor(hosts: string[], file: string | undefined, log: (line: string) => void, mode: PortalPinMode = PORTAL_PIN_MODE) {
    this.hosts = hosts;
    this.file = file;
    this.log = log;
    this.mode = mode;
    try {
      const kept = file ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { warnings?: unknown }).warnings : undefined;
      if (Array.isArray(kept)) this.warnings = kept.filter((w): w is PortalPinWarning => !!w && typeof (w as PortalPinWarning).at === 'string' && typeof (w as PortalPinWarning).what === 'string').slice(-KEEP);
    } catch {
      // none kept yet, or unreadable: start empty
    }
  }

  /** The file beside daemon.json, or undefined without one. */
  static fileFor(configFile: string | undefined): string | undefined {
    return configFile ? path.join(path.dirname(configFile), 'portal-pin.json') : undefined;
  }

  pinned(url: string): boolean {
    return isPinned(url, this.hosts);
  }

  /**
   * Check `url` for `kind`. True: go ahead. An unpinned one is logged and kept; in enforce mode a relocate or a redirect
   * to it is refused (false). A dial is never refused (w5715): daemon.json's portalUrl and previousPortalUrl were set on
   * the machine itself, and refusing them would leave it with no portal and no updates. Never throws: a broken warning
   * file must not stop a daemon.
   */
  check(kind: PortalPinWarning['kind'], url: string, why: string): boolean {
    if (this.pinned(url)) return true;
    const what = `${why}: ${hostOf(url) ?? url} is not a pinned portal host (${this.hosts.join(', ')})`;
    const refused = this.mode === 'enforce' && kind !== 'dial';
    this.warn(kind, what, refused);
    return !refused;
  }

  /**
   * A redirect of a portal fetch from `from` to another host `to` (portalFetch's sink, wired by the daemon). `refusable`:
   * checked as any redirect (refused in enforce mode when unpinned). Not refusable (the update bundle): an unpinned one is
   * only logged, kept and reported, and followed.
   */
  redirect(from: string, to: string, refusable: boolean): boolean {
    const why = `the portal redirected ${hostOf(from) ?? from} to ${to}`;
    if (refusable) return this.check('redirect', to, why);
    if (!this.pinned(to)) this.warn('redirect', `${why}: ${hostOf(to) ?? to} is not a pinned portal host (${this.hosts.join(', ')})`, false, 'followed, an update download is never refused');
    return true;
  }

  warn(kind: PortalPinWarning['kind'], what: string, refused = this.mode === 'enforce' && kind !== 'dial', followed?: string) {
    const how = refused ? 'REFUSED' : followed ?? (this.mode === 'enforce' ? 'dialled anyway, a dial is never refused' : 'would refuse, allowed in warn mode');
    this.log(`portal pin (w5576, ${this.mode}): ${how}: ${what}`);
    this.warnings = [...this.warnings, { at: new Date().toISOString(), kind, what }].slice(-KEEP);
    try {
      if (this.file) fs.writeFileSync(this.file, JSON.stringify({ warnings: this.warnings }, null, 2));
    } catch (e) {
      this.log(`portal pin: could not keep the warning in ${this.file}: ${(e as Error).message}`);
    }
  }

  status(portalUrl: string): PortalPinStatus {
    return { mode: this.mode, host: hostOf(portalUrl) ?? portalUrl, pinned: this.pinned(portalUrl), hosts: [...this.hosts], warnings: [...this.warnings] };
  }
}

/**
 * One line for list_machines (w5576): the mode, the host it dials and whether it is pinned, and the warnings since
 * `since` (an ISO time; all kept when absent), newest first, at most three quoted.
 */
export function describePortalPin(p: PortalPinStatus | undefined): string {
  if (!p) return 'portal pin: not reported (a daemon from before w5576)';
  // A hello is another machine's data: an odd entry is skipped, never thrown on, so one daemon cannot break list_machines.
  const w = (Array.isArray(p.warnings) ? p.warnings : []).filter((x) => !!x && typeof x === 'object');
  const h = (Array.isArray(p.hosts) ? p.hosts : []).filter((x) => typeof x === 'string');
  const hosts = h.length ? `; follows ${h.join(', ')}` : '';
  const head = `portal pin (w5576): ${p.mode} mode; dials ${p.host}${p.pinned ? ' (pinned)' : ' (NOT pinned)'}${hosts}`;
  if (!w.length) return `${head}; no warnings`;
  const last = w.slice(-3).reverse().map((x) => `${x.at} ${x.kind}: ${x.what}`).join(' | ');
  return `${head}; ${w.length} warning${w.length === 1 ? '' : 's'} kept, newest first: ${last}`;
}

/**
 * Where portalFetch asks about a redirect to another host (the daemon sets it to PortalPin.redirect; none in tests or the
 * update job, which then follow every redirect). It answers whether to follow it: false refuses it (enforce mode, an
 * unpinned host, a refusable fetch).
 */
export type PortalRedirectSink = (from: string, to: string, refusable: boolean) => boolean | void;
let redirectSink: PortalRedirectSink | undefined;

export function onPortalRedirect(sink: PortalRedirectSink | undefined) {
  redirectSink = sink;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * fetch for a portal URL that follows redirects itself (w5715; w5726 review, finding 3): each hop is checked BEFORE it is
 * followed, so no token and no upload body goes to a host this daemon does not follow.
 * - A hop to the host being fetched is always followed (http to https, a slash added): a machine whose daemon.json
 *   portalUrl is not pinned (recovery route 2(b)) must still reach its portal (w5726 finding 2).
 * - A hop to another host asks the sink: refused (throws refusedRedirect with `final: true`, nothing sent there) when
 *   it answers false and `refuse` is not false.
 * - `refuse: false` (the update bundle): an unpinned hop is only reported, then followed. The bundle is checked against
 *   the SHA-256 its link message carries and the commit against GitHub main (selfUpdate.ts), so a redirect cannot change
 *   what installs, and a pin must never stop the update link (lothsahn, w5576: no machine may be locked out of updates).
 * As fetch does: a 303, and a 301/302 of a POST, become a GET without a body; 307 and 308 keep both; the Authorization
 * header goes on only to the same host.
 */
export async function portalFetch(url: string, init: RequestInit = {}, o: { fetch?: typeof fetch; refuse?: boolean } = {}): Promise<Response> {
  const doFetch = o.fetch ?? fetch;
  const first = hostOf(url);
  let cur = url;
  let req: RequestInit = init;
  for (let hop = 0; ; hop++) {
    const res = await doFetch(cur, { ...req, redirect: 'manual' });
    const loc = REDIRECT_STATUS.has(res.status) ? res.headers?.get?.('location') : null;
    if (!loc) return res;
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error(`the portal redirected ${hostOf(url) ?? url} more than ${MAX_REDIRECTS} times`);
    let next: string;
    try {
      next = new URL(loc, cur).toString();
    } catch {
      throw new Error(`the portal redirected ${hostOf(cur) ?? cur} to ${loc}, which is no URL`);
    }
    const to = hostOf(next);
    const sameHost = !!to && (to === hostOf(cur) || to === first);
    if (!sameHost && redirectSink?.(cur, next, o.refuse !== false) === false && o.refuse !== false) {
      throw Object.assign(refusedRedirect(url, { url: next }), { final: true });
    }
    const method = (req.method ?? 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) req = { ...req, method: method === 'HEAD' ? 'HEAD' : 'GET', body: undefined };
    if (to !== hostOf(cur)) {
      const h = new Headers(req.headers);
      h.delete('authorization');
      req = { ...req, headers: h };
    }
    cur = next;
  }
}

/** The error a caller throws for a refused redirect. */
export function refusedRedirect(requested: string, res: { url?: string }): Error {
  return new Error(`the portal's answer for ${hostOf(requested) ?? requested} came through a redirect to ${hostOf(res.url ?? '') ?? res.url}, not a pinned portal host (w5715, docs/portal-pin.md): refused`);
}

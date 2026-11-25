// The portal hosts a daemon follows (w5576, docs/portal-pin.md): a taken-over portal must not move a worker machine to an
// address it chose. The hosts a daemon trusts ship in this file, so they change only with an update of the daemon's own
// code, and an update installs only a commit published on GitHub's ff-factory main (w5516, machine/selfUpdate.ts
// checkPublished). A daemon.json `pinnedPortalHosts` adds hosts on one machine: a person or the ops worker edits it by hand
// over ssh (no installer flag writes it; an installer rerun keeps it), and nothing sent over the link can (patchDaemonConfig takes only the relocate fields).
//
// Stage 1, warn (this file's PORTAL_PIN_MODE): what pinning would refuse is logged, kept in portal-pin.json beside
// daemon.json and reported in the hello (`portalPin`, list_machines shows it), and goes ahead as before. Enforcement is a
// later, separate change once every machine has reported clean here.
//
// No npm imports: the update job (scripts/worker/linkJob.ts) may load modules from a checkout without node_modules.
import fs from 'node:fs';
import path from 'node:path';

export type PortalPinMode = 'warn' | 'enforce';

/** Stage 1 of w5576: warn only. */
export const PORTAL_PIN_MODE: PortalPinMode = 'warn';

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

/** The host of a URL, lower case, without port; undefined when it is no URL. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** The hosts this daemon follows: the built-in list and daemon.json's `pinnedPortalHosts`, lower case. */
export function pinnedHosts(extra?: unknown): string[] {
  const more = Array.isArray(extra) ? extra.filter((h): h is string => typeof h === 'string' && h.trim() !== '') : [];
  return [...new Set([...PINNED_PORTAL_HOSTS, ...more].map((h) => h.trim().toLowerCase()))];
}

/** Whether `url` names a pinned host (or loopback). */
export function isPinned(url: string, hosts: readonly string[]): boolean {
  const h = hostOf(url);
  return !!h && (LOOPBACK.has(h) || hosts.includes(h));
}

export interface PortalPinWarning {
  at: string;
  /** What pinning would have refused: `dial`, `relocate` or `redirect`. */
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
   * Check `url` for `kind`. True: go ahead. In warn mode an unpinned one is logged and kept, and still goes ahead; in
   * enforce mode it is refused (false). Never throws: a broken warning file must not stop a daemon.
   */
  check(kind: PortalPinWarning['kind'], url: string, why: string): boolean {
    if (this.pinned(url)) return true;
    const what = `${why}: ${hostOf(url) ?? url} is not a pinned portal host (${this.hosts.join(', ')})`;
    this.warn(kind, what);
    return this.mode !== 'enforce';
  }

  warn(kind: PortalPinWarning['kind'], what: string) {
    const refused = this.mode === 'enforce';
    this.log(`portal pin (w5576, ${this.mode}): ${refused ? 'REFUSED' : 'would refuse, allowed in warn mode'}: ${what}`);
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

/** Where a fetch to the portal reports a redirect (the daemon sets it; none in tests or the update job). */
let redirectSink: ((from: string, to: string) => void) | undefined;

export function onPortalRedirect(sink: ((from: string, to: string) => void) | undefined) {
  redirectSink = sink;
}

/**
 * After a fetch to the portal: a response that came through a redirect is reported (warn mode: it is used as before).
 */
export function notePortalRedirect(requested: string, res: { redirected?: boolean; url?: string }) {
  if (res.redirected && res.url && res.url !== requested) redirectSink?.(requested, res.url);
}

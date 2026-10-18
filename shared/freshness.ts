// A page open across a deploy keeps running the old UI against the new server. The server names the web
// UI build it serves (server/webStatic.ts); the page compares it with the build it loaded and reloads
// (web/src/freshness.ts). The rules are here, so the tests can reach them (w1489: the reload is automatic;
// what a reload would lose is saved first, and a page with something it cannot save waits for it).

/** The <meta name=…> in index.html that carries the build the page was served. */
export const BUILD_META = 'ff-build';

/**
 * How long after the last key or pointer press a page still counts as being typed in. The composer saves its draft a
 * moment after typing stops and at once when the page goes, so this is only for an input method mid-word and a
 * hand still on the keys.
 */
export const IDLE_MS = 1500;

/** Tabs spread their reload over this long after the new build is seen, so a deploy does not send them all at once. */
export const JITTER_MS = 8000;

/** What a page does when the server says it serves a build other than the one it loaded. */
export type FreshnessAction = 'none' | 'wait' | 'reload' | 'banner';

/**
 * How much a reload now would lose. 'none': nothing (or only what is saved and put back). 'soon': a hand is on the keys or
 * an input method is mid-word: it passes by itself, so the page waits quietly. 'blocked': something that cannot be put back
 * (a form open, a file attached and not sent, text in a box that keeps no draft): the page waits for it and offers the reload.
 */
export type Busy = 'none' | 'soon' | 'blocked';

export function freshnessAction(o: {
  /** The build the page loaded; undefined for a dev server's page, which never reloads. */
  loaded: string | undefined;
  /** The build the server serves now; undefined from a server older than this, or while the UI is not built. */
  served: string | undefined;
  /** The build the page last reloaded to get: reloaded once and still not it, it does not loop. */
  triedFor: string | null;
  /** What a reload would lose now (see Busy). */
  busy: Busy;
  /** The new build answered /api/health and serves the page of that build (a draining or starting portal does not). */
  healthy: boolean;
}): FreshnessAction {
  if (!o.loaded || !o.served || o.loaded === o.served) return 'none';
  if (o.triedFor === o.served) return 'banner';
  if (!o.healthy) return 'wait';
  if (o.busy === 'blocked') return 'banner';
  return o.busy === 'soon' ? 'wait' : 'reload';
}

/** A text box on the page, as the busy rule sees it. */
export interface FieldLook {
  /** The page saves what it holds before a reload and puts it back (the message box, a deny note). */
  kept: boolean;
  empty: boolean;
}

export interface PageLook {
  /** Holds (a message on its way, a picture attached) taken with holdReload. */
  holds: number;
  /** Files attached to a chat and not yet sent. */
  pendingFiles: boolean;
  /** A dialog or drawer is open. */
  modalOpen: boolean;
  fields: FieldLook[];
  /** Milliseconds since the last key or pointer press on this page; undefined when there has been none. */
  sinceInputMs: number | undefined;
  /** An input method is composing a word. */
  composing: boolean;
}

/** The wait-while-typing rule: whether a reload now would lose something, and whether that is over in a moment. */
export function busyLevel(p: PageLook): Busy {
  if (p.holds > 0 || p.pendingFiles || p.modalOpen) return 'blocked';
  if (p.fields.some((f) => !f.kept && !f.empty)) return 'blocked';
  if (p.composing || (p.sinceInputMs !== undefined && p.sinceInputMs < IDLE_MS)) return 'soon';
  return 'none';
}

/** Whether /api/health's answer (and the page the server serves) is the new build, up. */
export function healthyFor(served: string, health: { ok?: unknown; web?: unknown } | undefined, pageBuild: string | undefined): boolean {
  return !!health && health.ok === true && health.web === served && pageBuild === served;
}

/** When the reload of this tab happens, within JITTER_MS (`rand` is Math.random()). */
export function reloadJitterMs(rand: number): number {
  return Math.floor(Math.min(Math.max(rand, 0), 0.999999) * JITTER_MS);
}

/** How long to wait before asking /api/health again after the `n`th refusal (1-based): 2 s, 4 s … 30 s. */
export function healthRetryMs(n: number): number {
  return Math.min(30_000, 2000 * 2 ** Math.max(0, n - 1));
}

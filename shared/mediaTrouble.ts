/**
 * A still a page could not show (w2576): it failed, or it stayed blank on screen. The page tells the portal what its own
 * browser saw, so a person's view of a card can be read in the portal's journal without their login or a screenshot.
 */
export interface MediaTrouble {
  /** Where the still is drawn: "card" (a question card's thumbnails) or "text" (an image in Markdown). */
  surface: string;
  /** "error": the browser gave up on it; "blank": on screen this long and still not drawn. */
  kind: 'error' | 'blank';
  /** The `/api/image` (or other) URL the page asked for, relative to the portal. */
  src: string;
  /** The page's route (`#/dispatcher/waiting`), without anything after a `?`. */
  page?: string;
  /** How many requests the browser's resource timing lists for it (0: it never asked). */
  requests?: number;
  /** The last request's HTTP status (0: unknown, as Safari and Firefox do not say), bytes received and milliseconds. */
  status?: number;
  bytes?: number;
  ms?: number;
  /** The image element's own state. */
  complete?: boolean;
  naturalWidth?: number;
}

/** How long a still may stay blank on screen before the page reports it. */
export const BLANK_AFTER_MS = 15_000;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined);
const word = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').slice(0, max) : '');

/** A report from a page, checked and clipped; undefined when it is not one. */
export function cleanMediaTrouble(b: unknown): MediaTrouble | undefined {
  if (!b || typeof b !== 'object') return undefined;
  const r = b as Record<string, unknown>;
  const kind = r.kind === 'error' || r.kind === 'blank' ? r.kind : undefined;
  const src = word(r.src, 600);
  if (!kind || !src) return undefined;
  const out: MediaTrouble = { surface: word(r.surface, 20) || '?', kind, src };
  const page = word(r.page, 80).split('?')[0];
  if (page) out.page = page;
  for (const k of ['requests', 'status', 'bytes', 'ms', 'naturalWidth'] as const) {
    const n = num(r[k]);
    if (n !== undefined) out[k] = n;
  }
  if (typeof r.complete === 'boolean') out.complete = r.complete;
  return out;
}

/** The still's file path from its `/api/image` URL, or the URL itself. */
function shownPath(src: string): string {
  try {
    const u = new URL(src, 'http://portal');
    const p = u.searchParams.get('path');
    if (u.pathname === '/api/image' && p) return `${p}${u.searchParams.get('session') ? ` (session ${u.searchParams.get('session')})` : ''}${u.searchParams.get('machine') ? ` (machine ${u.searchParams.get('machine')})` : ''}`;
  } catch {
    // not a URL: shown as it is
  }
  return src;
}

/** One journal line: who, where, what the browser saw. */
export function mediaTroubleLine(who: string, t: MediaTrouble, agent: string): string {
  const seen = t.requests === undefined ? 'requests ?' : t.requests === 0 ? 'never requested' : `requests ${t.requests}, last: status ${t.status || '?'}, ${t.bytes ?? '?'} B, ${t.ms ?? '?'} ms`;
  return `[media] ${who}'s page could not show a still (${t.kind}${t.kind === 'blank' ? ` ${BLANK_AFTER_MS / 1000}s on screen` : ''}) in ${t.surface} on ${t.page ?? '?'}: ${shownPath(t.src)}; ${seen}; complete ${t.complete ?? '?'}, width ${t.naturalWidth ?? '?'}; ${word(agent, 120)}`;
}

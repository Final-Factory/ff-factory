import { BLANK_AFTER_MS, type MediaTrouble } from '../../shared/mediaTrouble';

/**
 * Stills a page could not show, told to the portal (w2576, shared/mediaTrouble.ts): one that failed, and one on screen
 * for BLANK_AFTER_MS and still not drawn, with what this browser's resource timing saw of its request. The portal writes
 * one journal line each, so a blank card can be explained without the person's login or a screenshot.
 */
const reported = new Set<string>();
// The default buffer (250) fills on a busy page, and a full one would read as "never requested".
try {
  performance.setResourceTimingBufferSize(5000);
} catch {
  // not offered: the default buffer
}

export function reportStill(img: HTMLImageElement, surface: string, kind: MediaTrouble['kind']) {
  const src = img.getAttribute('src') ?? '';
  if (!src || src.startsWith('data:') || reported.has(`${kind} ${src}`)) return;
  reported.add(`${kind} ${src}`);
  const entries = performance.getEntriesByName(new URL(src, location.href).href, 'resource') as PerformanceResourceTiming[];
  const last = entries[entries.length - 1] as (PerformanceResourceTiming & { responseStatus?: number }) | undefined;
  const body: MediaTrouble = {
    surface,
    kind,
    src,
    page: location.hash.split('?')[0],
    requests: entries.length,
    ...(last ? { status: last.responseStatus ?? 0, bytes: last.encodedBodySize, ms: last.duration } : {}),
    complete: img.complete,
    naturalWidth: img.naturalWidth,
  };
  void fetch('/api/client/media-trouble', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => undefined);
}

const timers = new WeakMap<HTMLImageElement, number>();
const nudges = new WeakMap<HTMLImageElement, number>();

/**
 * A still on screen this long and never asked for is asked for again, eagerly (w2664): on 2026-10-31 Ben's Firefox 158
 * left the stills of options C and D on screen and blank, and its resource timing never saw a request for them
 * ("never requested", journal 20:44 to 20:50 UTC), while the server logged no error. A lazy still that the browser
 * never fetched is fetched now; one whose request is under way is left alone.
 */
export const NUDGE_AFTER_MS = 4000;
function nudge(img: HTMLImageElement) {
  if (!img.isConnected || img.naturalWidth > 0 || img.complete) return;
  const src = img.getAttribute('src');
  if (!src || src.startsWith('data:') || performance.getEntriesByName(new URL(src, location.href).href, 'resource').length) return;
  img.loading = 'eager';
  img.src = src;
}
const surfaces = new WeakMap<HTMLImageElement, string>();
let observer: IntersectionObserver | undefined;
const watcher = () =>
  (observer ??= new IntersectionObserver((list) => {
    for (const e of list) {
      const img = e.target as HTMLImageElement;
      clearTimeout(timers.get(img));
      clearTimeout(nudges.get(img));
      if (!e.isIntersecting || img.naturalWidth > 0) continue;
      nudges.set(img, window.setTimeout(() => nudge(img), NUDGE_AFTER_MS));
      timers.set(
        img,
        window.setTimeout(() => {
          if (img.isConnected && img.naturalWidth === 0) reportStill(img, surfaces.get(img) ?? '?', 'blank');
        }, BLANK_AFTER_MS),
      );
    }
  }));

const refs = new Map<string, (img: HTMLImageElement | null) => void>();
const watched = new Set<HTMLImageElement>();

/** A ref for a still: watched while it is on the page (one function per surface, so a re-render does not restart it). */
export function watchStill(surface: string): (img: HTMLImageElement | null) => void {
  let ref = refs.get(surface);
  if (!ref) {
    ref = (img) => {
      if (typeof IntersectionObserver === 'undefined') return;
      if (img) {
        surfaces.set(img, surface);
        watched.add(img);
        watcher().observe(img);
        return;
      }
      // React passes null when an element goes: stop watching the ones that left the page.
      for (const x of watched) {
        if (x.isConnected) continue;
        watched.delete(x);
        clearTimeout(timers.get(x));
        clearTimeout(nudges.get(x));
        observer?.unobserve(x);
      }
    };
    refs.set(surface, ref);
  }
  return ref;
}

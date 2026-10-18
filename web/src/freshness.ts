// A tab left open across a deploy would keep running the old UI against the new server (w285: the FFBox
// panes that did not scroll, the red dot that never showed). The server names the build it serves
// (server/webStatic.ts: index.html's <meta>, and `app.web` in the state and /api/health); when it differs
// from the build this page loaded, the page reloads itself (w1489). Not before the new build answers /api/health
// and serves its own page (a draining or starting portal does not), and not at the same moment as every other tab
// (a few seconds' spread). What a reload would lose is kept first: the message boxes' drafts, the card forms, the
// chats' scroll places (web/src/keep.ts). What cannot be kept (a picture attached, a form open, text in a box that
// keeps no draft) makes the page wait, with a bar offering the reload meanwhile; a hand on the keys makes it wait
// quietly. The page looks again every second until the way is clear.
import { useSyncExternalStore } from 'react';
import { BUILD_META, busyLevel, freshnessAction, healthRetryMs, healthyFor, reloadJitterMs, type Busy, type FieldLook } from '../../shared/freshness';
import { savePage } from './keep';
import { hasPendingFiles } from './upload';

const loaded = document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META}"]`)?.content || undefined;
/** The build the last automatic reload went for (per tab): a reload that does not bring it is not repeated. */
const TRIED = 'ffsb.reloadedFor';
/** How often a page that waits (for a hand off the keys, for a box to be emptied) looks again. */
const LOOK_MS = 1000;

function triedFor(): string | null {
  try {
    return sessionStorage.getItem(TRIED);
  } catch {
    return null;
  }
}

function setTried(build: string | undefined) {
  try {
    if (build) sessionStorage.setItem(TRIED, build);
    else sessionStorage.removeItem(TRIED);
  } catch {
    /* ignore */
  }
}

if (loaded && triedFor() === loaded) setTried(undefined);

let served: string | undefined;
/** The build /api/health and the page itself confirmed. */
let healthy: string | undefined;
let offer = false;
const holds = new Set<string>();
const listeners = new Set<() => void>();

// ---- is a hand on the keys ----
let lastInput: number | undefined;
let composing = false;
for (const t of ['keydown', 'input', 'pointerdown', 'paste']) document.addEventListener(t, () => (lastInput = performance.now()), { capture: true, passive: true });
document.addEventListener('compositionstart', () => (composing = true), true);
document.addEventListener('compositionend', () => (composing = false), true);

const FIELDS = 'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="file"], [type="range"], [type="hidden"], [type="color"])';

function look(): FieldLook[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FIELDS), (el) => ({
    kept: !!el.closest('[data-kept]'),
    empty: !((el as HTMLInputElement).value ?? el.textContent ?? '').trim(),
  }));
}

/** What a reload now would lose (shared/freshness.ts busyLevel). */
function busy(): Busy {
  return busyLevel({
    holds: holds.size,
    pendingFiles: hasPendingFiles(),
    modalOpen: !!document.querySelector('[aria-modal]'),
    fields: look(),
    sinceInputMs: lastInput === undefined ? undefined : performance.now() - lastInput,
    composing,
  });
}

let timer: ReturnType<typeof setTimeout> | undefined;
const later = (ms: number, fn: () => void) => {
  clearTimeout(timer);
  timer = setTimeout(fn, ms);
};

function check() {
  clearTimeout(timer);
  const action = freshnessAction({ loaded, served, triedFor: triedFor(), busy: busy(), healthy: !!served && healthy === served });
  if (action === 'reload') return reloadNow();
  const banner = action === 'banner';
  if (offer !== banner) {
    offer = banner;
    listeners.forEach((l) => l());
  }
  // Waiting: for the new build to answer, or for the way to be clear. 'banner' for a loop-guarded reload waits for the person.
  if (action === 'wait' || (banner && triedFor() !== served)) later(LOOK_MS, check);
}

let confirming: string | undefined;

/** Ask /api/health and the page itself until `build` is what they serve, after the tab's own few seconds' wait. */
async function confirm(build: string) {
  if (confirming === build) return;
  confirming = build;
  await new Promise((r) => setTimeout(r, reloadJitterMs(Math.random())));
  for (let n = 1; served === build; n++) {
    try {
      const h = await fetch('/api/health', { cache: 'no-store' });
      const health = h.ok ? ((await h.json()) as { ok?: unknown; web?: unknown }) : undefined;
      const page = health ? await (await fetch('/', { cache: 'no-store' })).text() : '';
      const pageBuild = new RegExp(`<meta[^>]*name="${BUILD_META}"[^>]*content="([^"]*)"`).exec(page)?.[1];
      if (healthyFor(build, health, pageBuild)) {
        healthy = build;
        break;
      }
    } catch {
      /* the portal is down or restarting: try again */
    }
    await new Promise((r) => setTimeout(r, healthRetryMs(n)));
  }
  confirming = undefined;
  check();
}

/** The server's build, from the state it sent (every connect, so after each restart) or from /api/health. */
export function noteServedBuild(build: string | undefined) {
  if (!build) return;
  if (build !== served) healthy = undefined;
  served = build;
  if (loaded && build !== loaded && triedFor() !== build) void confirm(build);
  check();
}

export function reloadNow() {
  setTried(served);
  savePage();
  location.reload();
}

async function askServer() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) noteServedBuild(((await r.json()) as { web?: string }).web);
  } catch {
    /* offline: the socket's reconnect brings the state */
  }
}

/** While `on`, keep this page (something a reload would lose, such as images attached to an unsent message). */
export function holdReload(key: string, on: boolean) {
  if (on) holds.add(key);
  else if (holds.delete(key)) check();
}

/** Whether a newer build waits for the user's reload. */
export function useNewVersion(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => offer,
  );
}

if (loaded) {
  // Back from the background (a rebuild without a restart says nothing over the socket): ask.
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? void askServer() : check()));
  // A lazily loaded part (the diagram renderer) whose file a rebuild removed: this page is out of date.
  window.addEventListener('vite:preloadError', () => void askServer());
}

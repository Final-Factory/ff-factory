// The page's saved copy of its last state (w6763). A fresh load used to wait for the socket's whole first state:
// 4.3-4.6 MB, about 1,000-1,100 sessions, 1.4-10.3 s to 'ready' over Funnel on 2026-11-27 (median 3.2 s) while the
// server built it in 0.15-0.55 s. Now the page keeps its last live state in IndexedDB (web/src/pageCache.ts), draws it
// at once on the next load, and opens its socket as a reconnect does: the copy's sessions rev and parts' hashes, so the
// server sends only what changed since (shared/pageSessions.ts, shared/pageParts.ts). The page then shows what a
// fresh load shows: the delta lands on the copy exactly as a reconnect's lands on the page's own state.
import type { AppState } from './types.ts';
import { fillKeptParts, partsHave } from './pageParts.ts';
import { mergeSessions } from './pageSessions.ts';

export const PAGE_CACHE_V = 1;
/** A copy older than this is not drawn (it may still be the base the delta lands on). */
export const PAGE_CACHE_SHOW_MS = 24 * 3_600_000;
/** A visible page saves its state at most this often; a tab saves once more as it is hidden or closed. */
export const PAGE_CACHE_SAVE_EVERY_MS = 60_000;
/** How long the boot waits for IndexedDB before it opens the socket without the copy. */
export const PAGE_CACHE_READ_WAIT_MS = 400;

export interface PageCacheRecord {
  v: typeof PAGE_CACHE_V;
  /** Whose state it is (UserInfo.userId): the server ignores the copy's rev and hashes for anyone else. */
  user: string;
  /** The web build that saved it: only a copy of this page's own build is drawn (an older build's state may lack a field this one reads). */
  build: string;
  savedAt: number;
  app: AppState;
}

/** What the page saves: its live state, without the per-connect fields a delta carries. */
export function cacheRecord(app: AppState, build: string | undefined, now: number): PageCacheRecord | undefined {
  const user = app.me?.userId;
  if (!user || !build || !app.sessionsRev) return undefined;
  return { v: PAGE_CACHE_V, user, build, savedAt: now, app: { ...app, sessionsDelta: undefined, partsKept: undefined, workDelta: undefined } };
}

export interface PageBoot {
  /** The state a first delta lands on. */
  base: AppState;
  user: string;
  /** Draw `base` now: this page's build, saved in the last PAGE_CACHE_SHOW_MS. */
  show: boolean;
  savedAt: number;
}

/** A saved copy read back, or undefined when it is not one this page can use. */
export function bootFrom(raw: unknown, build: string | undefined, now: number): PageBoot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<PageCacheRecord>;
  if (r.v !== PAGE_CACHE_V || typeof r.user !== 'string' || !r.user || typeof r.build !== 'string' || typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return undefined;
  const app = r.app;
  if (!app || typeof app !== 'object' || !Array.isArray(app.sessions) || typeof app.sessionsRev !== 'string' || app.me?.userId !== r.user) return undefined;
  const age = now - r.savedAt;
  return { base: app, user: r.user, show: !!build && r.build === build && age >= 0 && age < PAGE_CACHE_SHOW_MS, savedAt: r.savedAt };
}

/** What the first socket of a page with a saved copy sends: the copy's rev, its parts' hashes and whose it is. */
export function bootQuery(boot: PageBoot): { have: string | undefined; parts: string | undefined; u: string } {
  return { have: boot.base.sessionsRev, parts: partsHave(boot.base), u: boot.user };
}

/** The server takes a page's rev and hashes only from a copy of the signed-in person's (`u` absent: a page's own state). */
export function holdsOwnCopy(u: string | null | undefined, user: string | undefined): boolean {
  return u === null || u === undefined || u === user;
}

/**
 * The page's state once `next` arrives on what it holds (`had`: its state, or the saved copy on a first connect).
 * Undefined when `next` leaves out something `had` lacks: the page then fetches the whole state. `missing`: sessions a
 * delta lists that `had` has no copy of (the page fetches them by id).
 */
export function applyState(had: AppState | null | undefined, next: AppState, extra: ReadonlySet<string>): { app: AppState; missing: string[] } | undefined {
  const app = fillKeptParts(had, next);
  if (!app || (app.sessionsDelta && !had)) return undefined;
  const { sessions, missing } = mergeSessions(had?.sessions, app, extra);
  return { app: { ...app, sessions, sessionsDelta: undefined }, missing };
}

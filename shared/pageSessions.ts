// The page's session list across reconnects (w5907). On open the server sends the sessions the page shows (live, recent,
// named; server/pageState.ts keepsOnPage); a page that reconnects soon after a drop sends back the `sessionsRev` it holds
// and gets only the sessions that changed since, with the ids of all it should keep (AppState.sessionsDelta).
import type { AppState, SessionInfo } from './types.ts';

/**
 * A page away longer than this asks for the whole list again rather than what changed: a short gap is the Funnel drop
 * (lothsahn's sockets closed 'by network' about 30 times in 2 h on 2026-11-25, many within 0-7 s of opening, each
 * reconnect resending all 11.5 MB), a long one a laptop that slept.
 */
export const SESSIONS_DELTA_MAX_GAP_MS = 10 * 60_000;

/** The `have` a reconnecting page sends on /ws: its sessions' rev, while the gap is short. */
export function sessionsHave(app: Pick<AppState, 'sessionsRev'> | undefined, gapMs: number): string | undefined {
  return app?.sessionsRev && gapMs >= 0 && gapMs <= SESSIONS_DELTA_MAX_GAP_MS ? app.sessionsRev : undefined;
}

/**
 * The page's sessions once `next` arrives. A whole list replaces what the page had, except the older sessions a view
 * fetched by id (`extra`). A delta keeps the page's own copies of the ids it lists, takes the changed ones from it,
 * and keeps `extra`. `missing`: ids the delta lists that the page has no copy of (it fetches them).
 */
export function mergeSessions(had: readonly SessionInfo[] | undefined, next: Pick<AppState, 'sessions' | 'sessionsDelta'>, extra: ReadonlySet<string>): { sessions: SessionInfo[]; missing: string[] } {
  const keepExtra = (had ?? []).filter((s) => extra.has(s.id));
  if (!next.sessionsDelta) {
    const ids = new Set(next.sessions.map((s) => s.id));
    return { sessions: [...next.sessions, ...keepExtra.filter((s) => !ids.has(s.id))], missing: [] };
  }
  const byId = new Map((had ?? []).map((s) => [s.id, s]));
  for (const s of next.sessions) byId.set(s.id, s);
  const out: SessionInfo[] = [];
  const missing: string[] = [];
  const listed = new Set<string>();
  for (const id of next.sessionsDelta.ids) {
    listed.add(id);
    const s = byId.get(id);
    if (s) out.push(s);
    else missing.push(id);
  }
  for (const s of keepExtra) if (!listed.has(s.id)) out.push(s);
  return { sessions: out, missing };
}

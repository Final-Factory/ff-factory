// The page's session list across reconnects (w5907). On open the server sends the sessions the page shows (live, recent,
// named; server/pageState.ts keepsOnPage); a page that reconnects soon after a drop sends back the `sessionsRev` it holds
// and gets only the sessions that changed since, with the ids of all it should keep (AppState.sessionsDelta).
import type { AppState, SessionInfo } from './types.ts';

/**
 * The `have` a reconnecting page sends on /ws: its sessions' rev, after any gap (w6456). Until then a page away over
 * 10 minutes asked for the whole list: 1.9-4.5 MB per reconnect on 2026-11-27, about 30 of ben's tabs at once at 16:09Z.
 * The server decides what a token is still good for (server/pageState.ts SessionRevs.since: this run, or an earlier
 * run's up to its saved rev), and a delta is never more than the whole list and its ids.
 */
export function sessionsHave(app: Pick<AppState, 'sessionsRev'> | undefined, gapMs: number): string | undefined {
  return app?.sessionsRev && gapMs >= 0 ? app.sessionsRev : undefined;
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

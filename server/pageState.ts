// The sessions as the dashboard page gets them in AppState (w5861). AppState lists every session a portal ever ran (4,700
// on 2026-11-25), and the page's first state had reached 18 MB of JSON: lothsahn waited 5-10 s for the page to connect
// over Funnel, and a socket whose first message was still downloading missed its pong and was dropped. The page reads
// only some of each session's fields; the rest stay on the server (store.sessions) and in its session events.
import type { SessionInfo, WorkItem } from '../shared/types.ts';

/**
 * Session fields no code the page runs reads (web/src and the shared modules it imports). Kept out of the page's state;
 * pageState.test.ts fails when page code starts to read one, so take it off this list then.
 */
export const PAGE_OMITTED_SESSION_FIELDS = [
  'labelAt',
  'timedVerdict',
  'followUpOn',
  'sdkSessionId',
  'ranAs',
  'ranFor',
  'ranOn',
  'sdkCostUsd',
  'peopleMessaged',
  'lastTurnCostUsd',
  'compactOwed',
  'movedAway',
  'reclaimed',
  'preempted',
  'releaseSwitch',
  'savedWork',
  'movedFrom',
  'liveLost',
] as const satisfies readonly (keyof SessionInfo)[];

/**
 * A worker's last report (up to about 2,000 characters each) is read by the page only for the requests it shows
 * (shared/workState.ts, through WorkItem.sessionIds). A session none of them names, idle this long, goes without it.
 */
export const PAGE_RESULT_KEEP_MS = 3 * 86_400_000;

/** `sessions` as the page gets them: without the fields it never reads, and without old reports no shown request needs. */
export function pageSessions(sessions: Iterable<SessionInfo>, work: readonly Pick<WorkItem, 'sessionIds'>[], now: number): SessionInfo[] {
  const named = new Set<string>();
  for (const w of work) for (const id of w.sessionIds) named.add(id);
  const out: SessionInfo[] = [];
  for (const s of sessions) {
    const p: Partial<SessionInfo> = { ...s };
    for (const k of PAGE_OMITTED_SESSION_FIELDS) delete p[k];
    if (p.lastResult !== undefined && !named.has(s.id) && !(now - (Date.parse(s.lastActivityAt) || 0) < PAGE_RESULT_KEEP_MS)) delete p.lastResult;
    out.push(p as SessionInfo);
  }
  return out;
}

/**
 * Where a state's bytes go, for the log (w5861): its biggest top-level fields, and the biggest fields of its sessions,
 * in KB of JSON. One stringify of each part: call it rarely (pageStateSizes in index.ts, at most once an hour).
 */
export function stateSizes(state: object, top = 6): string {
  const kb = (n: number) => `${Math.round(n / 1024)}KB`;
  const parts = Object.entries(state).map(([k, v]) => [k, JSON.stringify(v ?? null).length] as const);
  parts.sort((a, b) => b[1] - a[1]);
  const sessions = (state as { sessions?: unknown }).sessions;
  const byField = new Map<string, number>();
  if (Array.isArray(sessions)) {
    for (const s of sessions) for (const [k, v] of Object.entries(s as object)) byField.set(k, (byField.get(k) ?? 0) + k.length + 4 + JSON.stringify(v ?? null).length);
  }
  const fields = [...byField].sort((a, b) => b[1] - a[1]).slice(0, top);
  const n = Array.isArray(sessions) ? sessions.length : 0;
  return `${parts.slice(0, top).map(([k, b]) => `${k} ${kb(b)}`).join(', ')}; ${n} sessions, by field: ${fields.map(([k, b]) => `${k} ${kb(b)}`).join(', ')}`;
}

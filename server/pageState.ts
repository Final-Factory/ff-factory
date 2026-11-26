// The sessions as the dashboard page gets them in AppState (w5861). AppState lists every session a portal ever ran (4,700
// on 2026-11-25), and the page's first state had reached 18 MB of JSON: lothsahn waited 5-10 s for the page to connect
// over Funnel, and a socket whose first message was still downloading missed its pong and was dropped. The page reads
// only some of each session's fields; the rest stay on the server (store.sessions) and in its session events.
import { holdsItsPlace, holdsSandbox } from '../shared/agentState.ts';
import type { AppState, Machine, SessionInfo, StandingAgent, WorkItem } from '../shared/types.ts';

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

/**
 * How long a finished session stays on the page's open (w5907): the requests the page shows are the open ones and those
 * of the last 3 days too (Orchestrators.forPage). An older one comes when a view asks for it (GET /api/sessions?ids=).
 */
export const PAGE_SESSION_KEEP_MS = 3 * 86_400_000;

/** How many of a sandbox's newest agents the page gets whatever their age: its tab strip's (PanelChrome AgentTabs). */
export const PAGE_SANDBOX_RECENT = 12;

/** One session as the page gets it: without the fields it never reads, and without an old report no shown request needs. */
export function pageSession(s: SessionInfo, named: ReadonlySet<string>, now: number): SessionInfo {
  const p: Partial<SessionInfo> = { ...s };
  for (const k of PAGE_OMITTED_SESSION_FIELDS) delete p[k];
  if (p.lastResult !== undefined && !named.has(s.id) && !(now - (Date.parse(s.lastActivityAt) || 0) < PAGE_RESULT_KEEP_MS)) delete p.lastResult;
  return p as SessionInfo;
}

/**
 * Whether the page gets this session on open (w5907; 13,265 sessions and 8.9 MB of the 11.5 MB state on 2026-11-25):
 * one the state names (a shown request's worker, the home chats, a standing agent's, a sandbox's newest), every chat,
 * every one not stopped, one that still holds or will come back to its sandbox, and one active in the last 3 days.
 */
export function keepsOnPage(s: SessionInfo, named: ReadonlySet<string>, now: number): boolean {
  if (named.has(s.id) || s.kind === 'orchestrator') return true;
  if (s.status !== 'stopped' && s.status !== 'error') return true;
  if (s.pendingPermissions?.length || s.wakeAt || s.queuedSend || holdsSandbox(s, now) || holdsItsPlace(s, now)) return true;
  return now - (Date.parse(s.lastActivityAt) || 0) < PAGE_SESSION_KEEP_MS;
}

/** What the state names that the page looks up in its sessions (keepsOnPage keeps these whatever their age). */
export function pageNamedSessions(parts: {
  work: readonly Pick<WorkItem, 'sessionIds'>[];
  ids?: readonly (string | undefined)[];
  standing?: readonly Pick<StandingAgent, 'sessionId'>[];
  machines?: readonly Pick<Machine, 'sandboxes'>[];
  live?: readonly { sessionId: string }[];
}): Set<string> {
  const named = new Set<string>();
  for (const w of parts.work) for (const id of w.sessionIds) named.add(id);
  for (const id of parts.ids ?? []) if (id) named.add(id);
  for (const a of parts.standing ?? []) if (a.sessionId) named.add(a.sessionId);
  // A sandbox's tabs show its newest past agents (AgentTabs, recentAgents 12) and open on the newest: those, not its whole
  // history (a sandbox lists every agent it ever ran; "+N older" fetches the rest).
  for (const m of parts.machines ?? []) for (const sb of m.sandboxes ?? []) for (const id of sb.sessionIds.slice(-PAGE_SANDBOX_RECENT)) named.add(id);
  for (const v of parts.live ?? []) named.add(v.sessionId);
  return named;
}

/** `sessions` as the page gets them on open (keepsOnPage, pageSession), and how many older ones were left on the server. */
export function pageSessions(sessions: Iterable<SessionInfo>, named: ReadonlySet<string>, now: number): { sessions: SessionInfo[]; older: number } {
  const out: SessionInfo[] = [];
  let older = 0;
  for (const s of sessions) {
    if (keepsOnPage(s, named, now)) out.push(pageSession(s, named, now));
    else older++;
  }
  return { sessions: out, older };
}

/**
 * When each session last changed (w5907), so a page that reconnects gets only the sessions that changed while it was
 * away. A token is `<boot>.<rev>`: a page's token from another run of the server is no use (every rev starts again).
 * Every change of a session goes through Store.putSession/removeSession, which emit the `session` and
 * `session_removed` events this counts; a session the server has not changed since it started has rev 0.
 */
export class SessionRevs {
  readonly boot: string;
  private rev = 0;
  private revs = new Map<string, number>();

  constructor(boot: string = Math.random().toString(36).slice(2, 10)) {
    this.boot = boot;
  }

  note(e: { type: string; session?: { id: string }; id?: string }) {
    if (e.type === 'session' && e.session) this.revs.set(e.session.id, ++this.rev);
    else if (e.type === 'session_removed' && e.id) {
      this.revs.delete(e.id);
      this.rev++;
    }
  }

  get token(): string {
    return `${this.boot}.${this.rev}`;
  }

  /** The rev a page's token stands for, when it is this run's and not ahead of it; else undefined (send them all). */
  since(token: string | null | undefined): number | undefined {
    const m = /^([a-z0-9]+)\.(\d+)$/.exec(token ?? '');
    if (!m || m[1] !== this.boot) return undefined;
    const rev = Number(m[2]);
    return Number.isSafeInteger(rev) && rev <= this.rev ? rev : undefined;
  }

  changedSince(id: string, rev: number): boolean {
    return (this.revs.get(id) ?? 0) > rev;
  }
}

/**
 * The sessions part of a page's state: all of them, or (`since` set, a reconnect) only those changed since, with the ids
 * of all it would have got, so the page drops the rest and asks for any it lacks (web/src/store.ts mergeSessions).
 */
export function sessionsPart(kept: SessionInfo[], revs: SessionRevs, since: number | undefined): Pick<AppState, 'sessions' | 'sessionsRev' | 'sessionsDelta'> {
  if (since === undefined) return { sessions: kept, sessionsRev: revs.token };
  return { sessions: kept.filter((s) => revs.changedSince(s.id, since)), sessionsRev: revs.token, sessionsDelta: { since, ids: kept.map((s) => s.id) } };
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

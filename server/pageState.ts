// The sessions as the dashboard page gets them in AppState (w5861). AppState lists every session a portal ever ran (4,700
// on 2026-11-25), and the page's first state had reached 18 MB of JSON: lothsahn waited 5-10 s for the page to connect
// over Funnel, and a socket whose first message was still downloading missed its pong and was dropped. The page reads
// only some of each session's fields; the rest stay on the server (store.sessions) and in its session events.
import { createHash } from 'node:crypto';
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
 * away. A token is `<epoch>.<rev>`. Every change of a session goes through Store.putSession/removeSession, which emit the
 * `session` and `session_removed` events this counts.
 *
 * w6382: the revs outlive a restart. Each run saves them (`saved()`, server/index.ts session-revs.json) with a content key
 * per session, a hash of its JSON; the next run loads them (`load`), and a session whose content key no longer matches,
 * or that the file does not know, gets a new rev. Revs are one sequence across runs, each run under its own epoch: a token
 * of an earlier run is taken up to the rev its file was saved at (`past`), since every change after that either reached
 * the file with a higher rev or shows as a changed content key. A token past that saw changes the file never got: sent whole.
 * Before w6382 every restart resent all 977 sessions (2.4 MB) to each reconnecting page.
 */
export class SessionRevs {
  readonly boot: string;
  private rev = 0;
  private revs = new Map<string, number>();
  /** Earlier runs' epochs, and the rev each one's file was saved at, oldest first (at most PAST_EPOCHS). */
  private past: [string, number][] = [];
  /** Content keys as saved or loaded; a session changed since has none until the next save. */
  private keys = new Map<string, string>();
  /** Until `load` has checked every session against its content key, no token is taken (the page gets them all). */
  private ready: boolean;
  /** Sessions this run changed while `load` was still checking: their new rev stands. */
  private touched = new Set<string>();

  constructor(boot: string = Math.random().toString(36).slice(2, 10), o: { ready?: boolean } = {}) {
    this.boot = boot;
    this.ready = o.ready ?? true;
  }

  note(e: { type: string; session?: { id: string }; id?: string }) {
    if (e.type === 'session' && e.session) {
      this.revs.set(e.session.id, ++this.rev);
      this.keys.delete(e.session.id);
      if (!this.ready) this.touched.add(e.session.id);
    } else if (e.type === 'session_removed' && e.id) {
      this.revs.delete(e.id);
      this.keys.delete(e.id);
      this.rev++;
    }
  }

  /** Whether `load` is done (or was never needed): only then are tokens taken and the revs saved. */
  get isReady(): boolean {
    return this.ready;
  }

  get token(): string {
    return `${this.boot}.${this.rev}`;
  }

  /** The rev a page's token stands for, when it is this run's (not ahead of it) or an earlier saved run's; else undefined (send them all). */
  since(token: string | null | undefined): number | undefined {
    if (!this.ready) return undefined;
    const m = /^([a-z0-9]+)\.(\d+)$/.exec(token ?? '');
    if (!m) return undefined;
    const rev = Number(m[2]);
    if (!Number.isSafeInteger(rev)) return undefined;
    const upTo = m[1] === this.boot ? this.rev : this.past.find(([e]) => e === m[1])?.[1];
    return upTo !== undefined && rev <= upTo ? rev : undefined;
  }

  changedSince(id: string, rev: number): boolean {
    return (this.revs.get(id) ?? 0) > rev;
  }

  /**
   * Take an earlier run's saved revs (`saved` as `saved()` wrote it, or undefined) for the sessions the store holds now.
   * Yields to the event loop every `sliceMs`, as Store.scrubSecrets does; tokens are taken once it is done. Returns how
   * many sessions kept their rev and how many got a new one.
   */
  async load(saved: unknown, sessions: () => Iterable<SessionInfo>, sliceMs = 20, clock: () => number = Date.now): Promise<{ kept: number; changed: number }> {
    const s = readSavedRevs(saved);
    let kept = 0;
    let changed = 0;
    if (s) {
      // This run's revs go on from the file's, so they are above every rev a token of the file's run can carry.
      this.rev += s.rev;
      for (const [id, r] of this.revs) this.revs.set(id, r + s.rev);
      this.past = [...s.past, [s.epoch, s.rev] as [string, number]].slice(-PAST_EPOCHS);
      let since = clock();
      for (const x of [...sessions()]) {
        if (clock() - since >= sliceMs) {
          await new Promise<void>((r) => setImmediate(r));
          since = clock();
        }
        if (this.touched.has(x.id)) continue;
        const was = s.sessions.get(x.id);
        const key = contentKey(x);
        if (was && was[1] === key) {
          this.revs.set(x.id, was[0]);
          this.keys.set(x.id, key);
          kept++;
        } else {
          this.revs.set(x.id, ++this.rev);
          this.keys.set(x.id, key);
          changed++;
        }
      }
    }
    this.touched.clear();
    this.ready = true;
    return { kept, changed };
  }

  /** What session-revs.json holds: the epoch, the rev, the earlier runs, and each session's rev and content key. */
  saved(sessions: ReadonlyMap<string, SessionInfo>): SavedRevs {
    const out: Record<string, [number, string]> = {};
    for (const [id, s] of sessions) {
      let key = this.keys.get(id);
      if (key === undefined) this.keys.set(id, (key = contentKey(s)));
      out[id] = [this.revs.get(id) ?? 0, key];
    }
    return { v: 1, epoch: this.boot, rev: this.rev, past: this.past, sessions: out };
  }
}

/** The file in the data folder the revs are saved in (server/index.ts). */
export const SESSION_REVS_FILE = 'session-revs.json';

/** How many earlier runs' tokens a server still takes: a page sends its token only after a gap of at most 10 minutes. */
export const PAST_EPOCHS = 8;

export interface SavedRevs {
  v: 1;
  epoch: string;
  rev: number;
  past: [string, number][];
  sessions: Record<string, [number, string]>;
}

/** A session's content key (w6382): a hash of its JSON, so a change the saved revs missed still reads as a change. */
export function contentKey(s: SessionInfo): string {
  return createHash('sha1').update(JSON.stringify(s)).digest('base64url').slice(0, 16);
}

/** session-revs.json read, or undefined when it is not one this server wrote (then every session counts as changed). */
function readSavedRevs(v: unknown): { epoch: string; rev: number; past: [string, number][]; sessions: Map<string, [number, string]> } | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Partial<SavedRevs>;
  if (o.v !== 1 || typeof o.epoch !== 'string' || !/^[a-z0-9]+$/.test(o.epoch) || !Number.isSafeInteger(o.rev) || (o.rev as number) < 0) return undefined;
  if (!Array.isArray(o.past) || typeof o.sessions !== 'object' || o.sessions === null) return undefined;
  const past = o.past.filter((p): p is [string, number] => Array.isArray(p) && typeof p[0] === 'string' && Number.isSafeInteger(p[1]) && p[1] <= (o.rev as number));
  const sessions = new Map<string, [number, string]>();
  for (const [id, e] of Object.entries(o.sessions)) {
    // A rev above the file's own is not one it could have given: such a session counts as changed.
    if (Array.isArray(e) && Number.isSafeInteger(e[0]) && e[0] >= 0 && e[0] <= (o.rev as number) && typeof e[1] === 'string') sessions.set(id, [e[0], e[1]]);
  }
  return { epoch: o.epoch, rev: o.rev as number, past, sessions };
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

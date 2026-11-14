import type { SessionInfo, WorkItem } from './types.ts';
import { questionFor } from './types.ts';

/**
 * Who acts on which session in the portal (w17). Ben: "you can see the other persons transcripts you just cant interact
 * with it". Everyone signed in reads every session, transcript, request, report and file. Only these change a session
 * (message, react, answer, compact, reply, seen, rename, interrupt, permission, mode, delete):
 *   - an owner, any session (the orchestrator, ops and dispatcher rules of mayDrive in server/index.ts still apply);
 *   - a member: their own orchestrator; a worker or standing agent session they asked for (requestedBy, lastRequestedBy),
 *     or one started or linked for a request they are on (its filer, its requesters, whom it runs for, whom its question
 *     waits on).
 * Not the dispatcher, the ops worker or another person's orchestrator. On in every factory, Final Factory included
 * (config privacyGuards turns only the worker guard, server/privacyGuard.ts, on or off).
 */
export interface ActPolicy {
  roleOf(userId: string): 'owner' | 'member' | undefined;
  /** The whole ledger: the requests a session was started or linked for. */
  work(): Iterable<WorkItem>;
}

const lower = (s: string | undefined) => (s ?? '').toLowerCase();

/** Everyone a request is for: its filer, the people merged into it, whom it runs for and whom its question waits on. */
export function peopleOn(w: WorkItem): Set<string> {
  const ids = [w.requestedBy?.userId, ...(w.requesters ?? []).map((r) => r.userId), w.runsFor?.userId, ...questionFor(w).map((r) => r.userId)];
  return new Set(ids.filter((x): x is string => !!x).map(lower));
}

/** What one person may act on. `userId` undefined: the portal itself, or a page with sign-in off, which acts on all. */
export class ActScope {
  readonly all: boolean;
  private readonly me: string;
  private readonly sessionIds: Set<string>;

  constructor(p: ActPolicy, userId: string | undefined) {
    this.all = !userId || p.roleOf(userId) === 'owner';
    this.me = lower(userId);
    const mine = this.all ? [] : [...p.work()].filter((w) => peopleOn(w).has(this.me));
    this.sessionIds = new Set(mine.flatMap((w) => w.sessionIds ?? []));
  }

  session(s: Pick<SessionInfo, 'id' | 'kind' | 'orchestratorRole' | 'requestedBy' | 'lastRequestedBy'> | undefined): boolean {
    if (this.all) return true;
    if (!s || !this.me) return false;
    if (s.kind === 'ops') return false;
    if (s.kind === 'orchestrator') return s.orchestratorRole === 'personal' && lower(s.requestedBy?.userId) === this.me;
    if ([s.requestedBy, s.lastRequestedBy].some((r) => lower(r?.userId) === this.me)) return true;
    return this.sessionIds.has(s.id);
  }
}

export const NOT_YOURS = "this is another person's work: you can read it, but only the people on its request (and the owners) act on it";

import type { DelegationRequest, ReportSummary, SessionInfo, WorkItem } from '../shared/types.ts';
import { questionFor } from '../shared/types.ts';

/**
 * Who reads what in the portal (w17, Ben: "add some security measures to prevent people from snooping in people's
 * computers or invading anyone privacy"). Before this, any login read every chat, transcript, report, attachment and
 * review file, and could write to, rename and delete other people's sessions.
 *
 * With the policy on, an owner still reads everything. A member reads:
 *   - their own orchestrator;
 *   - a worker or standing agent session they asked for (requestedBy, lastRequestedBy), or one started or linked for a
 *     request they are on (its filer, its requesters, whom it runs for, whom its question waits on);
 *   - reports, attachments and review media of those requests and sessions, and the files they uploaded themselves.
 * Not the dispatcher, the ops worker or another person's orchestrator. The routes that change a session (message, rename,
 * delete, interrupt, ...) take the same check, so a member can no longer act on a session they cannot read.
 *
 * Off (Final Factory until its owners say yes, config privacyGuards): everyone signed in reads everything, as before.
 */
export interface ReadPolicy {
  on: boolean;
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

/** Whether the policy lets everything through for this person (it is off, or they are an owner). */
export function readsAll(p: ReadPolicy, userId: string | undefined): boolean {
  if (!p.on) return true;
  return !!userId && p.roleOf(userId) === 'owner';
}

/** The requests `userId` is on. */
export function workOf(p: ReadPolicy, userId: string): WorkItem[] {
  const me = lower(userId);
  return [...p.work()].filter((w) => peopleOn(w).has(me));
}

/** What a member may read, worked out once for a page's state or a broadcast. */
export class ReadScope {
  readonly all: boolean;
  private readonly me: string;
  private readonly work: WorkItem[];
  private readonly sessionIds: Set<string>;
  private readonly workIds: Set<string>;

  constructor(p: ReadPolicy, userId: string | undefined) {
    this.all = readsAll(p, userId);
    this.me = lower(userId);
    this.work = this.all || !userId ? [] : workOf(p, userId);
    this.workIds = new Set(this.work.map((w) => lower(w.id)));
    this.sessionIds = new Set(this.work.flatMap((w) => w.sessionIds ?? []));
  }

  session(s: Pick<SessionInfo, 'id' | 'kind' | 'orchestratorRole' | 'requestedBy' | 'lastRequestedBy'> | undefined): boolean {
    if (this.all) return true;
    if (!s || !this.me) return false;
    if (s.kind === 'ops') return false;
    if (s.kind === 'orchestrator') return s.orchestratorRole === 'personal' && lower(s.requestedBy?.userId) === this.me;
    if ([s.requestedBy, s.lastRequestedBy].some((r) => lower(r?.userId) === this.me)) return true;
    return this.sessionIds.has(s.id);
  }

  workItem(w: Pick<WorkItem, 'id'> | undefined): boolean {
    return this.all || (!!w && this.workIds.has(lower(w.id)));
  }

  report(r: Pick<ReportSummary, 'workId' | 'requesters' | 'sessionId'>, session?: (id: string) => SessionInfo | undefined): boolean {
    if (this.all) return true;
    if (!this.me) return false;
    if (r.requesters?.some((x) => lower(x.userId) === this.me)) return true;
    if (r.workId && this.workIds.has(lower(r.workId))) return true;
    return !!r.sessionId && !!session && this.session(session(r.sessionId));
  }

  /** An attachment: one they uploaded, one a session they read published, or one on a request they are on. */
  attachment(a: { id: string; uploadedBy?: string; session?: string }, session: (id: string) => SessionInfo | undefined, reports: () => ReportSummary[] = () => []): boolean {
    if (this.all) return true;
    if (!this.me) return false;
    if (lower(a.uploadedBy) === this.me) return true;
    if (a.session && this.session(session(a.session))) return true;
    if (this.work.some((w) => w.attachments?.some((x) => x.id === a.id))) return true;
    return reports().some((r) => r.attachments?.some((x) => x.id === a.id) && this.report(r, session));
  }

  /** A review topic folder: one a request they are on published to. */
  reviewTopic(topic: string): boolean {
    return this.all || this.work.some((w) => w.reviewTopics?.includes(topic));
  }

  delegation(d: Pick<DelegationRequest, 'workId'>): boolean {
    return this.all || (!!d.workId && this.workIds.has(lower(d.workId)));
  }
}

export const NOT_YOURS = "this is another person's work: a member reads their own orchestrator and the workers, reports and files of the requests they are on";

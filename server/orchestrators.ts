// People's own orchestrators and the one dispatcher (docs/orchestrators.md). Which orchestrator session is whose, the
// work ledger (filing, the dispatcher's decisions, the replies people's orchestrators get), each chat's budget between
// its person's messages, and where the harness's messages about work and workers go. server/agents.ts builds their
// options and tool belts on top of this; the rules that are not the model's to decide live here.
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { OptionsFactory, SessionHandle, SessionManager } from './sessions.ts';
import { actingFor, asRequester, type Identity } from './identity.ts';
import {
  STRONG,
  decisionProblem,
  dispatchNotice,
  findOverlaps,
  firstLine,
  isFor,
  isOpen,
  limitProblem,
  logLine,
  names,
  overlapLine,
  pruneIds,
  relatedKeys,
  repeatOf,
  requestNotice,
  startProblem,
  statusAfter,
  textKeys,
  updateNotice,
  updateProblem,
  type Decision,
  type PoolEntry,
} from './work.ts';
import { displayName } from '../shared/labels.ts';
import type { Machine, Requester, Sandbox, SessionInfo, WorkItem, WorkOverlap, WorkPriority } from '../shared/types.ts';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const BUSY: SessionInfo['status'][] = ['running', 'starting', 'waiting_permission'];

/** Filings (request_work, update_work) a personal orchestrator may make between two messages of its person. */
export const FILINGS_PER_MESSAGE = 3;
/** Follow-ups a personal orchestrator may send one worker between two messages of its person. */
export const FOLLOW_UPS_PER_MESSAGE = 3;
/** Notices to the dispatcher are gathered this long, so one burst of filings is one turn. */
const GATHER_MS = 1500;
/** "Capacity may have freed" wakes of the dispatcher: after a quiet spell, at least this far apart, at most this many an hour. */
const CAPACITY = { quietMs: 30_000, gapMs: 2 * 60_000, perHour: 20 };

export interface OrchestratorsDeps {
  cfg: Config;
  store: Store;
  sessions: SessionManager;
  identity: Identity;
  /** The SDK options of an orchestrator session (Agents.orchestratorOptions): its role decides its brief, tools and account. */
  options: OptionsFactory;
  /** The sandboxes and machines: their branches and open PRs are what workers there work on. */
  places: () => { sandboxes: Sandbox[]; machines: Machine[] };
  /** Commits that reached develop in the last 48 hours ("recent merges"); optional. */
  recentCommits?: () => { sha: string; subject: string }[];
  now?: () => Date;
}

/** What a filing asks for (the request_work tool's arguments). */
export interface WorkInput {
  title: string;
  brief: string;
  priority?: WorkPriority;
  constraints?: string;
  related_ids?: string[];
}

export class Orchestrators {
  private readonly d: OrchestratorsDeps;
  private readonly now: () => Date;
  /** Per personal orchestrator: its filings since its person last wrote. */
  private readonly filed = new Map<string, number>();
  /** Per personal orchestrator and worker ("orch:worker"): follow-ups since the person last wrote. */
  private readonly followUps = new Map<string, number>();
  /** Notices gathered for the dispatcher, per person they are about. */
  private readonly gathered = new Map<string, { by: Requester; texts: string[]; timer: NodeJS.Timeout }>();
  private capacityTimer?: NodeJS.Timeout;
  private readonly capacityWakes: number[] = [];

  constructor(d: OrchestratorsDeps) {
    this.d = d;
    this.now = d.now ?? (() => new Date());
  }

  private get store() {
    return this.d.store;
  }

  /** Stop the timers (notices gathered for the dispatcher, the capacity wake): the server or a test is ending. */
  close() {
    for (const g of this.gathered.values()) clearTimeout(g.timer);
    this.gathered.clear();
    clearTimeout(this.capacityTimer);
  }

  private get sessions() {
    return this.d.sessions;
  }

  // ---------------------------------------------------------------- the sessions

  /** The dispatcher's session id. store.orchestratorId keeps its old name: it was the one shared orchestrator. */
  get dispatcherId(): string | undefined {
    return this.store.orchestratorId;
  }

  isDispatcher(info: Pick<SessionInfo, 'id' | 'kind' | 'orchestratorRole'>): boolean {
    return info.kind === 'orchestrator' && (info.orchestratorRole === 'dispatcher' || (!info.orchestratorRole && info.id === this.dispatcherId));
  }

  isPersonal(info: Pick<SessionInfo, 'kind' | 'orchestratorRole'>): boolean {
    return info.kind === 'orchestrator' && info.orchestratorRole === 'personal';
  }

  /** The person a personal orchestrator talks with. */
  ownerOf(info: Pick<SessionInfo, 'kind' | 'orchestratorRole' | 'requestedBy'>): Requester | undefined {
    return this.isPersonal(info) ? info.requestedBy : undefined;
  }

  newDispatcher(): SessionHandle {
    const old = this.dispatcherId;
    if (old && this.sessions.sessions.has(old)) this.sessions.remove(old);
    const s = this.sessions.create({ kind: 'orchestrator', orchestratorRole: 'dispatcher', title: 'Dispatcher', model: this.d.cfg.orchestrator.model, permissionMode: 'default', options: this.d.options });
    this.store.orchestratorId = s.info.id;
    this.store.save();
    return s;
  }

  /**
   * At startup: make sure there is a dispatcher. A shared orchestrator from before (no role) becomes the dispatcher,
   * keeping its conversation, which knows what is in flight; each person then gets their own orchestrator, with one
   * line saying where the old conversation went, and the old global heartbeat becomes the owner's.
   */
  boot() {
    const id = this.dispatcherId;
    const h = id ? this.sessions.sessions.get(id) : undefined;
    if (!h) this.newDispatcher();
    else if (h.info.orchestratorRole !== 'dispatcher') {
      Object.assign(h.info, { orchestratorRole: 'dispatcher', title: 'Dispatcher', requestedBy: undefined });
      this.store.putSession(h.info);
      for (const u of this.d.identity.list()) {
        const p = this.personalFor(u);
        this.store.append(p.info.id, {
          kind: 'system',
          text: 'This is your own orchestrator now: only you write here. It files work with the dispatcher, which owns the sandboxes and agents and keeps two people from starting the same work. The conversation you had here before continues as the Dispatcher (in the sidebar), with the ledger of everyone’s requests.',
        });
      }
    }
    const m = this.store.settings.heartbeatMinutes;
    if (m) this.store.putSettings({ heartbeat: { ...this.store.settings.heartbeat, [this.d.identity.owner().userId]: m }, heartbeatMinutes: null });
  }

  /** A person's own orchestrator, if they have one yet. */
  personalOf(userId: string): SessionHandle | undefined {
    for (const h of this.sessions.sessions.values()) {
      if (this.isPersonal(h.info) && h.info.requestedBy && same(h.info.requestedBy.userId, userId)) return h;
    }
    return undefined;
  }

  /** A person's own orchestrator, made on first use (no process until it gets a message). */
  personalFor(r: Requester): SessionHandle {
    return (
      this.personalOf(r.userId) ??
      this.sessions.create({ kind: 'orchestrator', orchestratorRole: 'personal', title: r.displayName, model: this.d.cfg.orchestrator.model, permissionMode: 'default', options: this.d.options, requestedBy: asRequester(r) })
    );
  }

  /** Start a person's conversation afresh: a new session in place of the old one (whose transcript goes). */
  resetPersonal(r: Requester): SessionHandle {
    const old = this.personalOf(r.userId);
    if (old) this.sessions.remove(old.info.id);
    this.filed.delete(old?.info.id ?? '');
    return this.personalFor(r);
  }

  /** A person wrote to this chat themselves: its budgets start again (loops need a person's message to go on). */
  personWrote(sessionId: string) {
    this.filed.delete(sessionId);
    for (const k of [...this.followUps.keys()]) if (k.startsWith(`${sessionId}:`)) this.followUps.delete(k);
  }

  // ---------------------------------------------------------------- who hears what

  /** Send the dispatcher a harness message about `by`'s work (recorded with them, so for_user can name them). */
  toDispatcher(text: string, by?: Requester) {
    const id = this.dispatcherId;
    if (!id) return;
    try {
      this.sessions.send(id, text, 'system', undefined, { requestedBy: by });
    } catch {
      // the dispatcher is gone or at a limit; the ledger and the UI still have it
    }
  }

  /** Gather a notice for the dispatcher: a burst of filings from one person reaches it as one message. */
  private gatherForDispatcher(by: Requester, text: string) {
    const key = by.userId.toLowerCase();
    const g = this.gathered.get(key) ?? { by, texts: [], timer: undefined as unknown as NodeJS.Timeout };
    clearTimeout(g.timer);
    g.texts.push(text);
    g.timer = setTimeout(() => {
      this.gathered.delete(key);
      this.toDispatcher(g.texts.join('\n\n---\n\n'), g.by);
    }, GATHER_MS);
    g.timer.unref?.();
    this.gathered.set(key, g);
  }

  /** Send each of these people's own orchestrators a harness message (made if missing). */
  toPeople(people: readonly Requester[], text: string) {
    const seen = new Set<string>();
    for (const r of people) {
      if (seen.has(r.userId.toLowerCase())) continue;
      seen.add(r.userId.toLowerCase());
      try {
        this.sessions.send(this.personalFor(r).info.id, text, 'system', undefined, { requestedBy: asRequester(r) });
      } catch {
        // that orchestrator could not be started (a limit); the ledger and the UI still have it
      }
    }
  }

  /** The open and recent ledger items a worker works on. */
  itemsOf(sessionId: string): WorkItem[] {
    return [...this.store.work.values()].filter((w) => w.sessionIds.includes(sessionId) && w.status !== 'merged');
  }

  /**
   * Who hears about a worker: everyone its requests are for, else the person it works for, else the system payer
   * (docs/identity.md), so news of work nobody asked for reaches whoever pays for it.
   */
  audienceOf(info: Pick<SessionInfo, 'id' | 'requestedBy'>): Requester[] {
    const out = new Map<string, Requester>();
    for (const w of this.itemsOf(info.id)) for (const r of w.requesters) out.set(r.userId.toLowerCase(), r);
    if (!out.size) {
      const r = info.requestedBy ?? this.d.identity.systemPayer();
      out.set(r.userId.toLowerCase(), r);
    }
    return [...out.values()];
  }

  /** The people whose workers are in this sandbox or on this machine (the owner when there are none). */
  peopleAt(where: { sandboxId?: string; machineId?: string }): Requester[] {
    const out = new Map<string, Requester>();
    for (const s of this.store.sessions.values()) {
      if (s.kind !== 'worker' || (where.sandboxId ? s.sandboxId !== where.sandboxId : s.machineId !== where.machineId)) continue;
      for (const r of this.audienceOf(s)) out.set(r.userId.toLowerCase(), r);
    }
    return out.size ? [...out.values()] : [this.d.identity.owner()];
  }

  // ---------------------------------------------------------------- the dispatcher's attribution

  /**
   * Who a dispatcher tool call is for (docs/identity.md, docs/orchestrators.md): the requester of the request it
   * serves (work_id); else for_user, when the conversation shows that person asking (or it names the system payer);
   * else the person who wrote this turn. Anything else is refused: most of what the dispatcher hears is the harness,
   * so "whoever wrote last" would bill the wrong person.
   */
  dispatcherActor(forUser?: string, workId?: string): Requester {
    if (workId) {
      const w = this.requireWork(workId);
      const problem = startProblem(w);
      if (problem) throw new Error(problem);
      return w.requestedBy;
    }
    const id = this.dispatcherId;
    const h = id ? this.sessions.sessions.get(id) : undefined;
    const byPerson = h && (h.turnFrom ?? h.lastFrom) === 'human' ? h.info.lastRequestedBy : undefined;
    if (forUser) {
      const payer = this.d.identity.systemPayer();
      if (same(forUser.trim(), payer.userId)) return payer;
      return actingFor(id ? this.store.readTranscript(id, 200) : [], byPerson, forUser, this.d.identity.owner());
    }
    if (byPerson) return byPerson;
    throw new Error('say whom this is for: pass work_id (the request it serves), or for_user (someone the conversation shows asking, or the system payer for work nobody asked for)');
  }

  /** Whether the dispatcher's current turn was started by a person writing to it (the owner, in its chat). */
  dispatcherHeardPerson(): boolean {
    const h = this.dispatcherId ? this.sessions.sessions.get(this.dispatcherId) : undefined;
    return !!h && (h.turnFrom ?? h.lastFrom) === 'human';
  }

  // ---------------------------------------------------------------- the ledger

  requireWork(id: string): WorkItem {
    const w = this.store.work.get(id.trim().toLowerCase());
    if (!w) throw new Error(`no work request "${id}"; list_work shows them`);
    return w;
  }

  /** What the page shows: every open item, and those closed in the last 3 days, at most 100. */
  forPage(): WorkItem[] {
    const since = this.now().getTime() - 3 * 86_400_000;
    const keep = [...this.store.work.values()].filter((w) => isOpen(w) || Date.parse(w.updatedAt) >= since);
    return keep.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
  }

  private stamp(w: WorkItem, line: string) {
    const now = this.now();
    w.log = [...w.log, logLine(now, line)].slice(-40);
    w.updatedAt = now.toISOString();
  }

  private knownBranches(): string[] {
    const { sandboxes, machines } = this.d.places();
    return [...sandboxes.flatMap((s) => [s.branch, s.git?.branch ?? '']), ...machines.map((m) => m.git?.branch ?? '')].filter(Boolean);
  }

  /** Everything a new request may repeat: requests open or closed in the last 48 hours, live and recent workers, pending delegations, recent commits. */
  private pool(exceptId?: string): PoolEntry[] {
    const now = this.now().getTime();
    const branches = this.knownBranches();
    const { sandboxes, machines } = this.d.places();
    const out: PoolEntry[] = [];
    for (const w of this.store.work.values()) {
      if (w.id === exceptId || w.status === 'merged' || w.status === 'cancelled') continue;
      if (!isOpen(w) && now - Date.parse(w.updatedAt) > 48 * 3_600_000) continue;
      out.push({ ref: w.id, kind: 'work', title: w.title, keys: [...w.keys, `work:${w.id}`] });
    }
    for (const s of this.store.sessions.values()) {
      if (s.kind !== 'worker') continue;
      if (!BUSY.includes(s.status) && now - Date.parse(s.lastActivityAt) > 6 * 3_600_000) continue;
      const sb = s.sandboxId ? sandboxes.find((x) => x.id === s.sandboxId) : undefined;
      const m = s.machineId ? machines.find((x) => x.id === s.machineId) : undefined;
      const git = sb?.git ?? m?.git;
      const keys = new Set([...textKeys(`${s.title}\n${s.lastResult ?? ''}\n${sb?.purpose ?? m?.purpose ?? ''}`, branches), `session:${s.id}`]);
      const branch = git?.branch && git.branch !== 'detached HEAD' ? git.branch : sb?.branch;
      if (branch && !['develop', 'main', 'master'].includes(branch)) {
        keys.add(`branch:${branch.toLowerCase()}`);
        for (const k of textKeys(branch)) keys.add(k);
      }
      if (git?.pr) keys.add(`pr:${git.pr.number}`);
      out.push({ ref: s.id, kind: 'session', title: s.title, keys: [...keys], text: sb ? displayName(sb) : m ? displayName(m) : undefined });
    }
    for (const d of this.store.delegations.values()) {
      if (d.status !== 'pending') continue;
      out.push({ ref: d.id, kind: 'delegation', title: d.title, keys: [...textKeys(`${d.title}\n${d.task}`, branches), `delegation:${d.id}`] });
    }
    for (const c of this.d.recentCommits?.() ?? []) {
      out.push({ ref: c.sha, kind: 'commit', title: c.subject, keys: textKeys(c.subject, branches) });
    }
    return out;
  }

  /**
   * A person's orchestrator files a request (request_work). Refused past the chat's budget or the person's limits.
   * A repeat of the person's open request with the same title returns that one. Otherwise the server finds what it
   * may repeat, stores it, and the dispatcher gets it (gathered for a moment with others from the same person).
   */
  file(chat: SessionHandle, input: WorkInput): string {
    const owner = this.ownerOf(chat.info);
    if (!owner) throw new Error('only a person’s own orchestrator files work requests');
    const title = input.title.replace(/\s+/g, ' ').trim();
    const brief = input.brief.trim();
    if (!title || !brief) throw new Error('give a title and a brief');
    const repeat = repeatOf(this.store.work.values(), owner, title);
    if (repeat) {
      this.stamp(repeat, `filed again by ${owner.displayName}'s orchestrator: ${firstLine(brief)}`);
      this.store.putWork(repeat);
      return `Already filed as ${repeat.id} (${repeat.status}); the new text is in its log. To change what it asks for, use update_work with a note.`;
    }
    this.spend(chat.info.id, owner);
    const now = this.now();
    const limit = limitProblem(this.store.work.values(), owner, now.getTime());
    if (limit) throw new Error(limit);
    const branches = this.knownBranches();
    const { sandboxes, machines } = this.d.places();
    const related = (input.related_ids ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
    const keys = new Set([
      ...textKeys(`${title}\n${brief}\n${input.constraints ?? ''}`, branches),
      ...relatedKeys(related, {
        work: (id) => this.store.work.has(id.toLowerCase()),
        session: (id) => this.store.sessions.has(id),
        delegation: (id) => this.store.delegations.has(id),
        sandbox: (id) => sandboxes.some((s) => same(s.id, id)),
        machine: (id) => machines.some((m) => same(m.id, id)),
      }, branches),
    ]);
    const id = `w${++this.store.workSeq}`;
    const w: WorkItem = {
      id,
      title: clip(title, 120),
      brief: clip(brief, 8000),
      ...(input.constraints?.trim() ? { constraints: clip(input.constraints.trim(), 2000) } : {}),
      priority: input.priority ?? 'normal',
      ...(related.length ? { relatedIds: related } : {}),
      keys: [...keys],
      requestedBy: asRequester(owner),
      requesters: [asRequester(owner)],
      humanAsked: (chat.turnFrom ?? chat.lastFrom) === 'human',
      status: 'new',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      sessionIds: [],
      overlaps: [],
      asks: 0,
      log: [],
    };
    w.overlaps = findOverlaps({ keys: w.keys, title: w.title }, this.pool(id));
    this.stamp(w, `filed by ${owner.displayName}${w.humanAsked ? '' : ' (not in a turn of theirs)'}`);
    this.store.putWork(w);
    this.store.dropWork(pruneIds(this.store.work.values()));
    this.gatherForDispatcher(owner, requestNotice(w));
    const overlap = w.overlaps.length ? ` Possible overlap: ${w.overlaps.slice(0, 3).map(overlapLine).join('; ')}. Tell ${owner.displayName}; the dispatcher decides.` : '';
    return `Filed ${id} with the dispatcher.${overlap} You get a [dispatch] message with its decision.`;
  }

  /** Count a filing against the chat's budget, refusing it past FILINGS_PER_MESSAGE since its person last wrote. */
  private spend(chatId: string, owner: Requester) {
    const n = this.filed.get(chatId) ?? 0;
    if (n >= FILINGS_PER_MESSAGE) throw new Error(`${FILINGS_PER_MESSAGE} filings since ${owner.displayName} last wrote; ask them before filing more`);
    this.filed.set(chatId, n + 1);
  }

  /** A requester's update (update_work): a note (an answer to a question reopens it), a priority, closing or reopening. */
  update(chat: SessionHandle, input: { id: string; note?: string; priority?: WorkPriority; close?: 'done' | 'cancelled'; reopen?: boolean }): string {
    const owner = this.ownerOf(chat.info);
    if (!owner) throw new Error('only a person’s own orchestrator updates its requests');
    const w = this.requireWork(input.id);
    if (!isFor(w, owner.userId)) throw new Error(`${w.id} is ${names(w.requesters)}'s request, not ${owner.displayName}'s`);
    const note = input.note?.trim();
    if (!note && !input.priority && !input.close && !input.reopen) throw new Error('give a note, a priority, close or reopen');
    const problem = updateProblem(w, input, this.now().getTime());
    if (problem) throw new Error(problem);
    this.spend(chat.info.id, owner);
    const what: string[] = [];
    if (input.reopen) {
      w.status = 'new';
      what.push('reopened');
    }
    if (input.priority && input.priority !== w.priority) {
      what.push(`priority ${w.priority} → ${input.priority}`);
      w.priority = input.priority;
    }
    if (note) {
      what.push(`note: ${note}`);
      if (w.status === 'question') w.status = 'new';
    }
    if (input.close) {
      w.status = input.close;
      if (note) w.outcome = clip(note, 300);
      what.push(input.close === 'done' ? 'closed as done' : 'cancelled');
    }
    this.stamp(w, `${owner.displayName}: ${what.join('; ')}`);
    this.store.putWork(w);
    // Closing as done needs nothing from the dispatcher; anything else may.
    if (input.close !== 'done') {
      const live = w.sessionIds.filter((sid) => BUSY.includes(this.store.sessions.get(sid)?.status ?? 'stopped'));
      const hint = input.close === 'cancelled' && live.length ? ` Its workers ${live.join(', ')} are still working: stop or redirect them.` : '';
      this.gatherForDispatcher(owner, updateNotice(w, owner, `${what.join('; ')}.${hint}`));
    }
    return `${w.id} is ${w.status}: ${what.join('; ')}.`;
  }

  /** The dispatcher decides about a request (decide_work); the requesters' orchestrators get the reply. */
  decide(input: { id: string; action: Decision; note: string; into?: string; session_ids?: string[] }): string {
    const w = this.requireWork(input.id);
    const into = input.into ? this.requireWork(input.into) : undefined;
    const problem = decisionProblem(w, input.action, into);
    if (problem) throw new Error(problem);
    const note = input.note.trim();
    let what = '';
    if (input.action === 'merge') {
      const t = into!;
      for (const r of w.requesters) if (!isFor(t, r.userId)) t.requesters.push(r);
      t.sessionIds = [...new Set([...t.sessionIds, ...w.sessionIds])];
      this.stamp(t, `merged ${w.id} from ${names(w.requesters)}: ${note}`);
      this.store.putWork(t);
      w.mergedInto = t.id;
      const workers = t.sessionIds.filter((sid) => this.store.sessions.get(sid)).map((sid) => this.workerLine(sid));
      what = `merged into ${t.id} "${clip(t.title, 80)}" (${t.status}${workers.length ? `: ${workers.join(', ')}` : ''}), which ${names(t.requesters)} will hear about`;
    } else if (input.action === 'link') {
      const ids = (input.session_ids ?? []).map((x) => x.trim()).filter(Boolean);
      if (!ids.length) throw new Error('link needs session_ids: the workers already doing it');
      for (const sid of ids) {
        const s = this.store.sessions.get(sid);
        if (!s || s.kind !== 'worker') throw new Error(`no worker "${sid}"`);
      }
      w.sessionIds = [...new Set([...w.sessionIds, ...ids])];
      what = `linked to ${ids.map((sid) => this.workerLine(sid)).join(', ')}, already on it`;
    } else if (input.action === 'ask') {
      w.asks++;
      what = 'a question';
    } else if (input.action === 'queue') what = 'queued';
    else if (input.action === 'reject') what = 'declined';
    else what = 'done';
    w.status = statusAfter(input.action);
    if (input.action === 'reject' || input.action === 'done') w.outcome = clip(note, 300);
    this.stamp(w, `dispatcher: ${what}: ${note}`);
    this.store.putWork(w);
    // A question is for the person who asked; the rest is news for everyone the request is for.
    this.toPeople(input.action === 'ask' ? [w.requestedBy] : w.requesters, dispatchNotice(w, what, note));
    return `${w.id} ${w.status}: ${what}. ${input.action === 'ask' ? names([w.requestedBy]) : names(w.requesters)}'s orchestrator has your note.`;
  }

  /** A request's overlaps as they are now (for the dispatcher's list_work): what else is in flight or recently done. */
  currentOverlaps(w: WorkItem): WorkOverlap[] {
    return findOverlaps({ keys: w.keys, title: w.title }, this.pool(w.id).filter((e) => !(e.kind === 'session' && w.sessionIds.includes(e.ref))));
  }

  /** Strong overlaps of a request that are still in flight: starting it anyway needs a reason (override_duplicate). */
  blockingOverlaps(w: WorkItem): WorkOverlap[] {
    return w.overlaps.filter((o) => {
      if (o.score < STRONG) return false;
      if (o.kind === 'work') {
        const other = this.store.work.get(o.ref);
        const live = other?.status === 'merged' && other.mergedInto ? this.store.work.get(other.mergedInto) : other;
        return !!live && live.id !== w.id && isOpen(live);
      }
      if (o.kind === 'session') {
        const s = this.store.sessions.get(o.ref);
        return !!s && s.status !== 'stopped' && s.status !== 'error' && !w.sessionIds.includes(s.id);
      }
      if (o.kind === 'delegation') return this.store.delegations.get(o.ref)?.status === 'pending';
      return true;
    });
  }

  /** A worker was started, messaged or approved for a request: link it, mark the request active, tell its requesters. */
  linkWorker(workId: string, s: Pick<SessionInfo, 'id' | 'title'>, what: string, opts: { reply?: boolean } = {}) {
    const w = this.requireWork(workId);
    w.sessionIds = [...new Set([...w.sessionIds, s.id])];
    w.status = 'active';
    this.stamp(w, `dispatcher: ${what}`);
    this.store.putWork(w);
    if (opts.reply !== false) this.toPeople(w.requesters, dispatchNotice(w, what));
  }

  /**
   * A dispatcher start_agent without a work_id: the ledger still gets it, so its updates find their people and the
   * page lists it. Returns the new item's id.
   */
  recordDirectStart(s: Pick<SessionInfo, 'id' | 'title'>, prompt: string, by: Requester, where: string): string {
    const now = this.now();
    const w: WorkItem = {
      id: `w${++this.store.workSeq}`,
      title: clip(s.title, 120),
      brief: clip(prompt, 8000),
      priority: 'normal',
      keys: [...textKeys(`${s.title}\n${prompt}`, this.knownBranches()), `session:${s.id}`],
      requestedBy: asRequester(by),
      requesters: [asRequester(by)],
      humanAsked: this.dispatcherHeardPerson(),
      status: 'active',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      sessionIds: [s.id],
      overlaps: [],
      asks: 0,
      log: [],
    };
    this.stamp(w, `started directly by the dispatcher for ${by.displayName}: worker ${s.id} ${where}`);
    this.store.putWork(w);
    this.store.dropWork(pruneIds(this.store.work.values()));
    return w.id;
  }

  /** A worker's line for replies: `worker ab12 "Belt fix" in alpha`. */
  workerLine(id: string): string {
    const s = this.store.sessions.get(id);
    if (!s) return `worker ${id}`;
    return `worker ${id} "${clip(s.title, 60)}"${s.sandboxId ? ` in ${s.sandboxId}` : s.machineId ? ` on ${s.machineId}` : ''}`;
  }

  /** One line per worker with its live state, for list_work. */
  workerState(id: string): string {
    const s = this.store.sessions.get(id);
    return s ? `${id} (${s.status})` : `${id} (gone)`;
  }

  /** A worker finished a turn: the requests it works on record its last word. */
  workerTurnEnded(s: SessionInfo, text: string) {
    const line = clip(firstLine(text), 300);
    for (const w of this.itemsOf(s.id)) {
      if (!line) continue;
      w.outcome = line;
      this.stamp(w, `worker ${s.id}: ${line}`);
      this.store.putWork(w);
    }
    this.capacityMayHaveFreed(`worker ${s.id} "${clip(s.title, 60)}" finished a turn`);
  }

  // ---------------------------------------------------------------- follow-ups (personal message_agent)

  /**
   * Whether a personal orchestrator may send this worker a follow-up: it must work for its person (who started it,
   * or one of its requests is theirs), within FOLLOW_UPS_PER_MESSAGE since the person last wrote. Counts it.
   */
  followUp(chat: SessionInfo, worker: SessionInfo) {
    const owner = this.ownerOf(chat);
    if (!owner) return;
    const theirs = (worker.requestedBy && same(worker.requestedBy.userId, owner.userId)) || this.itemsOf(worker.id).some((w) => isFor(w, owner.userId));
    if (!theirs) {
      const whose = worker.requestedBy ? `${worker.requestedBy.displayName}'s` : 'not yours';
      throw new Error(`${worker.id} "${worker.title}" is ${whose} work: follow up only on ${owner.displayName}'s own workers; for anything else, request_work`);
    }
    const key = `${chat.id}:${worker.id}`;
    const n = this.followUps.get(key) ?? 0;
    if (n >= FOLLOW_UPS_PER_MESSAGE) throw new Error(`${FOLLOW_UPS_PER_MESSAGE} follow-ups to ${worker.id} since ${owner.displayName} last wrote; ask them first`);
    this.followUps.set(key, n + 1);
    for (const w of this.itemsOf(worker.id)) {
      this.stamp(w, `${owner.displayName}'s orchestrator followed up with ${worker.id}`);
      this.store.putWork(w);
    }
  }

  // ---------------------------------------------------------------- capacity

  /**
   * A worker finished a turn or ended: when requests are queued, the dispatcher is told (after a quiet spell, at
   * least a few minutes apart, a few an hour) so queued work can start without anyone asking.
   */
  capacityMayHaveFreed(what: string) {
    if (![...this.store.work.values()].some((w) => w.status === 'queued')) return;
    clearTimeout(this.capacityTimer);
    this.capacityTimer = setTimeout(() => {
      const now = this.now().getTime();
      while (this.capacityWakes.length && now - this.capacityWakes[0] > 3_600_000) this.capacityWakes.shift();
      const last = this.capacityWakes.at(-1) ?? 0;
      if (now - last < CAPACITY.gapMs || this.capacityWakes.length >= CAPACITY.perHour) return;
      const queued = [...this.store.work.values()].filter((w) => w.status === 'queued');
      if (!queued.length) return;
      this.capacityWakes.push(now);
      this.toDispatcher(`[ledger] Capacity may have freed (${what}). Queued: ${queued.map((w) => `${w.id} "${clip(w.title, 80)}" (${names(w.requesters)}, ${w.priority})`).join('; ')}. Start what fits now, or leave it queued.`);
    }, CAPACITY.quietMs);
    this.capacityTimer.unref?.();
  }
}

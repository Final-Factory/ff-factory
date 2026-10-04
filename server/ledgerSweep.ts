// The ledger cleanup (docs/orchestrators.md, "Ledger cleanup"): requests nobody closes by hand. Two passes share this code.
//
// - Every 5 minutes (checkPrs): link each request to the pull requests its workers open, and close it as done when they
//   have merged and nothing is left to do after the merge (w304).
// - Every `ledger.cleanup.everyHours` hours, and on demand (run): that, plus the intake's merged requests (server/intake.ts
//   checkMerged), requests whose worker reported them delivered, workers a usage limit or a restart cut off (resumed
//   once, else stalled), requests another finished one probably covers, and requests nothing has touched for 24 hours,
//   which become `stalled` for their person to close or reopen (w306).
//
// A request with a running worker is never touched, and nothing here closes a request waiting on a person. Rules:
// server/ledgerRules.ts. Every action is logged on its request; each person's orchestrator hears one line per pass.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { emit } from './store.ts';
import type { Orchestrators } from './orchestrators.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import { run as runProc } from './proc.ts';
import { isOpen } from './work.ts';
import {
  STALL_AFTER_MS,
  REPORT_QUIET_MS,
  afterMergeReason,
  cleanupSettings,
  cutOffOf,
  isRelease,
  mergePrs,
  ownerAt,
  prUrlsIn,
  prMergedText,
  prsOf,
  reportVerdict,
  stallCandidate,
  supersededBy,
  type OpenedPr,
  type PrRecord,
} from './ledgerRules.ts';
import type { LedgerCleanupState, Requester, SessionInfo, WorkItem, WorkPr } from '../shared/types.ts';

const CHECK_EVERY_MS = 5 * 60_000;
const BUSY: ReadonlySet<SessionInfo['status']> = new Set(['running', 'starting', 'waiting_permission']);
const PRS_PER_REPO = 200;
const REFRESH_OLD_PRS = 12;

export interface LedgerSweepDeps {
  cfg: Config;
  store: Store;
  orchestrators: Orchestrators;
  /** GitHub owner/name of the repos whose PRs are linked: the game repo and this app's own, besides config's. */
  repos?: () => Promise<string[]>;
  /** The newest PRs of those repos in every state (gh); undefined when gh could not say. */
  prs?: (repos: string[]) => Promise<PrRecord[] | undefined>;
  /** One PR by number, for a linked PR older than the list reaches. */
  viewPr?: (repo: string, number: number) => Promise<PrRecord | undefined>;
  /** Send a stopped worker a message, which resumes it. */
  resume?: (sessionId: string, text: string) => void;
  /** Whether the Claude account a worker ran on has room again (no meter near its limit), or undefined when unknown. */
  limitsClear?: (s: SessionInfo) => boolean | undefined;
  /** The intake's merged-branch rule (server/intake.ts checkMerged), run in a full pass; returns the ids it closed. */
  intakeMerged?: () => Promise<string[]>;
  now?: () => number;
}

interface Persisted {
  lastRunAt?: string;
  lastSummary?: string;
  /** The first pass ran: it lists what stayed open and why (the one-time backfill). */
  backfilledAt?: string;
}

/** closed, resumed and stalled are what a pass did; open: a merged request that stayed open, and why (told on the first pass only); note: a PR was closed without merging (always told, once). */
type Kind = 'closed' | 'resumed' | 'stalled' | 'open' | 'note';
interface Action {
  id: string;
  title: string;
  who: readonly Requester[];
  kind: Kind;
  text: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export class LedgerSweep {
  private readonly d: LedgerSweepDeps;
  private readonly file: string;
  private data: Persisted;
  private readonly timers: NodeJS.Timeout[] = [];
  private busy = false;
  private repoCache?: string[];
  readonly now: () => number;

  constructor(d: LedgerSweepDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.file = path.join(d.cfg.dataDir, 'ledger.json');
    try {
      this.data = readJsonDurable<Persisted>(this.file, { check: checkObject }) ?? {};
    } catch {
      this.data = {};
    }
  }

  get settings() {
    return cleanupSettings(this.d.cfg);
  }

  state(): LedgerCleanupState {
    const s = this.settings;
    return { enabled: s.enabled, everyHours: s.everyHours, ...(this.data.lastRunAt ? { lastRunAt: this.data.lastRunAt } : {}), ...(this.data.lastSummary ? { lastSummary: this.data.lastSummary } : {}), ...(this.busy ? { running: true } : {}) };
  }

  start() {
    const every = (ms: number, f: () => void, first: number) => {
      const a = setTimeout(f, first);
      a.unref();
      const b = setInterval(f, ms);
      b.unref();
      this.timers.push(a, b);
    };
    every(CHECK_EVERY_MS, () => void this.checkPrs(), 2 * 60_000);
    const hours = this.settings.everyHours * 3_600_000;
    const sinceLast = this.data.lastRunAt ? this.now() - Date.parse(this.data.lastRunAt) : hours;
    every(hours, () => void this.run(), Math.max(10 * 60_000, hours - sinceLast));
    return this;
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.flush();
  }

  private flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeJsonDurable(this.file, this.data);
    } catch (e) {
      console.warn('ledger cleanup: could not save its state:', (e as Error).message);
    }
  }

  private publish() {
    emit({ type: 'ledger', ledger: this.state() });
  }

  // ---------------------------------------------------------------- the passes

  /** The pull-request rule only (w304): cheap enough to run every few minutes. */
  async checkPrs(): Promise<string[]> {
    if (!this.settings.enabled || this.busy) return [];
    return (await this.pass(false)).filter((a) => a.kind === 'closed').map((a) => a.id);
  }

  /** The whole cleanup (w306), on its schedule or on demand. Returns what it did, in a line. */
  async run(): Promise<string> {
    if (!this.settings.enabled) return 'the ledger cleanup is off (config ledger.cleanup.enabled)';
    if (this.busy) return 'a cleanup is already running';
    const acts = await this.pass(true);
    return this.data.lastSummary ?? summaryOf(acts);
  }

  private async pass(full: boolean): Promise<Action[]> {
    this.busy = true;
    this.publish();
    const acts: Action[] = [];
    try {
      const backfill = !this.data.backfilledAt;
      const prs = await this.loadPrs();
      if (prs) await this.recheckClosed(prs, acts);
      const work = [...this.d.store.work.values()];
      if (full && this.d.intakeMerged) {
        for (const id of await this.d.intakeMerged().catch(() => [] as string[])) {
          const w = this.d.store.work.get(id);
          if (w?.autoClosed) acts.push({ id, title: w.title, who: w.requesters, kind: 'closed', text: w.autoClosed.text });
        }
      }
      for (const w of work) {
        const live = this.d.store.work.get(w.id);
        if (!live || !(isOpen(live) || live.status === 'stalled')) continue;
        if (live.approval?.state === 'pending') continue;
        const workers = live.sessionIds.map((id) => this.d.store.sessions.get(id)).filter((s): s is SessionInfo => !!s);
        if (workers.some((s) => BUSY.has(s.status))) continue;
        try {
          if (prs && (await this.prStep(live, workers, prs, acts))) continue;
          if (!full) continue;
          if (this.deliveredStep(live, workers, acts)) continue;
          if (this.cutOffStep(live, workers, acts)) continue;
          this.stallStep(live, workers, acts);
        } catch (e) {
          console.warn(`ledger cleanup: ${live.id}: ${(e as Error).message}`);
        }
      }
      const notable = acts.filter((a) => a.kind !== 'open' || backfill);
      this.tell(notable);
      if (full) {
        this.data.lastRunAt = new Date(this.now()).toISOString();
        this.data.lastSummary = summaryOf(acts);
      }
      if (backfill && prs) this.data.backfilledAt = new Date(this.now()).toISOString();
      return acts;
    } finally {
      this.busy = false;
      this.flush();
      this.publish();
    }
  }

  /** One line per person for what changed in a pass; nothing when nothing did. */
  private tell(acts: readonly Action[]) {
    const byPerson = new Map<string, { who: Requester; acts: Action[] }>();
    for (const a of acts) {
      for (const r of a.who) {
        const e = byPerson.get(r.userId.toLowerCase()) ?? { who: r, acts: [] };
        e.acts.push(a);
        byPerson.set(r.userId.toLowerCase(), e);
      }
    }
    for (const { who, acts: mine } of byPerson.values()) {
      const part = (kind: Kind, label: string) => {
        const list = mine.filter((a) => a.kind === kind);
        return list.length ? [`${label} ${list.length}: ${list.map((a) => `${a.id} "${clip(a.title, 60)}" (${a.text})`).join('; ')}`] : [];
      };
      const text = [...part('closed', 'closed as done'), ...part('resumed', 'resumed'), ...part('stalled', 'stalled, for you to close or reopen'), ...part('note', 'for your attention'), ...part('open', 'stayed open')].join('. ');
      this.d.orchestrators.toPeople([who], `[ledger cleanup] ${text}.`);
    }
  }

  // ---------------------------------------------------------------- pull requests (w304)

  private async repoSlugs(): Promise<string[]> {
    if (this.d.repos) return this.d.repos();
    if (this.repoCache) return this.repoCache;
    const slug = async (dir: string) => /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec((await runProc('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })).stdout.trim())?.[1];
    const app = path.resolve(import.meta.dirname, '..');
    const given = this.settings.repos;
    this.repoCache = given ?? [...new Set([await slug(this.d.cfg.repo.basePath), await slug(app)].filter((x): x is string => !!x))];
    return this.repoCache;
  }

  private async loadPrs(): Promise<PrRecord[] | undefined> {
    const repos = await this.repoSlugs();
    if (!repos.length) return undefined;
    if (this.d.prs) return this.d.prs(repos);
    const out: PrRecord[] = [];
    for (const repo of repos) {
      const r = await runProc('gh', ['pr', 'list', '-R', repo, '--state', 'all', '--limit', String(PRS_PER_REPO), '--json', 'number,title,body,headRefName,baseRefName,state,createdAt,mergedAt,closedAt,mergeCommit,url'], { timeoutMs: 45_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
      if (r.code !== 0) return undefined;
      try {
        out.push(...(JSON.parse(r.stdout) as GhPr[]).map((p) => fromGh(repo, p)));
      } catch {
        return undefined;
      }
    }
    return out;
  }

  private async view(repo: string, number: number): Promise<PrRecord | undefined> {
    if (this.d.viewPr) return this.d.viewPr(repo, number);
    const r = await runProc('gh', ['pr', 'view', String(number), '-R', repo, '--json', 'number,title,body,headRefName,baseRefName,state,createdAt,mergedAt,closedAt,mergeCommit,url'], { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    if (r.code !== 0) return undefined;
    try {
      return fromGh(repo, JSON.parse(r.stdout) as GhPr);
    } catch {
      return undefined;
    }
  }

  /**
   * The PRs this request's workers opened while working on it (w340): the URL a `gh pr create` printed, at the time it ran,
   * kept only when this request is the one the worker was on then (the latest filed by then of the requests that share the
   * worker). A URL a worker merely mentions, or a PR of an earlier request the same worker did, is not one.
   */
  private openedBy(w: WorkItem, workers: readonly SessionInfo[], limit = 2000): OpenedPr[] {
    const out: OpenedPr[] = [];
    const all = [...this.d.store.work.values()];
    for (const s of workers) {
      const sharing = all.filter((x) => x.sessionIds.includes(s.id));
      const created = new Set<string>();
      for (const e of this.d.store.readTranscript(s.id, limit)) {
        if (e.kind === 'tool_use' && /bash/i.test(e.name) && /\bgh\s+pr\s+create\b/.test(String((e.input as { command?: unknown } | null)?.command ?? ''))) created.add(e.toolUseId);
        if (e.kind !== 'tool_result' || !created.has(e.toolUseId) || e.isError) continue;
        if (ownerAt(sharing, e.t)?.id !== w.id) continue;
        for (const u of prUrlsIn(e.text)) out.push({ ...u, at: e.t });
      }
    }
    return out;
  }

  /**
   * w340: requests this cleanup closed on a merged PR within the last 14 days are checked against the strict link rules
   * (server/ledgerRules.ts prsOf). One whose closing PR no longer qualifies is reopened (active with its worker, else new),
   * its wrong links dropped, and its person told. A PR gh cannot show is left alone: no evidence either way.
   */
  private async recheckClosed(all: readonly PrRecord[], acts: Action[]) {
    const since = this.now() - 14 * 86_400_000;
    for (const w of [...this.d.store.work.values()]) {
      if (w.status !== 'done' || w.autoClosed?.how !== 'prs' || !w.autoClosed.pr || Date.parse(w.autoClosed.at) < since) continue;
      try {
        const workers = w.sessionIds.map((id) => this.d.store.sessions.get(id)).filter((s): s is SessionInfo => !!s);
        const listed = new Map(all.map((p) => [`${p.repo.toLowerCase()}#${p.number}`, p]));
        const records = [...all];
        for (const p of w.prs ?? []) {
          if (listed.has(`${p.repo.toLowerCase()}#${p.number}`)) continue;
          const v = await this.view(p.repo, p.number);
          if (v) records.push(v);
        }
        const strong = prsOf(w, records, { opened: this.openedBy(w, workers, 100_000) });
        const closing = w.prs?.find((p) => p.number === w.autoClosed!.pr);
        if (!closing) continue;
        if (closing.via) continue;
        if (strong.some((p) => p.number === closing.number && p.repo === closing.repo)) continue;
        if (!records.some((p) => p.number === closing.number && p.repo === closing.repo)) continue;
        const keep = (w.prs ?? []).filter((p) => strong.some((q) => q.number === p.number && q.repo === p.repo));
        const status = workers.length ? 'active' : 'new';
        const text = `PR #${closing.number} is not this request's by the strict link rules (no Request: ${w.id} line, not opened by its own worker after it was filed, not its branch)`;
        this.d.orchestrators.ledgerEdit(w.id, `reopened by the ledger cleanup: ${text}; it was closed automatically as "${w.autoClosed.text}"`, (x) => {
          x.status = status;
          x.autoClosed = undefined;
          if (x.outcome?.startsWith('closed automatically')) x.outcome = undefined;
          x.prs = keep;
        });
        acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'note', text: `reopened: ${text}` });
      } catch (e) {
        console.warn(`ledger cleanup: recheck ${w.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Link PRs, note what changed, close or leave open. True when the request was closed (it needs nothing more). */
  private async prStep(w: WorkItem, workers: readonly SessionInfo[], all: readonly PrRecord[], acts: Action[]): Promise<boolean> {
    const found = prsOf(w, all, { opened: this.openedBy(w, workers) });
    let prs = mergePrs(w.prs ?? [], found);
    // A linked PR the list no longer reaches: ask for it by number (a few per pass).
    const listed = new Set(all.map((p) => `${p.repo.toLowerCase()}#${p.number}`));
    let refreshed = 0;
    for (const p of prs.filter((x) => x.state === 'open' && !listed.has(`${x.repo.toLowerCase()}#${x.number}`))) {
      if (refreshed++ >= REFRESH_OLD_PRS) break;
      const v = await this.view(p.repo, p.number);
      if (v) prs = mergePrs(prs, [v]);
    }
    if (!prs.length) return false;
    const fresh = prs.filter((p) => !(w.prs ?? []).some((q) => q.repo === p.repo && q.number === p.number));
    const keep = (next: WorkPr[]) => {
      prs = next;
    };
    const note = (p: WorkPr, key: string, line: string) => {
      if (p.noted === key) return;
      keep(prs.map((q) => (q.number === p.number && q.repo === p.repo ? { ...q, noted: key } : q)));
      this.d.orchestrators.ledgerEdit(w.id, line, (x) => void (x.prs = prs), true);
    };
    if (JSON.stringify(prs) !== JSON.stringify(w.prs ?? [])) {
      const line = fresh.length ? `linked ${fresh.map((p) => `PR #${p.number} (${p.state})`).join(', ')}` : 'pull request states updated';
      this.d.orchestrators.ledgerEdit(w.id, line, (x) => void (x.prs = prs), true);
    }
    const open = prs.filter((p) => p.state === 'open');
    const merged = prs.filter((p) => p.state === 'merged');
    const closed = prs.filter((p) => p.state === 'closed');
    for (const p of closed) {
      if (p.noted === 'closed') continue;
      note(p, 'closed', `PR #${p.number} was closed without merging${open.length ? `; PR #${open[0].number} is still open` : ''}`);
      if (!open.length && !merged.length) acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'note', text: `PR #${p.number} was closed without merging; the request stays open` });
    }
    if (!merged.length) return false;
    const last = [...merged].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).at(-1)!;
    if (open.length) {
      note(last, `merged:open`, `PR #${last.number} merged; still open: PR #${open[0].number} is open`);
      acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'open', text: `PR #${last.number} merged, PR #${open[0].number} is still open` });
      return false;
    }
    const reason = afterMergeReason(w, workers.map((s) => s.lastResult ?? ''));
    if (reason) {
      note(last, `merged:${reason.slice(0, 40)}`, `PR #${last.number} merged; still open: ${reason}`);
      acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'open', text: `PR #${last.number} merged; ${reason}` });
      return false;
    }
    this.closeAsDone(w, { how: 'prs', pr: last.number, sha: last.sha, mergedAt: last.at, text: prMergedText(last) }, acts);
    return true;
  }

  private closeAsDone(w: WorkItem, how: { how: 'prs' | 'report'; pr?: number; sha?: string; mergedAt?: string; text: string }, acts: Action[]) {
    const at = new Date(this.now()).toISOString();
    this.d.orchestrators.ledgerEdit(w.id, `closed automatically by the ledger cleanup: ${how.text}`, (x) => {
      x.status = 'done';
      x.stalled = undefined;
      x.autoClosed = { at, how: how.how, ...(how.pr ? { pr: how.pr } : {}), ...(how.sha ? { sha: how.sha } : {}), ...(how.mergedAt ? { mergedAt: how.mergedAt } : {}), text: how.text };
      x.outcome = clip(`closed automatically: ${how.text}`, 300);
    });
    acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'closed', text: how.text });
  }

  // ---------------------------------------------------------------- finished, cut off, stalled (w306)

  private latest(workers: readonly SessionInfo[]): SessionInfo | undefined {
    return [...workers].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  }

  private lastActivity(w: WorkItem, workers: readonly SessionInfo[]): number {
    return Math.max(Date.parse(w.updatedAt) || 0, ...workers.map((s) => Date.parse(s.lastActivityAt) || 0));
  }

  /** A worker's final report states the work is done, nothing is open: close it (the report, not a guess). */
  private deliveredStep(w: WorkItem, workers: readonly SessionInfo[], acts: Action[]): boolean {
    if (!isOpen(w) || !workers.length || w.question || w.flag) return false;
    if ((w.prs ?? []).some((p) => p.state === 'open')) return false;
    const last = this.latest(workers);
    if (!last || last.status === 'error' || this.now() - this.lastActivity(w, workers) < REPORT_QUIET_MS) return false;
    const release = isRelease(w);
    if (reportVerdict(last.lastResult, release) !== 'delivered') return false;
    const reason = release ? undefined : afterMergeReason(w, [last.lastResult ?? '']);
    if (reason) return false;
    this.closeAsDone(w, { how: 'report', text: `its worker's final report says it is delivered: "${clip(oneLine(last.lastResult ?? ''), 140)}"` }, acts);
    return true;
  }

  /** A worker a limit, a restart or a refused tool stopped: resume it once, or stall the request with the reason. */
  private cutOffStep(w: WorkItem, workers: readonly SessionInfo[], acts: Action[]): boolean {
    if (!isOpen(w) || !workers.length) return false;
    const last = this.latest(workers);
    if (!last) return false;
    const evidence = this.d.store.readTranscript(last.id, 8).flatMap((e) => (e.kind === 'error' || e.kind === 'system' || e.kind === 'result' || e.kind === 'assistant' ? [e.text] : []));
    const cut = cutOffOf(last, evidence);
    if (!cut) return false;
    const who = w.requesters;
    const stall = (reason: string) => {
      this.stall(w, 'cut-off', reason, acts);
      return true;
    };
    if (w.resumedBy?.[last.id]) return stall(`${cut.reason}; the cleanup resumed it once already (${w.resumedBy[last.id].slice(0, 10)}) and it was cut off again`);
    if (cut.kind === 'refused') return stall(`${cut.reason}; resuming would be refused again`);
    if (cut.kind === 'limit') {
      const clear = this.d.limitsClear?.(last);
      if (clear !== true) return stall(`${cut.reason}; ${clear === false ? 'the limit has not reset yet' : 'whether the limit has reset is unknown'}`);
    }
    if (!this.d.resume) return stall(`${cut.reason}; this server cannot resume it`);
    const at = new Date(this.now()).toISOString();
    this.d.orchestrators.ledgerEdit(w.id, `ledger cleanup resumed worker ${last.id} once: ${cut.reason}`, (x) => void (x.resumedBy = { ...(x.resumedBy ?? {}), [last.id]: at }));
    this.d.resume(last.id, `[ledger cleanup] Your last turn on ${w.id} "${clip(w.title, 100)}" was cut off (${cut.reason}) and nobody resumed you. Carry on where you stopped. If the work is already done, say so in one line and stop.`);
    acts.push({ id: w.id, title: w.title, who, kind: 'resumed', text: `worker ${last.id}: ${cut.reason}` });
    return true;
  }

  private stall(w: WorkItem, kind: 'idle' | 'cut-off' | 'superseded' | 'unsure', reason: string, acts: Action[], by?: string) {
    if (w.status === 'stalled') return;
    const at = new Date(this.now()).toISOString();
    this.d.orchestrators.ledgerEdit(w.id, `stalled by the ledger cleanup: ${reason}`, (x) => {
      x.status = 'stalled';
      x.stalled = { at, kind, reason: clip(reason, 400), ...(by ? { by } : {}) };
    });
    acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'stalled', text: clip(reason, 160) });
  }

  /** Nothing running and nothing touched for 24 hours: covered by newer finished work, or simply stalled. Never closed. */
  private stallStep(w: WorkItem, workers: readonly SessionInfo[], acts: Action[]) {
    if (!stallCandidate(w)) return;
    const idle = this.now() - this.lastActivity(w, workers);
    if (idle < STALL_AFTER_MS) return;
    if ((w.prs ?? []).some((p) => p.state === 'open')) return;
    const finished = [...this.d.store.work.values()].filter((y) => y.status === 'done');
    const strong = this.d.orchestrators.currentOverlaps(w).filter((o) => o.kind === 'work' && o.score >= 0.8);
    const y = supersededBy(w, finished, strong);
    if (y) return this.stall(w, 'superseded', `probably superseded by ${y.id} "${clip(y.title, 80)}", which is done`, acts, y.id);
    const last = this.latest(workers);
    const days = idle >= 2 * 86_400_000 ? `${Math.floor(idle / 86_400_000)} days` : `${Math.floor(idle / 3_600_000)} hours`;
    if (last && reportVerdict(last.lastResult) === 'unsure' && last.lastResult) {
      return this.stall(w, 'unsure', `no worker running and no activity for ${days}; its worker's last report does not say it is done: "${clip(oneLine(last.lastResult), 140)}"`, acts);
    }
    this.stall(w, 'idle', `no worker running and no activity for ${days}${last ? `; its last worker ${last.id} ended ${last.status}` : '; no worker ever started on it'}`, acts);
  }
}

// ---------------------------------------------------------------- gh

interface GhPr {
  number: number;
  title: string;
  body?: string;
  headRefName: string;
  baseRefName: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  createdAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  mergeCommit?: { oid?: string } | null;
  url: string;
}

function fromGh(repo: string, p: GhPr): PrRecord {
  return {
    repo,
    number: p.number,
    url: p.url,
    title: p.title,
    body: p.body ?? '',
    head: p.headRefName,
    base: p.baseRefName,
    state: p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : 'open',
    createdAt: p.createdAt,
    ...(p.mergedAt ? { mergedAt: p.mergedAt } : {}),
    ...(p.closedAt ? { closedAt: p.closedAt } : {}),
    ...(p.mergeCommit?.oid ? { sha: p.mergeCommit.oid } : {}),
  };
}

export function summaryOf(acts: readonly { kind: Kind }[]): string {
  const n = (k: Kind) => acts.filter((a) => a.kind === k).length;
  const parts = [n('closed') && `closed ${n('closed')}`, n('resumed') && `resumed ${n('resumed')}`, n('stalled') && `stalled ${n('stalled')}`, n('open') && `${n('open')} left open with a reason`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing to do';
}

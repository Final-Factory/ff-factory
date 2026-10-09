// The ledger cleanup (docs/orchestrators.md, "Ledger cleanup"): requests nobody closes by hand. Two passes share this code.
//
// - Every 5 minutes (checkPrs): link each request to the pull requests its workers open, and close it as done when they
//   have merged and nothing is left to do after the merge (w304). The states of the PRs already linked are refreshed for
//   every request, a busy or a closed one too, and a DONE refused on a PR that has merged since is checked again (w515).
//   The first pass after a start that has not done it yet also re-reads every PR the ledger holds as open (the repair).
// - A worker's `DONE: wNNN`, or a report that says a linked PR merged, reads that request's open PRs live (refreshLive).
// - Every `ledger.cleanup.everyHours` hours, and on demand (run): that, plus the intake's merged requests (server/intake.ts
//   checkMerged), requests whose worker reported them delivered, workers a usage limit or a restart cut off (resumed
//   once, else stalled), requests another finished one probably covers, and requests nothing has touched for 24 hours,
//   which become `stalled` for their person to close or reopen (w306). A request whose PRs merged but which stays open
//   for a step after the merge, with no word about it for 6 hours, gets one "Is it done?" to its worker a day; a
//   `DONE: wNNN` reply closes it (server/orchestrators.ts), and with no worker left to ask it stalls (w419).
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
import { dryRun } from './dryRun.ts';
import { run as runProc } from './proc.ts';
import { afterReopen, doneOf, isOpen, settleByHand } from './work.ts';
import {
  STALL_AFTER_MS,
  REPORT_QUIET_MS,
  afterMergeReason,
  deployStep,
  partOfReason,
  cleanupSettings,
  followUpDecision,
  cutOffOf,
  isRelease,
  mergePrs,
  ownerAt,
  prUrlsIn,
  prMergedText,
  prsOf,
  reportVerdict,
  stallCandidate,
  stillOpenIn,
  supersededBy,
  type OpenedPr,
  type PrRecord,
} from './ledgerRules.ts';
import type { LedgerCleanupState, Requester, SessionInfo, WorkItem, WorkPr } from '../shared/types.ts';
import { servedBy } from '../shared/workState.ts';
import { BLOCKER_STUCK_MS } from '../shared/blockers.ts';
import { holdsItsPlace } from '../shared/agentState.ts';
import { appVersion } from './version.ts';

const CHECK_EVERY_MS = 5 * 60_000;
/** How long a full pass waits for a running pass to end before giving up this turn. */
const RUN_WAIT_MS = 10 * 60_000;
const BUSY: ReadonlySet<SessionInfo['status']> = new Set(['running', 'starting', 'waiting_permission']);
const PRS_PER_REPO = 200;
/** The full pass reads this many (w631): PRs named only by their titles, from before the `Request:` line, are older than 200. */
const PRS_PER_REPO_FULL = 1000;
/** Linked open PRs the list does not reach, read one by one: at most this many a pass (GitHub's rate limit: 5000 an hour). */
const REFRESH_OLD_PRS = 30;

export interface LedgerSweepDeps {
  cfg: Config;
  store: Store;
  orchestrators: Orchestrators;
  /** GitHub owner/name of the repos whose PRs are linked: the game repo and this app's own, besides config's. */
  repos?: () => Promise<string[]>;
  /** The newest PRs of those repos in every state (gh); undefined when gh could not say. */
  prs?: (repos: string[], limit: number) => Promise<PrRecord[] | undefined>;
  /** One PR by number, for a linked PR older than the list reaches. */
  viewPr?: (repo: string, number: number) => Promise<PrRecord | undefined>;
  /** Send a stopped worker a message, which resumes it. */
  resume?: (sessionId: string, text: string) => void;
  /** Whether the Claude account a worker ran on has room again (no meter near its limit), or undefined when unknown. */
  limitsClear?: (s: SessionInfo) => boolean | undefined;
  /** The intake's merged-branch rule (server/intake.ts checkMerged), run in a full pass; returns the ids it closed. */
  intakeMerged?: () => Promise<string[]>;
  // A deploy after the merge (w631, deployStep): what the portal and the machines run now.
  /** This app's own GitHub repo (owner/name), whose merges a deploy brings out. Default: its checkout's origin. */
  appRepo?: () => Promise<string | undefined>;
  /** The commit the portal runs (version.ts appVersion), or undefined when it is unknown. */
  portalSha?: () => string | undefined;
  /** The connected worker machines and the commit each one's daemon runs (sha undefined when its version is not one). */
  daemons?: () => { id: string; sha?: string }[];
  /** Whether commit `head` contains commit `sha`; undefined when that cannot be told. Default: git, then GitHub's compare. */
  contains?: (sha: string, head: string) => Promise<boolean | undefined>;
  now?: () => number;
}

interface Persisted {
  lastRunAt?: string;
  lastSummary?: string;
  /** The first pass ran: it lists what stayed open and why (the one-time backfill). */
  backfilledAt?: string;
  /** The one-time repair of stale PR states ran (w515): every PR held as open was read again, merged requests re-checked. */
  prRepairAt?: string;
}

/** closed, resumed, asked and stalled are what a pass did; open: a merged request that stayed open, and why (told on the first pass only); note: a PR was closed without merging (always told, once). */
type Kind = 'closed' | 'resumed' | 'asked' | 'stalled' | 'open' | 'note';
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
  /** The first re-check of automatic closes since this server started has been logged (w340: say it ran). */
  private recheckLogged = false;
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
    // A dry run (server/dryRun.ts): the copied ledger stays as copied, so its counts can be checked against the original.
    if (dryRun()) return this;
    this.d.orchestrators.prsLive = (id) => this.refreshLive(id);
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
    // A PR-only pass may be running (every 5 minutes, and the first full pass comes 10 minutes after a start): wait for it
    // rather than skip. Skipping is how no full pass ever ran (w363: `lastRunAt` never written, so nothing finished, cut
    // off, superseded or idle was ever closed, resumed or stalled; each restart put the next try 10 minutes after it).
    for (const end = this.now() + RUN_WAIT_MS; this.busy; ) {
      if (this.now() > end) return 'a cleanup is already running';
      await new Promise((r) => setTimeout(r, 2000));
    }
    const acts = await this.pass(true);
    const summary = this.data.lastSummary ?? summaryOf(acts);
    console.log(`ledger cleanup: full pass: ${summary}`);
    return summary;
  }

  private async pass(full: boolean): Promise<Action[]> {
    this.busy = true;
    this.publish();
    const acts: Action[] = [];
    try {
      const backfill = !this.data.backfilledAt;
      const repair = !this.data.prRepairAt;
      const prs = await this.loadPrs(full ? PRS_PER_REPO_FULL : PRS_PER_REPO);
      if (prs) await this.recheckClosed(prs, acts);
      if (prs) await this.refreshStates(prs, repair);
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
        // A DONE refused while a PR was open, whose PRs are all merged or closed now (w515): it closes on that DONE.
        if (Object.keys(doneOf(live)).length && !(live.prs ?? []).some((p) => p.state === 'open') && this.d.orchestrators.recheckDone(live.id, 'its PRs have merged or closed since')) {
          console.log(`ledger cleanup: closed ${live.id} on its refused DONE: its PRs have merged or closed since`);
          continue;
        }
        const workers = live.sessionIds.map((id) => this.d.store.sessions.get(id)).filter((s): s is SessionInfo => !!s);
        // A Waiting worker (w475: a running job, a queued message or a check-in ahead) will come back, and so will a stopped
        // one its check-in or a queued message resumes (w509): as good as busy here.
        const busy = workers.filter((s) => BUSY.has(s.status) || holdsItsPlace(s, this.now()));
        if (busy.length) {
          // A worker busy on ANOTHER request (it moved on, w418) can still be asked about this one (w419): the question
          // waits until its turn ends. Nothing else touches a request with a running worker.
          if (full && !busy.some((s) => servedBy(s.id, work).has(live.id))) this.followUpStep(live, workers, acts);
          continue;
        }
        try {
          if (prs && (await this.prStep(live, workers, prs, acts))) continue;
          if (!full) continue;
          if (this.deliveredStep(live, workers, acts)) continue;
          if (this.cutOffStep(live, workers, acts)) continue;
          if (this.followUpStep(live, workers, acts)) continue;
          this.stallStep(live, workers, acts);
        } catch (e) {
          console.warn(`ledger cleanup: ${live.id}: ${(e as Error).message}`);
        }
      }
      if (repair && prs) {
        this.repairReport(acts);
        this.data.prRepairAt = new Date(this.now()).toISOString();
      }
      const notable = acts.filter((a) => a.kind !== 'open' || backfill || repair);
      // Each change in the server log too (w363), with whose request it is.
      for (const a of acts) if (a.kind === 'closed' || a.kind === 'stalled' || a.kind === 'resumed' || a.kind === 'asked') console.log(`ledger cleanup: ${a.kind} ${a.id} (${a.who.map((r) => r.userId).join(', ')}): ${clip(oneLine(a.text), 200)}`);
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
      const text = [...part('closed', 'closed as done'), ...part('resumed', 'resumed'), ...part('asked', 'asked its worker whether it is done'), ...part('stalled', 'stalled, for you to close or reopen'), ...part('note', 'for your attention'), ...part('open', 'stayed open')].join('. ');
      this.d.orchestrators.toPeople([who], `[ledger cleanup] ${text}.`);
    }
  }

  // ---------------------------------------------------------------- pull requests (w304)

  private async repoSlugs(): Promise<string[]> {
    if (this.d.repos) return this.d.repos();
    if (this.repoCache) return this.repoCache;
    const given = this.settings.repos;
    this.repoCache = given ?? [...new Set([await slugOf(this.d.cfg.repo.basePath), await this.appSlug()].filter((x): x is string => !!x))];
    return this.repoCache;
  }

  private appSlugCache?: string | null;

  /** This app's own repo, owner/name (its checkout's origin), or undefined. */
  private async appSlug(): Promise<string | undefined> {
    if (this.d.appRepo) return this.d.appRepo();
    if (this.appSlugCache === undefined) this.appSlugCache = (await slugOf(path.resolve(import.meta.dirname, '..')).catch(() => undefined)) ?? null;
    return this.appSlugCache ?? undefined;
  }

  private async loadPrs(limit: number): Promise<PrRecord[] | undefined> {
    const repos = await this.repoSlugs();
    if (!repos.length) return undefined;
    if (this.d.prs) return this.d.prs(repos, limit);
    const out: PrRecord[] = [];
    for (const repo of repos) {
      const r = await runProc('gh', ['pr', 'list', '-R', repo, '--state', 'all', '--limit', String(limit), '--json', 'number,title,body,headRefName,baseRefName,state,createdAt,mergedAt,closedAt,mergeCommit,url'], { timeoutMs: limit > PRS_PER_REPO ? 180_000 : 45_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
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
    let checked = 0;
    let reopened = 0;
    for (const w of [...this.d.store.work.values()]) {
      if (w.status !== 'done' || w.autoClosed?.how !== 'prs' || !w.autoClosed.pr || Date.parse(w.autoClosed.at) < since) continue;
      // ONLY ITS OWN CLOSE (w370): a request a person, the dispatcher or a worker closed or reopened after the cleanup
      // closed it is theirs now, and a stale mark from before settleByHand existed (w50, w339) is dropped, not acted on.
      if (handledAfterAutoClose(w.log)) {
        this.d.orchestrators.ledgerEdit(w.id, 'the ledger cleanup dropped its old automatic-close mark: a person closed this request since', (x) => settleByHand(x), true);
        continue;
      }
      checked++;
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
        reopened++;
        // IN THE SERVER LOG TOO (w340: after the f4ce1cd deploy it reopened 42 requests, w312 among them, and the log
        // said nothing, so it looked as if it had not run).
        console.log(`ledger cleanup: reopened ${w.id} (${status}): ${text}`);
      } catch (e) {
        console.warn(`ledger cleanup: recheck ${w.id}: ${(e as Error).message}`);
      }
    }
    if (!this.recheckLogged || reopened) {
      this.recheckLogged = true;
      console.log(`ledger cleanup: rechecked ${checked} automatic close(s) from the last 14 days; reopened ${reopened}`);
    }
  }

  /**
   * The states of the PRs already linked to requests (w515), from this pass's list, and by number for the open ones the
   * list does not reach: for every request, a busy one (its PR step is skipped while its worker runs) and a closed one
   * (w443 still showed #1087 open after a person closed it) alike. Reading by number is for open requests only, at most
   * REFRESH_OLD_PRS a pass, except in the one-time repair, which reads every PR held as open. No new links here.
   */
  private async refreshStates(all: readonly PrRecord[], repair: boolean) {
    const listed = new Map(all.map((p) => [`${p.repo.toLowerCase()}#${p.number}`, p]));
    let viewed = 0;
    let failed = 0;
    for (const w of [...this.d.store.work.values()]) {
      const open = (w.prs ?? []).filter((p) => p.state === 'open');
      if (!open.length) continue;
      const live = isOpen(w) || w.status === 'stalled';
      const records: PrRecord[] = [];
      for (const p of open) {
        const l = listed.get(`${p.repo.toLowerCase()}#${p.number}`);
        if (l) records.push(l);
        else if (repair || (live && viewed < REFRESH_OLD_PRS)) {
          viewed++;
          const v = await this.view(p.repo, p.number).catch(() => undefined);
          if (v) records.push(v);
          else failed++;
        }
      }
      if (records.length) this.applyStates(w.id, records, repair ? 'the one-time repair' : 'the 5-minute read', live);
    }
    if (repair) console.log(`ledger cleanup: PR repair: read ${viewed} PR(s) by number beyond the list; ${failed} could not be read`);
  }

  /**
   * A request's open PRs read live from GitHub, one `gh pr view` each (w515): on a worker's DONE (server/orchestrators.ts
   * doneMarkers) and on a report saying a linked PR merged. Updates their states; answers the ones gh could not read.
   * `recheck`: a refused DONE is checked again when one has merged or closed (off for the DONE being decided now).
   */
  async refreshLive(id: string, recheck = false): Promise<{ unverified: number[] }> {
    const w = this.d.store.work.get(id);
    const unverified: number[] = [];
    const found: PrRecord[] = [];
    for (const p of (w?.prs ?? []).filter((x) => x.state === 'open').slice(0, REFRESH_OLD_PRS)) {
      const v = await this.view(p.repo, p.number).catch(() => undefined);
      if (v) found.push(v);
      else unverified.push(p.number);
    }
    if (found.length) this.applyStates(id, found, 'read live from GitHub', recheck);
    return { unverified };
  }

  /**
   * New states for a request's linked PRs from gh's records (no links added or dropped), logged quietly when one changed.
   * `recheck`: when one left open, a DONE refused while it was open is checked again (Orchestrators.recheckDone).
   */
  private applyStates(id: string, records: readonly PrRecord[], how: string, recheck: boolean) {
    const w = this.d.store.work.get(id);
    if (!w?.prs?.length) return;
    const same = (a: { repo: string; number: number }, b: { repo: string; number: number }) => a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();
    const changed: WorkPr[] = [];
    const next = w.prs.map((p) => {
      const r = records.find((x) => same(x, p));
      if (!r || r.state === p.state) return p;
      const { noted: _noted, at: _at, sha: _sha, ...rest } = p;
      const q: WorkPr = { ...rest, state: r.state, ...(r.state === 'merged' ? { at: r.mergedAt, ...(r.sha ? { sha: r.sha } : {}) } : r.state === 'closed' ? { at: r.closedAt } : {}) };
      changed.push(q);
      return q;
    });
    if (!changed.length) return;
    const what = changed.map((p) => `PR #${p.number} ${p.state}`).join(', ');
    this.d.orchestrators.ledgerEdit(id, `pull request states updated (${how}): ${what}`, (x) => void (x.prs = next), true);
    if (recheck && changed.some((p) => p.state !== 'open') && this.d.orchestrators.recheckDone(id, `${what} since (${how})`)) console.log(`ledger cleanup: closed ${id} on its refused DONE: ${what} (${how})`);
  }

  /**
   * The one-time repair's account (w515), in the server log: each open request whose PRs have all merged, and what keeps
   * it open, or that this pass closed it.
   */
  private repairReport(acts: readonly Action[]) {
    const all = [...this.d.store.work.values()];
    for (const a of acts.filter((x) => x.kind === 'closed')) console.log(`ledger cleanup: PR repair: ${a.id} closed: ${clip(oneLine(a.text), 200)}`);
    for (const w of all) {
      if (!(isOpen(w) || w.status === 'stalled') || acts.some((a) => a.id === w.id && a.kind === 'closed')) continue;
      const prs = w.prs ?? [];
      if (!prs.some((p) => p.state === 'merged') || prs.some((p) => p.state === 'open')) continue;
      const workers = w.sessionIds.map((id) => this.d.store.sessions.get(id)).filter((s): s is SessionInfo => !!s);
      const busy = workers.filter((s) => BUSY.has(s.status) || holdsItsPlace(s, this.now()));
      const reason =
        w.question ? 'it waits on a question' : w.flag ? 'it waits on a design question' : busy.length ? `its worker ${busy.map((s) => s.id).join(', ')} is busy or waiting, so the cleanup leaves it alone` : (partOfReason(w.id, prs) ?? afterMergeReason(w, workers.map((s) => s.lastResult ?? '')) ?? 'nothing found left; the next pass closes it');
      console.log(`ledger cleanup: PR repair: ${w.id} stays open: ${clip(oneLine(reason), 240)}`);
    }
  }

  /** Link PRs, note what changed, close or leave open. True when the request was closed (it needs nothing more). */
  private async prStep(w: WorkItem, workers: readonly SessionInfo[], all: readonly PrRecord[], acts: Action[]): Promise<boolean> {
    const found = prsOf(w, all, { opened: this.openedBy(w, workers) });
    // A linked PR the list no longer reaches was read by number already this pass (refreshStates).
    let prs = mergePrs(w.prs ?? [], found);
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
    const partOf = partOfReason(w.id, prs);
    const reason = partOf ?? afterMergeReason(w, workers.map((s) => s.lastResult ?? ''));
    // ONLY A DEPLOY LEFT, AND IT HAPPENED (w631): w605, w513, w537 and w600 waited on a portal deploy or machine updates,
    // which the ops worker or a person then did, and nothing told the ledger. What runs now is the evidence.
    const step = reason && !partOf ? await this.appDeployStep(w, workers, merged) : undefined;
    const deployed = step ? await this.deployedText(step, merged) : undefined;
    if (deployed) {
      this.closeAsDone(w, { how: 'deploy', pr: last.number, sha: last.sha, mergedAt: last.at, text: `${prMergedText(last)}; deployed since: ${deployed}` }, acts);
      return true;
    }
    if (reason) {
      note(last, `merged:${reason.slice(0, 40)}`, `PR #${last.number} merged; still open: ${reason}`);
      // Only a deploy left, not yet run (w643): Blocked on that deploy, not "Merged, follow-up pending"; it closes above
      // once what runs contains the merge, and a week without one stalls it.
      if (this.deployBlock(w, step, reason, acts)) return false;
      acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'open', text: `PR #${last.number} merged; ${reason}` });
      return false;
    }
    this.closeAsDone(w, { how: 'prs', pr: last.number, sha: last.sha, mergedAt: last.at, text: prMergedText(last) }, acts);
    return true;
  }

  /**
   * The deploy of this app that is a request's only step left after its merge (deployStep), when every merged PR of it is
   * this app's own with its merge commit known (a game repo's "deploy" is not the portal's); else undefined.
   */
  private async appDeployStep(w: WorkItem, workers: readonly SessionInfo[], merged: readonly WorkPr[]): Promise<{ portal: boolean; machines: boolean } | undefined> {
    const step = deployStep(w, workers.map((s) => s.lastResult ?? ''));
    if (!step || !merged.length) return undefined;
    const app = (await this.appSlug())?.toLowerCase();
    if (!app || merged.some((p) => p.repo.toLowerCase() !== app || !p.sha)) return undefined;
    return step;
  }

  /**
   * A merged request whose only step left is a deploy of this app that has not run yet is Blocked on it (w643), by the
   * cleanup (`by: ledger cleanup`): blocked once, unblocked back to its follow-up when another step turns out to be left,
   * and stalled after BLOCKER_STUCK_MS.deploy without the deploy. A request the dispatcher blocked is its own. Returns
   * whether the request is (still) blocked on the deploy.
   */
  private deployBlock(w: WorkItem, step: { portal: boolean; machines: boolean } | undefined, reason: string | undefined, acts: Action[]): boolean {
    const mine = w.status === 'blocked' && w.blocked?.by === 'ledger cleanup';
    if (w.status === 'blocked' && !mine) return false;
    if (!step) {
      if (mine) this.d.orchestrators.ledgerEdit(w.id, `unblocked by the ledger cleanup: a deploy is no longer the only step left${reason ? ` (still open: ${reason})` : ''}`, (x) => void (x.status = 'active'));
      return false;
    }
    if (!isOpen(w)) return false;
    const what = step.portal && step.machines ? "a portal deploy and the machines' update, after the merge" : step.portal ? 'a portal deploy, after the merge' : "the machines' update, after the merge";
    if (!mine) {
      const at = new Date(this.now()).toISOString();
      const sha = step.portal ? (this.d.portalSha ?? (() => appVersion().sha))() : undefined;
      this.d.orchestrators.ledgerEdit(w.id, `blocked by the ledger cleanup on ${what}: its only step left`, (x) => {
        x.status = 'blocked';
        x.blocked = { kind: 'deploy', ...(step.portal ? {} : { ref: 'machines' }), what, at, by: 'ledger cleanup', ...(sha ? { sha } : {}) };
      });
      acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'open', text: `merged; blocked on ${what}` });
      return true;
    }
    const age = this.now() - (Date.parse(w.blocked!.at) || this.now());
    if (age >= BLOCKER_STUCK_MS.deploy!) {
      this.stall(w, 'blocked', `blocked on ${what} for ${Math.floor(age / 86_400_000)} days: no deploy has run the merge`, acts);
      return false;
    }
    return true;
  }

  /** Answers of `contains`, by "<sha>:<head>" (ancestry never changes; unknown answers are not kept). */
  private readonly containsCache = new Map<string, boolean>();

  /**
   * When a request's only step left after its merge is a deploy of this app (deployStep), and it has happened, how:
   * "the portal runs 1a2b3c4" (and "each connected machine's daemon runs it: beast 1a2b3c4, …" when the step names the
   * machines). Undefined otherwise: another step is left, a merged PR is not this app's (a game repo's "deploy" is not
   * the portal's), or what runs does not contain every merge yet, or cannot be told.
   */
  private async deployedText(step: { portal: boolean; machines: boolean }, merged: readonly WorkPr[]): Promise<string | undefined> {
    const runs = async (head: string) => {
      for (const p of merged) if ((await this.containsSha(p.sha!, head)) !== true) return false;
      return true;
    };
    const parts: string[] = [];
    if (step.portal) {
      const head = (this.d.portalSha ?? (() => appVersion().sha))();
      if (!head || !(await runs(head))) return undefined;
      parts.push(`the portal runs ${head.slice(0, 12)}`);
    }
    if (step.machines) {
      const ds = this.d.daemons?.() ?? [];
      if (!ds.length) return undefined;
      for (const d of ds) if (!d.sha || !(await runs(d.sha))) return undefined;
      parts.push(`each connected machine's daemon runs it (${ds.map((d) => `${d.id} ${d.sha!.slice(0, 12)}`).join(', ')})`);
    }
    return parts.join(', and ');
  }

  private async containsSha(sha: string, head: string): Promise<boolean | undefined> {
    const key = `${sha}:${head}`;
    const known = this.containsCache.get(key);
    if (known !== undefined) return known;
    const r = await (this.d.contains ?? ((a: string, b: string) => this.gitContains(a, b)))(sha, head).catch(() => undefined);
    if (r !== undefined) this.containsCache.set(key, r);
    return r;
  }

  /** git merge-base --is-ancestor in this app's checkout (a release is a worktree of the portal's clone), else GitHub's compare. */
  private async gitContains(sha: string, head: string): Promise<boolean | undefined> {
    const app = path.resolve(import.meta.dirname, '..');
    const g = await runProc('git', ['-C', app, 'merge-base', '--is-ancestor', sha, head], { timeoutMs: 15_000 });
    if (g.code === 0) return true;
    if (g.code === 1) return false;
    const repo = await this.appSlug();
    if (!repo) return undefined;
    const r = await runProc('gh', ['api', `repos/${repo}/compare/${sha}...${head}`, '--jq', '.status'], { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    const status = r.code === 0 ? r.stdout.trim() : '';
    return status === 'ahead' || status === 'identical' ? true : status === 'behind' || status === 'diverged' ? false : undefined;
  }

  private closeAsDone(w: WorkItem, how: { how: 'prs' | 'report' | 'deploy'; pr?: number; sha?: string; mergedAt?: string; text: string }, acts: Action[]) {
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

  /**
   * A worker's final report states the work is done, nothing is open: close it (the report, not a guess). A stalled
   * request too, when that report came after the stall (w631: a worker that went back to a stalled request and finished
   * it was never read again, so it stayed stalled).
   */
  private deliveredStep(w: WorkItem, workers: readonly SessionInfo[], acts: Action[]): boolean {
    if (!workers.length || w.question || w.flag) return false;
    if ((w.prs ?? []).some((p) => p.state === 'open')) return false;
    const last = this.latest(workers);
    // A report from before a reopen (w731) says nothing about the reopened work: the worker has to report again.
    if (last && !afterReopen(w, last.lastActivityAt)) return false;
    const reportedSinceStall = w.status === 'stalled' && !!last && (Date.parse(last.lastActivityAt) || 0) > (Date.parse(w.stalled?.at ?? '') || Infinity);
    if (!isOpen(w) && !reportedSinceStall) return false;
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

  private stall(w: WorkItem, kind: 'idle' | 'cut-off' | 'superseded' | 'unsure' | 'blocked', reason: string, acts: Action[], by?: string) {
    if (w.status === 'stalled') return;
    const at = new Date(this.now()).toISOString();
    this.d.orchestrators.ledgerEdit(w.id, `stalled by the ledger cleanup: ${reason}`, (x) => {
      x.status = 'stalled';
      x.stalled = { at, kind, reason: clip(reason, 400), ...(by ? { by } : {}) };
    });
    acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'stalled', text: clip(reason, 160) });
  }

  /**
   * Merged, but open for a step after the merge (w419): with no word about it for 6 hours and no question in the last
   * day, ask its most recent worker once "Is it done?" (a `DONE: <id>` reply closes it), or stall it as follow-up
   * unconfirmed when no worker is left to ask. Returns whether it acted.
   */
  private followUpStep(w: WorkItem, workers: readonly SessionInfo[], acts: Action[]): boolean {
    // A blocked request waits on its blocker (w643): the blocker watch unblocks, stalls or asks, not "Is it done?".
    if (!isOpen(w) || w.question || w.flag || w.status === 'blocked') return false;
    const prs = w.prs ?? [];
    if (!prs.some((p) => p.state === 'merged') || prs.some((p) => p.state === 'open')) return false;
    const reason = partOfReason(w.id, prs) ?? afterMergeReason(w, workers.map((s) => s.lastResult ?? ''));
    if (!reason) return false;
    const all = [...this.d.store.work.values()];
    const d = followUpDecision(w, workers, reason, this.now(), (s) => servedBy(s.id, all).has(w.id), !!this.d.resume);
    if (!d) return false;
    if (d.kind === 'stall') {
      this.stall(w, 'unsure', d.why, acts);
      return true;
    }
    const last = [...prs].filter((p) => p.state === 'merged').sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).at(-1)!;
    const at = new Date(this.now()).toISOString();
    this.d.orchestrators.ledgerEdit(w.id, `ledger cleanup asked worker ${d.worker.id} whether it is done (no word for ${d.quietHours} h since PR #${last.number} merged; still open: ${d.why})`, (x) => void (x.followUp = { at, sessionId: d.worker.id }));
    this.d.resume!(
      d.worker.id,
      `[ledger cleanup] Is ${w.id} "${clip(w.title, 100)}" done? PR #${last.number} merged${last.at ? ` (${last.at.slice(0, 16).replace('T', ' ')} UTC)` : ''} and it stayed open: ${d.why}. If every step is finished, reply with a line \`DONE: ${w.id}\` and say how the step after the merge went. Otherwise say in one line what is left. If you are on other work now, answer this in one line and carry on with it.`,
    );
    acts.push({ id: w.id, title: w.title, who: w.requesters, kind: 'asked', text: `worker ${d.worker.id}, no word for ${d.quietHours} h` });
    return true;
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
    // Its worker said what is left, in so many words (w631): that is the reason, not a guess from the report.
    const said = last?.lastResult ? stillOpenIn(last.lastResult).get(w.id) : undefined;
    if (said) return this.stall(w, 'idle', `no worker running and no activity for ${days}; its worker said: "${clip(oneLine(said), 160)}"`, acts);
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

/**
 * Whether a request's log shows someone other than the cleanup closing or reopening it after the cleanup's last automatic
 * close: a person ("lothsahn: …; closed as done", "ben: reopened"), the dispatcher ("dispatcher: done: …"), or a worker's
 * marker (FIX-LANDED, RESOLVED).
 */
export function handledAfterAutoClose(log: readonly string[]): boolean {
  let at = -1;
  log.forEach((l, i) => {
    if (/^\d\d:\d\d closed automatically/.test(l)) at = i;
  });
  if (at < 0) return false;
  return log.slice(at + 1).some((l) => {
    const m = /^\d\d:\d\d (.*)$/.exec(l);
    const t = m?.[1] ?? '';
    if (/^(reopened by the ledger cleanup|closed automatically|linked PR|pull request states|PR #|the ledger cleanup|stalled by the ledger cleanup|ledger cleanup)/.test(t)) return false;
    return /^dispatcher: (done|declined|rejected|cancelled|merged into)\b/.test(t) || /^worker \S+: (FIX-LANDED|RESOLVED)\b/.test(t) || /^[\w.-]+: (.*; )?(closed as done|cancelled|reopened)\b/.test(t) || /^[\w.-]+: note: .*; (closed as done|cancelled)$/.test(t);
  });
}

export function summaryOf(acts: readonly { kind: Kind }[]): string {
  const n = (k: Kind) => acts.filter((a) => a.kind === k).length;
  const parts = [n('closed') && `closed ${n('closed')}`, n('resumed') && `resumed ${n('resumed')}`, n('asked') && `asked ${n('asked')} whether done`, n('stalled') && `stalled ${n('stalled')}`, n('open') && `${n('open')} left open with a reason`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing to do';
}

/** A checkout's GitHub repo, owner/name, from its origin's URL. */
async function slugOf(dir: string): Promise<string | undefined> {
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec((await runProc('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })).stdout.trim())?.[1];
}

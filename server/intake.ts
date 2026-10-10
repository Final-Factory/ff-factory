// The intake (docs/intake.md): everything that asks for work outside the people's own orchestrators, routed into the
// one work ledger so the dispatcher sees it beside everyone else's work, de-duplicated against what is in flight and
// what is done.
//
// - Discord: new #bug-reports threads (the in-game reporter's posts too) and trusted people's requests to Max in
//   #dev-chat, read with Max's bot token through server/max.ts (read-only; nothing here posts).
// - FFBox: its fix branches and diagnoses (the connector's conversations), the requests it files itself, and its
//   question "is this already in the ledger?" before it works a report (board_check).
// - Releases: once a landed fix ships in a version, one follow-up request tells its reporters.
// - The nightly e2e lab: each night's new regressions (and long-flaky scenarios) become requests, or are added to the
//   open request already on that scenario (POST /api/intake/nightly, server/nightlyRules.ts).
//
// Every switch is off by default (config intake, server/intakeRules.ts intakeSettings). The rules that are not a
// model's to decide (trust, caps, approval, quoting players' text) are fixed code here and in intakeRules.ts.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { emit } from './store.ts';
import type { Identity } from './identity.ts';
import type { BoardAnswer, Orchestrators } from './orchestrators.ts';
import { escalationBrief, escalationSource, escalationTitle, escalationTriage, type Escalation } from './escalationRules.ts';
import { diagnosisBrief, diagnosisKeys, diagnosisMatch, diagnosisSource, diagnosisTitle, diagnosisTriage, fixCovers, type Diagnosis } from './diagnosisRules.ts';

/** What FFBox gets back for an escalation (docs/intake.md, "Escalations from Max"). */
export type EscalationAnswer =
  /** approval (w299): pending while it waits for a reviewer (FFBox says it is waiting on a developer), else approved. */
  | { status: 'filed'; workId: string; triage: 'obvious-bug' | 'needs-human'; approval: 'pending' | 'approved' }
  | { status: 'in_flight'; workId: string }
  | { status: 'done'; workId: string; version: string | null }
  | { status: 'skipped'; why: string }
  /** An intake diagnosis (w361) filed and waiting for a reviewer; `filed` then means it is approved. */
  | { status: 'held'; workId: string }
  | { status: 'off' };
import type { BoardCheckMessage, ProviderRequestMessage, ResultMessage, WorkReply } from './providerProtocol.ts';
import { run } from './proc.ts';
import {
  bugBrief,
  bugSource,
  bugTitle,
  bundleVersionOf,
  capProblem,
  classifyBug,
  desyncTriage,
  ffboxDesyncSignal,
  triageOf,
  cleanLine,
  ffboxReviewFrom,
  intakeSettings,
  parseBugThread,
  parseDevRequest,
  quoteUntrusted,
  cleanBlock,
  releaseDraft,
  isFfboxOwned,
  reporterProblem,
  requestBrief,
  requestSource,
  requestTitle,
  type BugReport,
  type DevRequest,
  type DiscordMessage,
  type IntakeSettings,
} from './intakeRules.ts';
import { brokenNightDraft, mentionsScenario, NIGHT_BROKEN, nightlyAgainLine, nightlyDraft, nightlyKey, nightlyRunDraft, nightlySkip, nightStatus, type NightlyReport, type NightlyResult } from './nightlyRules.ts';
import { nextDaily } from './timers.ts';
import type { NightlyRunSettings } from './intakeRules.ts';
import { isOpen } from './work.ts';
import { linkedClosed, linkedDone, mergeCandidates, mergedBy, mergedText, parseLog, prNumberOf, type MergeRecord } from './mergedIntake.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import { dryRun } from './dryRun.ts';
import { escalationCatchUp, escalationRef, fixLearnable, fixedByPr, followed, reportFixesOf, reportIdsOf, reportLines, reportObsoletesOf, reportSweep, type BoardWatch, type CatchUpLine, type ReportFix, type ReportObsolete, type ReportSweep } from './boardFollow.ts';
import type { IntakeEntry, IntakeSummary, MaxEvent, NightlyNight, ProviderConversation, WorkAutoClosed, WorkItem, WorkSource, WorkSourceKind } from '../shared/types.ts';
import { ffboxConversationHref } from '../shared/ffboxLinks.ts';

const DISCORD_KINDS: readonly WorkSourceKind[] = ['discord-bug', 'discord-request'];
const FFBOX_KINDS: readonly WorkSourceKind[] = ['ffbox-branch', 'ffbox-diagnosis', 'ffbox-request'];
const NIGHTLY_KINDS: readonly WorkSourceKind[] = ['nightly'];
const KEEP_RECENT = 200;
const RELEASE_EVERY_MS = 10 * 60_000;
/** The nightly schedule's look (w864): fires and missing-night alarms within a minute. */
const NIGHTLY_RUN_EVERY_MS = 60_000;
/** A fire the portal was down for still starts up to this late (back by 06:00 for a 03:00 night); later, it is missing. */
const NIGHTLY_FIRE_LATE_MS = 3 * 3_600_000;
/** A run request that closed this long ago with no report from its night: that night is missing (its worker gave up). */
const NIGHTLY_CLOSED_GRACE_MS = 15 * 60_000;
/** Nights kept, newest first; the Intake tab shows the last 14. */
const NIGHTS_KEEP = 60;
const MERGED_EVERY_MS = 5 * 60_000;
/** Commits read from each base branch, and merged PRs read from GitHub, when looking for what a request's work became. */
const MERGED_LOG = 400;
const MERGED_PRS = 100;
const RELEASE_LOOKBACK_MS = 30 * 86_400_000;
/** What FFBox acts on in a board answer: an update goes only when this changes, not for a new updatedAt or title. */
const boardDigest = (a: BoardAnswer) => JSON.stringify([a.verdict, a.matches.map((m) => [m.id, m.status, m.watch ?? null, m.version, m.mergedIn, m.branch])]);

/** Board answers FFBox follows: re-checked this often, for at most this long, at most this many. */
const BOARD_RECHECK_MS = 60_000;
const BOARD_FOLLOW_MS = 30 * 86_400_000;
const BOARD_MAX = 500;
/** A followed request's fix (its PR, its release) is looked for this often, and again this long after a try that left it short. */
const FIX_EVERY_MS = 2 * 60_000;
const FIX_RETRY_MS = 30 * 60_000;
/** A done answer waits this long at most for that look, so FFBox's notice can name the PR and the version. */
const FIX_HOLD_MS = 15 * 60_000;
/** The one-time catch-up (w480): escalated requests closed done this many days back. */
const CATCH_UP_DAYS = 14;
/** Reports a finished request fixed (w502): told to FFBox for requests that changed this many days back. */
const REPORT_FIX_DAYS = 30;
/** Reports a declined request leaves (w853): told to FFBox for requests declined this many days back. */
const REPORT_OBSOLETE_DAYS = 30;
const VERSION_FILE = 'ProjectSettings/ProjectSettings.asset';

/** What server/max.ts gives the intake: reads only, the token stays there. */
export interface DiscordReader {
  hasToken: boolean;
  guildId: string | undefined;
  botId?: string;
  channelIdOf(alias: string): string | undefined;
  channelName(id: string): Promise<string | undefined>;
  ensureBotId(): Promise<string | undefined>;
  forumThreads(channelId: string): Promise<{ id: string; parent_id?: string; name?: string; owner_id?: string; message_count?: number }[]>;
  message(channelId: string, messageId: string): Promise<unknown>;
  messagesAfter(channelId: string, after?: string): Promise<{ id: string }[]>;
}

export interface IntakeDeps {
  cfg: Config;
  store: Store;
  identity: Identity;
  orchestrators: Orchestrators;
  discord?: DiscordReader;
  /** Send FFBox a board answer again when it changed (server/providers.ts pushBoard); false when it could not go. */
  pushBoard?: (ref: string, answer: BoardAnswer) => boolean;
  /** Whether a board answer may say `maybe` (else it says clear). server/index.ts: always, FFBox runs ffbox master. */
  takesMaybe?: () => boolean;
  /** The newest merged PRs of the repo (gh); the default asks gh. Undefined when it could not say: git alone is then used. */
  mergedPrs?: () => Promise<MergeRecord[] | undefined>;
  /** git in the base clone; the default runs it there. */
  git?: (args: string[]) => Promise<{ code: number; stdout: string }>;
  /** One pull request of the repo, if it merged (gh pr view); the default asks gh. */
  prInfo?: (n: number) => Promise<MergeRecord | undefined>;
  /** Tell FFBox a player's report is fixed (server/providers.ts pushReportFixed); false when it could not go. */
  pushReportFixed?: (fix: ReportFix) => boolean;
  /** Tell FFBox a player's report is obsolete, or no longer (server/providers.ts pushReportObsolete); false when it could not go. */
  pushReportObsolete?: (o: ReportObsolete & { withdrawn?: true }) => boolean;
  now?: () => number;
}

interface Persisted {
  /** Per channel: the newest thread or message seen ("bug:<id>", "req:<id>"). */
  cursors: Record<string, string>;
  recent: IntakeEntry[];
  /** bundleVersion per version-bump commit. */
  versions: Record<string, string>;
  lastVersion?: string;
  checkedAt?: string;
  /** Escalations from FFBox already answered, by their ref: a resend gets the same answer and files nothing new. */
  escalations?: Record<string, { answer: EscalationAnswer; at: number }>;
  /**
   * board_check answers of `maybe`, by FFBox conversation: the candidate requests, so that what FFBox files from that
   * conversation later names them for a person to merge. The newest MAYBE_KEEP.
   */
  maybes?: Record<string, { ids: string[]; scores: number[]; at: number }>;
  /** The last nightly report and what it came to (the Intake tab). */
  nightly?: NonNullable<IntakeSummary['nightly']>['last'];
  /** Every night the schedule fired or the lab reported, newest first (w864). */
  nights?: NightlyNight[];
  /** When the nightly schedule was first seen on: nights due before it are never fired late nor called missing. */
  nightlyRunSince?: number;
  /** Board answers FFBox follows, by ref (w480: kept across restarts, escalated threads' watches among them). */
  boards?: Record<string, BoardWatch>;
  /** When the resolver last looked for a followed request's fix (its PR, its release), by request. */
  fixTried?: Record<string, number>;
  /** The one-time catch-up of escalated threads (w480): when it ran and the refs it followed. */
  catchUp?: { at: string; refs: string[] };
  /** Players' reports a finished request fixed (w502), by report id: what FFBox is told, again on every link. */
  reportFixes?: Record<string, ReportFix & { at: string }>;
  /** w502's one-time sweep: when it ran, and what it found. */
  reportSweep?: { at: string; certain: number; uncertain: string[] };
  /** Players' reports a declined request leaves (w853), by report id: what FFBox is told, again on every link. */
  reportObsoletes?: Record<string, ReportObsolete & { at: string; withdrawn?: true }>;
  polledAt?: string;
  error?: string;
}

/** board_check `maybe` answers kept for linking what FFBox files later. */
const MAYBE_KEEP = 200;

/** A snowflake for a moment: every Discord id made after it is larger. */
const snowflakeAt = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const newer = (a: string, b: string) => BigInt(a) > BigInt(b);

export class IntakeManager {
  private readonly d: IntakeDeps;
  private readonly file: string;
  private data: Persisted;
  private readonly timers: NodeJS.Timeout[] = [];
  private polling = false;
  private checking = false;
  private resolving = false;
  private closing = false;
  private saveTimer?: NodeJS.Timeout;
  private emitTimer?: NodeJS.Timeout;
  readonly now: () => number;

  constructor(d: IntakeDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.file = path.join(d.cfg.dataDir, 'intake.json');
    this.data = this.load();
    // Oldest first, so the cap drops the oldest (watchBoard).
    for (const [ref, b] of Object.entries(this.data.boards ?? {}).sort((x, y) => x[1].at - y[1].at)) {
      if (b && Array.isArray(b.q?.keys) && typeof b.at === 'number') this.boards.set(ref, { q: b.q, last: typeof b.last === 'string' ? b.last : '', at: b.at, ...(typeof b.follow === 'string' ? { follow: b.follow } : {}) });
    }
  }

  get settings(): IntakeSettings {
    return intakeSettings(this.d.cfg);
  }

  /** Start the timers for what is switched on (not in unit tests, which call the steps by hand). */
  start() {
    // A dry run (server/dryRun.ts) polls nothing: no Discord, no releases, no merge or board checks.
    if (dryRun()) return this;
    const s = this.settings;
    const every = (ms: number, f: () => void, first: number) => {
      const a = setTimeout(f, first);
      a.unref();
      const b = setInterval(f, ms);
      b.unref();
      this.timers.push(a, b);
    };
    if (s.discord.enabled) every(s.discord.pollMinutes * 60_000, () => void this.pollDiscord(), 20_000);
    if (s.release.enabled) every(RELEASE_EVERY_MS, () => void this.checkReleases(), 60_000);
    // The nightly e2e lab's run, fired by the portal every night, and its missing-night alarm (w864).
    every(NIGHTLY_RUN_EVERY_MS, () => this.checkNightlyRun(), 15_000);
    // Requests whose branch or PR merged some other way close themselves (docs/intake.md, "Closed when it merged").
    every(MERGED_EVERY_MS, () => void this.checkMerged(), 90_000);
    // Board answers FFBox still follows are re-checked every minute; a change goes to it at once (docs/intake.md).
    every(BOARD_RECHECK_MS, () => this.recheckBoards(), BOARD_RECHECK_MS);
    // Players' reports a finished request fixed go to FFBox, recorded there and never posted (w502).
    every(BOARD_RECHECK_MS, () => this.pushReportFixes(), BOARD_RECHECK_MS);
    // Players' reports a declined request leaves go to FFBox as obsolete, recorded there and never posted (w853).
    every(BOARD_RECHECK_MS, () => this.pushReportObsoletes(), BOARD_RECHECK_MS);
    // A merged PR's `Report: <id>` lines make its request the work for those reports (w502).
    every(MERGED_EVERY_MS, () => void this.linkReportsFromPrs(), 120_000);
    // A followed request's fix: the PR that merged it and the release that carries it, for FFBox's notice (w480).
    every(FIX_EVERY_MS, () => void this.resolveFixes(), 45_000);
    // Once: escalated threads whose request closed done before FF Factory followed them (w480).
    const once = setTimeout(() => {
      this.catchUpEscalations();
      this.sweepReports();
    }, 30_000);
    once.unref();
    this.timers.push(once);
    return this;
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    clearTimeout(this.emitTimer);
    this.flush();
  }

  // ---------------------------------------------------------------- state

  private load(): Persisted {
    try {
      const d = readJsonDurable<Partial<Persisted>>(this.file, { check: checkObject });
      if (!d) throw new Error('none yet');
      return { cursors: d.cursors ?? {}, recent: d.recent ?? [], versions: d.versions ?? {}, lastVersion: d.lastVersion, checkedAt: d.checkedAt, polledAt: d.polledAt, error: d.error, nightly: d.nightly, nights: Array.isArray(d.nights) ? d.nights : undefined, nightlyRunSince: typeof d.nightlyRunSince === 'number' ? d.nightlyRunSince : undefined, escalations: d.escalations, maybes: d.maybes, boards: d.boards, fixTried: d.fixTried, catchUp: d.catchUp, reportFixes: d.reportFixes, reportSweep: d.reportSweep, reportObsoletes: d.reportObsoletes };
    } catch {
      return { cursors: {}, recent: [], versions: {} };
    }
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeJsonDurable(this.file, this.data);
    } catch (e) {
      console.warn('intake: could not save its state:', (e as Error).message);
    }
  }

  private changed() {
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => this.flush(), 1000);
      this.saveTimer.unref();
    }
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      emit({ type: 'intake', intake: this.summary() });
    }, 300);
    this.emitTimer.unref();
  }

  private record(e: Omit<IntakeEntry, 'at'>) {
    this.data.recent = [{ at: new Date(this.now()).toISOString(), ...e, title: cleanLine(e.title, 140) }, ...this.data.recent].slice(0, KEEP_RECENT);
    this.changed();
  }

  /** What a filing came to, in the log. */
  private outcome(source: WorkSourceKind, title: string, url: string | undefined, r: ReturnType<Orchestrators['fileIntake']>): IntakeEntry['action'] {
    if (r.skipped) this.record({ source, action: 'skipped', title, why: r.skipped, url });
    else if (r.repeat) this.record({ source, action: 'repeat', title, workId: r.item!.id, why: 'the same thread or conversation again', url });
    else if (r.mergedInto) this.record({ source, action: 'repeat', title, workId: r.mergedInto, why: `the same bug as ${r.mergedInto}: merged into it`, url });
    else this.record({ source, action: 'filed', title, workId: r.item!.id, why: r.item!.approval?.state === 'pending' ? `waits for a person: ${r.item!.approval.why}` : 'auto-approved', url });
    return r.skipped ? 'skipped' : r.repeat || r.mergedInto ? 'repeat' : 'filed';
  }

  // ---------------------------------------------------------------- Discord

  private lastCheck = 0;

  /** The Intake tab's "Check Discord now": a poll now, at most every 30 s (intake.discord.checkNowSeconds, tests only). */
  async checkNow(): Promise<{ ok: boolean; note?: string }> {
    if (!this.settings.discord.enabled) return { ok: false, note: 'the Discord intake is off (config intake.discord.enabled)' };
    const now = this.now();
    if (now - this.lastCheck < this.settings.discord.checkNowSeconds * 1000) return { ok: false, note: `checked ${Math.round((now - this.lastCheck) / 1000)} s ago; try again in a moment` };
    this.lastCheck = now;
    await this.pollDiscord();
    await this.checkMerged();
    return { ok: true };
  }

  /** One poll of the bug and request channels. Returns what it filed (tests). */
  async pollDiscord(): Promise<void> {
    const s = this.settings.discord;
    const dc = this.d.discord;
    if (!s.enabled || !dc || this.polling) return;
    if (!dc.hasToken) {
      this.data.error = 'no bot token (docs/max.md, "The bot token")';
      return this.changed();
    }
    this.polling = true;
    const errors: string[] = [];
    // A bug channel configured by id is still FFBox's when that id is one of its channels.
    const ffboxIds = new Set(s.ffboxOwned.map((a) => dc.channelIdOf(a)).filter(Boolean));
    try {
      for (const alias of s.bugChannels) {
        if (ffboxIds.has(dc.channelIdOf(alias))) continue;
        try {
          await this.pollBugChannel(alias);
        } catch (e) {
          errors.push(`${alias}: ${cleanLine((e as Error).message, 160)}`);
        }
      }
      for (const alias of s.requestChannels) {
        if (ffboxIds.has(dc.channelIdOf(alias))) continue;
        try {
          await this.pollRequestChannel(alias);
        } catch (e) {
          errors.push(`${alias}: ${cleanLine((e as Error).message, 160)}`);
        }
      }
    } finally {
      this.polling = false;
      this.data.polledAt = new Date(this.now()).toISOString();
      this.data.error = errors.length ? errors.join('; ') : undefined;
      this.changed();
    }
  }

  private async pollBugChannel(alias: string) {
    const dc = this.d.discord!;
    const id = dc.channelIdOf(alias);
    if (!id) throw new Error(`no channel id for "${alias}" in the ffbox config's discord.channels`);
    const key = `bug:${id}`;
    const threads = await dc.forumThreads(id);
    // The first look only marks where "new" starts: threads from before the intake was switched on are not filed.
    const cursor = this.data.cursors[key];
    if (!cursor) {
      const newest = threads.at(-1)?.id;
      const now = snowflakeAt(this.now());
      this.data.cursors[key] = newest && newer(newest, now) ? newest : now;
      return this.changed();
    }
    const name = `#${(await dc.channelName(id).catch(() => undefined)) ?? alias.replace(/_/g, '-')}`;
    const botId = dc.botId;
    for (const t of threads.filter((x) => newer(x.id, cursor))) {
      this.data.cursors[key] = t.id;
      if (botId && t.owner_id === botId) continue;
      let starter: DiscordMessage | undefined;
      try {
        starter = (await dc.message(t.id, t.id)) as DiscordMessage;
      } catch {
        // no starter message readable: the title still makes a report
      }
      this.fileBug(parseBugThread(t, starter, { guildId: dc.guildId, channel: name }));
    }
  }

  private async pollRequestChannel(alias: string) {
    const dc = this.d.discord!;
    const id = dc.channelIdOf(alias);
    if (!id) throw new Error(`no channel id for "${alias}" in the ffbox config's discord.channels`);
    const key = `req:${id}`;
    const cursor = this.data.cursors[key];
    const msgs = (await dc.messagesAfter(id, cursor)) as DiscordMessage[];
    if (!cursor) {
      const newest = msgs.at(-1)?.id;
      const now = snowflakeAt(this.now());
      this.data.cursors[key] = newest && newer(newest, now) ? newest : now;
      return this.changed();
    }
    const botId = await this.d.discord!.ensureBotId();
    if (!botId) throw new Error('the bot id is unknown (the token check has not answered)');
    const name = `#${(await dc.channelName(id).catch(() => undefined)) ?? alias.replace(/_/g, '-')}`;
    for (const m of msgs) {
      if (!newer(m.id, this.data.cursors[key])) continue;
      this.data.cursors[key] = m.id;
      const r = parseDevRequest(m, botId, this.settings.discord.trusted, { guildId: dc.guildId, channelId: id });
      if (!r) continue;
      // Who wrote it is not shown: an untrusted person's name is not worth a line of the log.
      if ('ignored' in r) this.record({ source: 'discord-request', action: 'ignored', title: `a message to Max in ${name}`, why: r.ignored });
      else this.fileRequest(r, name);
    }
  }

  /** A bug report into the ledger, for the system payer. */
  fileBug(r: BugReport): IntakeEntry['action'] {
    const s = this.settings;
    const items = () => this.d.store.work.values();
    const now = this.now();
    const res = this.d.orchestrators.fileIntake({
      title: bugTitle(r),
      brief: bugBrief(r),
      source: bugSource(r),
      triage: classifyBug(r),
      requestedBy: this.d.identity.systemPayer(),
      autoApprove: { ...s.discord.autoApprove, allowed: s.discord.autoApprove.bugs },
      kinds: DISCORD_KINDS,
      lookbackDays: s.lookbackDays,
      limit: () => capProblem(items(), DISCORD_KINDS, s.discord.dailyCap, now) ?? reporterProblem(items(), r.reporterKey, s.discord.perReporterPerDay, now),
    });
    return this.outcome('discord-bug', r.title, r.url, res);
  }

  /** A trusted person's request to Max into the ledger, for that person. */
  fileRequest(r: DevRequest, channel: string): IntakeEntry['action'] {
    const s = this.settings;
    const person = this.d.identity.get(r.userId);
    if (!person) {
      this.record({ source: 'discord-request', action: 'ignored', title: `a message to Max in ${channel}`, why: `intake.discord.trusted maps its author to "${r.userId}", which is no login here` });
      return 'ignored';
    }
    const now = this.now();
    const source = requestSource(r, channel, person.displayName);
    const res = this.d.orchestrators.fileIntake({
      title: requestTitle(r),
      brief: requestBrief(r, person.displayName),
      source,
      triage: triageOf(source),
      requestedBy: person,
      person: true,
      autoApprove: { ...s.discord.autoApprove, allowed: s.discord.autoApprove.requests },
      kinds: DISCORD_KINDS,
      lookbackDays: s.lookbackDays,
      limit: () => capProblem(this.d.store.work.values(), DISCORD_KINDS, s.discord.dailyCap, now),
    });
    return this.outcome('discord-request', requestTitle(r), r.url, res);
  }

  /** Max replied in or closed a thread (server/max.ts onEvent): intake requests there record it. */
  onMaxEvent(ev: MaxEvent) {
    if (!ev.ok) return;
    if (ev.action === 'close') {
      const thread = ev.thread?.id ?? ev.channelId;
      if (thread) this.d.orchestrators.noteDelivery(thread, 'closedAt', ev.at);
    } else if ((ev.action === 'reply' || ev.action === 'post') && ev.channelId) {
      this.d.orchestrators.noteDelivery(ev.channelId, 'repliedAt', ev.at);
    }
  }

  // ---------------------------------------------------------------- FFBox

  /** A conversation from the connector: our own submissions record their progress; a fix branch becomes a review request. */
  onConversation(c: ProviderConversation) {
    this.d.orchestrators.ffboxConversation(c);
    const s = this.settings.ffbox;
    if (!s.enabled) return;
    // Its pull request merged or closed on FFBox's side: the review request for it needs nothing more.
    if (c.pr && c.pr.state !== 'open') {
      for (const w of this.d.store.work.values()) {
        // An operator's dev request is theirs to close, whatever FFBox's conversation does.
        if (w.source?.conversation !== c.id || !w.source.kind.startsWith('ffbox') || w.source.kind === 'ffbox-dev' || !['new', 'question', 'queued', 'blocked', 'active'].includes(w.status)) continue;
        this.d.orchestrators.closeIntake(w.id, `FFBox's PR #${c.pr.number} ${c.pr.state === 'merged' ? 'merged' : 'was closed'}`);
      }
    }
    const draft = ffboxReviewFrom(c, s);
    if (!draft) return;
    const now = this.now();
    const desync = this.desyncRoute({ key: c.key, title: c.title, opener: c.opener, source: c.source, agentClass: c.agentClass });
    const res = this.d.orchestrators.fileIntake({
      ...draft,
      triage: desync?.triage ?? triageOf(draft.source, c.opener === 'fff' ? 'system' : c.opener, { title: c.title, text: '' }),
      requestedBy: this.d.identity.systemPayer(),
      autoApprove: desync?.autoApprove ?? s.autoApprove,
      kinds: FFBOX_KINDS,
      lookbackDays: this.settings.lookbackDays,
      limit: () => capProblem(this.d.store.work.values(), FFBOX_KINDS, s.dailyCap, now),
    });
    // A conversation is reported again on every change: log only what is new.
    if (!res.repeat) {
      this.outcome(draft.source.kind, draft.title, draft.source.url, res);
      if (!res.mergedInto) this.linkMaybe(c.id, res.item?.id);
    }
  }

  /**
   * Lothsahn's desync PR policy (2026-10-04, w358): an FFBox desync diagnosis or its ffbox/* PR is approved at once into
   * a review-and-merge request whose worker classifies it and follows the policy (intakeRules.ts DESYNC_PR_POLICY), at
   * most intake.ffbox.desync.maxPerDay a day; the daily caps and the duplicate checks still apply. Undefined when it is
   * not one, or the policy is switched off (then the usual triage applies).
   */
  private desyncRoute(x: Parameters<typeof ffboxDesyncSignal>[0]) {
    const d = this.settings.ffbox.desync;
    const why = d.enabled ? ffboxDesyncSignal(x) : undefined;
    return why ? { triage: desyncTriage(why), autoApprove: { enabled: true, maxPerDay: d.maxPerDay } } : undefined;
  }

  /** FFBox filed a request (the connector's "request" message); undefined while that is off. */
  onRequest(m: ProviderRequestMessage): { workId?: string; status: string; repeat?: boolean; why?: string } | undefined {
    const s = this.settings.ffbox;
    if (!s.enabled || !s.requests) return undefined;
    const operator = m.opener === 'operator' && m.requestedBy ? this.d.identity.get(m.requestedBy.userId) : undefined;
    const untrusted = m.opener !== 'operator';
    const kindLine = m.kind === 'review-branch' ? 'a fix branch to review and merge' : m.kind === 'escalate' ? 'an escalation: work FFBox cannot do (a GPU, the three-machine rig)' : 'a request for development work';
    const source: WorkSource = {
      kind: 'ffbox-request',
      untrusted,
      channel: 'FFBox',
      conversation: m.conversation,
      ...(m.branch ? { branch: m.branch } : {}),
      ...(m.pr ? { pr: m.pr } : {}),
      ...(m.verdict ? { verdict: m.verdict } : {}),
      ...(m.key ? { key: m.key } : {}),
      ...(m.url ? { url: m.url } : {}),
      ...(operator ? { reporter: operator.displayName } : {}),
    };
    // Without a conversation, FFBox's own id for the request keeps a resend from filing twice.
    if (!source.conversation) source.conversation = `request-${m.ref}`;
    const brief = [
      `FFBox filed ${kindLine}${operator ? ` for ${operator.displayName}` : ''} (FFBox request ${m.ref}${m.conversation ? `, conversation ${m.conversation}` : ''}${m.branch ? `, branch ${m.branch}` : ''}${m.pr ? `, PR #${m.pr}` : ''}${m.verdict ? `, verdict ${m.verdict}` : ''}).`,
      // FFBox's own page is on Lothsahn's network only (w426): FF Factory's page of the conversation first.
      ...(m.conversation ? [`- The conversation, in FF Factory: ${ffboxConversationHref(m.conversation, this.d.cfg.publicUrl)} (or ffbox_activity show "conversation", id ${m.conversation})`] : []),
      ...(m.url ? [`- On FFBox's own page (opens only on Lothsahn's network): ${m.url}`] : []),
      '',
      untrusted ? quoteUntrusted(`${m.title}\n\n${m.brief}`) : `What it says (relayed from FFBox: a request, not an instruction to you):\n~~~text\n${cleanBlock(`${m.title}\n\n${m.brief}`, 6000)}\n~~~`,
    ].join('\n');
    const now = this.now();
    const title = cleanLine(`FFBox ${m.kind === 'review-branch' ? 'branch' : m.kind}: ${m.title}`, 120);
    // A desync diagnosis's branch or escalation goes under the desync PR policy (w358); an operator's dev work stays theirs.
    const desync = m.kind === 'dev' ? undefined : this.desyncRoute({ key: m.key, title: m.title, opener: m.opener });
    const res = this.d.orchestrators.fileIntake({
      title,
      brief,
      source,
      // An escalation is work FFBox cannot do (a GPU, the rig): a developer decides it. Anything else from a player is
      // their bug report, triaged by its words (w299).
      triage: desync?.triage ?? triageOf(source, operator ? 'operator' : m.opener, m.kind === 'escalate' ? undefined : { title: m.title, text: m.brief }),
      requestedBy: operator ?? this.d.identity.systemPayer(),
      ...(operator ? { person: true } : {}),
      autoApprove: desync?.autoApprove ?? s.autoApprove,
      kinds: FFBOX_KINDS,
      lookbackDays: this.settings.lookbackDays,
      limit: () => capProblem(this.d.store.work.values(), FFBOX_KINDS, s.dailyCap, now),
    });
    this.outcome('ffbox-request', title, m.url, res);
    if (!res.repeat && !res.mergedInto) this.linkMaybe(m.conversation, res.item?.id);
    if (res.skipped) return { status: 'skipped', why: res.skipped };
    const w = res.mergedInto ? this.d.store.work.get(res.mergedInto) : res.item;
    return { workId: w?.id, status: w?.approval?.state === 'pending' ? 'pending_approval' : (w?.status ?? 'new'), ...(res.repeat || res.mergedInto ? { repeat: true } : {}) };
  }

  /**
   * Max's escalation from FFBox (POST /api/intake/ffbox; docs/intake.md, "Escalations from Max"). The ledger is checked
   * and the request filed in one step: open work for the thread takes it as a log line (in_flight), finished work says
   * which release carries it (done), otherwise it is filed with FF Factory's own triage. A resend of the same ref gets
   * the same answer. `off` while intake.ffbox.escalations (or intake.ffbox) is off.
   */
  onEscalation(e: Escalation): EscalationAnswer {
    const s = this.settings;
    if (!s.ffbox.enabled || !s.ffbox.escalations) return { status: 'off' };
    const seen = this.data.escalations?.[e.ref];
    const answer = seen ? seen.answer : this.remember(e.ref, this.escalate(e));
    if ((answer.status === 'filed' || answer.status === 'in_flight') && s.ffbox.enabled) this.followEscalation(e.conversation, e.threadId, answer.workId);
    return answer;
  }

  /**
   * Follow an escalated thread's request for FFBox (w480): the board ref FFBox watches after it links the conversation
   * (conv-<conversation>, discord:<thread>; ffwatch fff_escalation_link), answered with THAT request's standing, which
   * FFBox's own board_check cannot find (followAnswer). recheckBoards pushes it as it moves: in flight with its branch and
   * PR, then done with its PR and release, which FFBox says as its merge notice.
   */
  private followEscalation(conversation: string, threadId: string, workId: string) {
    const ref = escalationRef(conversation);
    const was = this.boards.get(ref);
    if (was?.follow === workId) return;
    this.boards.set(ref, { q: { keys: [`discord:${threadId}`], conversation }, last: '', at: this.now(), follow: workId });
    console.log(`intake: following ${workId} for FFBox's escalated conversation ${conversation} (board ${ref})`);
    this.capBoards();
    this.saveBoards();
  }

  /**
   * FFBox's finished intake diagnosis (w361; POST /api/intake/ffbox with `source: "intake"`, docs/intake.md "Intake
   * diagnoses from FFBox"): a player's desync or crash report diagnosed on FFBox, with or without a root cause or a fix.
   * It joins ledger work only on an exact key (a report id already on it, the same desync event, FFBox's own PR or
   * branch), among requests that came from a report; a shared signature is only a "maybe", noted on what it files.
   * Otherwise it is filed: a desync with a PR or a found root cause under the desync PR policy (w358), anything else by
   * the w299 triage. A resend of the same ref gets the same answer. `off` while intake.ffbox.escalations,
   * intake.ffbox.diagnoses or intake.ffbox is off.
   */
  onDiagnosis(d: Diagnosis): EscalationAnswer {
    const s = this.settings;
    if (!s.ffbox.enabled || !s.ffbox.escalations || !s.ffbox.diagnoses) return { status: 'off' };
    const seen = this.data.escalations?.[d.ref];
    if (seen) return seen.answer;
    return this.remember(d.ref, this.diagnosed(d));
  }

  /** An escalation's or diagnosis's answer, kept by its ref so a resend gets the same one. */
  private remember(ref: string, answer: EscalationAnswer): EscalationAnswer {
    const all = { ...this.data.escalations, [ref]: { answer, at: this.now() } };
    // The newest 500, and none older than 30 days.
    const keep = Object.entries(all)
      .filter(([, v]) => this.now() - v.at < 30 * 86_400_000)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, 500);
    this.data.escalations = Object.fromEntries(keep);
    this.changed();
    return answer;
  }

  private diagnosed(d: Diagnosis): EscalationAnswer {
    const s = this.settings;
    const title = diagnosisTitle(d);
    const now = this.now();
    const o = this.d.orchestrators;
    // The pool: requests open, or finished within the lookback (merged ones stand for what they merged into).
    const recent = (w: WorkItem) => isOpen(w) || (w.status === 'done' && now - Date.parse(w.updatedAt) < s.lookbackDays * 86_400_000);
    const seen = new Set<string>();
    const exact: { w: WorkItem; why: string }[] = [];
    const maybe: { w: WorkItem; why: string }[] = [];
    for (let w of this.d.store.work.values()) {
      if (w.status === 'merged' && w.mergedInto) w = this.d.store.work.get(w.mergedInto) ?? w;
      if (seen.has(w.id) || !recent(w)) continue;
      seen.add(w.id);
      const m = diagnosisMatch(w, d);
      if (m) (m.kind === 'exact' ? exact : maybe).push({ w, why: m.why });
    }
    const keys = diagnosisKeys(d);
    const open = exact.find((x) => isOpen(x.w));
    if (open) {
      o.attachDiagnosis(open.w.id, { keys, source: diagnosisSource(d), line: `FFBox's diagnosis ${d.ref} joined it (${open.why}): root cause ${d.rootCause === 'found' ? 'found' : 'not found'}, verdict ${d.verdict}, reports ${d.report.reportIds.join(', ')}, ${d.link}` });
      this.record({ source: 'ffbox-diagnosis', action: 'repeat', title, workId: open.w.id, why: open.why, url: d.link });
      return { status: 'in_flight', workId: open.w.id };
    }
    // Finished work answers `done` only when a released fix can be this bug: released in a version newer than the
    // report's game. A fix merged but not released yet is on its way (in flight); one the forked game already had is not it.
    const older: string[] = [];
    for (const x of exact) {
      const f = o.boardFacts(x.w);
      if (!f.mergedIn) continue;
      const covers = fixCovers(f.version, d.report.gameVersion);
      if (covers === 'covers') {
        o.attachDiagnosis(x.w.id, { keys, line: `FFBox's diagnosis ${d.ref} of reports ${d.report.reportIds.join(', ')} (game ${d.report.gameVersion}) matched it (${x.why}): fixed in ${f.version}, answered done` });
        this.record({ source: 'ffbox-diagnosis', action: 'repeat', title, workId: x.w.id, why: `fixed in ${f.version}`, url: d.link });
        return { status: 'done', workId: x.w.id, version: f.version ?? null };
      }
      if (covers === 'unreleased') {
        o.attachDiagnosis(x.w.id, { keys, line: `FFBox's diagnosis ${d.ref} of reports ${d.report.reportIds.join(', ')} matched it (${x.why}): merged (${f.mergedIn}), not released yet` });
        this.record({ source: 'ffbox-diagnosis', action: 'repeat', title, workId: x.w.id, why: 'its fix is merged, not released yet', url: d.link });
        return { status: 'in_flight', workId: x.w.id };
      }
      older.push(`${x.w.id} (fixed in ${f.version}, which game ${d.report.gameVersion} already had)`);
    }
    // NOT RAISED AGAIN (w853): a new diagnosis of reports a person already declined, with no fix pushed, is not filed
    // again; FFBox shows those reports obsolete (pushReportObsoletes). A report nobody declined still files the lot.
    const obsolete = new Map(reportObsoletesOf(this.d.store.work, now, s.lookbackDays).map((x) => [x.reportId, x.workId]));
    if (!d.pr && d.report.reportIds.length && d.report.reportIds.every((id) => obsolete.has(id))) {
      const by = [...new Set(d.report.reportIds.map((id) => obsolete.get(id)!))];
      const why = `its reports were declined in ${by.join(', ')}`;
      this.record({ source: 'ffbox-diagnosis', action: 'skipped', title, workId: by[0], why, url: d.link });
      return { status: 'skipped', why };
    }
    const source = diagnosisSource(d);
    // A desync with a fix pushed or a root cause found is a desync PR (w358); anything else is a player's report (w299).
    const desync = d.report.kind === 'desync' && (d.pr || d.rootCause === 'found') ? this.desyncRoute({ key: source.key, title: d.title, opener: 'system', source: 'intake', agentClass: 'ffdiagnose' }) : undefined;
    const res = o.fileIntake({
      title,
      brief: diagnosisBrief(d),
      source,
      triage: desync?.triage ?? diagnosisTriage(d),
      requestedBy: this.d.identity.systemPayer(),
      autoApprove: desync?.autoApprove ?? s.ffbox.autoApprove,
      kinds: FFBOX_KINDS,
      lookbackDays: s.lookbackDays,
      limit: () => capProblem(this.d.store.work.values(), FFBOX_KINDS, s.ffbox.dailyCap, now),
    });
    this.outcome('ffbox-diagnosis', title, d.link, res);
    if (res.skipped) return { status: 'skipped', why: res.skipped };
    const w = res.mergedInto ? this.d.store.work.get(res.mergedInto) : res.item;
    if (!w) return { status: 'skipped', why: 'not filed' };
    if (res.repeat || res.mergedInto) return { status: 'in_flight', workId: w.id };
    if (maybe.length) o.noteIntake(w.id, `Possibly the same bug as ${maybe.map((x) => `${x.w.id} (${x.why})`).join(', ')}: a shared signature alone does not make it the same; merge it into one of them if so.`);
    if (older.length) o.noteIntake(w.id, `Not the bug of ${older.join(', ')}: a different bug, or that fix regressed.`);
    this.linkMaybe(d.conversation, w.id);
    return w.approval?.state === 'pending' ? { status: 'held', workId: w.id } : { status: 'filed', workId: w.id, triage: w.triage?.class === 'obvious-bug' ? 'obvious-bug' : 'needs-human', approval: 'approved' };
  }

  private escalate(e: Escalation): EscalationAnswer {
    const s = this.settings;
    const title = escalationTitle(e);
    const board = this.d.orchestrators.boardCheck({ keys: [`discord:${e.threadId}`], conversation: e.conversation }, s.lookbackDays);
    const match = board.matches[0];
    if (board.verdict === 'in_flight' && match) {
      this.d.orchestrators.noteIntake(match.id, `Max escalated its thread again (${e.kind}, FFBox conversation ${e.conversation}): ${cleanLine(e.title, 160)}`);
      this.record({ source: 'ffbox-request', action: 'repeat', title, workId: match.id, why: 'the thread is already in flight', url: e.url });
      return { status: 'in_flight', workId: match.id };
    }
    if (board.verdict === 'done' && match) {
      this.record({ source: 'ffbox-request', action: 'repeat', title, workId: match.id, why: 'the thread was already fixed', url: e.url });
      return { status: 'done', workId: match.id, version: match.version ?? null };
    }
    const source = escalationSource(e);
    const triage = escalationTriage(e);
    const now = this.now();
    const res = this.d.orchestrators.fileIntake({
      title,
      brief: escalationBrief(e),
      source,
      triage,
      requestedBy: this.d.identity.systemPayer(),
      autoApprove: s.ffbox.autoApprove,
      kinds: FFBOX_KINDS,
      lookbackDays: s.lookbackDays,
      limit: () => capProblem(this.d.store.work.values(), FFBOX_KINDS, s.ffbox.dailyCap, now),
    });
    this.outcome('ffbox-request', title, e.url, res);
    if (!res.repeat && !res.mergedInto) this.linkMaybe(e.conversation, res.item?.id);
    if (res.skipped) return { status: 'skipped', why: res.skipped };
    const w = res.mergedInto ? this.d.store.work.get(res.mergedInto) : res.item;
    if (!w) return { status: 'skipped', why: 'not filed' };
    if (res.repeat || res.mergedInto) return { status: 'in_flight', workId: w.id };
    return { status: 'filed', workId: w.id, triage: triage.class === 'obvious-bug' ? 'obvious-bug' : 'needs-human', approval: w.approval?.state === 'pending' ? 'pending' : 'approved' };
  }

  /** FFBox asks the ledger before it works a report; undefined while the check is off. */
  onBoardCheck(m: BoardCheckMessage): BoardAnswer | undefined {
    const s = this.settings;
    // An escalated thread's watch (w480): FFBox asks about the ref it links, and hears the request it was escalated to.
    const kept = this.boards.get(m.ref);
    if (kept?.follow && s.ffbox.enabled) {
      const answer = this.followAnswer(kept);
      this.watchBoard(m.ref, kept.q, answer, kept);
      console.log(`intake: board_check ${m.ref} (FFBox conversation ${m.conversation ?? kept.q.conversation}): ${answer.verdict}, following ${kept.follow}`);
      return answer;
    }
    if (!s.ffbox.enabled || !s.ffbox.boardCheck) return undefined;
    // FFBox's board keys in the ledger's spelling: "pr#412" is PR 412, "spec-098" spec 098, "issue#7" a #7 reference.
    const keys = m.keys.flatMap((k) => {
      const l = k.toLowerCase();
      let x: RegExpExecArray | null;
      if ((x = /^pr#(\d+)$/.exec(l))) return [`pr:${Number(x[1])}`];
      if ((x = /^spec-(\d{2,4})$/.exec(l))) return [`spec:${x[1].padStart(3, '0')}`];
      if ((x = /^issue#(\d+)$/.exec(l))) return [`ref:${Number(x[1])}`];
      // Exact keys, as FFBox sends them for its bug_report and suggestion turns and its intake diagnoses.
      if ((x = /^discord:(\d{15,25})$/.exec(l))) return [`discord:${x[1]}`];
      if ((x = /^report:(\d{8}t\d{6}z-(?:crash|desync)-[0-9a-f]{6,32})$/.exec(l))) return [`report:${x[1].replace(/t/, 'T').replace(/z-/, 'Z-')}`];
      if (/^(branch|ffbox|pr|spec|ref):/.test(l)) return [l];
      return [l, `ffbox:${l}`];
    });
    const q = { keys, title: m.title ? cleanLine(m.title, 300) : undefined, summary: m.summary ? cleanBlock(m.summary, 1000) : undefined, conversation: m.conversation };
    const answer = this.d.orchestrators.boardCheck(q, s.lookbackDays, { thresholds: s.ffbox.match, maybe: this.d.takesMaybe?.() === true });
    this.watchBoard(m.ref, q, answer);
    this.noteBoard(m.ref, m.conversation, answer);
    return answer;
  }

  /** Every board_check decision, logged; a `maybe` remembered for what FFBox files from that conversation later. */
  private noteBoard(ref: string, conversation: string | undefined, a: BoardAnswer) {
    const tops = a.matches.map((x) => `${x.id} ${x.score} (${x.why})`).join(', ');
    console.log(`intake: board_check ${ref}${conversation ? ` (FFBox conversation ${conversation})` : ''}: ${a.verdict}, confidence ${a.confidence ?? 0}${tops ? `; ${tops}` : ''}`);
    if (a.verdict !== 'maybe' || !conversation) return;
    const maybes = { ...this.data.maybes, [conversation]: { ids: a.matches.map((x) => x.id), scores: a.matches.map((x) => x.score), at: this.now() } };
    const keys = Object.keys(maybes).sort((x, y) => maybes[y].at - maybes[x].at);
    for (const k of keys.slice(MAYBE_KEEP)) delete maybes[k];
    this.data.maybes = maybes;
    this.changed();
  }

  /** What FFBox filed from a conversation board_check answered `maybe` for: a line naming the candidates, for a person. */
  private linkMaybe(conversation: string | undefined, workId: string | undefined) {
    const m = conversation ? this.data.maybes?.[conversation] : undefined;
    if (!m || !workId || m.ids.includes(workId)) return;
    const list = m.ids.map((id, i) => `${id} (${m.scores[i]})`).join(', ');
    this.d.orchestrators.noteIntake(workId, `Possibly the same bug as ${list}: the ledger check answered "maybe" for FFBox conversation ${conversation}. Merge it into one of them if so.`);
  }

  // ---------------------------------------------------------------- board answers FFBox follows

  /**
   * Per board ref: what was asked, the last answer sent, and for an escalated thread the request it follows. Kept in
   * intake.json (w480), so a restart loses no watch and keeps its follow window; FFBox also asks its checks again after
   * a reconnect.
   */
  private boards = new Map<string, BoardWatch>();
  /** When a followed request was first seen done, by request: its done answer waits for the fix look (FIX_HOLD_MS). */
  private readonly doneSeen = new Map<string, number>();

  private saveBoards() {
    this.data.boards = Object.fromEntries(this.boards);
    this.changed();
  }

  /** Oldest first out, past the cap. */
  private capBoards() {
    while (this.boards.size > BOARD_MAX) this.boards.delete(this.boards.keys().next().value!);
  }

  /**
   * Remember a board answer FFBox will follow: one in flight (until it is done), or done but not yet released (until the
   * version is known). A clear answer, or a released fix, needs no follow-up. `was`: the watch it updates, whose start
   * and followed request it keeps.
   */
  private watchBoard(ref: string, q: BoardWatch['q'], answer: BoardAnswer, was?: BoardWatch) {
    const follow = answer.verdict === 'in_flight' || (answer.verdict === 'done' && answer.matches.some((m) => m.status === 'done' && !m.version));
    if (!follow) {
      if (this.boards.delete(ref)) this.saveBoards();
      return;
    }
    this.boards.set(ref, { q, last: boardDigest(answer), at: was?.at ?? this.now(), ...(was?.follow ? { follow: was.follow } : {}) });
    this.capBoards();
    this.saveBoards();
  }

  /**
   * An escalated thread's answer (w480): the standing of the request it was escalated to, through a merge into another.
   * Open is in_flight (its branch and PR to watch), done is done (its PR, merge and release), anything else is clear
   * (FFBox says nothing about a request that will not be fixed in a thread it escalated).
   */
  private followAnswer(b: BoardWatch): BoardAnswer {
    const w = followed(b.follow!, this.d.store.work);
    if (!w) return { verdict: 'clear', matches: [], confidence: 0 };
    const verdict = isOpen(w) ? 'in_flight' : w.status === 'done' ? 'done' : 'clear';
    if (verdict === 'clear') return { verdict, matches: [], confidence: 0 };
    return { verdict, matches: [this.d.orchestrators.boardMatch(w, 1, 'the request this thread was escalated to')], confidence: 1 };
  }

  /** A followed request just done waits for the look for its fix (resolveFixes), at most FIX_HOLD_MS. */
  private holding(b: BoardWatch): boolean {
    if (!b.follow) return false;
    const w = followed(b.follow, this.d.store.work);
    if (!w || w.status !== 'done') return false;
    if (!this.doneSeen.has(w.id)) this.doneSeen.set(w.id, this.now());
    if (!fixLearnable(w) || this.data.fixTried?.[w.id]) return false;
    return this.now() - this.doneSeen.get(w.id)! < FIX_HOLD_MS;
  }

  /** Recompute every followed answer; push the ones that changed (a PR opened, a merge, a release). Returns how many went. */
  recheckBoards(): number {
    const s = this.settings;
    if (!s.ffbox.enabled || !this.d.pushBoard) return 0;
    let sent = 0;
    for (const [ref, b] of [...this.boards]) {
      // An escalated thread's watch is followed whenever the FFBox intake is on; a board_check's while the check is.
      if (!b.follow && !s.ffbox.boardCheck) continue;
      if (this.now() - b.at > BOARD_FOLLOW_MS) {
        this.boards.delete(ref);
        this.saveBoards();
        continue;
      }
      const answer = b.follow ? this.followAnswer(b) : this.d.orchestrators.boardCheck(b.q, s.lookbackDays, { thresholds: s.ffbox.match, maybe: this.d.takesMaybe?.() === true });
      if (boardDigest(answer) === b.last || this.holding(b)) continue;
      if (!this.d.pushBoard(ref, answer)) continue;
      sent++;
      this.watchBoard(ref, b.q, answer, b);
    }
    return sent;
  }

  /**
   * Learn each followed, finished request's fix (w480): the commit and PR (an auto-close's, a linked request's, the PR an
   * "already fixed by #N" close names, or the merged PR whose merge commit is the FIX-LANDED one) and the first release
   * that carries it, so the done answer says "Fixed in PR #1076, coming in version 78". Recorded on the request
   * (delivery), where boardFacts reads it. Each request is looked at again at most every FIX_RETRY_MS. Never throws.
   */
  async resolveFixes(): Promise<string[]> {
    const s = this.settings;
    if (!s.ffbox.enabled || this.resolving) return [];
    const now = this.now();
    const tried = this.data.fixTried ?? {};
    const targets = new Map<string, WorkItem>();
    const due = (w: WorkItem | undefined) => !!w && fixLearnable(w) && !(tried[w.id] && now - tried[w.id] < FIX_RETRY_MS);
    for (const b of this.boards.values()) {
      const w = b.follow ? followed(b.follow, this.d.store.work) : undefined;
      if (due(w)) targets.set(w!.id, w!);
    }
    // And every finished request that claims player reports (w502): FFBox is told they are fixed once the fix ships.
    for (const w of this.reportClaimants(now)) if (due(w)) targets.set(w.id, w);
    if (!targets.size) return [];
    this.resolving = true;
    const changed: string[] = [];
    try {
      let records: MergeRecord[] | undefined;
      let bumps: { sha: string; at: number }[] | undefined;
      for (const w of targets.values()) {
        const d = { ...w.delivery };
        const said: string[] = [];
        if (!d.fixCommit) {
          const linked = w.autoClosed?.by ? this.d.store.work.get(w.autoClosed.by) : undefined;
          const named = fixedByPr(w.outcome);
          if (linked?.delivery?.fixCommit) {
            const l = linked.delivery;
            Object.assign(d, { fixCommit: l.fixCommit }, l.fixPr ? { fixPr: l.fixPr } : {}, l.fixBranch ? { fixBranch: l.fixBranch } : {}, l.releasedIn ? { releasedIn: l.releasedIn, releasedAt: l.releasedAt } : {});
            said.push(`its fix is ${linked.id}'s (${l.fixCommit!.slice(0, 12)})`);
          } else if (w.autoClosed?.sha) {
            Object.assign(d, { fixCommit: w.autoClosed.sha }, w.autoClosed.pr ? { fixPr: w.autoClosed.pr } : {});
            said.push(`its fix is the merge it was closed by (${w.autoClosed.sha.slice(0, 12)})`);
          } else if (named || d.fixPr) {
            // "Already fixed by #N" (w480), or a PR a confirmed link named (w502): its merge commit is the fix.
            const n = named ?? d.fixPr!;
            const pr = await this.prInfo(n).catch(() => undefined);
            if (pr?.sha) {
              Object.assign(d, { fixCommit: pr.sha, fixPr: n }, pr.head ? { fixBranch: pr.head } : {});
              said.push(`${named ? 'already fixed by' : 'fixed by'} PR #${n} (${pr.sha.slice(0, 12)})`);
            }
          }
        }
        if (d.fixCommit && !d.fixPr) {
          records ??= (await this.mergedPrs().catch(() => undefined)) ?? [];
          // A FIX-LANDED commit may be abbreviated ("ede697a08").
          const fix = d.fixCommit.toLowerCase();
          const r = records.find((x) => x.number && x.sha && (x.sha.startsWith(fix) || fix.startsWith(x.sha)));
          if (r) {
            Object.assign(d, { fixPr: r.number }, r.head ? { fixBranch: r.head } : {});
            said.push(`merged as PR #${r.number}`);
          }
        }
        if (d.fixPr && !d.fixBranch) {
          const pr = await this.prInfo(d.fixPr).catch(() => undefined);
          if (pr?.head) d.fixBranch = pr.head;
        }
        if (d.fixCommit && !d.releasedIn) {
          bumps ??= await this.releaseBumps().catch(() => []);
          const rel = await this.releaseOf(d.fixCommit, bumps, s.release.delayMinutes * 60_000);
          if (rel) {
            Object.assign(d, { releasedIn: rel.version, releasedAt: new Date(rel.at).toISOString() });
            said.push(`shipped in ${rel.version}`);
          }
        }
        this.data.fixTried = { ...this.data.fixTried, [w.id]: now };
        const patch = Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== undefined && (w.delivery as Record<string, unknown> | undefined)?.[k] !== v));
        if (Object.keys(patch).length) {
          this.d.orchestrators.noteRelease(w.id, patch, `for FFBox's merge notice: ${said.join('; ') || 'its fix'}${d.fixPr ? `, PR #${d.fixPr}` : ''}`);
          changed.push(w.id);
        }
      }
      // Forget the looks at requests nobody follows any more.
      const followedIds = new Set([...this.boards.values()].map((b) => (b.follow ? followed(b.follow, this.d.store.work)?.id : undefined)).filter(Boolean));
      for (const w of this.reportClaimants(now)) followedIds.add(w.id);
      this.data.fixTried = Object.fromEntries(Object.entries(this.data.fixTried ?? {}).filter(([id]) => followedIds.has(id)));
    } catch (e) {
      this.data.error = `fix look: ${cleanLine((e as Error).message, 200)}`;
    } finally {
      this.resolving = false;
      this.changed();
    }
    return changed;
  }

  // ---------------------------------------------------------------- players' reports a request fixed (w502)

  /** The finished requests (as they continue, through a merge) that claim player reports and changed recently. */
  private reportClaimants(now = this.now()): WorkItem[] {
    const out = new Map<string, WorkItem>();
    for (const w of this.d.store.work.values()) {
      if (!reportIdsOf(w).length) continue;
      const f = followed(w.id, this.d.store.work);
      if (f?.status === 'done' && now - Date.parse(f.updatedAt) <= REPORT_FIX_DAYS * 86_400_000) out.set(f.id, f);
    }
    return [...out.values()];
  }

  /**
   * Tell FFBox each player report a finished request fixed (w502): every report the request claims (its subjects, or an
   * intake diagnosis that joined it), once its fix is merged and a release carries it, with the PR and the version.
   * Kept in intake.json and sent on every link (providers.pushReportFixed sends each once per link). FFBox records it
   * on the report and its diagnosis and posts nothing. Returns how many went now.
   */
  pushReportFixes(): number {
    const s = this.settings;
    if (!s.ffbox.enabled) return 0;
    const now = this.now();
    const target = this.d.cfg.defaultBase.replace(/^origin\//, '') || 'develop';
    const known = { ...this.data.reportFixes };
    let changed = false;
    for (const f of reportFixesOf(this.d.store.work, target, now, REPORT_FIX_DAYS)) {
      const was = known[f.reportId];
      if (was && was.workId === f.workId && was.pr === f.pr && was.version === f.version && was.mergedIn === f.mergedIn) continue;
      known[f.reportId] = { ...f, at: new Date(now).toISOString() };
      changed = true;
      console.log(`intake: report ${f.reportId} fixed by ${f.workId}${f.pr ? ` (PR #${f.pr})` : ''}, in ${f.version}: FFBox is told (w502)`);
    }
    for (const [id, f] of Object.entries(known)) if (now - Date.parse(f.at) > REPORT_FIX_DAYS * 86_400_000) (delete known[id], (changed = true));
    if (changed) {
      this.data.reportFixes = known;
      this.changed();
    }
    if (!this.d.pushReportFixed) return 0;
    let sent = 0;
    for (const f of Object.values(known)) {
      const { at: _at, ...fix } = f;
      if (this.d.pushReportFixed(fix)) sent++;
    }
    return sent;
  }

  /**
   * Tell FFBox each player report a declined request leaves (w853): every report a request closed `rejected` claims,
   * unless another request claims it while open or done (reportObsoletesOf). FFBox records it as obsolete on the report
   * and its diagnosis, apart from fixed, and posts nothing. A report told obsolete whose request was reopened, or that an
   * open or finished request now claims, is told `withdrawn`, and FFBox puts back what its diagnosis said. Kept in
   * intake.json and sent on every link (providers.pushReportObsolete sends each once per link) for REPORT_OBSOLETE_DAYS.
   * Returns how many went now.
   */
  pushReportObsoletes(): number {
    const s = this.settings;
    if (!s.ffbox.enabled) return 0;
    const now = this.now();
    const at = new Date(now).toISOString();
    const known = { ...this.data.reportObsoletes };
    let changed = false;
    for (const o of reportObsoletesOf(this.d.store.work, now, REPORT_OBSOLETE_DAYS)) {
      const was = known[o.reportId];
      if (was && !was.withdrawn && was.workId === o.workId) continue;
      known[o.reportId] = { ...o, at };
      changed = true;
      console.log(`intake: report ${o.reportId} obsolete: ${o.workId} was declined; FFBox is told (w853)`);
    }
    // Withdrawn only when no request declines it any more, however long ago: an old decline just stops being sent.
    const still = new Set(reportObsoletesOf(this.d.store.work, now, Infinity).map((o) => o.reportId));
    for (const [id, o] of Object.entries(known)) {
      if (now - Date.parse(o.at) > REPORT_OBSOLETE_DAYS * 86_400_000) {
        delete known[id];
        changed = true;
      } else if (!o.withdrawn && !still.has(id)) {
        known[id] = { reportId: id, workId: o.workId, at, withdrawn: true };
        changed = true;
        console.log(`intake: report ${id} no longer obsolete: ${o.workId} is not declined any more, or other work claims it; FFBox is told (w853)`);
      }
    }
    if (changed) {
      this.data.reportObsoletes = known;
      this.changed();
    }
    if (!this.d.pushReportObsolete) return 0;
    let sent = 0;
    for (const o of Object.values(known)) {
      const { at: _at, ...msg } = o;
      if (this.d.pushReportObsolete(msg)) sent++;
    }
    return sent;
  }

  /**
   * A merged PR's `Report: <id>` lines (w502): the request the PR belongs to (its PR, its fix's PR, the PR it was closed
   * by, FFBox's PR for it) becomes the work for those reports. Reads the merged PRs gh lists. Returns the requests changed.
   */
  async linkReportsFromPrs(): Promise<string[]> {
    const s = this.settings;
    if (!s.ffbox.enabled) return [];
    const records = (await this.mergedPrs().catch(() => undefined)) ?? [];
    const changed: string[] = [];
    for (const r of records) {
      const ids = r.number ? reportLines(r.text) : [];
      if (!ids.length) continue;
      const w = [...this.d.store.work.values()].find((x) => x.status !== 'merged' && (x.delivery?.fixPr === r.number || x.autoClosed?.pr === r.number || x.ffbox?.pr === r.number || x.source?.pr === r.number || x.prs?.some((p) => p.number === r.number)));
      if (!w) continue;
      const keys = ids.map((id) => `report:${id}`).filter((k) => !w.keys.includes(k));
      if (!keys.length) continue;
      this.d.orchestrators.addSubjects(w.id, keys, `PR #${r.number}'s Report: lines`);
      if (!w.delivery?.fixPr && w.status === 'done') this.d.orchestrators.noteRelease(w.id, { fixPr: r.number, ...(r.sha ? { fixCommit: r.sha } : {}), ...(r.head ? { fixBranch: r.head } : {}) }, `its fix is PR #${r.number}, which names its reports`);
      changed.push(w.id);
    }
    return changed;
  }

  /**
   * w502's one-time sweep, at the first start with it: the finished requests that claim reports (marked fixed on FFBox
   * once their fix ships, by pushReportFixes) and the ones that only mention report ids. Those are never marked: they
   * go to Lothsahn (the reviewers, on a portal without his login) in one message, to add as subjects (update_work) where the
   * request did fix them. Once per data folder (intake.json `reportSweep`).
   */
  sweepReports(): ReportSweep | undefined {
    const s = this.settings;
    if (!s.ffbox.enabled || this.data.reportSweep) return undefined;
    const now = this.now();
    const sweep = reportSweep(this.d.store.work, now, REPORT_FIX_DAYS);
    this.data.reportSweep = { at: new Date(now).toISOString(), certain: sweep.certain.length, uncertain: sweep.uncertain.map((u) => u.workId) };
    this.changed();
    console.log(`intake: report sweep (w502): ${sweep.certain.length} finished request(s) claim reports (${sweep.certain.map((c) => `${c.workId}${c.released ? '' : ' (not released yet)'}`).join(', ') || 'none'}); ${sweep.uncertain.length} only mention some (${sweep.uncertain.map((u) => u.workId).join(', ') || 'none'})`);
    if (sweep.uncertain.length) {
      // Lothsahn asked for the list (w502); the reviewers get it on a portal without his login.
      const loth = this.d.identity.get('lothsahn');
      const to = loth ? [{ userId: loth.userId, displayName: loth.displayName }] : [];
      const reviewers = this.d.orchestrators.reviewers();
      const lines = sweep.uncertain.map((u) => `${u.workId} "${cleanLine(u.title, 80)}" mentions ${u.reportIds.join(', ')}`);
      this.d.orchestrators.toPeople(
        to.length ? to : reviewers,
        `[intake reports] w502's sweep: these finished requests mention player reports they do not claim, so FFBox still shows those reports open. Where a request did fix a report, add it with update_work {id, subjects: [<report id>]} and FFBox shows it fixed once the fix ships; leave the rest. ${lines.join('; ')}`,
      );
    }
    return sweep;
  }

  /**
   * The one-time catch-up (w480): escalated requests closed done in the last CATCH_UP_DAYS days are followed as if FFBox
   * had just escalated them, so recheckBoards pushes each thread its done answer (after the fix look). Once per data
   * folder (intake.json `catchUp`); FFBox's once-only guards keep a thread that already heard from hearing it twice.
   * scripts/escalation-catchup.ts lists the same selection from a copy of the data folder, changing nothing.
   */
  catchUpEscalations(): CatchUpLine[] {
    const s = this.settings;
    if (!s.ffbox.enabled || !s.ffbox.escalations || this.data.catchUp) return [];
    const now = this.now();
    const lines = escalationCatchUp(this.d.store.work, now, CATCH_UP_DAYS);
    for (const l of lines) {
      if (this.boards.get(l.ref)?.follow) continue;
      this.boards.delete(l.ref);
      this.boards.set(l.ref, { q: { keys: [`discord:${l.threadId}`], conversation: l.conversation }, last: '', at: now, follow: l.workId });
    }
    this.capBoards();
    this.data.catchUp = { at: new Date(now).toISOString(), refs: lines.map((l) => l.ref) };
    console.log(`intake: catch-up (w480): following ${lines.length} escalated thread(s) closed done in the last ${CATCH_UP_DAYS} days: ${lines.map((l) => `${l.ref} ${l.followId}`).join(', ') || 'none'}`);
    this.saveBoards();
    return lines;
  }

  /** FFBox accepted or refused a submit. */
  onWorkReply(m: WorkReply) {
    const w = [...this.d.store.work.values()].find((x) => x.ffbox?.requestId === m.ref);
    if (m.type === 'accepted') {
      const wrong = w && m.billedTo.toLowerCase() !== w.requestedBy.userId.toLowerCase() ? ` (NOT ${w.requestedBy.displayName}'s account, which it must be: tell Lothsahn)` : '';
      this.d.orchestrators.ffboxReply(m.ref, { state: 'accepted', conversation: m.conversation, billedTo: m.billedTo }, `accepted as conversation ${m.conversation}, billed to ${m.billedTo}${wrong}`);
    } else {
      this.d.orchestrators.ffboxReply(m.ref, { state: 'refused', reason: m.reason }, `refused: ${m.reason}${m.message ? ` (${cleanLine(m.message, 200)})` : ''}`);
    }
  }

  /** A turn we submitted finished. */
  onResult(m: ResultMessage) {
    const tail = [m.branch ? `branch ${m.branch}` : '', m.pr ? `PR #${m.pr}` : '', m.verdict ? `verdict ${m.verdict}` : '', m.noBranchReason ? `no branch: ${cleanLine(m.noBranchReason, 160)}` : ''].filter(Boolean).join(', ');
    this.d.orchestrators.ffboxReply(
      m.ref,
      { state: 'done', conversation: m.conversation, ...(m.branch ? { branch: m.branch } : {}), ...(m.pr ? { pr: m.pr } : {}), ...(m.verdict ? { verdict: m.verdict } : {}) },
      `${m.state}${tail ? `: ${tail}` : ''}`,
    );
  }

  // ---------------------------------------------------------------- the nightly e2e lab

  /**
   * A night's results from the lab (POST /api/intake/nightly). Each new regression, still-failing scenario and scenario
   * flaky intake.nightly.flakyNights nights running either joins the open request already on that scenario (a nightly
   * request, or a person's own that names the scenario id) or is filed; more to file than batchOver become one request
   * for the night. A still-failing scenario whose request a reviewer declined within the lookback is not filed again.
   * Undefined while intake.nightly is off.
   */
  onNightly(rep: NightlyReport): { scenario: string; action: 'filed' | 'attached' | 'skipped'; workId?: string; why?: string }[] | undefined {
    const out = !this.settings.nightly.enabled ? undefined : nightStatus(rep) === 'broken' ? this.fileBrokenNight(rep) : this.fileNightly(rep);
    // Every night is recorded, whether its regressions are filed or not (w864).
    this.recordNight(rep, out);
    return out;
  }

  private fileNightly(rep: NightlyReport): { scenario: string; action: 'filed' | 'attached' | 'skipped'; workId?: string; why?: string }[] {
    const s = this.settings;
    const now = this.now();
    const lookbackMs = s.lookbackDays * 86_400_000;
    const out: { scenario: string; action: 'filed' | 'attached' | 'skipped'; workId?: string; why?: string }[] = [];
    const toFile: NightlyResult[] = [];
    const work = () => [...this.d.store.work.values()];
    for (const r of rep.results) {
      const skip = nightlySkip(r, s.nightly);
      if (skip) {
        out.push({ scenario: r.scenario, action: 'skipped', why: skip });
        continue;
      }
      const key = nightlyKey(r.scenario);
      // The open request on it: a nightly one (or one that took a nightly line before), else a person's that names it.
      const open = work().filter((w) => isOpen(w) && !w.mergedInto);
      const target = open.find((w) => w.keys.includes(key)) ?? open.find((w) => w.source?.kind !== 'nightly' && mentionsScenario(`${w.title}\n${w.brief}`, r.scenario));
      if (target) {
        const added = this.d.orchestrators.attachNightly(target.id, { key, line: nightlyAgainLine(rep, r), night: rep.date, scenario: r.scenario, urgent: r.release?.shipped === 'yes' });
        if (added) this.record({ source: 'nightly', action: 'repeat', title: `${r.scenario} failed again (${rep.date})`, workId: target.id, why: `added to ${target.id}, open on it` });
        out.push({ scenario: r.scenario, action: 'attached', workId: target.id, why: added ? `added to ${target.id}, open on it` : `already on ${target.id} for ${rep.date}` });
        continue;
      }
      const declined = r.class !== 'new' && work().find((w) => w.source?.kind === 'nightly' && w.keys.includes(key) && w.approval?.state === 'declined' && now - Date.parse(w.updatedAt) < lookbackMs);
      if (declined) {
        out.push({ scenario: r.scenario, action: 'skipped', workId: declined.id, why: `${declined.id} for it was declined${declined.approval?.by && declined.approval.by !== 'auto' ? ` by ${declined.approval.by.displayName}` : ''}` });
        continue;
      }
      toFile.push(r);
    }
    const groups = toFile.length > s.nightly.batchOver ? [toFile] : toFile.map((r) => [r]);
    for (const g of groups) {
      const draft = nightlyDraft(rep, g);
      const res = this.d.orchestrators.fileIntake({
        ...draft,
        requestedBy: this.d.identity.systemPayer(),
        autoApprove: s.nightly.autoApprove,
        kinds: NIGHTLY_KINDS,
        lookbackDays: s.lookbackDays,
        limit: () => capProblem(this.d.store.work.values(), NIGHTLY_KINDS, s.nightly.dailyCap, now),
      });
      this.outcome('nightly', draft.title, draft.source.url, res);
      for (const r of g) {
        if (res.skipped) out.push({ scenario: r.scenario, action: 'skipped', why: res.skipped });
        else out.push({ scenario: r.scenario, action: res.repeat ? 'attached' : 'filed', workId: res.item?.id, ...(g.length > 1 ? { why: `the night's batch of ${g.length}` } : {}) });
      }
    }
    this.lastNightly(rep, out);
    return out;
  }

  private lastNightly(rep: NightlyReport, out: { action: string }[]) {
    const count = (a: string) => out.filter((o) => o.action === a).length;
    this.data.nightly = { at: new Date(this.now()).toISOString(), date: rep.date, lab: rep.lab, sha: rep.sha, filed: count('filed'), attached: count('attached'), skipped: count('skipped') };
    this.changed();
  }

  /**
   * A broken night (w864): one cause stopped the battery, so its scenarios are not filed one by one. The open request on
   * a broken night takes it (one line), else one request is filed to find the cause, the game or the lab.
   */
  private fileBrokenNight(rep: NightlyReport): { scenario: string; action: 'filed' | 'attached' | 'skipped'; workId?: string; why?: string }[] {
    const s = this.settings;
    const now = this.now();
    const key = nightlyKey(NIGHT_BROKEN);
    const target = [...this.d.store.work.values()].find((w) => isOpen(w) && !w.mergedInto && w.keys.includes(key));
    let out: { scenario: string; action: 'filed' | 'attached' | 'skipped'; workId?: string; why?: string };
    if (target) {
      const added = this.d.orchestrators.attachNightly(target.id, { key, line: `nightly ${rep.date}: the night broke again${rep.sha ? ` on develop ${rep.sha.slice(0, 9)}` : ''}: ${cleanLine(rep.cause, 200)}`, night: rep.date, scenario: NIGHT_BROKEN, urgent: rep.release?.shipped === 'yes' });
      out = { scenario: NIGHT_BROKEN, action: 'attached', workId: target.id, why: added ? `added to ${target.id}, open on a broken night` : `already on ${target.id} for ${rep.date}` };
    } else {
      const run = this.data.nights?.find((n) => n.date === rep.date)?.workId ?? rep.request;
      const draft = brokenNightDraft(rep, run);
      const res = this.d.orchestrators.fileIntake({
        ...draft,
        requestedBy: this.d.identity.systemPayer(),
        autoApprove: s.nightly.autoApprove,
        kinds: NIGHTLY_KINDS,
        lookbackDays: s.lookbackDays,
        limit: () => capProblem(this.d.store.work.values(), NIGHTLY_KINDS, s.nightly.dailyCap, now),
      });
      this.outcome('nightly', draft.title, undefined, res);
      out = res.skipped ? { scenario: NIGHT_BROKEN, action: 'skipped', why: res.skipped } : { scenario: NIGHT_BROKEN, action: res.repeat ? 'attached' : 'filed', workId: res.item?.id };
    }
    this.lastNightly(rep, [out]);
    return [out];
  }

  // ---------------------------------------------------------------- the nightly run (w864)

  /**
   * The portal's nightly schedule (config intake.nightly.run; docs/intake.md, "The nightly run"). Once a night, at its
   * time in its time zone, it files the run request that the dispatcher places on its machine; and it raises the
   * missing-night alarm for a night with no report by its due time, or whose run request closed without one. Lothsahn:
   * "We shouldn't assume silence means a successful (or failed) run."
   */
  checkNightlyRun(): void {
    const r = this.settings.nightly.run;
    if (!r.enabled) return;
    const now = this.now();
    if (this.data.nightlyRunSince === undefined) {
      this.data.nightlyRunSince = now;
      this.changed();
    }
    const fire = lastFire(r, now);
    const date = nightOf(fire, r.tz);
    if (fire >= this.data.nightlyRunSince && !this.nights().some((n) => n.date === date)) {
      if (now - fire <= NIGHTLY_FIRE_LATE_MS) this.fireNightlyRun(r, date, fire);
      else {
        const n: NightlyNight = { date, status: 'missing', dueBy: iso(fire + r.reportWithinHours * 3_600_000), cause: `not started: FF Factory was not running at ${r.time} ${r.tz} and came back more than ${NIGHTLY_FIRE_LATE_MS / 3_600_000} hours later` };
        this.putNight(n);
        this.nightAlarm(n, `No nightly e2e run tonight (${date}): ${n.cause}.`);
      }
    }
    for (const n of this.nights()) {
      if (n.status !== 'running' || n.alarmAt) continue;
      const w = n.workId ? this.d.store.work.get(n.workId) : undefined;
      if (n.dueBy && now > Date.parse(n.dueBy)) {
        n.status = 'missing';
        n.cause = `no report from the lab by ${at(Date.parse(n.dueBy), r.tz)}`;
        this.nightAlarm(n, `The nightly e2e run of ${n.date}${n.workId ? ` (${n.workId})` : ''} sent no report by ${at(Date.parse(n.dueBy), r.tz)}: ${w ? `its request is ${w.status}${w.sessionIds.length ? '' : ', no worker ever started on it'}` : 'its request is gone'}. Silence is not a verdict: find out whether it ran.`);
      } else if (w && !isOpen(w) && now - Date.parse(w.updatedAt) > NIGHTLY_CLOSED_GRACE_MS) {
        n.status = 'missing';
        n.cause = `its run request ${w.id} closed (${w.status}) with no report from the lab`;
        this.nightAlarm(n, `The nightly e2e run of ${n.date} (${w.id}) ended as ${w.status} without a report from the lab reaching FF Factory. Silence is not a verdict: find out whether it ran.`);
      }
    }
  }

  private fireNightlyRun(r: NightlyRunSettings, date: string, fire: number) {
    const now = this.now();
    const dueBy = fire + r.reportWithinHours * 3_600_000;
    const draft = nightlyRunDraft({ date, machine: r.machine, time: r.time, tz: r.tz, dueBy: at(dueBy, r.tz) });
    const person = this.d.identity.requester(r.person);
    const res = this.d.orchestrators.fileIntake({
      ...draft,
      requestedBy: person ?? this.d.identity.systemPayer(),
      person: !!person,
      autoApprove: { enabled: false, maxPerDay: 0 },
      kinds: ['nightly-run'],
      lookbackDays: this.settings.lookbackDays,
      // Switched on in config by a person: the schedule is the approval, like a release follow-up.
      approved: true,
    });
    this.outcome('nightly-run', draft.title, undefined, res);
    const n: NightlyNight = { date, status: 'running', firedAt: iso(now), dueBy: iso(dueBy), ...(res.item ? { workId: res.item.id } : {}) };
    this.putNight(n);
    if (!res.item) {
      n.status = 'missing';
      n.cause = `the schedule could not file the run: ${res.skipped ?? 'no request was made'}`;
      this.nightAlarm(n, `No nightly e2e run tonight (${date}): ${n.cause}.`);
    }
  }

  /** The person the nightly run is for hears it (their orchestrator), and the run request's log has it. */
  private nightAlarm(n: NightlyNight, text: string) {
    n.alarmAt = iso(this.now());
    const r = this.settings.nightly.run;
    this.d.orchestrators.toPeople([this.d.identity.requester(r.person) ?? this.d.identity.systemPayer()], `[nightly] ${text}`);
    if (n.workId) this.d.orchestrators.noteIntake(n.workId, `nightly: ${text}`);
    this.changed();
  }

  /** The night a report is for (its date, else its run request), with what it said; a broken or late one is told. */
  private recordNight(rep: NightlyReport, out?: { action: string; workId?: string }[]) {
    const now = this.now();
    const status = nightStatus(rep);
    let n = this.nights().find((x) => x.date === rep.date) ?? (rep.request ? this.nights().find((x) => x.workId === rep.request) : undefined);
    const late = n?.status === 'missing';
    const again = !!n?.reportedAt && n.status === status && n.sha === (rep.sha || undefined);
    if (!n) {
      n = { date: rep.date, status };
      this.putNight(n);
    }
    const work = [...new Set((out ?? []).filter((o) => o.workId && o.action !== 'skipped').map((o) => o.workId!))];
    Object.assign(n, {
      status,
      reportedAt: iso(now),
      lab: rep.lab,
      ...(rep.sha ? { sha: rep.sha } : {}),
      ...(rep.counts ? { counts: rep.counts } : {}),
      // The lab's own cause; a stale one ("no report by ...") goes once the report is in.
      cause: rep.cause ?? (status === 'broken' ? n.cause : undefined),
      ...(work.length ? { work } : {}),
    });
    if (!n.workId && rep.request && this.d.store.work.has(rep.request)) n.workId = rep.request;
    if (!again) {
      const line = nightLine(n);
      if (n.workId) this.d.orchestrators.noteIntake(n.workId, `nightly: ${line}`);
      if (status === 'broken' || late) this.nightAlarm(n, late ? `The report of the nightly e2e run of ${n.date} came after all, late: ${line}` : line);
    }
    this.changed();
  }

  /** What the lab's POST is answered with: the night as recorded, and its run request. */
  nightLabel(date: string): string | undefined {
    const n = this.nights().find((x) => x.date === date);
    return n ? `${n.date}${n.workId ? `, ${n.workId}` : ''}` : undefined;
  }

  private nights(): NightlyNight[] {
    return (this.data.nights ??= []);
  }

  private putNight(n: NightlyNight) {
    this.data.nights = [n, ...this.nights().filter((x) => x !== n && x.date !== n.date)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, NIGHTS_KEEP);
    this.changed();
  }

  // ---------------------------------------------------------------- releases

  private async git(args: string[]): Promise<{ code: number; stdout: string }> {
    if (this.d.git) return this.d.git(args);
    return run('git', ['-C', this.d.cfg.repo.basePath, ...args], { timeoutMs: 60_000 });
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.git(['merge-base', '--is-ancestor', a, b])).code === 0;
  }

  /** The base branch's version bumps, oldest first (fetched first), each one's bundleVersion remembered in `versions`. */
  private async releaseBumps(): Promise<{ sha: string; at: number }[]> {
    const base = this.d.cfg.defaultBase;
    const slash = base.indexOf('/');
    if (slash > 0) await this.git(['fetch', '--quiet', base.slice(0, slash), base.slice(slash + 1)]);
    const log = await this.git(['log', base, '--first-parent', '--format=%H %cI', '-n', '40', '-G', 'bundleVersion:', '--', VERSION_FILE]);
    const bumps = log.stdout
      .split('\n')
      .map((l) => l.trim().split(' '))
      .filter((p) => /^[0-9a-f]{40}$/.test(p[0] ?? ''))
      .map(([sha, at]) => ({ sha, at: Date.parse(at) }))
      .reverse();
    for (const b of bumps) {
      if (this.data.versions[b.sha]) continue;
      const v = bundleVersionOf((await this.git(['show', `${b.sha}:${VERSION_FILE}`])).stdout);
      if (v) this.data.versions[b.sha] = v;
    }
    if (bumps.length) this.data.lastVersion = this.data.versions[bumps.at(-1)!.sha] ?? this.data.lastVersion;
    return bumps;
  }

  /** The first release that carries `fix`, once it is `delayMs` old; undefined when none does yet. */
  private async releaseOf(fix: string, bumps: readonly { sha: string; at: number }[], delayMs: number): Promise<{ version: string; at: number } | undefined> {
    for (const b of bumps) {
      const version = this.data.versions[b.sha];
      if (!version || !(await this.isAncestor(fix, b.sha))) continue;
      return this.now() - b.at < delayMs ? undefined : { version, at: b.at };
    }
    return undefined;
  }

  /**
   * Where each landed fix is: on the base branch, and in which release (the first bundleVersion bump on the base branch
   * that contains it, once it is delayMinutes old). A version's newly shipped fixes with a Discord thread get one
   * follow-up request that tells their reporters; it is approved by config intake.release itself.
   */
  async checkReleases(): Promise<void> {
    const s = this.settings;
    if (!s.release.enabled || this.checking) return;
    const now = this.now();
    const waiting = [...this.d.store.work.values()].filter((w) => w.delivery?.fixCommit && !w.delivery.releasedIn && now - Date.parse(w.updatedAt) < RELEASE_LOOKBACK_MS);
    this.checking = true;
    try {
      const base = this.d.cfg.defaultBase;
      const bumps = await this.releaseBumps();
      const shipped = new Map<string, WorkItem[]>();
      for (const w of waiting) {
        const fix = w.delivery!.fixCommit!;
        if (!(await this.isAncestor(fix, base))) continue;
        if (!w.delivery!.landedAt) this.d.orchestrators.noteRelease(w.id, { landedAt: new Date(now).toISOString() }, `its fix ${fix.slice(0, 12)} is on ${base}`);
        for (const b of bumps) {
          const version = this.data.versions[b.sha];
          if (!version || !(await this.isAncestor(fix, b.sha))) continue;
          if (now - b.at < s.release.delayMinutes * 60_000) break;
          this.d.orchestrators.noteRelease(w.id, { releasedIn: version, releasedAt: new Date(b.at).toISOString() }, `shipped in ${version}`);
          // A thread in a channel FFBox owns hears from FFBox when the fix merges, not from a release follow-up.
          const threads = !isFfboxOwned(w.source?.channel) && (w.source?.threadId || w.source?.alsoThreads?.length);
          if (threads && !w.delivery?.announcedBy) shipped.set(version, [...(shipped.get(version) ?? []), w]);
          break;
        }
      }
      for (const [version, items] of shipped) {
        const draft = releaseDraft(version, items);
        const res = this.d.orchestrators.fileIntake({
          ...draft,
          triage: triageOf(draft.source),
          requestedBy: this.d.identity.systemPayer(),
          autoApprove: { enabled: false, maxPerDay: 0 },
          kinds: ['release'],
          lookbackDays: s.lookbackDays,
          approved: true,
        });
        const id = res.item?.id;
        if (id) for (const w of items) this.d.orchestrators.noteRelease(w.id, { announcedBy: id }, `release follow-up filed as ${id}`);
        this.outcome('release', draft.title, undefined, res);
      }
      this.data.checkedAt = new Date(now).toISOString();
    } catch (e) {
      this.data.error = `release check: ${cleanLine((e as Error).message, 200)}`;
    } finally {
      this.checking = false;
      this.changed();
    }
  }

  // ---------------------------------------------------------------- merged work

  private async originSlug(): Promise<string | undefined> {
    const origin = (await run('git', ['-C', this.d.cfg.repo.basePath, 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 })).stdout.trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin)?.[1];
  }

  /** Pull request `n` of the game repo if it merged: its merge commit and head branch (gh pr view). */
  private async prInfo(n: number): Promise<MergeRecord | undefined> {
    if (this.d.prInfo) return this.d.prInfo(n);
    const slug = await this.originSlug();
    if (!slug) return undefined;
    const r = await run('gh', ['pr', 'view', String(n), '-R', slug, '--json', 'number,title,body,headRefName,state,mergedAt,mergeCommit'], { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    if (r.code !== 0) return undefined;
    try {
      const p = JSON.parse(r.stdout) as { number: number; title: string; body?: string; headRefName: string; state: string; mergedAt?: string; mergeCommit?: { oid?: string } };
      if (p.state !== 'MERGED' || !p.mergeCommit?.oid) return undefined;
      return { sha: p.mergeCommit.oid, at: p.mergedAt ?? '', number: p.number, head: p.headRefName, text: `${p.title}\n${p.body ?? ''}` };
    } catch {
      return undefined;
    }
  }

  private async mergedPrs(): Promise<MergeRecord[] | undefined> {
    if (this.d.mergedPrs) return this.d.mergedPrs();
    const slug = await this.originSlug();
    if (!slug) return undefined;
    const r = await run('gh', ['pr', 'list', '-R', slug, '--state', 'merged', '--limit', String(MERGED_PRS), '--json', 'number,title,body,headRefName,baseRefName,mergedAt,mergeCommit'], { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    if (r.code !== 0) return undefined;
    try {
      const prs = JSON.parse(r.stdout) as { number: number; title: string; body?: string; headRefName: string; baseRefName: string; mergedAt?: string; mergeCommit?: { oid?: string } }[];
      const bases = this.mergeTargets().map((t) => t.slice(t.indexOf('/') + 1));
      return prs.filter((p) => bases.includes(p.baseRefName) && p.mergedAt).map((p) => ({ sha: p.mergeCommit?.oid ?? '', at: p.mergedAt!, number: p.number, head: p.headRefName, text: `${p.title}\n${p.body ?? ''}` }));
    } catch {
      return undefined;
    }
  }

  /** The branches work merges into: the base branch and master beside it (a master release carries develop's fixes too). */
  private mergeTargets(): string[] {
    const base = this.d.cfg.defaultBase;
    const slash = base.indexOf('/');
    const master = slash > 0 ? `${base.slice(0, slash)}/master` : 'master';
    return base === master ? [base] : [base, master];
  }

  private async exists(ref: string): Promise<string | undefined> {
    const r = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  /**
   * Every commit of a request's branch is already on a base branch, though no PR or commit message says so (merged by hand, or
   * rebased). Only counts when the branch joined the base after the request was filed: a branch that never moved past the
   * commit it started from is an ancestor of the base from the start.
   */
  private async branchInBase(w: WorkItem, targets: { ref: string; sha: string }[]): Promise<WorkAutoClosed | undefined> {
    const branch = w.source?.branch;
    if (!branch) return undefined;
    const remote = this.d.cfg.defaultBase.indexOf('/') > 0 ? this.d.cfg.defaultBase.slice(0, this.d.cfg.defaultBase.indexOf('/')) : 'origin';
    const tip = (await this.exists(`${remote}/${branch}`)) ?? (await this.exists(branch));
    if (!tip) return undefined;
    for (const t of targets) {
      if (!(await this.isAncestor(tip, t.sha))) continue;
      const then = (await this.git(['rev-list', '-1', `--before=${w.createdAt}`, t.sha])).stdout.trim();
      if (then && (await this.isAncestor(tip, then))) continue;
      const first = (await this.git(['log', t.sha, '--first-parent', '--ancestry-path', '--reverse', '-1', '--format=%H%x1f%cI%x1f%s', `${tip}..${t.sha}`])).stdout.trim().split('\x1f');
      const [sha, at, subject] = first.length >= 2 ? first : [tip, new Date(this.now()).toISOString(), ''];
      return { at: '', how: 'ancestor', ...(prNumberOf(subject ?? '') ? { pr: prNumberOf(subject!) } : {}), sha, mergedAt: at, text: mergedText({ number: prNumberOf(subject ?? ''), sha, at, base: t.ref }) };
    }
    return undefined;
  }

  /**
   * Close the intake requests whose work merged (docs/intake.md, "Closed when it merged"): a merged PR or commit on the base
   * branch or master that is the request's PR, names its branch or carries its Discord thread; every commit of its branch
   * already on the base branch; or a linked request that is done. Closed as done with a log line, never worked, the
   * dispatcher not told. Returns the ids closed.
   */
  async checkMerged(notify = true): Promise<string[]> {
    const s = this.settings;
    if (!(s.discord.enabled || s.ffbox.enabled) || this.closing) return [];
    const candidates = mergeCandidates(this.d.store.work.values());
    if (!candidates.length) return [];
    this.closing = true;
    try {
      const targets: { ref: string; sha: string }[] = [];
      for (const ref of this.mergeTargets()) {
        const slash = ref.indexOf('/');
        if (slash > 0) await this.git(['fetch', '--quiet', ref.slice(0, slash), ref.slice(slash + 1)]);
        const sha = await this.exists(ref);
        if (sha) targets.push({ ref, sha });
      }
      const remote = this.d.cfg.defaultBase.indexOf('/') > 0 ? this.d.cfg.defaultBase.slice(0, this.d.cfg.defaultBase.indexOf('/')) : '';
      if (remote) for (const b of new Set(candidates.map((w) => w.source?.branch).filter((x): x is string => !!x))) await this.git(['fetch', '--quiet', remote, `+refs/heads/${b}:refs/remotes/${remote}/${b}`]);
      const records: MergeRecord[] = [];
      for (const t of targets) records.push(...parseLog((await this.git(['log', t.sha, `-n`, String(MERGED_LOG), '--format=%H%x1f%cI%x1f%s%x1f%b%x1e'])).stdout));
      records.push(...((await this.mergedPrs().catch(() => undefined)) ?? []));
      records.sort((a, b) => b.at.localeCompare(a.at));
      const closed: { id: string; closed: WorkAutoClosed }[] = [];
      const done = [...this.d.store.work.values()];
      for (const w of candidates) {
        // A reopened request closes only on a merge after the reopen (w731): the branch already in the base is the work it was reopened for.
        let how = mergedBy(w, records) ?? (w.reopenedAt ? undefined : await this.branchInBase(w, targets));
        if (!how) {
          const y = linkedDone(w, done);
          if (y) how = linkedClosed(w, y);
        }
        if (how) closed.push({ id: w.id, closed: how });
      }
      const ids = new Set(this.d.orchestrators.closeMerged(closed, notify));
      for (const { id, closed: how } of closed) {
        if (!ids.has(id)) continue;
        const w = this.d.store.work.get(id)!;
        this.record({ source: w.source!.kind, action: 'closed', title: w.title, workId: id, why: how.text, url: w.source!.url });
      }
      return [...ids];
    } catch (e) {
      this.data.error = `merged check: ${cleanLine((e as Error).message, 200)}`;
      return [];
    } finally {
      this.closing = false;
      this.changed();
    }
  }

  // ---------------------------------------------------------------- the page

  summary(): IntakeSummary {
    const s = this.settings;
    const now = this.now();
    const day = (iso: string) => now - Date.parse(iso) < 86_400_000;
    const intake = [...this.d.store.work.values()].filter((w) => w.source);
    return {
      discord: {
        enabled: s.discord.enabled,
        bugChannels: s.discord.bugChannels,
        requestChannels: s.discord.requestChannels,
        ffboxOwned: s.discord.ffboxOwned,
        trustedPeople: [...new Set(Object.values(s.discord.trusted))],
        dailyCap: s.discord.dailyCap,
        perReporterPerDay: s.discord.perReporterPerDay,
        autoApprove: s.discord.autoApprove,
        ...(this.data.polledAt ? { polledAt: this.data.polledAt } : {}),
        ...(this.data.error ? { error: this.data.error } : {}),
      },
      ffbox: {
        enabled: s.ffbox.enabled,
        branches: s.ffbox.branches,
        diagnoses: s.ffbox.diagnoses,
        requests: s.ffbox.requests,
        escalations: s.ffbox.escalations,
        boardCheck: s.ffbox.boardCheck,
        sendWork: s.ffbox.sendWork,
        dailyCap: s.ffbox.dailyCap,
        autoApprove: s.ffbox.autoApprove,
        desync: s.ffbox.desync,
      },
      release: { enabled: s.release.enabled, delayMinutes: s.release.delayMinutes, ...(this.data.lastVersion ? { lastVersion: this.data.lastVersion } : {}), ...(this.data.checkedAt ? { checkedAt: this.data.checkedAt } : {}) },
      nightly: {
        ...s.nightly,
        run: { ...s.nightly.run, ...(s.nightly.run.enabled ? { next: iso(nextDaily(s.nightly.run.time, s.nightly.run.tz, now)) } : {}) },
        ...(this.data.nightly ? { last: this.data.nightly } : {}),
        nights: this.nights().slice(0, 14),
      },
      reviewers: this.d.orchestrators.reviewers().map((r) => r.displayName),
      reviewerIds: this.d.orchestrators.reviewers().map((r) => r.userId),
      today: {
        filed: intake.filter((w) => day(w.createdAt)).length,
        skipped: this.data.recent.filter((e) => e.action === 'skipped' && day(e.at)).length,
        autoApproved: intake.filter((w) => day(w.createdAt) && w.approval?.by === 'auto').length,
        pending: intake.filter((w) => w.approval?.state === 'pending' && w.status === 'new').length,
      },
      recent: this.data.recent.slice(0, 50),
    };
  }
}

// ---------------------------------------------------------------- the nightly run's clock (w864)

const iso = (ms: number) => new Date(ms).toISOString();

/** The night of a moment: its date (YYYY-MM-DD) in the schedule's time zone. */
export function nightOf(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** The schedule's latest fire at or before `now`. */
export function lastFire(r: Pick<NightlyRunSettings, 'time' | 'tz'>, now: number): number {
  let fire = nextDaily(r.time, r.tz, now - 2 * 86_400_000);
  for (let next = nextDaily(r.time, r.tz, fire); next <= now; next = nextDaily(r.time, r.tz, fire)) fire = next;
  return fire;
}

/** "2026-10-11 08:00 America/New_York (12:00 UTC)". */
function at(ms: number, tz: string): string {
  const hm = (zone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return `${nightOf(ms, tz)} ${hm(tz)} ${tz} (${hm('UTC')} UTC)`;
}

/** One line for a night: "the night 2026-10-11 passed: 130 of 136 passed, 2 flaky (lothdesktop, develop 7c43c32aa)". */
export function nightLine(n: NightlyNight): string {
  const c = n.counts;
  const counts = c ? `: ${c.passed} of ${c.ran} passed${c.failed ? `, ${c.failed} failed` : ''}${c.flaky ? `, ${c.flaky} flaky` : ''}${c.env ? `, ${c.env} could not run` : ''}` : '';
  const why = n.status === 'broken' && n.cause ? `: ${cleanLine(n.cause, 300)}` : counts;
  const filed = n.work?.length ? `; its regressions are on ${n.work.join(', ')}` : '';
  return `the night ${n.date} ${n.status === 'broken' ? 'broke' : n.status}${why} (${n.lab ?? 'the lab'}${n.sha ? `, develop ${n.sha.slice(0, 9)}` : ''})${filed}`;
}

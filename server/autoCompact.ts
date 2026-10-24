// Automatic compaction of the orchestrators' conversations (w535; docs/orchestrators.md, "Compacting a conversation").
// Every turn sends the whole conversation again, so a turn costs about $0.20 per million tokens of context on Opus 5.5
// (cache reads), and Claude Code only compacts by itself near its 1M-token limit: measured on 2026-10-06 over the three
// live orchestrators' 6,950 turns, a turn started at 800k-1M tokens cost a median $0.20-0.36, one at 100k-150k
// $0.04-0.07. FF Factory compacts each orchestrator, the dispatcher included, between turns once its context passes
// orchestrator.compactAtTokens (default 200,000) or a turn costs orchestrator.compactAtTurnUsd (default $1) with the
// context at 100,000 tokens or more, with Claude Code's own /compact and a focus that keeps what is still open. An
// orchestrator may also ask for it itself (compact_conversation), which runs after its turn the same way.
//
// QUIET FIRST (w1538, lothsahn: "compact when it's above 80k and there have been no messages in 2 minutes? That way you're
// less likely to compact when we're trying to send a message? You should compact at 100k no matter what."). Under
// orchestrator.compactHardAtTokens (default 100,000) an orchestrator due by its context or a turn's cost compacts only
// once its conversation has been quiet for orchestrator.compactIdleSeconds (default 120): no turn has ended, and none is
// running or waiting, for that long. Every message, a person's or the harness's, opens a turn, so anything that arrives
// starts the wait again from that turn's end. At the hard threshold it compacts at the turn's end, as before. A hard
// threshold at or under compactAtTokens, or 0 seconds, compacts at once, as before w1538. The wait is this file's own
// per-session timer, and its clock is the session's saved lastResultAt, so a portal restart loses nothing: the next turn's
// end (a stopped orchestrator is never started just to compact) arms it again.
//
// Workers too (w1469, lothsahn: "Build 1, 2 and 4: compact at ~200k, compact before long waits, trim the base"): a worker
// compacts between turns once its context passes worker.compactAtTokens (200,000), and right after a turn that ends in a
// long wait (a person, another request, a merge, a deploy, a check-in an hour away) once it passes
// worker.compactBeforeWaitTokens (100,000), while its cache is still warm: after the cache's hour the conversation is
// written again small, not whole. Measured on beast's workers (2026-10-15..18, docs/spend.md "Workers compact"): calls
// averaged 357k tokens of context, and a modelled compaction at 200k with the one before waits cut their cost by about
// 45%. A machine's worker compacts through its daemon (`compact`, offered in its hello); one that did not offer it is
// left alone. First a pilot: worker.compactPilotPercent (34) of worker sessions, by id.
//
// IT ALWAYS FINISHES (w1749, lothsahn: "Can you make sure compaction works even if I close the browser or the session is
// closed?"). It runs here, on the portal, from the session's own events: no browser takes part. An orchestrator's due
// compaction is saved on the session (SessionInfo.compactOwed) until one finishes. A stopped or closed orchestrator is started
// for it (it no longer waits for its next message), and an attempt that fails (the process ended, the session was stopped,
// a portal restart cut it off, Claude Code's summary failed) is tried again after COMPACT_RETRY_DELAYS_MS, at most
// MAX_COMPACT_ATTEMPTS times in all, each attempt logged as "auto-compact <id> ... attempt N of M". A portal restart runs an
// owed one again at boot. While an attempt runs or a retry is owed, every message to that orchestrator (a person's, a
// worker update, a dispatch, a timer) waits in the saved send queue and goes after it, so a stop or a restart in the
// middle loses none; a message that comes while a retry waits starts the retry at once.
import type { Config } from './config.ts';
import type { CompactionOwed, SessionInfo } from '../shared/types.ts';
import { COMPACT_FOCUS_CHARS, isMidTurn, type AutoCompaction, type CompactEnd, type SessionHandle, type SessionManager, type TurnEndMeta } from './sessions.ts';

/** The defaults: the context in tokens, and a turn's cost in USD (with the context at COST_TRIGGER_MIN_TOKENS or more). */
export const AUTO_COMPACT_DEFAULTS = { atTokens: 200_000, atTurnUsd: 1 } as const;

/** What set_app_config accepts for them, besides 0 (off). */
export const AUTO_COMPACT_LIMITS = { minTokens: 50_000, maxTokens: 900_000, minTurnUsd: 0.05, maxTurnUsd: 50, maxIdleSeconds: 3600 } as const;

/**
 * The quiet wait's defaults (w1538): under hardAtTokens an orchestrator due for a compaction waits for idleSeconds without
 * a turn first; at hardAtTokens or more it compacts at the turn's end.
 */
export const QUIET_COMPACT_DEFAULTS = { idleSeconds: 120, hardAtTokens: 100_000 } as const;

/**
 * Below this context the cost trigger waits: a compaction cost about $0.17 at 276k tokens (measured, Lothsahn's /compact
 * on 2026-10-06) and leaves 30-50k, so under 100k it would save under $0.012 a model call.
 */
export const COST_TRIGGER_MIN_TOKENS = 100_000;

/** An automatic compaction waits this many turns after any compaction. */
export const MIN_TURNS_BETWEEN = 3;

/** After an automatic compaction that did not finish, the next automatic one waits this long. */
export const RETRY_AFTER_MS = 30 * 60_000;

/** An orchestrator's owed compaction is tried at most this many times in all (w1749); then it waits for a later turn. */
export const MAX_COMPACT_ATTEMPTS = 6;

/** The wait before each retry of an orchestrator's compaction (w1749), ms: after the first failure, the second, … */
export const COMPACT_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000, 60_000, 120_000, 300_000];

/** A message to an orchestrator whose retry waits starts that retry at once (w1749), at most this often. */
export const KICK_AFTER_MS = 10_000;

/** Why its messages wait (w1749): the send queue's line in its chat. */
export const COMPACT_HOLD = 'its conversation is being compacted';

/** How long after a turn's end the check waits, so a message sent with the turn's end goes first. */
export const SETTLE_MS = 2_000;

/**
 * What a coordinator's summary leaves out (w2051): its brief, CLAUDE.md and the MEMORY.md index are loaded again after every
 * compaction, and list_work id shows a waiting card whole, so a summary that repeats them pays for them twice. Lothsahn's
 * orchestrator's summaries were 6-7k tokens and the dispatcher's 10-12k (portal coordinator_context, 2026-10-24, estimated).
 */
export const LEAN_SUMMARY =
  'Leave out what your brief, CLAUDE.md and memory already say (standing rules, how the tools work) and the full text of waiting cards and questions (list_work id has them): one line per open request, its question in a few words.';

/** What a person's orchestrator keeps across an automatic compaction: Claude Code's /compact focus. */
export const PERSONAL_FOCUS =
  `Automatic compaction by FF Factory. Keep, exactly: every request still open (its wNNN id, title, state, the worker session id, its sandbox or machine, PR numbers, and what it waits on); every question you asked your person that they have not answered, and every question of theirs you have not answered yet; decisions, approvals and holds, each with the person who gave it; timers, heartbeat and wake_me check-ins you set, and why; anything you promised to report or check. Keep every id with what it is. Finished work: one line each at most. Your memory folder is unchanged, and list_work has the ledger. ${LEAN_SUMMARY}`;

/** What a worker keeps across an automatic compaction (w1469). */
export const WORKER_FOCUS =
  "Automatic compaction by FF Factory. Keep, exactly: every request you are on (its wNNN id, title and person), its brief's goal, done-when and constraints, and every person's words quoted in it or since, word for word, with who said them; your branch, sandbox, commits pushed and PR numbers with their state; what is done and verified and how (the commands and their results), what is left, and what you wait on; the files and line numbers you are changing and why; corrections and decisions, each with who gave them; ids with what they are. Finished steps: one line each at most. The ledger (read_work) has the requests.";

/** The defaults of a worker's compaction (w1469): its context, its context before a long wait, and the pilot's share in percent. */
export const WORKER_COMPACT_DEFAULTS = { atTokens: 200_000, beforeWaitTokens: 100_000, pilotPercent: 34 } as const;

/**
 * The earlier-compaction pilot (w2002, lothsahn: "File the compaction pilot plus the base-context trim and noise fixes"). Over
 * 14 days 96% of workers' cache-read tokens came from calls above 100k of context and 78% above 200k (measured), so a share
 * of worker sessions compacts earlier: between turns from atTokens instead of worker.compactAtTokens, and within a turn from
 * midTurnTokens (Claude Code's own autocompact, through the session's autoCompactWindow setting) instead of near the model's
 * 1M window. Never below EARLY_COMPACT_MIN_TOKENS: the base plus a compaction's summary is already about 67k. The rest of the
 * workers are the control arm. docs/spend.md, "Compacting earlier, a pilot".
 */
export const EARLY_COMPACT_DEFAULTS = { pilotPercent: 50, atTokens: 120_000, midTurnTokens: 150_000 } as const;

/** The least either early threshold may be set to (set_app_config). */
export const EARLY_COMPACT_MIN_TOKENS = 80_000;

/**
 * Claude Code compacts within a turn once the context reaches its autoCompactWindow less 20,000 (the output reserve) less
 * 13,000 (its buffer): read from Claude Code 2.1.284 (`Sve`, `yQ`), and measured there with autoCompactWindow 170,000 (its
 * debug log: "effectiveWindow=150000"). So a mid-turn threshold T takes the window T + 33,000.
 */
export const AUTO_COMPACT_WINDOW_OVERHEAD = 33_000;

/** Appended to a pilot worker's system prompt: it marks the arm in the transcript (scripts/compact-compare.py reads it). */
export const EARLY_COMPACT_MARK = '## Compaction (pilot)';

export interface EarlyCompactSettings {
  pilotPercent: number;
  atTokens: number;
  midTurnTokens: number;
}

/** The early pilot in force (config worker.earlyCompactPilotPercent / earlyCompactAtTokens / earlyCompactMidTurnTokens). */
export function earlyCompactSettings(cfg: Partial<Pick<Config, 'worker'>>): EarlyCompactSettings {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  const w = cfg.worker;
  return {
    pilotPercent: Math.min(100, n(w?.earlyCompactPilotPercent, EARLY_COMPACT_DEFAULTS.pilotPercent)),
    atTokens: Math.max(EARLY_COMPACT_MIN_TOKENS, n(w?.earlyCompactAtTokens, EARLY_COMPACT_DEFAULTS.atTokens)),
    midTurnTokens: Math.max(EARLY_COMPACT_MIN_TOKENS, n(w?.earlyCompactMidTurnTokens, EARLY_COMPACT_DEFAULTS.midTurnTokens)),
  };
}

/** Whether this worker session is in the earlier-compaction arm: a stable share of ids, drawn apart from the other pilots. */
export function inEarlyCompactPilot(sessionId: string, cfg: Partial<Pick<Config, 'worker'>>): boolean {
  return inPilot(`early:${sessionId}`, earlyCompactSettings(cfg).pilotPercent);
}

/** The Claude Code autoCompactWindow setting of a pilot worker's process, or undefined (the control arm: Claude Code's own). */
export function workerAutoCompactWindow(sessionId: string, cfg: Partial<Pick<Config, 'worker'>>): number | undefined {
  return inEarlyCompactPilot(sessionId, cfg) ? earlyCompactSettings(cfg).midTurnTokens + AUTO_COMPACT_WINDOW_OVERHEAD : undefined;
}

/** A worker's system prompt append with the pilot's mark when its session is in the early arm. */
export function withEarlyCompactMark(brief: string, sessionId: string, cfg: Partial<Pick<Config, 'worker'>>): string {
  if (!inEarlyCompactPilot(sessionId, cfg)) return brief;
  const e = earlyCompactSettings(cfg);
  return `${brief}\n\n${EARLY_COMPACT_MARK}\nThis session compacts earlier than most: between turns from about ${num(e.atTokens)} tokens of context, within a turn from about ${num(e.midTurnTokens)}.`;
}

/** A wait shorter than this keeps the cache warm (its entries live an hour): a check-in sooner is no long wait. */
export const LONG_WAIT_MS = 55 * 60_000;

export interface WorkerCompactSettings {
  atTokens: number;
  beforeWaitTokens: number;
  pilotPercent: number;
}

/**
 * The worker thresholds in force (config worker.compactAtTokens / compactBeforeWaitTokens / compactPilotPercent; 0 is off).
 * With a session id in the earlier-compaction arm (w2002), its between-turns threshold is the arm's, unless compaction is off.
 */
export function workerCompactSettings(cfg: Partial<Pick<Config, 'worker'>>, sessionId?: string): WorkerCompactSettings {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  const w = cfg.worker;
  const s = { atTokens: n(w?.compactAtTokens, WORKER_COMPACT_DEFAULTS.atTokens), beforeWaitTokens: n(w?.compactBeforeWaitTokens, WORKER_COMPACT_DEFAULTS.beforeWaitTokens), pilotPercent: Math.min(100, n(w?.compactPilotPercent, WORKER_COMPACT_DEFAULTS.pilotPercent)) };
  if (sessionId !== undefined && s.atTokens > 0 && inEarlyCompactPilot(sessionId, cfg)) s.atTokens = earlyCompactSettings(cfg).atTokens;
  return s;
}

/** Whether this worker session is in the pilot: a stable share of session ids (the same session always answers the same). */
export function inPilot(sessionId: string, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) h = Math.imul(h ^ sessionId.charCodeAt(i), 16777619);
  return (h >>> 0) % 100 < percent;
}

/**
 * Whether this worker is due for an automatic compaction now (w1469): before a long wait (`waiting`, why it waits) from
 * beforeWaitTokens, else by its context as an orchestrator's (compactionDue, no cost trigger: a worker's turn is long by nature).
 */
export function workerCompactionDue(info: Pick<SessionInfo, 'contextTokens' | 'lastTurnCostUsd' | 'lastCompaction' | 'turns'>, s: WorkerCompactSettings, waiting?: string): AutoCompaction | undefined {
  const ctx = info.contextTokens;
  if (!ctx) return undefined;
  if (waiting && s.beforeWaitTokens > 0 && ctx >= s.beforeWaitTokens) return { trigger: 'wait', reason: `it waits (${waiting.slice(0, 160)}) with the context at ${num(ctx)} tokens` };
  return compactionDue(info, { atTokens: s.atTokens, atTurnUsd: 0 });
}

/** What the dispatcher keeps across an automatic compaction. */
export const DISPATCHER_FOCUS =
  `Automatic compaction by FF Factory. Keep, exactly: every open or queued request (its wNNN id, title, who asked, its state, the worker session id and sandbox or machine, PR numbers, and what it waits on: a slot, a check, a person); decisions, approvals, holds and priorities, each with the person who gave it; deploy and release checks in flight; timers you set and why; capacity facts you still rely on (which machine or slot is out, and since when). Keep every id with what it is. Finished work: one line each at most. Your memory folder is unchanged, and list_work has the ledger. ${LEAN_SUMMARY}`;

export interface AutoCompactSettings {
  atTokens: number;
  atTurnUsd: number;
  /** The quiet wait (w1538), seconds; 0 is none. Absent (a worker's): none. */
  idleSeconds?: number;
  /** From this context on, no quiet wait (w1538); at or under atTokens (or 0), never a quiet wait. */
  hardAtTokens?: number;
}

/** The thresholds in force (config orchestrator.compactAtTokens / compactAtTurnUsd / compactIdleSeconds / compactHardAtTokens; 0 is off). */
export function autoCompactSettings(cfg: Pick<Config, 'orchestrator'>): AutoCompactSettings {
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  const o = cfg.orchestrator;
  return {
    atTokens: n(o?.compactAtTokens, AUTO_COMPACT_DEFAULTS.atTokens),
    atTurnUsd: n(o?.compactAtTurnUsd, AUTO_COMPACT_DEFAULTS.atTurnUsd),
    idleSeconds: n(o?.compactIdleSeconds, QUIET_COMPACT_DEFAULTS.idleSeconds),
    hardAtTokens: n(o?.compactHardAtTokens, QUIET_COMPACT_DEFAULTS.hardAtTokens),
  };
}

/**
 * How many ms more this orchestrator, due for an automatic compaction, waits for quiet (w1538); 0: compact now. No wait at
 * hardAtTokens or more, nor when hardAtTokens is at or under atTokens or idleSeconds is 0 (as before w1538). `quietSince`:
 * when its last turn ended (ms), undefined when unknown (no wait then: nothing says it was busy).
 */
export function quietWaitMs(info: Pick<SessionInfo, 'contextTokens'>, s: AutoCompactSettings, quietSince: number | undefined, now: number): number {
  const idleMs = (s.idleSeconds ?? 0) * 1000;
  const hard = s.hardAtTokens ?? 0;
  if (idleMs <= 0 || hard <= s.atTokens || (info.contextTokens ?? 0) >= hard || quietSince === undefined || !Number.isFinite(quietSince)) return 0;
  return Math.max(0, quietSince + idleMs - now);
}

const num = (n: number) => n.toLocaleString('en-US');

/**
 * Whether this orchestrator's conversation is due for an automatic compaction now, by its measured context and its last
 * turn's cost: why (the chat line says it), or undefined. Not within MIN_TURNS_BETWEEN turns of the last compaction, and
 * the token trigger also waits until the context has grown by half the threshold past what the last one left, so a
 * conversation a compaction cannot bring under it is not compacted every few turns.
 */
export function compactionDue(info: Pick<SessionInfo, 'contextTokens' | 'lastTurnCostUsd' | 'lastCompaction' | 'turns'>, s: AutoCompactSettings): AutoCompaction | undefined {
  const ctx = info.contextTokens;
  if (!ctx) return undefined;
  const last = info.lastCompaction;
  if (last && info.turns - last.turns < MIN_TURNS_BETWEEN) return undefined;
  if (s.atTokens > 0 && ctx >= s.atTokens && ctx >= (last?.after ?? 0) + s.atTokens / 2) return { trigger: 'tokens', reason: `the context passed ${num(s.atTokens)} tokens` };
  const spent = info.lastTurnCostUsd ?? 0;
  if (s.atTurnUsd > 0 && spent >= s.atTurnUsd && ctx >= COST_TRIGGER_MIN_TOKENS) return { trigger: 'cost', reason: `its last turn cost $${spent.toFixed(2)}, $${s.atTurnUsd.toFixed(2)} or more, with the context at ${num(ctx)} tokens` };
  return undefined;
}

/**
 * Why this orchestrator must not be compacted now, or undefined. Only between turns: not mid-turn, no permission
 * prompt, no message of anyone's waiting in the send queue or unanswered, not compacting already. `resume` (w1749, an
 * orchestrator of this portal): a stopped process is started for it; otherwise (a worker) it must be up.
 */
export function compactBlocker(s: SessionHandle & { compactingNow?: boolean }, queued: boolean, resume = false): string | undefined {
  const i = s.info;
  if ((i.kind !== 'orchestrator' && i.kind !== 'worker') || !s.compact) return i.kind === 'worker' ? 'its daemon cannot compact' : 'not an orchestrator or a worker';
  if (!i.sdkSessionId) return 'no conversation yet';
  if (!s.live && !resume) return 'its process is not running';
  if (s.compactingNow) return 'compacting already';
  if (isMidTurn(i) || (s.live && i.status !== 'idle')) return `it is ${i.status.replace('_', ' ')}`;
  if (i.turnOpenSince) return 'a message to it is not answered yet';
  if (i.pendingPermissions.length) return 'a permission prompt is open';
  if (queued) return 'a message to it is waiting in the send queue';
  return undefined;
}

/** The sessions whose compaction is owed and retried (w1749): this portal's orchestrators (a worker's daemon runs its own). */
const owesOn = (i: SessionInfo) => i.kind === 'orchestrator' && !i.machineId;

/** An attempt at its owed compaction was made and did not finish (w1749): a retry is owed. */
const retrying = (i: SessionInfo) => owesOn(i) && (i.compactOwed?.attempts ?? 0) > 0;

/**
 * Compacts the orchestrators by themselves (see the top of this file). Listens to every turn's end; a compaction's own end
 * is not a turn to check. The triggers read the session's own fields, which are saved, and so is an orchestrator's owed
 * compaction (w1749, SessionInfo.compactOwed); the timers and compact_conversation's requests here are not.
 */
export class AutoCompactor {
  /** compact_conversation requests (w535), by session: the focus the orchestrator gave, '' for the default one. */
  private readonly requested = new Map<string, string>();
  /** When each session's last automatic compaction started: one that did not finish holds the next for RETRY_AFTER_MS. */
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** When each session's last turn ended, as seen here (w1538's quiet clock; after a restart, its saved lastResultAt). */
  private readonly turnEnded = new Map<string, number>();
  private readonly settleMs: number;
  /** The waits before each retry (w1749; tests make them short). */
  private readonly retryDelaysMs: readonly number[];
  private readonly sessions: SessionManager;
  private readonly cfg: Pick<Config, 'orchestrator'> & Partial<Pick<Config, 'worker'>>;
  /** Why a worker now waits a long time (a person, another request, a merge, a deploy, a far check-in), or undefined (w1469). */
  private readonly waitsLong: (i: SessionInfo) => string | undefined;
  /** Why a worker's process restarts on another account before its next turn (w1745, Agents.accountMoveWhy), or undefined. */
  private readonly moving: (s: SessionHandle) => string | undefined;

  constructor(sessions: SessionManager, cfg: Pick<Config, 'orchestrator'> & Partial<Pick<Config, 'worker'>>, opts: { settleMs?: number; waitsLong?: (i: SessionInfo) => string | undefined; moving?: (s: SessionHandle) => string | undefined; retryDelaysMs?: readonly number[] } = {}) {
    this.sessions = sessions;
    this.cfg = cfg;
    this.settleMs = opts.settleMs ?? SETTLE_MS;
    this.retryDelaysMs = opts.retryDelaysMs?.length ? opts.retryDelaysMs : COMPACT_RETRY_DELAYS_MS;
    this.waitsLong = opts.waitsLong ?? (() => undefined);
    this.moving = opts.moving ?? (() => undefined);
    sessions.events.on('turnEnd', (s: SessionHandle, _text: string, meta?: TurnEndMeta) => {
      if (s.info.kind !== 'orchestrator' && s.info.kind !== 'worker') return;
      this.turnEnded.set(s.info.id, Date.now());
      // w1749: a failed attempt's own end lets its retry go, unless a retry is already timed.
      if (meta?.compaction) {
        if (retrying(s.info) && !this.timers.has(s.info.id)) this.soon(s.info.id);
        return;
      }
      this.soon(s.info.id);
    });
    sessions.events.on('compactEnd', (s: SessionHandle, e: CompactEnd) => {
      if (!owesOn(s.info)) return;
      if (e.ok) this.finished(s);
      else if (e.auto) this.failed(s.info.id, e.why ?? 'no reason given');
    });
    sessions.compactHold = (s, incoming) => this.hold(s, incoming);
  }

  /**
   * After a portal restart (w1749): the compactions owed when the last one stopped (one cut off by the stop, a retry that
   * was timed, one waiting for quiet) are checked again now, the stopped orchestrators started for them.
   */
  boot(): number {
    let n = 0;
    for (const s of this.sessions.sessions.values()) {
      const o = s.info.compactOwed;
      if (!o || !owesOn(s.info)) continue;
      console.log(`auto-compact ${s.info.id} (${s.info.title}): owed across the restart (${o.reason}; ${o.attempts} attempt(s) so far${o.lastError ? `, the last failed: ${o.lastError}` : ''}); checked again now`);
      this.soon(s.info.id);
      n++;
    }
    return n;
  }

  /** Check this session after SETTLE_MS, or `ms` (a later turn end moves it: the quiet wait starts again, w1538). */
  private soon(id: string, ms = this.settleMs) {
    clearTimeout(this.timers.get(id));
    const t = setTimeout(() => {
      this.timers.delete(id);
      try {
        this.check(id);
      } catch (e) {
        console.warn(`auto-compact ${id}: ${(e as Error).message}`);
      }
    }, ms);
    t.unref?.();
    this.timers.set(id, t);
  }

  /**
   * Why a message to this orchestrator waits (w1749): its compaction runs, or a retry is owed. A message that comes while
   * a retry waits starts it at once (at most every KICK_AFTER_MS), so it waits for one attempt, not a backoff.
   */
  private hold(s: SessionHandle & { compactingNow?: boolean }, incoming = false): string | undefined {
    if (!owesOn(s.info)) return undefined;
    if (s.compactingNow) return COMPACT_HOLD;
    if (!retrying(s.info)) return undefined;
    const last = Date.parse(s.info.compactOwed!.lastAttemptAt ?? '') || 0;
    if (incoming && Date.now() - last >= KICK_AFTER_MS && !s.info.turnOpenSince) this.soon(s.info.id);
    return COMPACT_HOLD;
  }

  private save(s: SessionHandle, owed: CompactionOwed | undefined) {
    s.info.compactOwed = owed;
    this.sessions.saveInfo(s.info.id);
  }

  /** A compaction finished (any: automatic, a person's /compact): nothing is owed, and the messages it held go. */
  private finished(s: SessionHandle) {
    const o = s.info.compactOwed;
    if (!o) return;
    if (o.attempts > 1) console.log(`auto-compact ${s.info.id} (${s.info.title}): done at attempt ${o.attempts} of ${MAX_COMPACT_ATTEMPTS}`);
    this.save(s, undefined);
  }

  /** An attempt failed (w1749): tried again after its delay, or given up after MAX_COMPACT_ATTEMPTS; each one logged. */
  private failed(id: string, why: string) {
    const s = this.sessions.sessions.get(id);
    const o = s?.info.compactOwed;
    if (!s || !o) return;
    const err = why.replace(/\s+/g, ' ').slice(0, 300);
    if (o.attempts >= MAX_COMPACT_ATTEMPTS) {
      this.save(s, undefined);
      console.warn(`auto-compact ${id} (${s.info.title}): attempt ${o.attempts} of ${MAX_COMPACT_ATTEMPTS} failed (${err}); given up, tried again after a later turn`);
      this.sessions.note(id, `FF Factory gave up compacting this conversation after ${o.attempts} attempts (the last failed: ${err}). It tries again after a later turn, ${RETRY_AFTER_MS / 60_000} minutes from now at the earliest; the messages that waited for it go now.`);
      setImmediate(() => this.sessions.drain());
      return;
    }
    const wait = this.retryDelaysMs[Math.min(o.attempts, this.retryDelaysMs.length) - 1];
    this.save(s, { ...o, lastError: err });
    console.warn(`auto-compact ${id} (${s.info.title}): attempt ${o.attempts} of ${MAX_COMPACT_ATTEMPTS} failed (${err}); tried again in ${Math.round(wait / 1000)} s`);
    this.soon(id, wait);
  }

  /**
   * Compact this orchestrator now when it is due and between turns: what it did ("compacting: <why>"), or why not. For
   * the turn-end check and tests.
   */
  check(id: string, now = Date.now()): string {
    const s = this.sessions.sessions.get(id) as (SessionHandle & { compactingNow?: boolean }) | undefined;
    if (!s) return 'no such session';
    // w1749: an orchestrator of this portal is started for it; the messages held for it are no message ahead of it.
    const orch = owesOn(s.info);
    const blocked = compactBlocker(s, this.sessions.queued().some((q) => q.id === id && !q.compaction), orch);
    if (blocked) return `not now: ${blocked}`;
    const worker = s.info.kind === 'worker';
    let ws: WorkerCompactSettings | undefined;
    if (worker) {
      ws = workerCompactSettings(this.cfg, id);
      if (!inPilot(id, ws.pilotPercent)) return 'not in the pilot';
    }
    const owed = orch ? s.info.compactOwed : undefined;
    const asked = this.requested.get(id);
    let due: AutoCompaction | undefined = asked !== undefined ? { trigger: 'self', reason: 'the orchestrator asked for it' } : ws ? workerCompactionDue(s.info, ws, this.waitsLong(s.info)) : compactionDue(s.info, autoCompactSettings(this.cfg));
    // An owed one stays due until one finishes (w1749).
    if (!due && owed) due = { trigger: owed.trigger, reason: owed.reason };
    if (!due) return 'not due';
    // w1745: a worker whose process restarts on another account first (its token ran out) compacts after that restart. Sent
    // now, the /compact ran on the used-up token, failed at once and kept the turn open ahead of the resume (7d4cb2df and
    // 9888f324 on 2026-10-22: "auto-compact" 2 s after the limit, then the resume onto the same token).
    const move = worker ? this.moving(s) : undefined;
    if (move) return `not now: its process restarts first (${move})`;
    const retry = !!owed && owed.attempts > 0;
    const tried = this.attempts.get(id);
    const finished = tried !== undefined && s.info.lastCompaction && Date.parse(s.info.lastCompaction.at) >= tried;
    if (!retry && due.trigger !== 'self' && tried !== undefined && !finished && now - tried < RETRY_AFTER_MS) return 'not now: the last automatic compaction did not finish; it is tried again later';
    if (!worker && due.trigger !== 'self' && !retry) {
      // w1538: under the hard threshold, only after a quiet spell. A turn that ends meanwhile checks again and starts it over.
      const s2 = autoCompactSettings(this.cfg);
      const since = Math.max(this.turnEnded.get(id) ?? -Infinity, s.info.lastResultAt ? Date.parse(s.info.lastResultAt) || -Infinity : -Infinity);
      const wait = quietWaitMs(s.info, s2, since, now);
      if (wait > 0) {
        // Owed from now (w1749): a restart or a stop during the wait does not lose it.
        if (orch && !owed) this.save(s, { trigger: due.trigger, reason: due.reason, since: new Date(now).toISOString(), attempts: 0 });
        this.soon(id, wait);
        return `not yet: ${due.reason}; it compacts after ${s2.idleSeconds} s without a turn (${Math.ceil(wait / 1000)} s more), or at once from ${num(s2.hardAtTokens!)} tokens`;
      }
    }
    const dispatcher = s.info.orchestratorRole === 'dispatcher' || (!s.info.orchestratorRole && !s.info.requestedBy);
    const own = asked || owed?.focus;
    const focus = own || (worker ? WORKER_FOCUS : dispatcher ? DISPATCHER_FOCUS : PERSONAL_FOCUS);
    this.requested.delete(id);
    this.attempts.set(id, now);
    const n = (owed?.attempts ?? 0) + 1;
    const wasStopped = !s.live;
    if (orch) this.save(s, { trigger: due.trigger, reason: due.reason, ...(own ? { focus: own } : {}), since: owed?.since ?? new Date(now).toISOString(), attempts: n, lastAttemptAt: new Date(now).toISOString(), ...(owed?.lastError ? { lastError: owed.lastError } : {}) });
    const attempt = orch ? `; attempt ${n} of ${MAX_COMPACT_ATTEMPTS}${wasStopped ? ' (its process was not running: started for it)' : ''}` : '';
    console.log(`auto-compact ${id} (${s.info.title}): ${due.reason}; context ${s.info.contextTokens ?? '?'} tokens${attempt}`);
    try {
      this.sessions.compact(id, focus, undefined, due);
    } catch (e) {
      // It could not even start (its process would not start, a dry run): an attempt that failed, tried again (w1749).
      if (!orch) throw e;
      this.failed(id, (e as Error).message);
      return `not compacted: ${(e as Error).message}`;
    }
    return `compacting: ${due.reason}`;
  }

  /**
   * compact_conversation (w535): the orchestrator asks to compact its own conversation. It runs once this turn has ended,
   * under the same rules as the automatic one (never mid-turn, never ahead of a message waiting for an answer).
   */
  request(id: string, focus = ''): string {
    const s = this.sessions.get(id);
    if (s.info.kind !== 'orchestrator' || !s.compact) throw new Error('only an orchestrator of this host compacts its conversation');
    const f = focus.replace(/\s+/g, ' ').trim();
    if (f.length > COMPACT_FOCUS_CHARS) throw new Error(`the focus is ${f.length} characters; keep it to ${COMPACT_FOCUS_CHARS}`);
    const last = s.info.lastCompaction;
    if (last && s.info.turns - last.turns < MIN_TURNS_BETWEEN) throw new Error(`it was compacted ${s.info.turns - last.turns} turn(s) ago (${num(last.before)} → ${last.after !== undefined ? num(last.after) : '?'} tokens); compact again after ${MIN_TURNS_BETWEEN} turns at the earliest`);
    this.requested.set(id, f);
    const ctx = s.info.contextTokens;
    return `Your conversation is compacted once this turn ends${ctx ? ` (its context is ${num(ctx)} tokens now)` : ''}, before any message that arrives later. End your turn now; anything still open must be in what you have said, the ledger or your memory folder. ${f ? 'Your focus goes with it.' : 'The default focus keeps open requests, unanswered questions, decisions and ids.'}`;
  }

  /** Stop the pending checks (tests, the server stopping). */
  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

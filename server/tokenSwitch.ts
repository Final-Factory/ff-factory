// When a vault Claude token runs out, its agents move to a token with room in their person's pool (w1745; docs/vault.md
// section 4, "When a token runs out"). lothsahn, 2026-10-22: "we do want to run that account out. Can we have it run the
// account out and then have the dispatcher notice and change them once out?"
//
// An agent keeps the token its process started on while that token works: nothing here moves one early. A token is OUT when
// Claude refuses it (a rate_limit_event with status "rejected" on any session's own requests, or a turn that ends on Claude's
// usage-limit line, ledgerRules LIMIT_END), or when the pool rule retires it (weekly at vault.pool.retireWeeklyPercent). A
// refusal marks the token used up in the usage tracker until that window's reset (UsageTracker.markOut), so pickPool hands it
// to nobody and Agents.accountMove restarts every idle agent on it, at its next message, on its person's best token
// (w1375's path; never mid-turn, never with a background task running). This module adds the rest:
// - an agent the limit stopped is resumed at once, in the same conversation, sandbox and requests, when its pool can serve it
//   (its process restarts on the pool's pick first); when no token of that pool has room its requests are Blocked on the
//   token's usage gate, as today, and it is resumed when one has (the blocker watch);
// - every switch is logged: the portal journal, each request the agent holds, and system_status (from which token to which,
//   and why). Tokens are only ever named by their vault name and last four characters.
// The dispatcher stays on the token it is pinned to; the ops worker starts a fresh process for every job, so neither is resumed.

import fs from 'node:fs';
import { LIMIT_END } from './ledgerRules.ts';
import { readJsonDurable, writeJsonDurable, checkObject } from './durable.ts';
import type { TokenOutMark } from './usage.ts';
import type { PlanUsage, SessionInfo } from '../shared/types.ts';

/** How long an out mark lasts when neither Claude's answer nor the meters give the window's reset (a guess: the next polls decide after it). */
export const OUT_FALLBACK_MS = 60 * 60_000;
/** A session refused again on the token it was resumed from within this long did not move (a background task kept its process): held, not resumed again. */
const STUCK_MS = 2 * 3_600_000;
/** A worker still idle on an out token after a limit stop is resumed again this long after its last turn ended (TokenSwitch.tick). */
export const RETRY_STUCK_MS = 10 * 60_000;
/** At most this many such resumes per worker and token: each one that fails costs a turn that ends at once. */
export const MAX_STUCK_RETRIES = 3;
/** Switches kept for system_status. */
const KEEP = 20;
/** A move not seen to finish within this long is dropped (a held pool waits up to 8 days, docs/vault.md section 4). */
const PENDING_MS = 8 * 86_400_000;

/** The SDK's rate_limit_info, as much of it as is read here. */
export interface RateLimitInfo {
  status?: string;
  rateLimitType?: string;
  resetsAt?: number;
  utilization?: number;
}

/** One switch: an agent whose process ran on `from` and now runs on `to`. */
export interface TokenSwitchRecord {
  at: string;
  sessionId: string;
  kind: SessionInfo['kind'];
  title: string;
  /** "vault-ben-1 …nQAA" */
  from: string;
  to: string;
  why: string;
  /** The requests it holds, whose logs got the line. */
  requests: string[];
}

/** A move asked for and not seen to finish yet: the process stopped on `from` (its key) and has not started on another token. */
interface Pending {
  from: string;
  why: string;
  at: number;
}

export interface TokenSwitchDeps {
  now?: () => number;
  /** data/token-switches.json; absent in tests that need no file. */
  file?: string;
  /** "vault-ben-1 …nQAA" for a vault token's key ("token:<fingerprint>"), undefined for anything else. */
  label: (account: string) => string | undefined;
  /** The token's meters as the pool reads them (for the refused window and its reset). */
  meters: (account: string) => PlanUsage | undefined;
  /** Mark the token out (UsageTracker.markOut). */
  markOut: (account: string, mark: TokenOutMark, label: string) => void;
  /** Whether the token (its key) is out: used up or retired, so the pool hands it to no new job (Agents.tokenUnusable). */
  out: (account: string) => boolean;
  /** Whether the pool this agent's next process starts from (its person's, by their pool setting) can serve it now. */
  serves: (s: SessionInfo) => boolean | undefined;
  /** Resume it: a message the send queue holds until its process has restarted on the pool's pick (worker, orchestrator), or a new run (standing). */
  resume: (s: SessionInfo, text: string) => void;
  /** No token with room: block the worker's requests on this token's usage gate (Orchestrators.tokenStopBlocked); the ids blocked. */
  hold: (s: SessionInfo, ref: string, what: string) => string[];
  /** Put a line in the log of each open request the agent holds; the ids. */
  note: (s: SessionInfo, line: string) => string[];
  log: (line: string) => void;
}

const MID_TURN = new Set(['running', 'starting', 'waiting_permission']);

/** Which window a refusal is about: the rate-limit type, else the limit line's words, else the fuller meter. */
export function refusedWindow(type: string | undefined, text: string, u: PlanUsage | undefined): 'session' | 'weekly' {
  if (type === 'five_hour') return 'session';
  if (type?.startsWith('seven_day')) return 'weekly';
  if (/\b(weekly|7[- ]?day|week)\b/i.test(text)) return 'weekly';
  if (/\b(session|5[- ]?hour|five[- ]hour)\b/i.test(text)) return 'session';
  return (u?.session?.percent ?? 0) > (u?.weekly?.percent ?? 0) ? 'session' : 'weekly';
}

/** A pooled token as the orchestrator rule reads it: its meters' key, its label, its pool state and why. */
export interface PoolTokenView {
  key: string;
  label: string;
  state: string;
  why: string;
}

/**
 * Why an orchestrator's process on `account` moves before its next message (w1745), else undefined. An orchestrator uses its
 * pool up (docs/vault.md section 4: it runs past the caps), so it moves only off a token that is out (used up, which a
 * refusal by Claude makes it, or retired), and only when `pool` (the person whose pool its work runs on) has a token it would
 * be better on: one not used up, and not retired either when it leaves a retired one. Only that pool is read: never another
 * person's.
 */
export function orchestratorOut(pools: Iterable<readonly [string, readonly PoolTokenView[]]>, account: string, pool: string): string | undefined {
  const all = [...pools];
  const hit = all.flatMap(([, list]) => list).find((t) => t.key === account);
  if (!hit || (hit.state !== 'retired' && hit.state !== 'exhausted')) return undefined;
  const mine = all.find(([who]) => who.trim().toLowerCase() === pool.trim().toLowerCase())?.[1] ?? [];
  const better = (t: PoolTokenView) => t.key !== account && t.state !== 'exhausted' && (hit.state === 'exhausted' || t.state !== 'retired');
  return mine.some(better) ? `vault token ${hit.label} (${hit.why})` : undefined;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

export class TokenSwitch {
  private readonly d: TokenSwitchDeps;
  private readonly now: () => number;
  /** The token a session was refused on during its current turn (a rejected rate_limit_event), by session id. */
  private readonly refused = new Map<string, string>();
  /** Sessions resumed after a refusal, and on which token, so one whose process could not move is held, not resumed in a loop. */
  private readonly resumed = new Map<string, { account: string; at: number }>();
  /** Resumes by tick of a worker left on an out token, by session id: on which token, how many, and whether giving up was logged. */
  private readonly retries = new Map<string, { account: string; tries: number; gaveUp?: boolean }>();
  private pending = new Map<string, Pending>();
  private recent: TokenSwitchRecord[] = [];

  constructor(d: TokenSwitchDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    if (d.file && fs.existsSync(d.file)) {
      try {
        const f = readJsonDurable<{ recent?: TokenSwitchRecord[]; pending?: Record<string, Pending> }>(d.file, { check: checkObject });
        this.recent = (f?.recent ?? []).slice(-KEEP);
        this.pending = new Map(Object.entries(f?.pending ?? {}));
      } catch {
        // none yet
      }
    }
  }

  /** A session's rate_limit_event (the API's answer on its own requests): "rejected" marks its token out. */
  rateLimit(s: SessionInfo, info: RateLimitInfo | undefined) {
    if (info?.status !== 'rejected' || info.rateLimitType === 'overage' || !s.account) return;
    const label = this.d.label(s.account);
    if (!label) return;
    const reset = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) ? info.resetsAt * 1000 : undefined;
    this.markOut(s.account, label, refusedWindow(info.rateLimitType, '', this.d.meters(s.account)), reset, `Claude refused it (rate limit ${info.rateLimitType ?? 'unnamed'}: rejected) on ${s.kind} ${s.id}'s request`);
    this.refused.set(s.id, s.account);
  }

  /**
   * A session's turn ended. On Claude's usage-limit line, or after a refusal during the turn, its token is out: the agent is
   * resumed on its pool's best token, or held when none has room. Call it once the session reads idle (not mid-turn).
   */
  turnEnded(s: SessionInfo) {
    const account = s.account;
    const refusedOn = this.refused.get(s.id);
    this.refused.delete(s.id);
    if (!account) return;
    const label = this.d.label(account);
    const text = (s.lastResult ?? '').trim();
    const limitLine = LIMIT_END.test(text);
    if (!label || (!limitLine && refusedOn !== account)) return;
    const line = text.replace(/\s+/g, ' ').slice(0, 120);
    if (limitLine) this.markOut(account, label, refusedWindow(undefined, text, this.d.meters(account)), undefined, `${s.kind} ${s.id}'s turn ended on Claude's limit line ("${line}")`);
    if (MID_TURN.has(s.status)) return; // a message queued behind the turn started the next one: it ends on the limit too, and comes back here
    const who = `${s.kind} ${s.id}`;
    if (s.kind === 'ops' || (s.kind === 'orchestrator' && s.orchestratorRole === 'dispatcher')) {
      this.d.log(`token switch (w1745): ${who} stopped on ${label}, which is out; ${s.kind === 'ops' ? 'the ops worker starts a fresh process for every job, on a token with room' : 'the dispatcher stays on its own token'}, so it is not resumed`);
      return;
    }
    const why = `${label} ran out (${limitLine ? `"${line}"` : 'Claude refused it'})`;
    const again = this.resumed.get(s.id);
    const stuck = !!again && again.account === account && this.now() - again.at < STUCK_MS;
    const serves = !stuck && this.d.serves(s) === true;
    if (serves) {
      this.resumed.set(s.id, { account, at: this.now() });
      this.moving(s, why);
      this.d.log(`token switch (w1745): ${who} stopped on ${label}, which is out; resumed on a token with room in its pool`);
      this.d.resume(s, this.resumeText(s, label, why));
      return;
    }
    if (stuck) {
      // Its process could not move (a background task keeps it, accountMove): another resume would run on the out token again,
      // and a usage gate would clear at once (its pool has room) and loop. It moves at its first message once the task is done;
      // tick resumes it again RETRY_STUCK_MS later, a few times, and the ledger cleanup resumes a worker a limit cut off (cutOffStep).
      this.d.log(`token switch (w1745): ${who} stopped on ${label} again after its resume: its process is still there (${s.backgroundTasks ? 'a background task keeps it' : 'it did not restart'}), so it is not resumed at once; it moves at its next message once nothing keeps the process, or is resumed again in ${RETRY_STUCK_MS / 60_000} min`);
      return;
    }
    const reason = 'no token in its pool has room';
    if (s.kind === 'worker') {
      const blocked = this.d.hold(s, label, `${label} ran out and ${reason}`);
      this.d.log(`token switch (w1745): ${who} stopped on ${label}, which is out, and ${reason}: ${blocked.length ? `${blocked.join(', ')} blocked on its usage limit, resumed when a token of the pool has room` : 'nothing to block'}`);
    } else this.d.log(`token switch (w1745): ${who} stopped on ${label}, which is out, and ${reason}: it waits (its next message or run starts when a token has room)`);
  }

  /**
   * Every minute (index.ts): a worker still idle on an out token whose last turn ended on Claude's limit line is resumed again,
   * RETRY_STUCK_MS after that turn, at most MAX_STUCK_RETRIES times per token. Without it a worker whose move did not take
   * waited for "its next message", which nothing sent: 7d4cb2df (w1752) sat on vault-ben-1 from 18:31Z on 2026-10-22, its
   * process kept by an agent host that predated the daemon fix, and a portal restart forgets who was resumed. Not while a
   * background task keeps its process (that move waits for the task), and not when its pool has no room (the usage gate holds it).
   */
  tick(sessions: Iterable<SessionInfo>) {
    const now = this.now();
    for (const s of sessions) {
      if (s.kind !== 'worker' || !s.account || MID_TURN.has(s.status) || s.status === 'stopped' || s.status === 'error' || s.backgroundTasks) continue;
      if (!LIMIT_END.test((s.lastResult ?? '').trim())) continue;
      const ended = Date.parse(s.lastResultAt ?? '');
      if (!Number.isFinite(ended) || now - ended < RETRY_STUCK_MS) continue;
      const label = this.d.label(s.account);
      if (!label || !this.d.out(s.account)) continue;
      // Its last resume is still on its way (the restart, the queued message): not another on top.
      const last = this.resumed.get(s.id);
      if (last?.account === s.account && now - last.at < RETRY_STUCK_MS) continue;
      const r = this.retries.get(s.id);
      const tries = r?.account === s.account ? r.tries : 0;
      const who = `${s.kind} ${s.id}`;
      if (tries >= MAX_STUCK_RETRIES) {
        if (!r?.gaveUp) {
          this.retries.set(s.id, { account: s.account, tries, gaveUp: true });
          this.d.log(`token switch (w1745): ${who} is still on ${label} after ${tries} more resumes; not resumed again, it moves at its next message`);
        }
        continue;
      }
      if (this.d.serves(s) !== true) continue;
      this.retries.set(s.id, { account: s.account, tries: tries + 1 });
      this.resumed.set(s.id, { account: s.account, at: now });
      const why = `${label} ran out ("${(s.lastResult ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}")`;
      this.moving(s, why);
      this.d.log(`token switch (w1745): ${who} is still idle on ${label}, which is out, ${Math.round((now - ended) / 60_000)} min after its turn stopped there; resumed again on a token with room in its pool (${tries + 1} of ${MAX_STUCK_RETRIES})`);
      this.d.resume(s, this.resumeText(s, label, why));
    }
  }

  /**
   * An idle agent's process is stopped to restart on another account before its next message (Agents.accountMove): remember
   * where it was, so the start that follows is logged as a switch.
   */
  moving(s: Pick<SessionInfo, 'id' | 'account'>, why: string) {
    if (!s.account || !this.d.label(s.account) || this.pending.get(s.id)?.from === s.account) return;
    this.pending.set(s.id, { from: s.account, why, at: this.now() });
    this.save();
  }

  /** A session changed (bus "session"): a pending move whose process now runs on another token is a switch, logged. */
  seen(s: SessionInfo) {
    const p = this.pending.get(s.id);
    if (!p) return;
    if (this.now() - p.at > PENDING_MS) {
      this.pending.delete(s.id);
      this.save();
      return;
    }
    if (!s.account || s.account === p.from || s.status === 'stopped' || s.status === 'error') return;
    this.pending.delete(s.id);
    const from = this.d.label(p.from) ?? 'a vault token no longer in the vault';
    const to = this.d.label(s.account) ?? 'an account outside the vault';
    const line = `token switch (w1745): ${s.kind} ${s.id} moved from ${from} to ${to}: ${p.why}`;
    const requests = this.d.note(s, line);
    this.d.log(`${line}${requests.length ? ` (${requests.join(', ')})` : ''}`);
    this.recent = [...this.recent, { at: new Date(this.now()).toISOString(), sessionId: s.id, kind: s.kind, title: s.title, from, to, why: p.why, requests }].slice(-KEEP);
    this.save();
  }

  /** The switches kept, oldest first. */
  switches(): readonly TokenSwitchRecord[] {
    return this.recent;
  }

  /** system_status: the tokens out now, the moves waiting for a turn, and the last switches (24 hours). */
  statusLines(outs: [string, TokenOutMark][], live: (account: string) => string[]): string[] {
    const now = this.now();
    const out: string[] = [];
    for (const [key, o] of outs) {
      const on = live(key);
      out.push(`Token out (w1745): ${this.d.label(key) ?? 'a vault token'}: ${o.why} (${hhmm(o.at)}); its ${o.field === 'weekly' ? 'weekly' : '5-hour'} window counts as used up until ${hhmm(o.until)}. ${on.length ? `Still on it: ${on.join(', ')}; each moves to a token with room at its next turn, never mid-turn` : 'No agent runs on it'}.`);
    }
    const waiting = [...this.pending].filter(([, p]) => now - p.at <= PENDING_MS);
    if (waiting.length) out.push(`Token switches waiting for their next process (w1745): ${waiting.map(([id, p]) => `${id} from ${this.d.label(p.from) ?? 'a vault token'}`).join(', ')}`);
    const day = this.recent.filter((r) => now - Date.parse(r.at) < 86_400_000);
    if (day.length) {
      out.push(`Token switches in the last 24 h (w1745, docs/vault.md "When a token runs out"): ${day.length}`);
      for (const r of day.slice(-10)) out.push(`  ${r.at.slice(0, 16).replace('T', ' ')}Z ${r.kind} ${r.sessionId}${r.requests.length ? ` (${r.requests.join(', ')})` : ''}: ${r.from} → ${r.to}: ${r.why}`);
    }
    return out;
  }

  private markOut(account: string, label: string, field: 'session' | 'weekly', reset: number | undefined, why: string) {
    const now = this.now();
    const meter = this.d.meters(account)?.[field];
    const fromMeter = meter?.resetsAt ? Date.parse(meter.resetsAt) : NaN;
    const until = reset && reset > now ? reset : Number.isFinite(fromMeter) && fromMeter > now ? fromMeter : now + OUT_FALLBACK_MS;
    this.d.markOut(account, { field, until, at: now, why }, label);
  }

  private resumeText(s: SessionInfo, label: string, why: string) {
    const same = s.kind === 'worker' ? 'your conversation, sandbox and requests are as you left them' : 'your conversation is as you left it';
    return `[token switch] Your last turn stopped because ${why}. FF Factory moved you to a Claude token with room in the same pool (w1745, docs/vault.md "When a token runs out"); ${same}, and ${label} is not used again before its reset. Carry on where you stopped. If the work is already done, say so in one line and stop.`;
  }

  private save() {
    if (!this.d.file) return;
    try {
      writeJsonDurable(this.d.file, { recent: this.recent, pending: Object.fromEntries(this.pending) }, { indent: 1, generations: 0 });
    } catch {
      // not fatal: the journal and the request logs keep the switches
    }
  }
}

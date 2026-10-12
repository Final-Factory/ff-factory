// The dispatcher's token stop (w1109, lothsahn, 2026-10-12: "at 95%+ session or weekly usage the dispatcher asks all workers
// using the dispatcher key to stop, save their work and push"; docs/vault.md section 4, "The stop line").
//
// The dispatcher runs on one vault token (config claudeAccounts.dispatcher). When either of that token's meters reaches the
// stop line (vault.pool.dispatcherStopPercent, 95), every worker whose process runs on it and is mid-turn is asked, once, to
// commit and push its work and end its turn; one still mid-turn INTERRUPT_AFTER_MS later is interrupted. Once its turn has
// ended its requests are Blocked on that token's limit (Orchestrators.tokenStopBlocked), and it is resumed when its person's
// pool has a token with room (the usage gate, server/index.ts usageClear), on that token (Agents.accountMove). New workers
// stay off the token from the same reading: reserveOf puts a meter at the stop line inside the dispatcher's reserve
// (server/tokenPool.ts), which no worker is handed.
//
// Not asked: the dispatcher itself, the orchestrators, the ops worker (the harness takes no message to it but its own
// orchestrators', w597, and w1112 runs it past the caps), standing agents (one short scheduled run each), and a worker that
// is idle (its next message restarts its process on another token first, Agents.accountMove, so nothing more runs here).

import fs from 'node:fs';
import { metersOf, clock, type PoolLimits } from './tokenPool.ts';
import { writeJsonDurable } from './durable.ts';
import type { PlanUsage, SessionInfo } from '../shared/types.ts';

/**
 * How long a worker that was asked may stay mid-turn before it is interrupted. A worker reads a message sent mid-turn at
 * its next step, after the tool call it is in: a foreground shell command may run up to 10 minutes (Claude Code's Bash
 * timeout, 600000 ms at most), and committing, pushing (the repos' prepush checks) and writing the report take a few
 * minutes more. The restart drain gives the same wrap-up 10 minutes by default (server/restart.ts drainMinutes). A judgment,
 * not measured: 15 minutes lets the longest single step finish and the save follow, and an interrupt never loses the work,
 * which stays in the worker's sandbox, committed or not.
 */
export const INTERRUPT_AFTER_MS = 15 * 60_000;

/** One worker asked during the current crossing. */
export interface StopAsked {
  /** When it was asked (ISO). */
  at: string;
  /** When it was interrupted, still mid-turn INTERRUPT_AFTER_MS later (ISO). */
  interruptedAt?: string;
  /** When its turn had ended and its requests were blocked (ISO), and which. */
  endedAt?: string;
  blocked?: string[];
}

/** One crossing: the token's key while a meter of it stays at or above the stop line, and the workers asked during it. */
export interface StopCrossing {
  key: string;
  /** "vault-lothsahn-1 …EAAA" */
  name: string;
  since: string;
  /** The meters at the crossing: "weekly 96%" or "5-hour 95%, weekly 96%". */
  meters: string;
  asked: Record<string, StopAsked>;
}

export interface DispatcherStopDeps {
  /** The dispatcher's pinned vault token now: its meters' key ("token:<fingerprint>"), its name and its owner. Unpinned: undefined. */
  token: () => { key: string; name: string; owner?: string } | undefined;
  usageOf: (key: string) => PlanUsage | undefined;
  limits: () => PoolLimits;
  sessions: () => Iterable<SessionInfo>;
  /** The open requests a worker holds, by id (for its message). */
  requestsOf: (sessionId: string) => string[];
  /** Send a harness message the normal way (SessionManager.send, from 'system'): mid-turn it joins the running turn. */
  tell: (sessionId: string, text: string) => void;
  interrupt: (sessionId: string) => Promise<void> | void;
  /** Its turn has ended: block its requests on the token's limit; returns the ids blocked (Orchestrators.tokenStopBlocked). */
  block: (sessionId: string, gate: { ref: string; what: string }) => string[];
  log: (line: string) => void;
  now?: () => number;
  /** Where the crossing is kept, so a portal restart does not ask the same workers again. */
  file?: string;
}

const MID_TURN = new Set<SessionInfo['status']>(['running', 'starting', 'waiting_permission']);
const live = (s: SessionInfo) => s.status !== 'stopped' && s.status !== 'error';

/** Which meters are at or above the stop line, with their figures and resets; empty when none is (or there is no reading). */
export function stopMeters(u: PlanUsage | undefined, limits: PoolLimits): { name: '5-hour' | 'weekly'; percent: number; resetsAt?: string }[] {
  const m = metersOf(u);
  if (!m.known) return [];
  const out: { name: '5-hour' | 'weekly'; percent: number; resetsAt?: string }[] = [];
  if (typeof u?.session?.percent === 'number' && m.session >= limits.dispatcherStop) out.push({ name: '5-hour', percent: m.session, ...(m.sessionResetsAt ? { resetsAt: m.sessionResetsAt } : {}) });
  if (typeof u?.weekly?.percent === 'number' && m.weekly >= limits.dispatcherStop) out.push({ name: 'weekly', percent: m.weekly, ...(m.weeklyResetsAt ? { resetsAt: m.weeklyResetsAt } : {}) });
  return out;
}

/** The message a worker gets, once per crossing. */
export function stopMessage(o: { token: string; meters: string; line: number; owner?: string; requests: string[]; resets?: string; interruptAt: string }): string {
  const ids = o.requests.length ? o.requests.join(', ') : 'your request';
  const first = o.requests[0] ?? 'wNNN';
  return (
    `[token stop] The dispatcher's Claude token ${o.token}, which this session runs on, is at ${o.meters} (stop line ${o.line}%, vault.pool.dispatcherStopPercent; w1109). ` +
    'Stop at a safe point now, so the dispatcher, which starts every worker, does not run out:\n' +
    '1. Do not start anything long.\n' +
    '2. Commit your work in progress on your own branch (a WIP commit is fine) and push it. If the push is refused (a guard, a hook, a protected branch), keep the commit local and say so: never discard or stash work.\n' +
    `3. End your turn with a short report: where you stopped, the commit and whether it is pushed, what is left, and a line \`${first}: still open: stopped at the dispatcher token's stop line; resumes on a token with room\`.\n` +
    `Then ${ids} ${o.requests.length > 1 ? 'are' : 'is'} Blocked on that token's limit, and FF Factory resumes you by itself on another of ${o.owner ?? 'its person'}'s tokens with room, or after the reset${o.resets ? ` (${o.resets})` : ''}, with your history and worktree as they are. Do not set a wake_me for it. If you are still mid-turn at ${o.interruptAt} you are interrupted.`
  );
}

export class DispatcherStop {
  private crossing: StopCrossing | undefined;
  private readonly now: () => number;
  private readonly d: DispatcherStopDeps;

  constructor(d: DispatcherStopDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    if (d.file) {
      try {
        const c = JSON.parse(fs.readFileSync(d.file, 'utf8')) as { crossing?: StopCrossing };
        if (c.crossing?.key && c.crossing.asked) this.crossing = c.crossing;
      } catch {
        // No file yet, or unreadable: no crossing in progress.
      }
    }
  }

  /** The crossing in progress, if any (for system_status and tests). */
  get current(): Readonly<StopCrossing> | undefined {
    return this.crossing;
  }

  private save() {
    if (!this.d.file) return;
    try {
      writeJsonDurable(this.d.file, { crossing: this.crossing ?? null }, { indent: 1, generations: 0 });
    } catch (e) {
      this.d.log(`token stop: could not save ${this.d.file}: ${(e as Error).message}`);
    }
  }

  /** One look at the meters and the workers (every 30 seconds from server/index.ts). Returns what it did, one line each. */
  tick(): string[] {
    const did: string[] = [];
    const tok = this.d.token();
    const limits = this.d.limits();
    const over = tok ? stopMeters(this.d.usageOf(tok.key), limits) : [];
    if (!tok || !over.length) {
      if (this.crossing) {
        did.push(`token stop: ${this.crossing.name} is below the stop line again${tok && tok.key === this.crossing.key ? '' : ' (the dispatcher is on another token now)'}; the crossing since ${this.crossing.since} is over`);
        this.crossing = undefined;
        this.save();
      }
      for (const l of did) this.d.log(l);
      return did;
    }
    const nowMs = this.now();
    const meters = over.map((m) => `${m.name} ${Math.round(m.percent)}%`).join(', ');
    // Another token pinned meanwhile is another crossing: its workers have not been asked.
    if (this.crossing && this.crossing.key !== tok.key) this.crossing = undefined;
    if (!this.crossing) {
      this.crossing = { key: tok.key, name: tok.name, since: new Date(nowMs).toISOString(), meters, asked: {} };
      did.push(`token stop: the dispatcher's token ${tok.name} is at ${meters} (stop line ${limits.dispatcherStop}%): its workers are asked to stop`);
    }
    const c = this.crossing;
    const resets = over.map((m) => m.resetsAt).filter((x): x is string => !!x).sort().at(-1);
    const byId = new Map<string, SessionInfo>();
    for (const s of this.d.sessions()) byId.set(s.id, s);
    // Ask each worker mid-turn on the token, once per crossing.
    for (const s of byId.values()) {
      if (s.kind !== 'worker' || s.account !== tok.key || !live(s) || !MID_TURN.has(s.status) || c.asked[s.id]) continue;
      const requests = this.d.requestsOf(s.id);
      const interruptAt = `${new Date(nowMs + INTERRUPT_AFTER_MS).toISOString().slice(11, 16)}Z`;
      try {
        this.d.tell(s.id, stopMessage({ token: tok.name, meters, line: limits.dispatcherStop, ...(tok.owner ? { owner: tok.owner } : {}), requests, ...(resets ? { resets: clock(resets) } : {}), interruptAt }));
      } catch (e) {
        did.push(`token stop: could not ask worker ${s.id}: ${(e as Error).message}`);
        continue;
      }
      c.asked[s.id] = { at: new Date(nowMs).toISOString() };
      did.push(`token stop: asked worker ${s.id} (${requests.join(', ') || 'no request'}) to save its work and stop`);
    }
    // Follow the asked ones: blocked once their turn ends, interrupted when they are still mid-turn too long after.
    const gate = { ref: tok.name, what: `the dispatcher's token ${tok.name} at its stop line (${meters}); resumes on a token with room` };
    for (const [sid, a] of Object.entries(c.asked)) {
      if (a.endedAt) continue;
      const s = byId.get(sid);
      const mid = !!s && live(s) && MID_TURN.has(s.status);
      if (!mid) {
        a.endedAt = new Date(nowMs).toISOString();
        a.blocked = s ? this.d.block(sid, gate) : [];
        did.push(`token stop: worker ${sid} ${a.interruptedAt ? 'was interrupted' : 'ended its turn'}${a.blocked.length ? `; blocked ${a.blocked.join(', ')} on ${tok.name}'s limit` : ''}`);
        continue;
      }
      if (!a.interruptedAt && nowMs - Date.parse(a.at) >= INTERRUPT_AFTER_MS) {
        a.interruptedAt = new Date(nowMs).toISOString();
        did.push(`token stop: worker ${sid} is still mid-turn ${Math.round((nowMs - Date.parse(a.at)) / 60_000)} min after it was asked: interrupted (its work stays in its sandbox)`);
        void Promise.resolve()
          .then(() => this.d.interrupt(sid))
          .catch((e) => this.d.log(`token stop: could not interrupt worker ${sid}: ${(e as Error).message}`));
      }
    }
    if (did.length) this.save();
    for (const l of did) this.d.log(l);
    return did;
  }

  /** system_status's line while a crossing is in progress, or undefined. */
  statusLine(): string | undefined {
    const c = this.crossing;
    if (!c) return undefined;
    const asked = Object.entries(c.asked);
    const open = asked.filter(([, a]) => !a.endedAt).map(([sid]) => sid);
    return `Dispatcher token stop (w1109): ${c.name} reached the stop line at ${c.since.slice(0, 16).replace('T', ' ')} UTC (${c.meters}); ${asked.length} worker(s) asked to save and stop${open.length ? `, still working: ${open.join(', ')}` : ''}; no new worker starts on it until it resets`;
  }
}

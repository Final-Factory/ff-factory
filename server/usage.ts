import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.ts';
import type { PlanUsage, UsageMeter } from '../shared/types.ts';

/**
 * The user's Claude plan usage: the weekly limit, the 5-hour session limit and any per-model weekly limit,
 * as the claude.ai usage endpoint reports them (the data behind Claude Code's /usage). The Agent SDK
 * exposes it as an experimental control request on a live query; the tracker runs a short-lived CLI
 * process with no prompt (no model call, about a second) every few minutes and after rate-limit events.
 *
 * Credentials: the CLI only asks for usage (GET /api/oauth/usage) when its OAuth login carries the
 * `user:profile` scope. The agents' long-lived `claude setup-token` token never does: setup-token logs in
 * with inferenceOnly, which requests `user:inference` alone, and the CLI gives a CLAUDE_CODE_OAUTH_TOKEN
 * the scopes ["user:inference"] unless told otherwise. So this one read-only request runs WITHOUT the
 * agents' token: the CLI falls back to the interactive claude.ai login stored on this machine
 * (~/.claude/.credentials.json), which has user:profile, and refreshes it itself when it has expired.
 * Agents keep using their own token.
 */

/** The parts of the SDK's usage reply we read. Everything is optional: the API is marked experimental. */
export interface UsageReply {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null;
    seven_day?: { utilization: number | null; resets_at: string | null } | null;
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
    limits?:
      | {
          kind: string;
          group?: string;
          percent: number;
          resets_at: string | null;
          severity?: string;
          scope?: { model?: { display_name: string } | null; surface?: { display_name: string } | null } | null;
        }[]
      | null;
  } | null;
}

const meter = (label: string, percent: number | null | undefined, resetsAt: string | null | undefined, severity?: string): UsageMeter | undefined =>
  typeof percent === 'number' && Number.isFinite(percent) ? { label, percent: Math.max(0, Math.min(100, percent)), resetsAt: resetsAt ?? undefined, severity } : undefined;

/**
 * Turn the SDK reply into the meters the UI shows. Prefers the server's own rows (limits[], classified
 * by kind: 'session', 'weekly_all', 'weekly_scoped'), and falls back to the older named windows.
 */
export function parseUsage(r: UsageReply, asOf: string): PlanUsage {
  const rl = r.rate_limits;
  if (!r.rate_limits_available || !rl) {
    return { available: false, asOf, plan: r.subscription_type ?? undefined, models: [], why: `the Claude login used for usage reports no plan limits (an API key, or a token without the ${PROFILE_SCOPE} scope). ${LOGIN_ACTION}` };
  }
  let session: UsageMeter | undefined;
  let weekly: UsageMeter | undefined;
  const models: UsageMeter[] = [];
  for (const row of rl.limits ?? []) {
    if (row.kind === 'session') session ??= meter('Session (5 h)', row.percent, row.resets_at, row.severity);
    else if (row.kind === 'weekly_all') weekly ??= meter('Weekly', row.percent, row.resets_at, row.severity);
    else if (row.kind === 'weekly_scoped') {
      const name = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
      const m = name ? meter(`Weekly ${name}`, row.percent, row.resets_at, row.severity) : undefined;
      if (m) models.push(m);
    }
  }
  session ??= meter('Session (5 h)', rl.five_hour?.utilization, rl.five_hour?.resets_at);
  weekly ??= meter('Weekly', rl.seven_day?.utilization, rl.seven_day?.resets_at);
  if (!models.length) {
    for (const m of rl.model_scoped ?? []) {
      const x = meter(`Weekly ${m.display_name}`, m.utilization, m.resets_at);
      if (x) models.push(x);
    }
  }
  if (!weekly && !session) return { available: false, asOf, plan: r.subscription_type ?? undefined, models: [], why: 'the usage endpoint listed no limits' };
  return { available: true, asOf, plan: r.subscription_type ?? undefined, weekly, session, models };
}

/** "resets Sun 23:00" within a week, "resets in 3 h" within a day. */
export function describeReset(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '';
  const h = (t.getTime() - now.getTime()) / 3_600_000;
  if (h <= 0) return 'resets now';
  if (h < 1) return `resets in ${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `resets in ${Math.round(h)} h`;
  return `resets ${t.toLocaleDateString([], { weekday: 'short' })} ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** The lines the orchestrator's system_status tool adds. */
export function usageLines(u: PlanUsage | undefined, now: Date): string[] {
  if (!u) return ['Claude plan usage: not fetched yet'];
  const asOf = `as of ${new Date(u.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (!u.available) {
    const spend = u.spendWeekUsd !== undefined ? `; FF Factory's own agent spend in the last 7 days: $${u.spendWeekUsd.toFixed(2)} (spend, not the plan limit)` : '';
    return [`Claude plan usage: unavailable (${u.why ?? 'unknown'}), ${asOf}${spend}`];
  }
  const fmt = (m: UsageMeter) => `${m.label} ${Math.round(m.percent)}% used${m.resetsAt ? `, ${describeReset(m.resetsAt, now)}` : ''}`;
  return [`Claude plan (${u.plan ?? '?'}) usage, ${asOf}: ${[u.weekly, u.session, ...u.models].filter((m): m is UsageMeter => !!m).map(fmt).join('; ')}`];
}

// ---------------------------------------------------------------- our own spend ledger (the fallback)

/** Add a session's cost increase to today's bucket; keeps 8 days. Pure: returns the new ledger. */
export function addSpend(ledger: Record<string, number>, day: string, usd: number): Record<string, number> {
  if (!(usd > 0)) return ledger;
  const out = { ...ledger, [day]: (ledger[day] ?? 0) + usd };
  const keep = Object.keys(out).sort().slice(-8);
  return Object.fromEntries(keep.map((d) => [d, out[d]]));
}

/** Spend over the 7 days ending `today` (inclusive). */
export function weekSpend(ledger: Record<string, number>, today: string): number {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Object.entries(ledger).reduce((sum, [d, usd]) => {
    const age = (end - Date.parse(`${d}T00:00:00Z`)) / 86_400_000;
    return age >= 0 && age < 7 ? sum + usd : sum;
  }, 0);
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------------------------------------------------------- the credential the usage request uses

/** The single thing the user does when the stored login is missing, scope-less or expired. */
export const LOGIN_ACTION = 'Fix: on this machine, run `claude` in a terminal and type /login (claude.ai account).';

export const PROFILE_SCOPE = 'user:profile';

/**
 * Environment variables that would make the CLI use something other than the stored claude.ai login.
 * Removed for the usage request only; the agents' environment is untouched.
 */
export const AUTH_ENV = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SIMPLE',
];

/** The usage request's environment: the agents' environment without the credentials that would shadow the stored login. */
export function usageEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of AUTH_ENV) delete out[k];
  return out;
}

/** Where Claude Code keeps the interactive login on Windows and Linux (macOS keeps it in the Keychain). */
export function credentialsFile(env: Record<string, string | undefined>): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
}

/** The metadata we read from the stored login. Token values never leave readStoredLogin. */
export interface StoredLogin {
  present: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  scopes: string[];
  /** Epoch ms. */
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
}

/** Read the stored login's metadata. Never throws, and never lets the file's text reach an error message. */
export function readStoredLogin(file: string): StoredLogin {
  let o: Record<string, unknown> | undefined;
  try {
    o = (JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
  } catch {
    // Missing or unreadable. JSON.parse's message quotes the input, so it is dropped on purpose.
    return { present: false, hasAccessToken: false, hasRefreshToken: false, scopes: [] };
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    present: !!o,
    hasAccessToken: typeof o?.accessToken === 'string' && o.accessToken.length > 0,
    hasRefreshToken: typeof o?.refreshToken === 'string' && o.refreshToken.length > 0,
    scopes: Array.isArray(o?.scopes) ? o.scopes.filter((x): x is string => typeof x === 'string') : [],
    expiresAt: num(o?.expiresAt),
    refreshTokenExpiresAt: num(o?.refreshTokenExpiresAt),
  };
}

/**
 * Why the stored login cannot read plan usage, or undefined when it can. An expired access token is
 * fine while the refresh token lives: the CLI refreshes it (and writes it back) during the request.
 * `keychain`: the platform keeps the login outside the file (macOS), so a missing file proves nothing.
 */
export function loginProblem(l: StoredLogin, now: number, file: string, keychain = false): string | undefined {
  if (!l.present || !l.hasAccessToken) return keychain ? undefined : `no claude.ai login is stored on this machine (${file}). ${LOGIN_ACTION}`;
  if (!l.scopes.includes(PROFILE_SCOPE)) return `the stored claude.ai login lacks the ${PROFILE_SCOPE} scope (it has: ${l.scopes.join(' ') || 'none'}). ${LOGIN_ACTION}`;
  const accessLive = l.expiresAt === undefined || l.expiresAt > now;
  const refreshLive = l.hasRefreshToken && (l.refreshTokenExpiresAt === undefined || l.refreshTokenExpiresAt > now);
  if (!accessLive && !refreshLive) {
    const when = l.refreshTokenExpiresAt ?? l.expiresAt;
    return `the stored claude.ai login expired${when ? ` on ${new Date(when).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}. ${LOGIN_ACTION}`;
  }
  return undefined;
}

/** The stored login cannot be used: fall back to spend without starting the CLI. */
class LoginProblem extends Error {}

// ---------------------------------------------------------------- the tracker

const REFRESH_MS = 5 * 60_000;
const EVENT_DEBOUNCE_MS = 60_000;

export class UsageTracker {
  usage?: PlanUsage;
  private readonly cfg: Config;
  private readonly file: string;
  private readonly spendFile: string;
  private ledger: Record<string, number> = {};
  private readonly lastCost = new Map<string, number>();
  private inFlight = false;
  private lastFetch = 0;
  private soon?: NodeJS.Timeout;
  private readonly changed: (u: PlanUsage) => void;

  constructor(cfg: Config, changed: (u: PlanUsage) => void) {
    this.cfg = cfg;
    this.changed = changed;
    this.file = path.join(cfg.dataDir, 'usage.json');
    this.spendFile = path.join(cfg.dataDir, 'spend.json');
    try {
      this.usage = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PlanUsage;
    } catch {
      // first run
    }
    try {
      this.ledger = JSON.parse(fs.readFileSync(this.spendFile, 'utf8'));
    } catch {
      // first run
    }
  }

  start() {
    void this.refresh();
    setInterval(() => void this.refresh(), REFRESH_MS);
  }

  /** A session saw a rate-limit event: the numbers moved, fetch them again soon (at most once a minute). */
  poke() {
    if (this.soon) return;
    const wait = Math.max(5_000, EVENT_DEBOUNCE_MS - (Date.now() - this.lastFetch));
    this.soon = setTimeout(() => {
      this.soon = undefined;
      void this.refresh();
    }, wait);
  }

  /** A session's cumulative cost changed: record the increase (the fallback's "our own spend"). */
  recordCost(sessionId: string, costUsd: number) {
    const before = this.lastCost.get(sessionId);
    this.lastCost.set(sessionId, costUsd);
    if (before === undefined || costUsd <= before) return; // first sighting after a restart: no baseline
    this.ledger = addSpend(this.ledger, localDay(), costUsd - before);
    try {
      fs.writeFileSync(this.spendFile, JSON.stringify(this.ledger));
    } catch {
      // not fatal
    }
  }

  async refresh() {
    if (this.inFlight) return;
    this.inFlight = true;
    this.lastFetch = Date.now();
    const asOf = new Date().toISOString();
    let u: PlanUsage;
    const env = usageEnv({ ...process.env, ...this.cfg.claudeEnv });
    const file = credentialsFile(env);
    try {
      const problem = loginProblem(readStoredLogin(file), Date.now(), file, process.platform === 'darwin');
      if (problem) throw new LoginProblem(problem);
      u = parseUsage(await this.fetch(env), asOf);
    } catch (e) {
      if (e instanceof LoginProblem) {
        // A known, lasting cause: say it plainly instead of showing old numbers.
        u = { available: false, asOf, models: [], why: e.message };
      } else if (this.usage?.available) {
        // Keep showing the last good numbers, marked stale by their own asOf, rather than nothing.
        this.usage = { ...this.usage, error: (e as Error).message.slice(0, 200) };
        this.changed(this.usage);
        this.inFlight = false;
        return;
      } else {
        u = { available: false, asOf, models: [], why: `could not fetch plan usage: ${(e as Error).message.slice(0, 200)}` };
      }
    } finally {
      this.inFlight = false;
    }
    if (!u.available) u.spendWeekUsd = weekSpend(this.ledger, localDay());
    this.usage = u;
    try {
      fs.writeFileSync(this.file, JSON.stringify(u));
    } catch {
      // not fatal
    }
    this.changed(u);
  }

  /**
   * One promptless CLI process: it answers the get_usage control request without starting a turn. `env`
   * carries no agent token, so the CLI reads the stored login from disk afresh each time (picking up
   * refreshes by other Claude Code processes) and refreshes an expired access token itself.
   */
  private async fetch(env: Record<string, string | undefined>): Promise<UsageReply> {
    let release: (() => void) | undefined;
    const idle: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise((r) => (release = () => r({ value: undefined, done: true }))) }),
    };
    const abort = new AbortController();
    const q = query({
      prompt: idle,
      options: {
        cwd: this.cfg.dataDir,
        settingSources: [],
        persistSession: false,
        abortController: abort,
        env,
        ...(this.cfg.claudeExecutable ? { pathToClaudeCodeExecutable: this.cfg.claudeExecutable } : {}),
      },
    });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 60 s')), 60_000).unref());
    try {
      const get = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<UsageReply> })
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (!get) throw new Error('this Agent SDK has no usage request');
      return await Promise.race([get.call(q, { skipBehaviors: true }), timeout]);
    } finally {
      release?.();
      abort.abort();
    }
  }
}

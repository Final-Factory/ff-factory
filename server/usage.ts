import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.ts';
import type { AccountUsage, PlanUsage, SessionInfo, UsageMeter } from '../shared/types.ts';

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
 *
 * Every account in use (README, "Claude plan" meters): the agents' token is a separate account from that stored login
 * as far as anything here can tell, so it is polled too, but NOT through the CLI: given the token (and
 * CLAUDE_CODE_OAUTH_SCOPES naming user:profile) the CLI still answers get_usage with the stored login's
 * numbers. Measured 2026-09-27 on BEAST: a made-up token got the login's exact numbers back, and with the
 * login hidden (an empty CLAUDE_CONFIG_DIR) it got none. So a token is sent to the usage endpoint itself
 * (fetchTokenUsage), its only credential, and a failure there is "unknown", never another account's
 * numbers. Each Mac's own login is polled by its daemon and reported to the portal (protocol 4).
 * Accounts are told apart by the login's email (accountInfo) or the token's last 4 characters, never by
 * the credential.
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

/** One account's usage in words: "Claude plan (max) usage, as of 10:02: Weekly 33% used, resets ...". */
export function usageSummary(u: PlanUsage | undefined, now: Date): string {
  if (!u) return 'Claude plan usage: not fetched yet';
  const asOf = `as of ${new Date(u.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (!u.available) {
    const spend = u.spendWeekUsd !== undefined ? `; FF Factory's own agent spend in the last 7 days: $${u.spendWeekUsd.toFixed(2)} (spend, not the plan limit)` : '';
    return `Claude plan usage: unavailable (${u.why ?? 'unknown'}), ${asOf}${spend}`;
  }
  const fmt = (m: UsageMeter) => `${m.label} ${Math.round(m.percent)}% used${m.resetsAt ? `, ${describeReset(m.resetsAt, now)}` : ''}`;
  return `Claude plan${u.plan ? ` (${u.plan})` : ''} usage, ${asOf}${u.source ? `, from ${u.source}` : ''}: ${[u.weekly, u.session, ...u.models].filter((m): m is UsageMeter => !!m).map(fmt).join('; ')}`;
}

/**
 * The system_status lines for every account: which one, where it is used, who runs on it now, its usage.
 * `sessions` names the agents (by id) so the orchestrator can tell which worker is on which account.
 */
export function accountLines(accounts: AccountUsage[], sessions: Map<string, Pick<SessionInfo, 'id' | 'kind' | 'status'>>, now: Date): string[] {
  if (!accounts.length) return ['Claude accounts: none known yet'];
  return [
    `Claude accounts in use (${accounts.length}):`,
    ...accounts.map((a) => {
      const live = a.sessionIds.map((id) => sessions.get(id)).filter((s): s is Pick<SessionInfo, 'id' | 'kind' | 'status'> => !!s && s.status !== 'stopped' && s.status !== 'error');
      const who = live.length ? live.map((s) => (s.kind === 'orchestrator' ? 'the orchestrator' : s.id)).join(', ') : 'no agent right now';
      return `- ${a.label} [${a.where.join('; ')}; agents on it: ${who}]: ${usageSummary(a.usage, now)}`;
    }),
  ];
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

// ---------------------------------------------------------------- accounts

/** What accountInfo() says about a login, safe to show: no credential in it. A token reports none of it. */
export interface AccountIdentity {
  email?: string;
  organization?: string;
  plan?: string;
}

/** A token's account key: a hash prefix, so equal tokens are one account and the key reveals nothing. */
export const tokenKey = (token: string) => `token:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
export const tokenLabel = (token: string) => `host token …${token.slice(-4)}`;
/** This host's own login. Not "login:<id>": a machine may be called "host" (MACHINE_ID). */
export const HOST_LOGIN = 'host:login';
export const machineLogin = (machineId: string) => `login:${machineId}`;

/** The token the host's agents run on (claudeEnv over the server's own environment), if any. */
export function hostToken(cfg: Pick<Config, 'claudeEnv'>, env: Record<string, string | undefined> = process.env): string | undefined {
  return { ...env, ...cfg.claudeEnv }.CLAUDE_CODE_OAUTH_TOKEN || undefined;
}

/**
 * The token a machine's portal-run agents get: config claudeEnv only, and only when that machine takes it
 * (hostClaudeEnvFor, server/secrets.ts). A token in the server's own environment stays on this host.
 */
export function machineToken(cfg: Pick<Config, 'claudeEnv'>, takesHostEnv: boolean): string | undefined {
  return (takesHostEnv && cfg.claudeEnv?.CLAUDE_CODE_OAUTH_TOKEN) || undefined;
}

/**
 * Which credential a portal-run session uses, as an account source key: on this host its token (hostToken)
 * when there is one, on a machine the token it is sent (machineToken); else the login of the computer it
 * runs on. Follows the current config: an agent started before a token change keeps its old account until
 * its process restarts.
 */
export function sessionSource(info: Pick<SessionInfo, 'machineId'>, hostTok: string | undefined, machineTok: (machineId: string) => string | undefined): string {
  if (info.machineId) {
    const t = machineTok(info.machineId);
    return t ? tokenKey(t) : machineLogin(info.machineId);
  }
  return hostTok ? tokenKey(hostTok) : HOST_LOGIN;
}

/** One polled or reported credential. */
export interface UsageEntry {
  kind: 'token' | 'login';
  /** Tokens: "host token …abcd". */
  label?: string;
  account?: AccountIdentity;
  usage?: PlanUsage;
  /**
   * Tokens: these numbers came from a request carrying this token itself (fetchTokenUsage). A token entry
   * without it was saved before that fix, when the CLI answered with the stored login's numbers: dropped.
   */
  direct?: boolean;
}

export interface AccountContext {
  /** This host's name, for "BEAST login". */
  hostName: string;
  /** The current host token's key and label, when one is set. */
  token?: { key: string; label: string };
  /** Machines that exist; `usesToken`: their portal-run agents take the host token. */
  machines: { id: string; usesToken: boolean }[];
  /** Every session with its source key (sessionSource); `live`: running now (for the order). */
  sessions: { id: string; source: string; live?: boolean }[];
}

const newer = (a?: PlanUsage, b?: PlanUsage) => {
  if (!a) return b;
  if (!b) return a;
  if (a.available !== b.available) return a.available ? a : b;
  return a.asOf >= b.asOf ? a : b;
};

/**
 * The accounts in use, merged: one login signed in on several computers (same email) is one account;
 * a token is one account per token. Sources nobody polls (a machine login no daemon reported yet) still
 * appear when a session runs on them. Most agents running now first, then tokens (the agents' account), then by label. Pure.
 */
export function buildAccounts(entries: ReadonlyMap<string, UsageEntry>, ctx: AccountContext): AccountUsage[] {
  const machineIds = new Set(ctx.machines.map((m) => m.id));
  const sources = new Map<string, UsageEntry>();
  sources.set(HOST_LOGIN, entries.get(HOST_LOGIN) ?? { kind: 'login' });
  if (ctx.token) sources.set(ctx.token.key, { label: ctx.token.label, ...entries.get(ctx.token.key), kind: 'token' });
  for (const [key, e] of entries) {
    if (key.startsWith('login:') && key !== HOST_LOGIN && machineIds.has(key.slice(6))) sources.set(key, e);
  }
  for (const s of ctx.sessions) if (!sources.has(s.source) && s.source.startsWith('login:') && machineIds.has(s.source.slice(6))) sources.set(s.source, { kind: 'login' });

  const tokenUsers = [ctx.hostName, ...ctx.machines.filter((m) => m.usesToken).map((m) => m.id)];
  const out = new Map<string, AccountUsage>();
  for (const [key, e] of sources) {
    const email = e.kind === 'login' ? e.account?.email?.trim().toLowerCase() : undefined;
    const id = e.kind === 'token' ? key : email ? `email:${email}` : key;
    const where = e.kind === 'token' ? `the agents' token on ${tokenUsers.join(', ')}` : `${key === HOST_LOGIN ? ctx.hostName : key.slice(6)} login`;
    const a = out.get(id) ?? { id, kind: e.kind, label: e.kind === 'token' ? (e.label ?? 'a token') : (e.account?.email ?? where), email: e.account?.email, sources: [], where: [], sessionIds: [], usage: undefined };
    a.sources.push(key);
    a.where.push(where);
    a.usage = newer(a.usage, e.usage);
    out.set(id, a);
  }
  const byId = [...out.values()];
  const live = new Map<string, number>();
  for (const s of ctx.sessions) {
    const a = byId.find((x) => x.sources.includes(s.source));
    if (!a) continue;
    a.sessionIds.push(s.id);
    if (s.live) live.set(a.id, (live.get(a.id) ?? 0) + 1);
  }
  const busy = (a: AccountUsage) => live.get(a.id) ?? 0;
  return byId.sort((a, b) => busy(b) - busy(a) || (a.kind === b.kind ? 0 : a.kind === 'token' ? -1 : 1) || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------- fetching

/**
 * One promptless CLI process: it answers the account and get_usage control requests without starting a
 * turn. With no token in `env` the CLI reads the stored login afresh each time (picking up refreshes by
 * other Claude Code processes) and refreshes an expired access token itself. Used by the portal for its
 * own login and token, and by each machine daemon for its Mac's login.
 */
export async function fetchPlanUsage(
  env: Record<string, string | undefined>,
  opts: { cwd: string; claudeExecutable?: string },
): Promise<{ reply: UsageReply; account: AccountIdentity }> {
  let release: (() => void) | undefined;
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise((r) => (release = () => r({ value: undefined, done: true }))) }),
  };
  const abort = new AbortController();
  const q = query({
    prompt: idle,
    options: {
      cwd: opts.cwd,
      settingSources: [],
      persistSession: false,
      abortController: abort,
      env,
      ...(opts.claudeExecutable ? { pathToClaudeCodeExecutable: opts.claudeExecutable } : {}),
    },
  });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 60 s')), 60_000).unref());
  try {
    const get = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<UsageReply> })
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (!get) throw new Error('this Agent SDK has no usage request');
    // Who it is (a login only: a token reports no email), asked alongside with its own time limit: a
    // failure there costs the label, not the numbers.
    const who = Promise.race([q.accountInfo(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000).unref())]).catch(() => undefined);
    const [reply, info] = await Promise.all([Promise.race([get.call(q, { skipBehaviors: true }), timeout]), who]);
    return { reply, account: { email: info?.email || undefined, organization: info?.organization || undefined, plan: info?.subscriptionType || undefined } };
  } finally {
    release?.();
    abort.abort();
  }
}

/** The endpoint behind get_usage (Claude Code's /usage). It answers a setup-token too. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** A token's usage request that failed. `retryAfterMs`: how long the endpoint asked us to wait (HTTP 429). */
export class UsageFetchError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Keeps any credential out of a message that came from elsewhere. */
const scrub = (s: string) => s.replace(/sk-ant-[\w-]+/g, 'sk-ant-…');

/**
 * A token's plan usage, asked of the usage endpoint with that token as the only credential: no CLI, so
 * nothing can fall back to a login stored on this machine (top of this file). The reply has the same
 * shape as the SDK's rate_limits, so parseUsage reads it. Throws UsageFetchError, whose message never
 * holds the token.
 */
export async function fetchTokenUsage(token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): Promise<UsageReply> {
  let res: Response;
  try {
    res = await fetchImpl(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new UsageFetchError(`the usage endpoint could not be reached: ${scrub((e as Error).message).slice(0, 150)}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
    } catch {
      // no JSON body
    }
    const seconds = Number(res.headers.get('retry-after'));
    const retryAfterMs = res.status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : REFRESH_MS) : undefined;
    const what =
      res.status === 401 ? 'the token was rejected (expired or revoked?)'
      : res.status === 403 ? 'the token may not read usage'
      : retryAfterMs ? `the usage endpoint rate-limits this token, next try in ${Math.ceil(retryAfterMs / 60_000)} min`
      : 'the usage endpoint failed';
    throw new UsageFetchError(`${what} (HTTP ${res.status}${detail ? `: ${scrub(detail).slice(0, 150)}` : ''})`, retryAfterMs);
  }
  let body: UsageReply['rate_limits'];
  try {
    body = (await res.json()) as UsageReply['rate_limits'];
  } catch {
    throw new UsageFetchError('the usage endpoint answered with something other than JSON');
  }
  return { rate_limits_available: true, rate_limits: body };
}

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const LIMITS_SOURCE = 'rate-limit headers';

/**
 * A token's weekly and 5-hour utilization from the rate-limit headers the API sends with every reply
 * (anthropic-ratelimit-unified-7d-* / -5h-*), for when the usage endpoint rate-limits the token: it
 * does for long stretches when many agents run on it (measured 2026-09-27: HTTP 429 with a fresh
 * Retry-After of ~58 min each hour, while these headers answered). Costs one Haiku request with one
 * output token, made with that token alone. No per-model limits: the headers do not carry them.
 */
export async function fetchTokenLimits(token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): Promise<UsageReply> {
  let res: Response;
  try {
    res = await fetchImpl(MESSAGES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.text(); // the body is not needed; read it so the connection is released
  } catch (e) {
    throw new UsageFetchError(`the API could not be reached: ${scrub((e as Error).message).slice(0, 150)}`);
  }
  const num = (k: string) => {
    const v = res.headers.get(`anthropic-ratelimit-unified-${k}`);
    return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  const window = (k: '5h' | '7d') => {
    const used = num(`${k}-utilization`);
    const reset = num(`${k}-reset`);
    return used === undefined ? null : { utilization: used * 100, resets_at: reset === undefined ? null : new Date(reset * 1000).toISOString() };
  };
  const five_hour = window('5h');
  const seven_day = window('7d');
  if (!five_hour && !seven_day) throw new UsageFetchError(`the API's reply had no rate-limit headers for this token (HTTP ${res.status})`);
  return { rate_limits_available: true, rate_limits: { five_hour, seven_day } };
}

/** The stored login cannot be used: fall back to spend without starting the CLI. */
class LoginProblem extends Error {}

/** "Weekly 41%, Session (5 h) 33%" for the poll log. */
const brief = (u: PlanUsage) =>
  u.available
    ? [u.weekly, u.session, ...u.models].filter((m): m is UsageMeter => !!m).map((m) => `${m.label} ${Math.round(m.percent)}%`).join(', ')
    : `no numbers: ${u.why ?? 'unknown'}`;

// ---------------------------------------------------------------- the tracker

const REFRESH_MS = 5 * 60_000;
const EVENT_DEBOUNCE_MS = 60_000;

/** What usage.json holds; a file from before per-account usage is one PlanUsage (this host's login). */
interface UsageFile {
  entries: Record<string, UsageEntry>;
}

/** How the tracker reaches the network and its log; tests pass fakes. */
export interface UsageDeps {
  /** This host's stored login, through the CLI (fetchPlanUsage). */
  fetchLogin?: (env: Record<string, string | undefined>) => Promise<{ reply: UsageReply; account: AccountIdentity }>;
  /** A token, straight to the endpoint (fetchTokenUsage). */
  fetchToken?: (token: string) => Promise<UsageReply>;
  /** A token's weekly and session numbers from the API's rate-limit headers (fetchTokenLimits), while the endpoint rate-limits it. */
  fetchTokenLimits?: (token: string) => Promise<UsageReply>;
  /** One line per poll: which credential, whether it answered. Never a credential. */
  log?: (line: string) => void;
}

/**
 * Polls this host's login and its token (when set) every few minutes and after rate-limit events, and
 * keeps what the machine daemons report for their Macs' logins. `usage` is this host's login, as before.
 */
export class UsageTracker {
  private readonly cfg: Config;
  private readonly file: string;
  private readonly spendFile: string;
  private ledger: Record<string, number> = {};
  private readonly lastCost = new Map<string, number>();
  readonly entries = new Map<string, UsageEntry>();
  private inFlight = false;
  private lastFetch = 0;
  private soon?: NodeJS.Timeout;
  private readonly changed: () => void;
  private readonly fetchLogin: NonNullable<UsageDeps['fetchLogin']>;
  private readonly fetchToken: NonNullable<UsageDeps['fetchToken']>;
  private readonly fetchTokenLimits: NonNullable<UsageDeps['fetchTokenLimits']>;
  private readonly log: NonNullable<UsageDeps['log']>;
  /** Per token key: no request before this time (epoch ms), the endpoint's Retry-After. */
  private readonly retryAt = new Map<string, number>();

  constructor(cfg: Config, changed: () => void, deps: UsageDeps = {}) {
    this.cfg = cfg;
    this.changed = changed;
    this.fetchLogin = deps.fetchLogin ?? ((env) => fetchPlanUsage(env, { cwd: this.cfg.dataDir, claudeExecutable: this.cfg.claudeExecutable }));
    this.fetchToken = deps.fetchToken ?? ((token) => fetchTokenUsage(token));
    this.fetchTokenLimits = deps.fetchTokenLimits ?? ((token) => fetchTokenLimits(token));
    this.log = deps.log ?? ((line) => console.log(line));
    this.file = path.join(cfg.dataDir, 'usage.json');
    this.spendFile = path.join(cfg.dataDir, 'spend.json');
    try {
      const f = JSON.parse(fs.readFileSync(this.file, 'utf8')) as UsageFile | PlanUsage;
      if ('entries' in f) {
        // A token's numbers saved before it was asked directly were the stored login's: never show them.
        for (const [k, e] of Object.entries(f.entries)) if (e.kind !== 'token' || e.direct) this.entries.set(k, e);
      } else this.entries.set(HOST_LOGIN, { kind: 'login', usage: f });
    } catch {
      // first run
    }
    try {
      this.ledger = JSON.parse(fs.readFileSync(this.spendFile, 'utf8'));
    } catch {
      // first run
    }
  }

  /** This host's own claude.ai login's usage (the single meter before per-account usage). */
  get usage(): PlanUsage | undefined {
    return this.entries.get(HOST_LOGIN)?.usage;
  }

  /** The token the last refresh polled, to notice a new one (set_app_config) before the next poll. */
  private tokenSeen?: string;

  start() {
    void this.refresh();
    setInterval(() => void this.refresh(), REFRESH_MS);
    setInterval(() => {
      const t = hostToken(this.cfg);
      if ((t ? tokenKey(t) : undefined) !== this.tokenSeen) this.poke();
    }, 10_000).unref();
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

  /** A machine daemon reported its Mac's own login (protocol 4). */
  report(machineId: string, account: AccountIdentity, usage: PlanUsage) {
    const key = machineLogin(machineId);
    const prev = this.entries.get(key);
    // As for this host: a failed fetch keeps the last good numbers (stale by their asOf) and who it was.
    const failed = !usage.available && /^could not fetch/.test(usage.why ?? '');
    const kept = failed && prev?.usage?.available ? { ...prev.usage, error: usage.why?.slice(0, 200) } : usage;
    this.entries.set(key, { kind: 'login', account: account.email ? account : prev?.account, usage: kept });
    this.save();
    this.changed();
  }

  /** A machine was removed: forget its login. */
  forget(machineId: string) {
    if (this.entries.delete(machineLogin(machineId))) {
      this.save();
      this.changed();
    }
  }

  async refresh() {
    if (this.inFlight) return;
    this.inFlight = true;
    this.lastFetch = Date.now();
    try {
      const base = { ...process.env, ...this.cfg.claudeEnv };
      const token = hostToken(this.cfg);
      // A replaced token's numbers are no longer anyone's.
      for (const k of [...this.entries.keys()]) if (k.startsWith('token:') && (!token || k !== tokenKey(token))) this.entries.delete(k);
      this.tokenSeen = token ? tokenKey(token) : undefined;
      await Promise.all([this.refreshLogin(usageEnv(base)), token ? this.refreshToken(token) : undefined]);
      this.save();
    } finally {
      this.inFlight = false;
    }
    this.changed();
  }

  /** This host's stored claude.ai login, through the CLI with no token in its environment. */
  private async refreshLogin(env: Record<string, string | undefined>) {
    const asOf = new Date().toISOString();
    const prev = this.entries.get(HOST_LOGIN);
    const file = credentialsFile(env);
    const said = (u: PlanUsage, account?: AccountIdentity) =>
      this.log(`usage: ${os.hostname()} login (the claude.ai login stored in ${file}${account?.email ? `, ${account.email}` : ''}): ${u.available ? 'ok' : 'failed'}, ${brief(u)}`);
    let u: PlanUsage;
    let account = prev?.account;
    try {
      const problem = loginProblem(readStoredLogin(file), Date.now(), file, process.platform === 'darwin');
      if (problem) throw new LoginProblem(problem);
      const r = await this.fetchLogin(env);
      u = parseUsage(r.reply, asOf);
      if (r.account.email || r.account.plan) account = r.account;
    } catch (e) {
      if (e instanceof LoginProblem) {
        // A known, lasting cause: say it plainly instead of showing old numbers.
        u = { available: false, asOf, models: [], why: e.message };
      } else if (prev?.usage?.available) {
        // Keep showing this login's last good numbers, marked stale by their own asOf, rather than nothing.
        const kept = { ...prev.usage, error: scrub((e as Error).message).slice(0, 200) };
        this.entries.set(HOST_LOGIN, { ...prev, usage: kept });
        this.log(`usage: ${os.hostname()} login: failed (${kept.error}), keeping its numbers from ${prev.usage.asOf}`);
        return;
      } else {
        u = { available: false, asOf, models: [], why: `could not fetch plan usage: ${scrub((e as Error).message).slice(0, 200)}` };
      }
    }
    if (!u.available) u.spendWeekUsd = weekSpend(this.ledger, localDay());
    this.entries.set(HOST_LOGIN, { kind: 'login', account, usage: u });
    said(u, account);
  }

  /**
   * The agents' token, asked with that token alone (fetchTokenUsage). A failure is "unknown" with its
   * reason: no older numbers are kept, so nothing another credential answered can ever show here.
   */
  private async refreshToken(token: string) {
    const key = tokenKey(token);
    const label = tokenLabel(token);
    const asOf = new Date().toISOString();
    const reason = (e: unknown) => scrub((e as Error).message).slice(0, 200);
    // The usage endpoint's answer, or why it rate-limits this token (now, or still within its Retry-After).
    const endpoint = async (): Promise<PlanUsage | { limited: string }> => {
      const wait = this.retryAt.get(key);
      if (wait && wait > Date.now()) return { limited: `the usage endpoint rate-limits this token until ${new Date(wait).toISOString()}` };
      this.retryAt.delete(key);
      try {
        const u = parseUsage(await this.fetchToken(token), asOf);
        if (!u.available) u.why = `the usage endpoint gave no plan limits for this token (${u.why ?? 'unknown'})`;
        return u;
      } catch (e) {
        const after = e instanceof UsageFetchError ? e.retryAfterMs : undefined;
        if (!after) return { available: false, asOf, models: [], why: `usage unknown: ${reason(e)}` };
        this.retryAt.set(key, Date.now() + after);
        return { limited: reason(e) };
      }
    };
    const first = await endpoint();
    let u: PlanUsage;
    let via = 'the usage endpoint';
    if ('limited' in first) {
      // The same token's rate-limit headers stand in: weekly and session, no per-model limits.
      via = `the API's ${LIMITS_SOURCE} (${first.limited})`;
      try {
        u = { ...parseUsage(await this.fetchTokenLimits(token), asOf), source: LIMITS_SOURCE };
      } catch (e) {
        u = { available: false, asOf, models: [], why: `usage unknown: ${first.limited}; ${reason(e)}` };
      }
    } else u = first;
    if (!u.available) u.spendWeekUsd = weekSpend(this.ledger, localDay());
    this.entries.set(key, { kind: 'token', label, usage: u, direct: true });
    this.log(`usage: ${label} (${key}, asked with that token itself, via ${via}): ${u.available ? 'ok' : 'failed'}, ${brief(u)}`);
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ entries: Object.fromEntries(this.entries) } satisfies UsageFile));
    } catch {
      // not fatal
    }
  }
}

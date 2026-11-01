import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { HOST_ROLES, roleNames, type Config, type HostRole } from './config.ts';
import { noSessionLimit, type AccountUsage, type PlanUsage, type SessionInfo, type SessionKind, type UsageMeter } from '../shared/types.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import { dryRun } from './dryRun.ts';

/**
 * The user's Claude plan usage: the weekly limit, the 5-hour session limit and any per-model weekly limit,
 * as the claude.ai usage endpoint reports them (the data behind Claude Code's /usage). The Agent SDK
 * exposes it as an experimental control request on a live query; the tracker runs a short-lived CLI
 * process with no prompt (no model call, about a second) at startup and every config usagePollMinutes (default 15).
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
  const meters = [u.weekly, u.session, ...u.models].filter((m): m is UsageMeter => !!m).map(fmt);
  if (noSessionLimit(u)) meters.splice(1, 0, 'no 5-hour limit');
  return `Claude plan${u.plan ? ` (${u.plan})` : ''} usage, ${asOf}${u.source ? `, from ${u.source}` : ''}: ${meters.join('; ')}`;
}

/**
 * The system_status lines for every account: which one, where it is used, who runs on it now, its usage.
 * `sessions` names the agents (by id) so the orchestrator can tell which worker is on which account.
 */
type AccountSession = Pick<SessionInfo, 'id' | 'kind' | 'status'> & Partial<Pick<SessionInfo, 'title' | 'orchestratorRole'>>;

/** An agent as the account lines name it: the dispatcher, "Lothsahn's orchestrator", or a session id. */
const agentName = (s: AccountSession) => (s.kind !== 'orchestrator' ? s.id : s.orchestratorRole === 'personal' && s.title ? `${s.title}'s orchestrator` : s.orchestratorRole === 'dispatcher' ? 'the dispatcher' : 'the orchestrator');

export function accountLines(accounts: AccountUsage[], sessions: Map<string, AccountSession>, now: Date): string[] {
  if (!accounts.length) return ['Claude accounts: none known yet'];
  return [
    `Claude accounts in use (${accounts.length}):`,
    ...accounts.map((a) => {
      const live = a.sessionIds.map((id) => sessions.get(id)).filter((s): s is AccountSession => !!s && s.status !== 'stopped' && s.status !== 'error');
      const who = live.length ? live.map(agentName).join(', ') : 'no agent right now';
      return `- ${a.label} [${[...a.where, `agents on it: ${who}`].join('; ')}]: ${usageSummary(a.usage, now)}`;
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

/**
 * The usage request's environment: the agents' environment without the credentials that would shadow the stored
 * login. Also what an agent set to run on the stored login starts with (server/secrets.ts, docs/accounts.md).
 */
export function usageEnv<E extends Record<string, string | undefined>>(env: E): E {
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
  if (l.present && l.hasAccessToken && !l.scopes.includes(PROFILE_SCOPE)) return `the stored claude.ai login lacks the ${PROFILE_SCOPE} scope (it has: ${l.scopes.join(' ') || 'none'}). ${LOGIN_ACTION}`;
  return loginUnusable(l, now, file, keychain);
}

/**
 * Why the stored login cannot run an agent at all (none stored, or expired past refreshing), or undefined. An
 * agent needs no user:profile scope, so a login without it is still usable here (config claudeAccounts).
 */
export function loginUnusable(l: StoredLogin, now: number, file: string, keychain = false): string | undefined {
  if (!l.present || !l.hasAccessToken) return keychain ? undefined : `no claude.ai login is stored on this machine (${file}). ${LOGIN_ACTION}`;
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
/** This host's own login: no agent runs on it since w1078 (every Claude process is on a vault token); kept to read old records. */
export const HOST_LOGIN = 'host:login';
export const machineLogin = (machineId: string) => `login:${machineId}`;

/**
 * The account source key of a process started with `env`: its token, or else the login stored on the computer
 * it runs on (HOST_LOGIN; the portal reads a Mac's as that Mac's login, machineLogin). Recorded as
 * SessionInfo.account when the process starts (server/sessions.ts).
 */
export function accountKeyOf(env: Record<string, string | undefined>): string {
  const t = env.CLAUDE_CODE_OAUTH_TOKEN;
  return t ? tokenKey(t) : HOST_LOGIN;
}

/**
 * Which credential a portal-run session uses, as an account source key: the one its process started on
 * (SessionInfo.account), running or not. Every process starts on a vault token (w1078); one that never started has none.
 */
export function sessionSource(info: Partial<Pick<SessionInfo, 'account'>>): string {
  return info.account ?? '';
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
  /** Before w1078: the host token's key and label. Nothing sets it now. */
  token?: { key: string; label: string };
  /** Machines that exist; `usesToken`: their portal-run agents take the host token (before w1078); `onVault`: their runs take a vault token (always, since w1078). */
  machines: { id: string; usesToken: boolean; onVault?: boolean }[];
  /**
   * What the config sets to use each credential (w748): an account nothing is set to use, and no agent runs on now, is not
   * listed (a Mac's login once its machine is on the vault shows again when it leaves). Absent: every account is listed.
   */
  inUse?: { hostLogin: boolean; hostToken: boolean; vault: boolean };
  /** This host's roles config claudeAccounts sets to its stored login (docs/accounts.md); the others take the token. */
  hostLoginRoles?: HostRole[];
  /** The roles to name apart (secrets.ts shownRoles): the dispatcher only when it has an account of its own. Default: all but the dispatcher. */
  roles?: HostRole[];
  /** Before w1078: the token file's key and label, and the roles on it. Nothing sets it now. */
  tokenFile?: { key: string; label: string; roles: HostRole[] };
  /** Before w1078: people's own tokens (config userClaudeEnv). Nothing sets it now. */
  people?: { key: string; label: string; displayName: string }[];
  /** The token vault's Claude tokens (docs/vault.md, w512): key, label ("ben-max …abcd") and the account email a person recorded for it, if any (w785). Their grants are not shown (w748). */
  vault?: { key: string; label: string; email?: string }[];
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
  // Every vault token is listed under its vault name (w777), even when it is also the host token, the token file or a person's
  // own token: one account, one usage, named by the vault entry, the other roles noted on it (`alsoOn`).
  const vaultByKey = new Map((ctx.vault ?? []).map((v) => [v.key, v]));
  if (ctx.token && !vaultByKey.has(ctx.token.key)) sources.set(ctx.token.key, { label: ctx.token.label, ...entries.get(ctx.token.key), kind: 'token' });
  const whose = new Map<string, string>();
  // The token file's token (w464): its own account, named by the roles on it; the same token as the host's is one account.
  const fileRoles = ctx.tokenFile?.roles ?? [];
  if (ctx.tokenFile && !sources.has(ctx.tokenFile.key) && !vaultByKey.has(ctx.tokenFile.key)) sources.set(ctx.tokenFile.key, { label: ctx.tokenFile.label, ...entries.get(ctx.tokenFile.key), kind: 'token' });
  for (const p of ctx.people ?? []) {
    if (sources.has(p.key) || vaultByKey.has(p.key)) continue; // the same token as the host's or a vault entry's: one account
    sources.set(p.key, { label: p.label, ...entries.get(p.key), kind: 'token' });
    whose.set(p.key, p.displayName);
  }
  const vaultKeys = new Set<string>();
  for (const v of ctx.vault ?? []) {
    // The tracker keeps one entry per token and names it by the first holder (a person's, the token file's); the vault name wins here.
    sources.set(v.key, { ...entries.get(v.key), label: v.label, kind: 'token' });
    vaultKeys.add(v.key);
  }
  for (const [key, e] of entries) {
    if (key.startsWith('login:') && key !== HOST_LOGIN && machineIds.has(key.slice(6))) sources.set(key, e);
  }
  for (const s of ctx.sessions) if (!sources.has(s.source) && s.source.startsWith('login:') && machineIds.has(s.source.slice(6))) sources.set(s.source, { kind: 'login' });

  // Which of this host's agents are on the token and which on its login, named only when they are split.
  const roles = ctx.roles ?? HOST_ROLES.filter((r) => r !== 'dispatcher');
  const onLogin = roles.filter((r) => ctx.hostLoginRoles?.includes(r));
  const onToken = roles.filter((r) => !onLogin.includes(r) && !fileRoles.includes(r));
  // Named when not every role is on the token: some on the login, or on the token file.
  const split = (onLogin.length > 0 || roles.some((r) => fileRoles.includes(r))) && onToken.length > 0;
  const hostOnToken = onToken.length ? [split ? `${ctx.hostName} (${roleNames(onToken)})` : ctx.hostName] : [];
  const hostLoginWhere = `${ctx.hostName} login${ctx.token && onLogin.length ? ` (${roleNames(onLogin)})` : ''}`;
  const tokenUsers = [...hostOnToken, ...ctx.machines.filter((m) => m.usesToken).map((m) => m.id)];
  // An account nothing is set to use and no agent runs on now is left out (w748).
  const running = new Set(ctx.sessions.filter((x) => x.live).map((x) => x.source));
  // What else a vault token is, for its subtext line like a Mac login's "m3 login" (w777): the host token, the token file, a person's own token.
  const alsoOn = (key: string): string[] => [
    ...(key === ctx.token?.key ? [tokenUsers.length ? `the agents' token on ${tokenUsers.join(', ')}` : 'the host token (no agent set to it)'] : []),
    ...(key === ctx.tokenFile?.key ? [`${ctx.hostName}'s token file${fileRoles.length ? ` (${roleNames(fileRoles)})` : ''}`] : []),
    ...(ctx.people ?? []).filter((p) => p.key === key).map((p) => `agents working for ${p.displayName}`),
  ];
  const unused = (key: string): boolean => {
    const use = ctx.inUse;
    if (!use || running.has(key)) return false;
    if (key === HOST_LOGIN) return !use.hostLogin;
    // A token with several roles is unused only when every one of them is: a vault token that is also the token file or a person's own stays.
    if (vaultKeys.has(key) || key === ctx.token?.key) {
      if (key === ctx.tokenFile?.key || (ctx.people ?? []).some((p) => p.key === key)) return false;
      return (key !== ctx.token?.key || !use.hostToken) && (!vaultKeys.has(key) || !use.vault);
    }
    if (key.startsWith('login:')) {
      const m = ctx.machines.find((x) => x.id === key.slice(6));
      return !!m && (!!m.onVault || m.usesToken);
    }
    return false;
  };
  const out = new Map<string, AccountUsage>();
  for (const [key, e] of sources) {
    if (unused(key)) continue;
    const email = e.kind === 'login' ? e.account?.email?.trim().toLowerCase() : undefined;
    const id = e.kind === 'token' ? key : email ? `email:${email}` : key;
    const person = whose.get(key);
    const where = person
      ? `agents working for ${person}`
      : vaultKeys.has(key)
        ? ''
      : ctx.tokenFile?.key === key && key !== ctx.token?.key
        ? `${ctx.hostName}'s token file (${roleNames(fileRoles)})`
      : e.kind === 'token'
        ? tokenUsers.length ? `the agents' token on ${tokenUsers.join(', ')}` : "the agents' token (no agent set to it)"
        : key === HOST_LOGIN ? hostLoginWhere : `${key.slice(6)} login`;
    const a = out.get(id) ?? { id, kind: e.kind, label: e.kind === 'token' ? (e.label ?? 'a token') : (e.account?.email ?? where), email: e.account?.email, ...(vaultByKey.get(key)?.email ? { vaultEmail: vaultByKey.get(key)!.email } : {}), sources: [], where: [], sessionIds: [], usage: undefined };
    a.sources.push(key);
    if (where) a.where.push(where);
    // A vault token's subtext, like a Mac login's "m3 login": the account email a person recorded (w785, never read from the token), then the other uses of the token.
    if (vaultKeys.has(key)) {
      const email = vaultByKey.get(key)?.email;
      if (email) a.where.push(email);
      a.where.push(...alsoOn(key));
    }
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
  /** The HTTP status of the failed request, when there was a reply (403: the token lacks user:profile). */
  readonly status?: number;
  constructor(message: string, retryAfterMs?: number, status?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/** Keeps any credential out of a message that came from elsewhere. */
const scrub = (s: string) => s.replace(/sk-ant-[\w-]+/g, 'sk-ant-…');

/** How long a 429 without a Retry-After keeps the tracker off the endpoint for that token. */
const RETRY_DEFAULT_MS = 5 * 60_000;

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
    const retryAfterMs = res.status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RETRY_DEFAULT_MS) : undefined;
    const what =
      res.status === 401 ? 'the token was rejected (expired or revoked?)'
      : res.status === 403 ? 'the token may not read usage'
      : retryAfterMs ? `the usage endpoint rate-limits this token, next try in ${Math.ceil(retryAfterMs / 60_000)} min`
      : 'the usage endpoint failed';
    throw new UsageFetchError(`${what} (HTTP ${res.status}${detail ? `: ${scrub(detail).slice(0, 150)}` : ''})`, retryAfterMs, res.status);
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
export const LIMITS_SOURCE = 'rate limits';

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
    ? [...[u.weekly, u.session, ...u.models].filter((m): m is UsageMeter => !!m).map((m) => `${m.label} ${Math.round(m.percent)}%`), ...(noSessionLimit(u) ? ['no 5-hour limit'] : [])].join(', ')
    : `no numbers: ${u.why ?? 'unknown'}`;

// ---------------------------------------------------------------- the tracker

/**
 * The longest the tracker waits for any one request (the login's CLI, the token's endpoint, its headers),
 * whatever the request's own timeout says. A token asks at most two, so a poll settles well within
 * STUCK_MS, and every credential has numbers or a reason by the next one.
 */
const ANSWER_MS = 75_000;
/** A poll still marked running after this long is taken as stuck: the next one goes ahead (it cannot happen while ANSWER_MS holds). */
const STUCK_MS = 5 * 60_000;
/** A token the endpoint refused for its scope is asked again after this long (a re-issued token may carry it). */
const NO_SCOPE_RETRY_MS = 6 * 3_600_000;
/** A token near a pool limit is polled alone this often, between the regular polls (w739): 5-hour at 60% or weekly at 90%. */
export const NEAR_POLL_MS = 2 * 60_000;
export const NEAR_SESSION_PERCENT = 60;
export const NEAR_WEEKLY_PERCENT = 90;
/** A new token (set_app_config) is polled this soon, and a manual refresh no sooner than this after the last poll. */
const SOON_MS = 5_000;

/**
 * How old a reading may be and still be used as it was read (w1041). Past it, a window that has not reset counts as at
 * least 50% (the same assumption as a token never read), because a window's counter only goes up until its reset: the old
 * number is a floor, never a ceiling. Six hours: longer than the 60 minutes the usage endpoint's Retry-After asks for
 * (measured 2026-10-11, 14:30 local: "next try in 60 min") and than several poll intervals (15 min), and longer than one
 * 5-hour window, so a 5-hour reading never outlives its window by much. It is short enough that the weekly counter cannot
 * have moved far: vault-lothsahn-1 read weekly 6% at 13:29 local and 8% at 14:32 the same day (+2% in an hour, measured
 * in the portal journal), so six hours of the same pace is about +12 points, far from the 80/95/99 limits. A guess for a
 * heavier pace; a window that resets in between is zero anyway.
 */
export const STALE_READING_MS = 6 * 3_600_000;
const WEEK_MS = 7 * 86_400_000;

/**
 * A reading as the scheduler and system_status may use it at `now` (w1041). Unavailable readings come back as they are.
 * A window whose reset time has passed counts as 0% (the weekly window rolls forward by whole weeks, the 5-hour one has no
 * known next reset). With `held` (this portal has not read the credential successfully since it started, or its last poll
 * failed) the result carries `reading`, and one older than STALE_READING_MS counts every window not yet reset as at least 50%.
 */
export function effectiveUsage(u: PlanUsage | undefined, now: number, held = false): PlanUsage | undefined {
  if (!u?.available) return u;
  const asOf = Date.parse(u.asOf);
  const age = Number.isFinite(asOf) ? Math.max(0, now - asOf) : Infinity;
  const stale = held && age > STALE_READING_MS;
  const aged = (m: UsageMeter | undefined, weekly: boolean): UsageMeter | undefined => {
    if (!m) return m;
    const reset = m.resetsAt ? Date.parse(m.resetsAt) : NaN;
    if (Number.isFinite(reset) && reset <= now) {
      const next = weekly ? new Date(reset + Math.ceil((now - reset + 1) / WEEK_MS) * WEEK_MS).toISOString() : undefined;
      const { resetsAt: _gone, ...rest } = m;
      return { ...rest, percent: 0, ...(next ? { resetsAt: next } : {}) };
    }
    return stale && m.percent < 50 ? { ...m, percent: 50 } : m;
  };
  const out: PlanUsage = { ...u, weekly: aged(u.weekly, true), session: aged(u.session, false), models: u.models.map((m) => aged(m, true)!) };
  if (!held) return out;
  const mins = Math.round(age / 60_000);
  const how = Number.isFinite(age) ? (mins < 1 ? 'under a minute' : mins < 90 ? `${mins} min` : age < 48 * 3_600_000 ? `${Math.round(age / 3_600_000)} h` : `${Math.round(age / 86_400_000)} days`) : 'an unknown time';
  const why = `read ${how} ago${u.error ? `; the latest poll failed (${u.error.slice(0, 120)})` : '; not read since this portal started'}${stale ? `; older than ${STALE_READING_MS / 3_600_000} h, so a window not yet reset counts as at least 50%` : ''}`;
  return { ...out, reading: { kind: stale ? 'stale' : 'persisted', asOf: u.asOf, ageMs: Number.isFinite(age) ? age : 0, why } };
}

/** What usage.json holds; a file from before per-account usage is one PlanUsage (this host's login). */
interface UsageFile {
  entries: Record<string, UsageEntry>;
  /** When the usage endpoint last refused a token, so a restart does not ask again at once (w1041): by token key (a hash prefix), epoch ms. */
  holds?: Record<string, { noScopeAt?: number; retryAt?: number }>;
  /** Tokens Claude refused (w1745), by token key: which window, until when, why. */
  outs?: Record<string, TokenOutMark>;
}

/**
 * A vault token Claude refused (w1745, docs/vault.md "When a token runs out"): a session on it got a rejected rate-limit answer
 * or ended its turn on Claude's usage-limit line. That window counts as 100% (used up) until `until`, whatever a poll reads
 * meanwhile, so no agent is handed it again, and none is moved back onto it, before its reset.
 */
export interface TokenOutMark {
  field: 'session' | 'weekly';
  /** Epoch ms: the window's reset. */
  until: number;
  /** Epoch ms: when it was refused. */
  at: number;
  why: string;
}

/** A reading with an out mark applied (w1745): the refused window at 100% at least, resetting when the mark ends. */
export function withOut(u: PlanUsage | undefined, o: TokenOutMark | undefined, now: number): PlanUsage | undefined {
  if (!o || o.until <= now) return u;
  const base: PlanUsage = u?.available ? u : { available: true, asOf: new Date(o.at).toISOString(), models: [] };
  const was = base[o.field];
  const meter: UsageMeter = { ...(was ?? { label: o.field === 'weekly' ? 'Weekly' : 'Session (5 h)' }), percent: Math.max(100, was?.percent ?? 0), resetsAt: new Date(o.until).toISOString() };
  return { ...base, [o.field]: meter };
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
  /** Tests: the per-request deadline (ANSWER_MS). */
  answerMs?: number;
}

/**
 * Polls the vault's Claude tokens (w1078: every Claude process runs on one) once at startup, then every config
 * usagePollMinutes (default 15), and keeps what the machine daemons report for their Macs' logins. A manual
 * refresh polls at once; system_status polls only when the numbers are older than the interval. Rate-limit
 * events no longer poll: the endpoint rate-limits, and one poll per interval is enough. This host's own login is not
 * polled any more: nothing runs on it.
 */
export class UsageTracker {
  private readonly cfg: Config;
  private readonly file: string;
  private readonly spendFile: string;
  private ledger: Record<string, number> = {};
  private readonly lastCost = new Map<string, number>();
  readonly entries = new Map<string, UsageEntry>();
  /** When the running poll started (0: none), and which poll it is, so a stale one cannot clear a newer one's mark. */
  private inFlightSince = 0;
  private pollId = 0;
  private lastFetch = 0;
  private soon?: NodeJS.Timeout;
  private next?: NodeJS.Timeout;
  private started = false;
  private readonly changed: () => void;
  private readonly fetchLogin: NonNullable<UsageDeps['fetchLogin']>;
  private readonly fetchToken: NonNullable<UsageDeps['fetchToken']>;
  private readonly fetchTokenLimits: NonNullable<UsageDeps['fetchTokenLimits']>;
  private readonly log: NonNullable<UsageDeps['log']>;
  private readonly answerMs: number;
  /** Per token key: no request before this time (epoch ms), the endpoint's Retry-After. */
  private readonly retryAt = new Map<string, number>();
  /**
   * Per token key: when the usage endpoint answered 403 (the token lacks the user:profile scope, as every `claude
   * setup-token` token does), epoch ms. Such a token is read from the API's rate-limit headers (FFBox does the same,
   * ffbox scripts/claude_keys.py), and the endpoint is asked again only after NO_SCOPE_RETRY_MS.
   */
  private readonly noScope = new Map<string, number>();
  private nearTimer?: NodeJS.Timeout;
  /** Credentials read successfully by this process (w1041): every other reading is a persisted one until a poll answers. */
  private readonly freshKeys = new Set<string>();
  /** Tokens Claude refused, by token key (w1745, markOut). */
  private readonly outs = new Map<string, TokenOutMark>();

  constructor(cfg: Config, changed: () => void, deps: UsageDeps = {}) {
    this.cfg = cfg;
    this.changed = changed;
    this.fetchLogin = deps.fetchLogin ?? ((env) => fetchPlanUsage(env, { cwd: this.cfg.dataDir, claudeExecutable: this.cfg.claudeExecutable }));
    this.fetchToken = deps.fetchToken ?? ((token) => fetchTokenUsage(token));
    this.fetchTokenLimits = deps.fetchTokenLimits ?? ((token) => fetchTokenLimits(token));
    this.log = deps.log ?? ((line) => console.log(line));
    this.answerMs = deps.answerMs ?? ANSWER_MS;
    this.file = path.join(cfg.dataDir, 'usage.json');
    this.spendFile = path.join(cfg.dataDir, 'spend.json');
    try {
      const f = readJsonDurable<UsageFile | PlanUsage>(this.file, { check: checkObject });
      if (!f) throw new Error('none yet');
      if ('entries' in f) {
        // A token's numbers saved before it was asked directly were the stored login's: never show them.
        for (const [k, e] of Object.entries(f.entries)) if (e.kind !== 'token' || e.direct) this.entries.set(k, e);
      } else this.entries.set(HOST_LOGIN, { kind: 'login', usage: f });
      // A refusal the last process was told about stands until it runs out (w1041).
      const now = Date.now();
      if ('entries' in f) {
        for (const [k, h] of Object.entries(f.holds ?? {})) {
          if (h.noScopeAt && now - h.noScopeAt < NO_SCOPE_RETRY_MS) this.noScope.set(k, h.noScopeAt);
          if (h.retryAt && h.retryAt > now) this.retryAt.set(k, h.retryAt);
        }
        for (const [k, o] of Object.entries(f.outs ?? {})) if (o && o.until > now && (o.field === 'session' || o.field === 'weekly')) this.outs.set(k, o);
      }
    } catch {
      // first run
    }
    try {
      this.ledger = readJsonDurable<Record<string, number>>(this.spendFile, { check: checkObject }) ?? {};
    } catch {
      // first run
    }
  }

  /** This host's own claude.ai login's usage (the single meter before per-account usage). */
  get usage(): PlanUsage | undefined {
    return this.entries.get(HOST_LOGIN)?.usage;
  }

  /**
   * A credential's usage as the scheduler and system_status use it (w1041, effectiveUsage): a reading this portal has not
   * read itself since it started, or whose last poll failed, is the persisted one, aged and labelled as such.
   */
  usageOf(key: string, now: number = Date.now()): PlanUsage | undefined {
    const u = this.entries.get(key)?.usage;
    return withOut(effectiveUsage(u, now, !!u && (!this.freshKeys.has(key) || !!u.error)), this.outOf(key, now), now);
  }

  /**
   * Claude refused this token (w1745): a rejected rate-limit answer, or a turn that ended on its usage-limit line. Its window
   * counts as used up (100%) until `mark.until` (its reset), so the pool skips it for every new process and the agents on it
   * move at their next turn. A mark that ends later replaces an earlier one; a poll never shortens it.
   */
  markOut(key: string, mark: TokenOutMark, label?: string) {
    if (!key.startsWith('token:') || !(mark.until > mark.at)) return;
    const was = this.outOf(key, mark.at);
    if (was && was.until >= mark.until) return;
    this.outs.set(key, mark);
    this.log(`usage: ${label ?? 'a vault token'} is out (w1745): ${mark.why}; its ${mark.field === 'weekly' ? 'weekly' : '5-hour'} window counts as used up until ${new Date(mark.until).toISOString()}`);
    this.save();
    this.changed();
  }

  /** The token's out mark while it lasts (w1745), else undefined. */
  outOf(key: string, now: number = Date.now()): TokenOutMark | undefined {
    const o = this.outs.get(key);
    return o && o.until > now ? o : undefined;
  }

  /** Every token out now (w1745), by key. */
  outsNow(now: number = Date.now()): [string, TokenOutMark][] {
    return [...this.outs].filter(([, o]) => o.until > now);
  }

  /** The entries with their usage as usageOf gives it (for the accounts list). */
  effectiveEntries(now: number = Date.now()): Map<string, UsageEntry> {
    return new Map([...this.entries].map(([k, e]) => [k, e.usage ? { ...e, usage: this.usageOf(k, now) } : e] as const));
  }

  /** The tokens the last refresh polled, to notice a new one (set_app_config) before the next poll. */
  private tokenSeen?: string;

  /** The vault's Claude tokens with their labels; wired by index.ts. */
  personTokens?: () => { token: string; label: string }[];

  /** Every token to poll, each once. */
  private tokens(): { token: string; label: string }[] {
    const all = this.personTokens?.() ?? [];
    return all.filter((x, i) => all.findIndex((y) => y.token === x.token) === i);
  }

  private tokensKey() {
    return this.tokens().map((x) => tokenKey(x.token)).join() || undefined;
  }

  /** The poll interval (config usagePollMinutes), read afresh so a change applies at the next scheduling. */
  get intervalMs(): number {
    return Math.max(1, this.cfg.usagePollMinutes || 15) * 60_000;
  }

  /** One poll now (so the meters are not empty), then one every interval; a new token is polled within seconds. */
  start() {
    // A dry run (server/dryRun.ts) sends no account's token anywhere to poll it.
    if (dryRun()) return;
    this.started = true;
    void this.refresh();
    setInterval(() => {
      if (this.tokensKey() !== this.tokenSeen) this.poke();
    }, 10_000).unref();
    // A token near a pool limit is read more often than the regular poll (w739): the meters are the pool's only eyes.
    this.nearTimer = setInterval(() => void this.refreshNear(), NEAR_POLL_MS);
    this.nearTimer.unref?.();
  }

  /** The tokens that are near a pool limit now (5-hour at NEAR_SESSION_PERCENT or weekly at NEAR_WEEKLY_PERCENT), or have no numbers. */
  nearTokens(): { token: string; label: string }[] {
    return this.tokens().filter((x) => {
      const u = this.entries.get(tokenKey(x.token))?.usage;
      return !u?.available || !!u.error || (u.session?.percent ?? 0) >= NEAR_SESSION_PERCENT || (u.weekly?.percent ?? 0) >= NEAR_WEEKLY_PERCENT;
    });
  }

  /** One poll of just the near tokens, between the regular polls; skipped while a regular poll runs. */
  async refreshNear() {
    if (this.inFlightSince) return;
    const near = this.nearTokens().filter((x) => this.entries.has(tokenKey(x.token)));
    if (!near.length) return;
    await Promise.all(near.map((x) => this.refreshToken(x.token, x.label)));
    this.save();
    this.changed();
  }

  /**
   * A running session's rate_limit_event (the SDK's, from the API's rate-limit headers on its own requests): raises the
   * token's meter at once, never lowers it (the next poll replaces it). `account` is the session's recorded account key.
   * `utilization` is a fraction (the header's scale; a value above 1 is read as a percent). A guess at the event's
   * frequency: it is not relied on, only used as a floor between polls.
   */
  noteRateLimit(account: string | undefined, info: { rateLimitType?: string; utilization?: number; resetsAt?: number }) {
    if (!account?.startsWith('token:')) return;
    const entry = this.entries.get(account);
    const u = entry?.usage;
    if (!entry || !u?.available || typeof info.utilization !== 'number' || !Number.isFinite(info.utilization) || info.utilization < 0) return;
    const field = info.rateLimitType === 'five_hour' ? 'session' : info.rateLimitType === 'seven_day' ? 'weekly' : undefined;
    // A 5-hour event on a token whose plan sent no 5-hour window (w2709) brings the window back until the next poll.
    const meter = field === 'session' && !u.session ? { label: 'Session (5 h)', percent: -1 } : field ? u[field] : undefined;
    if (!field || !meter) return;
    const percent = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
    if (percent <= meter.percent) return;
    u[field] = { ...meter, percent: Math.round(percent * 100) / 100, ...(info.resetsAt ? { resetsAt: new Date(info.resetsAt * 1000).toISOString() } : {}) };
    this.changed();
  }

  /** Stop the timers (tests, shutdown). */
  stop() {
    this.started = false;
    clearInterval(this.nearTimer);
    clearTimeout(this.next);
    clearTimeout(this.soon);
    this.soon = undefined;
  }

  /** The next scheduled poll: one interval after the last one, whatever started it. Again after the interval changes. */
  reschedule() {
    clearTimeout(this.next);
    if (!this.started) return;
    this.next = setTimeout(() => void this.refresh(), Math.max(1_000, this.lastFetch + this.intervalMs - Date.now()));
    this.next.unref?.();
  }

  /** A new token appeared (set_app_config): poll within seconds rather than at the next interval. */
  poke() {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = undefined;
      void this.refresh();
    }, SOON_MS);
    this.soon.unref?.();
  }

  /**
   * Someone looked (system_status): the numbers are fine up to one interval old; older (the last poll failed, or
   * the timer was held up), a poll starts and the caller shows what there is, with its "as of".
   */
  ensureFresh() {
    if (Date.now() - this.lastFetch >= this.intervalMs) void this.refresh();
  }

  /**
   * The Refresh button: poll now, whatever the interval says, unless a poll is running or one started a few
   * seconds ago. Returns whether a poll started.
   */
  refreshNow(): boolean {
    if (this.inFlightSince || Date.now() - this.lastFetch < SOON_MS) return false;
    void this.refresh();
    return true;
  }

  /** A session's cumulative cost changed: record the increase (the fallback's "our own spend"). */
  recordCost(sessionId: string, costUsd: number) {
    const before = this.lastCost.get(sessionId);
    this.lastCost.set(sessionId, costUsd);
    if (before === undefined || costUsd <= before) return; // first sighting after a restart: no baseline
    this.ledger = addSpend(this.ledger, localDay(), costUsd - before);
    try {
      writeJsonDurable(this.spendFile, this.ledger);
    } catch {
      // not fatal
    }
  }

  /** A machine daemon reported its Mac's own login (protocol 4). */
  report(machineId: string, account: AccountIdentity, usage: PlanUsage) {
    const key = machineLogin(machineId);
    const prev = this.entries.get(key);
    if (usage.available) this.freshKeys.add(key);
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

  /**
   * `p`, or a UsageFetchError once the tracker's own deadline passes. A request that never settles (seen
   * 2026-09-28: the token's first poll never answered and, holding the in-flight mark, stopped every poll
   * after it) then becomes a reason like any other failure.
   */
  private within<T>(p: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UsageFetchError(`${what} gave no answer within ${Math.round(this.answerMs / 1000)} s`)), this.answerMs);
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  }

  async refresh() {
    const now = Date.now();
    if (this.inFlightSince) {
      if (now - this.inFlightSince < STUCK_MS) return;
      // Cannot happen while every request has a deadline; if it does, one stuck poll must not stop the rest.
      this.log(`usage: the poll started at ${new Date(this.inFlightSince).toISOString()} has not finished; polling again`);
    }
    const mine = ++this.pollId;
    this.inFlightSince = now;
    this.lastFetch = now;
    this.reschedule();
    try {
      const tokens = this.tokens();
      const keep = new Set(tokens.map((x) => tokenKey(x.token)));
      // A replaced token's numbers are no longer anyone's.
      for (const k of [...this.entries.keys()]) if (k.startsWith('token:') && !keep.has(k)) this.entries.delete(k);
      this.tokenSeen = this.tokensKey();
      await Promise.all(tokens.map((x) => this.refreshToken(x.token, x.label)));
      this.save();
    } finally {
      if (this.pollId === mine) this.inFlightSince = 0;
    }
    this.changed();
  }

  /**
   * The agents' token, asked with that token alone (fetchTokenUsage). A failure is "unknown" with its
   * reason: no older numbers are kept, so nothing another credential answered can ever show here.
   */
  private async refreshToken(token: string, label = `token …${token.slice(-4)}`) {
    const key = tokenKey(token);
    const asOf = new Date().toISOString();
    const reason = (e: unknown) => scrub(e instanceof Error ? e.message : String(e)).slice(0, 200);
    // The usage endpoint's answer, or why it rate-limits this token (now, or still within its Retry-After).
    const endpoint = async (): Promise<PlanUsage | { limited: string }> => {
      const refused = this.noScope.get(key);
      if (refused && Date.now() - refused < NO_SCOPE_RETRY_MS) return { limited: 'the usage endpoint needs the user:profile scope, which this token lacks' };
      this.noScope.delete(key);
      const wait = this.retryAt.get(key);
      if (wait && wait > Date.now()) return { limited: `the usage endpoint rate-limits this token until ${new Date(wait).toISOString()}` };
      this.retryAt.delete(key);
      try {
        const u = parseUsage(await this.within(this.fetchToken(token), 'the usage endpoint'), asOf);
        if (!u.available) u.why = `the usage endpoint gave no plan limits for this token (${u.why ?? 'unknown'})`;
        return u;
      } catch (e) {
        // 403: no user:profile scope (a setup-token): the headers answer instead, and the endpoint is not asked every poll.
        if (e instanceof UsageFetchError && e.status === 403) {
          this.noScope.set(key, Date.now());
          return { limited: reason(e) };
        }
        const after = e instanceof UsageFetchError ? e.retryAfterMs : undefined;
        if (!after) return { available: false, asOf, models: [], why: `usage unknown: ${reason(e)}` };
        this.retryAt.set(key, Date.now() + after);
        return { limited: reason(e) };
      }
    };
    let u: PlanUsage;
    let via = 'the usage endpoint';
    try {
      const first = await endpoint();
      if ('limited' in first) {
        // The same token's rate-limit headers stand in: weekly and session, no per-model limits.
        via = `the API's rate-limit headers (${first.limited})`;
        try {
          u = { ...parseUsage(await this.within(this.fetchTokenLimits(token), "the API's rate-limit headers"), asOf), source: LIMITS_SOURCE };
        } catch (e) {
          u = { available: false, asOf, models: [], why: `usage unknown: ${first.limited}; ${reason(e)}` };
        }
      } else u = first;
    } catch (e) {
      // Anything unexpected (a reply parseUsage cannot read): still a reason, never "not fetched yet".
      u = { available: false, asOf, models: [], why: `usage unknown: ${reason(e)}` };
    }
    const prev = this.entries.get(key);
    if (u.available) this.freshKeys.add(key);
    else if (prev?.direct && prev.usage?.available && !/HTTP 401/.test(u.why ?? '')) {
      // A failed poll keeps this token's own last good reading (w1041: the 2026-10-11 20:30Z restart lost it to a failed first
      // poll and the pool was counted at 50%): shown as persisted with the failure, aged by effectiveUsage. Same key, same token.
      // A token the API rejected (401: expired or revoked) is not kept: its old numbers would hide that it cannot run.
      const kept = { ...prev.usage, error: (u.why ?? 'usage unknown').slice(0, 200) };
      this.entries.set(key, { kind: 'token', label, usage: kept, direct: true });
      this.log(`usage: ${label} (${key}, asked with that token itself, via ${via}): failed (${kept.error}), keeping its reading from ${prev.usage.asOf}`);
      return;
    }
    if (!u.available) u.spendWeekUsd = weekSpend(this.ledger, localDay());
    this.entries.set(key, { kind: 'token', label, usage: u, direct: true });
    this.log(`usage: ${label} (${key}, asked with that token itself, via ${via}): ${u.available ? 'ok' : 'failed'}, ${brief(u)}`);
  }

  private save() {
    try {
      const holds: NonNullable<UsageFile['holds']> = {};
      const now = Date.now();
      for (const [k, at] of this.noScope) if (now - at < NO_SCOPE_RETRY_MS) holds[k] = { ...holds[k], noScopeAt: at };
      for (const [k, at] of this.retryAt) if (at > now) holds[k] = { ...holds[k], retryAt: at };
      const outs = Object.fromEntries([...this.outs].filter(([, o]) => o.until > now));
      writeJsonDurable(this.file, { entries: Object.fromEntries(this.entries), ...(Object.keys(holds).length ? { holds } : {}), ...(Object.keys(outs).length ? { outs } : {}) } satisfies UsageFile);
    } catch {
      // not fatal
    }
  }
}

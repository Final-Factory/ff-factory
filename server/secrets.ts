import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_ROLES, TOKEN_FILE_ROLES, roleNames, type ClaudeAccount, type Config, type HostRole } from './config.ts';
import type { Requester, SessionInfo, SessionKind } from '../shared/types.ts';
import { claudeEnvFor, userToken } from './identity.ts';
import { PoolHeldError, vaultContext, type VaultContext, type VaultRole } from './vault.ts';
import { HOST_LOGIN, credentialsFile, loginUnusable, readStoredLogin, tokenKey, usageEnv } from './usage.ts';
import { clock, poolLimits, reserveOf, type PoolLimits, type Reserve } from './tokenPool.ts';
import type { PlanUsage } from '../shared/types.ts';
import { writeFileDurable } from './durable.ts';

/**
 * Secrets agents may set but nobody may read back (set_app_config's write-only keys): the Claude OAuth token
 * the agents run on. The value is only ever shown as "set (…last 4 chars)", and every transcript event is
 * written (and sent to the UI) with such a token redacted, so neither the orchestrator's own tool call that
 * set it nor a pasted message keeps it on disk. Discord bot tokens (and DISCORD_TOKEN / FFDISCORD_APP_TOKEN
 * values) are redacted the same way, and so are provider connector tokens (ffpv1_…, server/providerProtocol.ts).
 * Search reads the transcripts, so it never sees them either.
 */

/** A Claude Code OAuth token (`claude setup-token`). */
export const OAUTH_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;
const OAUTH_TOKEN_ANYWHERE = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/g;

/** set_app_config keys whose value is never shown. */
export const SECRET_KEYS: ReadonlySet<string> = new Set(['claudeEnv.CLAUDE_CODE_OAUTH_TOKEN', 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN', 'providers.ffbox.token']);

/** A provider connector token (server/providerProtocol.ts, PROVIDER_TOKEN). */
const PROVIDER_TOKEN_ANYWHERE = /ffpv1_[A-Za-z0-9_-]{43}/g;

/** How a secret setting reads anywhere: "set (…abcd)" or "not set". */
export const maskSecret = (v: unknown) => (typeof v === 'string' && v ? `set (…${v.slice(-4)})` : 'not set');

/** A Discord bot token: base64 user id, timestamp, HMAC (three dot-separated parts). */
const DISCORD_TOKEN_ANYWHERE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-])/g;
/**
 * The value of a Discord token variable (`DISCORD_TOKEN=…`, `FFDISCORD_APP_TOKEN: "…"`), whatever it looks
 * like. The value stops at whitespace, a quote, a backslash (a JSON escape) or a separator, so redacting the
 * serialized JSON of an event cannot break it.
 */
const DISCORD_ASSIGNMENT = /\b((?:FF)?DISCORD(?:_APP)?_TOKEN)(\s*[=:]\s*\\?["']?)([^\s"'\\&;,]{8,})/g;

const lastFour = (m: string) => m.slice(-4);

/**
 * What the orchestration worker's shell could meet in the portal VM (w597): a machine's /machine credential
 * (ffm_<id>_<secret>), an Anthropic API key, a Tailscale key, an age identity and a private key block.
 */
const MACHINE_TOKEN_ANYWHERE = /(ffm_[A-Za-z0-9.-]{1,64}_)[A-Za-z0-9_-]{32,}/g;
const API_KEY_ANYWHERE = /sk-ant-api\d\d-[A-Za-z0-9_-]{40,}/g;
const TAILSCALE_KEY_ANYWHERE = /tskey-[a-z]+-[A-Za-z0-9-]{16,}/g;
const AGE_KEY_ANYWHERE = /AGE-SECRET-KEY-1[0-9A-Z]{50,}/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;

/** A GitHub token (classic, OAuth, app, refresh or fine-grained), the vault's kind github (w512). */
const GITHUB_TOKEN_ANYWHERE = /(?<![A-Za-z0-9_])(gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}/g;

/**
 * Values the token vault holds (server/vault.ts, w512), whatever their form: redacted by value, so a vault secret with no
 * recognisable shape (an env-kind API key) never reaches a transcript or a log either. Only values of 8+ characters.
 */
let knownValues: string[] = [];
export function registerSecretValues(values: readonly string[]) {
  knownValues = [...new Set(values.filter((v) => typeof v === 'string' && v.length >= 8))].sort((a, b) => b.length - a.length);
}

/** The secret-looking values of a launch spec's environment (a vault's or a person's token): what a daemon adds with addSecretValues. */
export const SECRET_ENV = /^(?:CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN)$|_(?:TOKEN|KEY|SECRET|PASSWORD)$/;

/** Learn more values to redact without forgetting the ones known (a daemon, from each launch spec it gets). At most 200 kept. */
export function addSecretValues(values: readonly string[]) {
  registerSecretValues([...values, ...knownValues].slice(0, 200));
}

/** Whether `text` may hold a secret this module redacts (a cheap check before the regexes). */
const maybeSecret = (text: string) =>
  text.includes('sk-ant-oat01-') || text.includes('ffpv1_') || /ffm_|sk-ant-api|tskey-|AGE-SECRET-KEY-|PRIVATE KEY-----/.test(text) || /DISCORD|\.[A-Za-z0-9_-]{6}\.|gh[pousr]_|github_pat_/.test(text) || knownValues.some((v) => text.includes(v));

/**
 * `text` with its secrets replaced: a Claude OAuth token by "sk-ant-oat01-[redacted …abcd]", a Discord bot token
 * by "[redacted Discord token …abcd]", and the value of DISCORD_TOKEN / FFDISCORD_APP_TOKEN by "[redacted …abcd]".
 */
export function redactSecrets(text: string): string {
  if (!maybeSecret(text)) return text;
  let out = text;
  for (const v of knownValues) if (out.includes(v)) out = out.split(v).join(`[redacted vault secret …${lastFour(v)}]`);
  return out
    .replace(OAUTH_TOKEN_ANYWHERE, (m) => `sk-ant-oat01-[redacted …${lastFour(m)}]`)
    .replace(MACHINE_TOKEN_ANYWHERE, (m, prefix: string) => `${prefix}[redacted …${lastFour(m)}]`)
    .replace(API_KEY_ANYWHERE, (m) => `sk-ant-api-[redacted …${lastFour(m)}]`)
    .replace(TAILSCALE_KEY_ANYWHERE, (m) => `tskey-[redacted …${lastFour(m)}]`)
    .replace(AGE_KEY_ANYWHERE, () => 'AGE-SECRET-KEY-[redacted]')
    .replace(PRIVATE_KEY_BLOCK, (_m, kind: string) => `[redacted ${kind}private key]`)
    .replace(PROVIDER_TOKEN_ANYWHERE, (m) => `ffpv1_[redacted …${lastFour(m)}]`)
    .replace(GITHUB_TOKEN_ANYWHERE, (m, prefix: string) => `${prefix}[redacted …${lastFour(m)}]`)
    .replace(DISCORD_ASSIGNMENT, (_m, name: string, sep: string, value: string) => (value.startsWith('[redacted') ? _m : `${name}${sep}[redacted …${lastFour(value)}]`))
    .replace(DISCORD_TOKEN_ANYWHERE, (m) => `[redacted Discord token …${lastFour(m)}]`);
}

/** A value (a transcript event) with its secrets redacted; the same object when there are none. */
export function redactValue<T>(v: T): T {
  const json = JSON.stringify(v);
  if (!json || !maybeSecret(json)) return v;
  const clean = redactSecrets(json);
  return clean === json ? v : (JSON.parse(clean) as T);
}

/** Rewrite every transcript in `dir` that still holds a token (written before redaction existed). Returns how many. */
export function scrubTranscripts(dir: string): number {
  let n = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (!maybeSecret(text)) continue;
      const clean = redactSecrets(text);
      if (clean === text) continue;
      writeFileDurable(file, clean, { generations: 0 });
      n++;
    } catch {
      // being written, or gone: the next start tries again
    }
  }
  return n;
}

/** A machine as the account rules need it: its id, and whether it is the portal's own host (docs/beast-machine.md). */
export type MachineRef = string | { id: string; local?: boolean };
const refId = (m: MachineRef) => (typeof m === 'string' ? m : m.id);
const refLocal = (m: MachineRef) => typeof m !== 'string' && !!m.local;

/**
 * Whether portal-run agents on a machine get this host's claudeEnv (config machines.useHostClaudeEnv; default
 * yes): an entry naming the machine, else, for the portal's own host (a local machine, docs/beast-machine.md), what
 * claudeAccounts.workers says (its sandboxes were this host's, so its workers keep the account they had), else the
 * value itself, or "*" for machines not named.
 */
export function usesHostClaudeEnv(cfg: Pick<Config, 'machines'> & Partial<Pick<Config, 'claudeAccounts'>>, machine: MachineRef): boolean {
  const u = cfg.machines?.useHostClaudeEnv;
  const id = refId(machine);
  if (u && typeof u === 'object' && u[id] !== undefined) return u[id];
  if (refLocal(machine)) return hostAccount(cfg, 'workers') !== 'login';
  if (u === undefined) return true;
  if (typeof u === 'boolean') return u;
  return u['*'] ?? true;
}

// ---------------------------------------------------------------- this host's agents (docs/accounts.md)

/** The role config claudeAccounts knows a session of `kind` on this host by. */
// The orchestration worker (w597) runs on the orchestrators' account: it works only for their people.
export const hostRole = (kind: SessionKind): HostRole => (kind === 'orchestrator' || kind === 'ops' ? 'orchestrator' : 'workers');

/**
 * The account this host's agents of `role` run on (config claudeAccounts; default the token; the dispatcher, unset:
 * the orchestrator's). Workers never run on the token file: a "tokenfile" there (refused at config load) reads as the token.
 */
export function hostAccount(cfg: Pick<Config, 'claudeAccounts'> & Partial<Pick<Config, 'claudeTokenFile'>>, role: HostRole): ClaudeAccount {
  const v = cfg.claudeAccounts?.[role] ?? (role === 'dispatcher' ? cfg.claudeAccounts?.orchestrator : undefined);
  // "vault" (w738) is the orchestrators'; the dispatcher that inherits it stays on the token file (else the host token), and
  // so does anyone with no vault tokens: `poolRunEnv` falls back to this.
  if (v === 'vault') return role === 'orchestrator' ? 'vault' : cfg.claudeTokenFile ? 'tokenfile' : 'token';
  if (v === 'tokenfile') return TOKEN_FILE_ROLES.includes(role) ? 'tokenfile' : 'token';
  return v === 'login' ? 'login' : 'token';
}

/**
 * The OAuth token in config claudeTokenFile (w464), read now: a role set to "tokenfile" reads it at each session
 * start, so a new token applies to the next session without a restart. Throws, never showing the content, when no file
 * is named, it cannot be read, or what it holds is not one OAuth token.
 */
export function readTokenFile(cfg: Partial<Pick<Config, 'claudeTokenFile'>>): string {
  const file = cfg.claudeTokenFile;
  if (!file) throw new Error('config claudeTokenFile names no file, but a role is set to "tokenfile"');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read config claudeTokenFile ${file}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`);
  }
  const token = text.replace(/^\uFEFF/, '').trim();
  if (!OAUTH_TOKEN.test(token)) throw new Error(`config claudeTokenFile ${file} does not hold one Claude OAuth token (sk-ant-oat01-…, from \`claude setup-token\`); its content is not shown`);
  return token;
}

/** A role's credentials replaced by the token file's alone (w464): every other Claude credential removed first. */
const withTokenFile = <E extends Record<string, string | undefined>>(cfg: Partial<Pick<Config, 'claudeTokenFile'>>, env: E): E => ({ ...usageEnv(env), CLAUDE_CODE_OAUTH_TOKEN: readTokenFile(cfg) });

/** Whether the dispatcher has an account of its own (config claudeAccounts.dispatcher, w464): it then ignores the system payer's own token. */
export const dispatcherOwnAccount = (cfg: Pick<Config, 'claudeAccounts'>) => cfg.claudeAccounts?.dispatcher !== undefined;

/** The roles worth naming apart: the dispatcher only when it has an account of its own (else it is the orchestrator's). */
export const shownRoles = (cfg: Pick<Config, 'claudeAccounts'>): HostRole[] => HOST_ROLES.filter((r) => r !== 'dispatcher' || dispatcherOwnAccount(cfg));

/** The role a session on this host runs as (claudeAccounts): the dispatcher's own when it has one, else by its kind. */
export function hostRoleOf(cfg: Pick<Config, 'claudeAccounts'>, info: Pick<SessionInfo, 'kind'> & Partial<Pick<SessionInfo, 'orchestratorRole'>>): HostRole {
  return info.kind === 'orchestrator' && info.orchestratorRole === 'dispatcher' && dispatcherOwnAccount(cfg) ? 'dispatcher' : hostRole(info.kind);
}

/** The account a host role runs on when it has no vault pool to use: "vault" is the token file (else the host token). */
const baseAccount = (cfg: Pick<Config, 'claudeAccounts'> & Partial<Pick<Config, 'claudeTokenFile'>>, role: HostRole): ClaudeAccount => {
  const a = hostAccount(cfg, role);
  return a === 'vault' ? (cfg.claudeTokenFile ? 'tokenfile' : 'token') : a;
};

/**
 * Config claudeEnv as a host agent of `role` gets it: whole ("token"), or without its credentials ("login"), so
 * the agent falls back to the claude.ai login stored on this host. Its other variables (CLAUDE_CONFIG_DIR…) stay.
 */
export function hostClaudeEnv(cfg: Pick<Config, 'claudeAccounts' | 'claudeEnv'> & Partial<Pick<Config, 'claudeTokenFile'>>, role: HostRole): Record<string, string> {
  const env = { ...cfg.claudeEnv };
  const a = baseAccount(cfg, role);
  return a === 'tokenfile' ? withTokenFile(cfg, env) : a === 'login' ? usageEnv(env) : env;
}

/**
 * The whole environment a Claude process of `role` starts with on this host: the server's own with config
 * claudeEnv over it, and for "login" without any credential, as the usage meters read the host login
 * (server/usage.ts refresh), so what they show as "<host> login" is what the agent runs on.
 */
export function hostProcessEnv(cfg: Pick<Config, 'claudeAccounts' | 'claudeEnv'> & Partial<Pick<Config, 'claudeTokenFile'>>, role: HostRole, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const all = { ...env, ...cfg.claudeEnv };
  const a = baseAccount(cfg, role);
  return a === 'tokenfile' ? withTokenFile(cfg, all) : a === 'login' ? usageEnv(all) : all;
}

/** The token file's token, or undefined when no role runs on it or it cannot be read (the meters and attribution). */
export function tokenFileToken(cfg: Pick<Config, 'claudeAccounts'> & Partial<Pick<Config, 'claudeTokenFile'>>): string | undefined {
  if (!HOST_ROLES.some((r) => hostAccount(cfg, r) === 'tokenfile')) return undefined;
  try {
    return readTokenFile(cfg);
  } catch {
    return undefined;
  }
}

/**
 * Why this host's stored claude.ai login cannot run agents (none stored, or expired past refreshing), or
 * undefined. Read from where a "login" agent's Claude Code reads it (hostProcessEnv). macOS keeps it in the
 * Keychain, where a missing file proves nothing.
 */
export function hostLoginProblem(cfg: Pick<Config, 'claudeEnv'>, env: Record<string, string | undefined> = process.env, now = Date.now()): string | undefined {
  const file = credentialsFile(usageEnv({ ...env, ...cfg.claudeEnv }));
  return loginUnusable(readStoredLogin(file), now, file, process.platform === 'darwin');
}

/**
 * The Claude env a portal-run agent on `machineId` runs with: this host's claudeEnv (with
 * CLAUDE_CODE_OAUTH_TOKEN, it overrides the Mac's keychain login for that agent only), or nothing (the Mac's
 * own login). It travels in the launch spec over the authenticated daemon channel and is never logged.
 */
export function hostClaudeEnvFor(cfg: Pick<Config, 'machines' | 'claudeEnv'> & Partial<Pick<Config, 'claudeAccounts'>>, machine: MachineRef): Record<string, string> {
  if (usesHostClaudeEnv(cfg, machine)) return { ...cfg.claudeEnv };
  // The portal's own host on its login: config claudeEnv without its credentials, as this host's "login" workers had
  // it (CLAUDE_CONFIG_DIR and the like stay, so a resumed session finds its history).
  return refLocal(machine) ? usageEnv({ ...cfg.claudeEnv }) : {};
}

/** Whether a machine's portal-run agents run on the Mac's own login: they are sent no token (hostClaudeEnvFor). */
export const machineUsesLogin = (cfg: Pick<Config, 'machines' | 'claudeEnv'> & Partial<Pick<Config, 'claudeAccounts'>>, machine: MachineRef) => !hostClaudeEnvFor(cfg, machine).CLAUDE_CODE_OAUTH_TOKEN;

/** Which Claude account a machine's portal-run agents use, safe to show: "host token …abcd" or "Mac login". */
export function accountSource(cfg: Pick<Config, 'machines' | 'claudeEnv'> & Partial<Pick<Config, 'claudeAccounts'>>, machine: MachineRef): string {
  const token = hostClaudeEnvFor(cfg, machine).CLAUDE_CODE_OAUTH_TOKEN;
  if (token) return `host token …${token.slice(-4)}`;
  return refLocal(machine) ? `${os.hostname()} login (this host's stored Claude login, claudeAccounts.workers)` : "Mac login (the Mac's own Claude Code login)";
}

/**
 * Whether a machine's runs take their Claude token from the token vault (config machines.claudeFromVault, docs/vault.md;
 * default no): an entry naming the machine, else "*", else the value itself.
 */
export function claudeFromVault(cfg: Pick<Config, 'machines'>, machine: MachineRef): boolean {
  const u = cfg.machines?.claudeFromVault;
  if (u === undefined) return false;
  if (typeof u === 'boolean') return u;
  return u[refId(machine)] ?? u['*'] ?? false;
}

/** What a machine run starts with (machineRunEnv): its environment, whether it drops the daemon's own credentials, and its account for people. */
export interface MachineRunEnv {
  env: Record<string, string>;
  login: boolean;
  /** "vault token ben-max …abcd", "host token …abcd" or "Mac login", safe to show. */
  account: string;
}

/**
 * The Claude account and the vault's secrets a run on a machine gets (docs/vault.md, sections 3 and 4). In order: a
 * person's own token (config userClaudeEnv) for their work, as before; then, on a machine config machines.claudeFromVault
 * names, a Claude token from the run person's vault pool (server/tokenPool.ts); else the machine's account without the vault (hostClaudeEnvFor:
 * the host token or its own login). Every other vault entry granted to the run's role and machine is added as
 * environment. With a vault token, `login` is true so the daemon's own credentials (an API key in its environment would
 * outrank the token) are dropped and only the token remains. Without a vault context, exactly what it was before.
 */
export function machineRunEnv(
  cfg: Pick<Config, 'machines' | 'claudeEnv' | 'userClaudeEnv'> & Partial<Pick<Config, 'claudeAccounts'>>,
  machine: MachineRef,
  run: { role: VaultRole; requestedBy?: Requester; sessionId?: string; tokenUser?: string },
  ctx: VaultContext | undefined = vaultContext(),
): MachineRunEnv {
  const vaultOn = !!ctx && claudeFromVault(cfg, machine);
  // Whose tokens (docs/vault.md, "Whose tokens"): work nobody asked for by name runs on the person config
  // vault.unattributed names (run.tokenUser); anything else on its requester's, else the system payer's.
  const person = run.tokenUser ?? run.requestedBy?.userId ?? ctx?.payer?.();
  const billed = vaultOn && run.tokenUser ? { userId: run.tokenUser, displayName: run.tokenUser } : run.requestedBy;
  const base = claudeEnvFor(cfg, billed, hostClaudeEnvFor(cfg, machine));
  const plain = { env: base, login: machineUsesLogin(cfg, machine), account: accountSource(cfg, machine) };
  const own = userToken(cfg, billed?.userId);
  if (!ctx) return plain;
  const wantClaude = vaultOn && !own;
  const s = ctx.vault.forRun({ machineId: refId(machine), role: run.role, userId: person, sessionId: run.sessionId }, { claude: wantClaude, usageOf: ctx.usageOf, liveOn: ctx.liveOn, limits: ctx.limits });
  for (const p of s.problems) ctx.onProblem?.(p);
  if (s.claude) {
    return { env: { ...usageEnv(base), ...s.env, CLAUDE_CODE_OAUTH_TOKEN: s.claude.token }, login: true, account: poolAccount(s.claude, person) };
  }
  // The person has Claude tokens and none may serve this run (every one over its caps or used up): the run waits for the
  // first to free up. No other person's token, no shared token, not the dispatcher's, not the host token (w739).
  if (wantClaude && s.claudeHold) throw new PoolHeldError(`${person ?? 'this run'}'s Claude token pool is held: ${s.claudeHold.why}`, s.claudeHold.next);
  // No token of their own (or the vault cannot open them): today's account, as before the pool (docs/vault.md, "Cut-over").
  if (wantClaude) ctx.onProblem?.(`no vault Claude token for a ${run.role} run on ${refId(machine)}${person ? ` for ${person}` : ''}; it runs on ${plain.account} instead`);
  return { ...plain, env: { ...base, ...s.env } };
}

/** "vault token ben-max …abcd" for a run's account line, safe to show. */
function poolAccount(c: { entry: { name: string; last4: string }; how: 'normal' | 'over-cap' }, person: string | undefined): string {
  return `vault token ${c.entry.name} …${c.entry.last4} (${person ? `${person}'s pool` : 'a pool'}${c.how === 'over-cap' ? ', over its caps: used up first' : ''}, docs/vault.md)`;
}

/**
 * The environment of a portal-side Claude process for a person (w738): their own orchestrator ("orchestrator"), or the
 * orchestration worker working for them ("ops"). With `claudeAccounts.orchestrator` set to "vault" and the vault holding
 * Claude tokens for the person, it is exactly that person's pool token as CLAUDE_CODE_OAUTH_TOKEN, every other Claude
 * credential removed first (as the token file's does), picked now so a new token applies to the next session start.
 * All their tokens used up or capped: an orchestrator uses its pool up and then stops, the ops worker is held like a
 * worker; both throw PoolHeldError (the session start fails with the reason and the next reset). No tokens of their own
 * yet (the transition), or the vault cannot open them: `fallback`, today's account.
 */
export function poolRunEnv(
  cfg: Pick<Config, 'claudeAccounts' | 'claudeEnv'> & Partial<Pick<Config, 'claudeTokenFile'>>,
  run: { role: 'orchestrator' | 'ops'; personId: string | undefined; sessionId?: string },
  fallback: () => Record<string, string | undefined>,
  ctx: VaultContext | undefined = vaultContext(),
): { env: Record<string, string | undefined>; account: string } {
  const plain = () => ({ env: fallback(), account: baseAccount(cfg, 'orchestrator') === 'tokenfile' ? 'token file' : 'host token' });
  if (hostAccount(cfg, 'orchestrator') !== 'vault' || !ctx || !run.personId) return plain();
  const s = ctx.vault.forRun({ machineId: 'portal', role: run.role, userId: run.personId, sessionId: run.sessionId }, { claude: true, usageOf: ctx.usageOf, liveOn: ctx.liveOn, limits: ctx.limits });
  for (const p of s.problems) ctx.onProblem?.(p);
  if (s.claude) {
    const all = { ...process.env, ...cfg.claudeEnv };
    return { env: { ...usageEnv(all), CLAUDE_CODE_OAUTH_TOKEN: s.claude.token }, account: poolAccount(s.claude, run.personId) };
  }
  if (s.claudeHold) throw new PoolHeldError(`${run.personId}'s Claude token pool is ${run.role === 'orchestrator' ? 'used up' : 'held'}: ${s.claudeHold.why}`, s.claudeHold.next);
  return plain();
}

// ---------------------------------------------------------------- the dispatcher's reserve (w739)

/** A credential kept back for one role: the dispatcher's, and the host token's. */
export interface ReservedCredential {
  /** The usage meters' key (tokenKey), or HOST_LOGIN. */
  key: string;
  /** "the dispatcher's token file …dAAA" */
  what: string;
  role: 'dispatcher' | 'host-token';
}

/**
 * The credentials with a reserve, worked out from config now (never a fixed token): whatever claudeAccounts.dispatcher
 * resolves to (the token file today, else the host token or this host's login), and the host token
 * (claudeEnv.CLAUDE_CODE_OAUTH_TOKEN) that machine agents and the people with no pool yet run on. When they are one
 * credential it is the dispatcher's. One token is one account: no matching of two tokens to one account.
 */
export function reservedCredentials(cfg: Pick<Config, 'claudeAccounts' | 'claudeEnv'> & Partial<Pick<Config, 'claudeTokenFile'>>): ReservedCredential[] {
  const out: ReservedCredential[] = [];
  const a = hostAccount(cfg, 'dispatcher');
  const hostTok = cfg.claudeEnv?.CLAUDE_CODE_OAUTH_TOKEN;
  if (a === 'tokenfile') {
    const t = tokenFileToken(cfg);
    if (t) out.push({ key: tokenKey(t), what: `the dispatcher's token file …${t.slice(-4)}`, role: 'dispatcher' });
  } else if (a === 'token') {
    if (hostTok) out.push({ key: tokenKey(hostTok), what: `the dispatcher's host token …${hostTok.slice(-4)}`, role: 'dispatcher' });
  } else if (a === 'login') out.push({ key: HOST_LOGIN, what: "the dispatcher's host login", role: 'dispatcher' });
  if (hostTok && !out.some((c) => c.key === tokenKey(hostTok))) out.push({ key: tokenKey(hostTok), what: `the host token …${hostTok.slice(-4)}`, role: 'host-token' });
  return out;
}

export interface ReserveLine {
  cred: ReservedCredential;
  reserve: Reserve;
  /** The status line: "dispatcher token …dAAA: weekly 41%, reserve 25% (5 days to reset); 5-hour 12%, reserve 20%". */
  line: string;
  /** Set when runs other than the owner's are live on it while it is inside its reserve: the dashboard's banner. */
  warning?: string;
}

/**
 * system_status's line for each reserved credential and the dashboard's warning. The reserve is the dispatcher's: it may
 * run into it up to 100%, nothing here ever holds the dispatcher. Other runs landing on it (a person with no vault tokens
 * yet, whose orchestrator is on the token file) are not refused, because they have nothing else: the warning says they
 * are using the buffer. `othersOn`: how many live sessions other than the owner's run on a credential key.
 */
export function reserveLines(
  cfg: Pick<Config, 'claudeAccounts' | 'claudeEnv' | 'vault'> & Partial<Pick<Config, 'claudeTokenFile'>>,
  usageOf: (key: string) => PlanUsage | undefined,
  othersOn: (key: string, role: ReservedCredential['role']) => number,
  now = Date.now(),
): ReserveLine[] {
  const limits: PoolLimits = poolLimits(cfg);
  return reservedCredentials(cfg).map((cred) => {
    const u = usageOf(cred.key);
    const r = reserveOf(u, limits, now);
    const w = u?.weekly;
    const sess = u?.session;
    const name = cred.what.replace(/^the /, '');
    const nums = r.noReading
      ? 'no reading yet (counted as inside its reserve)'
      : `weekly ${Math.round(w?.percent ?? 50)}%, reserve ${Math.round(r.weekly)}% (${r.daysLeft.toFixed(r.daysLeft < 1 ? 1 : 0)} day${Math.round(r.daysLeft) === 1 ? '' : 's'} to reset); 5-hour ${Math.round(sess?.percent ?? 50)}%, reserve ${Math.round(r.session)}%`;
    const others = r.inReserve ? othersOn(cred.key, cred.role) : 0;
    const who = cred.role === 'dispatcher' ? 'the dispatcher' : 'its own roles';
    return {
      cred,
      reserve: r,
      line: `${name}: ${nums}${r.inReserve ? `; inside its reserve, kept for ${who}` : ''}${others ? `; ${others} other run${others === 1 ? '' : 's'} using it` : ''}`,
      ...(others ? { warning: `${name} is the last token with room for ${others} run${others === 1 ? '' : 's'} and is inside the buffer kept for ${who}${w ? ` (weekly ${Math.round(w.percent)}%, reserve ${Math.round(r.weekly)}%, resets ${clock(w.resetsAt)})` : ''}` } : {}),
    };
  });
}

/**
 * system_status's lines on which account each kind of agent runs on (docs/accounts.md), safe to show: this
 * host's roles, then every machine. `hostName`: this host, `hostToken`: the token its agents would get (usage.ts
 * hostToken), `people`: display names of those with their own token, which wins for work they asked for.
 */
export function accountSetupLines(cfg: Pick<Config, 'claudeAccounts' | 'claudeEnv' | 'machines'> & Partial<Pick<Config, 'claudeTokenFile'>>, hostName: string, hostToken: string | undefined, machineIds: MachineRef[], people: string[] = []): string[] {
  const fileToken = tokenFileToken(cfg);
  const here = (role: HostRole) =>
    hostAccount(cfg, role) === 'vault'
      ? `each person's own vault pool (${fileToken ? `token file …${fileToken.slice(-4)}` : hostToken ? `host token …${hostToken.slice(-4)}` : 'no token'} for a person with no vault token)`
      : hostAccount(cfg, role) === 'tokenfile'
      ? fileToken
        ? `token file …${fileToken.slice(-4)}`
        : 'token file (UNREADABLE: its sessions will not start)'
      : hostAccount(cfg, role) === 'login' || !hostToken
        ? `${hostName} login`
        : `host token …${hostToken.slice(-4)}`;
  const logins = shownRoles(cfg).filter((r) => hostAccount(cfg, r) === 'login');
  const problem = logins.length ? hostLoginProblem(cfg) : undefined;
  return [
    `Claude account per agent (config claudeAccounts, machines.useHostClaudeEnv): ${shownRoles(cfg).map((r) => `${roleNames([r])} here: ${here(r)}`).join('; ')}${machineIds.length ? `; ${machineIds.map((m) => `agents on ${refId(m)}: ${accountSource(cfg, m).replace(/ \(.*\)$/, '')}`).join('; ')}` : ''}${people.length ? `; work asked for by ${people.join(', ')}: their own token` : ''}`,
    ...(problem ? [`WARNING: set to the ${hostName} login (${roleNames(logins)}), which cannot run agents: ${problem}`] : []),
  ];
}

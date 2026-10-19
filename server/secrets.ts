import fs from 'node:fs';
import path from 'node:path';
import { HOST_ROLES, pinnedVaultEntry, type ClaudeAccount, type Config, type HostRole } from './config.ts';
import type { Requester, SessionInfo, SessionKind } from '../shared/types.ts';
import { PoolHeldError, vaultContext, type VaultContext, type VaultRole } from './vault.ts';
import { githubFromVault } from './githubTokens.ts';
import { tokenKey, usageEnv } from './usage.ts';
import { poolLimits, reserveOf, reserveReason, type PoolLimits, type Reserve } from './tokenPool.ts';
import type { PlanUsage } from '../shared/types.ts';
import { writeFileDurable } from './durable.ts';

/**
 * Secrets agents may set but nobody may read back (set_app_config's write-only keys): FFBox's connector token (the Claude
 * tokens are the vault's, w1078). A value is only ever shown as "set (…last 4 chars)", and every transcript event is
 * written (and sent to the UI) with a Claude OAuth token redacted, so neither a tool call nor a pasted message keeps one
 * on disk. Discord bot tokens (and DISCORD_TOKEN / FFDISCORD_APP_TOKEN
 * values) are redacted the same way, and so are provider connector tokens (ffpv1_…, server/providerProtocol.ts).
 * Search reads the transcripts, so it never sees them either.
 */

/** A Claude Code OAuth token (`claude setup-token`). */
export const OAUTH_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;
const OAUTH_TOKEN_ANYWHERE = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/g;

/** set_app_config keys whose value is never shown. */
export const SECRET_KEYS: ReadonlySet<string> = new Set(['providers.ffbox.token']);

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
/** The portal's own API key (Auth.createApiKey: ffsb_ and 43 base64url characters), for /mcp (w1415: fffctl apikey). */
const PORTAL_KEY_ANYWHERE = /ffsb_[A-Za-z0-9_-]{40,}/g;
const TAILSCALE_KEY_ANYWHERE =/tskey-[a-z]+-[A-Za-z0-9-]{16,}/g;
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
  text.includes('sk-ant-oat01-') || text.includes('ffpv1_') || /ffm_|ffsb_|sk-ant-api|tskey-|AGE-SECRET-KEY-|PRIVATE KEY-----/.test(text) || /DISCORD|\.[A-Za-z0-9_-]{6}\.|gh[pousr]_|github_pat_/.test(text) || knownValues.some((v) => text.includes(v));

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
    .replace(PORTAL_KEY_ANYWHERE, (m) => `ffsb_[redacted …${lastFour(m)}]`)
    .replace(TAILSCALE_KEY_ANYWHERE,(m) => `tskey-[redacted …${lastFour(m)}]`)
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

// ---------------------------------------------------------------- every Claude process on a vault token (docs/accounts.md)

/**
 * Whether a session of `kind` without a machine is one this host runs (w510: only the orchestrators, and the orchestration
 * worker, w597, which works only for their people).
 */
export const runsOnThisHost = (kind: SessionKind): boolean => kind === 'orchestrator' || kind === 'ops';

/** The role config claudeAccounts knows a session of `kind` on this host by: the orchestrator's, for the orchestration worker too. */
export const hostRole = (_kind: SessionKind): HostRole => 'orchestrator';

/**
 * The vault token this host's agents of `role` run on (config claudeAccounts, w1078): "vault", their person's own pool (the
 * dispatcher: the system payer's), or the dispatcher's one named token "vault:<entry name>" (w996). There is nothing else:
 * no host token, token file or stored login (lothsahn, 2026-10-12: "everything runs off the vault").
 */
export function hostAccount(cfg: Pick<Config, 'claudeAccounts'>, role: HostRole): ClaudeAccount {
  const v = cfg.claudeAccounts?.[role];
  return role === 'dispatcher' && pinnedVaultEntry(v) !== undefined ? v! : 'vault';
}

/** The vault entry the dispatcher is pinned to (claudeAccounts.dispatcher "vault:<name>", w996), or undefined. */
export const pinnedDispatcherEntry = (cfg: Pick<Config, 'claudeAccounts'>): string | undefined => pinnedVaultEntry(hostAccount(cfg, 'dispatcher'));

/** Whether the dispatcher has a token of its own (pinned, w996): else it runs on the system payer's pool. */
export const dispatcherOwnAccount = (cfg: Pick<Config, 'claudeAccounts'>) => pinnedDispatcherEntry(cfg) !== undefined;

/** The roles worth naming apart: the dispatcher only when it has a token of its own (else it is on a person's pool). */
export const shownRoles = (cfg: Pick<Config, 'claudeAccounts'>): HostRole[] => HOST_ROLES.filter((r) => r !== 'dispatcher' || dispatcherOwnAccount(cfg));

/**
 * How many live processes run on the credential `key` (SessionInfo.account), not counting `except`'s own: what the pool's
 * one-at-a-time slot counts. The dispatcher never counts (w996): its reserve is the rule that keeps workers off its token,
 * so its own process must not also fill a pooled token's single slot. It is still named under the token in system_status.
 */
export function liveOnAccount(sessions: Iterable<{ id?: string; account?: string; status?: string; kind?: string; orchestratorRole?: string }>, key: string, except?: string): number {
  let n = 0;
  for (const s of sessions) {
    if (s.id === except || s.account !== key || s.status === 'stopped' || s.status === 'error') continue;
    if (s.kind === 'orchestrator' && s.orchestratorRole === 'dispatcher') continue;
    n++;
  }
  return n;
}

/** The role a session on this host runs as (claudeAccounts): the dispatcher's own when it has one, else by its kind. */
export function hostRoleOf(cfg: Pick<Config, 'claudeAccounts'>, info: Pick<SessionInfo, 'kind'> & Partial<Pick<SessionInfo, 'orchestratorRole'>>): HostRole {
  return info.kind === 'orchestrator' && info.orchestratorRole === 'dispatcher' && dispatcherOwnAccount(cfg) ? 'dispatcher' : hostRole(info.kind);
}

/**
 * The environment a Claude process this portal starts begins with: the server's own without any Claude credential
 * (usageEnv), so the vault token put on top is the only one it has.
 */
export const hostBaseEnv = (env: Record<string, string | undefined> = process.env): Record<string, string | undefined> => usageEnv({ ...env });

/** Why nothing starts when there is no vault on this portal (tests, or a portal that never set its context). */
const NO_VAULT = 'the token vault is not loaded on this portal, and every Claude process runs on a vault token (docs/vault.md; w1078: there is no other credential)';

/**
 * Why a person's pool gave no token (w1078): their tokens do not open, or they have none. Every Claude process runs on a vault
 * token, so the run does not start; it never falls back to another credential.
 */
function noTokenWhy(person: string | undefined, s: { poolSize?: number; problems: string[] }, what: string): string {
  if (!person) return `${what} is for nobody, so it has no vault pool to run on (config vault.unattributed names whose tokens work nobody asked for runs on, docs/vault.md)`;
  if ((s.poolSize ?? 0) > 0) return `${person}'s Claude token pool cannot serve ${what}: ${s.problems.join('; ') || 'none of their tokens opens'}. It never runs on another credential; fix the vault (docs/vault.md) and it starts`;
  return `${person} has no Claude token in the vault, so ${what} cannot start: add one with \`sudo fffctl vault add-claude ${person}\` (docs/vault.md, section 4). It never runs on another credential (w1078)`;
}

/** "vault token ben-max …abcd" for a run's account line, safe to show. */
function poolAccount(c: { entry: { name: string; last4: string }; how: 'normal' | 'over-cap' | 'in-reserve' }, person: string | undefined): string {
  return `vault token ${c.entry.name} …${c.entry.last4} (${person ? `${person}'s pool` : 'a pool'}${c.how === 'over-cap' ? ', over its caps: used up first' : c.how === 'in-reserve' ? ", inside the dispatcher's reserve: no other token has room" : ''}, docs/vault.md)`;
}

/**
 * The environment of the dispatcher's process when it is pinned to a vault token (w996): exactly that token as
 * CLAUDE_CODE_OAUTH_TOKEN, every other Claude credential removed first. `undefined` when it is not pinned (it runs on the
 * system payer's pool, poolRunEnv). A pinned token the vault cannot give (no such entry, disabled, or the key does not open
 * it) stops the dispatcher's start with the reason (w1078: no fallback), which the log and system_status show.
 */
export function pinnedDispatcherEnv(cfg: Pick<Config, 'claudeAccounts'>, ctx: VaultContext | undefined = vaultContext()): { env: Record<string, string | undefined>; account: string } | undefined {
  const name = pinnedDispatcherEntry(cfg);
  if (name === undefined) return undefined;
  const got = ctx?.vault.claudeByName(name);
  if (got) return { env: { ...hostBaseEnv(), CLAUDE_CODE_OAUTH_TOKEN: got.token }, account: `vault token ${got.entry.name} …${got.entry.last4} (the dispatcher's, docs/vault.md)` };
  const why = ctx
    ? `the dispatcher is pinned to vault token ${name} (claudeAccounts.dispatcher), but the vault has no usable Claude entry of that name, so it does not start: fix the entry (\`fffctl vault list\`), or pin another`
    : NO_VAULT;
  ctx?.onProblem?.(why);
  throw new PoolHeldError(why);
}

/** What a machine run starts with (machineRunEnv): its environment, whether it drops the daemon's own credentials, and its account for people. */
export interface MachineRunEnv {
  env: Record<string, string>;
  /** Always true since w1078: the daemon drops its own credentials, so the vault token is the run's only one. */
  login: boolean;
  /** "vault token ben-max …abcd (ben's pool, …)", safe to show. */
  account: string;
  /** The vault GitHub entry given as GH_TOKEN (w868), "vault-ben-github …abcd"; absent: the machine's own gh login. */
  github?: string;
  /** Whose pool the token came from. */
  person?: string;
}

/**
 * The Claude token and the vault's secrets a run on a machine gets (docs/vault.md, sections 3 and 4): a token from the
 * vault pool of the person the run is for (the person who last acted on the request, w1031, or config vault.unattributed's
 * for work nobody asked for by name: `run.tokenUser`; else its requester; else the system payer), and every other vault
 * entry granted to the run's role and machine as environment. `login` is true so the daemon's own credentials (an API key in
 * its environment would outrank the token) are dropped and only the token remains. No usable token: the run waits (its pool
 * is held: PoolHeldError with the next reset), or does not start with the reason (no token at all, none opens). It never
 * runs on another credential (w1078: no host token, no machine login, nobody else's pool).
 */
export function machineRunEnv(
  cfg: Pick<Config, 'machines'> & Partial<Pick<Config, 'claudeAccounts'>>,
  machine: MachineRef,
  run: { role: VaultRole; requestedBy?: Requester; sessionId?: string; tokenUser?: string },
  ctx: VaultContext | undefined = vaultContext(),
): MachineRunEnv {
  if (!ctx) throw new PoolHeldError(NO_VAULT);
  const person = run.tokenUser ?? run.requestedBy?.userId ?? ctx.payer?.();
  const wantGithub = githubFromVault(cfg, refId(machine));
  const s = ctx.vault.forRun({ machineId: refId(machine), role: run.role, userId: person, sessionId: run.sessionId }, { claude: true, github: wantGithub, githubUsable: ctx.githubUsable, usageOf: ctx.usageOf, liveOn: ctx.liveOn, limits: ctx.limits, reservedFor: ctx.reservedFor, now: ctx.now });
  for (const p of s.problems) ctx.onProblem?.(p);
  // GitHub (w868): the person's own token, else the machine's own gh login as before; never another person's.
  const github = s.github ? { github: `${s.github.name} …${s.github.last4}` } : {};
  if (s.github) ctx.onGithubUse?.(s.github, `given to a ${run.role} run on ${refId(machine)}${person ? ` for ${person}` : ''}`);
  else if (wantGithub) {
    ctx.onProblem?.(`no usable vault GitHub token for a ${run.role} run on ${refId(machine)}${person ? ` for ${person}` : ''}; it uses the machine's own gh login`);
    ctx.onGithubMissing?.(person, refId(machine), `a ${run.role} run`);
  }
  // GitHub Apps (w1519, docs/github-apps.md): the apps this run may use, by name. Its daemon keeps their installation tokens,
  // and the run's git and gh take one for a repository an app is installed on. Only beside a vault GitHub token: the git
  // credential helper that routes by repository replaces the machine's own helpers, so a run on the machine's login gets none.
  const apps = s.github ? ctx.vault.githubAppsFor({ machineId: refId(machine), role: run.role, userId: person }).map((e) => e.name) : [];
  if (apps.length) s.env.FF_GH_APP_NAMES = apps.join(',');
  if (s.claude) return { env: { ...s.env, CLAUDE_CODE_OAUTH_TOKEN: s.claude.token }, login: true, account: poolAccount(s.claude, person), ...github, ...(person ? { person } : {}) };
  // Every token of the person's is over its caps or used up: the run waits for the first to free up (w739).
  if (s.claudeHold) throw new PoolHeldError(`${person ?? 'this run'}'s Claude token pool is held: ${s.claudeHold.why}`, s.claudeHold.next);
  const why = noTokenWhy(person, s, `a ${run.role} run on ${refId(machine)}`);
  ctx.onProblem?.(why);
  throw new PoolHeldError(why);
}

/**
 * The environment of a portal-side Claude process for a person (w738): their own orchestrator ("orchestrator"), the
 * orchestration worker working for them ("ops"), or the dispatcher on the system payer's pool when it is pinned to no token.
 * Exactly that person's pool token as CLAUDE_CODE_OAUTH_TOKEN, every other Claude credential removed, picked now so a new
 * token applies to the next session start. All their tokens capped: an orchestrator and the ops worker use the pool up past
 * the caps (w1112: the ops worker is never held by them, like the dispatcher) and stop only once every token is used up;
 * no token at all, or none opens: the start fails with the reason (w1078: no fallback). Each throws PoolHeldError, and the
 * session start shows it.
 */
export function poolRunEnv(run: { role: 'orchestrator' | 'ops'; personId: string | undefined; sessionId?: string }, ctx: VaultContext | undefined = vaultContext()): { env: Record<string, string | undefined>; account: string } {
  if (!ctx) throw new PoolHeldError(NO_VAULT);
  const what = run.role === 'ops' ? 'the orchestration worker' : 'an orchestrator';
  if (!run.personId) throw new PoolHeldError(noTokenWhy(undefined, { problems: [] }, what));
  const s = ctx.vault.forRun({ machineId: 'portal', role: run.role, userId: run.personId, sessionId: run.sessionId }, { claude: true, usageOf: ctx.usageOf, liveOn: ctx.liveOn, limits: ctx.limits, reservedFor: ctx.reservedFor, now: ctx.now });
  for (const p of s.problems) ctx.onProblem?.(p);
  if (s.claude) return { env: { ...hostBaseEnv(), CLAUDE_CODE_OAUTH_TOKEN: s.claude.token }, account: poolAccount(s.claude, run.personId) };
  // Only a pool whose every token is used up gets here (pickPool's use-it-up for both roles): Claude would refuse them all.
  if (s.claudeHold) {
    const stop = run.role === 'ops' ? ", so the orchestration worker cannot start until a token resets (Claude refuses a used-up token; the pool's limits never hold it, w1112)" : '';
    throw new PoolHeldError(`${run.personId}'s Claude token pool is used up${stop}: ${s.claudeHold.why}`, s.claudeHold.next);
  }
  const why = noTokenWhy(run.personId, s, what);
  ctx.onProblem?.(why);
  throw new PoolHeldError(why);
}

// ---------------------------------------------------------------- the dispatcher's reserve (w739)

/** A credential kept back for one role: the dispatcher's pinned vault token. */
export interface ReservedCredential {
  /** The usage meters' key (tokenKey). */
  key: string;
  /** "the dispatcher's vault token vault-lothsahn-1 …dAAA" */
  what: string;
  role: 'dispatcher';
  /** Whose pool the token is in: its vault entry's owner (Vault.pools groups by it), absent when it has none (w1108). */
  person?: string;
}

/**
 * The credentials with a reserve, worked out from config now (never a fixed token): the vault token the dispatcher is pinned
 * to (w996). Unpinned, the dispatcher runs on the system payer's pool, whose own limits hold it like anyone's: no reserve.
 */
export function reservedCredentials(cfg: Pick<Config, 'claudeAccounts'>, ctx: Pick<VaultContext, 'vault'> | undefined = vaultContext()): ReservedCredential[] {
  const pinned = pinnedDispatcherEntry(cfg);
  const got = pinned !== undefined ? ctx?.vault.claudeByName(pinned) : undefined;
  return got ? [{ key: tokenKey(got.token), what: `the dispatcher's vault token ${got.entry.name} …${got.entry.last4}`, role: 'dispatcher', ...(got.entry.owner ? { person: got.entry.owner.toLowerCase() } : {}) }] : [];
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
 * run into it up to 100%, nothing here ever holds the dispatcher. Other runs landing on it (its pool's own runs when no other
 * token has room) are not refused: the warning says they are using the buffer. `othersOn`: how many live sessions other
 * than the owner's run on a credential key.
 */
export function reserveLines(
  cfg: Pick<Config, 'claudeAccounts' | 'vault'>,
  usageOf: (key: string) => PlanUsage | undefined,
  othersOn: (key: string, role: ReservedCredential['role']) => number,
  now = Date.now(),
  ctx?: Pick<VaultContext, 'vault'>,
): ReserveLine[] {
  const limits: PoolLimits = poolLimits(cfg);
  return reservedCredentials(cfg, ctx ?? vaultContext()).map((cred) => {
    const u = usageOf(cred.key);
    const r = reserveOf(u, limits, now);
    const w = u?.weekly;
    const sess = u?.session;
    const name = cred.what.replace(/^the /, '');
    const nums = r.noReading
      ? 'no reading yet (counted as inside its reserve)'
      : `weekly ${Math.round(w?.percent ?? 50)}%, reserve ${Math.round(r.weekly)}% (${r.daysLeft.toFixed(r.daysLeft < 1 ? 1 : 0)} day${Math.round(r.daysLeft) === 1 ? '' : 's'} to reset); 5-hour ${Math.round(sess?.percent ?? 50)}%, reserve ${Math.round(r.session)}%`;
    const others = r.inReserve ? othersOn(cred.key, cred.role) : 0;
    return {
      cred,
      reserve: r,
      line: `${name}: ${nums}${u?.reading ? ` [${u.reading.kind} reading: ${u.reading.why}]` : ''}${r.inReserve ? `; inside its reserve (${reserveReason(r, u, now)}), kept for the dispatcher` : ''}${others ? `; ${others} other run${others === 1 ? '' : 's'} using it` : ''}`,
      ...(others ? { warning: `${name} is the last token with room for ${others} run${others === 1 ? '' : 's'} and is inside the buffer kept for the dispatcher: ${reserveReason(r, u, now)}` } : {}),
    };
  });
}

/** What a worker's brief and list_machines say about the Claude account a machine's runs use (w1078: always a vault token). */
export const MACHINE_ACCOUNT = "a vault token from the pool of the person the work is for (docs/vault.md)";

/**
 * system_status's line on which account each kind of agent runs on (docs/accounts.md), safe to show: every one a vault
 * token (w1078). The dispatcher's pinned token by its last four characters, or why the vault cannot give it.
 */
export function accountSetupLines(cfg: Pick<Config, 'claudeAccounts'>, payer: string | undefined, ctx: Pick<VaultContext, 'vault'> | undefined = vaultContext()): string[] {
  const pinned = pinnedDispatcherEntry(cfg);
  const got = pinned !== undefined ? ctx?.vault.claudeByName(pinned) : undefined;
  const dispatcher =
    pinned === undefined
      ? `the system payer's pool (${payer ?? 'nobody'}; claudeAccounts.dispatcher pins none)`
      : got
        ? `vault token ${got.entry.name} …${got.entry.last4} (pinned; its dispatcher reserve is kept there)`
        : `vault token ${pinned} (pinned, but the vault has no usable Claude entry of that name: the dispatcher does not start until it is fixed)`;
  return [
    `Claude account per agent (every one a vault token, docs/vault.md; w1078: no host token, token file or login): the orchestrators and the orchestration worker on their person's own pool; the dispatcher on ${dispatcher}; workers and standing agents on every machine on the pool of the person their work is for. A person with no usable token waits or is told why; nothing falls back to another credential.`,
  ];
}

/**
 * The dashboard banners for the dispatcher's buffer (w1108, lothsahn: "Please only show the dispatcher message to the
 * operator whose pool that token is in."): one for the person whose vault pool holds the dispatcher's token, never for
 * everyone; a token in nobody's pool goes to each owner instead. The text is reserveLines' own.
 */
export function reserveWarnings(lines: readonly ReserveLine[], owners: readonly string[]): { id: string; kind: 'reserve'; person: string; text: string }[] {
  return lines.flatMap((r) => (r.warning ? (r.cred.person ? [r.cred.person] : owners).map((person) => ({ id: `reserve:${r.cred.key}`, kind: 'reserve' as const, person, text: r.warning! })) : []));
}

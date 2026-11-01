import { HOST_ROLES, pinnedVaultEntry, type ClaudeAccount, type Config, type HostRole } from './config.ts';
import type { Requester, SessionInfo, SessionKind } from '../shared/types.ts';
import { PoolHeldError, isSamePerson, vaultContext, type VaultContext, type VaultRole } from './vault.ts';
import { githubFromVault } from './githubTokens.ts';
import { tokenKey, usageEnv } from './usage.ts';
import { poolLimits, reserveOf, reserveReason, type PoolLimits, type Reserve } from './tokenPool.ts';
import { noSessionLimit, type PlanUsage } from '../shared/types.ts';
import { maybeTokenShape, redactTokenShapes, secretEnvNames } from '../shared/secretShapes.ts';

/**
 * Secrets agents may set but nobody may read back (set_app_config's write-only keys): FFBox's connector token (the Claude
 * tokens are the vault's, w1078). A value is only ever shown as "set (…last 4 chars)", and every transcript event is
 * written (and sent to the UI) with a Claude OAuth token redacted, so neither a tool call nor a pasted message keeps one
 * on disk. Discord bot tokens (and DISCORD_TOKEN / FFDISCORD_APP_TOKEN
 * values) are redacted the same way, and so are provider connector tokens (ffpv1_…, server/providerProtocol.ts).
 * Search reads the transcripts, so it never sees them either.
 */

export { OAUTH_TOKEN, SECRET_ENV } from '../shared/secretShapes.ts';

/** set_app_config keys whose value is never shown. */
export const SECRET_KEYS: ReadonlySet<string> = new Set(['providers.ffbox.token']);

/** How a secret setting reads anywhere: "set (…abcd)" or "not set". */
export const maskSecret = (v: unknown) => (typeof v === 'string' && v ? `set (…${v.slice(-4)})` : 'not set');

const lastFour = (m: string) => m.slice(-4);

/**
 * Values the token vault holds (server/vault.ts, w512) and every other secret a run or the portal is handed, whatever their
 * form and whatever their variable is called (w1688: a worker printed its environment through a filter of its own that hid
 * only names with TOKEN, and FFSTEAM_PASSWORD's value reached Claude Code's transcript): redacted by value, so a secret with
 * no recognisable shape never reaches a transcript, a tool result, a report, a post or a log. Each value is masked as it is
 * and in its common encodings (URL-encoded, base64 and base64url of the bare value, JSON-escaped), all through one regular
 * expression built when the set changes (valueMatcher).
 *
 * MIN_SECRET_LENGTH: a value shorter than 8 characters is not masked by value. Masking every "1234", "true" or "admin" would
 * rewrite ordinary words and numbers all over the transcripts, and the vault already refuses an env secret under 8
 * (server/vault.ts valueProblem). The names of the secrets skipped for it are kept (skippedSecrets), never their values.
 */
export const MIN_SECRET_LENGTH = 8;
/** From this length a mask shows the value's last four characters; a shorter value's mask shows none (4 of 8 is half of it). */
export const SHOW_LAST4_FROM = 16;
/** Values kept: the newest first. Each daemon learns a run's secrets at every launch, so the set is small (tens). */
const MAX_VALUES = 2000;

let knownValues: string[] = [];
/** Bumped whenever a value is learnt that was not known: the transcript scrubbers (server/cliScrub.ts) scan again for it. */
let valuesVersion = 0;
/** For each version, the values new in it (cliScrub's back-scan looks for only those in the files it has already read). */
const added: { version: number; values: string[]; recent: boolean }[] = [];
const skipped = new Set<string>();
let matcher: { re: RegExp; masks: Map<string, string> } | undefined | null = null;
let byteMatcher: { re: RegExp; maxLen: number } | undefined | null = null;

/** The forms a value is masked in, each with its label in the mask (none for the value itself). */
function forms(v: string): [string, string][] {
  const out: [string, string][] = [[v, '']];
  const url = encodeURIComponent(v);
  if (url !== v) out.push([url, 'URL-encoded'], [url.replace(/%[0-9A-F]{2}/g, (s) => s.toLowerCase()), 'URL-encoded'], [url.replace(/%20/g, '+'), 'URL-encoded']);
  const b64 = Buffer.from(v, 'utf8').toString('base64').replace(/=+$/, '');
  out.push([b64, 'base64'], [b64.replace(/\+/g, '-').replace(/\//g, '_'), 'base64']);
  // in a JSON text (a transcript line, redactValue's quick check) a quote, a backslash or a control character is escaped
  for (const [f, label] of [...out]) {
    const json = JSON.stringify(f).slice(1, -1);
    if (json !== f) out.push([json, label]);
  }
  const seen = new Set<string>();
  return out.filter(([f]) => f.length >= MIN_SECRET_LENGTH && !seen.has(f) && !!seen.add(f));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The mask of a value (and of each of its encodings): "[redacted vault secret …abcd]", "[redacted vault secret, base64]". */
const maskOf = (v: string, label: string) => `[redacted vault secret${label ? `, ${label}` : ''}${v.length >= SHOW_LAST4_FROM ? ` …${lastFour(v)}` : ''}]`;

/** One regular expression for every form of every known value, longest first, built once per change of the set. */
function valueMatcher() {
  if (matcher !== null) return matcher;
  const masks = new Map<string, string>();
  for (const v of knownValues) for (const [f, label] of forms(v)) if (!masks.has(f)) masks.set(f, maskOf(v, label));
  const all = [...masks.keys()].sort((a, b) => b.length - a.length);
  matcher = all.length ? { re: new RegExp(all.map(escapeRe).join('|'), 'g'), masks } : undefined;
  return matcher;
}

function setValues(values: string[], recent = false) {
  const before = new Set(knownValues);
  knownValues = values;
  matcher = byteMatcher = null;
  const fresh = values.filter((v) => !before.has(v));
  if (fresh.length) {
    valuesVersion++;
    added.push({ version: valuesVersion, values: fresh, recent });
    while (added.length > 50) added.shift();
  }
  return fresh.length;
}

const usable = (v: unknown): v is string => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH;

/** The values to redact, replacing the ones known (the portal, from its vault at each load and change). */
export function registerSecretValues(values: readonly string[]) {
  setValues([...new Set(values.filter(usable))].slice(0, MAX_VALUES));
}

/**
 * Learn more values to redact without forgetting the ones known (a daemon, from each launch spec it gets). How many were
 * new. `recent`: the values were minted just now (a GitHub App installation token), so no file written before can hold them
 * and the scrubbers need not look back for them.
 */
export function addSecretValues(values: readonly string[], o: { recent?: boolean } = {}): number {
  const fresh = [...new Set(values.filter(usable))].filter((v) => !knownValues.includes(v));
  return fresh.length ? setValues([...fresh, ...knownValues].slice(0, MAX_VALUES), o.recent) : 0;
}

/**
 * Learn the secrets of an environment (a launch spec's, the portal's own): every variable `names` lists (LaunchSpec
 * secretEnv: what the vault granted the run, whatever it is called), every variable whose name says it carries one
 * (SECRET_ENV) and every value shaped like a token. A secret under MIN_SECRET_LENGTH is skipped, and its name kept. How many
 * values were new.
 */
export function addSecretEnv(env: Record<string, string | undefined> | undefined, names: readonly string[] = []): number {
  if (!env) return 0;
  const want = new Set([...names, ...secretEnvNames(env)]);
  const values: string[] = [];
  for (const k of want) {
    const v = env[k];
    if (typeof v !== 'string' || !v) continue;
    if (v.length < MIN_SECRET_LENGTH) skipped.add(k);
    else values.push(v);
  }
  return addSecretValues(values);
}

/** The names of the secrets not masked by value because they are shorter than MIN_SECRET_LENGTH (never their values). */
export const skippedSecrets = (): string[] => [...skipped].sort();

/** What redaction knows: how many values, how many forms of them it masks, and the version of the set. Never a value. */
export function secretValueStats(): { values: number; forms: number; version: number; skipped: string[] } {
  return { values: knownValues.length, forms: valueMatcher()?.masks.size ?? 0, version: valuesVersion, skipped: skippedSecrets() };
}

/** The version of the set of values (bumped by each new one). */
export const secretValuesVersion = () => valuesVersion;

/**
 * The values learnt after `version`, and whether every one of them was minted just now (`recent`): what a back-scan of
 * files already read must look for. `undefined` when that version is too old to tell: look for every value.
 */
export function secretValuesSince(version: number): { values: string[]; recent: boolean } | undefined {
  if (version >= valuesVersion) return { values: [], recent: true };
  const later = added.filter((a) => a.version > version);
  if (!later.length || later[0].version !== version + 1) return undefined;
  const live = new Set(knownValues);
  return { values: [...new Set(later.flatMap((a) => a.values))].filter((v) => live.has(v)), recent: later.every((a) => a.recent) };
}

/**
 * A matcher of the bytes of every form of `values` (default: every known value) as they sit in a UTF-8 file, as a regular
 * expression over the file read as latin1 (one character per byte, so an index is a byte offset), and the longest form in
 * bytes: what server/cliScrub.ts overwrites in place. undefined when there is nothing to look for.
 */
export function secretBytesMatcher(values?: readonly string[]): { re: RegExp; maxLen: number } | undefined {
  if (!values && byteMatcher !== null) return byteMatcher;
  const all = new Set<string>();
  for (const v of values ?? knownValues) for (const [f] of forms(v)) all.add(Buffer.from(f, 'utf8').toString('latin1'));
  const list = [...all].sort((a, b) => b.length - a.length);
  const m = list.length ? { re: new RegExp(list.map(escapeRe).join('|'), 'g'), maxLen: list[0].length } : undefined;
  if (!values) byteMatcher = m;
  return m;
}

/** Whether `text` holds a known value in any form. */
const hasValue = (text: string) => {
  const m = valueMatcher();
  if (!m) return false;
  m.re.lastIndex = 0;
  return m.re.test(text);
};

/** Whether `text` may hold a secret this module redacts (a cheap check before the regexes). */
const maybeSecret = (text: string) => maybeTokenShape(text) || hasValue(text);

/**
 * `text` with its secrets replaced: a value the vault handed out (in any of its forms) by "[redacted vault secret …abcd]",
 * and every token shape (shared/secretShapes.ts) by its kind and last four characters: "github_pat_[redacted …abcd]",
 * "sk-ant-oat01-[redacted …abcd]", "[redacted Discord token …abcd]".
 */
export function redactSecrets(text: string): string {
  let out = text;
  if (hasValue(text)) {
    const m = valueMatcher()!;
    out = text.replace(m.re, (s) => m.masks.get(s) ?? '[redacted vault secret]');
  }
  return maybeTokenShape(out) ? redactTokenShapes(out) : out;
}

/** Every string in `v` (keys too) redacted; the same object where nothing changed. */
function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = redactDeep(x);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const k2 = redactSecrets(k);
      const y = redactDeep(x);
      if (y !== x || k2 !== k) changed = true;
      out[k2] = y;
    }
    return changed ? out : v;
  }
  return v;
}

/**
 * Redact every string inside a record the portal keeps by reference (a session, a work item: w1584), in place, so the
 * object the code holds and the one saved to state.json or work.json stay one. Plain objects and arrays only. Returns
 * how many strings changed.
 */
export function redactInPlace(v: unknown): number {
  let n = 0;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      for (let i = 0; i < x.length; i++) {
        if (typeof x[i] === 'string') {
          const clean = redactSecrets(x[i]);
          if (clean !== x[i]) (x[i] = clean), n++;
        } else walk(x[i]);
      }
    } else if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      const o = x as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        const y = o[k];
        if (typeof y === 'string') {
          const clean = redactSecrets(y);
          if (clean !== y) (o[k] = clean), n++;
        } else walk(y);
      }
    }
  };
  walk(v);
  return n;
}

/**
 * A value (a transcript event) with its secrets redacted; the same object when there are none. Each string is redacted
 * on its own (w1584): redacting the event's JSON text missed a token after an escape (`\nghp_…`).
 */
export function redactValue<T>(v: T): T {
  const json = JSON.stringify(v);
  if (!json || !maybeSecret(json)) return v;
  const plain = JSON.parse(json) as unknown;
  const clean = redactDeep(plain);
  return clean === plain ? v : (clean as T);
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

/** "vault token ben-max …abcd" for a run's account line, safe to show; `forWhom` when the pool is not the run's person's own (w1717). */
function poolAccount(c: { entry: { name: string; last4: string }; how: 'normal' | 'over-cap' | 'in-reserve' }, person: string | undefined, forWhom?: string): string {
  return `vault token ${c.entry.name} …${c.entry.last4} (${person ? `${person}'s pool` : 'a pool'}${forWhom ? `, for ${forWhom}'s work by their pool setting` : ''}${c.how === 'over-cap' ? ', over its caps: used up first' : c.how === 'in-reserve' ? ", inside the dispatcher's reserve: no other token has room" : ''}, docs/vault.md)`;
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
  /** The person the run is for: whose GitHub token it got, and whose pool setting picked the Claude pool (SessionInfo.ranFor). */
  person?: string;
  /** Whose pool the Claude token came from, when it is not `person`'s own (w1717). */
  pool?: string;
  /** The variables of `env` that hold a secret the vault gave (w1688): the daemon masks their values whatever they are called. */
  secretEnv: string[];
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
  // w1717: the Claude token comes from the pool the person's setting names (their own unless they picked another's); the
  // GitHub token and the other secrets stay theirs. That pool's own caps, reserve and stop line apply; held, the run waits.
  const pool = person ? (ctx.poolOf?.(person) ?? person) : undefined;
  const other = !!pool && !isSamePerson(pool, person);
  const wantGithub = githubFromVault(cfg, refId(machine));
  const s = ctx.vault.forRun({ machineId: refId(machine), role: run.role, userId: person, ...(other ? { claudeOwner: pool } : {}), sessionId: run.sessionId }, { claude: true, github: wantGithub, githubUsable: ctx.githubUsable, usageOf: ctx.usageOf, liveOn: ctx.liveOn, limits: ctx.limits, reservedFor: ctx.reservedFor, now: ctx.now });
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
  const secretEnv = [...Object.keys(s.env), 'CLAUDE_CODE_OAUTH_TOKEN'];
  const apps = s.github ? ctx.vault.githubAppsFor({ machineId: refId(machine), role: run.role, userId: person }).map((e) => e.name) : [];
  if (apps.length) s.env.FF_GH_APP_NAMES = apps.join(',');
  if (s.claude) return { env: { ...s.env, CLAUDE_CODE_OAUTH_TOKEN: s.claude.token }, login: true, account: poolAccount(s.claude, pool, other ? person : undefined), secretEnv, ...github, ...(person ? { person } : {}), ...(other ? { pool } : {}) };
  // Every token of the pool is over its caps or used up: the run waits for the first to free up (w739); never on another pool.
  const forWhom = other ? ` (${person}'s work runs on ${pool}'s pool: their pool setting, w1717)` : '';
  if (s.claudeHold) throw new PoolHeldError(`${pool ?? 'this run'}'s Claude token pool is held${forWhom}: ${s.claudeHold.why}`, s.claudeHold.next);
  const why = noTokenWhy(pool, s, `a ${run.role} run on ${refId(machine)}${other ? ` for ${person}` : ''}`) + (other ? `; ${person}'s pool setting picks ${pool}'s pool (w1717): set it back to self in Settings` : '');
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
 * session start shows it. w1717: the pool is the one the person's pool setting names (their own unless they picked another's),
 * with the same rules there as on their own.
 */
export function poolRunEnv(run: { role: 'orchestrator' | 'ops'; personId: string | undefined; sessionId?: string }, ctx: VaultContext | undefined = vaultContext()): { env: Record<string, string | undefined>; account: string } {
  if (!ctx) throw new PoolHeldError(NO_VAULT);
  const what = run.role === 'ops' ? 'the orchestration worker' : 'an orchestrator';
  if (!run.personId) throw new PoolHeldError(noTokenWhy(undefined, { problems: [] }, what));
  const pool = ctx.poolOf?.(run.personId) ?? run.personId;
  const other = !isSamePerson(pool, run.personId);
  const s = ctx.vault.forRun({ machineId: 'portal', role: run.role, userId: run.personId, ...(other ? { claudeOwner: pool } : {}), sessionId: run.sessionId }, { claude: true, usageOf: ctx.usageOf, liveOn: ctx.liveOn, limits: ctx.limits, reservedFor: ctx.reservedFor, now: ctx.now });
  for (const p of s.problems) ctx.onProblem?.(p);
  if (s.claude) return { env: { ...hostBaseEnv(), CLAUDE_CODE_OAUTH_TOKEN: s.claude.token }, account: poolAccount(s.claude, pool, other ? run.personId : undefined) };
  // Only a pool whose every token is used up gets here (pickPool's use-it-up for both roles): Claude would refuse them all.
  if (s.claudeHold) {
    const stop = run.role === 'ops' ? ", so the orchestration worker cannot start until a token resets (Claude refuses a used-up token; the pool's limits never hold it, w1112)" : '';
    const forWhom = other ? ` (${run.personId}'s work runs on ${pool}'s pool: their pool setting, w1717)` : '';
    throw new PoolHeldError(`${pool}'s Claude token pool is used up${forWhom}${stop}: ${s.claudeHold.why}`, s.claudeHold.next);
  }
  const why = noTokenWhy(pool, s, `${what}${other ? ` for ${run.personId}` : ''}`) + (other ? `; ${run.personId}'s pool setting picks ${pool}'s pool (w1717): set it back to self in Settings` : '');
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
    const name = cred.what.replace(/^the /, '');
    const nums = r.noReading
      ? 'no reading yet (counted as inside its reserve)'
      : `weekly ${w ? `${Math.round(w.percent)}%` : 'unknown'}, reserve ${Math.round(r.weekly)}% (${r.daysLeft.toFixed(r.daysLeft < 1 ? 1 : 0)} day${Math.round(r.daysLeft) === 1 ? '' : 's'} to reset)${noSessionLimit(u) ? '' : `; 5-hour ${u?.session ? `${Math.round(u.session.percent)}%` : 'unknown'}, reserve ${Math.round(r.session)}%`}`;
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

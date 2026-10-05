import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOST_ROLES, roleNames, type ClaudeAccount, type Config, type HostRole } from './config.ts';
import type { SessionInfo, SessionKind } from '../shared/types.ts';
import { credentialsFile, loginUnusable, readStoredLogin, usageEnv } from './usage.ts';
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

/** Whether `text` may hold a secret this module redacts (a cheap check before the regexes). */
const maybeSecret = (text: string) => text.includes('sk-ant-oat01-') || text.includes('ffpv1_') || /DISCORD|\.[A-Za-z0-9_-]{6}\./.test(text);

/**
 * `text` with its secrets replaced: a Claude OAuth token by "sk-ant-oat01-[redacted …abcd]", a Discord bot token
 * by "[redacted Discord token …abcd]", and the value of DISCORD_TOKEN / FFDISCORD_APP_TOKEN by "[redacted …abcd]".
 */
export function redactSecrets(text: string): string {
  if (!maybeSecret(text)) return text;
  return text
    .replace(OAUTH_TOKEN_ANYWHERE, (m) => `sk-ant-oat01-[redacted …${lastFour(m)}]`)
    .replace(PROVIDER_TOKEN_ANYWHERE, (m) => `ffpv1_[redacted …${lastFour(m)}]`)
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
export const hostRole = (kind: SessionKind): HostRole => (kind === 'orchestrator' ? 'orchestrator' : kind === 'standing' ? 'standing' : 'workers');

/** The account this host's agents of `role` run on (config claudeAccounts; default the token; the dispatcher, unset: the orchestrator's). */
export function hostAccount(cfg: Pick<Config, 'claudeAccounts'>, role: HostRole): ClaudeAccount {
  const v = cfg.claudeAccounts?.[role] ?? (role === 'dispatcher' ? cfg.claudeAccounts?.orchestrator : undefined);
  return v === 'login' ? 'login' : 'token';
}

/** Whether the dispatcher has an account of its own (config claudeAccounts.dispatcher, w464): it then ignores the system payer's own token. */
export const dispatcherOwnAccount = (cfg: Pick<Config, 'claudeAccounts'>) => cfg.claudeAccounts?.dispatcher !== undefined;

/** The roles worth naming apart: the dispatcher only when it has an account of its own (else it is the orchestrator's). */
export const shownRoles = (cfg: Pick<Config, 'claudeAccounts'>): HostRole[] => HOST_ROLES.filter((r) => r !== 'dispatcher' || dispatcherOwnAccount(cfg));

/** The role a session on this host runs as (claudeAccounts): the dispatcher's own when it has one, else by its kind. */
export function hostRoleOf(cfg: Pick<Config, 'claudeAccounts'>, info: Pick<SessionInfo, 'kind'> & Partial<Pick<SessionInfo, 'orchestratorRole'>>): HostRole {
  return info.kind === 'orchestrator' && info.orchestratorRole === 'dispatcher' && dispatcherOwnAccount(cfg) ? 'dispatcher' : hostRole(info.kind);
}

/**
 * Config claudeEnv as a host agent of `role` gets it: whole ("token"), or without its credentials ("login"), so
 * the agent falls back to the claude.ai login stored on this host. Its other variables (CLAUDE_CONFIG_DIR…) stay.
 */
export function hostClaudeEnv(cfg: Pick<Config, 'claudeAccounts' | 'claudeEnv'>, role: HostRole): Record<string, string> {
  const env = { ...cfg.claudeEnv };
  return hostAccount(cfg, role) === 'login' ? usageEnv(env) : env;
}

/**
 * The whole environment a Claude process of `role` starts with on this host: the server's own with config
 * claudeEnv over it, and for "login" without any credential, as the usage meters read the host login
 * (server/usage.ts refresh), so what they show as "<host> login" is what the agent runs on.
 */
export function hostProcessEnv(cfg: Pick<Config, 'claudeAccounts' | 'claudeEnv'>, role: HostRole, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const all = { ...env, ...cfg.claudeEnv };
  return hostAccount(cfg, role) === 'login' ? usageEnv(all) : all;
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
 * system_status's lines on which account each kind of agent runs on (docs/accounts.md), safe to show: this
 * host's roles, then every machine. `hostName`: this host, `hostToken`: the token its agents would get (usage.ts
 * hostToken), `people`: display names of those with their own token, which wins for work they asked for.
 */
export function accountSetupLines(cfg: Pick<Config, 'claudeAccounts' | 'claudeEnv' | 'machines'>, hostName: string, hostToken: string | undefined, machineIds: MachineRef[], people: string[] = []): string[] {
  const here = (role: HostRole) => (hostAccount(cfg, role) === 'login' || !hostToken ? `${hostName} login` : `host token …${hostToken.slice(-4)}`);
  const logins = shownRoles(cfg).filter((r) => hostAccount(cfg, r) === 'login');
  const problem = logins.length ? hostLoginProblem(cfg) : undefined;
  return [
    `Claude account per agent (config claudeAccounts, machines.useHostClaudeEnv): ${shownRoles(cfg).map((r) => `${roleNames([r])} here: ${here(r)}`).join('; ')}${machineIds.length ? `; ${machineIds.map((m) => `agents on ${refId(m)}: ${accountSource(cfg, m).replace(/ \(.*\)$/, '')}`).join('; ')}` : ''}${people.length ? `; work asked for by ${people.join(', ')}: their own token` : ''}`,
    ...(problem ? [`WARNING: set to the ${hostName} login (${roleNames(logins)}), which cannot run agents: ${problem}`] : []),
  ];
}

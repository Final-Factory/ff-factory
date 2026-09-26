import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';

/**
 * Secrets agents may set but nobody may read back (set_app_config's write-only keys): the Claude OAuth token
 * the agents run on. The value is only ever shown as "set (…last 4 chars)", and every transcript event is
 * written (and sent to the UI) with such a token redacted, so neither the orchestrator's own tool call that
 * set it nor a pasted message keeps it on disk. Discord bot tokens (and DISCORD_TOKEN / FFDISCORD_APP_TOKEN
 * values) are redacted the same way. Search reads the transcripts, so it never sees them either.
 */

/** A Claude Code OAuth token (`claude setup-token`). */
export const OAUTH_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;
const OAUTH_TOKEN_ANYWHERE = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/g;

/** set_app_config keys whose value is never shown. */
export const SECRET_KEYS: ReadonlySet<string> = new Set(['claudeEnv.CLAUDE_CODE_OAUTH_TOKEN']);

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
const maybeSecret = (text: string) => text.includes('sk-ant-oat01-') || /DISCORD|\.[A-Za-z0-9_-]{6}\./.test(text);

/**
 * `text` with its secrets replaced: a Claude OAuth token by "sk-ant-oat01-[redacted …abcd]", a Discord bot token
 * by "[redacted Discord token …abcd]", and the value of DISCORD_TOKEN / FFDISCORD_APP_TOKEN by "[redacted …abcd]".
 */
export function redactSecrets(text: string): string {
  if (!maybeSecret(text)) return text;
  return text
    .replace(OAUTH_TOKEN_ANYWHERE, (m) => `sk-ant-oat01-[redacted …${lastFour(m)}]`)
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
      fs.writeFileSync(file + '.tmp', clean);
      fs.renameSync(file + '.tmp', file);
      n++;
    } catch {
      // being written, or gone: the next start tries again
    }
  }
  return n;
}

/** Whether portal-run agents on `machineId` get this host's claudeEnv (config machines.useHostClaudeEnv; default yes). */
export function usesHostClaudeEnv(cfg: Pick<Config, 'machines'>, machineId: string): boolean {
  const u = cfg.machines?.useHostClaudeEnv;
  if (u === undefined) return true;
  if (typeof u === 'boolean') return u;
  return u[machineId] ?? true;
}

/**
 * The Claude env a portal-run agent on `machineId` runs with: this host's claudeEnv (with
 * CLAUDE_CODE_OAUTH_TOKEN, it overrides the Mac's keychain login for that agent only), or nothing (the Mac's
 * own login). It travels in the launch spec over the authenticated daemon channel and is never logged.
 */
export function hostClaudeEnvFor(cfg: Pick<Config, 'machines' | 'claudeEnv'>, machineId: string): Record<string, string> {
  return usesHostClaudeEnv(cfg, machineId) ? { ...cfg.claudeEnv } : {};
}

/** Which Claude account a machine's portal-run agents use, safe to show: "host token …abcd" or "Mac login". */
export function accountSource(cfg: Pick<Config, 'machines' | 'claudeEnv'>, machineId: string): string {
  const token = hostClaudeEnvFor(cfg, machineId).CLAUDE_CODE_OAUTH_TOKEN;
  return token ? `host token …${token.slice(-4)}` : "Mac login (the Mac's own Claude Code login)";
}

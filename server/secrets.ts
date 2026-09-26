import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';

/**
 * Secrets agents may set but nobody may read back (set_app_config's write-only keys): the Claude OAuth token
 * the agents run on. The value is only ever shown as "set (…last 4 chars)", and every transcript event is
 * written (and sent to the UI) with such a token redacted, so neither the orchestrator's own tool call that
 * set it nor a pasted message keeps it on disk.
 */

/** A Claude Code OAuth token (`claude setup-token`). */
export const OAUTH_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;
const OAUTH_TOKEN_ANYWHERE = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/g;

/** set_app_config keys whose value is never shown. */
export const SECRET_KEYS: ReadonlySet<string> = new Set(['claudeEnv.CLAUDE_CODE_OAUTH_TOKEN']);

/** How a secret setting reads anywhere: "set (…abcd)" or "not set". */
export const maskSecret = (v: unknown) => (typeof v === 'string' && v ? `set (…${v.slice(-4)})` : 'not set');

/** `text` with every OAuth token replaced by "sk-ant-oat01-[redacted …abcd]". */
export function redactSecrets(text: string): string {
  return text.includes('sk-ant-oat01-') ? text.replace(OAUTH_TOKEN_ANYWHERE, (m) => `sk-ant-oat01-[redacted …${m.slice(-4)}]`) : text;
}

/** A value (a transcript event) with its secrets redacted; the same object when there are none. */
export function redactValue<T>(v: T): T {
  const json = JSON.stringify(v);
  if (!json || !json.includes('sk-ant-oat01-')) return v;
  return JSON.parse(redactSecrets(json)) as T;
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
      if (!text.includes('sk-ant-oat01-')) continue;
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

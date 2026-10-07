import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CLEANUP, DEFAULT_USAGE_POLL_MINUTES, LOOP_GUARD_RANGE, ROOT, TOKEN_FILE_ROLES, VOICE_DEFAULTS, type ClaudeAccount, type Config, type HostRole, type IntakeConfig } from './config.ts';
import { OAUTH_TOKEN, SECRET_KEYS, hostLoginProblem, maskSecret, readTokenFile } from './secrets.ts';
import { PROVIDER_TOKEN, tokenSha256 } from './providerProtocol.ts';
import { USER_ID } from './identity.ts';
import { writeFileDurable } from './durable.ts';
import { refuseInDryRun } from './dryRun.ts';
import { placeId } from './placement.ts';
import { DEV_DEFAULTS, type DevRequestsConfig } from './devRequests.ts';
import { STALE_OUTPUT_DEFAULTS, staleOutputSettings, type StaleOutputSettings } from './staleOutput.ts';
import { AUTO_COMPACT_LIMITS } from './autoCompact.ts';

/**
 * The config.json keys an agent may change (the set_app_config tool). Only cosmetic ones, plus the public
 * commit identity (which names the identity to use; noreply addresses are always accepted): nothing that
 * touches paths, permissions, models or the network (the capacity limits below are bounded). Each applies to the running server at once
 * (the config object is shared; guards read it when a session starts) and is written to config.json.
 */
export const SETTABLE_KEYS = [
  'ownerName',
  'voice.vocabulary',
  'voice.ttsVoice',
  'publicGitIdentity.name',
  'publicGitIdentity.email',
  // The host guard's housekeeping (docs/self-recovery.md), so it can be tuned without anyone at the desk.
  'hostGuard.devDriveVhdx',
  'hostGuard.cleanup.ageRules',
  // The continuous clean-up's pace and soft threshold, on this host and on the machines (optional `machine`).
  'hostGuard.cleanup.everyMinutes',
  'hostGuard.cleanup.softFreeGB',
  'machines.cleanup.everyMinutes',
  'machines.cleanup.softFreeGB',
  // The stale build and run output rules (w459, server/staleOutput.ts): this host's, and every machine's.
  'hostGuard.cleanup.staleOutput',
  'machines.cleanup.staleOutput',
  // How often every Claude account's plan usage is polled, here and by the machines' daemons (the endpoint rate-limits).
  'usagePollMinutes',
  // The address machines and the outside watchdog reach this portal at (the Tailscale Funnel URL).
  'publicUrl',
  // The Claude account the agents run on (claude setup-token): write-only, never shown (server/secrets.ts).
  'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN',
  // A person's own Claude account, for agents working for them (docs/identity.md): write-only, needs `user`.
  'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN',
  // Which account this host's agents run on, per role: "token" (claudeEnv's) or "login" (this host's stored
  // claude.ai login), and whether a Mac's agents take the host token (optional `machine`). docs/accounts.md.
  'claudeAccounts.orchestrator',
  // The dispatcher's own (w464); unset, it follows the orchestrator's (and the system payer's own token).
  'claudeAccounts.dispatcher',
  'claudeAccounts.workers',
  // The file holding the token the "tokenfile" roles run on (w464): a path, checked by reading it; its content is never shown.
  'claudeTokenFile',
  'machines.useHostClaudeEnv',
  // Whether a machine's runs take their Claude token from the token vault (docs/vault.md, w512; optional `machine`). The owner's only.
  'machines.claudeFromVault',
  // Who automatic work (scheduled standing runs, intake-triggered FFBox work) is attributed and billed to.
  'systemPayer',
  // Files people attach to messages (docs/attachments.md): the largest one, and how long one nobody sends on is kept.
  'attachments.maxMB',
  'attachments.retentionDays',
  // FFBox's connector (docs/ffbox-integration.md): whether it may connect (default off), and its token,
  // write-only: only its SHA-256 is stored, as providers.ffbox.tokenSha256.
  'providers.ffbox.enabled',
  'providers.ffbox.token',
  // FFBox dev requests (docs/ffbox.md, "Dev requests"): the switch and caps. The owner's only (OWNER_ONLY_KEYS). Which
  // person a request is for is FFBox's operator name, the login of the same name: nothing to set here.
  'providers.ffbox.devRequests',
  // The FFBox intake (docs/intake.md): its whole block at once, the owner's only (OWNER_ONLY_KEYS).
  'intake.ffbox',
  // Who may approve or decline intake requests (docs/intake.md): login names known to identity. The owner's only.
  'intake.reviewers',
  // Where new game-repo work goes first, and which computers it stays off (w428, docs/machines.md "Placing work").
  'placement.prefer',
  'placement.avoid',
  // When the orchestrators compact their conversations by themselves (w535, server/autoCompact.ts): the context in
  // tokens, and a turn's cost in USD. 0 turns either trigger off.
  'orchestrator.compactAtTokens',
  'orchestrator.compactAtTurnUsd',
  // The orchestrators' loop guards (w571, server/orchestrators.ts loopGuards): budgets a person's own message starts again.
  'orchestrator.filingsPerMessage',
  'orchestrator.followUpsPerMessage',
  'orchestrator.messagesPerPerson',
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

/** Placement names machines only: the portal holds no sandboxes of its own (w510), so "this host" is no place for work. */
const NO_HOST = '; "this host" is no place for work any more (w510): name this host\'s own daemon (e.g. "beast")';

/** Keys only an owner may set (docs/identity.md roles): what the intake files and starts by itself. */
export const OWNER_ONLY_KEYS: ReadonlySet<SettableKey> = new Set(['intake.ffbox', 'intake.reviewers', 'providers.ffbox.devRequests', 'machines.claudeFromVault']);

const FFBOX_INTAKE_FLAGS = ['enabled', 'branches', 'diagnoses', 'requests', 'boardCheck', 'escalations'] as const;
const FFBOX_INTAKE_KEYS = [...FFBOX_INTAKE_FLAGS, 'repo', 'dailyCap', 'match', 'autoApprove', 'desync'];
const GITHUB_REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** A value given as an object or its JSON text. */
function objectOf(value: unknown, key: string, example: string): Record<string, unknown> {
  let o = value;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      throw new Error(`${key} is an object (or its JSON), e.g. ${example}`);
    }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error(`${key} is an object, e.g. ${example}`);
  return o as Record<string, unknown>;
}

/**
 * intake.reviewers as set_app_config takes it (a list of user ids, one comma-separated string, or its JSON): each must be
 * a login in `users`, stored in the login's own spelling, no duplicates. The whole list is replaced; `null` removes it
 * (the owner decides alone).
 */
export function checkReviewers(value: unknown, users: readonly string[]): string[] {
  let list = value;
  if (typeof list === 'string') {
    const t = list.trim();
    if (t.startsWith('[')) {
      try {
        list = JSON.parse(t);
      } catch {
        throw new Error('intake.reviewers is a list of user ids, e.g. ["ben", "lothsahn"]');
      }
    } else list = t.split(',');
  }
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) throw new Error('intake.reviewers is a list of user ids, e.g. ["ben", "lothsahn"]');
  const ids = (list as string[]).map((id) => id.trim()).filter(Boolean);
  if (!ids.length) throw new Error('intake.reviewers needs at least one user id; use null to remove it (then only the owner decides)');
  if (ids.length > 20) throw new Error('intake.reviewers: at most 20 user ids');
  const out: string[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const known = users.find((u) => u.toLowerCase() === id.toLowerCase());
    if (!known) unknown.push(JSON.stringify(id.slice(0, 40)));
    else if (!out.includes(known)) out.push(known);
  }
  if (unknown.length) throw new Error(`intake.reviewers: no login ${unknown.join(', ')}; the logins are ${users.join(', ') || '(none)'}`);
  return out;
}

const DEV_REQUEST_KEYS = ['enabled', 'perHour', 'maxFiles', 'maxRequestMB'];

/** providers.ffbox.devRequests: the whole block, unknown keys refused (server/devRequests.ts devSettings fills the rest). */
export function checkDevRequests(value: unknown): DevRequestsConfig {
  const r = objectOf(value, 'providers.ffbox.devRequests', '{ "enabled": true, "perHour": 20 }');
  const unknown = Object.keys(r).filter((k) => !DEV_REQUEST_KEYS.includes(k));
  if (unknown.length) throw new Error(`providers.ffbox.devRequests: unknown key(s) ${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}; known: ${DEV_REQUEST_KEYS.join(', ')}`);
  const out: DevRequestsConfig = {};
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') throw new Error('providers.ffbox.devRequests.enabled is true or false');
    out.enabled = r.enabled;
  }
  const whole = (k: 'perHour' | 'maxFiles' | 'maxRequestMB', lo: number, hi: number) => {
    if (r[k] === undefined) return;
    if (!Number.isInteger(r[k]) || (r[k] as number) < lo || (r[k] as number) > hi) throw new Error(`providers.ffbox.devRequests.${k} is a whole number from ${lo} to ${hi}`);
    out[k] = r[k] as number;
  };
  whole('perHour', 0, 1000);
  whole('maxFiles', 0, DEV_DEFAULTS.maxFiles);
  whole('maxRequestMB', 1, DEV_DEFAULTS.maxRequestMB);
  return out;
}

/**
 * intake.ffbox as set_app_config takes it (an object, or its JSON): known keys only, each of its type and range, the
 * ranges intakeRules.ts intakeSettings() clamps to. The whole block is replaced, so a key left out takes its default.
 */
export function checkFfboxIntake(value: unknown): NonNullable<IntakeConfig['ffbox']> {
  let o = value;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      throw new Error('intake.ffbox is an object (or its JSON), e.g. { "enabled": true, "boardCheck": true }');
    }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error('intake.ffbox is an object, e.g. { "enabled": true, "boardCheck": true }');
  const r = o as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !FFBOX_INTAKE_KEYS.includes(k));
  if (unknown.length) throw new Error(`intake.ffbox: unknown key(s) ${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}; known: ${FFBOX_INTAKE_KEYS.join(', ')}`);
  const out: NonNullable<IntakeConfig['ffbox']> = {};
  for (const k of FFBOX_INTAKE_FLAGS) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== 'boolean') throw new Error(`intake.ffbox.${k} is true or false`);
    out[k] = r[k];
  }
  if (r.repo !== undefined) {
    if (typeof r.repo !== 'string' || !GITHUB_REPO.test(r.repo.trim())) throw new Error('intake.ffbox.repo is a GitHub owner/name, e.g. "Final-Factory/FinalFactory"');
    out.repo = r.repo.trim();
  }
  if (r.dailyCap !== undefined) {
    if (!Number.isInteger(r.dailyCap) || (r.dailyCap as number) < 0 || (r.dailyCap as number) > 200) throw new Error('intake.ffbox.dailyCap is a whole number from 0 to 200');
    out.dailyCap = r.dailyCap as number;
  }
  if (r.match !== undefined) {
    // board_check's bands (server/boardMatch.ts thresholdsOf): numbers from 0 to 1, medium at most high.
    const m = r.match;
    if (typeof m !== 'object' || m === null || Array.isArray(m)) throw new Error('intake.ffbox.match is an object: { "high": 0.7, "medium": 0.45 }');
    const mm = m as Record<string, unknown>;
    const bad = Object.keys(mm).filter((k) => k !== 'high' && k !== 'medium');
    if (bad.length) throw new Error(`intake.ffbox.match: unknown key(s) ${bad.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}; known: high, medium`);
    out.match = {};
    for (const k of ['high', 'medium'] as const) {
      if (mm[k] === undefined) continue;
      if (typeof mm[k] !== 'number' || !Number.isFinite(mm[k]) || (mm[k] as number) < 0 || (mm[k] as number) > 1) throw new Error(`intake.ffbox.match.${k} is a number from 0 to 1`);
      out.match[k] = mm[k] as number;
    }
    if (out.match.high !== undefined && out.match.medium !== undefined && out.match.medium > out.match.high) throw new Error('intake.ffbox.match.medium is at most match.high');
  }
  if (r.autoApprove !== undefined) out.autoApprove = enabledPerDay('autoApprove', r.autoApprove, '{ "enabled": false, "maxPerDay": 3 }');
  // The FFBox desync PR policy (w358): on unless switched off.
  if (r.desync !== undefined) out.desync = enabledPerDay('desync', r.desync, '{ "enabled": true, "maxPerDay": 10 }');
  return out;
}

/** An intake.ffbox sub-block of the form { enabled, maxPerDay } (autoApprove, desync), checked. */
function enabledPerDay(name: string, a: unknown, example: string): { enabled?: boolean; maxPerDay?: number } {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new Error(`intake.ffbox.${name} is an object: ${example}`);
  const aa = a as Record<string, unknown>;
  const bad = Object.keys(aa).filter((k) => k !== 'enabled' && k !== 'maxPerDay');
  if (bad.length) throw new Error(`intake.ffbox.${name}: unknown key(s) ${bad.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}; known: enabled, maxPerDay`);
  const out: { enabled?: boolean; maxPerDay?: number } = {};
  if (aa.enabled !== undefined) {
    if (typeof aa.enabled !== 'boolean') throw new Error(`intake.ffbox.${name}.enabled is true or false`);
    out.enabled = aa.enabled;
  }
  if (aa.maxPerDay !== undefined) {
    if (!Number.isInteger(aa.maxPerDay) || (aa.maxPerDay as number) < 0 || (aa.maxPerDay as number) > 100) throw new Error(`intake.ffbox.${name}.maxPerDay is a whole number from 0 to 100`);
    out.maxPerDay = aa.maxPerDay as number;
  }
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

// Windows paths ("C:/x", "\\\\server\\x") are judged as Windows paths on any OS (CI runs on Linux too).
const P = (p: string) => (/^[a-zA-Z]:[\\/]|^\\\\/.test(p) ? path.win32 : path);
const normPath = (p: string) => P(p).resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (p: string, root: string) => normPath(p) === normPath(root) || normPath(p).startsWith(normPath(root) + '/');

/**
 * Age rules delete old entries in a folder, so the folder must be a specific one: absolute, not a drive root
 * or the home folder itself, and not overlapping this app, its data, the sandboxes, the game's base clone or
 * any protected path.
 */
export function checkAgeRules(value: unknown, cfg?: Pick<Config, 'protectedPaths' | 'sandboxRoot' | 'standingRoot' | 'dataDir' | 'repo'>): { path: string; olderThanDays: number }[] {
  const list = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(list) || list.length > 20) throw new Error('hostGuard.cleanup.ageRules is a list (at most 20) of { "path": "C:/abs/folder", "olderThanDays": 14 }');
  const off = cfg ? [...cfg.protectedPaths, cfg.sandboxRoot, cfg.standingRoot, cfg.dataDir, cfg.repo.basePath, ROOT] : [ROOT];
  return list.map((r) => {
    const p = typeof r?.path === 'string' ? r.path.trim() : '';
    const days = Number(r?.olderThanDays);
    if (!P(p).isAbsolute(p)) throw new Error(`age rule path "${p}" must be absolute`);
    if (normPath(p) === normPath(P(p).parse(P(p).resolve(p)).root) || normPath(p) === normPath(os.homedir())) throw new Error(`age rule path "${p}" is too broad`);
    const clash = off.find((o) => o && (inside(p, o) || inside(o, p)));
    if (clash) throw new Error(`age rule path "${p}" overlaps ${clash}, which clean-up never touches`);
    if (!Number.isFinite(days) || days < 3) throw new Error(`age rule for "${p}": olderThanDays must be at least 3`);
    return { path: p, olderThanDays: Math.round(days) };
  });
}

/** The value to store for `key`, or throws with what is wrong. `null` removes the key (back to the default). */
export function normalizeSetting(key: SettableKey, value: unknown, cfg?: Config, users?: readonly string[]): unknown {
  if (value === null || value === undefined) return undefined;
  switch (key) {
    case 'ownerName': {
      if (typeof value !== 'string') throw new Error('ownerName is a string');
      const v = oneLine(value);
      if (!v || v.length > 60 || /[<>`{}$\\]/.test(v)) throw new Error('ownerName: 1-60 characters, one line, no <>`{}$\\');
      return v;
    }
    case 'voice.vocabulary': {
      const list = typeof value === 'string' ? value.split(',') : value;
      if (!Array.isArray(list) || list.some((w) => typeof w !== 'string')) throw new Error('voice.vocabulary is a list of words (or one comma-separated string)');
      const words = [...new Set(list.map((w) => oneLine(w as string)).filter(Boolean))];
      if (words.length > 60 || words.some((w) => w.length > 40)) throw new Error('voice.vocabulary: at most 60 words of up to 40 characters');
      return words;
    }
    case 'publicGitIdentity.name': {
      if (typeof value !== 'string') throw new Error('publicGitIdentity.name is a string');
      const v = oneLine(value);
      if (!v || v.length > 60 || /[<>`{}$\\"]/.test(v)) throw new Error('publicGitIdentity.name: 1-60 characters, one line, no <>`{}$\\"');
      return v;
    }
    case 'publicGitIdentity.email': {
      if (typeof value !== 'string' || !/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(value.trim())) throw new Error('publicGitIdentity.email is an email address, e.g. 12345+you@users.noreply.github.com');
      return value.trim();
    }
    case 'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN':
    case 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN': {
      // Never echo the value, not even in the error.
      if (typeof value !== 'string' || !OAUTH_TOKEN.test(value.trim())) throw new Error(`${key} must be a Claude OAuth token (sk-ant-oat01-…, from \`claude setup-token\`); the value given is not one (not shown)`);
      return value.trim();
    }
    case 'claudeAccounts.orchestrator':
    case 'claudeAccounts.dispatcher':
    case 'claudeAccounts.workers': {
      const v = typeof value === 'string' ? value.trim() : value;
      const role = key.slice('claudeAccounts.'.length);
      if (v === 'tokenfile') {
        // w464, change 18: never for workers; only once the file reads as a token (never shown).
        if (!TOKEN_FILE_ROLES.includes(role)) throw new Error(`${key} cannot be "tokenfile": only ${TOKEN_FILE_ROLES.join(', ')} run on the token file`);
        if (cfg) readTokenFile(cfg);
        return v;
      }
      if (v !== 'login' && v !== 'token') throw new Error(`${key} is "login" (this host's stored claude.ai login) or "token" (config claudeEnv's)${TOKEN_FILE_ROLES.includes(role) ? ', or "tokenfile" (config claudeTokenFile\'s)' : ''}`);
      // Refuse a switch that would leave the role unable to start: the stored login must be there and alive.
      const problem = v === 'login' && cfg ? hostLoginProblem(cfg) : undefined;
      if (problem) throw new Error(`${key} cannot be "login": ${problem}`);
      return v;
    }
    case 'machines.useHostClaudeEnv': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error('machines.useHostClaudeEnv is true (the host token) or false (the Mac\'s own login)');
    }
    case 'machines.claudeFromVault': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error("machines.claudeFromVault is true (a vault token per run, docs/vault.md) or false (the host token or the machine's own login, as before)");
    }
    case 'claudeTokenFile': {
      // A path, checked by reading it as a token (w464); the content is never echoed, the path is.
      if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) throw new Error('claudeTokenFile is the absolute path of a file holding one Claude OAuth token');
      readTokenFile({ claudeTokenFile: value.trim() });
      return value.trim();
    }
    case 'systemPayer': {
      if (typeof value !== 'string' || !USER_ID.test(value.trim())) throw new Error('systemPayer is a user id (a login name, e.g. "ben")');
      return value.trim();
    }
    case 'publicUrl': {
      if (typeof value !== 'string' || !/^https?:\/\/[^/\s]+\/?$/.test(value.trim())) throw new Error("publicUrl is the portal's base URL, e.g. https://<host>.<tailnet>.ts.net");
      return value.trim().replace(/\/+$/, '');
    }
    case 'usagePollMinutes': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 5 || n > 240) throw new Error('usagePollMinutes is a whole number of minutes from 5 to 240');
      return n;
    }
    case 'attachments.maxMB': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 4096) throw new Error('attachments.maxMB is a whole number of megabytes from 1 to 4096');
      return n;
    }
    case 'orchestrator.compactAtTokens': {
      const n = Number(value);
      if (!Number.isInteger(n) || (n !== 0 && (n < AUTO_COMPACT_LIMITS.minTokens || n > AUTO_COMPACT_LIMITS.maxTokens))) throw new Error(`orchestrator.compactAtTokens is 0 (off) or a whole number of tokens from ${AUTO_COMPACT_LIMITS.minTokens.toLocaleString('en-US')} to ${AUTO_COMPACT_LIMITS.maxTokens.toLocaleString('en-US')}`);
      return n;
    }
    case 'orchestrator.compactAtTurnUsd': {
      const n = Number(value);
      if (!Number.isFinite(n) || (n !== 0 && (n < AUTO_COMPACT_LIMITS.minTurnUsd || n > AUTO_COMPACT_LIMITS.maxTurnUsd))) throw new Error(`orchestrator.compactAtTurnUsd is 0 (off) or a cost in USD from ${AUTO_COMPACT_LIMITS.minTurnUsd} to ${AUTO_COMPACT_LIMITS.maxTurnUsd}`);
      return n;
    }
    case 'orchestrator.filingsPerMessage':
    case 'orchestrator.followUpsPerMessage':
    case 'orchestrator.messagesPerPerson': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < LOOP_GUARD_RANGE.min || n > LOOP_GUARD_RANGE.max) throw new Error(`${key} is a whole number from ${LOOP_GUARD_RANGE.min} to ${LOOP_GUARD_RANGE.max}`);
      return n;
    }
    case 'attachments.retentionDays': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error('attachments.retentionDays is a whole number of days from 1 to 3650');
      return n;
    }
    case 'hostGuard.devDriveVhdx': {
      if (typeof value !== 'string' || !P(value.trim()).isAbsolute(value.trim()) || !/\.vhdx?$/i.test(value.trim())) throw new Error('hostGuard.devDriveVhdx is the absolute path of a .vhdx file');
      return value.trim();
    }
    case 'hostGuard.cleanup.ageRules':
      return checkAgeRules(value, cfg);
    case 'hostGuard.cleanup.everyMinutes':
    case 'machines.cleanup.everyMinutes': {
      const n = Number(value);
      if (!Number.isInteger(n) || (n !== 0 && (n < 15 || n > 1440))) throw new Error(`${key} is 0 (only when disk space is low) or a whole number of minutes from 15 to 1440`);
      return n;
    }
    case 'hostGuard.cleanup.staleOutput':
    case 'machines.cleanup.staleOutput':
      return checkStaleOutput(key, value);
    case 'hostGuard.cleanup.softFreeGB':
    case 'machines.cleanup.softFreeGB': {
      const n = Number(value);
      const floor = key === 'hostGuard.cleanup.softFreeGB' && cfg ? cfg.hostGuard.warnFreeGB + 1 : 10;
      if (!Number.isInteger(n) || n < floor || n > 2000) throw new Error(`${key} is a whole number of GB from ${floor} to 2000${floor > 10 ? ' (above hostGuard.warnFreeGB, where new work is refused)' : ''}`);
      return n;
    }
    case 'providers.ffbox.enabled': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error('providers.ffbox.enabled is true or false');
    }
    case 'providers.ffbox.token': {
      // Never echo the value, not even in the error. Stored as its hash (STORED_AS).
      if (typeof value !== 'string' || !PROVIDER_TOKEN.test(value.trim())) throw new Error('providers.ffbox.token must be a connector token (ffpv1_ and 43 characters, from `node server/providerToken.ts`); the value given is not one (not shown)');
      return tokenSha256(value.trim());
    }
    case 'intake.ffbox':
      return checkFfboxIntake(value);
    case 'providers.ffbox.devRequests':
      return checkDevRequests(value);
    case 'intake.reviewers':
      return checkReviewers(value, users ?? []);
    case 'placement.prefer': {
      const list = typeof value === 'string' ? value.split(',') : value;
      if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new Error('placement.prefer is a list of computers, first choice first: machine ids such as "lothdesktop" (or one comma-separated string)');
      const ids = [...new Set(list.map((x) => placeId(x as string)).filter(Boolean))];
      const bad = ids.find((x) => !MACHINE_KEY.test(x) || x === 'host');
      if (bad) throw new Error(`placement.prefer: "${bad.slice(0, 40)}" is not a machine id (letters, digits, dashes)${NO_HOST}`);
      if (ids.length > 12) throw new Error('placement.prefer names at most 12 computers');
      return ids.length ? ids : undefined;
    }
    case 'placement.avoid': {
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error('placement.avoid is an object: computer id to why, e.g. { "beast": "BEAST unstable, 2026-10-05" }');
      const out: Record<string, string> = {};
      for (const [k, why] of Object.entries(value as Record<string, unknown>)) {
        const id = placeId(k);
        if (!MACHINE_KEY.test(id) || id === 'host') throw new Error(`placement.avoid: "${k.slice(0, 40)}" is not a machine id${NO_HOST}`);
        if (typeof why !== 'string' || !oneLine(why) || oneLine(why).length > 200) throw new Error(`placement.avoid.${id}: say why in one line of at most 200 characters`);
        out[id] = oneLine(why);
      }
      if (Object.keys(out).length > 12) throw new Error('placement.avoid names at most 12 computers');
      return Object.keys(out).length ? out : undefined;
    }
    case 'voice.ttsVoice': {
      if (typeof value !== 'string' || !/^[a-z]{2}_[a-z]+$/.test(value.trim())) throw new Error('voice.ttsVoice is a Kokoro voice name such as "af_heart" or "bm_george"');
      return value.trim();
    }
  }
}

/** Keys stored under another name than the one set: the connector token is kept only as its hash. */
/**
 * The stale-output block (server/staleOutput.ts): only its known keys, each in range, e.g. { "mode": "dry-run" } or
 * { "shaBuildDays": 3, "runRetentionDays": 30 }; what is left out keeps its default.
 */
function checkStaleOutput(key: string, value: unknown): Partial<StaleOutputSettings> {
  const v = typeof value === 'string' ? (() => {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  })() : value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${key} is an object such as { "mode": "dry-run" } (mode on, dry-run or off; everyHours, untouchedHours, shaBuildDays, runRetentionDays, logRetentionDays, tempHours, nightlyKeep, nightlyRoots)`);
  const out: Record<string, unknown> = {};
  const normal = staleOutputSettings(v) as unknown as Record<string, unknown>;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!(k in STALE_OUTPUT_DEFAULTS) && k !== 'nightlyRoots') throw new Error(`${key}: unknown key "${k}"; known: ${[...Object.keys(STALE_OUTPUT_DEFAULTS), 'nightlyRoots'].join(', ')}`);
    if (JSON.stringify(normal[k]) !== JSON.stringify(x)) throw new Error(`${key}.${k}: ${JSON.stringify(x)} is not allowed (mode is on, dry-run or off; numbers in range: everyHours 1-336, untouchedHours 6-720, shaBuildDays, runRetentionDays and logRetentionDays 1-365, tempHours 1-720, nightlyKeep 1-20; nightlyRoots a list of folders)`);
    out[k] = x;
  }
  return out as Partial<StaleOutputSettings>;
}

const STORED_AS: Partial<Record<SettableKey, string>> = { 'providers.ffbox.token': 'providers.ffbox.tokenSha256' };

/** Set (or with `undefined`, remove) a dotted key in a plain object. */
function setPath(obj: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof o[p] !== 'object' || o[p] === null || Array.isArray(o[p])) o[p] = {};
    o = o[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
}

function getPath(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), obj);
}

/** A machine id as config machines.useHostClaudeEnv and machines.cleanup.* name it (server/machines.ts MACHINE_ID). */
const MACHINE_KEY = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * A per-machine setting (machines.useHostClaudeEnv, machines.cleanup.*) after setting it to `v` (undefined:
 * removing it) for `machine`, or for every machine not named when `machine` is absent. Per-machine entries
 * survive a change of the rest, which is "*" once there are any: { "*": false, "m5": true }. Collapses back to a
 * plain value (or nothing) when it can.
 */
export function nextPerMachine<T extends boolean | number>(cur: unknown, machine: string | undefined, v: T | undefined): T | Record<string, T> | undefined {
  const obj: Record<string, T> = typeof cur === 'object' && cur !== null ? { ...(cur as Record<string, T>) } : typeof cur === 'boolean' || typeof cur === 'number' ? { '*': cur as T } : {};
  const at = machine ?? '*';
  if (v === undefined) delete obj[at];
  else obj[at] = v;
  const keys = Object.keys(obj);
  if (!keys.length) return undefined;
  if (keys.length === 1 && keys[0] === '*') return obj['*'];
  return obj;
}

/**
 * Change one allowlisted key in the config file (kept as config.json.prev first; written through a temp
 * file) and in the running config. Returns the value before and after. `opts.user`: whose entry, for the
 * per-person keys (userClaudeEnv.*, stored as userClaudeEnv.<user>.*). `opts.machine`: for
 * machines.useHostClaudeEnv, the one machine to set (absent: every machine not named).
 */
export function setAppConfig(file: string, cfg: Config, key: SettableKey, value: unknown, opts: { user?: string; machine?: string; users?: readonly string[] } = {}): { before: unknown; after: unknown } {
  if (!SETTABLE_KEYS.includes(key)) throw new Error(`${key} cannot be changed by an agent; allowed: ${SETTABLE_KEYS.join(', ')}`);
  // A dry run ignores both (server/dryRun.ts); one set here would arm what it keeps off.
  if (key.startsWith('claudeEnv.') || key.startsWith('userClaudeEnv.')) refuseInDryRun(key);
  const perUser = key.startsWith('userClaudeEnv.');
  // The user id becomes a key path segment: no dots (edit config.json by hand for such a login).
  if (perUser && !(opts.user && USER_ID.test(opts.user) && !opts.user.includes('.'))) throw new Error(`${key} needs user: the user id (login name, without dots) whose account it is`);
  const perMachine = key === 'machines.useHostClaudeEnv' || key === 'machines.claudeFromVault' || (key.startsWith('machines.cleanup.') && key !== 'machines.cleanup.staleOutput');
  if (opts.machine !== undefined && (!perMachine || !MACHINE_KEY.test(opts.machine))) throw new Error(`machine is only for machines.useHostClaudeEnv, machines.claudeFromVault and machines.cleanup.*, and is a machine id such as "m5"`);
  const v = normalizeSetting(key, value, cfg, opts.users);
  if (key === 'claudeTokenFile' && v === undefined) {
    const on = Object.entries(cfg.claudeAccounts ?? {}).filter(([, x]) => x === 'tokenfile').map(([r]) => r);
    if (on.length) throw new Error(`claudeTokenFile cannot be cleared while claudeAccounts.${on.join(', claudeAccounts.')} ${on.length > 1 ? 'are' : 'is'} "tokenfile"`);
  }
  const text = fs.readFileSync(file, 'utf8');
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
  const stored = perUser ? `userClaudeEnv.${opts.user}.${key.slice('userClaudeEnv.'.length)}` : (STORED_AS[key] ?? key);
  const before = getPath(raw, stored);
  const next = perMachine ? nextPerMachine(before, opts.machine, v as boolean | number | undefined) : v;
  setPath(raw, stored, next);
  writeFileDurable(file + '.prev', text, { generations: 0 });
  writeFileDurable(file, JSON.stringify(raw, null, 2) + '\n');
  // Live: the running server reads these through the shared config object.
  if (key === 'ownerName') cfg.ownerName = v as string | undefined;
  else if (key === 'voice.vocabulary') cfg.voice.vocabulary = (v as string[] | undefined) ?? [];
  else if (key === 'voice.ttsVoice') cfg.voice.ttsVoice = (v as string | undefined) ?? VOICE_DEFAULTS.ttsVoice;
  else if (key === 'hostGuard.devDriveVhdx') cfg.hostGuard.devDriveVhdx = (v as string | undefined) ?? '';
  else if (key === 'publicUrl') cfg.publicUrl = v as string | undefined;
  else if (key === 'claudeTokenFile') cfg.claudeTokenFile = v as string | undefined;
  else if (key === 'attachments.maxMB' || key === 'attachments.retentionDays') {
    const field = key === 'attachments.maxMB' ? 'maxMB' : 'retentionDays';
    const a = { ...cfg.attachments };
    if (v === undefined) delete a[field];
    else a[field] = v as number;
    cfg.attachments = a;
  }
  else if (key === 'claudeEnv.CLAUDE_CODE_OAUTH_TOKEN') {
    const env = { ...cfg.claudeEnv };
    if (v === undefined) delete env.CLAUDE_CODE_OAUTH_TOKEN;
    else env.CLAUDE_CODE_OAUTH_TOKEN = v as string;
    cfg.claudeEnv = env;
  } else if (key === 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN') {
    const all = { ...cfg.userClaudeEnv };
    const env = { ...all[opts.user!] };
    if (v === undefined) delete env.CLAUDE_CODE_OAUTH_TOKEN;
    else env.CLAUDE_CODE_OAUTH_TOKEN = v as string;
    if (Object.keys(env).length) all[opts.user!] = env;
    else delete all[opts.user!];
    cfg.userClaudeEnv = all;
  } else if (key === 'claudeAccounts.orchestrator' || key === 'claudeAccounts.dispatcher' || key === 'claudeAccounts.workers') {
    const accounts = { ...cfg.claudeAccounts };
    const role = key.slice('claudeAccounts.'.length) as HostRole;
    if (v === undefined) delete accounts[role];
    else accounts[role] = v as ClaudeAccount;
    cfg.claudeAccounts = accounts;
  } else if (key === 'machines.useHostClaudeEnv') cfg.machines = { ...cfg.machines, useHostClaudeEnv: next as boolean | Record<string, boolean> | undefined };
  else if (key === 'machines.claudeFromVault') cfg.machines = { ...cfg.machines, claudeFromVault: next as boolean | Record<string, boolean> | undefined };
  else if (key === 'systemPayer') cfg.systemPayer = v as string | undefined;
  else if (key === 'providers.ffbox.enabled' || key === 'providers.ffbox.token' || key === 'providers.ffbox.devRequests') {
    const ffbox = { ...cfg.providers?.ffbox };
    if (key === 'providers.ffbox.enabled') ffbox.enabled = v as boolean | undefined;
    else if (key === 'providers.ffbox.devRequests') ffbox.devRequests = v as DevRequestsConfig | undefined;
    else ffbox.tokenSha256 = v as string | undefined;
    cfg.providers = { ...cfg.providers, ffbox };
  }
  else if (key === 'intake.ffbox') cfg.intake = { ...cfg.intake, ffbox: v as IntakeConfig['ffbox'] };
  else if (key === 'intake.reviewers') cfg.intake = { ...cfg.intake, reviewers: v as string[] | undefined };
  else if (key === 'placement.prefer' || key === 'placement.avoid') {
    const p = { ...cfg.placement };
    if (key === 'placement.prefer') {
      if (v === undefined) delete p.prefer;
      else p.prefer = v as string[];
    } else if (v === undefined) delete p.avoid;
    else p.avoid = v as Record<string, string>;
    cfg.placement = p;
  }
  else if (key === 'hostGuard.cleanup.staleOutput') cfg.hostGuard.cleanup.staleOutput = v as Partial<StaleOutputSettings> | undefined;
  else if (key === 'machines.cleanup.staleOutput') cfg.machines = { ...cfg.machines, cleanup: { ...cfg.machines?.cleanup, staleOutput: v as Partial<StaleOutputSettings> | undefined } };
  else if (key === 'hostGuard.cleanup.ageRules') cfg.hostGuard.cleanup.ageRules = (v as { path: string; olderThanDays: number }[] | undefined) ?? [];
  else if (key === 'orchestrator.compactAtTokens') cfg.orchestrator = { ...cfg.orchestrator, compactAtTokens: v as number | undefined };
  else if (key === 'orchestrator.compactAtTurnUsd') cfg.orchestrator = { ...cfg.orchestrator, compactAtTurnUsd: v as number | undefined };
  else if (key === 'orchestrator.filingsPerMessage') cfg.orchestrator = { ...cfg.orchestrator, filingsPerMessage: v as number | undefined };
  else if (key === 'orchestrator.followUpsPerMessage') cfg.orchestrator = { ...cfg.orchestrator, followUpsPerMessage: v as number | undefined };
  else if (key === 'orchestrator.messagesPerPerson') cfg.orchestrator = { ...cfg.orchestrator, messagesPerPerson: v as number | undefined };
  else if (key === 'usagePollMinutes') cfg.usagePollMinutes = (v as number | undefined) ?? DEFAULT_USAGE_POLL_MINUTES;
  else if (key === 'hostGuard.cleanup.everyMinutes') cfg.hostGuard.cleanup.everyMinutes = (v as number | undefined) ?? DEFAULT_CLEANUP.everyMinutes;
  else if (key === 'hostGuard.cleanup.softFreeGB') cfg.hostGuard.cleanup.softFreeGB = (v as number | undefined) ?? DEFAULT_CLEANUP.softFreeGB;
  else if (key === 'machines.cleanup.everyMinutes' || key === 'machines.cleanup.softFreeGB') {
    const field = key === 'machines.cleanup.everyMinutes' ? 'everyMinutes' : 'softFreeGB';
    cfg.machines = { ...cfg.machines, cleanup: { ...cfg.machines?.cleanup, [field]: next as number | Record<string, number> | undefined } };
  }
  else if (key === 'publicGitIdentity.name' || key === 'publicGitIdentity.email') {
    const field = key === 'publicGitIdentity.name' ? 'name' : 'email';
    cfg.publicGitIdentity = { ...cfg.publicGitIdentity, [field]: v as string | undefined };
  }
  // A write-only secret reads back as "set (…abcd)" only.
  if (SECRET_KEYS.has(key)) return { before: maskSecret(before), after: maskSecret(v) };
  return { before, after: next };
}

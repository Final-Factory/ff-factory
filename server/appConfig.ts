import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CLEANUP, DEFAULT_WORKER_EFFORT, HOST_GUARD_DEFAULTS, DEFAULT_USAGE_POLL_MINUTES, LOOP_GUARD_RANGE, ROOT, VAULT_ENTRY_NAME, VAULT_PINNED_PREFIX, VOICE_DEFAULTS, pinnedVaultEntry, type ClaudeAccount, type Config, type IntakeConfig } from './config.ts';
import { SECRET_KEYS, maskSecret } from './secrets.ts';
import { FFBOX_HASH_FILE, ffboxTokenHash, secretsDirOf, writeFfboxTokenHash } from './configMigration.ts';
import { vaultContext } from './vault.ts';
import { PROVIDER_TOKEN, tokenSha256 } from './providerProtocol.ts';
import { USER_ID } from './identity.ts';
import { writeFileDurable } from './durable.ts';
import { placeId } from './placement.ts';
import { MIN_PRIORITIES, type MinPriority } from '../shared/capacity.ts';
import { DEV_DEFAULTS, type DevRequestsConfig } from './devRequests.ts';
import { STALE_OUTPUT_DEFAULTS, staleOutputSettings, type StaleOutputSettings } from './staleOutput.ts';
import { poolLimits, poolSettingProblem, weeklyCapsProblem, type PoolConfigKey } from './tokenPool.ts';
import { AUTO_COMPACT_LIMITS, EARLY_COMPACT_MIN_TOKENS } from './autoCompact.ts';

/** The efforts worker.effort takes (w2000, lothsahn's brief: "validated to low, medium, high or max"). */
export const WORKER_EFFORTS = ['low', 'medium', 'high', 'max'] as const;

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
  // The portal's own disk levels (w1101): low (warn) and critical, in GB free; critical below warn. The machines' are their own.
  'hostGuard.warnFreeGB',
  'hostGuard.criticalFreeGB',
  'hostGuard.cleanup.ageRules',
  // The continuous clean-up's pace and soft threshold, on this host and on the machines (optional `machine`).
  'hostGuard.cleanup.everyMinutes',
  'hostGuard.cleanup.softFreeGB',
  // The portal's pictures and videos of idle conversations (w2268, server/mediaRetention.ts): days, 0 never.
  'hostGuard.cleanup.mediaDays',
  'machines.cleanup.everyMinutes',
  'machines.cleanup.softFreeGB',
  // The stale build and run output rules (w459, server/staleOutput.ts): this host's, and every machine's.
  'hostGuard.cleanup.staleOutput',
  'machines.cleanup.staleOutput',
  // How often every Claude account's plan usage is polled, here and by the machines' daemons (the endpoint rate-limits).
  'usagePollMinutes',
  // The address machines and the outside watchdog reach this portal at (the Tailscale Funnel URL).
  'publicUrl',
  // The one vault token the dispatcher runs on (w996), "vault:<entry name>"; unset, the system payer's pool. The owner's only.
  // Every other Claude process runs on its person's pool: nothing else to set (w1078).
  'claudeAccounts.dispatcher',
  // Whether a machine's runs (and, for the machine id "portal", the portal's own gh reads) use the run person's vault GitHub
  // token (docs/vault.md section 13, w868; optional `machine`). The owner's only.
  'machines.githubFromVault',
  // The activity pause on Windows machines (w1574, docs/machines.md "Pausing a machine"; optional `machine`): on or off (default
  // off), and the minutes without a key or click before work resumes (default 90).
  'machines.activityPause.enabled',
  'machines.activityPause.idleMinutes',
  // A person playing Final Factory on a machine (w1894, docs/unity-lifecycle.md "A person's game"; optional `machine`): on or
  // off (default on at LothDesktop only), the minutes of grace after the game closes (default 10), and who plays there.
  'machines.personPlay.enabled',
  'machines.personPlay.graceMinutes',
  'machines.personPlay.who',
  // Whose Claude pool (and GitHub token) work nobody asked for by name runs on (w1289, docs/vault.md section 10): the intake's,
  // FFBox's without an operator, and the nightly run, review and regression sentry. Each a user id with a Claude pool in the
  // vault; null goes back to the default (lothsahn). The owner's only.
  'vault.unattributed.intake',
  'vault.unattributed.ffbox',
  'vault.unattributed.nightly',
  // The Claude token pool's limits (w739, docs/vault.md section 4): one system-wide set, anyone may change them (not owner-only).
  // Each is a percent, 0-100; the one-at-a-time limit may not be above the retire limit.
  'vault.pool.sessionHoldPercent',
  'vault.pool.onePerWeeklyPercent',
  'vault.pool.retireWeeklyPercent',
  'vault.pool.reservePerDayPercent',
  'vault.pool.reserveSessionPercent',
  // The dispatcher token's stop line (w1109): its workers are asked to save and stop, and no new one starts on it.
  'vault.pool.dispatcherStopPercent',
  // The near-reset rule (w1539): its window in hours before a token's weekly reset (0: off), and the burst floor in tokens.
  'vault.pool.nearResetHours',
  'vault.pool.nearResetFloorTokens',
  // A token's own weekly cap (w2785, docs/vault.md section 4): a map of vault entry name to percent, merged into the one set
  // ({ "vault-ben-3": 90 }; a name set to null drops its cap; null drops them all). At its cap a token is retired for all work.
  'vault.pool.weeklyCapPercent',
  // Who automatic work (scheduled standing runs, intake-triggered FFBox work) is attributed and billed to.
  'systemPayer',
  // Files people attach to messages (docs/attachments.md): the largest one, and how long one nobody sends on is kept.
  'attachments.maxMB',
  'attachments.retentionDays',
  // FFBox's connector (docs/ffbox-integration.md): whether it may connect (default off), and its token,
  // write-only: only its SHA-256 is stored, in a file of the secrets folder that providers.ffbox.tokenSha256File names (w1078).
  'providers.ffbox.enabled',
  'providers.ffbox.token',
  // FFBox dev requests (docs/ffbox.md, "Dev requests"): the switch and caps. The owner's only (OWNER_ONLY_KEYS). Which
  // person a request is for is FFBox's operator name, the login of the same name: nothing to set here.
  'providers.ffbox.devRequests',
  // The FFBox intake (docs/intake.md): its whole block at once, the owner's only (OWNER_ONLY_KEYS).
  'intake.ffbox',
  // Who may approve or decline intake requests (docs/intake.md): login names known to identity. The owner's only.
  'intake.reviewers',
  // The nightly e2e lab (w864, docs/intake.md "The nightly run"): whether its regressions are filed, and the portal's nightly
  // schedule that starts it. Anyone may set them: they file the team's own lab work, never players' words.
  'intake.nightly.enabled',
  'intake.nightly.run',
  'intake.nightly.review',
  // Whether the nightly's requests go to the dispatcher without a reviewer, at most maxPerDay a day (w2142, lothsahn: "Turn
  // on nightly auto-approve, 10 a day"). Anyone may set it, like the switch above. Read live (intakeSettings, every look).
  'intake.nightly.autoApprove',
  // The game repo's red master batches handed back to the culprit PR's request (w1180, docs/intake.md "Master batch reds"): the
  // switch and the auto-approve rule. Anyone may set them: they file the team's own CI work, never players' words.
  'masterBatch.enabled',
  'masterBatch.autoApprove',
  // The automatic portal deploy (w1634, server/autoDeploy.ts): on unless false. Anyone may set it: it only decides whether
  // code already merged into main through a pull request and its CI goes out without a person asking.
  'autoDeploy.enabled',
  // The live view (w1398, docs/live-view.md): a sandbox's running game streamed beside its agent's chat, with the shader's
  // knobs. Off unless true. The owner's only (OWNER_ONLY_KEYS): it opens a new stream from the machines to the pages.
  'live.enabled',
  // Minutes a Live view sits idle (no turn, job, check-in or viewer) before its sandbox's editor is closed (w1746,
  // docs/live-view.md "Idle editors close"): default 15, 0 never. The owner's only: it closes editors on every machine.
  'live.idleCloseMinutes',
  // How long a timed leg or run waits for an offline computer before it goes elsewhere (w2048, server/timedAsk.ts
  // unavailableWait): whole minutes when the fleet is idle (default 5) and when it is busy (default 60).
  'timing.unavailableIdleMinutes',
  'timing.unavailableBusyMinutes',
  // Where new game-repo work goes first, and which computers it stays off (w428, docs/machines.md "Placing work").
  'placement.prefer',
  'placement.avoid',
  // Computers that take no new work at all, with who holds them and why (w1089): the m5 held for Ben's testing.
  'placement.hold',
  // Where work that needs a Live view goes first (w1600, docs/machines.md "Placing work"); unset: beast.
  'placement.live',
  // Where builds run first, and which computers a build declared coming clears (w1606, docs/orchestrators.md); unset: beast.
  'placement.build',
  // The lowest priority of work each computer takes (w1643, docs/machines.md "Placing work"): { "beast": "urgent" }.
  'placement.minPriority',
  // The load, %, past which new work spills down the placement list (w2054, docs/machines.md "Placing work"); unset: 50.
  'placement.spillAtPercent',
  // When the orchestrators compact their conversations by themselves (w535, server/autoCompact.ts): the context in
  // tokens, and a turn's cost in USD. 0 turns either trigger off.
  'orchestrator.compactAtTokens',
  'orchestrator.compactAtTurnUsd',
  // The quiet wait before a due compaction, in seconds, and the context from which there is none (w1538).
  'orchestrator.compactIdleSeconds',
  'orchestrator.compactHardAtTokens',
  // Workers' automatic compaction (w1469): the context in tokens, the context before a long wait, and the pilot's share.
  'worker.compactAtTokens',
  'worker.compactBeforeWaitTokens',
  'worker.compactPilotPercent',
  // The earlier-compaction pilot (w2002, server/autoCompact.ts): its share of workers, and its two thresholds (80,000 at least).
  'worker.earlyCompactPilotPercent',
  'worker.earlyCompactAtTokens',
  'worker.earlyCompactMidTurnTokens',
  // The share of workers that write terse prose between tool calls (w1480, server/terseProse.ts).
  'worker.terseProsePilotPercent',
  // The share of workers nudged to hand a long read/search chain to a subagent (w2014, server/readChain.ts).
  'worker.readChainPilotPercent',
  // The share of requests whose green PRs FF Factory merges itself, filing the report the worker left (w2045, server/mergeOnGreen.ts).
  'worker.mergeOnGreenPilotPercent',
  // The share of requests whose worker starts a fresh session after a merged PR (w2043, server/freshAfterMerge.ts); default 0, off.
  'worker.freshAfterMergePilotPercent',
  // Workers' reasoning effort when start_agent names none (w2000, docs/orchestrators.md "A worker's effort"): low, medium, high or
  // max; null goes back to medium (w2010). It is the session's --effort flag, which beats the repo's settings.json modelSettings.
  'worker.effort',
  // The orchestrators' loop guards (w571, server/orchestrators.ts loopGuards): budgets a person's own message starts again.
  'orchestrator.filingsPerMessage',
  'orchestrator.followUpsPerMessage',
  'orchestrator.messagesPerPerson',
  // w1867: per person, the filings limit in turns their own timers started ({ "lothsahn": 100 }). The owner's only.
  'orchestrator.timerFilingsPerMessage',
  // The coordinators' routine turns (w1158, server/turnModel.ts): their model ("off" keeps every turn on orchestrator.model)
  // and how long after a turn on orchestrator.model they stay on it.
  'orchestrator.routineModel',
  'orchestrator.routineAfterMinutes',
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

/** Placement names machines only: the portal holds no sandboxes of its own (w510), so "this host" is no place for work. */
const NO_HOST = '; "this host" is no place for work any more (w510): name this host\'s own daemon (e.g. "beast")';

/** Keys only an owner may set (docs/identity.md roles): what the intake files and starts by itself. */
export const OWNER_ONLY_KEYS: ReadonlySet<SettableKey> = new Set(['live.enabled', 'live.idleCloseMinutes', 'intake.ffbox', 'intake.reviewers', 'providers.ffbox.devRequests', 'claudeAccounts.dispatcher', 'machines.githubFromVault', 'vault.unattributed.intake', 'vault.unattributed.ffbox', 'vault.unattributed.nightly', 'orchestrator.timerFilingsPerMessage']);

const FFBOX_INTAKE_FLAGS = ['enabled', 'branches', 'diagnoses', 'requests', 'boardCheck', 'escalations'] as const;
const FFBOX_INTAKE_KEYS = [...FFBOX_INTAKE_FLAGS, 'repo', 'dailyCap', 'match', 'autoApprove', 'desync', 'crash'];
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
 * orchestrator.timerFilingsPerMessage (w1867): { <login>: <1-100> }, the whole map replaced; a login that exists (stored
 * in lower case, as Orchestrators.timerFilings reads it), each value a whole number in LOOP_GUARD_RANGE.
 */
export function checkTimerFilings(value: unknown, users: readonly string[]): Record<string, number> {
  const o = objectOf(value, 'orchestrator.timerFilingsPerMessage', '{ "lothsahn": 100 }');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) {
    const login = users.find((u) => u.toLowerCase() === k.trim().toLowerCase());
    if (!login) throw new Error(`orchestrator.timerFilingsPerMessage: no login ${JSON.stringify(k.slice(0, 40))}; the logins are ${users.join(', ') || '(none)'}`);
    const n = Number(v);
    if (!Number.isInteger(n) || n < LOOP_GUARD_RANGE.min || n > LOOP_GUARD_RANGE.max) throw new Error(`orchestrator.timerFilingsPerMessage.${login} is a whole number from ${LOOP_GUARD_RANGE.min} to ${LOOP_GUARD_RANGE.max}`);
    out[login.toLowerCase()] = n;
  }
  return out;
}

const NIGHTLY_RUN_KEYS = ['enabled', 'time', 'tz', 'machine', 'person', 'reportWithinHours'];

/**
 * intake.nightly.run as set_app_config takes it (w864): the whole schedule block, known keys only, each checked; a key
 * left out takes its default (03:00, America/New_York, lothdesktop, 5 hours; intakeRules.ts intakeSettings).
 */
export function checkNightlyRun(value: unknown, users: readonly string[]): NonNullable<NonNullable<IntakeConfig['nightly']>['run']> {
  return checkNightlySchedule(value, users, 'intake.nightly.run');
}

/** intake.nightly.review (w905): the merge review's timer, checked like the run's (no reportWithinHours; default 06:00). */
export function checkNightlyReview(value: unknown, users: readonly string[]): NonNullable<NonNullable<IntakeConfig['nightly']>['review']> {
  return checkNightlySchedule(value, users, 'intake.nightly.review');
}

function checkNightlySchedule(value: unknown, users: readonly string[], key: 'intake.nightly.run' | 'intake.nightly.review'): NonNullable<NonNullable<IntakeConfig['nightly']>['run']> {
  const example = '{ "enabled": true, "time": "03:00", "tz": "America/New_York", "machine": "lothdesktop", "person": "lothsahn" }';
  const o = objectOf(value, key, example);
  const known = key === 'intake.nightly.run' ? NIGHTLY_RUN_KEYS : NIGHTLY_RUN_KEYS.filter((k) => k !== 'reportWithinHours');
  const unknown = Object.keys(o).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`${key}: unknown key(s) ${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}; known: ${known.join(', ')}`);
  const out: NonNullable<NonNullable<IntakeConfig['nightly']>['run']> = {};
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') throw new Error(`${key}.enabled is true or false`);
    out.enabled = o.enabled;
  }
  if (o.time !== undefined) {
    if (typeof o.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) throw new Error(`${key}.time is HH:MM, 24-hour, e.g. "03:00"`);
    out.time = o.time;
  }
  if (o.tz !== undefined) {
    let ok = typeof o.tz === 'string';
    try {
      if (ok) new Intl.DateTimeFormat('en-US', { timeZone: o.tz as string });
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`${key}.tz is an IANA time zone, e.g. "America/New_York"`);
    out.tz = o.tz as string;
  }
  if (o.machine !== undefined) {
    if (typeof o.machine !== 'string' || !MACHINE_KEY.test(o.machine)) throw new Error(`${key}.machine is a machine id, e.g. "lothdesktop"`);
    out.machine = o.machine;
  }
  if (o.person !== undefined) {
    const login = typeof o.person === 'string' ? users.find((u) => u.toLowerCase() === (o.person as string).trim().toLowerCase()) : undefined;
    if (!login) throw new Error(`${key}.person is a login; the logins are ${users.join(', ') || '(none)'}`);
    out.person = login;
  }
  if (o.reportWithinHours !== undefined) {
    if (!Number.isInteger(o.reportWithinHours) || (o.reportWithinHours as number) < 1 || (o.reportWithinHours as number) > 20) throw new Error(`${key}.reportWithinHours is a whole number from 1 to 20`);
    out.reportWithinHours = o.reportWithinHours as number;
  }
  return out;
}

/**
 * intake.nightly.autoApprove as set_app_config takes it (w2142): { enabled: true or false, maxPerDay: a whole number from 1
 * to 100 }, both given, nothing else. null removes it (the default: off, 10 a day; intakeRules.ts intakeSettings).
 */
export function checkNightlyAutoApprove(value: unknown): { enabled: boolean; maxPerDay: number } {
  const o = objectOf(value, 'intake.nightly.autoApprove', '{ "enabled": true, "maxPerDay": 10 }');
  const unknown = Object.keys(o).filter((k) => k !== 'enabled' && k !== 'maxPerDay');
  if (unknown.length) throw new Error(`intake.nightly.autoApprove: unknown key(s) ${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}; known: enabled, maxPerDay`);
  if (typeof o.enabled !== 'boolean') throw new Error('intake.nightly.autoApprove.enabled is true or false, and must be given');
  if (!Number.isInteger(o.maxPerDay) || (o.maxPerDay as number) < 1 || (o.maxPerDay as number) > 100) throw new Error('intake.nightly.autoApprove.maxPerDay is a whole number from 1 to 100, and must be given');
  return { enabled: o.enabled, maxPerDay: o.maxPerDay as number };
}

/** masterBatch.autoApprove as set_app_config takes it (w1180): { enabled, maxPerDay 0-100 }, known keys only. */
export function checkMasterBatchAutoApprove(value: unknown): NonNullable<NonNullable<Config['masterBatch']>['autoApprove']> {
  const o = objectOf(value, 'masterBatch.autoApprove', '{ "enabled": true, "maxPerDay": 10 }');
  const unknown = Object.keys(o).filter((k) => k !== 'enabled' && k !== 'maxPerDay');
  if (unknown.length) throw new Error(`masterBatch.autoApprove: unknown key(s) ${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}; known: enabled, maxPerDay`);
  const out: NonNullable<NonNullable<Config['masterBatch']>['autoApprove']> = {};
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') throw new Error('masterBatch.autoApprove.enabled is true or false');
    out.enabled = o.enabled;
  }
  if (o.maxPerDay !== undefined) {
    if (!Number.isInteger(o.maxPerDay) || (o.maxPerDay as number) < 0 || (o.maxPerDay as number) > 100) throw new Error('masterBatch.autoApprove.maxPerDay is a whole number from 0 to 100');
    out.maxPerDay = o.maxPerDay as number;
  }
  return out;
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

const DEV_REQUEST_KEYS = ['enabled', 'operatorTurns', 'perHour', 'maxFiles', 'maxRequestMB'];

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
  if (r.operatorTurns !== undefined) {
    if (typeof r.operatorTurns !== 'boolean') throw new Error('providers.ffbox.devRequests.operatorTurns is true or false');
    out.operatorTurns = r.operatorTurns;
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
  // The FFBox crash-fix policy (w1827): on unless switched off.
  if (r.crash !== undefined) out.crash = enabledPerDay('crash', r.crash, '{ "enabled": true, "maxPerDay": 10 }');
  return out;
}

/** An intake.ffbox sub-block of the form { enabled, maxPerDay } (autoApprove, desync, crash), checked. */
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
    case 'claudeAccounts.dispatcher': {
      // The dispatcher on one named vault token (w996), or "vault": the system payer's pool, stored as no key (w1078).
      const v = typeof value === 'string' ? value.trim() : value;
      if (v === 'vault') return undefined;
      const pinned = pinnedVaultEntry(typeof v === 'string' ? v : undefined);
      if (pinned === undefined || !VAULT_ENTRY_NAME.test(pinned)) throw new Error(`${key} is "${VAULT_PINNED_PREFIX}<vault entry name>", the name \`fffctl vault list\` shows (lower-case letters, digits, ".", "_", "-"), e.g. "vault:vault-lothsahn-1", or "vault" (the system payer's pool); every Claude process runs on a vault token (w1078)`);
      const context = vaultContext();
      if (context && !context.vault.claudeByName(pinned)) throw new Error(`${key}: the vault has no enabled Claude token named "${pinned}" that its key opens (\`fffctl vault list\` shows the names)`);
      return v as ClaudeAccount;
    }
    case 'vault.unattributed.intake':
    case 'vault.unattributed.ffbox':
    case 'vault.unattributed.nightly': {
      // The person whose tokens that kind of nobody's work runs on (w1289): a login that exists and has a Claude pool in the vault.
      // Stored in the login's own spelling. null (above) removes the key: back to the default (UNATTRIBUTED_DEFAULTS).
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is a user id (a login name, e.g. "ben") with a Claude pool in the vault; null goes back to the default`);
      const id = value.trim();
      const known = (users ?? []).find((u) => u.toLowerCase() === id.toLowerCase());
      if (!known) throw new Error(`${key}: no login ${JSON.stringify(id.slice(0, 40))}; the logins are ${(users ?? []).join(', ') || '(none)'}`);
      const context = vaultContext();
      if (!context) throw new Error(`${key}: the vault is not loaded in this process, so ${known}'s Claude pool cannot be checked`);
      if (!context.vault.hasClaudeFor(known)) throw new Error(`${key}: ${known} has no enabled Claude token in the vault that its key opens (fffctl vault list; docs/vault.md section 10): their runs would not start`);
      return known;
    }
    case 'machines.activityPause.enabled': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error("machines.activityPause.enabled is true (a person's key or click on that Windows machine pauses its work) or false (work goes on while someone uses it)");
    }
    case 'machines.personPlay.enabled': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error("machines.personPlay.enabled is true (a person's own Final Factory game on that machine makes its agents yield) or false (they work on beside it)");
    }
    case 'machines.personPlay.graceMinutes': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 240) throw new Error(`${key} is a whole number of minutes from 1 to 240: how long after the game closes before the agents' work comes back`);
      return n;
    }
    case 'machines.personPlay.who': {
      if (typeof value !== 'string' || !/^[\w .'-]{1,40}$/.test(value.trim())) throw new Error(`${key} is a name of up to 40 letters, digits, spaces, dots, dashes or apostrophes: who plays there ("lothsahn")`);
      return value.trim();
    }
    case 'machines.activityPause.idleMinutes': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 1440) throw new Error(`${key} is a whole number of minutes from 1 to 1440: how long without a key or click before work resumes`);
      return n;
    }
    case 'machines.githubFromVault': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error('machines.githubFromVault is true (the run person\'s vault GitHub token, docs/vault.md section 13; machine "portal" for the portal\'s own reads) or false (the gh login it had, as before)');
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
    case 'vault.pool.sessionHoldPercent':
    case 'vault.pool.onePerWeeklyPercent':
    case 'vault.pool.retireWeeklyPercent':
    case 'vault.pool.reservePerDayPercent':
    case 'vault.pool.reserveSessionPercent':
    case 'vault.pool.dispatcherStopPercent': {
      // The token pool's limits (w739): a percent, 0-100 (a number or its text); one at a time may not be above retired.
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${key} is a percent from 0 to 100`);
      const now = poolLimits(cfg);
      if (key === 'vault.pool.onePerWeeklyPercent' && n > now.retireWeekly) throw new Error(`${key} (${n}) cannot be above vault.pool.retireWeeklyPercent (${now.retireWeekly}): one at a time starts before a token is retired`);
      if (key === 'vault.pool.retireWeeklyPercent' && n < now.onePerWeekly) throw new Error(`${key} (${n}) cannot be below vault.pool.onePerWeeklyPercent (${now.onePerWeekly}): one at a time starts before a token is retired`);
      return n;
    }
    case 'vault.pool.weeklyCapPercent': {
      // Per-token weekly caps (w2785): merged into the map in effect, so setting one token's cap keeps the others'.
      if (value === null || value === undefined) return undefined;
      let given: unknown = value;
      if (typeof value === 'string') {
        const t = value.trim();
        if (t.startsWith('{')) {
          try {
            given = JSON.parse(t);
          } catch {
            throw new Error(`${key} is a map of vault entry name to a percent, e.g. {"vault-ben-3": 90}, or "vault-ben-3=90" ("vault-ben-3=off" drops it)`);
          }
        } else {
          const m = /^([^=\s]+)\s*=\s*(\S+)$/.exec(t);
          if (!m) throw new Error(`${key} is a map of vault entry name to a percent, e.g. {"vault-ben-3": 90}, or "vault-ben-3=90" ("vault-ben-3=off" drops it)`);
          given = { [m[1]]: /^(off|null|none)$/i.test(m[2]) ? null : Number(m[2]) };
        }
      }
      if (!given || typeof given !== 'object' || Array.isArray(given)) throw new Error(`${key} is a map of vault entry name to a percent, e.g. {"vault-ben-3": 90}`);
      const merged: Record<string, unknown> = { ...(cfg?.vault?.pool?.weeklyCapPercent ?? {}) };
      for (const [name, n] of Object.entries(given as Record<string, unknown>)) {
        if (n === null) delete merged[name];
        else merged[name] = typeof n === 'string' && n.trim() !== '' ? Number(n) : n;
      }
      const why = weeklyCapsProblem(merged);
      if (why) throw new Error(why.replace('config vault.pool.', 'vault.pool.'));
      return Object.keys(merged).length ? merged : undefined;
    }
    case 'vault.pool.nearResetHours':
    case 'vault.pool.nearResetFloorTokens': {
      // The near-reset rule (w1539): hours from 0 (off) to 168, and a whole number of tokens from 0 to 10.
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      const why = poolSettingProblem(key.slice('vault.pool.'.length) as PoolConfigKey, n);
      if (why) throw new Error(why.replace('config vault.pool.', 'vault.pool.'));
      return n as number;
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
    case 'orchestrator.compactIdleSeconds': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > AUTO_COMPACT_LIMITS.maxIdleSeconds) throw new Error(`orchestrator.compactIdleSeconds is 0 (compact at once) or a whole number of seconds up to ${AUTO_COMPACT_LIMITS.maxIdleSeconds.toLocaleString('en-US')}`);
      return n;
    }
    case 'orchestrator.compactHardAtTokens':
    case 'worker.compactAtTokens':
    case 'worker.compactBeforeWaitTokens': {
      const n = Number(value);
      if (!Number.isInteger(n) || (n !== 0 && (n < AUTO_COMPACT_LIMITS.minTokens || n > AUTO_COMPACT_LIMITS.maxTokens))) throw new Error(`${key} is 0 (off) or a whole number of tokens from ${AUTO_COMPACT_LIMITS.minTokens.toLocaleString('en-US')} to ${AUTO_COMPACT_LIMITS.maxTokens.toLocaleString('en-US')}`);
      return n;
    }
    case 'worker.earlyCompactAtTokens':
    case 'worker.earlyCompactMidTurnTokens': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < EARLY_COMPACT_MIN_TOKENS || n > AUTO_COMPACT_LIMITS.maxTokens) throw new Error(`${key} is a whole number of tokens from ${EARLY_COMPACT_MIN_TOKENS.toLocaleString('en-US')} to ${AUTO_COMPACT_LIMITS.maxTokens.toLocaleString('en-US')}`);
      return n;
    }
    case 'worker.compactPilotPercent':
    case 'worker.earlyCompactPilotPercent':
    case 'worker.terseProsePilotPercent':
    case 'worker.readChainPilotPercent':
    case 'worker.mergeOnGreenPilotPercent':
    case 'worker.freshAfterMergePilotPercent': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error(`${key} is a whole number from 0 to 100`);
      return n;
    }
    case 'worker.effort': {
      const e = String(value).trim();
      if (!WORKER_EFFORTS.includes(e as (typeof WORKER_EFFORTS)[number])) throw new Error(`worker.effort is one of ${WORKER_EFFORTS.join(', ')}`);
      return e;
    }
    case 'orchestrator.compactAtTurnUsd': {
      const n = Number(value);
      if (!Number.isFinite(n) || (n !== 0 && (n < AUTO_COMPACT_LIMITS.minTurnUsd || n > AUTO_COMPACT_LIMITS.maxTurnUsd))) throw new Error(`orchestrator.compactAtTurnUsd is 0 (off) or a cost in USD from ${AUTO_COMPACT_LIMITS.minTurnUsd} to ${AUTO_COMPACT_LIMITS.maxTurnUsd}`);
      return n;
    }
    case 'orchestrator.routineModel': {
      const m = String(value).trim();
      if (!/^(off|opus|sonnet|haiku|claude-[a-z0-9.-]{3,40})$/.test(m)) throw new Error('orchestrator.routineModel is a model ("claude-sonnet-5-5", "sonnet") or "off" (every coordinator turn on orchestrator.model)');
      return m;
    }
    case 'orchestrator.routineAfterMinutes': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 1440) throw new Error('orchestrator.routineAfterMinutes is a whole number of minutes from 0 to 1440');
      return n;
    }
    case 'orchestrator.filingsPerMessage':
    case 'orchestrator.followUpsPerMessage':
    case 'orchestrator.messagesPerPerson': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < LOOP_GUARD_RANGE.min || n > LOOP_GUARD_RANGE.max) throw new Error(`${key} is a whole number from ${LOOP_GUARD_RANGE.min} to ${LOOP_GUARD_RANGE.max}`);
      return n;
    }
    case 'orchestrator.timerFilingsPerMessage':
      return checkTimerFilings(value, users ?? []);
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
    case 'hostGuard.cleanup.mediaDays': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 3650) throw new Error(`${key} is 0 (never) or a whole number of days from 1 to 3650`);
      return n;
    }
    case 'hostGuard.cleanup.softFreeGB':
    case 'machines.cleanup.softFreeGB': {
      // The portal's at or below its warn level is fine (w1101: its default is warnFreeGB); above its critical level.
      const n = Number(value);
      const floor = key === 'hostGuard.cleanup.softFreeGB' && cfg ? Math.max(cfg.hostGuard.criticalFreeGB + 1, 5) : 10;
      if (!Number.isInteger(n) || n < floor || n > 2000) throw new Error(`${key} is a whole number of GB from ${floor} to 2000${key === 'hostGuard.cleanup.softFreeGB' && cfg ? ' (above hostGuard.criticalFreeGB)' : ''}`);
      return n;
    }
    case 'hostGuard.warnFreeGB':
    case 'hostGuard.criticalFreeGB': {
      // Critical stays below warn (w1101): the other one is the running config's.
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 2000) throw new Error(`${key} is a whole number of GB from 1 to 2000`);
      if (cfg && key === 'hostGuard.warnFreeGB' && n <= cfg.hostGuard.criticalFreeGB) throw new Error(`${key} (${n}) must be above hostGuard.criticalFreeGB (${cfg.hostGuard.criticalFreeGB}): lower that first`);
      if (cfg && key === 'hostGuard.criticalFreeGB' && n >= cfg.hostGuard.warnFreeGB) throw new Error(`${key} (${n}) must be below hostGuard.warnFreeGB (${cfg.hostGuard.warnFreeGB}): raise that first`);
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
    case 'intake.nightly.enabled': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error('intake.nightly.enabled is true or false');
    }
    case 'intake.nightly.run':
      return checkNightlyRun(value, users ?? []);
    case 'intake.nightly.review':
      return checkNightlyReview(value, users ?? []);
    case 'intake.nightly.autoApprove':
      return checkNightlyAutoApprove(value);
    case 'masterBatch.enabled': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error('masterBatch.enabled is true or false');
    }
    case 'masterBatch.autoApprove':
      return checkMasterBatchAutoApprove(value);
    case 'autoDeploy.enabled': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error('autoDeploy.enabled is true or false');
    }
    case 'live.enabled': {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      throw new Error('live.enabled is true or false');
    }
    case 'live.idleCloseMinutes': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 1440) return n;
      throw new Error('live.idleCloseMinutes is a whole number of minutes from 0 (never) to 1440');
    }
    case 'timing.unavailableIdleMinutes':
    case 'timing.unavailableBusyMinutes': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 720) return n;
      throw new Error(`${key} is a whole number of minutes from 1 to 720`);
    }
    case 'providers.ffbox.devRequests':
      return checkDevRequests(value);
    case 'intake.reviewers':
      return checkReviewers(value, users ?? []);
    case 'placement.spillAtPercent': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 100) return n;
      throw new Error(`${key} is a whole percent from 1 to 100: the load (the larger of CPU use and agents mid-turn over the cap) past which new work spills down the placement list; 100 turns the spill off`);
    }
    case 'placement.prefer':
    case 'placement.live':
    case 'placement.build': {
      const name = key;
      const list = typeof value === 'string' ? value.split(',') : value;
      if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new Error(`${name} is a list of computers, first choice first: machine ids such as "lothdesktop" (or one comma-separated string)`);
      const ids = [...new Set(list.map((x) => placeId(x as string)).filter(Boolean))];
      const bad = ids.find((x) => !MACHINE_KEY.test(x) || x === 'host');
      if (bad) throw new Error(`${name}: "${bad.slice(0, 40)}" is not a machine id (letters, digits, dashes)${NO_HOST}`);
      if (ids.length > 12) throw new Error(`${name} names at most 12 computers`);
      return ids.length ? ids : undefined;
    }
    case 'placement.hold': {
      // w1863, lothsahn: "stop all work on LothDesktop except w1785 until it's done": a hold may name the requests it lets
      // through, { "lothdesktop": { "why": "...", "except": ["w1785"] } }; a plain string holds everything (w1089, w1376).
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('placement.hold is an object: computer id to who holds it and why, e.g. { "m5": "Ben testing, 2026-10-12" }, or to { "why": "...", "except": ["w1785"] } to let the workers of those requests through');
      const out: Record<string, string | { why: string; except: string[] }> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const id = placeId(k);
        if (!MACHINE_KEY.test(id) || id === 'host') throw new Error(`placement.hold: "${k.slice(0, 40)}" is not a machine id${NO_HOST}`);
        const obj = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
        const why = obj ? obj.why : v;
        if (typeof why !== 'string' || !oneLine(why) || oneLine(why).length > 200) throw new Error(`placement.hold.${id}: say who holds it and why in one line of at most 200 characters${obj ? ' (its "why")' : ''}`);
        const extra = obj ? Object.keys(obj).filter((x) => x !== 'why' && x !== 'except') : [];
        if (extra.length) throw new Error(`placement.hold.${id}: only "why" and "except" (unknown: ${extra.join(', ').slice(0, 60)})`);
        const ex = obj?.except === undefined ? [] : typeof obj.except === 'string' ? obj.except.split(',') : obj.except;
        if (!Array.isArray(ex) || ex.some((x) => typeof x !== 'string' || !/^w\d{1,6}$/i.test(x.trim()))) throw new Error(`placement.hold.${id}.except: a list of request ids such as "w1785"`);
        const except = [...new Set((ex as string[]).map((x) => x.trim().toLowerCase()))];
        if (except.length > 12) throw new Error(`placement.hold.${id}.except names at most 12 requests`);
        out[id] = except.length ? { why: oneLine(why), except } : oneLine(why);
      }
      if (Object.keys(out).length > 12) throw new Error('placement.hold names at most 12 computers');
      return Object.keys(out).length ? out : undefined;
    }
    case 'placement.avoid': {
      const name = key;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('placement.avoid is an object: computer id to why, e.g. { "beast": "BEAST unstable, 2026-10-05" }');
      const out: Record<string, string> = {};
      for (const [k, why] of Object.entries(value as Record<string, unknown>)) {
        const id = placeId(k);
        if (!MACHINE_KEY.test(id) || id === 'host') throw new Error(`${name}: "${k.slice(0, 40)}" is not a machine id${NO_HOST}`);
        if (typeof why !== 'string' || !oneLine(why) || oneLine(why).length > 200) throw new Error(`${name}.${id}: say why in one line of at most 200 characters`);
        out[id] = oneLine(why);
      }
      if (Object.keys(out).length > 12) throw new Error(`${name} names at most 12 computers`);
      return Object.keys(out).length ? out : undefined;
    }
    case 'placement.minPriority': {
      // w1643, lothsahn: "If normal (all work), if high, high and urgent, if urgent, urgent only". normal is the default, so
      // it is not stored: a computer left out takes all work.
      const name = key;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} is an object: computer id to the lowest priority of work it takes (${MIN_PRIORITIES.join(', ')}), e.g. { "beast": "urgent" }`);
      const out: Record<string, MinPriority> = {};
      for (const [k, level] of Object.entries(value as Record<string, unknown>)) {
        const id = placeId(k);
        if (!MACHINE_KEY.test(id) || id === 'host') throw new Error(`${name}: "${k.slice(0, 40)}" is not a machine id${NO_HOST}`);
        const lv = typeof level === 'string' ? level.trim().toLowerCase() : level;
        if (!MIN_PRIORITIES.includes(lv as MinPriority)) throw new Error(`${name}.${id}: ${JSON.stringify(level)?.slice(0, 40)} is not a level; one of ${MIN_PRIORITIES.join(', ')} (normal: all work, low included; high: high and urgent work only; urgent: urgent work only)`);
        if (lv !== 'normal') out[id] = lv as MinPriority;
      }
      if (Object.keys(value as object).length > 12) throw new Error(`${name} names at most 12 computers`);
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


/**
 * providers.ffbox.token (w1078): its hash into the file in the secrets folder (FFBOX_HASH_FILE, 0600) that config
 * providers.ffbox.tokenSha256File names, never into config.json; undefined removes the file and the key. config.json is
 * written only when the key changes (the first time), and an old inline hash is taken out with it. The connector reads the
 * file at its next connection (server/configMigration.ts ffboxTokenHash).
 */
function setFfboxToken(file: string, cfg: Config, raw: Record<string, unknown>, text: string, hash: string | undefined): { before: unknown; after: unknown } {
  const hashFile = cfg.providers?.ffbox?.tokenSha256File ?? path.join(secretsDirOf(file), FFBOX_HASH_FILE);
  const before = ffboxTokenHash(cfg);
  writeFfboxTokenHash(hashFile, hash, file);
  const named = getPath(raw, 'providers.ffbox.tokenSha256File');
  const want = hash === undefined ? undefined : hashFile;
  if (named !== want || getPath(raw, 'providers.ffbox.tokenSha256') !== undefined) {
    setPath(raw, 'providers.ffbox.tokenSha256File', want);
    setPath(raw, 'providers.ffbox.tokenSha256', undefined);
    writeFileDurable(file + '.prev', text, { generations: 0 });
    writeFileDurable(file, JSON.stringify(raw, null, 2) + '\n');
  }
  const ffbox = { ...cfg.providers?.ffbox };
  delete ffbox.tokenSha256;
  if (want === undefined) delete ffbox.tokenSha256File;
  else ffbox.tokenSha256File = want;
  cfg.providers = { ...cfg.providers, ffbox };
  return { before: maskSecret(before), after: maskSecret(hash) };
}

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

/**
 * The Intake tab's click-to-toggle on the nightly chips (w903): flips `intake.nightly.enabled` (regressions filed) or the
 * `enabled` flag of `intake.nightly.run` (the portal's nightly schedule) through setAppConfig, so it is checked, written
 * to config.json and applied live exactly as set_app_config does. The run block's other keys (time, tz, machine, person,
 * reportWithinHours) are kept as they are. Anyone may toggle them, as set_app_config allows (SETTABLE_KEYS comment).
 */
export function toggleNightly(file: string, cfg: Config, which: 'enabled' | 'run' | 'review', on: boolean, users: readonly string[]): { key: SettableKey; before: boolean; after: boolean } {
  if (typeof on !== 'boolean') throw new Error('on is true or false');
  if (which === 'enabled') {
    const r = setAppConfig(file, cfg, 'intake.nightly.enabled', on, { users });
    return { key: 'intake.nightly.enabled', before: r.before === true, after: r.after === true };
  }
  if (which === 'review') {
    // The merge review's timer (w905): its enabled flag only; time, zone, machine and person stay.
    const r = setAppConfig(file, cfg, 'intake.nightly.review', { ...cfg.intake?.nightly?.review, enabled: on }, { users });
    return { key: 'intake.nightly.review', before: (r.before as { enabled?: unknown } | undefined)?.enabled === true, after: on };
  }
  if (which !== 'run') throw new Error('which is "enabled", "run" or "review"');
  const cur = cfg.intake?.nightly?.run;
  const r = setAppConfig(file, cfg, 'intake.nightly.run', { ...cur, enabled: on }, { users });
  const was = r.before as { enabled?: unknown } | undefined;
  return { key: 'intake.nightly.run', before: was?.enabled === true, after: on };
}

/** A machine id as config machines.githubFromVault and machines.cleanup.* name it (server/machines.ts MACHINE_ID). */
const MACHINE_KEY = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * A per-machine setting (machines.githubFromVault, machines.cleanup.*) after setting it to `v` (undefined:
 * removing it) for `machine`, or for every machine not named when `machine` is absent. Per-machine entries
 * survive a change of the rest, which is "*" once there are any: { "*": false, "m5": true }. Collapses back to a
 * plain value (or nothing) when it can.
 */
export function nextPerMachine<T extends boolean | number | string>(cur: unknown, machine: string | undefined, v: T | undefined): T | Record<string, T> | undefined {
  const obj: Record<string, T> = typeof cur === 'object' && cur !== null ? { ...(cur as Record<string, T>) } : typeof cur === 'boolean' || typeof cur === 'number' || typeof cur === 'string' ? { '*': cur as T } : {};
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
 * file) and in the running config. Returns the value before and after. `opts.machine`: for the per-machine keys
 * (machines.githubFromVault, machines.cleanup.*), the one machine to set (absent: every machine not named).
 * providers.ffbox.token is never written to config.json (w1078): its hash goes to the file in the secrets folder that
 * providers.ffbox.tokenSha256File names (named there the first time).
 */
/**
 * placement.hold's value as stored (w1863): the reasons under `hold`, which every reader takes, and the requests each hold
 * lets through under `holdExcept`. Undefined parts are left out.
 */
function splitHold(v: unknown): { hold?: Record<string, string>; except?: Record<string, string[]> } {
  const given = (v ?? {}) as Record<string, string | { why: string; except: string[] }>;
  const hold = Object.fromEntries(Object.entries(given).map(([id, x]) => [id, typeof x === 'string' ? x : x.why]));
  const except = Object.fromEntries(Object.entries(given).flatMap(([id, x]) => (typeof x === 'string' ? [] : [[id, x.except]])));
  return { ...(Object.keys(hold).length ? { hold } : {}), ...(Object.keys(except).length ? { except } : {}) };
}

export function setAppConfig(file: string, cfg: Config, key: SettableKey, value: unknown, opts: { machine?: string; users?: readonly string[] } = {}): { before: unknown; after: unknown } {
  if (!SETTABLE_KEYS.includes(key)) throw new Error(`${key} cannot be changed by an agent; allowed: ${SETTABLE_KEYS.join(', ')}`);
  const perMachine = key === 'machines.githubFromVault' || key.startsWith('machines.activityPause.') || key.startsWith('machines.personPlay.') || (key.startsWith('machines.cleanup.') && key !== 'machines.cleanup.staleOutput');
  if (opts.machine !== undefined && (!perMachine || !MACHINE_KEY.test(opts.machine))) throw new Error(`machine is only for machines.githubFromVault, machines.activityPause.*, machines.personPlay.* and machines.cleanup.*, and is a machine id such as "m5"`);
  const v = normalizeSetting(key, value, cfg, opts.users);
  const text = fs.readFileSync(file, 'utf8');
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
  if (key === 'providers.ffbox.token') return setFfboxToken(file, cfg, raw, text, v as string | undefined);
  const before = getPath(raw, key);
  const next = perMachine ? nextPerMachine(before, opts.machine, v as boolean | number | string | undefined) : v;
  // w1863: a hold's { why, except } form is stored split, so every reader of placement.hold keeps getting reasons.
  if (key === 'placement.hold') {
    const split = splitHold(next);
    setPath(raw, 'placement.hold', split.hold);
    setPath(raw, 'placement.holdExcept', split.except);
  } else setPath(raw, key, next);
  // The last vault.unattributed key removed leaves no empty block behind.
  if (key.startsWith('vault.unattributed.') && Object.keys((getPath(raw, 'vault.unattributed') as object) ?? {}).length === 0) setPath(raw, 'vault.unattributed', undefined);
  writeFileDurable(file + '.prev', text, { generations: 0 });
  writeFileDurable(file, JSON.stringify(raw, null, 2) + '\n');
  // Live: the running server reads these through the shared config object.
  if (key === 'ownerName') cfg.ownerName = v as string | undefined;
  else if (key === 'voice.vocabulary') cfg.voice.vocabulary = (v as string[] | undefined) ?? [];
  else if (key === 'voice.ttsVoice') cfg.voice.ttsVoice = (v as string | undefined) ?? VOICE_DEFAULTS.ttsVoice;
  else if (key === 'hostGuard.devDriveVhdx') cfg.hostGuard.devDriveVhdx = (v as string | undefined) ?? '';
  else if (key === 'publicUrl') cfg.publicUrl = v as string | undefined;
  else if (key === 'attachments.maxMB' || key === 'attachments.retentionDays') {
    const field = key === 'attachments.maxMB' ? 'maxMB' : 'retentionDays';
    const a = { ...cfg.attachments };
    if (v === undefined) delete a[field];
    else a[field] = v as number;
    cfg.attachments = a;
  }
  else if (key === 'claudeAccounts.dispatcher') {
    const accounts = { ...cfg.claudeAccounts };
    if (v === undefined) delete accounts.dispatcher;
    else accounts.dispatcher = v as ClaudeAccount;
    cfg.claudeAccounts = accounts;
  } else if (key === 'machines.githubFromVault') cfg.machines = { ...cfg.machines, githubFromVault: next as boolean | Record<string, boolean> | undefined };
  else if (key.startsWith('vault.pool.')) {
    // Live: the pool picks read the limits at each process start (poolLimits).
    const pool = { ...cfg.vault?.pool } as Record<string, number | undefined>;
    const field = key.slice('vault.pool.'.length);
    if (v === undefined) delete pool[field];
    else pool[field] = v as number;
    cfg.vault = { ...cfg.vault, pool: pool as NonNullable<Config['vault']>['pool'] };
  }
  else if (key.startsWith('vault.unattributed.')) {
    // Live: the intake, the standing agent runs and the token picks read cfg.vault.unattributed at each use (unattributedPerson).
    const unattributed = { ...cfg.vault?.unattributed } as Record<string, string | undefined>;
    const kind = key.slice('vault.unattributed.'.length);
    if (v === undefined) delete unattributed[kind];
    else unattributed[kind] = v as string;
    cfg.vault = { ...cfg.vault, unattributed: Object.keys(unattributed).length ? (unattributed as NonNullable<Config['vault']>['unattributed']) : undefined };
  }
  else if (key === 'systemPayer') cfg.systemPayer = v as string | undefined;
  else if (key === 'providers.ffbox.enabled' || key === 'providers.ffbox.devRequests') {
    const ffbox = { ...cfg.providers?.ffbox };
    if (key === 'providers.ffbox.enabled') ffbox.enabled = v as boolean | undefined;
    else ffbox.devRequests = v as DevRequestsConfig | undefined;
    cfg.providers = { ...cfg.providers, ffbox };
  }
  else if (key === 'intake.ffbox') cfg.intake = { ...cfg.intake, ffbox: v as IntakeConfig['ffbox'] };
  else if (key === 'intake.reviewers') cfg.intake = { ...cfg.intake, reviewers: v as string[] | undefined };
  else if (key === 'intake.nightly.enabled' || key === 'intake.nightly.run' || key === 'intake.nightly.review' || key === 'intake.nightly.autoApprove') {
    // Live: the intake reads its settings at every look (intakeSettings), the schedule's every minute.
    const nightly = { ...cfg.intake?.nightly };
    if (key === 'intake.nightly.enabled') nightly.enabled = v as boolean | undefined;
    else if (key === 'intake.nightly.run') nightly.run = v as NonNullable<IntakeConfig['nightly']>['run'];
    else if (key === 'intake.nightly.autoApprove') nightly.autoApprove = v as NonNullable<IntakeConfig['nightly']>['autoApprove'];
    else nightly.review = v as NonNullable<IntakeConfig['nightly']>['review'];
    cfg.intake = { ...cfg.intake, nightly };
  }
  else if (key === 'masterBatch.enabled' || key === 'masterBatch.autoApprove') {
    // Live: the master batch watch reads its settings at every look.
    const mb = { ...cfg.masterBatch };
    if (key === 'masterBatch.enabled') mb.enabled = v as boolean | undefined;
    else mb.autoApprove = v as NonNullable<Config['masterBatch']>['autoApprove'];
    cfg.masterBatch = mb;
  }
  // Live: the automatic deploy reads cfg.autoDeploy.enabled at every pass (each minute); null is the default, on.
  else if (key === 'autoDeploy.enabled') {
    const ad = { ...cfg.autoDeploy };
    if (v === undefined) delete ad.enabled;
    else ad.enabled = v as boolean;
    cfg.autoDeploy = ad;
  }
  // Live: the live view reads cfg.live.enabled at every use (server/live.ts); null is the default, off.
  else if (key === 'live.enabled' || key === 'live.idleCloseMinutes') {
    // Live: the idle close reads cfg.live.idleCloseMinutes at every pass (server/liveIdle.ts); null is the default, 15.
    const l: NonNullable<Config['live']> = { ...cfg.live };
    const field = key === 'live.enabled' ? 'enabled' : 'idleCloseMinutes';
    if (v === undefined) delete l[field];
    else (l as Record<string, unknown>)[field] = v;
    cfg.live = Object.keys(l).length ? l : undefined;
  }
  else if (key === 'timing.unavailableIdleMinutes' || key === 'timing.unavailableBusyMinutes') {
    // Timing: read at every timed_place, leg bound and timed-run pass (server/timedAsk.ts unavailableWait); null is the default.
    const t: NonNullable<Config['timing']> = { ...cfg.timing };
    const field = key === 'timing.unavailableIdleMinutes' ? 'unavailableIdleMinutes' : 'unavailableBusyMinutes';
    if (v === undefined) delete t[field];
    else t[field] = v as number;
    cfg.timing = Object.keys(t).length ? t : undefined;
  }
  else if (key === 'placement.prefer' || key === 'placement.avoid' || key === 'placement.hold' || key === 'placement.live' || key === 'placement.build' || key === 'placement.minPriority' || key === 'placement.spillAtPercent') {
    const p = { ...cfg.placement };
    const field = key === 'placement.spillAtPercent' ? 'spillAtPercent' : key === 'placement.prefer' ? 'prefer' : key === 'placement.avoid' ? 'avoid' : key === 'placement.live' ? 'live' : key === 'placement.build' ? 'build' : key === 'placement.minPriority' ? 'minPriority' : 'hold';
    const split = field === 'hold' ? splitHold(v) : undefined;
    if (v === undefined) delete p[field];
    else (p as Record<string, unknown>)[field] = split ? split.hold : v;
    // w1863: the whole hold is replaced, so are its exceptions.
    if (split?.except) p.holdExcept = split.except;
    else if (split) delete p.holdExcept;
    cfg.placement = p;
  }
  else if (key === 'hostGuard.cleanup.staleOutput') cfg.hostGuard.cleanup.staleOutput = v as Partial<StaleOutputSettings> | undefined;
  else if (key === 'machines.cleanup.staleOutput') cfg.machines = { ...cfg.machines, cleanup: { ...cfg.machines?.cleanup, staleOutput: v as Partial<StaleOutputSettings> | undefined } };
  else if (key === 'hostGuard.cleanup.ageRules') cfg.hostGuard.cleanup.ageRules = (v as { path: string; olderThanDays: number }[] | undefined) ?? [];
  else if (key === 'orchestrator.compactAtTokens') cfg.orchestrator = { ...cfg.orchestrator, compactAtTokens: v as number | undefined };
  else if (key === 'worker.compactAtTokens' || key === 'worker.compactBeforeWaitTokens' || key === 'worker.compactPilotPercent' || key === 'worker.earlyCompactPilotPercent' || key === 'worker.earlyCompactAtTokens' || key === 'worker.earlyCompactMidTurnTokens' || key === 'worker.terseProsePilotPercent' || key === 'worker.readChainPilotPercent' || key === 'worker.freshAfterMergePilotPercent' || key === 'worker.mergeOnGreenPilotPercent') cfg.worker = { ...cfg.worker, [key.slice('worker.'.length)]: v as number | undefined };
  // Live: each worker's launch spec reads it when its session starts (agents.ts machineSandboxSpec, standing.ts).
  else if (key === 'worker.effort') cfg.worker = { ...cfg.worker, effort: (v as Config['worker']['effort'] | undefined) ?? DEFAULT_WORKER_EFFORT };
  else if (key === 'orchestrator.compactAtTurnUsd') cfg.orchestrator = { ...cfg.orchestrator, compactAtTurnUsd: v as number | undefined };
  // Live: the automatic compaction reads them at each check (autoCompactSettings).
  else if (key === 'orchestrator.compactIdleSeconds' || key === 'orchestrator.compactHardAtTokens') cfg.orchestrator = { ...cfg.orchestrator, [key.slice('orchestrator.'.length)]: v as number | undefined };
  else if (key === 'orchestrator.filingsPerMessage') cfg.orchestrator = { ...cfg.orchestrator, filingsPerMessage: v as number | undefined };
  else if (key === 'orchestrator.followUpsPerMessage') cfg.orchestrator = { ...cfg.orchestrator, followUpsPerMessage: v as number | undefined };
  else if (key === 'orchestrator.messagesPerPerson') cfg.orchestrator = { ...cfg.orchestrator, messagesPerPerson: v as number | undefined };
  // Live: the filings limit reads it at every filing (orchestrators.ts timerFilings).
  else if (key === 'orchestrator.timerFilingsPerMessage') cfg.orchestrator = { ...cfg.orchestrator, timerFilingsPerMessage: v as Record<string, number> | undefined };
  else if (key === 'orchestrator.routineModel') cfg.orchestrator = { ...cfg.orchestrator, routineModel: v as string | undefined };
  else if (key === 'orchestrator.routineAfterMinutes') cfg.orchestrator = { ...cfg.orchestrator, routineAfterMinutes: v as number | undefined };
  else if (key === 'usagePollMinutes') cfg.usagePollMinutes = (v as number | undefined) ?? DEFAULT_USAGE_POLL_MINUTES;
  else if (key === 'hostGuard.cleanup.everyMinutes') cfg.hostGuard.cleanup.everyMinutes = (v as number | undefined) ?? DEFAULT_CLEANUP.everyMinutes;
  else if (key === 'hostGuard.cleanup.softFreeGB') cfg.hostGuard.cleanup.softFreeGB = (v as number | undefined) ?? DEFAULT_CLEANUP.softFreeGB;
  // Live: the next clean-up pass reads it (index.ts, the host's pass).
  else if (key === 'hostGuard.cleanup.mediaDays') cfg.hostGuard.cleanup.mediaDays = (v as number | undefined) ?? DEFAULT_CLEANUP.mediaDays;
  // Live: the host guard reads its levels at every look (server/hostHealth.ts).
  else if (key === 'hostGuard.warnFreeGB') cfg.hostGuard.warnFreeGB = (v as number | undefined) ?? HOST_GUARD_DEFAULTS.warnFreeGB;
  else if (key === 'hostGuard.criticalFreeGB') cfg.hostGuard.criticalFreeGB = (v as number | undefined) ?? HOST_GUARD_DEFAULTS.criticalFreeGB;
  else if (key === 'machines.activityPause.enabled' || key === 'machines.activityPause.idleMinutes') {
    const field = key === 'machines.activityPause.enabled' ? 'enabled' : 'idleMinutes';
    cfg.machines = { ...cfg.machines, activityPause: { ...cfg.machines?.activityPause, [field]: next as never } };
  }
  // Live: sent with the next bench priorities (each minute, server/machines.ts benchPrioritiesMsg).
  else if (key === 'machines.personPlay.enabled' || key === 'machines.personPlay.graceMinutes' || key === 'machines.personPlay.who') {
    const field = key.slice('machines.personPlay.'.length) as 'enabled' | 'graceMinutes' | 'who';
    cfg.machines = { ...cfg.machines, personPlay: { ...cfg.machines?.personPlay, [field]: next as never } };
  }
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

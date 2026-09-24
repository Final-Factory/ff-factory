import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { commandLine, isAlive, isWindows, launchIndependent, run, sleep } from './proc.ts';

/**
 * Whether this server runs with administrator rights, and what to do about it.
 *
 * Everything the server starts inherits its token: agents' shells, and every Unity editor. An
 * elevated Unity editor stops at startup on a modal "Unity is running as administrator." dialog
 * (Unity.dll, 6000.3) and sits in "starting" until someone clicks it. The app is meant to run from
 * the Limited "ffsb-server" task (scripts/install-autostart.ps1); an elevated server only happens
 * when someone starts it by hand from an admin shell.
 */

export type Integrity = 'untrusted' | 'low' | 'medium' | 'high' | 'system';

const INTEGRITY_SIDS: Record<string, Integrity> = {
  'S-1-16-0': 'untrusted',
  'S-1-16-4096': 'low',
  'S-1-16-8192': 'medium',
  'S-1-16-8448': 'medium', // medium plus
  'S-1-16-12288': 'high',
  'S-1-16-16384': 'system',
};

/** One CSV row of `whoami /groups /fo csv`: quoted fields, commas inside quotes allowed. */
function csvFields(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"]|"")*)"|([^,]+)|(?<=,)(?=,|$)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    out.push((m[1] ?? m[2] ?? '').replace(/""/g, '"'));
    if (m[0] === '') re.lastIndex++;
  }
  return out;
}

export interface TokenInfo {
  integrity?: Integrity;
  /** BUILTIN\Administrators is an enabled group (not "deny only", as it is in a UAC-filtered token). */
  adminGroupEnabled: boolean;
}

/** Parse `whoami /groups /fo csv`. Language-independent: it keys on SIDs, not names. */
export function parseWhoamiGroups(csv: string): TokenInfo {
  let integrity: Integrity | undefined;
  let adminGroupEnabled = false;
  for (const line of csv.split(/\r?\n/)) {
    const f = csvFields(line.trim());
    const sid = f.find((x) => /^S-1-(16|5-32)-\d+$/.test(x));
    if (!sid) continue;
    if (INTEGRITY_SIDS[sid]) integrity = INTEGRITY_SIDS[sid];
    // Attributes are localized; a filtered token marks the admin group "Group used for deny only",
    // which has no "Enabled group" among its attributes. Check the English words and the count of
    // attributes as a fallback: an enabled group lists three (mandatory, enabled by default, enabled).
    if (sid === 'S-1-5-32-544') {
      const attrs = f[f.length - 1] ?? '';
      adminGroupEnabled = /enabled group/i.test(attrs) || (!/deny only/i.test(attrs) && attrs.split(',').length >= 3);
    }
  }
  return { integrity, adminGroupEnabled };
}

/** Elevated as Unity would see it: a high/system integrity token, or an enabled Administrators group. */
export function tokenIsElevated(t: TokenInfo): boolean {
  return t.integrity === 'high' || t.integrity === 'system' || t.adminGroupEnabled;
}

export async function currentProcessElevated(): Promise<boolean> {
  if (!isWindows) return typeof process.getuid === 'function' && process.getuid() === 0;
  const r = await run('whoami.exe', ['/groups', '/fo', 'csv'], { timeoutMs: 15_000 });
  if (r.code !== 0) return false; // unknown: do not block on it
  return tokenIsElevated(parseWhoamiGroups(r.stdout));
}

// ---------------------------------------------------------------- hand-off to the Limited task

/** FFSB_TASK_NAME overrides it for tests (scripts/common.ps1 reads the same variable). */
export const TASK_NAME = process.env.FFSB_TASK_NAME || 'ffsb-server';
/** Set (to anything) in the environment to stop an elevated server from handing itself off. */
export const NO_HANDOFF_ENV = 'FFSB_NO_DEELEVATE';
/** A failed hand-off is not retried for this long, so a broken task cannot cause a restart loop. */
export const HANDOFF_RETRY_MS = 15 * 60_000;

export interface HandoffFacts {
  elevated: boolean;
  optedOut: boolean;
  /** RunLevel of the ffsb-server task, or undefined when there is no such task. */
  taskRunLevel?: string;
  /** A supervisor (scripts/supervise.ps1) is running and would otherwise restart us elevated. */
  supervisorPid?: number;
  lastAttemptMs?: number;
  nowMs: number;
}

/** What an elevated server should do at startup: hand itself to the Limited task, or stay and warn. */
export function planHandoff(f: HandoffFacts): { handoff: true } | { handoff: false; why?: string } {
  if (!f.elevated) return { handoff: false };
  if (f.optedOut) return { handoff: false, why: `${NO_HANDOFF_ENV} is set (a hand-off to the ${TASK_NAME} task already failed or was declined)` };
  if (!f.taskRunLevel) return { handoff: false, why: `there is no ${TASK_NAME} scheduled task; run scripts/install-autostart.ps1 once, then scripts/restart.ps1` };
  if (f.taskRunLevel.toLowerCase() !== 'limited') {
    return { handoff: false, why: `the ${TASK_NAME} task runs at RunLevel ${f.taskRunLevel}, not Limited; re-run scripts/install-autostart.ps1` };
  }
  if (!f.supervisorPid) return { handoff: false, why: 'no supervisor is running, so nothing would restart the server after a hand-off; run scripts/restart.ps1' };
  if (f.lastAttemptMs !== undefined && f.nowMs - f.lastAttemptMs < HANDOFF_RETRY_MS) {
    return { handoff: false, why: `a hand-off to the ${TASK_NAME} task was tried ${Math.round((f.nowMs - f.lastAttemptMs) / 60_000)} min ago and the server is still elevated` };
  }
  return { handoff: true };
}

/** RunLevel of the ffsb-server task ("Limited" / "Highest"), or undefined if it does not exist. */
export async function taskRunLevel(): Promise<string | undefined> {
  if (!isWindows) return undefined;
  const r = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `$t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; if ($t) { [string]$t.Principal.RunLevel }`],
    { timeoutMs: 30_000 },
  );
  return r.stdout.trim() || undefined;
}

async function supervisorPid(dataDir: string): Promise<number | undefined> {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir, 'supervisor.pid'), 'utf8').trim());
    if (pid && isAlive(pid) && (await commandLine(pid))?.includes('supervise.ps1')) return pid;
  } catch {
    // no pid file
  }
  return undefined;
}

export interface ElevationStatus {
  elevated: boolean;
  /** Set when elevated: why the server stayed elevated, for the log and the UI banner. */
  why?: string;
}

/**
 * Run once at startup, before anything else starts. Returns 'exit' when the server has handed itself
 * to the Limited task: scripts/restart.ps1 (started detached, elevated like us) stops the supervisor,
 * waits for this process to exit and runs the task, which starts a fresh, non-elevated supervisor.
 */
export async function checkElevation(dataDir: string): Promise<ElevationStatus | 'exit'> {
  const elevated = await currentProcessElevated();
  if (!elevated) return { elevated: false };
  const stamp = path.join(dataDir, 'deelevate.last');
  let lastAttemptMs: number | undefined;
  try {
    lastAttemptMs = fs.statSync(stamp).mtimeMs;
  } catch {
    // never tried
  }
  const sup = await supervisorPid(dataDir);
  const plan = planHandoff({
    elevated,
    optedOut: !!process.env[NO_HANDOFF_ENV],
    taskRunLevel: await taskRunLevel(),
    supervisorPid: sup,
    lastAttemptMs,
    nowMs: Date.now(),
  });
  if (!plan.handoff) return { elevated: true, why: plan.why };

  fs.writeFileSync(stamp, new Date().toISOString());
  const script = path.join(ROOT, 'scripts', 'restart.ps1');
  try {
    await launchIndependent('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
      '-NoDrain', '-Reason', `the server started elevated; handing it to the Limited ${TASK_NAME} task`, '-ExitingServerPid', String(process.pid),
    ]);
  } catch (e) {
    return { elevated: true, why: `handing off to the ${TASK_NAME} task failed: ${(e as Error).message}` };
  }
  // restart.ps1 stops the supervisor first (so it cannot restart us elevated), then waits for us.
  for (let i = 0; i < 60 && sup && isAlive(sup); i++) await sleep(500);
  // Still supervised: the hand-off did not happen. Exiting now would only get us restarted, elevated.
  if (sup && isAlive(sup)) return { elevated: true, why: `the hand-off to the ${TASK_NAME} task did not stop the supervisor; see data/supervisor.log` };
  return 'exit';
}

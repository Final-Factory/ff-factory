import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.ts';

/**
 * The privileged helpers (docs/self-recovery.md): scheduled tasks that run a fixed script as SYSTEM, which
 * scripts/install-privileged-helpers.ps1 registers once (with admin) and lets this app's user trigger. The
 * app can only START one of these fixed actions; it cannot pass arguments or change what they run.
 */
export const HELPERS = {
  /** Attach the sandbox Dev Drive VHDX and bring its volume online at its drive letter. */
  mount: 'ffsb-helper-mount',
  /** Retrim the Dev Drive (free space inside the volume is handed back to the VHDX). */
  trim: 'ffsb-helper-trim',
  /** Detach, compact and reattach the VHDX; refuses while any Unity editor uses the drive. */
  compact: 'ffsb-helper-compact',
  /** Detach the VHDX (the recovery self-test); refuses while any Unity editor uses the drive. */
  detach: 'ffsb-helper-detach',
  /** Controlled reboot in 2 minutes; refuses unless automatic logon is set up (else the app would not come back). */
  reboot: 'ffsb-helper-reboot',
} as const;
export type HelperAction = keyof typeof HELPERS;

/** Where the helpers write their results (readable by everyone, writable by SYSTEM only). */
export const HELPER_RESULTS = path.join(process.env.ProgramData ?? 'C:/ProgramData', 'ffsb-helpers', 'results');

export interface HelperResult {
  action: string;
  ok: boolean;
  at: string;
  detail: string;
}

export function readHelperResult(action: HelperAction, dir = HELPER_RESULTS): HelperResult | undefined {
  try {
    const t = fs.readFileSync(path.join(dir, `${action}.json`), 'utf8');
    return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t) as HelperResult;
  } catch {
    return undefined;
  }
}

/**
 * Start a helper and wait for its result (written after `startedAt`). Resolves with the result, or with
 * ok false and the reason (not installed, access denied, timed out).
 */
export async function runHelper(action: HelperAction, timeoutMs = 5 * 60_000, dir = HELPER_RESULTS): Promise<HelperResult> {
  const started = Date.now();
  const r = await run('schtasks', ['/run', '/tn', HELPERS[action]], { timeoutMs: 30_000 });
  if (r.code !== 0) {
    const why = `${r.stdout}${r.stderr}`.replace(/\s+/g, ' ').trim();
    return { action, ok: false, at: new Date().toISOString(), detail: `could not start ${HELPERS[action]} (${why}); is scripts/install-privileged-helpers.ps1 installed?` };
  }
  while (Date.now() - started < timeoutMs) {
    const res = readHelperResult(action, dir);
    if (res && Date.parse(res.at) >= started - 2000) return res;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { action, ok: false, at: new Date().toISOString(), detail: `${HELPERS[action]} started but wrote no result within ${Math.round(timeoutMs / 1000)} s` };
}

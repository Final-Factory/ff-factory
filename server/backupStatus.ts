// The portal VM's backup and restore drill, for system_status (w5529).
//
// fff-backup (daily, root, deploy/vm/guest/fff-backup) writes /var/lib/fff/backup.json: when it ran, ok / failed / off, why,
// and how the upload was checked (sha256 read back, or size). fff-backup-drill (fffctl backup-drill, monthly) writes
// backup-drill.json beside it: what it restored and checked. Both are root-written, world-readable and hold no secrets. This
// module reads them on every system_status; a missing file (any machine that is not the portal VM) shows nothing. The files
// are data written by another process: strings are clamped, unknown fields ignored.

import fs from 'node:fs';
import path from 'node:path';

/** Where the VM's scripts write (lib.sh FFF_STATE_DIR); FFF_BACKUP_STATE_DIR overrides it (tests). */
export const BACKUP_STATE_DIR = '/var/lib/fff';
/** The backup runs daily: older than this, the last result is stale. */
export const BACKUP_STALE_MS = 26 * 3_600_000;
/** The drill is monthly: older than this, it is due. */
export const DRILL_DUE_MS = 31 * 86_400_000;

const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The backup's and the drill's lines from the two files' contents (undefined: no file). */
export function backupLines(backup: Record<string, unknown> | undefined, drill: Record<string, unknown> | undefined, now: number): string[] {
  if (!backup && !drill) return [];
  const out: string[] = [];
  if (backup) {
    const result = str(backup.result);
    const at = str(backup.at);
    const age = Date.parse(at);
    const why = str(backup.why);
    if (result === 'off') out.push(`Backups: off (${why || 'no target'}).`);
    else if (result === 'failed') out.push(`PROBLEM: the portal's last backup FAILED at ${at}: ${why || 'no reason given'}. sudo fffctl status on the VM.`);
    else if (result === 'ok') {
      const size = typeof backup.size === 'number' ? ` ${Math.round(backup.size / 1_048_576)} MB,` : '';
      out.push(`Backup: ok at ${at} (${str(backup.name)},${size} upload checked by ${str(backup.verified) || 'nothing'}).`);
    } else out.push(`Backup: the last run's result is unknown (${result || 'none'}).`);
    if (result !== 'off' && (Number.isNaN(age) || now - age > BACKUP_STALE_MS)) out.push(`WARNING: the portal's last backup record is from ${at || 'an unknown time'}, over 26 h ago: is fff-backup.timer running?`);
    if (result === 'ok' && str(backup.verified) === 'size') out.push('Backup: its upload was checked by size only (BACKUP_VERIFY=size), not by reading it back.');
  }
  if (!backup || str(backup.result) !== 'off') {
    if (!drill) out.push('Restore drill: never run (monthly; docs/portal-on-ffbox-host.md, 2.2).');
    else {
      const at = str(drill.at);
      const result = str(drill.result);
      const problems = Array.isArray(drill.problems) ? drill.problems.map((p) => str(p, 200)).filter(Boolean).slice(0, 5) : [];
      if (result === 'ok') out.push(`Restore drill: ok at ${at} (${str(drill.source, 120)}).`);
      else out.push(`PROBLEM: the last restore drill FAILED at ${at} (${str(drill.source, 120)}): ${problems.join('; ') || 'no reason given'}.`);
      const age = Date.parse(at);
      if (Number.isNaN(age) || now - age > DRILL_DUE_MS) out.push('Restore drill: DUE (monthly; the last is over 31 days old).');
    }
  }
  return out;
}

/** system_status's backup lines, read now from the VM's state folder. */
export function backupStatusLines(dir = process.env.FFF_BACKUP_STATE_DIR || BACKUP_STATE_DIR, now = Date.now()): string[] {
  return backupLines(readJson(path.join(dir, 'backup.json')), readJson(path.join(dir, 'backup-drill.json')), now);
}

// The daemon's side of a machine rebooting itself (w6792, shared/selfReboot.ts). On Windows it tells its supervisor it works,
// in logs/daemon-alive.json every DAEMON_ALIVE_EVERY_MS ({pid, at, linked}): a fresh one from the daemon the supervisor runs
// now, linked to the portal, ends a stuck episode, so no reboot follows. It reads back what the supervisor wrote about
// rebooting (logs/supervisor-reboot.json) and the daemon sends that to the portal. macOS and Linux have no supervisor of
// ours (launchd and systemd restart the daemon) and a reboot needs root there: they only report why they are not eligible.
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeSelfReboot, type SelfRebootInfo } from '../shared/selfReboot.ts';

/** In the daemon's logs folder: {pid, at, linked}, rewritten every DAEMON_ALIVE_EVERY_MS. */
export const DAEMON_ALIVE = 'daemon-alive.json';
export const DAEMON_ALIVE_EVERY_MS = 30_000;
/** The supervisor counts a heartbeat this old or newer as live (three missed writes are not). */
export const DAEMON_ALIVE_FRESH_S = 90;
/** In the daemon's logs folder: what the supervisor saw and did (shared/selfReboot.ts SelfRebootInfo, plus lastLiveAt). */
export const SELF_REBOOT_STATE = 'supervisor-reboot.json';

/** Why a Mac or Linux machine does not reboot itself (w6792's research, 2026-11-28). */
export const NOT_ELIGIBLE: Partial<Record<NodeJS.Platform, string>> = {
  darwin:
    'macOS: launchd restarts the daemon (KeepAlive) and there is no supervisor of ours to see it stuck; a reboot needs root, and with FileVault on the disk stays locked after a restart until someone types the password, so the machine would not come back by itself',
  linux: 'Linux: systemd restarts the daemon (Restart=always) and there is no supervisor of ours to see it stuck; a reboot needs root, which the daemon does not have',
};

/** Atomically, so the supervisor never reads half a file. */
export function writeAlive(logsDir: string, linked: boolean, now = new Date()): void {
  const file = path.join(logsDir, DAEMON_ALIVE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: now.toISOString(), linked }));
  fs.renameSync(tmp, file);
}

/** What the supervisor wrote (Windows), or why this machine is not eligible (macOS, Linux); undefined when there is nothing yet. */
export function readSelfReboot(logsDir: string, platform: NodeJS.Platform = process.platform): SelfRebootInfo | undefined {
  if (platform !== 'win32') {
    const why = NOT_ELIGIBLE[platform];
    return why ? { eligible: false, why, mode: 'warn' } : undefined;
  }
  try {
    // Windows PowerShell 5.1's Set-Content -Encoding utf8 starts the file with a byte order mark.
    return sanitizeSelfReboot(JSON.parse(fs.readFileSync(path.join(logsDir, SELF_REBOOT_STATE), 'utf8').replace(/^﻿/, '')));
  } catch {
    return undefined;
  }
}

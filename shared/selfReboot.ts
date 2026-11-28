// A machine rebooting itself when its daemon stays stuck (w6792, lothsahn 2026-11-28: "If the daemon is stuck, can we reboot
// after 15minutes? That way it fixes any stuck issues?"). On Windows the supervisor (run-daemon.ps1, server/machineDeployWin.ts)
// watches for a daemon stuck mid-exit (w6784) that its own recovery has not replaced with a working one, and after
// SUPERVISOR_REBOOT_AFTER_S reboots a machine that comes back by itself (automatic logon to the daemon's user, the stored
// password, the logon task), unless someone used its console lately or it rebooted itself in the last hours. It writes what
// it saw and did to logs/supervisor-reboot.json; the daemon reads that (machine/selfReboot.ts) and tells the portal, which
// shows it on the machine's panel. macOS and Linux only report why they are not eligible.

export type SelfRebootMode = 'warn' | 'live';

export interface SelfRebootEvent {
  at: string;
  /** warn: it only said it would reboot (lothsahn's lockout rule, stage 1); live: it rebooted. */
  mode: SelfRebootMode;
  why: string;
  /** When the stuck state it answered began. */
  stuckSince?: string;
}

export interface SelfRebootInfo {
  /** Whether this machine comes back by itself after a reboot (w6792's eligibility). Absent: not read yet. */
  eligible?: boolean;
  /** Eligible: the evidence; not: what is missing. */
  why: string;
  mode: SelfRebootMode;
  checkedAt?: string;
  /** A stuck episode going on now: when it began. */
  stuckSince?: string;
  /** The last time it rebooted itself, or (warn) would have. */
  last?: SelfRebootEvent;
  /** The guard holding the reboot back in the episode going on now (someone at the console, the rate limit, the off switch). */
  skip?: { at: string; why: string };
}

const MAX = 400;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, MAX) : undefined);
const time = (v: unknown): string | undefined => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v.slice(0, 40) : undefined);
const mode = (v: unknown): SelfRebootMode | undefined => (v === 'warn' || v === 'live' ? v : undefined);

/** Only the fields above, as short strings: nothing else a daemon (or the file it read) sends lands on the machine record. */
export function sanitizeSelfReboot(raw: unknown): SelfRebootInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const m = mode(r.mode);
  const why = str(r.why);
  if (!m || !why) return undefined;
  const out: SelfRebootInfo = { why, mode: m };
  if (typeof r.eligible === 'boolean') out.eligible = r.eligible;
  if (time(r.checkedAt)) out.checkedAt = time(r.checkedAt);
  if (time(r.stuckSince)) out.stuckSince = time(r.stuckSince);
  const l = r.last as Record<string, unknown> | undefined;
  if (l && typeof l === 'object' && time(l.at) && mode(l.mode) && str(l.why)) out.last = { at: time(l.at)!, mode: mode(l.mode)!, why: str(l.why)!, ...(time(l.stuckSince) ? { stuckSince: time(l.stuckSince) } : {}) };
  const s = r.skip as Record<string, unknown> | undefined;
  if (s && typeof s === 'object' && time(s.at) && str(s.why)) out.skip = { at: time(s.at)!, why: str(s.why)! };
  return out;
}

/** "eligible (warn only): ..." or "not eligible: ...", for the portal's log and the machine's panel. */
export function selfRebootEligibility(s: SelfRebootInfo): string {
  const warn = s.mode === 'warn' ? ' (warn only)' : '';
  if (s.eligible === undefined) return `self-reboot: not read yet: ${s.why}`;
  return s.eligible ? `self-reboot: eligible${warn}: ${s.why}` : `self-reboot: not eligible: ${s.why}`;
}

/** The machine panel's chip (w6792): on, warn only, off (not eligible), or not read yet; red while a stuck episode goes on. */
export function selfRebootChip(s: SelfRebootInfo): { label: string; tone: 'green' | 'amber' | 'grey' | 'red' } {
  if (s.stuckSince) return { label: 'stuck', tone: 'red' };
  if (s.eligible === undefined) return { label: 'not read yet', tone: 'grey' };
  if (!s.eligible) return { label: 'off', tone: 'grey' };
  return s.mode === 'live' ? { label: 'on', tone: 'green' } : { label: 'warn only', tone: 'amber' };
}

/** "rebooted itself at <at>: <why>", or what it would have done in warn mode. */
export function selfRebootEventLine(e: SelfRebootEvent): string {
  return e.mode === 'live' ? `rebooted itself at ${e.at}: ${e.why}` : `would have rebooted itself at ${e.at} (warn only): ${e.why}`;
}

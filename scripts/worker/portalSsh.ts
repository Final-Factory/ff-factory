/**
 * The worker installer's half of the portal's ssh (w568, docs/worker-install.md "The portal's ssh"; the portal's half is
 * server/machineSsh.ts). Adding a machine is running its installer: nothing by hand on the portal's host or in its VM.
 *
 * 1. The portal's key: GET /machine/ssh with this machine's own credential (never from an unauthenticated source) gives
 *    the authorized_keys line, `from="<the portal's tailnet address>",no-agent-forwarding,... ssh-ed25519 ...`. It goes
 *    where this account's sshd looks: on Windows, for a member of Administrators, the shared
 *    C:\ProgramData\ssh\administrators_authorized_keys (Windows' default sshd_config, `Match Group administrators`;
 *    written in the install's one administrator step, ACL Administrators and SYSTEM only), else ~/.ssh/authorized_keys
 *    (the account and SYSTEM only on Windows; 0600 in a 0700 folder on a Mac). An existing line for the same key is
 *    replaced in place; the uninstall removes exactly the lines for that key, unless the line was there before.
 * 2. This machine's host keys: from its own sshd over loopback (ssh-keyscan 127.0.0.1: no network in between), sent with
 *    the account's user name and the name the portal reaches it by (its tailnet MagicDNS name) to POST /machine/ssh;
 *    the portal pins them in its own known_hosts2 and answers whether its ssh now gets in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The ssh public key in an authorized_keys line (after any options): its base64, or undefined. */
export function keyBlob(line: string): string | undefined {
  const m = /(?:^|[\s,])(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?=\s|$)/.exec(line);
  return m?.[1];
}

const lines = (text: string) => text.split(/\r?\n/);
const joined = (ls: string[]) => {
  const out = ls.join('\n').replace(/\n+$/, '');
  return out ? `${out}\n` : '';
};

/** authorized_keys text with `line` in it: a line for the same key replaced in place, else `line` added at the end. */
export function withAuthorizedKey(text: string, line: string): { text: string; changed: boolean; existed: boolean } {
  const blob = keyBlob(line);
  if (!blob) throw new Error('not an authorized_keys line with an ssh key');
  const ls = lines(text);
  const at = ls.findIndex((l) => !l.trimStart().startsWith('#') && keyBlob(l) === blob);
  if (at >= 0) {
    if (ls[at] === line) return { text: joined(ls), changed: false, existed: true };
    ls[at] = line;
    return { text: joined(ls), changed: true, existed: true };
  }
  return { text: joined([...ls.filter((l, i) => !(i === ls.length - 1 && l === '')), line]), changed: true, existed: false };
}

/** authorized_keys text without the lines for key `blob` (comments and every other key stay). */
export function withoutAuthorizedKey(text: string, blob: string): { text: string; removed: number } {
  const ls = lines(text);
  const kept = ls.filter((l) => l.trimStart().startsWith('#') || keyBlob(l) !== blob);
  return { text: joined(kept), removed: ls.length - kept.length };
}

/**
 * The file this account's sshd reads its keys from: Windows' administrators_authorized_keys for a member of the
 * Administrators group (whether or not this process is elevated: sshd matches the group), else ~/.ssh/authorized_keys.
 */
export function authorizedKeysFile(platform: NodeJS.Platform, home: string, admin: boolean, programData = process.env.ProgramData || 'C:\\ProgramData'): string {
  if (platform === 'win32' && admin) return path.win32.join(programData, 'ssh', 'administrators_authorized_keys');
  return (platform === 'win32' ? path.win32 : path.posix).join(home, '.ssh', 'authorized_keys');
}

/** Whether `whoami /groups /fo csv` lists BUILTIN\Administrators (S-1-5-32-544), deny-only (UAC) or not. */
export const inAdministrators = (whoamiGroupsCsv: string) => /"S-1-5-32-544"/.test(whoamiGroupsCsv);

/**
 * Whether this account is in the Administrators group, as sshd's `Match Group administrators` sees it: a member by
 * SID (Get-LocalGroupMember), or the group on the token (whoami /groups, deny-only in a non-elevated shell; it also
 * covers a domain group nested in it). Both, because either alone misses a case: an account added to the group after
 * this logon is a member sshd sees at its next logon but not on this token, and a nested domain group is no direct
 * member. Measured on BEAST (2026-10-06): both halves say admin=True for rydin.
 */
export const ADMIN_PROBE_PS = `$ErrorActionPreference = 'SilentlyContinue'
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$member = [bool](@(Get-LocalGroupMember -SID 'S-1-5-32-544') | Where-Object { $_.SID.Value -eq $me.User.Value })
$token = [bool](& (Join-Path $env:SystemRoot 'System32\\whoami.exe') /groups /fo csv | Select-String -SimpleMatch '"S-1-5-32-544"')
"admin=$($member -or $token)"`;

export const adminFromProbe = (out: string) => /^admin=True\s*$/m.test(out);

/** The host keys in ssh-keyscan's output, `<type> <base64>`, ed25519 first. */
export function parseKeyscan(out: string): string[] {
  const keys = out
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa)$/.test(f[1]) && /^[A-Za-z0-9+/]+={0,3}$/.test(f[2]))
    .map((f) => `${f[1]} ${f[2]}`);
  const rank = (k: string) => (k.startsWith('ssh-ed25519') ? 0 : k.startsWith('ecdsa') ? 1 : 2);
  return [...new Set(keys)].sort((a, b) => rank(a) - rank(b));
}

/** This node's tailnet name from `tailscale status --json` (Self.DNSName "m3.tailxxxx.ts.net." -> "m3"), or undefined. */
export function tailnetNameOf(statusJson: string): string | undefined {
  try {
    const self = (JSON.parse(statusJson) as { Self?: { DNSName?: string; HostName?: string } }).Self;
    const name = (self?.DNSName ?? '').split('.')[0] || self?.HostName || '';
    return /^[A-Za-z0-9-]{1,63}$/.test(name) ? name.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** The tailscale CLI's likely places: on PATH, the Mac app's, the Windows install's, the Linux package's. */
export function tailscaleCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'];
  if (platform === 'win32') return ['tailscale', path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  return ['tailscale', '/usr/bin/tailscale'];
}

/** The name the portal reaches this machine by when Tailscale cannot say: the computer's own name, lower case. */
export const hostnameFallback = (h = os.hostname()) => h.toLowerCase().replace(/\.local$/, '').split('.')[0];

export interface PortalKey {
  publicKey: string;
  authorizedKey: string;
  from: string | null;
}

/** GET /machine/ssh: the portal's key line, with this machine's own credential. */
export async function fetchPortalKey(portalUrl: string, token: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; key: PortalKey } | { ok: false; error: string }> {
  try {
    const r = await fetcher(`${portalUrl}/machine/ssh`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 404 && !(r.headers.get('content-type') ?? '').includes('json')) return { ok: false, error: 'the portal is too old to set up its ssh from the installer (no /machine/ssh)' };
    const b = (await r.json().catch(() => ({}))) as Partial<PortalKey> & { error?: string };
    if (!r.ok) return { ok: false, error: b.error ?? `the portal answered ${r.status}` };
    if (typeof b.authorizedKey !== 'string' || !keyBlob(b.authorizedKey)) return { ok: false, error: 'the portal sent no usable key line' };
    return { ok: true, key: { publicKey: String(b.publicKey ?? ''), authorizedKey: b.authorizedKey, from: b.from ?? null } };
  } catch (e) {
    return { ok: false, error: `the portal did not answer (${(e as Error).message})` };
  }
}

export interface SshRegistration {
  user: string;
  host: string;
  hostKeys: string[];
}

/** POST /machine/ssh: this machine's ssh user, name and host keys; the portal answers whether its ssh now gets in. */
export async function registerSsh(portalUrl: string, token: string, reg: SshRegistration, fetcher: typeof fetch = fetch): Promise<{ ok: true; host: string; reachable: boolean; detail: string } | { ok: false; error: string }> {
  try {
    const r = await fetcher(`${portalUrl}/machine/ssh`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(reg), signal: AbortSignal.timeout(60_000) });
    const b = (await r.json().catch(() => ({}))) as { error?: string; host?: string; reachable?: boolean; detail?: string };
    if (!r.ok) return { ok: false, error: b.error ?? `the portal answered ${r.status}` };
    return { ok: true, host: String(b.host ?? `${reg.user}@${reg.host}`), reachable: !!b.reachable, detail: String(b.detail ?? '') };
  } catch (e) {
    return { ok: false, error: `the portal did not answer (${(e as Error).message})` };
  }
}

/**
 * Put `line` into authorized_keys file `file` (made if missing), in this process: the Mac's and a non-admin Windows
 * account's own file, or the admin file from the install's elevated step. Returns what changed, and whether the key was
 * there before (an uninstall then leaves it).
 */
export function authorizeIn(file: string, line: string): { changed: boolean; existed: boolean } {
  fs.mkdirSync(path.dirname(file), { recursive: true, ...(process.platform === 'win32' ? {} : { mode: 0o700 }) });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const r = withAuthorizedKey(before, line);
  if (r.changed) fs.writeFileSync(file, r.text, { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(path.dirname(file), 0o700);
    fs.chmodSync(file, 0o600);
  }
  return { changed: r.changed, existed: r.existed };
}

/** Remove key `blob`'s lines from `file` (missing file: nothing to do). */
export function revokeIn(file: string, blob: string): number {
  if (!fs.existsSync(file)) return 0;
  const r = withoutAuthorizedKey(fs.readFileSync(file, 'utf8'), blob);
  if (r.removed) fs.writeFileSync(file, r.text, { mode: 0o600 });
  return r.removed;
}

/**
 * The icacls arguments that give an authorized_keys file the rights Windows' sshd accepts (it ignores a file others
 * can write): the admin file to Administrators and SYSTEM only (Microsoft's OpenSSH key management guide), an
 * account's own file to that account and SYSTEM only. Inheritance off, so nothing else keeps a right.
 */
export function aclArgs(file: string, admin: boolean, user = os.userInfo().username): string[] {
  return admin ? [file, '/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '/grant:r', '*S-1-5-18:F'] : [file, '/inheritance:r', '/grant:r', `${user}:F`, '/grant:r', '*S-1-5-18:F'];
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The portal's ssh to its machines, set up by the worker installer (w568, docs/worker-install.md "The portal's ssh"):
 * adding a machine is running its installer there, with nothing done by hand on the portal's host or in its VM.
 *
 * - The portal's key: the installer fetches the line to authorize (GET /machine/ssh, with the machine's own credential,
 *   never from anywhere unauthenticated) and adds it to the machine's authorized_keys.
 * - The machine's host keys: the installer reads them from the machine's own sshd (a loopback ssh-keyscan) and sends
 *   them with its ssh user and the name the portal reaches it by (POST /machine/ssh). The portal keeps them in its data
 *   (the machine's record in state.json: moved by a migration, kept by the backups, so a rebuilt VM keeps them) and
 *   writes them, pinned, into its own account's ~/.ssh/known_hosts2, which ssh reads by default beside known_hosts
 *   (measured: OpenSSH 9.6 and 9.7, `ssh -G` userknownhostsfile). That file is the portal's alone, rewritten from its
 *   records; known_hosts stays the person's (and deploy/vm/guest/fff-machine-ssh's, for machines from before the installer).
 *
 * Why ssh at all for an installed machine: its daemon is updated by re-running the installer there, never over ssh, but
 * `machine_daemon start|stop|restart` and remove_machine's unload still reach the machine over ssh (server/machines.ts
 * controlDaemon, removeMachine), and start is the only way back for a daemon that is not running.
 */

/** One ssh host key as `<type> <base64>`: the types OpenSSH's sshd offers. */
export const HOST_KEY_RE = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]{32,2048}={0,3}$/;
/** An ssh user: plain characters only (it becomes part of the ssh destination, user@host). */
export const SSH_USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
/** The name the portal reaches the machine by: a hostname (its tailnet MagicDNS name) or an address. */
export const SSH_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

export interface MachineSsh {
  /** The account the daemon runs as there, which the portal's key is authorized for. */
  user: string;
  /** The name the portal reaches it by (lower case). */
  host: string;
  /** Its sshd's host keys, `<type> <base64>`, pinned in the portal's known_hosts2. */
  hostKeys: string[];
  /** When the installer registered them. */
  at: string;
}

/** A registration's body (POST /machine/ssh), checked: what to keep, or why it is refused. */
export function parseSshRegistration(body: unknown, now = new Date()): MachineSsh | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const user = typeof b.user === 'string' ? b.user.trim() : '';
  const host = typeof b.host === 'string' ? b.host.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!SSH_USER_RE.test(user)) return { error: 'user: the ssh user name (letters, digits, ".", "_", "-")' };
  if (!SSH_HOST_RE.test(host)) return { error: 'host: the name the portal reaches this machine by (a hostname or address)' };
  if (!Array.isArray(b.hostKeys) || !b.hostKeys.length || b.hostKeys.length > 8) return { error: 'hostKeys: one to eight "<type> <base64>" host keys' };
  const keys = [...new Set(b.hostKeys.map((k) => (typeof k === 'string' ? k.trim().split(/\s+/).slice(0, 2).join(' ') : '')))];
  const bad = keys.find((k) => !HOST_KEY_RE.test(k));
  if (bad !== undefined) return { error: `hostKeys: not an ssh host key: ${JSON.stringify(bad.slice(0, 60))}` };
  return { user, host, hostKeys: keys, at: now.toISOString() };
}

/** The header that marks known_hosts2 as the portal's (it is rewritten, and removed, only when it carries it). */
export const KNOWN_HOSTS_MARK = '# FF Factory: the machines\' host keys, pinned by their worker installers (server/machineSsh.ts).';

/** known_hosts2's text for these machines (empty when none registered keys). */
export function knownHostsText(machines: { id: string; ssh?: MachineSsh }[]): string {
  const lines = machines.filter((m) => m.ssh?.hostKeys.length).sort((a, b) => a.id.localeCompare(b.id)).flatMap((m) => m.ssh!.hostKeys.map((k) => `${m.ssh!.host} ${k} ${m.id}`));
  if (!lines.length) return '';
  return `${KNOWN_HOSTS_MARK}\n# Rewritten from the portal's machine records (state.json) on each change; an edit here does not last.\n${lines.join('\n')}\n`;
}

/**
 * Write the portal account's ~/.ssh/known_hosts2 from its machines' records: 0600 in a 0700 folder. A file there
 * without the portal's header is someone else's and is left alone. Returns what happened, for the log.
 */
export function writeKnownHosts(machines: { id: string; ssh?: MachineSsh }[], home = os.homedir()): 'written' | 'unchanged' | 'removed' | 'not ours' | 'none' {
  const file = path.join(home, '.ssh', 'known_hosts2');
  const text = knownHostsText(machines);
  let have: string | undefined;
  try {
    have = fs.readFileSync(file, 'utf8');
  } catch {
    have = undefined;
  }
  if (have !== undefined && !have.startsWith(KNOWN_HOSTS_MARK)) return 'not ours';
  if (!text) {
    if (have === undefined) return 'none';
    fs.rmSync(file, { force: true });
    return 'removed';
  }
  if (have === text) return 'unchanged';
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return 'written';
}

/** The options a machine authorizes the portal's key with: only from the portal, and nothing forwarded. */
export const AUTHORIZED_OPTIONS = 'no-agent-forwarding,no-port-forwarding,no-X11-forwarding';

/**
 * The portal's public key and the authorized_keys line for it (GET /machine/ssh): the portal account's
 * ~/.ssh/id_ed25519.pub (the guest install makes it in the VM), restricted with from="<address>" when the portal knows
 * its own tailnet address. Undefined fields: no key here.
 */
export function authorizedKeyLine(publicKey: string, from?: string): string {
  const key = publicKey.trim().split(/\s+/).slice(0, 3).join(' ');
  return `${from ? `from="${from}",` : ''}${AUTHORIZED_OPTIONS} ${key}`;
}

export function portalPublicKey(home = os.homedir()): string | undefined {
  try {
    const text = fs.readFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), 'utf8').trim();
    return /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}( |$)/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The portal's own tailnet IPv4 (`tailscale ip -4`), the address its ssh comes from; undefined without Tailscale. */
export async function tailnetAddress(run: (cmd: string, args: string[], o: { timeoutMs: number }) => Promise<{ code: number | null; stdout: string }>): Promise<string | undefined> {
  const r = await run('tailscale', ['ip', '-4'], { timeoutMs: 5000 }).catch(() => undefined);
  const ip = r?.code === 0 ? r.stdout.trim().split(/\s+/)[0] : undefined;
  return ip && /^100\.(\d{1,3}\.){2}\d{1,3}$/.test(ip) ? ip : undefined;
}

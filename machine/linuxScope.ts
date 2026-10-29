import { spawnSync } from 'node:child_process';

/**
 * w2474: on a Linux PC the daemon starts every Unity editor and every agent host in a transient systemd scope of its own
 * (`systemd-run --user --scope`), so they are not in the daemon's own cgroup.
 *
 * Why: the daemon's unit has `KillMode=process` (server/machineDeployLinux.ts) so that a restart leaves its agents and
 * editors running, and with that alone they all stayed in the unit's one cgroup. systemd-oomd (on by default on Ubuntu
 * desktops) kills a whole cgroup when memory and swap run out. On biscuit on 2026-10-28, Unity filled RAM and swap, and the
 * kills at 10:23 and 10:52 UTC took the daemon with them: the portal saw biscuit close its link at 10:23:11 and come back
 * 11 s later, which is the unit's RestartSec=10. In its own scope an editor (or an agent with its batch Unity) is what
 * gets killed, and the daemon and its link stay up.
 *
 * `--scope` runs the command in place: the process systemd-run starts IS the command after an exec, so the pid the
 * daemon keeps, its start time (machine/hostWatch.ts) and its stdin are the command's (measured in Ubuntu 24.04,
 * systemd 255). Where no user manager answers (a container, no session bus), the command starts as before.
 */

/** How long a probe's answer is kept. */
const PROBE_TTL_MS = 10 * 60_000;

let probed: { ok: boolean; at: number } | undefined;
let seq = 0;

const PROBE_MARK = 'ffw-scope-ok';

/**
 * Whether `systemd-run --user --scope` works here: a scope whose command says PROBE_MARK. The exit status is not enough:
 * with no user bus systemd 255 says "Failed to connect to bus", runs nothing and still exits 0 (measured, Ubuntu 24.04).
 * Exported for tests.
 */
export function probeScopes(run: () => { status: number | null; stdout: string } = () => spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'echo', PROBE_MARK], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })): boolean {
  const r = run();
  return r.status === 0 && (r.stdout ?? '').includes(PROBE_MARK);
}

/** Whether scopes can be used now: probed once, the answer kept PROBE_TTL_MS. Exported for tests. */
export function scopesUsable(probe: () => boolean = probeScopes, now = Date.now()): boolean {
  if (!probed || now - probed.at > PROBE_TTL_MS) probed = { ok: probe(), at: now };
  return probed.ok;
}

/** Forget the probe's answer (tests). */
export function resetScopeProbe() {
  probed = undefined;
}

/**
 * A scope's unit name: `ffw-<kind>-<tag>-<time><n>`, unique (systemd refuses a second scope of the same name while the
 * first is loaded) and within systemd's unit-name characters. Exported for tests.
 */
export function scopeUnit(kind: 'unity' | 'agent', tag: string, now = Date.now()): string {
  const t = tag.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[._-]+/, '').slice(0, 48) || 'x';
  seq = (seq + 1) % 1296;
  return `ffw-${kind}-${t}-${now.toString(36)}${seq.toString(36)}.scope`;
}

/** The command line that runs bin args in a scope of its own. Exported for tests. */
export function inScope(unit: string, bin: string, args: string[]): { bin: string; args: string[] } {
  return { bin: 'systemd-run', args: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', bin, ...args] };
}

/** bin args, run in a scope of their own on a Linux PC whose user manager answers; unchanged anywhere else. */
export function scoped(kind: 'unity' | 'agent', tag: string, bin: string, args: string[], o: { platform?: NodeJS.Platform; usable?: () => boolean } = {}): { bin: string; args: string[] } {
  if ((o.platform ?? process.platform) !== 'linux') return { bin, args };
  if (!(o.usable ?? scopesUsable)()) return { bin, args };
  return inScope(scopeUnit(kind, tag), bin, args);
}

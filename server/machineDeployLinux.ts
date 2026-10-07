/**
 * The Linux half of the daemon's service (docs/worker-install.md, "Linux"): a systemd user unit that runs the daemon as
 * the user who installed it, the way a Mac's LaunchAgent and a Windows PC's scheduled task do. The builders are pure
 * (tested in machineDeployLinux.test.ts); scripts/worker/worker.ts writes the unit and runs the lines.
 *
 * - `Restart=always` is the supervisor (w576): systemd starts the daemon again whenever it exits, as launchd's KeepAlive.
 * - `KillMode=process`: a restart or an update stops the daemon only. Its agent hosts (machine/agentHost.ts, w605) and
 *   the Unity editors it started run in the unit's cgroup, and systemd's default (control-group) would kill them all.
 *   A stop or an uninstall ends the agent hosts itself (pkill, as on a Mac).
 * - `WantedBy=graphical-session.target`: the daemon starts with the user's desktop session, so it gets the session's
 *   DISPLAY / WAYLAND_DISPLAY and XAUTHORITY (the desktop imports them into the user manager) and Unity editors can
 *   open windows. Lingering (`loginctl enable-linger`) keeps the user manager, and so the daemon and its agents,
 *   running after a logout and lets `systemctl --user` work over ssh.
 */

/** A unit label, checked: it is spliced into shell lines and the unit's file name. Exported for tests. */
export function unitLabel(label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(label)) throw new Error(`"${label}" is not a usable systemd unit name`);
  return label;
}

export const unitName = (label: string) => `${unitLabel(label)}.service`;

/** Where the user's systemd manager reads the unit. */
export const unitFile = (home: string, label: string) => `${home.replace(/\/+$/, '')}/.config/systemd/user/${unitName(label)}`;

/** One word of a unit file's command line or Environment=: double-quoted, with systemd's `%` specifiers escaped. Exported for tests. */
export function unitWord(s: string): string {
  if (/[\n\r]/.test(s)) throw new Error('a unit file value cannot hold a line break');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/** A path where systemd takes it unquoted (WorkingDirectory=, StandardOutput=append:): only its `%` specifiers escaped. */
const unitPath = (s: string) => {
  if (/[\n\r]/.test(s)) throw new Error('a unit file value cannot hold a line break');
  return s.replace(/%/g, '%%');
};

/** The daemon's systemd user unit. `path` is the daemon's PATH (machineDeploy agentPath). */
export function systemdUnit(o: { home: string; node: string; flag: boolean; path: string; appDir: string; label: string }): string {
  const dir = o.appDir.replace(/\/+$/, '');
  const app = `${dir}/app`;
  const args = [o.node, ...(o.flag ? ['--experimental-strip-types'] : []), '--disable-warning=ExperimentalWarning', `${app}/machine/daemon.ts`, `${dir}/daemon.json`];
  return `[Unit]
Description=FF Factory worker daemon (${unitLabel(o.label)})
After=graphical-session.target network-online.target

[Service]
Type=simple
ExecStart=${args.map(unitWord).join(' ')}
WorkingDirectory=${unitPath(app)}
Environment=${unitWord(`HOME=${o.home}`)}
Environment=${unitWord(`PATH=${o.path}`)}
Restart=always
RestartSec=10
KillMode=process
StandardOutput=append:${unitPath(dir)}/logs/daemon.log
StandardError=append:${unitPath(dir)}/logs/daemon.log

[Install]
WantedBy=graphical-session.target
`;
}

/** The PATH a unit gives the daemon, or undefined. Exported for tests. */
export function unitPathOf(text: string): string | undefined {
  const m = /^Environment="PATH=((?:[^"\\]|\\.)*)"$/m.exec(text);
  return m ? m[1].replace(/\\(.)/g, '$1').replace(/%%/g, '%') : undefined;
}

/** The unit with its PATH replaced. */
export function withUnitPath(text: string, value: string): string {
  return text.replace(/^Environment="PATH=(?:[^"\\]|\\.)*"$/m, () => `Environment=${unitWord(`PATH=${value}`)}`);
}

/**
 * Load the unit written on disk and (re)start the daemon. `restart` starts one that is stopped, and with KillMode=process
 * it leaves the agent hosts running for the new daemon (w605). Exported for tests.
 */
export function linuxReloadLines(label: string): string {
  const unit = unitName(label);
  return `systemctl --user daemon-reload
systemctl --user enable ${unit}
systemctl --user restart ${unit}
`;
}

export type LinuxAction = 'start' | 'stop' | 'restart' | 'uninstall';

/** systemctl lines for each action on the unit. Exported for tests. */
export function linuxControlScript(action: LinuxAction, label: string, appDir?: string): string {
  const unit = unitName(label);
  const file = `"$HOME/.config/systemd/user/${unit}"`;
  // A stop or uninstall ends this daemon's agent hosts too (w605); a restart leaves them for the next daemon.
  const host = appDir ? `'${appDir.replace(/\/+$/, '').replace(/'/g, `'\\''`)}/app/machine/agentHost.ts'` : '"$HOME/.ff-factory/app/machine/agentHost.ts"';
  const hosts = `pkill -f ${host} 2>/dev/null || true\n`;
  switch (action) {
    case 'start':
      return `set -e\nsystemctl --user start ${unit}\n`;
    case 'stop':
      return `systemctl --user stop ${unit} 2>/dev/null || true\n${hosts}`;
    case 'restart':
      return `set -e\nsystemctl --user restart ${unit}\n`;
    case 'uninstall':
      return `systemctl --user disable --now ${unit} 2>/dev/null || true\n${hosts}rm -f ${file}\nsystemctl --user daemon-reload 2>/dev/null || true\n`;
  }
}

/** What `systemctl --user show` says about the unit, for the supervisor check. Exported for tests. */
export function parseUnitShow(out: string): { active: boolean; enabled: boolean; restart: string; killMode: string } {
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1]?.trim() ?? '';
  return { active: get('ActiveState') === 'active', enabled: get('UnitFileState') === 'enabled', restart: get('Restart'), killMode: get('KillMode') };
}

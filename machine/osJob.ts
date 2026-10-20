// A one-shot job outside the daemon's process (w1596, docs/worker-install.md "Updates over the daemon's link"): the worker
// install's update job (scripts/worker/linkJob.ts) restarts the daemon, so it cannot be the daemon's child. A restart over
// ssh ends the daemon with everything it started but its agent hosts (Stop-FFDaemon on Windows), so the job runs as the OS's
// own: a scheduled task on Windows, a LaunchAgent on a Mac, a transient systemd user unit on Linux. The first two also start
// at the user's next logon, so a job a reboot cut off finishes (or puts the old code back); the job does nothing once ended.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobRemoveScript, jobScript, jobTaskXml } from '../server/machineDeployWin.ts';
import { macLabel } from '../server/machineDeploy.ts';

export interface JobSpec {
  /** The daemon's service (its task's name, its LaunchAgent label, its systemd unit's): the job is named after it. */
  service: string;
  node: string;
  args: string[];
  cwd: string;
  /** Where its output goes (a Mac's and Linux's: the job re-opens it itself on Windows). */
  log: string;
}

type Runner = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;

const runner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ code: -1, out: e.message }));
    p.on('close', (code) => resolve({ code: code ?? -1, out }));
  });

const encoded = (script: string) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

/** The job's own name beside its daemon's: FFFactoryDaemon -> FFFactoryDaemonJob, com.fffactory.daemon -> com.fffactory.daemon.job. */
export function jobName(platform: NodeJS.Platform, service: string): string {
  return platform === 'win32' ? `${service}Job` : `${service}.job`;
}

/** A LaunchAgent for the job: run once now and at the next login, never kept alive, its output to `log`. Exported for tests. */
export function jobPlist(label: string, s: Pick<JobSpec, 'node' | 'args' | 'cwd' | 'log'>): string {
  const x = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(macLabel(label))}</string>
  <key>ProgramArguments</key>
  <array>
${[s.node, ...s.args].map((a) => `    <string>${x(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${x(s.cwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${x(s.log)}</string>
  <key>StandardErrorPath</key><string>${x(s.log)}</string>
</dict>
</plist>
`;
}

const plistFile = (label: string, home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${macLabel(label)}.plist`);

/** Start the job as the OS's own (see the top of the file). Throws with what the OS said when it could not. */
export async function launchJob(s: JobSpec, platform: NodeJS.Platform = process.platform, run: Runner = runner): Promise<string> {
  const name = jobName(platform, s.service);
  if (platform === 'win32') {
    const r = await run('powershell.exe', encoded(jobScript(name, jobTaskXml(s))));
    if (r.code !== 0 || !/job=started/.test(r.out)) throw new Error(`could not start the ${name} task: ${r.out.trim().slice(-400)}`);
    return `the ${name} scheduled task`;
  }
  if (platform === 'darwin') {
    const file = plistFile(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const target = `gui/${process.getuid?.() ?? 0}`;
    await run('launchctl', ['bootout', `${target}/${name}`]);
    fs.writeFileSync(file, jobPlist(name, s));
    const r = await run('launchctl', ['bootstrap', target, file]);
    if (r.code !== 0) throw new Error(`could not load the ${name} LaunchAgent: ${r.out.trim().slice(-400)}`);
    return `the ${name} LaunchAgent`;
  }
  const unit = name.replace(/[^\w.-]/g, '-');
  const r = await run('systemd-run', ['--user', '--quiet', '--collect', `--unit=${unit}`, `--working-directory=${s.cwd}`, '-p', `StandardOutput=append:${s.log}`, '-p', `StandardError=append:${s.log}`, s.node, ...s.args]);
  if (r.code === 0) return `the transient systemd unit ${unit}`;
  // No user systemd (a container, a session without one): its own session, as an agent host is (machine/agentHost.ts).
  const log = fs.openSync(s.log, 'a');
  try {
    const child = spawn(s.node, s.args, { cwd: s.cwd, detached: true, stdio: ['ignore', log, log] });
    child.unref();
    return `a process of its own (pid ${child.pid}; systemd-run: ${r.out.trim().split('\n').pop()})`;
  } finally {
    fs.closeSync(log);
  }
}

/** Remove an ended job's registration (best effort; never one still running). */
export async function removeJob(service: string, platform: NodeJS.Platform = process.platform, run: Runner = runner): Promise<void> {
  const name = jobName(platform, service);
  if (platform === 'win32') {
    await run('powershell.exe', encoded(jobRemoveScript(name)));
  } else if (platform === 'darwin') {
    await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${name}`]);
    fs.rmSync(plistFile(name), { force: true });
  }
}

/**
 * A worker install's update job (w1596, docs/worker-install.md "Updates over the daemon's link"): what the daemon starts,
 * as the OS's own job (machine/osJob.ts), when the portal asks over its link. It runs from the install's checkout at the
 * commit the daemon fetched and checked (machine/selfUpdate.ts), so the installer is that commit's:
 *
 *   node scripts/worker/linkJob.ts --job <appDir>/update/job.json
 *
 * - update: `worker.ts update --source <that checkout>` with only the settings the portal named, as the ssh path runs it
 *   (every other setting, the credential and the PATH carried; agents run on, the new daemon adopts them). When the portal
 *   does not then see the new daemon online, not outdated, on the new commit, it puts the code that ran before back
 *   (app.old, the folder the installer kept beside the new one), restarts that daemon and checks the portal sees it.
 * - tools: `worker.ts tools` (the agent tools; nothing restarted).
 * - uninstall: unload the daemon as removing the machine does over ssh (its supervisor stopped and unregistered, its
 *   agents ended); its files stay.
 *
 * The result goes to <appDir>/update/result.json, for the daemon that runs then to send (self_update_report). A job started
 * again (at the next logon, after a reboot cut it off) does nothing once it ended, and only checks and puts back otherwise.
 * Its output goes to <appDir>/logs/update-job.log. It prints no credential.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobName } from '../../machine/osJob.ts';
import type { LinkUpdateFlags, LinkUpdateReport } from '../../server/machineProtocol.ts';
import { linuxControlScript } from '../../server/machineDeployLinux.ts';
import { macControlScript } from '../../server/machineDeploy.ts';
import * as win from '../../server/machineDeployWin.ts';
import { jobSection, settingsOfLog } from '../../server/updateLog.ts';
import { readJson, scrub, updateFiles, writeJson, type UpdateJob } from '../../machine/selfUpdate.ts';
import { sameCommit, withStandardPaths, type UpdateFlags, type WhoAmI } from './worker.ts';

/** How long the code put back gets to be seen online, and when it is restarted once meanwhile. */
export const PUT_BACK = { waitMs: 3 * 60_000, restartAfterMs: 60_000, pollMs: 3_000 };

export interface JobDeps {
  say: (line: string) => void;
  /** The installer's update and tools forms (worker.ts), and the unload. */
  update: (job: UpdateJob) => Promise<boolean>;
  tools: (job: UpdateJob) => Promise<number>;
  uninstall: (job: UpdateJob) => Promise<void>;
  /** The commit in a daemon code folder (its machine/VERSION): 'app' or 'app.old'. */
  version: (which: 'app' | 'app.old') => string | undefined;
  /** app -> app.failed, app.old -> app, the daemon restarted (its agents run on). */
  swapBack: () => Promise<void>;
  restart: () => Promise<void>;
  /** What the portal sees of this machine now (GET /machine/whoami), or undefined when it does not answer. */
  view: () => Promise<Pick<WhoAmI, 'online' | 'daemon' | 'outdated'> | undefined>;
  save: (job: UpdateJob) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** w5967: the tools run's limit (default TOOLS_JOB_MS); tests shorten it. */
  toolsMs?: number;
}

/**
 * w5967: a tools job (a marketplace pull, plugin installs, the agents' node and Git) that has not ended in this long is
 * failed with the reason, and the job ends: while it runs, its job.json keeps the machine's update lock (machine/selfUpdate.ts
 * jobInFlight), so every update and tools run sent there is refused. beast's runs took 2 to 12.5 minutes on 2026-11-25/26
 * (the portal's journal); job 442c5638 on 2026-11-26 ran past 15 and held the lock. The portal waits longer
 * (server/machineRollout.ts ROLLOUT_LIMITS.toolsLinkMs), so this job's failed report reaches it.
 */
export const TOOLS_JOB_MS = 30 * 60_000;

/** The note of a tools run stopped at its limit. Exported for tests. */
export const toolsTimedOut = (ms: number) =>
  `the agent tools run did not end within ${Math.round(ms / 60_000)} min, so the job stopped it and ended: this machine takes updates again (w5967)`;

/** The tools run, failed with the reason at its limit (w5967). Exported for tests. */
export async function toolsWithLimit(job: UpdateJob, d: Pick<JobDeps, 'tools' | 'toolsMs' | 'say'>): Promise<{ code: number; late: boolean }> {
  const ms = d.toolsMs ?? TOOLS_JOB_MS;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms);
  });
  const run = d.tools(job).catch((e) => {
    d.say(`FAILED: ${(e as Error).message}`);
    return 1;
  });
  const r = await Promise.race([run, late]);
  clearTimeout(timer);
  if (r === 'late') {
    d.say(`FAILED: ${toolsTimedOut(ms)}.`);
    return { code: 1, late: true };
  }
  return { code: r, late: false };
}

type Outcome = Omit<LinkUpdateReport, 'id' | 'form' | 'commit' | 'log' | 'at'>;

/** Wait for the portal to see the daemon online, not outdated, on `commit`; restart it once if it takes long. */
async function seenOn(commit: string | undefined, d: JobDeps, restartOnce: boolean): Promise<boolean> {
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const start = now();
  let restarted = !restartOnce;
  for (;;) {
    const v = await d.view();
    if (v?.online && !v.outdated && sameCommit(v.daemon, commit)) return true;
    if (now() - start >= PUT_BACK.waitMs) return false;
    if (!restarted && now() - start >= PUT_BACK.restartAfterMs) {
      restarted = true;
      d.say('The portal does not see it yet: restarting it once.');
      await d.restart().catch((e) => d.say(`(the restart failed: ${(e as Error).message})`));
    }
    await sleep(PUT_BACK.pollMs);
  }
}

/**
 * After an update the portal did not see through: put the code that ran before back when the new code is in place, and
 * check the portal sees the old daemon again. Exported for tests.
 */
export async function putBack(job: UpdateJob, d: JobDeps): Promise<Outcome> {
  const now = d.version('app');
  const old = d.version('app.old');
  if (job.commit && sameCommit(now, job.commit) && job.before && sameCommit(old, job.before)) {
    d.say(`\nPutting ${job.before.slice(0, 12)} back (app.old; the new code goes to app.failed) and restarting the daemon; its agents run on...`);
    try {
      await d.swapBack();
    } catch (e) {
      d.say(`FAILED to put it back: ${(e as Error).message}`);
      return { ok: false, exit: 1, before: job.before, after: d.version('app'), rollback: 'failed', note: `the new daemon did not come back, and putting ${job.before.slice(0, 9)} back failed: ${(e as Error).message}` };
    }
    const back = await seenOn(job.before, d, true);
    d.say(back ? `Put back: the portal sees the daemon online on ${job.before.slice(0, 12)} again.` : `FAILED: ${job.before.slice(0, 12)} is back on disk, but the portal does not see its daemon online.`);
    return { ok: false, exit: 1, before: job.before, after: d.version('app'), rollback: back ? 'ok' : 'failed', note: back ? `the new daemon did not come back healthy, so the job put ${job.before.slice(0, 9)} back` : `the new daemon did not come back, and the daemon put back (${job.before.slice(0, 9)}) is not online either: it needs a person (the machine's daemon log)` };
  }
  if (job.before && sameCommit(now, job.before)) {
    // The installer stopped before it swapped the code (a prerequisite, npm ci): the daemon that ran before is the one there.
    const up = await seenOn(job.before, d, true);
    return { ok: false, exit: 1, before: job.before, after: now, note: up ? `the update did not put the new code in place; the daemon on ${job.before.slice(0, 9)} keeps working` : `the update did not put the new code in place, and the daemon on ${job.before.slice(0, 9)} is not online: it needs a person (the machine's daemon log)` };
  }
  return { ok: false, exit: 1, before: job.before, after: now, rollback: 'failed', note: `the daemon's code on disk is ${now ?? 'unknown'}, neither the new ${job.commit?.slice(0, 9)} nor the ${job.before?.slice(0, 9) ?? 'unknown'} before, so nothing was put back: it needs a person` };
}

/** Run one job to its outcome. A job started again after a reboot only checks and puts back. Exported for tests. */
export async function runJob(job: UpdateJob, d: JobDeps, resumed = false): Promise<Outcome> {
  if (job.form === 'tools') {
    const { code, late } = await toolsWithLimit(job, d);
    return { ok: code === 0, exit: code, ...(code === 0 ? {} : { note: late ? toolsTimedOut(d.toolsMs ?? TOOLS_JOB_MS) : `the agent tools run exited ${code}` }) };
  }
  if (job.form === 'uninstall') {
    await d.uninstall(job);
    return { ok: true, exit: 0, note: 'the daemon is unloaded (its supervisor stopped and removed, its agents ended); its files stay' };
  }
  if (!resumed) {
    job.before = d.version('app');
    d.save(job);
    let ok = false;
    try {
      ok = await d.update(job);
    } catch (e) {
      d.say(`FAILED: ${(e as Error).message}`);
    }
    if (ok) return { ok: true, exit: 0, before: job.before, after: d.version('app') };
  } else {
    d.say(`This job was cut off (a reboot?): checking that the portal sees the daemon on ${job.commit?.slice(0, 12)}.`);
    if (await seenOn(job.commit, d, true)) return { ok: true, exit: 0, before: job.before, after: d.version('app'), note: 'finished after the job was cut off' };
  }
  return putBack(job, d);
}

/** The last `bytes` of a file (update-job.log only grows). */
function readEnd(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, size - n);
    return b.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The report's log and settings for job `id`, never a credential: its own section of the log (w5394: the file holds every
 * job's, and the 12 KB tail sent before held about six, so an earlier job's "Settings: none changed" was read as this one's),
 * and the settings that section says it changed. Exported for tests.
 */
export function jobLog(file: string, id: string): Pick<LinkUpdateReport, 'log' | 'settings'> {
  let section = '';
  try {
    section = scrub(jobSection(readEnd(file, 512 * 1024), id));
  } catch {
    // no log: no settings either
  }
  const settings = settingsOfLog(section);
  return { log: section.slice(-12_000), ...(settings ? { settings } : {}) };
}

// ---------------------------------------------------------------- the real job

const shell = (cmd: string, args: string[], input?: string) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (out += b));
    p.on('error', (e) => resolve({ code: -1, out: e.message }));
    p.on('close', (code) => resolve({ code: code ?? -1, out }));
    p.stdin.end(input ?? '');
  });

async function script(what: string, platform: NodeJS.Platform, text: string): Promise<string> {
  const r = platform === 'win32' ? await shell('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')]) : await shell('bash', ['-s'], text);
  if (r.code !== 0) throw new Error(`${what} failed (${r.code}): ${r.out.trim().slice(-400)}`);
  return r.out;
}

/** The settings the portal named over the link, as the installer's update takes them; those it left out are carried. Exported for tests. */
export function updateFlagsOf(source: string, f: LinkUpdateFlags): UpdateFlags {
  return {
    source,
    ...(f.maxSandboxes !== undefined ? { maxSandboxes: f.maxSandboxes } : {}),
    ...(f.maxAgentsPerSandbox !== undefined ? { maxAgentsPerSandbox: f.maxAgentsPerSandbox } : {}),
    ...(f.maxUnity !== undefined ? { maxUnity: f.maxUnity } : {}),
    ...(f.devDrive || f.moveToDevDrive ? { devDrive: 'on' as const } : {}),
    ...(f.moveToDevDrive ? { moveToDevDrive: true } : {}),
    ...(f.devDriveMaxGB !== undefined ? { devDriveMaxGB: f.devDriveMaxGB } : {}),
    // From the wire: anything but on or off would otherwise count as off.
    ...(f.workerFence === 'on' || f.workerFence === 'off' ? { workerFence: f.workerFence } : {}),
    ...(f.workerCaps === 'off' || f.workerCaps === 'warn' || f.workerCaps === 'enforce' ? { workerCaps: f.workerCaps } : {}),
    ...(f.transcriptLock === 'on' || f.transcriptLock === 'off' ? { transcriptLock: f.transcriptLock } : {}),
    ...(f.storeLock === 'off' || f.storeLock === 'warn' || f.storeLock === 'on' ? { storeLock: f.storeLock } : {}),
    ...(f.editorTmpdir === 'on' || f.editorTmpdir === 'off' ? { editorTmpdir: f.editorTmpdir } : {}),
    ...(f.pathFence === 'off' || f.pathFence === 'warn' ? { pathFence: f.pathFence } : {}),
    ...(f.mediumAgentFolders === 'warn' || f.mediumAgentFolders === 'on' ? { mediumAgentFolders: f.mediumAgentFolders } : {}),
    ...(f.daemonTmpdir === 'on' || f.daemonTmpdir === 'off' ? { daemonTmpdir: f.daemonTmpdir } : {}),
    ...(f.toolsDiskLock === 'warn' || f.toolsDiskLock === 'on' ? { toolsDiskLock: f.toolsDiskLock } : {}),
  };
}

function realDeps(job: UpdateJob, say: (l: string) => void): JobDeps {
  const platform = process.platform;
  const svc = { task: job.service, only: true };
  const versionIn = (dir: string) => {
    try {
      return fs.readFileSync(path.join(job.appDir, dir, 'machine', 'VERSION'), 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const restart = async () => {
    if (platform === 'win32') await script('restarting the daemon', platform, win.controlScript('restart', job.appDir, svc));
    else await script('restarting the daemon', platform, platform === 'linux' ? linuxControlScript('restart', job.service) : macControlScript('restart', job.service));
  };
  return {
    say,
    version: (which) => versionIn(which),
    async update(j) {
      const w = await import('./worker.ts');
      return w.update(j.root, updateFlagsOf(updateFiles(j.appDir).src, j.flags ?? {}));
    },
    async tools(j) {
      const w = await import('./worker.ts');
      return w.tools(j.root);
    },
    async uninstall(j) {
      say(`Unloading the daemon (${j.service}): its agents end, its files stay in ${j.appDir}.`);
      if (platform === 'win32') say(await script('unloading the daemon', platform, win.uninstallScript(j.appDir, svc)));
      else say(await script('unloading the daemon', platform, platform === 'linux' ? linuxControlScript('uninstall', j.service, j.appDir) : macControlScript('uninstall', j.service, j.appDir)));
    },
    async swapBack() {
      if (platform === 'win32') {
        say((await script('putting the old code back', platform, win.rollbackScript(job.appDir, svc))).trim());
        return;
      }
      const app = path.join(job.appDir, 'app');
      const failed = path.join(job.appDir, 'app.failed');
      fs.rmSync(failed, { recursive: true, force: true });
      if (fs.existsSync(app)) fs.renameSync(app, failed);
      fs.renameSync(path.join(job.appDir, 'app.old'), app);
      await restart();
    },
    restart,
    async view() {
      const w = await import('./worker.ts');
      const cfg = readJson<{ portalUrl?: string }>(path.join(job.appDir, 'daemon.json'));
      const token = fs.readFileSync(path.join(path.dirname(job.appDir), 'secrets', 'machine-token'), 'utf8').trim();
      const r = cfg?.portalUrl ? await w.whoami(cfg.portalUrl.replace(/\/+$/, ''), token).catch(() => undefined) : undefined;
      return r?.ok ? r.me : undefined;
    },
    save: (j) => writeJson(updateFiles(j.appDir).job, j),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const i = argv.indexOf('--job');
  const file = i >= 0 ? argv[i + 1] : undefined;
  if (!file) throw new Error('usage: node scripts/worker/linkJob.ts --job <appDir>/update/job.json');
  const job = readJson<UpdateJob>(file);
  if (!job) throw new Error(`no job at ${file}`);
  const f = updateFiles(job.appDir);
  // Its output goes to the job's log: on Windows the task gives it none, so the job runs itself again with it.
  if (process.platform === 'win32' && !process.env.FF_LINK_JOB_LOG) {
    fs.mkdirSync(path.dirname(f.log), { recursive: true });
    const log = fs.openSync(f.log, 'a');
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...argv], { stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, FF_LINK_JOB_LOG: '1' } });
    return new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  }
  const say = (line: string) => console.log(line);
  // A LaunchAgent starts it with launchd's bare PATH, where git-lfs and node are not (m3, w1596; m5's ssh PATH, w629).
  process.env.PATH = withStandardPaths(process.env.PATH ?? '');
  if (job.phase === 'done' || readJson<LinkUpdateReport>(f.result)?.id === job.id) return 0;
  const resumed = job.phase === 'running';
  if (resumed && job.pid && job.pid !== process.pid) {
    try {
      process.kill(job.pid, 0);
      say(`Job ${job.id} already runs (pid ${job.pid}).`);
      return 0;
    } catch {
      // that process is gone: this one takes the job over
    }
  }
  say(`\n${new Date().toISOString()} FF Factory update job ${job.id}: ${job.form}${job.commit ? ` to ff-factory ${job.commit.slice(0, 12)}` : ''} (w1596, the portal asked over the daemon's link).`);
  Object.assign(job, { phase: 'running', pid: process.pid });
  writeJson(file, job);
  const out = await runJob(job, realDeps(job, say), resumed).catch((e): Outcome => ({ ok: false, exit: 1, note: `the job failed: ${(e as Error).message}` }));
  say(`${new Date().toISOString()} job ${job.id}: ${out.ok ? 'done' : 'FAILED'}${out.note ? ` (${out.note})` : ''}.`);
  const report: LinkUpdateReport = { id: job.id, form: job.form === 'tools' ? 'tools' : 'update', commit: job.commit ?? '', ...out, ...jobLog(f.log, job.id), at: new Date().toISOString() };
  writeJson(f.result, report);
  writeJson(file, { ...job, phase: 'done', pid: undefined });
  // An unloaded daemon never comes back to remove this job's own task or LaunchAgent (it does after an update): the job does.
  if (job.form === 'uninstall') {
    const name = jobName(process.platform, job.service);
    if (process.platform === 'win32') await shell('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false -ErrorAction SilentlyContinue`]);
    else if (process.platform === 'darwin') fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${name}.plist`), { force: true });
  }
  // w5967: a tools run stopped at its limit may leave work running inside this process (a spawn, a download) that would keep
  // it, and so the job's task or LaunchAgent, alive: its result and its done phase are on disk, so it ends here.
  if (job.form === 'tools' && out.note === toolsTimedOut(TOOLS_JOB_MS)) setTimeout(() => process.exit(out.exit), 1_000).unref();
  return out.exit;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`ERROR: ${(e as Error).message}`);
      process.exitCode = 1;
    },
  );
}

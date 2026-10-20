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
import type { LinkUpdateReport } from '../../server/machineProtocol.ts';
import { linuxControlScript } from '../../server/machineDeployLinux.ts';
import { macControlScript } from '../../server/machineDeploy.ts';
import * as win from '../../server/machineDeployWin.ts';
import { readJson, scrub, updateFiles, writeJson, type UpdateJob } from '../../machine/selfUpdate.ts';
import { sameCommit, type WhoAmI } from './worker.ts';

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
    const code = await d.tools(job);
    return { ok: code === 0, exit: code, ...(code === 0 ? {} : { note: `the agent tools run exited ${code}` }) };
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

/** The end of the job's log for the report: the installer's lines, never a credential. */
export function logTail(file: string, max = 12_000): string {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return scrub(s.slice(-max));
  } catch {
    return '';
  }
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
      const f = j.flags ?? {};
      return w.update(j.root, {
        source: updateFiles(j.appDir).src,
        ...(f.maxSandboxes !== undefined ? { maxSandboxes: f.maxSandboxes } : {}),
        ...(f.maxAgentsPerSandbox !== undefined ? { maxAgentsPerSandbox: f.maxAgentsPerSandbox } : {}),
        ...(f.maxUnity !== undefined ? { maxUnity: f.maxUnity } : {}),
        ...(f.devDrive || f.moveToDevDrive ? { devDrive: 'on' as const } : {}),
        ...(f.moveToDevDrive ? { moveToDevDrive: true } : {}),
        ...(f.devDriveMaxGB !== undefined ? { devDriveMaxGB: f.devDriveMaxGB } : {}),
      });
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
  const report: LinkUpdateReport = { id: job.id, form: job.form === 'tools' ? 'tools' : 'update', commit: job.commit ?? '', ...out, log: logTail(f.log), at: new Date().toISOString() };
  writeJson(f.result, report);
  writeJson(file, { ...job, phase: 'done', pid: undefined });
  // An unloaded daemon never comes back to remove this job's own task or LaunchAgent (it does after an update): the job does.
  if (job.form === 'uninstall') {
    const name = jobName(process.platform, job.service);
    if (process.platform === 'win32') await shell('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false -ErrorAction SilentlyContinue`]);
    else if (process.platform === 'darwin') fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${name}.plist`), { force: true });
  }
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

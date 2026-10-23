// Updates over the daemon's link (w1596, docs/worker-install.md "Updates over the daemon's link"; lothsahn: "Yes, move
// updates and restarts onto the daemon link; drop the SSH need"). The portal says `self_update` with a commit and the SHA-256
// and size of a git bundle of its own code; this side:
//
//   1. downloads the bundle (GET /machine/update/<sha256>, this machine's credential) into <appDir>/update, checking its size
//      and SHA-256 against the message, which came on this machine's own authenticated link;
//   2. fetches it into the install's checkout (<appDir>/src: git checks every object, so the commit is the portal's to the
//      byte) and checks the commit out;
//   3. writes the job (<appDir>/update/job.json) and starts scripts/worker/linkJob.ts from that commit as the OS's own job
//      (machine/osJob.ts), which runs the installer's update and puts the old code back when the new daemon does not come
//      back, then writes <appDir>/update/result.json;
//   4. the daemon that runs afterwards (the new one, or the old one put back) sends that result as self_update_report.
//
// No module here may need an npm package: linkJob.ts imports these from a checkout that has none.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FromDaemon, LinkUpdateFlags, LinkUpdateReport, ToDaemon } from '../server/machineProtocol.ts';
import { launchJob, removeJob } from './osJob.ts';

/** The largest bundle a daemon takes (ff-factory's whole history was 19 MB in October 2026). */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

export interface UpdateJob {
  id: string;
  form: 'update' | 'tools' | 'uninstall';
  /** update and tools: the commit checked out in <appDir>/src. */
  commit?: string;
  flags?: LinkUpdateFlags;
  root: string;
  appDir: string;
  /** The daemon's service: its task, LaunchAgent label or systemd unit (root.json `service`). */
  service: string;
  createdAt: string;
  phase: 'staged' | 'running' | 'done';
  /** The job process, while it runs. */
  pid?: number;
  /** The daemon's commit before the update (its machine/VERSION). */
  before?: string;
  /** The daemon sent the result to the portal. */
  reported?: boolean;
  /** And removed the job's task or LaunchAgent. */
  removed?: boolean;
}

export const updateFiles = (appDir: string) => {
  const dir = path.join(appDir, 'update');
  return { dir, job: path.join(dir, 'job.json'), result: path.join(dir, 'result.json'), log: path.join(appDir, 'logs', 'update-job.log'), src: path.join(appDir, 'src') };
};

export function readJson<T>(file: string): T | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(file: string, v: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(v, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/** Whether a process with this pid runs (signal 0 checks without touching it). */
export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A job not yet ended: one staged, or running in a live process. */
export function jobInFlight(job: UpdateJob | undefined): boolean {
  return !!job && (job.phase === 'staged' || (job.phase === 'running' && alive(job.pid)));
}

/** The machine's credential never leaves in a report: any ffm_ token in the text is cut down to its id. */
export const scrub = (s: string) => s.replace(/ffm_([a-z0-9-]+)_[A-Za-z0-9_-]{8,}/g, 'ffm_$1_…');

/** Why a self_update message cannot be acted on, or undefined. Exported for tests. */
export function selfUpdateProblem(m: { commit?: unknown; bundle?: { sha256?: unknown; size?: unknown } }): string | undefined {
  if (typeof m.commit !== 'string' || !/^[0-9a-f]{40}$/.test(m.commit)) return 'the commit is not a full git commit id';
  if (typeof m.bundle?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.bundle.sha256)) return 'the bundle has no SHA-256';
  if (typeof m.bundle.size !== 'number' || !Number.isInteger(m.bundle.size) || m.bundle.size < 1 || m.bundle.size > MAX_BUNDLE_BYTES) return `the bundle size is not a whole number of bytes up to ${MAX_BUNDLE_BYTES}`;
  return undefined;
}

/**
 * The bundle download's limits (w1641). beast's tools download at the 8c66ee8 deploy stalled at 6,962,988 of 18,549,629
 * bytes and sat there until undici's own body timeout (300 s without a byte) ended it as "terminated", after the portal had
 * stopped waiting (5 minutes): a stall is now noticed after `stallMs` and the download resumes where it stopped (the portal
 * answers a Range request, server/index.ts sendStream), at most `attempts` times, all of it within `totalMs`.
 */
export const DOWNLOAD = { stallMs: 30_000, attempts: 6, totalMs: 8 * 60_000 };

/** What a failed fetch says, its cause included (undici's "terminated" hides why: UND_ERR_BODY_TIMEOUT, UND_ERR_SOCKET). */
export function fetchError(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const c = err?.cause;
  const cause = c ? [c.code, c.message].filter(Boolean).join(': ') : '';
  return `${err?.message ?? String(e)}${cause ? ` (${cause})` : ''}`;
}

/** A failure another try would not mend: the portal refusing the bundle, a bundle unlike what it said, a disk that will not take it. */
class Final extends Error {}

/**
 * Download the bundle and check it against what the portal said on the link; returns its path. A download that stalls or
 * breaks resumes from the bytes it has (DOWNLOAD), each retry logged with its reason. Exported for tests.
 */
export async function downloadBundle(
  portalUrl: string,
  token: string,
  b: { sha256: string; size: number },
  dir: string,
  doFetch: typeof fetch = fetch,
  o: { stallMs?: number; attempts?: number; totalMs?: number; log?: (line: string) => void } = {},
): Promise<string> {
  const stallMs = o.stallMs ?? DOWNLOAD.stallMs;
  const attempts = o.attempts ?? DOWNLOAD.attempts;
  const deadline = Date.now() + (o.totalMs ?? DOWNLOAD.totalMs);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${b.sha256.slice(0, 16)}.bundle`);
  const part = `${file}.part`;
  const url = `${portalUrl.replace(/\/+$/, '')}/machine/update/${b.sha256}`;
  const out = await fs.promises.open(part, 'w');
  let hash = createHash('sha256');
  let size = 0;
  const restart = async () => {
    await out.truncate(0);
    hash = createHash('sha256');
    size = 0;
  };
  try {
    for (let attempt = 1; ; attempt++) {
      const ctl = new AbortController();
      let timedOut: 'stall' | 'total' | undefined;
      let timer: NodeJS.Timeout | undefined;
      const arm = () => {
        clearTimeout(timer);
        const left = deadline - Date.now();
        timer = setTimeout(() => {
          timedOut = left <= stallMs ? 'total' : 'stall';
          ctl.abort();
        }, Math.max(1, Math.min(stallMs, left)));
      };
      arm();
      try {
        const from = size;
        const res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, ...(from ? { range: `bytes=${from}-` } : {}) }, signal: ctl.signal });
        if (res.status >= 400 && res.status < 500) {
          await res.body?.cancel();
          throw new Final(`the portal answered ${res.status} for the update's bundle`);
        }
        if ((res.status !== 200 && res.status !== 206) || !res.body) {
          await res.body?.cancel();
          throw new Error(`the portal answered ${res.status} for the update's bundle`);
        }
        // A resume the portal answered with the whole file, or a range that does not start where this one stopped: from 0.
        if (from && (res.status === 200 || !new RegExp(`^bytes ${from}-`).test(res.headers.get('content-range') ?? ''))) await restart();
        for await (const chunk of Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)) {
          arm();
          if (size + chunk.length > b.size) throw new Final(`the bundle is larger than the ${b.size} bytes the portal said`);
          await out.write(chunk, 0, chunk.length, size).catch((e) => {
            throw new Final(`could not write ${part}: ${(e as Error).message}`);
          });
          hash.update(chunk);
          size += chunk.length;
        }
        // The portal sent all it has (a cut connection is an error, not an end): what it said is checked below.
        break;
      } catch (e) {
        if (e instanceof Final) throw e;
        const why = timedOut === 'stall' ? `stalled (no byte in ${Math.round(stallMs / 1000)} s)` : timedOut === 'total' ? `did not finish in ${Math.round((o.totalMs ?? DOWNLOAD.totalMs) / 1000)} s` : `broke: ${fetchError(e)}`;
        if (timedOut === 'total' || attempt >= attempts || Date.now() >= deadline) throw new Error(`the bundle's download ${why} at ${size} of ${b.size} bytes, after ${attempt} attempt(s)`);
        o.log?.(`update over the link: the bundle's download ${why} at ${size} of ${b.size} bytes; attempt ${attempt + 1} of ${attempts} resumes from there`);
        await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000, Math.max(0, deadline - Date.now()))));
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (e) {
    await out.close();
    fs.rmSync(part, { force: true });
    throw e;
  }
  await out.close();
  const sha = hash.digest('hex');
  if (size !== b.size || sha !== b.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`the bundle does not match what the portal said on the link (${size} bytes, SHA-256 ${sha.slice(0, 12)}…; expected ${b.size} bytes, ${b.sha256.slice(0, 12)}…): nothing was changed`);
  }
  fs.renameSync(part, file);
  return file;
}

const git = (args: string[], timeoutMs = 5 * 60_000) =>
  new Promise<string>((resolve, reject) =>
    execFile('git', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0] === '-C' ? args[2] : args[0]} failed: ${String(stderr || err.message).trim().split('\n').pop()}`)) : resolve(String(stdout)),
    ),
  );

/**
 * Fetch the bundle into the install's checkout and check `commit` out there (git verifies every object it takes, so what is
 * checked out is the portal's commit exactly). A checkout that is missing is made. Exported for tests.
 */
export async function checkoutFromBundle(src: string, bundle: string, commit: string): Promise<void> {
  if (!fs.existsSync(path.join(src, '.git'))) {
    fs.mkdirSync(src, { recursive: true });
    await git(['init', '--quiet', src]);
  }
  await git(['-C', src, 'bundle', 'verify', '--quiet', bundle]).catch((e) => {
    throw new Error(`the bundle is not one git can read (${(e as Error).message})`);
  });
  await git(['-C', src, 'fetch', '--quiet', '--no-tags', bundle, '+HEAD:refs/ff-update/portal']);
  const got = (await git(['-C', src, 'rev-parse', '--verify', 'refs/ff-update/portal^{commit}'])).trim();
  if (got !== commit) throw new Error(`the bundle holds commit ${got.slice(0, 12)}, not ${commit.slice(0, 12)} as the portal said: nothing was changed`);
  await git(['-C', src, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', commit]);
}

/** The worker install the daemon runs from (root.json): its service name and platform, or undefined. */
export function installOf(root: string): { service: string; platform?: string } | undefined {
  const m = readJson<{ service?: string; platform?: string }>(path.join(root, 'root.json'));
  return m?.service ? { service: m.service, platform: m.platform } : undefined;
}

/** The spare copy of root.json in the daemon's folder (w1918): off the Dev Drive for a root on it, beside daemon.json. */
export const rootBackupOf = (appDir: string) => path.join(appDir, 'root-backup.json');

/**
 * Keep root.json's spare copy fresh, and put root.json back from it when it is missing or unreadable (w1918, lothsahn: "Let's
 * do the root.json backup and have the daemon be smart enough to automatically reinstall it in v: if the V: ever gets reset").
 * LothLaptop's V: was reset to an empty drive: root.json went with it, and the daemon on D: refused every update over its link
 * until it was written by hand. Only for a root on its Dev Drive (devDrive.rootOnDrive), whose daemon's folder is on the host
 * volume: anywhere else the spare copy would go with the root. The root's folder is made again when its drive is there; a drive
 * that is not attached cannot be written, and the next call tries again. Returns what it put back, for the log; never throws.
 */
export function keepRootJson(root: string, appDir: string): string | undefined {
  const file = path.join(root, 'root.json');
  const spare = rootBackupOf(appDir);
  try {
    const have = readJson<{ service?: string }>(file);
    if (have?.service) {
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      if (!fs.existsSync(spare) || fs.readFileSync(spare, 'utf8') !== text) {
        fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(`${spare}.tmp`, text);
        fs.renameSync(`${spare}.tmp`, spare);
      }
      return undefined;
    }
    const copy = readJson<{ service?: string; devDrive?: { rootOnDrive?: boolean } }>(spare);
    if (!copy?.service || !copy.devDrive?.rootOnDrive) return undefined;
    const was = fs.existsSync(file) ? 'unreadable' : 'missing';
    writeJson(file, copy);
    return `${file} was ${was}: put back from ${spare}`;
  } catch {
    return undefined;
  }
}

/** The job's command line: node (with the daemon's own TypeScript flags) on linkJob.ts in the install's checkout. */
export function jobArgs(appDir: string, nodeArgs: string[]): string[] {
  const f = updateFiles(appDir);
  return [...nodeArgs, path.join(f.src, 'scripts', 'worker', 'linkJob.ts'), '--job', f.job];
}

/** A result the job left that the portal has not been sent, or undefined. */
export function pendingReport(appDir: string): LinkUpdateReport | undefined {
  const f = updateFiles(appDir);
  const job = readJson<UpdateJob>(f.job);
  const r = readJson<LinkUpdateReport>(f.result);
  if (!job || job.reported || !r || r.id !== job.id) return undefined;
  return r;
}

/** The result went to the portal: the job is kept (the next update replaces it), marked so it is not sent again. */
export function markReported(appDir: string, id: string) {
  const f = updateFiles(appDir);
  const job = readJson<UpdateJob>(f.job);
  if (job?.id === id) writeJson(f.job, { ...job, reported: true });
}

export interface SelfUpdaterDeps {
  root?: string;
  appDir: string;
  portalUrl: () => string;
  token: string;
  /** Send on the link now; false when it is down (the report is sent on the next try). */
  send: (msg: FromDaemon) => boolean;
  /** The daemon's own way out for a restart: its supervisor starts it again. */
  exit: () => void;
  log: (...a: unknown[]) => void;
  node?: string;
  nodeArgs?: string[];
  platform?: NodeJS.Platform;
  launch?: typeof launchJob;
  remove?: typeof removeJob;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The answers the link may lose (w1641). At the 450f7d53c rollout the portal VM's Tailscale restarted 4.5 minutes into
 * beast's update and the link was down 30 s: an answer sent then was dropped (send is false on a closed link), and one
 * sent into a dead socket is lost too, since the daemon notices a silent portal only after 45 s (machine/daemon.ts
 * heartbeat). Each is kept `keepMs` and sent again on the next link when it was not sent, or was sent within
 * `beforeDropMs` of the drop; the portal ignores a repeat (server/machineLink.ts PendingCalls.repeat).
 */
export const ANSWERS = { keepMs: 30 * 60_000, beforeDropMs: 60_000 };

type LinkAnswer = Extract<FromDaemon, { type: 'self_update_ack' | 'daemon_control_result' }>;

/** The daemon's half of the updates over its link (see the top of the file); machine/daemon.ts holds one. */
export class SelfUpdater {
  private busy = false;
  /** A finished job's task or LaunchAgent being removed: a new job or an unload waits for it rather than being refused (w1596). */
  private removing: Promise<void> | undefined;
  /** Answers to the portal's calls, kept until the link surely had them (ANSWERS). */
  private readonly answers = new Map<string, { msg: LinkAnswer; at: number; sentAt?: number }>();
  /** Its hands (the job launcher, the fetch); tests replace them. */
  readonly deps: SelfUpdaterDeps;
  constructor(d: SelfUpdaterDeps) {
    this.deps = d;
  }

  private get platform() {
    return this.deps.platform ?? process.platform;
  }

  /** The worker install it runs from, when it is one this can update: its root.json names the service. */
  private install() {
    if (!this.deps.root) return undefined;
    // Put back first (w1918): a reset drive took root.json, and the hello, an update or an unload would find no install.
    const put = keepRootJson(this.deps.root, this.deps.appDir);
    if (put) this.deps.log(`worker install record: ${put}`);
    return installOf(this.deps.root);
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** Answer a call of the portal's; one the link cannot take now is sent when it is back (ANSWERS). */
  private answer(msg: LinkAnswer) {
    const now = this.now();
    for (const [k, a] of this.answers) if (now - a.at > ANSWERS.keepMs) this.answers.delete(k);
    const sent = this.deps.send(msg);
    this.answers.set(msg.id, { msg, at: now, ...(sent ? { sentAt: now } : {}) });
    if (!sent) this.deps.log(`link down: the answer to call ${msg.id.slice(0, 8)} goes when it is back`);
  }

  /** The link closed: an answer sent shortly before may have gone into a dead socket, so it goes again on the next link. */
  linkDown(at = this.now()): void {
    for (const a of this.answers.values()) if (a.sentAt !== undefined && at - a.sentAt <= ANSWERS.beforeDropMs) delete a.sentAt;
  }

  /** The link is back (its hello sent): the answers it may not have had. */
  relink(): void {
    const now = this.now();
    for (const [id, a] of this.answers) {
      if (now - a.at > ANSWERS.keepMs) this.answers.delete(id);
      else if (a.sentAt === undefined && this.deps.send(a.msg)) {
        a.sentAt = now;
        this.deps.log(`link back: sent the answer to call ${id.slice(0, 8)} again (${a.msg.ok ? 'ok' : `refused: ${a.msg.error ?? ''}`})`);
      }
    }
  }

  /** Why there is no install to update: the refusal names the files, so the portal's report says what to fix (w1918). */
  private noInstall(): string {
    if (!this.deps.root) return 'this daemon is not a worker root install (daemon.json names no root)';
    return `this daemon is not a worker root install whose root.json names its service: ${path.join(this.deps.root, 'root.json')} is missing or unreadable, and ${rootBackupOf(this.deps.appDir)} holds no copy to put back (a daemon from w1918 on keeps one; an install or update writes both)`;
  }

  /** Whether the hello offers `selfUpdate`: a worker root install whose service is known. */
  offered(): boolean {
    return !!this.install();
  }

  private job(form: UpdateJob['form'], id: string, service: string, extra: Partial<UpdateJob> = {}): UpdateJob {
    return { id, form, root: this.deps.root!, appDir: this.deps.appDir, service, createdAt: new Date().toISOString(), phase: 'staged', ...extra };
  }

  private async start(job: UpdateJob, service: string): Promise<string> {
    const f = updateFiles(this.deps.appDir);
    writeJson(f.job, job);
    fs.rmSync(f.result, { force: true });
    fs.mkdirSync(path.dirname(f.log), { recursive: true });
    return (this.deps.launch ?? launchJob)({ service, node: this.deps.node ?? process.execPath, args: jobArgs(this.deps.appDir, this.deps.nodeArgs ?? []), cwd: this.deps.appDir, log: f.log }, this.platform);
  }

  /** self_update: check the bundle, check out its commit, start the job; answered with self_update_ack. */
  async onSelfUpdate(msg: Extract<ToDaemon, { type: 'self_update' }>): Promise<void> {
    const refuse = (error: string) => {
      this.deps.log(`update over the link refused: ${error}`);
      this.answer({ type: 'self_update_ack', id: msg.id, ok: false, error });
    };
    const inst = this.install();
    if (!inst) return refuse(this.noInstall());
    const why = selfUpdateProblem(msg);
    if (why) return refuse(why);
    const f = updateFiles(this.deps.appDir);
    await this.removing;
    if (this.busy || jobInFlight(readJson<UpdateJob>(f.job))) return refuse('an update job of this machine is still running');
    this.busy = true;
    try {
      this.deps.log(`update over the link: ${msg.form} to ff-factory ${msg.commit.slice(0, 12)}; fetching the bundle (${msg.bundle.size} bytes)`);
      const bundle = await downloadBundle(this.deps.portalUrl(), this.deps.token, msg.bundle, f.dir, this.deps.fetch, { log: (l) => this.deps.log(l) });
      await checkoutFromBundle(f.src, bundle, msg.commit);
      removeOldBundles(this.deps.appDir, bundle);
      const how = await this.start(this.job(msg.form, msg.id, inst.service, { commit: msg.commit, ...(msg.flags ? { flags: msg.flags } : {}) }), inst.service);
      this.deps.log(`update over the link: the bundle checked (SHA-256 and commit), job ${msg.id} started as ${how}`);
      this.answer({ type: 'self_update_ack', id: msg.id, ok: true });
    } catch (e) {
      refuse((e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** daemon_control: restart (exit; the supervisor starts it again, its agents run on) or unload, as a job. */
  async onControl(msg: Extract<ToDaemon, { type: 'daemon_control' }>): Promise<void> {
    const answer = (ok: boolean, error?: string) => {
      this.answer({ type: 'daemon_control_result', id: msg.id, ok, ...(error ? { error } : {}) });
    };
    if (msg.action === 'restart') {
      answer(true);
      this.deps.log('restart over the link: going; the supervisor starts the daemon again and it takes its agents back');
      setTimeout(() => this.deps.exit(), 300);
      return;
    }
    const inst = this.install();
    if (!inst) return answer(false, this.noInstall());
    if (!fs.existsSync(path.join(updateFiles(this.deps.appDir).src, 'scripts', 'worker', 'linkJob.ts'))) return answer(false, "the install's checkout has no update job (scripts/worker/linkJob.ts): update it first");
    await this.removing;
    if (this.busy || jobInFlight(readJson<UpdateJob>(updateFiles(this.deps.appDir).job))) return answer(false, 'an update job of this machine is still running');
    try {
      const how = await this.start(this.job('uninstall', msg.id, inst.service), inst.service);
      this.deps.log(`unload over the link: job ${msg.id} started as ${how}`);
      answer(true);
    } catch (e) {
      answer(false, (e as Error).message);
    }
  }

  /** Send a result the portal has not had; once sent and the job's process is gone, remove the job's task or LaunchAgent. */
  async tick(): Promise<void> {
    // The spare copy of root.json kept fresh, and root.json put back once a reset drive is there again (w1918).
    this.install();
    const r = pendingReport(this.deps.appDir);
    if (r && this.deps.send({ type: 'self_update_report', report: r })) {
      markReported(this.deps.appDir, r.id);
      this.deps.log(`update over the link: job ${r.id} reported (${r.ok ? 'ok' : 'failed'}${r.rollback ? `, put back: ${r.rollback}` : ''})`);
    }
    const job = readJson<UpdateJob>(updateFiles(this.deps.appDir).job);
    if (job?.reported && !job.removed && job.phase === 'done' && !alive(job.pid) && !this.busy) {
      // Busy meanwhile, so no new job starts while the old one's task or LaunchAgent is removed (it would be removed too).
      // A daemon restarted right after a job (w1596's Windows CI: a restart, then an unload as the new daemon connected) removes
      // it at its first tick, just as the portal's next command arrives: that command waits for this.
      this.busy = true;
      this.removing = (async () => {
        try {
          const inst = this.install();
          if (inst) await (this.deps.remove ?? removeJob)(inst.service, this.platform).catch(() => undefined);
          if (readJson<UpdateJob>(updateFiles(this.deps.appDir).job)?.id === job.id) writeJson(updateFiles(this.deps.appDir).job, { ...job, removed: true });
        } finally {
          this.busy = false;
          this.removing = undefined;
        }
      })();
      await this.removing;
    }
  }
}

/** Bundles of jobs that ended: only those in the install's own update folder, never the one a job may still need. */
export function removeOldBundles(appDir: string, keep?: string) {
  const { dir } = updateFiles(appDir);
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (/\.bundle(\.part)?$/.test(n) && path.join(dir, n) !== keep) fs.rmSync(path.join(dir, n), { force: true });
  }
}

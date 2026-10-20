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

/** Download the bundle and check it against what the portal said on the link; returns its path. Exported for tests. */
export async function downloadBundle(portalUrl: string, token: string, b: { sha256: string; size: number }, dir: string, doFetch: typeof fetch = fetch): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${b.sha256.slice(0, 16)}.bundle`);
  const part = `${file}.part`;
  const res = await doFetch(`${portalUrl.replace(/\/+$/, '')}/machine/update/${b.sha256}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    throw new Error(`the portal answered ${res.status} for the update's bundle`);
  }
  const hash = createHash('sha256');
  let size = 0;
  const out = fs.createWriteStream(part);
  try {
    for await (const chunk of Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)) {
      size += chunk.length;
      if (size > b.size) throw new Error(`the bundle is larger than the ${b.size} bytes the portal said`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
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
}

/** The daemon's half of the updates over its link (see the top of the file); machine/daemon.ts holds one. */
export class SelfUpdater {
  private busy = false;
  private readonly d: SelfUpdaterDeps;
  constructor(d: SelfUpdaterDeps) {
    this.d = d;
  }

  private get platform() {
    return this.d.platform ?? process.platform;
  }

  /** The worker install it runs from, when it is one this can update: its root.json names the service. */
  private install() {
    return this.d.root ? installOf(this.d.root) : undefined;
  }

  /** Whether the hello offers `selfUpdate`: a worker root install whose service is known. */
  offered(): boolean {
    return !!this.install();
  }

  private job(form: UpdateJob['form'], id: string, service: string, extra: Partial<UpdateJob> = {}): UpdateJob {
    return { id, form, root: this.d.root!, appDir: this.d.appDir, service, createdAt: new Date().toISOString(), phase: 'staged', ...extra };
  }

  private async start(job: UpdateJob, service: string): Promise<string> {
    const f = updateFiles(this.d.appDir);
    writeJson(f.job, job);
    fs.rmSync(f.result, { force: true });
    fs.mkdirSync(path.dirname(f.log), { recursive: true });
    return (this.d.launch ?? launchJob)({ service, node: this.d.node ?? process.execPath, args: jobArgs(this.d.appDir, this.d.nodeArgs ?? []), cwd: this.d.appDir, log: f.log }, this.platform);
  }

  /** self_update: check the bundle, check out its commit, start the job; answered with self_update_ack. */
  async onSelfUpdate(msg: Extract<ToDaemon, { type: 'self_update' }>): Promise<void> {
    const refuse = (error: string) => {
      this.d.log(`update over the link refused: ${error}`);
      this.d.send({ type: 'self_update_ack', id: msg.id, ok: false, error });
    };
    const inst = this.install();
    if (!inst) return refuse('this daemon is not a worker root install whose root.json names its service');
    const why = selfUpdateProblem(msg);
    if (why) return refuse(why);
    const f = updateFiles(this.d.appDir);
    if (this.busy || jobInFlight(readJson<UpdateJob>(f.job))) return refuse('an update job of this machine is still running');
    this.busy = true;
    try {
      this.d.log(`update over the link: ${msg.form} to ff-factory ${msg.commit.slice(0, 12)}; fetching the bundle (${msg.bundle.size} bytes)`);
      const bundle = await downloadBundle(this.d.portalUrl(), this.d.token, msg.bundle, f.dir, this.d.fetch);
      await checkoutFromBundle(f.src, bundle, msg.commit);
      removeOldBundles(this.d.appDir, bundle);
      const how = await this.start(this.job(msg.form, msg.id, inst.service, { commit: msg.commit, ...(msg.flags ? { flags: msg.flags } : {}) }), inst.service);
      this.d.log(`update over the link: the bundle checked (SHA-256 and commit), job ${msg.id} started as ${how}`);
      this.d.send({ type: 'self_update_ack', id: msg.id, ok: true });
    } catch (e) {
      refuse((e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** daemon_control: restart (exit; the supervisor starts it again, its agents run on) or unload, as a job. */
  async onControl(msg: Extract<ToDaemon, { type: 'daemon_control' }>): Promise<void> {
    const answer = (ok: boolean, error?: string) => {
      this.d.send({ type: 'daemon_control_result', id: msg.id, ok, ...(error ? { error } : {}) });
    };
    if (msg.action === 'restart') {
      answer(true);
      this.d.log('restart over the link: going; the supervisor starts the daemon again and it takes its agents back');
      setTimeout(() => this.d.exit(), 300);
      return;
    }
    const inst = this.install();
    if (!inst) return answer(false, 'this daemon is not a worker root install whose root.json names its service');
    if (!fs.existsSync(path.join(updateFiles(this.d.appDir).src, 'scripts', 'worker', 'linkJob.ts'))) return answer(false, "the install's checkout has no update job (scripts/worker/linkJob.ts): update it first");
    if (jobInFlight(readJson<UpdateJob>(updateFiles(this.d.appDir).job))) return answer(false, 'an update job of this machine is still running');
    try {
      const how = await this.start(this.job('uninstall', msg.id, inst.service), inst.service);
      this.d.log(`unload over the link: job ${msg.id} started as ${how}`);
      answer(true);
    } catch (e) {
      answer(false, (e as Error).message);
    }
  }

  /** Send a result the portal has not had; once sent and the job's process is gone, remove the job's task or LaunchAgent. */
  async tick(): Promise<void> {
    const r = pendingReport(this.d.appDir);
    if (r && this.d.send({ type: 'self_update_report', report: r })) {
      markReported(this.d.appDir, r.id);
      this.d.log(`update over the link: job ${r.id} reported (${r.ok ? 'ok' : 'failed'}${r.rollback ? `, put back: ${r.rollback}` : ''})`);
    }
    const job = readJson<UpdateJob>(updateFiles(this.d.appDir).job);
    if (job?.reported && !job.removed && job.phase === 'done' && !alive(job.pid) && !this.busy) {
      const inst = this.install();
      if (inst) await (this.d.remove ?? removeJob)(inst.service, this.platform).catch(() => undefined);
      writeJson(updateFiles(this.d.appDir).job, { ...job, phase: 'done', reported: true, removed: true });
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

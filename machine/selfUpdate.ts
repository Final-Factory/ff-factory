// Updates over the daemon's link (w1596, docs/worker-install.md "Updates over the daemon's link"; lothsahn: "Yes, move
// updates and restarts onto the daemon link; drop the SSH need"). The portal says `self_update` with a commit and the SHA-256
// and size of a git bundle of its own code; this side:
//
//   1. downloads the bundle (GET /machine/update/<sha256>, this machine's credential) into <appDir>/update, checking its size
//      and SHA-256 against the message, which came on this machine's own authenticated link;
//   2. fetches it into the install's checkout (<appDir>/src: git checks every object, so the commit is the portal's to the
//      byte) and checks the commit out;
//      Then (w5516) it checks the commit is on ff-factory's main on GitHub (checkPublished): the portal only deploys commits
//      on main, so a commit that is not there is refused, whoever sent it;
//   3. writes the job (<appDir>/update/job.json) and starts scripts/worker/linkJob.ts from that commit as the OS's own job
//      (machine/osJob.ts), which runs the installer's update and puts the old code back when the new daemon does not come
//      back, then writes <appDir>/update/result.json;
//   4. the daemon that runs afterwards (the new one, or the old one put back) sends that result as self_update_report.
//
// No module here may need an npm package: linkJob.ts imports these from a checkout that has none.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitExecFile } from '../server/safeGit.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FromDaemon, LinkUpdateFlags, LinkUpdateReport, ToDaemon } from '../server/machineProtocol.ts';
import { notePortalRedirect } from './portalPin.ts';
import { launchJob, removeJob } from './osJob.ts';
import { jobSection } from '../server/updateLog.ts';

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

/**
 * How long an update job may be in flight (w5938). On beast, 2026-11-26, job 977d56f7 ran 15.5 min (06:11:26-06:26:55 UTC,
 * its daemon too blocked to be seen online), and the agent tools update the rollout sent at 06:14:31 was refused for it;
 * the longest of the 179 jobs in the last 6000 lines of its update-job.log. Past these the daemon ends the job (endOverdue):
 * a staged job past `stagedMs` (its process never took it), or a running one past `inFlightMs` whose process is gone, is
 * not the job's any more (its pid now another program's), or is hung: alive but its update-job.log unwritten for `quietMs`.
 * A live job process whose log still grows is never ended, however old. `quietMs` is a guess with room: the job's longest
 * silent steps are the 3 min wait for the portal (linkJob.ts PUT_BACK) and an installer step; a tools run ends itself at
 * 30 min (linkJob.ts TOOLS_JOB_MS). Both clocks count only time this daemon was awake to look (w5983's review): a look
 * more than `gapMs` after the last (the computer slept, the loop was blocked, the daemon restarted) starts them again, so a
 * job frozen by sleep is not taken for hung when the computer wakes. A staged job, or one whose process is gone, is ended
 * only once this daemon has watched it so for `watchMs`: after a reboot the job's own logon task takes it over first
 * (linkJob.ts resumes it, or puts the old code back).
 */
export const JOB_LIMIT = { stagedMs: 10 * 60_000, inFlightMs: 45 * 60_000, quietMs: 15 * 60_000, watchMs: 5 * 60_000, gapMs: 3 * 60_000 };

const minutes = (ms: number) => Math.round(ms / 60_000);

/** Why a job in flight is past its limit (JOB_LIMIT), or undefined. A staged job is one whose process never took it. */
export function jobOverdue(job: UpdateJob | undefined, now = Date.now()): string | undefined {
  if (!job || !jobInFlight(job)) return undefined;
  const age = now - Date.parse(job.createdAt);
  const limit = job.phase === 'staged' ? JOB_LIMIT.stagedMs : JOB_LIMIT.inFlightMs;
  if (!(age > limit)) return undefined;
  const what = job.phase === 'staged' ? 'staged and never taken by its process' : `running (pid ${job.pid})`;
  return `job ${job.id.slice(0, 8)} (${job.form}) has been ${what} for ${minutes(age)} min, past its ${minutes(limit)} min limit`;
}

/** What the daemon sees of a job's process and log when it decides (endOverdue); tests pass their own. */
export interface JobLook {
  /** The process's command line; undefined when it cannot be read (then it is never ended as another program's). */
  command?: string;
  /** When its update-job.log last grew, as this daemon saw it awake (endOverdue); undefined: never. */
  logAt?: number;
  /** How long this daemon has watched the job, awake, as it is now (staged, or its process gone); undefined: not yet. */
  watchedMs?: number;
}

/**
 * Whether a job past its limit is to be ended (w5938), and why: undefined for one within its limits or done. `kill` says its
 * process is alive and hung, and is ended first; `hold` says why one past its limit is not ended (yet). The pid is the job's
 * only when its command line names linkJob.ts.
 */
export function jobToEnd(job: UpdateJob | undefined, now: number, look: JobLook = {}): { reason: string; kill: boolean; hold?: string } | undefined {
  if (!job || job.phase === 'done') return undefined;
  const age = now - Date.parse(job.createdAt);
  const id = `job ${job.id.slice(0, 8)} (${job.form})`;
  // Staged, or its process gone: ended once watched so for watchMs, so a logon task resuming it after a reboot goes first.
  const watched = (reason: string) => {
    const w = look.watchedMs ?? 0;
    return w >= JOB_LIMIT.watchMs ? { reason, kill: false } : { reason, kill: false, hold: `this daemon has watched it so for ${minutes(w)} of the ${minutes(JOB_LIMIT.watchMs)} min it waits for the job's own task to take it over` };
  };
  if (job.phase === 'staged') {
    if (!(age > JOB_LIMIT.stagedMs)) return undefined;
    return watched(`${id} was staged ${minutes(age)} min ago and its process never took it (limit ${minutes(JOB_LIMIT.stagedMs)} min)`);
  }
  if (!(age > JOB_LIMIT.inFlightMs)) return undefined;
  const over = `${id} has run ${minutes(age)} min (limit ${minutes(JOB_LIMIT.inFlightMs)} min)`;
  if (!alive(job.pid)) return watched(`${over} and its process (pid ${job.pid ?? 'none'}) is gone without a result`);
  if (look.command !== undefined && !/linkJob\.ts/.test(look.command)) return watched(`${over} and its pid ${job.pid} is now another program's, so its process is gone without a result`);
  if (look.command === undefined) return { reason: over, kill: false, hold: `its process (pid ${job.pid}) is alive and its command line could not be read, so it is not known to be the job's` };
  const quiet = look.logAt === undefined ? 0 : now - look.logAt;
  if (!(quiet > JOB_LIMIT.quietMs)) return { reason: over, kill: false, hold: 'its process is alive and still writing its log' };
  return { reason: `${over} and its process (pid ${job.pid}) is hung: its log unwritten for ${minutes(quiet)} min while this daemon watched (limit ${minutes(JOB_LIMIT.quietMs)} min)`, kill: true };
}

/** The refusal while a job is in flight: which job, how long, and whether it is past its limit (w5938). */
export function inFlightRefusal(job: UpdateJob | undefined, now = Date.now(), hold = 'its process is alive and still writing its log'): string {
  const base = 'an update job of this machine is still running';
  if (!job || !jobInFlight(job)) return base;
  const over = jobOverdue(job, now);
  if (over) return `${base}: ${over}, but ${hold}, so it is not ended (w5938)`;
  return `${base} (job ${job.id.slice(0, 8)}, ${job.form}, ${minutes(now - Date.parse(job.createdAt))} min since it was made)`;
}

/** A job process's command line, or undefined when it cannot be read (w5938). */
export async function processCommand(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  try {
    if (platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    const o = { timeout: 15_000, windowsHide: true };
    const out = await new Promise<string | undefined>((resolve) => {
      const done = (e: Error | null, out: string) => resolve(e ? undefined : String(out).trim());
      if (platform === 'win32') execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').CommandLine`], o, done);
      else execFile('ps', ['-o', 'command=', '-p', String(Math.trunc(pid))], o, done);
    });
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stop a hung job process (w5938). On Windows the job's git, npm or installer would outlive its node (TerminateProcess ends
 * that one process), so its whole tree is ended with taskkill /T /F; elsewhere the signal goes to the job process.
 */
export async function stopProcess(pid: number, sig: NodeJS.Signals, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'win32') return void process.kill(pid, sig);
  await new Promise<void>((resolve, reject) => execFile('taskkill', ['/PID', String(Math.trunc(pid)), '/T', '/F'], { timeout: 15_000, windowsHide: true }, (e) => (e && alive(pid) ? reject(e) : resolve())));
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
 * answers a Range request, server/index.ts sendStream), at most `attempts` times, all of it within `totalMs`. A stall check
 * `lateMs` late is not a stall (w5938), but `lateRow` of them in a row with nothing read between is (w5987).
 */
export const DOWNLOAD = { stallMs: 30_000, attempts: 6, totalMs: 8 * 60_000, lateMs: 10_000, lateRow: 5 };

/** A limit in words: "8 min", "1.5 s". */
const span = (ms: number) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 100) / 10} s`);

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
 * breaks resumes from the bytes it has (DOWNLOAD), each retry logged with its reason; a call that runs out keeps them for the
 * next call of the same bundle (w5898, keptPart). Exported for tests.
 */
export async function downloadBundle(
  portalUrl: string,
  token: string,
  b: { sha256: string; size: number },
  dir: string,
  doFetch: typeof fetch = fetch,
  o: { stallMs?: number; attempts?: number; totalMs?: number; lateMs?: number; lateRow?: number; fromZero?: boolean; log?: (line: string) => void } = {},
): Promise<string> {
  const stallMs = o.stallMs ?? DOWNLOAD.stallMs;
  const lateMs = o.lateMs ?? DOWNLOAD.lateMs;
  const lateRow = o.lateRow ?? DOWNLOAD.lateRow;
  const attempts = o.attempts ?? DOWNLOAD.attempts;
  const totalMs = o.totalMs ?? DOWNLOAD.totalMs;
  const deadline = Date.now() + totalMs;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${b.sha256.slice(0, 16)}.bundle`);
  const part = `${file}.part`;
  const url = `${portalUrl.replace(/\/+$/, '')}/machine/update/${b.sha256}`;
  // w5898: a part an earlier call kept (a cut attempt) is resumed: its bytes are hashed again and the next request asks for
  // the rest. One that cannot be read, is not a file or is not shorter than the bundle goes, and the download starts from 0.
  sweepParts(dir, part, o.log);
  const kept = o.fromZero ? undefined : await keptPart(part, b.size, o.log);
  const out = await fs.promises.open(part, kept ? 'r+' : 'w');
  let hash = kept?.hash ?? createHash('sha256');
  let size = kept?.size ?? 0;
  if (kept) o.log?.(`update over the link: resuming the bundle's download from the ${kept.size} of ${b.size} bytes an earlier attempt kept`);
  const restart = async () => {
    await out.truncate(0);
    hash = createHash('sha256');
    size = 0;
  };
  try {
    for (let attempt = 1; ; attempt++) {
      const ctl = new AbortController();
      let timedOut: 'stall' | 'total' | undefined;
      let lateNote = '';
      let lates = 0;
      let timer: NodeJS.Timeout | undefined;
      // w5938: a check that comes late is not a stall. beast's daemon blocked its own event loop 40-72 s at a time (LoopWatch,
      // 2026-11-26 05:38-06:33 UTC); Node runs a due timer before it reads the socket, so the 30 s check fired before the
      // bytes (or the TLS handshake) that came meanwhile were read, and six "stalled at 0 of 25693 bytes" refused the update
      // twice while the portal logged no bundle sent. A late check gives the stream a fresh `stallMs`; `totalMs` still ends it.
      // w5987: on a loop that keeps blocking, a real stall would show only at `totalMs`, so `lateRow` late checks in a row with
      // no answer or byte read between are a stall; and a late check past the deadline says so, not "stalled".
      const arm = (read = false) => {
        if (read) lates = 0;
        clearTimeout(timer);
        const left = deadline - Date.now();
        const wait = Math.max(1, Math.min(stallMs, left));
        const due = Date.now() + wait;
        timer = setTimeout(() => {
          const late = Date.now() - due;
          if (late > lateMs && Date.now() >= deadline) {
            timedOut = 'total';
            lateNote = ` (its stall check came ${Math.round(late / 1000)} s late, past the ${span(totalMs)} limit)`;
          } else if (left > stallMs && late > lateMs && ++lates >= lateRow) {
            timedOut = 'stall';
            lateNote = ` (its stall check came late ${lates} times in a row with nothing read between)`;
          } else if (left > stallMs && late > lateMs) {
            o.log?.(`update over the link: the bundle's stall check came ${Math.round(late / 1000)} s late (this daemon's event loop was blocked), at ${size} of ${b.size} bytes: not a stall, the stream gets another ${Math.round(stallMs / 1000)} s`);
            arm();
            return;
          } else timedOut = left <= stallMs ? 'total' : 'stall';
          ctl.abort();
        }, wait);
      };
      arm();
      try {
        const from = size;
        const res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, ...(from ? { range: `bytes=${from}-` } : {}) }, signal: ctl.signal });
        arm(true);
        notePortalRedirect(url, res);
        // A range the portal will not serve (416): the kept bytes are not part of this bundle, so it starts again from 0.
        if (from && res.status === 416) {
          await res.body?.cancel();
          await restart();
          throw new Error(`the portal answered 416 for a resume from byte ${from}; starting from 0`);
        }
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
          arm(true);
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
        const why = timedOut === 'stall' ? `stalled${lateNote || ` (no byte in ${Math.round(stallMs / 1000)} s)`}` : timedOut === 'total' ? `did not finish in ${Math.round(totalMs / 1000)} s${lateNote}` : `broke: ${fetchError(e)}`;
        if (timedOut === 'total' || attempt >= attempts || Date.now() >= deadline) throw new Error(`the bundle's download ${why} at ${size} of ${b.size} bytes, after ${attempt} attempt(s)`);
        o.log?.(`update over the link: the bundle's download ${why} at ${size} of ${b.size} bytes; attempt ${attempt + 1} of ${attempts} resumes from there`);
        await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000, Math.max(0, deadline - Date.now()))));
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (e) {
    await out.close();
    // w5898: a cut download keeps its bytes for the next call (beast fetched one 29.3 MB bundle four times from 0 on
    // 2026-11-25, reaching 16.6, 19.5, 22.0 and 8.9 MB); a refusal or a bundle unlike what the portal said keeps nothing.
    if (e instanceof Final || size <= 0) fs.rmSync(part, { force: true });
    else o.log?.(`update over the link: kept the ${size} of ${b.size} bytes of the bundle in ${path.basename(part)}; the next attempt resumes from there`);
    throw e;
  }
  await out.close();
  const sha = hash.digest('hex');
  if (size !== b.size || sha !== b.sha256) {
    fs.rmSync(part, { force: true });
    // A kept part that did not add up (bytes changed on disk, or not this bundle's): gone, and once more from 0 in the time left.
    if (kept && Date.now() < deadline) {
      o.log?.(`update over the link: the bundle resumed from ${kept.size} kept bytes did not match what the portal said (SHA-256 ${sha.slice(0, 12)}…); the kept part is deleted and the download starts again from 0`);
      return downloadBundle(portalUrl, token, b, dir, doFetch, { ...o, fromZero: true, totalMs: deadline - Date.now() });
    }
    throw new Error(`the bundle does not match what the portal said on the link (${size} bytes, SHA-256 ${sha.slice(0, 12)}…; expected ${b.size} bytes, ${b.sha256.slice(0, 12)}…): nothing was changed`);
  }
  fs.renameSync(part, file);
  return file;
}

/** The other bundles' parts that stay beside this one (w5898): a thin and a full one of the same commit, say. */
const KEEP_OTHER_PARTS = 1;

/** Parts of other bundles: the newest `KEEP_OTHER_PARTS` stay, the rest go, so kept parts never pile up in the update folder. */
function sweepParts(dir: string, part: string, log?: (line: string) => void): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.bundle.part') && path.join(dir, n) !== part);
  } catch {
    return;
  }
  const byAge = names
    .map((n) => ({ f: path.join(dir, n), t: fs.statSync(path.join(dir, n), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of byAge.slice(KEEP_OTHER_PARTS)) {
    try {
      fs.rmSync(f, { force: true });
      log?.(`update over the link: removed the partial bundle ${path.basename(f)} of an older update`);
    } catch {
      // Best effort: it goes at the next download or the next finished update (removeOldBundles).
    }
  }
}

/**
 * The part an earlier call kept for this bundle, hashed so far, or undefined (w5898). Anything else at that path (a part as
 * long as the bundle or longer, an empty one, a folder, one that cannot be read) is removed, and the download starts from 0.
 */
async function keptPart(part: string, total: number, log?: (line: string) => void): Promise<{ size: number; hash: ReturnType<typeof createHash> } | undefined> {
  const st = fs.lstatSync(part, { throwIfNoEntry: false });
  if (!st) return undefined;
  const drop = (why: string) => {
    log?.(`update over the link: the kept partial bundle ${path.basename(part)} ${why}; it is deleted and the download starts from 0`);
    fs.rmSync(part, { force: true, recursive: true });
    return undefined;
  };
  if (!st.isFile()) return drop('is not a file');
  if (st.size <= 0) return drop('is empty');
  if (st.size >= total) return drop(`holds ${st.size} bytes, not fewer than the bundle's ${total}`);
  try {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(part, { end: st.size - 1 })) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    if (size !== st.size) return drop(`read ${size} of its ${st.size} bytes`);
    return { size, hash };
  } catch (e) {
    return drop(`could not be read (${(e as Error).message})`);
  }
}

const git = (args: string[], timeoutMs = 5 * 60_000) =>
  new Promise<string>((resolve, reject) =>
    gitExecFile(args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args[0] === '-C' ? args[2] : args[0]} failed: ${String(stderr || err.message).trim().split('\n').pop()}`)) : resolve(String(stdout)),
    ),
  );

/**
 * Fetch the bundle into the install's checkout and check `commit` out there (git verifies every object it takes, so what is
 * checked out is the portal's commit exactly). A checkout that is missing is made. Exported for tests.
 */
export async function checkoutFromBundle(src: string, bundle: string, commit: string, verify?: (src: string) => Promise<void>): Promise<void> {
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
  if (verify) await verify(src);
  await git(['-C', src, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', commit]);
}

/** Where ff-factory's code is published: a daemon takes over its link only commits on this branch (w5516). */
export interface PublishedOrigin {
  url: string;
  branch: string;
}
export const FF_PUBLISHED: PublishedOrigin = { url: 'https://github.com/Final-Factory/ff-factory.git', branch: 'main' };

/**
 * w5516 (the w5452 audit's finding 11): the portal sends the commit and the bundle's hash itself, so the bundle check alone
 * trusts the portal. This fetches the published branch into the install's checkout (refs/remotes/ff-published/<branch>,
 * anonymous) and refuses a commit that is not on it. Exported for tests.
 */
export async function checkPublished(src: string, commit: string, origin: PublishedOrigin = FF_PUBLISHED): Promise<void> {
  if (!/^[\w.-]+$/.test(origin.branch)) throw new Error(`the published branch "${origin.branch}" is not a branch name`);
  const ref = `refs/remotes/ff-published/${origin.branch}`;
  await git(['-C', src, 'fetch', '--quiet', '--no-tags', origin.url, `+refs/heads/${origin.branch}:${ref}`], 3 * 60_000).catch((e) => {
    throw new Error(`could not read ${origin.branch} at ${origin.url} to check commit ${commit.slice(0, 12)} is published there (${(e as Error).message}): nothing was changed`);
  });
  await git(['-C', src, 'merge-base', '--is-ancestor', commit, ref]).catch(() => {
    throw new Error(`commit ${commit.slice(0, 12)} is not on ${origin.branch} at ${origin.url}: refused, nothing was changed`);
  });
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
  /** w5938: a job process's command line (processCommand) and the signal that ends a hung one; tests replace them. */
  command?: (pid: number) => Promise<string | undefined>;
  kill?: (pid: number, signal: NodeJS.Signals) => void | Promise<void>;
  /** How long a stopped job process is waited for after each signal (w5938); tests shorten it. */
  stopWaitMs?: number;
  /** w5546: sets the worker read fence's mode (daemon_control read-fence-off / read-fence-warn / read-fence-on). */
  readFence?: (mode: 'off' | 'warn' | 'on') => Promise<void>;
  remove?: typeof removeJob;
  fetch?: typeof fetch;
  now?: () => number;
  /**
   * Where a commit must be published before it is checked out (w5516): GitHub's ff-factory main unless daemon.json's
   * `updateOrigin` names another (the link end-to-end test's local repository). Read at each update.
   */
  published?: () => PublishedOrigin | undefined;
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
  /** Jobs past their limit already warned of (JOB_LIMIT), so the tick says it once. */
  private readonly overdueWarned = new Set<string>();
  /** The job's update-job.log as this daemon last looked (`seen`): its size, and when it grew or the clock started (JobLook.logAt). */
  private logSeen: { id: string; size: number; at: number; seen: number } | undefined;
  /** The job as this daemon last looked (`seen`), and since when it has been so (JobLook.watchedMs). */
  private watch: { key: string; since: number; seen: number } | undefined;
  /** The job process's command line as last read, so Windows starts PowerShell once in 5 min, not every tick. */
  private commandSeen: { pid: number; command: string | undefined; at: number } | undefined;
  /** Why the job past its limit is not ended, for the tick's warning and the refusal. */
  private held: { id: string; hold: string; stopFailedAt?: number } | undefined;
  /** An overdue job being ended: the tick and a new update wait for the one look (endOverdue). */
  private ending: Promise<void> | undefined;
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
    await this.endOverdue();
    await this.removing;
    if (this.busy) return refuse('an update job of this machine is still running (this daemon is fetching or starting one)');
    const prior = readJson<UpdateJob>(f.job);
    if (jobInFlight(prior)) return refuse(inFlightRefusal(prior, this.now(), this.holdOf(prior)));
    this.busy = true;
    try {
      this.deps.log(`update over the link: ${msg.form} to ff-factory ${msg.commit.slice(0, 12)}; fetching the bundle (${msg.bundle.size} bytes)`);
      const bundle = await downloadBundle(this.deps.portalUrl(), this.deps.token, msg.bundle, f.dir, this.deps.fetch, { log: (l) => this.deps.log(l) });
      await checkoutFromBundle(f.src, bundle, msg.commit, (src) => checkPublished(src, msg.commit, this.deps.published?.() ?? FF_PUBLISHED));
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
    if (msg.action === 'read-fence-off' || msg.action === 'read-fence-warn' || msg.action === 'read-fence-on') {
      if (!this.deps.readFence) return answer(false, 'this daemon has no read fence switch');
      try {
        await this.deps.readFence(msg.action === 'read-fence-off' ? 'off' : msg.action === 'read-fence-warn' ? 'warn' : 'on');
        answer(true);
      } catch (e) {
        answer(false, (e as Error).message);
      }
      return;
    }
    if (msg.action !== 'restart' && msg.action !== 'uninstall') return answer(false, `unknown action ${String((msg as { action?: unknown }).action)}`);
    if (msg.action === 'restart') {
      answer(true);
      this.deps.log('restart over the link: going; the supervisor starts the daemon again and it takes its agents back');
      setTimeout(() => this.deps.exit(), 300);
      return;
    }
    const inst = this.install();
    if (!inst) return answer(false, this.noInstall());
    if (!fs.existsSync(path.join(updateFiles(this.deps.appDir).src, 'scripts', 'worker', 'linkJob.ts'))) return answer(false, "the install's checkout has no update job (scripts/worker/linkJob.ts): update it first");
    await this.endOverdue();
    await this.removing;
    const prior = readJson<UpdateJob>(updateFiles(this.deps.appDir).job);
    if (this.busy || jobInFlight(prior)) return answer(false, this.busy ? 'an update job of this machine is still running' : inFlightRefusal(prior, this.now(), this.holdOf(prior)));
    try {
      const how = await this.start(this.job('uninstall', msg.id, inst.service), inst.service);
      this.deps.log(`unload over the link: job ${msg.id} started as ${how}`);
      answer(true);
    } catch (e) {
      answer(false, (e as Error).message);
    }
  }

  /**
   * w5938: end a job past its limit (jobToEnd) with nobody at the machine: a hung process is stopped first, then the job gets a
   * failed result (sent by the tick like any other) and its done phase, so updates are taken again. The daemon runs on.
   */
  /** Why the job in flight is not ended, as the last look found (inFlightRefusal's words). */
  private holdOf(job: UpdateJob | undefined): string | undefined {
    return job && this.held?.id === job.id ? this.held.hold : undefined;
  }
  endOverdue(): Promise<void> {
    this.ending ??= this.endOverdueOnce().finally(() => (this.ending = undefined));
    return this.ending;
  }
  private async endOverdueOnce(): Promise<void> {
    const f = updateFiles(this.deps.appDir);
    const job = readJson<UpdateJob>(f.job);
    if (!job || job.phase === 'done') return;
    const now = this.now();
    const look: JobLook = {};
    // A look long after the last (sleep, a blocked loop, a restart): what came before it was not watched, so the clocks start.
    const fresh = (seen: number | undefined) => seen === undefined || now - seen > JOB_LIMIT.gapMs || now < seen;
    let size = -1;
    try {
      size = fs.statSync(f.log).size;
    } catch {
      // no log yet
    }
    const ls = this.logSeen;
    this.logSeen = { id: job.id, size, seen: now, at: !ls || ls.id !== job.id || ls.size !== size || fresh(ls.seen) ? now : ls.at };
    look.logAt = this.logSeen.at;
    // Its command line only once it is past its limit, and once in 5 min: on Windows each look starts PowerShell.
    const pastLimit = now - Date.parse(job.createdAt) > JOB_LIMIT.inFlightMs;
    if (job.phase === 'running' && job.pid && alive(job.pid) && pastLimit) {
      const c = this.commandSeen;
      const seen = c && c.pid === job.pid && now - c.at < 5 * 60_000 && now >= c.at ? c : { pid: job.pid, command: await (this.deps.command ?? processCommand)(job.pid), at: now };
      this.commandSeen = seen;
      look.command = seen.command;
    }
    const gone = job.phase === 'running' && (!alive(job.pid) || (look.command !== undefined && !/linkJob\.ts/.test(look.command)));
    const key = `${job.id}|${job.phase}|${job.pid ?? ''}|${gone}`;
    const w = this.watch;
    this.watch = { key, seen: now, since: !w || w.key !== key || fresh(w.seen) ? now : w.since };
    look.watchedMs = now - this.watch.since;
    const end = jobToEnd(job, now, look);
    if (!end) return;
    if (end.hold) {
      this.held = { id: job.id, hold: end.hold };
      return;
    }
    if (end.kill && job.pid) {
      // One that did not end when stopped is tried again in 5 min, not at every tick (each try waits up to 10 s).
      const h = this.held;
      if (h?.id === job.id && h.stopFailedAt !== undefined && now - h.stopFailedAt < 5 * 60_000 && now >= h.stopFailedAt) return;
      // Its command line read again just before it is stopped: a cached one must never stop another program.
      const now3 = await (this.deps.command ?? processCommand)(job.pid);
      if (!now3 || !/linkJob\.ts/.test(now3)) return;
      const kill = this.deps.kill ?? stopProcess;
      try {
        const steps = Math.ceil((this.deps.stopWaitMs ?? 5_000) / 250);
        await kill(job.pid, 'SIGTERM');
        for (let i = 0; i < steps && alive(job.pid); i++) await new Promise((r) => setTimeout(r, 250));
        if (alive(job.pid)) await kill(job.pid, 'SIGKILL');
        for (let i = 0; i < steps && alive(job.pid); i++) await new Promise((r) => setTimeout(r, 250));
      } catch (e) {
        this.deps.log(`update over the link: ending hung job ${job.id.slice(0, 8)} (pid ${job.pid}) failed: ${(e as Error).message}`);
      }
      if (alive(job.pid)) {
        const hold = 'its process did not end when stopped';
        if (this.held?.hold !== hold) this.deps.log(`update over the link: WARNING ${end.reason}; ${hold}, so the job is left in flight (w5938)`);
        this.held = { id: job.id, hold, stopFailedAt: now };
        return;
      }
    }
    // Its process may have taken it, or ended it, meanwhile: only the job as it was seen is ended.
    const now2 = readJson<UpdateJob>(f.job);
    if (!now2 || now2.id !== job.id || now2.phase !== job.phase || now2.pid !== job.pid || readJson<LinkUpdateReport>(f.result)?.id === job.id) return;
    const note = `the daemon ended the job: ${end.reason}; this machine takes updates again, its daemon runs on (w5938)`;
    const at = new Date(now).toISOString();
    try {
      fs.mkdirSync(path.dirname(f.log), { recursive: true });
      const head = job.phase === 'staged' ? `\n${at} FF Factory update job ${job.id}: ${job.form}${job.commit ? ` to ff-factory ${job.commit.slice(0, 12)}` : ''} (never started by its process).\n` : '';
      fs.appendFileSync(f.log, `${head}${at} job ${job.id}: FAILED (${note}).\n`);
    } catch {
      // the result still says why
    }
    let log = '';
    try {
      log = scrub(jobSection(fs.readFileSync(f.log, 'utf8').slice(-512 * 1024), job.id)).slice(-12_000);
    } catch {
      // no log
    }
    const report: LinkUpdateReport = { id: job.id, form: job.form === 'tools' ? 'tools' : 'update', commit: job.commit ?? '', ok: false, exit: 1, ...(job.before ? { before: job.before } : {}), note, log, at };
    writeJson(f.result, report);
    writeJson(f.job, { ...job, phase: 'done', pid: undefined });
    this.deps.log(`update over the link: FAILED ${note}`);
  }

  /** Send a result the portal has not had; once sent and the job's process is gone, remove the job's task or LaunchAgent. */
  async tick(): Promise<void> {
    // The spare copy of root.json kept fresh, and root.json put back once a reset drive is there again (w1918).
    this.install();
    // An overdue job is ended first (w5938), so its failed result goes in this tick. Only one not done is looked at, so a
    // finished job's removal below still starts in this same turn of the loop (the command that arrives then waits for it).
    if (readJson<UpdateJob>(updateFiles(this.deps.appDir).job)?.phase !== 'done') await this.endOverdue();
    const r = pendingReport(this.deps.appDir);
    if (r && this.deps.send({ type: 'self_update_report', report: r })) {
      markReported(this.deps.appDir, r.id);
      this.deps.log(`update over the link: job ${r.id} reported (${r.ok ? 'ok' : 'failed'}${r.rollback ? `, put back: ${r.rollback}` : ''})`);
    }
    const job = readJson<UpdateJob>(updateFiles(this.deps.appDir).job);
    const over = jobOverdue(job, this.now());
    if (over && job && !this.overdueWarned.has(job.id)) {
      this.overdueWarned.add(job.id);
      this.deps.log(`update over the link: WARNING ${over}; ${this.holdOf(job) ?? 'it is not ended yet'}, so it is left to run and updates are refused meanwhile (w5938)`);
    }
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

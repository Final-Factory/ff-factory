// The portal's half of updates over a daemon's link (w1596, docs/worker-install.md "Updates over the daemon's link";
// machine/selfUpdate.ts is the daemon's). The code a machine updates to is the portal's own: a git bundle of the checkout
// it runs from (deploy/vm/guest/fff-update makes each release a worktree of one clone), at its HEAD. The bundle's SHA-256
// and size go in the `self_update` message on the machine's own authenticated link; the machine downloads it with its own
// credential (GET /machine/update/<sha256>, only a machine it was offered to) and checks both, and git checks the commit.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface UpdateBundle {
  commit: string;
  file: string;
  sha256: string;
  size: number;
}

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const p = spawn('git', ['-C', cwd, ...args], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} failed (${code}): ${err.trim().slice(-300)}`))));
  });

/** The commit the portal's checkout is at (its HEAD, the full id), or undefined when it is not a git checkout. */
export async function portalCommit(root: string): Promise<string | undefined> {
  const sha = (await git(root, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

/** The bundles a machine may fetch: made once per commit in the data folder, the newest few kept. */
export class UpdateBundles {
  private readonly dir: string;
  private readonly root: string;
  private made = new Map<string, Promise<UpdateBundle>>();
  /** machine id -> the bundle's SHA-256 it was offered, until when (ms). */
  private offers = new Map<string, { sha256: string; until: number }>();

  constructor(o: { dataDir: string; root: string }) {
    this.dir = path.join(o.dataDir, 'update-bundles');
    this.root = o.root;
  }

  /** The bundle of the portal's checkout at its HEAD, which must be `commit` (the code a rollout or update asked for). */
  async prepare(commit?: string): Promise<UpdateBundle> {
    const head = await portalCommit(this.root);
    if (!head) throw new Error(`the portal's code at ${this.root} is not a git checkout, so it has no bundle to send`);
    if (commit && !head.startsWith(commit.toLowerCase())) throw new Error(`the portal's checkout is at ${head.slice(0, 12)}, not ${commit.slice(0, 12)}`);
    // A shallow clone's bundle lacks the parents it names, and a machine's git refuses it ("did not send all necessary objects").
    if ((await git(this.root, ['rev-parse', '--is-shallow-repository']).catch(() => '')).trim() === 'true') throw new Error(`the portal's checkout at ${this.root} is a shallow clone, whose bundle no machine can fetch`);
    let p = this.made.get(head);
    if (!p) {
      p = this.make(head);
      this.made.set(head, p);
      p.catch(() => this.made.delete(head));
    }
    return p;
  }

  private async make(commit: string): Promise<UpdateBundle> {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${commit.slice(0, 16)}.bundle`);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      // Its HEAD as the bundle's HEAD: the machine fetches HEAD and checks the commit (machine/selfUpdate.ts checkoutFromBundle).
      await git(this.root, ['bundle', 'create', '--quiet', tmp, 'HEAD']);
      fs.renameSync(tmp, file);
    }
    const sha256 = await new Promise<string>((resolve, reject) => {
      const h = createHash('sha256');
      fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
    // The two newest stay: one a rollout may still hand out, one before it.
    const old = fs.readdirSync(this.dir).filter((n) => n.endsWith('.bundle') && path.join(this.dir, n) !== file).map((n) => path.join(this.dir, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of old.slice(1)) fs.rmSync(f, { force: true });
    return { commit, file, sha256, size: fs.statSync(file).size };
  }

  /** This machine may fetch this bundle for the next hour. */
  offer(machineId: string, b: UpdateBundle, now = Date.now()) {
    this.offers.set(machineId, { sha256: b.sha256, until: now + 3_600_000 });
  }

  /** The bundle file a machine asks for, when it was offered that one and the offer stands; else undefined. */
  async fileFor(machineId: string, sha256: string, now = Date.now()): Promise<string | undefined> {
    const o = this.offers.get(machineId);
    if (!o || o.sha256 !== sha256 || o.until < now) return undefined;
    for (const p of this.made.values()) {
      const b = await p.catch(() => undefined);
      if (b?.sha256 === sha256) return b.file;
    }
    return undefined;
  }
}

/**
 * GET /machine/update/<sha256> (server/index.ts): which file a machine gets, or the refusal. Only with its own credential,
 * and only the bundle it was offered on its link.
 */
export async function updateBundleFor(pathname: string, machineOf: () => string | undefined, bundles: UpdateBundles): Promise<{ status: 200; file: string; size: number } | { status: 401 | 404; error: string } | undefined> {
  const m = /^\/machine\/update\/([0-9a-f]{64})$/.exec(pathname);
  if (!m) return undefined;
  const machineId = machineOf();
  if (!machineId) return { status: 401, error: 'a valid machine token is required' };
  const file = await bundles.fileFor(machineId, m[1]);
  if (!file || !fs.existsSync(file)) return { status: 404, error: 'no update bundle with that SHA-256 was offered to this machine' };
  return { status: 200, file, size: fs.statSync(file).size };
}

/** How long a call that timed out is remembered, so its late answer is still logged with what it was (w1641). */
const LATE_KEEP_MS = 6 * 3_600_000;
const LATE_KEEP_MAX = 200;

/** A call that timed out before its answer came (w1641): what it waited for and since when. */
export interface LateCall {
  machineId: string;
  what: string;
  /** When the call was made and when it gave up (ms). */
  since: number;
  gaveUp: number;
}

/** A call to a daemon answered later by a message with its id (self_update_ack, self_update_report, daemon_control_result). */
export class PendingCalls<T> {
  private calls = new Map<string, { resolve: (v: T) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; machineId: string }>();
  /** Calls that timed out, oldest first: an answer that comes after is logged with its reason, never dropped (w1641). */
  private expired = new Map<string, LateCall>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  wait(id: string, machineId: string, ms: number, what: string): Promise<T> {
    const since = this.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        this.remember(id, { machineId, what, since, gaveUp: this.now() });
        reject(new Error(`${machineId} did not answer ${what} in ${Math.round(ms / 60_000) || 1} minute(s)`));
      }, ms);
      timer.unref?.();
      this.calls.set(id, { resolve, reject, timer, machineId });
    });
  }

  private remember(id: string, c: LateCall) {
    for (const [k, v] of this.expired) if (this.expired.size >= LATE_KEEP_MAX || c.gaveUp - v.gaveUp > LATE_KEEP_MS) this.expired.delete(k);
    this.expired.set(id, c);
  }

  /** The answer came: true when a call waited for it. */
  settle(id: string, v: T | Error): boolean {
    const c = this.calls.get(id);
    if (!c) return false;
    this.calls.delete(id);
    clearTimeout(c.timer);
    if (v instanceof Error) c.reject(v);
    else c.resolve(v);
    return true;
  }

  /** An answer no call waits for any more: the call it answers when that one timed out (once), else undefined. */
  late(id: string): LateCall | undefined {
    const c = this.expired.get(id);
    this.expired.delete(id);
    return c;
  }

  has(id: string): boolean {
    return this.calls.has(id);
  }
}

const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/**
 * The journal line for an answer from a daemon that no call waits for (w1641: beast refused a tools publish after the
 * portal's 5 minutes, and the reason was dropped, so the rollout said only "did not answer"). `late`: the call it answers,
 * when that one timed out; `said`: what the daemon answered ("took it", "refused it: <why>").
 */
export function unwaitedAnswer(machineId: string, callId: string, late: LateCall | undefined, said: string, now = Date.now()): string {
  const job = callId.slice(0, 8);
  if (!late) return `machine ${machineId}: an answer to call ${job} that nothing waits for (it ${said})`;
  return `machine ${machineId}: a late answer to ${late.what} (call ${job}): it ${said}, ${mins(now - late.since)} after it was sent; the portal had given up after ${mins(late.gaveUp - late.since)}`;
}

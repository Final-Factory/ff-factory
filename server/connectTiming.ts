// Where a page socket's handoff goes (w6762). After w6336 a reconnect's server build was 0.1-0.5 s, yet the page waited
// 3-9 s for its socket to open and 3-10 s more for the first state, with the event loop never blocked for a second
// (2026-11-28 05:00:26-34Z: three sockets, one second's finish). These measure the shared things that could hold them:
// libuv's thread pool (ws deflates on it, and so do fs and zlib), ws's own deflate of the first state (queued behind its
// limiter, then run on that pool in 16 KB output chunks, each a pool job and a loop turn), the kernel write after it, and
// the VM's CPU (the portal's node, tailscaled carrying Funnel and tailnet traffic, and the hypervisor's steal).
// docs/portal-logs.md, "Page socket timing".
import fs from 'node:fs';
import os from 'node:os';

const now = () => performance.now();

/** How long a no-op job waited for libuv's thread pool (`poolMs`) and for one turn of the event loop (`loopMs`). */
export interface PoolLag { poolMs: number; loopMs: number }

/**
 * Times one no-op thread-pool job (an fs.stat of the root folder: one pool job, no disk read) beside one setImmediate.
 * `poolMs` minus `loopMs` is roughly the job's wait for a free pool thread; both include the loop's own turn.
 */
export function probePool(done: (lag: PoolLag) => void, stat: (cb: () => void) => void = (cb) => fs.stat('/', () => cb())): void {
  const t0 = now();
  let loopMs: number | undefined;
  let poolMs: number | undefined;
  const finish = () => {
    if (loopMs !== undefined && poolMs !== undefined) done({ poolMs, loopMs });
  };
  setImmediate(() => {
    loopMs = now() - t0;
    finish();
  });
  stat(() => {
    poolMs = now() - t0;
    finish();
  });
}

/** ws's deflate of one message: waiting in ws's zlib limiter, running (pool jobs and loop turns), and its sizes. */
export interface DeflateTiming { queuedMs?: number; ranMs?: number; doneAt?: number; inBytes?: number; outBytes?: number; chunks?: number }

type Cb = (err: unknown, out?: Buffer) => void;
interface DeflateExt {
  compress?: (data: Buffer | string, fin: boolean, cb: Cb) => void;
  _compress?: (data: Buffer | string, fin: boolean, cb: Cb) => void;
  _deflate?: { on(ev: 'data', f: (b: Buffer) => void): void; off(ev: 'data', f: (b: Buffer) => void): void } | null;
}

/**
 * Times the next message ws deflates on this socket (call just before ws.send of the first state). It wraps that one
 * socket's permessage-deflate extension (ws 8's compress, which queues in its limiter, and _compress, which runs zlib)
 * for one call and puts the originals back; a socket without deflate, or a ws whose internals moved, is left alone and
 * the timing stays empty. Never throws.
 */
export function timeNextDeflate(ws: object): DeflateTiming {
  const t: DeflateTiming = {};
  try {
    const ext = (ws as { _extensions?: Record<string, DeflateExt> })._extensions?.['permessage-deflate'];
    if (!ext || typeof ext.compress !== 'function' || typeof ext._compress !== 'function') return t;
    if (Object.hasOwn(ext, 'compress') || Object.hasOwn(ext, '_compress')) return t;
    const proto = Object.getPrototypeOf(ext) as Required<Pick<DeflateExt, 'compress' | '_compress'>>;
    let queuedAt = 0;
    ext.compress = function (data, fin, cb) {
      delete ext.compress;
      queuedAt = now();
      t.inBytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      return proto.compress.call(this, data, fin, cb);
    };
    ext._compress = function (data, fin, cb) {
      delete ext._compress;
      const ranAt = now();
      if (queuedAt) t.queuedMs = ranAt - queuedAt;
      let chunks = 0;
      const count = () => void chunks++;
      const wrapped: Cb = (err, out) => {
        t.doneAt = now();
        t.ranMs = t.doneAt - ranAt;
        t.chunks = chunks;
        if (out) t.outBytes = out.length;
        try {
          ext._deflate?.off('data', count);
        } catch {
          // Closed meanwhile: the counts so far stand.
        }
        cb(err, out);
      };
      const r = proto._compress.call(this, data, fin, wrapped);
      try {
        ext._deflate?.on('data', count);
      } catch {
        // No stream: no chunk count.
      }
      return r;
    };
  } catch {
    // ws's internals are not ours: no timing rather than a broken send.
  }
  return t;
}

/** CPU counters at one moment: the whole VM's (/proc/stat, clock ticks), this process's (µs) and tailscaled's (ticks). */
export interface CpuSample { at: number; total?: number; idle?: number; steal?: number; node: number; tailscaled?: number }

/** Clock ticks per second for /proc's counters: 100 on every Linux the portal runs on (getconf CLK_TCK). */
const TICKS = 100;

/**
 * Samples the VM's CPU on demand (twice per page connect: at the open and when its first state is handed off), so the
 * line says what the CPU did over that connect's own seconds. Linux only (/proc); elsewhere only the node figure.
 */
export class CpuSampler {
  private tsPid: number | undefined;
  private tsLookedAt = -Infinity;
  private readonly proc: string;
  private readonly read: (p: string) => string;
  private readonly list: (p: string) => string[];

  constructor(opts: { proc?: string; read?: (p: string) => string; list?: (p: string) => string[] } = {}) {
    this.proc = opts.proc ?? '/proc';
    this.read = opts.read ?? ((p) => fs.readFileSync(p, 'utf8'));
    this.list = opts.list ?? ((p) => fs.readdirSync(p));
  }

  sample(): CpuSample {
    const u = process.cpuUsage();
    const s: CpuSample = { at: now(), node: u.user + u.system };
    try {
      const f = this.read(`${this.proc}/stat`).split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
      // user nice system idle iowait irq softirq steal
      if (f.length >= 8 && f.every(Number.isFinite)) {
        s.total = f.slice(0, 8).reduce((a, b) => a + b, 0);
        s.idle = f[3] + f[4];
        s.steal = f[7];
      }
    } catch {
      // Not Linux, or /proc is closed: the VM's figures are left out.
    }
    s.tailscaled = this.tailscaledTicks();
    return s;
  }

  /** "cpu{vm 93% of 2 cores, steal 4%, node 98%, tailscaled 41%}" between two samples; a process's % is of one core. */
  between(a: CpuSample, b: CpuSample): string {
    const secs = (b.at - a.at) / 1000;
    if (secs <= 0.05) return '';
    const parts: string[] = [];
    if (a.total !== undefined && b.total !== undefined && a.idle !== undefined && b.idle !== undefined && b.total > a.total) {
      const dt = b.total - a.total;
      parts.push(`vm ${Math.round((100 * (dt - (b.idle - a.idle))) / dt)}% of ${os.cpus().length} cores`);
      if (a.steal !== undefined && b.steal !== undefined) parts.push(`steal ${Math.round((100 * (b.steal - a.steal)) / dt)}%`);
    }
    parts.push(`node ${Math.round((b.node - a.node) / 1e4 / secs)}%`);
    if (a.tailscaled !== undefined && b.tailscaled !== undefined) parts.push(`tailscaled ${Math.round((100 * (b.tailscaled - a.tailscaled)) / TICKS / secs)}%`);
    return `cpu{${parts.join(', ')}}`;
  }

  /** tailscaled's utime+stime in ticks, finding its pid by name at most once a minute while it is unknown or gone. */
  private tailscaledTicks(): number | undefined {
    if (this.tsPid !== undefined) {
      const t = this.ticksOf(this.tsPid);
      if (t !== undefined) return t;
      this.tsPid = undefined;
    }
    if (now() - this.tsLookedAt < 60_000) return undefined;
    this.tsLookedAt = now();
    try {
      for (const d of this.list(this.proc)) {
        if (!/^\d+$/.test(d)) continue;
        try {
          if (this.read(`${this.proc}/${d}/comm`).trim() === 'tailscaled') {
            this.tsPid = Number(d);
            return this.ticksOf(this.tsPid);
          }
        } catch {
          // Gone while we looked.
        }
      }
    } catch {
      // No /proc.
    }
    return undefined;
  }

  private ticksOf(pid: number): number | undefined {
    try {
      const st = this.read(`${this.proc}/${pid}/stat`);
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      // After "pid (comm) ": state is field 3, so utime (14) and stime (15) are at 11 and 12.
      const ticks = Number(f[11]) + Number(f[12]);
      return Number.isFinite(ticks) ? ticks : undefined;
    } catch {
      return undefined;
    }
  }
}

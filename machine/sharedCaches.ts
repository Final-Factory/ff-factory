import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The machine's shared caches inside the worker install folder (w5281). Before it, every `uv run --with pillow ...` the
 * worker prompt prescribes filled the user's own uv cache (`~/.cache/uv`, 36.9 GB on m5 on 2026-11-23: 64 cached
 * environments, 62 of them older than 14 days, and 19.5 GB of archives), and the game's determinism audits wrote
 * `DeterminismAudit` (5.2 GB) into the game's data folder: both outside the folder, where no agent and no clean-up may delete.
 * The daemon puts these in its own environment (rootEnv), so every agent, editor, player and batch run it starts inherits them.
 */
export const sharedCacheDir = (root: string) => path.join(root, 'cache');
export const workerUvCacheDir = (root: string) => path.join(sharedCacheDir(root), 'uv');
/**
 * Read by the game (FF_DETERMINISM_AUDIT_DIR, NetworkDeterminismAuditRetention.AuditRoot) and the audit scripts in place of
 * `<game data>/DeterminismAudit`. No clean-up pass deletes in it (server/cleanup.ts PROTECTED_SEGMENTS: an `audit` segment is
 * never removed); the game's own retention keeps it to 40 entries and 10 GB.
 */
export const workerDeterminismAuditDir = (root: string) => path.join(sharedCacheDir(root), 'determinism-audit');

/** A normal prune this often; below the soft threshold, this often instead. */
export const UV_PRUNE_EVERY_HOURS = 24;
export const UV_PRUNE_LOW_EVERY_HOURS = 1;
/**
 * `uv cache prune` waits while another uv process reads the cache (its in-use check; never `--force`, which would pull files
 * from under a running `uv run`). A prune still waiting after this is ended and tried again at the next turn.
 */
export const UV_PRUNE_TIMEOUT_MS = 15 * 60_000;

/** Where uv may be when the daemon's PATH (a launchd or service PATH) lacks it: PATH first, then the installers' places. */
export function uvCandidates(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string[] {
  const exe = platform === 'win32' ? 'uv.exe' : 'uv';
  const P = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const onPath = (env[pathKey] ?? '').split(sep).filter(Boolean).map((d) => P.join(d, exe));
  const extra =
    platform === 'win32'
      ? [P.join(home, '.local', 'bin', exe), P.join(home, '.cargo', 'bin', exe), ...(env.LOCALAPPDATA ? [P.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe)] : [])]
      : [P.join(home, '.local', 'bin', exe), P.join(home, '.cargo', 'bin', exe), '/opt/homebrew/bin/uv', '/usr/local/bin/uv', '/usr/bin/uv'];
  return [...new Set([...onPath, ...extra])];
}

export function findUv(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform: NodeJS.Platform = process.platform, exists = (p: string) => fs.existsSync(p)): string | undefined {
  return uvCandidates(env, home, platform).find((p) => exists(p));
}

/** The bytes `uv cache prune` says it removed ("Removed 67 files (527.2KiB)"), 0 when it removed nothing. */
export function prunedBytes(out: string): number {
  const m = /Removed\s+[\d,]+\s+files?\s+\(([\d.]+)\s*([KMGT]?i?B)\)/i.exec(out);
  if (!m) return 0;
  const unit = m[2]!.toUpperCase();
  const pow = ({ B: 0, KIB: 1, KB: 1, MIB: 2, MB: 2, GIB: 3, GB: 3, TIB: 4, TB: 4 } as Record<string, number>)[unit] ?? 0;
  return Math.round(Number(m[1]) * 1024 ** pow);
}

export interface UvPruneDeps {
  dir: string;
  uv(): string | undefined;
  run(uv: string, args: string[], timeoutMs: number): Promise<{ out: string; error?: string }>;
  log(line: string): void;
  now?: () => number;
}

/** One `uv cache prune` of the machine's shared uv cache at a time, daily (hourly while space is low), never blocking a pass. */
export class UvCachePruner {
  private lastAt = 0;
  private running?: Promise<number | undefined>;
  private readonly d: UvPruneDeps;
  constructor(d: UvPruneDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  due(low: boolean): boolean {
    if (this.running) return false;
    const every = (low ? UV_PRUNE_LOW_EVERY_HOURS : UV_PRUNE_EVERY_HOURS) * 3_600_000;
    return this.now() - this.lastAt >= every;
  }

  /** Starts a prune when one is due and returns it (the bytes freed, undefined when it did not run); the caller need not wait. */
  maybe(low: boolean): Promise<number | undefined> | undefined {
    if (!this.due(low)) return undefined;
    this.lastAt = this.now();
    if (!fs.existsSync(this.d.dir)) return undefined;
    const uv = this.d.uv();
    if (!uv) {
      this.d.log(`uv cache prune: no uv found (PATH, ~/.local/bin, ~/.cargo/bin, Homebrew); ${this.d.dir} not pruned`);
      return undefined;
    }
    const p = this.d
      .run(uv, ['cache', 'prune', '--cache-dir', this.d.dir], UV_PRUNE_TIMEOUT_MS)
      .then(({ out, error }) => {
        if (error) {
          this.d.log(`uv cache prune of ${this.d.dir}: ${error.slice(0, 200)}`);
          return undefined;
        }
        const bytes = prunedBytes(out);
        this.d.log(`uv cache prune of ${this.d.dir}: freed ${(bytes / 2 ** 30).toFixed(2)} GB`);
        return bytes;
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = p;
    return p;
  }
}

/** Runs a command with a timeout, low and hidden; the error text when it failed or timed out. */
export function runQuiet(bin: string, args: string[], timeoutMs: number): Promise<{ out: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      const out = `${stdout ?? ''}\n${stderr ?? ''}`;
      if (e) resolve({ out, error: (e as NodeJS.ErrnoException & { killed?: boolean }).killed ? `still waiting after ${Math.round(timeoutMs / 60_000)} min (another uv process holds the cache); tried again next turn` : String(stderr || e.message).trim() });
      else resolve({ out });
    });
  });
}

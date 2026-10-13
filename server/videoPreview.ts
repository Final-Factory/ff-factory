import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Web previews of review videos (docs/review.md, w1248): a small H.264 copy of each clip, at most 1280 px on its long
 * side, with its index at the front (`+faststart`), so the chat's inline player starts at once and streams. Workers'
 * clips are 60 fps captures at 4 to 20 Mbit/s, half of them with the index at the end; the preview is 7 to 14% of
 * the original (measured on 3 review clips, w1248). The original is never touched: the preview is written beside it,
 * `<topic>/.preview/<name>.mp4`, so it goes when its topic folder goes, and one whose original is gone is removed.
 */

/** ffmpeg's arguments for a preview of `input` written to `output`. CRF 26: chosen by measurement (w1248). */
export function previewArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    // At most 1280 px on the long side, never larger than the original, even sizes (H.264 4:2:0 needs them).
    '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-threads', '2',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    '-f', 'mp4', output,
  ];
}

/** Where the preview of `original` lives: `<its folder>/.preview/<its name>.mp4` ("clip.webm" → "clip.webm.mp4"). */
export function previewPathOf(original: string): string {
  return path.join(path.dirname(original), '.preview', `${path.basename(original)}.mp4`);
}

export interface PreviewOptions {
  /** The ffmpeg program. Default "ffmpeg" on PATH; absent there, every request gets the original. */
  ffmpeg?: string;
  /** An encode running longer than this is ended. Default 10 minutes. */
  timeoutMs?: number;
}

export class VideoPreviews {
  private readonly ffmpeg: string;
  private readonly timeoutMs: number;
  /** Encodes in progress or queued, by original path: one per file, one at a time (the portal's CPU is shared). */
  private readonly pending = new Map<string, Promise<string | undefined>>();
  private queue: Promise<unknown> = Promise.resolve();
  /** ffmpeg was not found: stop trying. */
  private missing = false;
  /** Originals whose encode failed: not tried again until the portal restarts. */
  private readonly failed = new Set<string>();

  constructor(o: PreviewOptions = {}) {
    this.ffmpeg = o.ffmpeg ?? 'ffmpeg';
    this.timeoutMs = o.timeoutMs ?? 10 * 60_000;
  }

  /** The preview of `original` when it is made and newer than the original, else undefined. */
  ready(original: string): string | undefined {
    const p = previewPathOf(original);
    const pv = fs.statSync(p, { throwIfNoEntry: false });
    const ov = fs.statSync(original, { throwIfNoEntry: false });
    return pv?.isFile() && ov && pv.size > 0 && pv.mtimeMs >= ov.mtimeMs ? p : undefined;
  }

  /** The preview of `original`, made now if it is not there yet (queued behind other encodes); undefined when it cannot be made. */
  ensure(original: string): Promise<string | undefined> {
    const done = this.ready(original);
    if (done) return Promise.resolve(done);
    if (this.missing || this.failed.has(original)) return Promise.resolve(undefined);
    const running = this.pending.get(original);
    if (running) return running;
    const job = this.queue.then(() => this.make(original)).finally(() => this.pending.delete(original));
    this.queue = job.catch(() => undefined);
    this.pending.set(original, job);
    return job;
  }

  private async make(original: string): Promise<string | undefined> {
    const done = this.ready(original);
    if (done) return done;
    const out = previewPathOf(original);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    this.prune(path.dirname(out));
    const tmp = `${out}.${process.pid}.part`;
    try {
      await this.run(previewArgs(original, tmp));
      fs.renameSync(tmp, out);
      return out;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.missing = true;
        console.warn(`video previews: ${this.ffmpeg} not found; inline videos play their originals`);
      } else {
        this.failed.add(original);
        console.warn(`video preview of ${path.basename(original)} failed: ${(e as Error).message}`);
      }
      return undefined;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  private run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      try {
        if (child.pid) os.setPriority(child.pid, 10); // behind the portal's own work
      } catch {
        // not allowed here: it runs at normal priority
      }
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg ${signal ? `ended by ${signal}` : `exit ${code}`}: ${err.trim().split('\n').pop() ?? ''}`));
      });
    });
  }

  /** Remove previews in `dir` whose original is gone (a person deleted it), and parts an ended portal left. */
  private prune(dir: string) {
    const parent = path.dirname(dir);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
      const originals = new Set(fs.readdirSync(parent));
      for (const n of names) {
        const stale = n.endsWith('.part') ? !this.isOurs(n) : !originals.has(n.replace(/\.mp4$/, ''));
        if (stale) fs.rmSync(path.join(dir, n), { force: true });
      }
    } catch {
      // a folder gone meanwhile
    }
  }

  private isOurs(part: string): boolean {
    return part.endsWith(`.${process.pid}.part`);
  }
}

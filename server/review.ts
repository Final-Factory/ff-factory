import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fmtBytes } from '../shared/attachments.ts';

/**
 * Review media (docs/review.md): the stills, clips and notes workers publish for people to look at, in one folder on
 * the portal's computer, `review.root/<topic>/` (default `<sandboxRoot>/_review`). A worker on this host copies its
 * files there through the portal; a worker on a machine has its daemon send them over HTTP with the machine's own token
 * (PUT /machine/review/<uploadId>, resumable, SHA-256 checked), so no machine ever needs ssh or a share to the portal.
 * Files are written as bytes only, never opened or run, and never overwrite anything: a name already taken in the
 * topic gets "-2", "-3", ….
 */
export interface ReviewConfig {
  /** The folder topics go in. Default `<sandboxRoot>/_review`. */
  root?: string;
  /** The largest file, in MB. Default 200. */
  maxFileMB: number;
  /** The most one call may publish, in MB. Default 500. */
  maxCallMB: number;
  /** The most files one call may publish. Default 40. */
  maxFiles: number;
}

export const REVIEW_DEFAULTS: Omit<ReviewConfig, 'root'> = { maxFileMB: 200, maxCallMB: 500, maxFiles: 40 };

/** What may be published: images, video, notes and data as text, and zips. Decided by the extension. */
export const REVIEW_TYPES = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|m4v|mkv|avi|md|txt|json|zip)$/i;

/** One chunk of a machine's upload: what the daemon sends per PUT, and the most the portal takes in one. */
export const REVIEW_CHUNK = 8 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const UPLOAD_ID = /^rv_[a-f0-9]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** An upload left unfinished this long is dropped (a daemon resumes within minutes, not a day later). */
const UPLOAD_MAX_AGE_MS = 24 * 60 * 60_000;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

export class ReviewError extends Error {
  readonly status: number;
  readonly received?: number;
  constructor(status: number, message: string, received?: number) {
    super(message);
    this.status = status;
    this.received = received;
  }
}

/** One path segment of letters, digits, ".", "_" and "-": anything else becomes "-", and it can never climb out. */
function segment(raw: string, max: number): string {
  return raw
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, max)
    .replace(/[.-]+$/g, '');
}

/** A topic as a folder name ("w283 enemy attacks" → "w283-enemy-attacks"); refused when nothing usable is left. */
export function reviewTopic(topic: unknown): string {
  const t = segment(String(topic ?? ''), 80);
  if (!t || WINDOWS_RESERVED.test(t)) throw new ReviewError(400, `topic: give a short name such as "w283-enemy-attacks" (got ${JSON.stringify(String(topic ?? '')).slice(0, 60)})`);
  return t;
}

/** A file's name in its topic: its base name only, made safe; refused when its type may not be published. */
export function reviewName(name: unknown): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const ext = /\.[A-Za-z0-9]+$/.exec(base)?.[0] ?? '';
  const stem = segment(base.slice(0, base.length - ext.length), 100) || 'file';
  const out = `${WINDOWS_RESERVED.test(stem) ? `_${stem}` : stem}${ext.toLowerCase()}`;
  if (!REVIEW_TYPES.test(out)) throw new ReviewError(415, `${JSON.stringify(base).slice(0, 80)}: only images, video, .md/.txt/.json and .zip may be published`);
  return out;
}

/** "clip.mp4", "clip-2.mp4", "clip-3.mp4", … */
export function nthName(name: string, n: number): string {
  if (n <= 1) return name;
  const ext = /\.[A-Za-z0-9]+$/.exec(name)?.[0] ?? '';
  return `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
}

interface Upload {
  uploadId: string;
  machineId: string;
  topic: string;
  name: string;
  size: number;
  sha256: string;
  createdAt: number;
}

export interface PlannedFile {
  name: unknown;
  size: unknown;
  sha256: unknown;
}

export class ReviewStore {
  private readonly config: () => ReviewConfig & { root: string };
  private readonly now: () => number;
  private readonly uploads = new Map<string, Upload>();
  /** Uploads with a chunk being written: one writer per upload. */
  private readonly writing = new Set<string>();

  constructor(config: () => ReviewConfig & { root: string }, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  get root(): string {
    return path.resolve(this.config().root);
  }

  private get partialDir(): string {
    return path.join(this.root, '.uploads');
  }

  /** Whether `file` is inside the review folder (the page may show it to anyone who may see review media). */
  contains(file: string): boolean {
    const r = this.root.toLowerCase();
    const f = path.resolve(file).toLowerCase();
    return f.startsWith(r + path.sep) && !f.slice(r.length + 1).startsWith('.uploads');
  }

  /** Check a call's files against the caps; returns the safe topic and names. */
  private check(topic: unknown, files: { name: unknown; size: number }[]): { topic: string; names: string[] } {
    const c = { ...REVIEW_DEFAULTS, ...this.config() };
    const t = reviewTopic(topic);
    if (!files.length) throw new ReviewError(400, 'files: give at least one file');
    if (files.length > c.maxFiles) throw new ReviewError(413, `${files.length} files in one call; the limit is ${c.maxFiles} (config review.maxFiles)`);
    const names = files.map((f) => reviewName(f.name));
    let total = 0;
    for (const [i, f] of files.entries()) {
      if (!Number.isSafeInteger(f.size) || f.size <= 0) throw new ReviewError(400, `${names[i]}: empty, or its size is not a whole number of bytes`);
      if (f.size > c.maxFileMB * 1024 * 1024) throw new ReviewError(413, `${names[i]} is ${fmtBytes(f.size)}; the limit per file is ${fmtBytes(c.maxFileMB * 1024 * 1024)} (config review.maxFileMB)`);
      total += f.size;
    }
    if (total > c.maxCallMB * 1024 * 1024) throw new ReviewError(413, `${fmtBytes(total)} in one call; the limit is ${fmtBytes(c.maxCallMB * 1024 * 1024)} (config review.maxCallMB). Publish in smaller calls.`);
    return { topic: t, names };
  }

  // ---------------------------------------------------------------- a machine's daemon sends them

  /** A machine's publish_review: check the call, and give its daemon one upload per file to send (PUT /machine/review/<id>). */
  plan(machineId: string, input: { topic: unknown; files: unknown }): { topic: string; uploads: { uploadId: string; name: string; size: number; chunkBytes: number }[] } {
    this.expire();
    const raw = Array.isArray(input.files) ? (input.files as PlannedFile[]) : [];
    const files = raw.map((f) => ({ name: f?.name, size: Number(f?.size), sha256: String(f?.sha256 ?? '').toLowerCase() }));
    const { topic, names } = this.check(input.topic, files);
    for (const [i, f] of files.entries()) if (!SHA256.test(f.sha256)) throw new ReviewError(400, `${names[i]}: sha256 must be 64 hex digits`);
    fs.mkdirSync(this.partialDir, { recursive: true });
    const uploads = files.map((f, i) => {
      const u: Upload = { uploadId: `rv_${randomBytes(12).toString('hex')}`, machineId, topic, name: names[i], size: f.size, sha256: f.sha256, createdAt: this.now() };
      fs.writeFileSync(this.partPath(u.uploadId), '');
      this.uploads.set(u.uploadId, u);
      return { uploadId: u.uploadId, name: u.name, size: u.size, chunkBytes: REVIEW_CHUNK };
    });
    return { topic, uploads };
  }

  /** How far a machine's upload got (where its daemon resumes). */
  status(machineId: string, uploadId: string): { received: number; size: number } {
    const u = this.upload(machineId, uploadId);
    return { received: this.received(u.uploadId), size: u.size };
  }

  /**
   * One chunk of a machine's upload, at `offset` (which must be where it stands). The last one checks size and SHA-256
   * and puts the file in its topic; a mismatch drops the upload (the daemon plans the file again).
   */
  async append(machineId: string, uploadId: string, offset: number, body: AsyncIterable<Buffer | string> | Iterable<Buffer | string>): Promise<{ received: number; size: number; path?: string }> {
    const u = this.upload(machineId, uploadId);
    if (this.writing.has(uploadId)) throw new ReviewError(409, 'a chunk of this upload is still being written', this.received(uploadId));
    this.writing.add(uploadId);
    try {
      const have = this.received(uploadId);
      if (offset !== have) throw new ReviewError(409, `resume at ${have}`, have);
      const fd = fs.openSync(this.partPath(uploadId), 'a');
      let got = 0;
      try {
        for await (const c of body) {
          const b = typeof c === 'string' ? Buffer.from(c) : c;
          got += b.length;
          if (got > MAX_CHUNK || have + got > u.size) {
            fs.closeSync(fd);
            fs.truncateSync(this.partPath(uploadId), have);
            throw new ReviewError(413, got > MAX_CHUNK ? `a chunk is at most ${fmtBytes(MAX_CHUNK)}` : `more than the ${u.size} bytes announced`, have);
          }
          fs.writeSync(fd, b);
        }
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // closed above
        }
      }
      const received = have + got;
      if (received < u.size) return { received, size: u.size };
      const sha = await sha256Of(this.partPath(uploadId));
      if (sha !== u.sha256) {
        this.drop(uploadId);
        throw new ReviewError(422, `${u.name} arrived damaged (sha256 ${sha.slice(0, 12)}…, expected ${u.sha256.slice(0, 12)}…); publish it again`);
      }
      const dest = this.place(u.topic, u.name, (to) => fs.linkSync(this.partPath(uploadId), to));
      this.drop(uploadId);
      return { received, size: u.size, path: dest };
    } finally {
      this.writing.delete(uploadId);
    }
  }

  // ---------------------------------------------------------------- a worker on this host

  /** A worker on this host: copy its files into the topic. Returns where each went. */
  async publishLocal(input: { topic: unknown; files: string[] }): Promise<{ topic: string; files: { from: string; path: string; size: number; sha256: string }[] }> {
    const stats = input.files.map((f) => {
      const st = fs.statSync(f, { throwIfNoEntry: false });
      if (!st?.isFile()) throw new ReviewError(404, `${f}: no such file`);
      return { from: f, size: st.size };
    });
    const { topic, names } = this.check(input.topic, stats.map((s) => ({ name: s.from, size: s.size })));
    const out: { from: string; path: string; size: number; sha256: string }[] = [];
    for (const [i, s] of stats.entries()) {
      const p = this.place(topic, names[i], (to) => fs.copyFileSync(s.from, to, fs.constants.COPYFILE_EXCL));
      out.push({ from: s.from, path: p, size: s.size, sha256: await sha256Of(p) });
    }
    return { topic, files: out };
  }

  /** A note beside the files (`note.md`, `note-2.md`, …): who published what, and their words. */
  writeNote(topic: string, by: string, note: string, files: string[]): string {
    const text = `# ${topic}\n\nPublished ${new Date(this.now()).toISOString()} by ${by}.\n\n${note.trim()}\n\n${files.map((f) => `- ${path.basename(f)}`).join('\n')}\n`;
    const tmp = path.join(this.partialDir, `note-${randomBytes(6).toString('hex')}.md`);
    fs.mkdirSync(this.partialDir, { recursive: true });
    fs.writeFileSync(tmp, text);
    try {
      return this.place(reviewTopic(topic), 'note.md', (to) => fs.linkSync(tmp, to));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // ---------------------------------------------------------------- inside

  /** Put a file in `<root>/<topic>/` under `name` or the first free "-n" variant; `write` must fail when `to` exists. */
  private place(topic: string, name: string, write: (to: string) => void): string {
    const dir = path.join(this.root, reviewTopic(topic));
    // Belt and braces: whatever the names, the file stays in its topic folder under the root.
    if (path.dirname(dir) !== this.root) throw new ReviewError(400, 'topic: not a folder name');
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 1; n < 1000; n++) {
      const to = path.join(dir, nthName(reviewName(name), n));
      if (path.dirname(to) !== dir) throw new ReviewError(400, 'name: not a file name');
      try {
        write(to);
        return to;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    throw new ReviewError(409, `${name}: 999 files of that name already in ${topic}`);
  }

  private upload(machineId: string, uploadId: string): Upload {
    const u = UPLOAD_ID.test(uploadId) ? this.uploads.get(uploadId) : undefined;
    if (!u || u.machineId !== machineId) throw new ReviewError(404, 'no such upload for this machine (finished, expired, or the portal restarted: publish again)');
    return u;
  }

  private partPath(uploadId: string) {
    return path.join(this.partialDir, `${uploadId}.part`);
  }

  private received(uploadId: string): number {
    return fs.statSync(this.partPath(uploadId), { throwIfNoEntry: false })?.size ?? 0;
  }

  private drop(uploadId: string) {
    this.uploads.delete(uploadId);
    fs.rmSync(this.partPath(uploadId), { force: true });
  }

  private expire() {
    for (const u of this.uploads.values()) if (this.now() - u.createdAt > UPLOAD_MAX_AGE_MS && !this.writing.has(u.uploadId)) this.drop(u.uploadId);
  }
}

export async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of fs.createReadStream(file)) h.update(c as Buffer);
  return h.digest('hex');
}

/**
 * PUT /machine/review/<uploadId>?offset=N (a chunk) and GET (where to resume), for a machine's daemon with its own
 * token. `machineId`: the machine the token proved, or undefined. Answers JSON.
 */
export async function reviewHttp(store: ReviewStore, machineId: string | undefined, req: IncomingMessage, res: ServerResponse, uploadId: string, offset: number) {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    if (!machineId) return reply(401, { error: 'a machine token is required' });
    if (req.method === 'GET') return reply(200, store.status(machineId, uploadId));
    if (req.method !== 'PUT') return reply(405, { error: 'GET or PUT' });
    return reply(200, await store.append(machineId, uploadId, offset, req));
  } catch (e) {
    const r = e instanceof ReviewError ? e : new ReviewError(500, (e as Error).message);
    if (req.method === 'PUT' && !req.readableEnded) req.resume();
    return reply(r.status, { error: r.message, ...(r.received === undefined ? {} : { received: r.received }) });
  }
}

/** What a publish_review call answers: the paths on the portal's computer, ready to put in a report. */
export function publishedText(host: string, files: { path: string; size: number; sha256: string }[], note?: string): string {
  const lines = files.map((f) => `- ${f.path} (${fmtBytes(f.size)}, sha256 ${f.sha256.slice(0, 12)}…)`);
  const image = files.find((f) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.path));
  return [
    `Published ${files.length} file(s) on ${host}:`,
    ...lines,
    ...(note ? [`- ${note} (the note)`] : []),
    `Put these paths in your report as they are${image ? `; an image shows inline as ![what it shows](${image.path})` : ''}. They are on ${host}, not on this computer.`,
  ].join('\n');
}

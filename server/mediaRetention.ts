// Media retention (w2268, asked by lothsahn: "delete pictures and videos from transcripts older than 14 days"). The portal's
// hourly clean-up (index.ts, the host's CleanupRunner pass) deletes the pictures and videos of conversations idle for
// cleanup.mediaDays (default 14) from the two places the portal keeps them, and nothing else:
//
//   data/uploads/<session>/<id>.<ext>   the images a chat shows (a person's, a tool's, the copies of a reply's images,
//                                       store.ts saveImage, inlineImages.ts); served at /api/uploads/<session>/<id>;
//   <review root>/<topic>/<file>        published review stills and clips (review.ts), with their web previews in
//                                       <topic>/.preview/<file>.mp4 (videoPreview.ts); served at /api/image?path=.
//
// The transcript text, its .jsonl files, notes, logs, the ledger and attachments (download-only files with their own
// 30-day retention, attachments.ts) stay. Each folder that lost media keeps a tombstone (TOMBSTONE): the routes answer
// a removed picture with a placeholder still and a removed video with 410 and the reason, so the page shows
// "[image removed after 14 days]" where the picture was, never a broken image.
//
// The age: a worker's picture counts from the later of its own time and its conversation's last activity, so a
// transcript's media go together once the transcript is idle that long. An orchestrator's, the ops worker's or a
// standing agent's chat never goes idle, so there a picture counts from its own time. A review file counts from its own
// time (when it was published). Kept whatever their age: the media of a session that runs now, waits on a person
// (waitingOn, openAsks) or serves an open or stalled request; a review topic named for an open or stalled request
// (wNNN-...); and any file whose name an open request, a pending question or a waiting card mentions.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WORK_OPEN, type MediaSummary, type MediaTally, type SessionInfo, type WorkItem } from '../shared/types.ts';
import type { CleanupRun } from './cleanup.ts';
export type { MediaSummary, MediaTally };

/** The pictures (PNG, JPG, GIF, WebP, SVG) and videos (MP4, M4V, WebM, MOV) the rule removes. */
export const MEDIA_FILE = /\.(png|jpe?g|gif|webp|svg|mp4|m4v|webm|mov)$/i;
export const VIDEO_FILE = /\.(mp4|m4v|webm|mov)$/i;
/** Beside the files a folder lost: their names, when and after how many days. */
export const TOMBSTONE = '.media-removed.json';
export const MEDIA_RULE = 'media';

const DAY = 86_400_000;

export type Tombstone = Record<string, { at: string; days: number; bytes: number }>;

export interface MediaRun {
  /** One line per folder: what it lost and why. */
  removed: { path: string; bytes: number; rule: string; why: string }[];
  failed: { path: string; why: string }[];
  bytes: number;
  summary: MediaSummary;
}

type SessionLike = Pick<SessionInfo, 'id' | 'kind' | 'status' | 'lastActivityAt' | 'waitingOn' | 'openAsks'>;
type WorkLike = Pick<WorkItem, 'id' | 'status' | 'sessionIds'>;

const LIVE = new Set(['running', 'starting', 'waiting_permission']);
const isOpen = (w: WorkLike) => WORK_OPEN.includes(w.status) || w.status === 'stalled';

export interface MediaHolds {
  /** Sessions whose media stay whole. */
  sessions: Set<string>;
  /** Open or stalled request ids, lower case: their review topics stay whole. */
  requests: Set<string>;
  /** Everything open requests and pending questions say, with / for \: a file named here stays. */
  text: string;
}

/** What keeps media whatever its age, from the sessions and the ledger. */
export function mediaHolds(sessions: Iterable<SessionLike>, work: Iterable<WorkLike>): MediaHolds {
  const held = new Set<string>();
  const requests = new Set<string>();
  const text: string[] = [];
  for (const w of work) {
    if (!isOpen(w)) continue;
    requests.add(w.id.toLowerCase());
    for (const s of w.sessionIds ?? []) held.add(s);
    text.push(JSON.stringify(w));
  }
  for (const s of sessions) {
    if (LIVE.has(s.status) || s.waitingOn || s.openAsks?.length) held.add(s.id);
    if (s.waitingOn) text.push(JSON.stringify(s.waitingOn));
    if (s.openAsks?.length) text.push(JSON.stringify(s.openAsks));
  }
  return { sessions: held, requests, text: text.join('\n').replace(/\\\\|\\/g, '/') };
}

/** The request a review topic is named for (`w2268-retention` → w2268), or undefined. */
export const topicRequest = (topic: string) => /^(w\d+)(?=$|[-_. ])/i.exec(topic)?.[1].toLowerCase();

async function list(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function stat(p: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.lstat(p);
  } catch {
    return undefined;
  }
}

export function readTombstone(dir: string): Tombstone {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(dir, TOMBSTONE), 'utf8'));
    return t && typeof t === 'object' && !Array.isArray(t) ? (t as Tombstone) : {};
  } catch {
    return {};
  }
}

function writeTombstone(dir: string, add: Tombstone) {
  const t = { ...readTombstone(dir), ...add };
  const tmp = path.join(dir, `${TOMBSTONE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(t));
  fs.renameSync(tmp, path.join(dir, TOMBSTONE));
}

/** Whether `file` was removed by this rule: its tombstone entry, or undefined (never there, or gone some other way). */
export function removedMedia(file: string): Tombstone[string] | undefined {
  if (fs.existsSync(file)) return undefined;
  return readTombstone(path.dirname(file))[path.basename(file)];
}

/** An upload removed by this rule, by its id (the file name without its extension). */
export function removedUpload(sessionDir: string, id: string): Tombstone[string] | undefined {
  const t = readTombstone(sessionDir);
  const name = Object.keys(t).find((n) => n.slice(0, n.lastIndexOf('.')) === id);
  return name && !fs.existsSync(path.join(sessionDir, name)) ? t[name] : undefined;
}

/** What the page shows instead: "[image removed after 14 days]". */
export const removedText = (file: string, days: number) => `[${VIDEO_FILE.test(file) ? 'video' : 'image'} removed after ${days} day${days === 1 ? '' : 's'}]`;

/** The still served in a removed picture's place: the same words, so every view that showed it shows them instead. */
export function placeholderSvg(days: number): Buffer {
  const text = removedText('x.png', days);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="56" viewBox="0 0 320 56"><title>${text}</title><rect x="1" y="1" width="318" height="54" rx="6" fill="#23262b" stroke="#5a5f68" stroke-dasharray="5 4"/><text x="160" y="33" font-family="system-ui, sans-serif" font-size="14" fill="#a8adb5" text-anchor="middle">${text}</text></svg>`,
  );
}

interface Candidate {
  file: string;
  bytes: number;
  /** Extra files that go with it (a video's web preview). */
  with: { file: string; bytes: number }[];
}

const add = (t: MediaTally, bytes: number) => {
  t.files++;
  t.bytes += bytes;
};

/**
 * One pass over the uploads and the review folder: plan, and unless `dryRun` remove, with a tombstone per folder. Deletes
 * only media files (MEDIA_FILE) directly inside `<uploadDir>/<session>/` and `<reviewRoot>/<topic>/` (and that topic's
 * `.preview/`), never a link, a folder or anything else.
 */
export async function runMediaRetention(o: {
  uploadDir: string;
  reviewRoot: string;
  days: number;
  sessions: Iterable<SessionLike>;
  work: Iterable<WorkLike>;
  now?: number;
  dryRun?: boolean;
}): Promise<MediaRun> {
  const now = o.now ?? Date.now();
  const days = o.days;
  const summary: MediaSummary = { days, removedFiles: 0, freedBytes: 0, inventory: { uploads: { files: 0, bytes: 0 }, review: { files: 0, bytes: 0 } }, keptReferenced: { files: 0, bytes: 0 }, keptYoung: { files: 0, bytes: 0 }, ...(o.dryRun ? { dryRun: true } : {}) };
  const run: MediaRun = { removed: [], failed: [], bytes: 0, summary };
  if (!(days > 0)) return run;
  const cutoff = now - days * DAY;
  const sessions = new Map([...o.sessions].map((s) => [s.id, s]));
  const holds = mediaHolds(sessions.values(), o.work);
  // A whole name only: "a" in "a.png" must not match every "a" in a question.
  const named = (s: string) => new RegExp(`(?<![\\w-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(holds.text);

  const take = async (dir: string, label: string, picked: Candidate[]) => {
    if (!picked.length) return;
    let bytes = 0;
    let files = 0;
    let videos = 0;
    const gone: Tombstone = {};
    const at = new Date(now).toISOString();
    for (const c of picked) {
      try {
        if (!o.dryRun) {
          for (const w of c.with) fs.rmSync(w.file, { force: true });
          fs.rmSync(c.file, { force: true });
          gone[path.basename(c.file)] = { at, days, bytes: c.bytes };
        }
        const b = c.bytes + c.with.reduce((n, w) => n + w.bytes, 0);
        bytes += b;
        files += 1 + c.with.length;
        if (VIDEO_FILE.test(c.file)) videos++;
      } catch (e) {
        run.failed.push({ path: c.file, why: (e as Error).message });
      }
    }
    if (Object.keys(gone).length) {
      try {
        writeTombstone(dir, gone);
      } catch (e) {
        run.failed.push({ path: path.join(dir, TOMBSTONE), why: (e as Error).message });
      }
    }
    if (!files) return;
    const pictures = picked.length - videos;
    run.removed.push({ path: dir, bytes, rule: MEDIA_RULE, why: `${label}: ${[pictures ? `${pictures} picture(s)` : '', videos ? `${videos} video(s)` : ''].filter(Boolean).join(', ')}${files > picked.length ? ` and ${files - picked.length} preview(s)` : ''}, idle over ${days} days` });
    run.bytes += bytes;
    summary.removedFiles += files;
    summary.freedBytes += bytes;
  };

  // data/uploads/<session>/<id>.<ext>
  for (const d of await list(o.uploadDir)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(o.uploadDir, d.name);
    const s = sessions.get(d.name);
    const whole = holds.sessions.has(d.name);
    // A worker's transcript is idle from its last activity; a chat that never goes idle counts each picture from its own time.
    const idleFrom = s && s.kind === 'worker' ? Date.parse(s.lastActivityAt) || 0 : 0;
    const picked: Candidate[] = [];
    for (const f of await list(dir)) {
      if (!f.isFile() || !MEDIA_FILE.test(f.name)) continue;
      const st = await stat(path.join(dir, f.name));
      if (!st?.isFile()) continue;
      add(summary.inventory.uploads, st.size);
      if (Math.max(st.mtimeMs, idleFrom) > cutoff) add(summary.keptYoung, st.size);
      else if (whole || named(f.name.slice(0, f.name.lastIndexOf('.')))) add(summary.keptReferenced, st.size);
      else picked.push({ file: path.join(dir, f.name), bytes: st.size, with: [] });
    }
    await take(dir, `uploads of session ${d.name}`, picked);
  }

  // <review root>/<topic>/<file>, its previews in <topic>/.preview/
  for (const d of await list(o.reviewRoot)) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const dir = path.join(o.reviewRoot, d.name);
    const req = topicRequest(d.name);
    const whole = !!req && holds.requests.has(req);
    const previewDir = path.join(dir, '.preview');
    const previews = new Map<string, number>();
    for (const p of await list(previewDir)) {
      const st = p.isFile() ? await stat(path.join(previewDir, p.name)) : undefined;
      if (st?.isFile()) previews.set(p.name, st.size);
    }
    const originals = new Set<string>();
    const picked: Candidate[] = [];
    for (const f of await list(dir)) {
      if (!f.isFile() || !MEDIA_FILE.test(f.name)) continue;
      const st = await stat(path.join(dir, f.name));
      if (!st?.isFile()) continue;
      originals.add(f.name);
      const pv = previews.get(`${f.name}.mp4`);
      const size = st.size + (pv ?? 0);
      add(summary.inventory.review, size);
      if (st.mtimeMs > cutoff) add(summary.keptYoung, size);
      else if (whole || named(`${d.name}/${f.name}`)) add(summary.keptReferenced, size);
      else picked.push({ file: path.join(dir, f.name), bytes: st.size, with: pv === undefined ? [] : [{ file: path.join(previewDir, `${f.name}.mp4`), bytes: pv }] });
    }
    // A preview whose original is gone already (removed by a person): it is a video copy nobody can reach.
    for (const [name, bytes] of previews) {
      if (!name.endsWith('.mp4') || originals.has(name.slice(0, -4))) continue;
      const st = await stat(path.join(previewDir, name));
      if (!st) continue;
      add(summary.inventory.review, bytes);
      if (st.mtimeMs > cutoff) {
        add(summary.keptYoung, bytes);
        continue;
      }
      try {
        if (!o.dryRun) fs.rmSync(path.join(previewDir, name), { force: true });
        run.removed.push({ path: path.join(previewDir, name), bytes, rule: MEDIA_RULE, why: `review ${d.name}: a preview whose original is gone, over ${days} days old` });
        run.bytes += bytes;
        summary.removedFiles++;
        summary.freedBytes += bytes;
      } catch (e) {
        run.failed.push({ path: path.join(previewDir, name), why: (e as Error).message });
      }
    }
    await take(dir, `review ${d.name}`, picked);
  }
  return run;
}

/** The host's clean-up pass with the media pass folded in: its removals, bytes and failures, its plan on a dry run. */
export function withMedia(r: CleanupRun, m: MediaRun, dryRun?: boolean): CleanupRun {
  const items = m.removed;
  return {
    ...r,
    removed: dryRun ? r.removed : [...r.removed, ...items],
    bytes: dryRun ? r.bytes : r.bytes + m.bytes,
    failed: [...r.failed, ...m.failed],
    ...(dryRun && items.length ? { planned: [...(r.planned ?? []), ...items] } : {}),
    media: m.summary,
  };
}

/** The pass's line in the clean-up log readout (portal_logs cleanup). */
export function describeMedia(m: MediaSummary): string {
  const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);
  const t = (x: MediaTally) => `${x.files} file(s) ${mb(x.bytes)}`;
  return `media retention (${m.days} days)${m.dryRun ? ', dry run' : ''}: ${m.dryRun ? 'would remove' : 'removed'} ${m.removedFiles} picture/video file(s), ${mb(m.freedBytes)} freed; kept ${t(m.keptReferenced)} still referenced, ${t(m.keptYoung)} newer; before: uploads ${t(m.inventory.uploads)}, review ${t(m.inventory.review)}`;
}

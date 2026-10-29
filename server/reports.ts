import fs from 'node:fs';
import path from 'node:path';
import { readJsonDurable, writeFileDurable, writeJsonDurable, isObject } from './durable.ts';
import { redactValue } from './secrets.ts';
import { localPath, MD_IMAGE } from '../shared/imagePaths.ts';
import { REPORT_KINDS, type AttachmentRef, type Report, type ReportHit, type ReportKind, type ReportRevision, type ReportSummary, type Requester } from '../shared/types.ts';

/**
 * Reports (w2541, docs/reports.md): the written result of a design, an analysis, a profile, an investigation or research
 * a person asked for, kept beside the ledger in `<dataDir>/reports/`:
 *
 *   reports/seq.json            the last number given out, so an id is never given twice
 *   reports/r12/report.json     what the list shows: title, kind, request, its operators, times, revisions, attachments
 *   reports/r12/rev-1.md        the text of each revision, written once and never rewritten (a revision adds a file)
 *   reports/r12/media/…         copies of the stills and clips its text shows, taken from review media when it is filed:
 *                               review media is deleted after 14 days (server/mediaRetention.ts), a report is kept
 *
 * Every summary and latest text is held in memory: a few hundred reports of tens of kB each is a few MB, and search
 * reads them all.
 */

export const REPORT_ID = /^r[1-9][0-9]{0,6}$/;
/** The longest text one revision may have. */
export const MAX_REPORT_BODY = 400_000;
const MAX_TITLE = 200;
const MAX_NOTE = 500;
/** The most media files one revision may bring in, and the largest one (review media's own cap). */
const MAX_MEDIA_FILES = 40;
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const EXCERPT = 220;
const SNIPPET = 200;

export class ReportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ReportFile extends Omit<ReportSummary, 'revisions' | 'excerpt'> {
  history: ReportRevision[];
  /** Source path (lowercase) → the name of its copy in media/, so a revision that shows the same file reuses it. */
  media: Record<string, string>;
}

/** What a worker files: a new report, or a revision of one (`id`). */
export interface FileReportInput {
  id?: string;
  title: string;
  kind: string;
  body: string;
  note?: string;
  attachments?: AttachmentRef[];
}

/** The request a report is filed for, as the ledger has it. */
export interface ReportWork {
  id: string;
  title: string;
  requesters: Requester[];
}

export interface ReportFilter {
  query?: string;
  kind?: string;
  request?: string;
  /** An operator's user id or display name, any case. */
  person?: string;
  /** ISO dates or times: updated at or after `since`, at or before `until` (a bare date takes in its whole day). */
  since?: string;
  until?: string;
}

/** The result of a filing: the report, and the media it could not keep (a path outside review media). */
export interface FiledReport {
  report: ReportSummary;
  rev: number;
  notKept: string[];
  created: boolean;
}

/** A segment safe as a file name: letters, digits, ".", "_" and "-". */
const safeName = (raw: string) =>
  raw
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 100) || 'file';

/** Plain text from Markdown, roughly: for the excerpt and the snippets, never shown as Markdown. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(MD_IMAGE, ' ')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    // A table's rule line (|---|:--:|) goes; emphasis markers go without a gap ("**Left first**," reads "Left first,").
    .replace(/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/[*`~]+/g, '')
    .replace(/(^|\W)_+|_+(?=\W|$)/g, '$1')
    .replace(/[#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const words = (q: string) =>
  q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);

/** A bare date ("2026-10-29") as the end of its day; anything else as given. undefined when it is no date. */
function bound(v: string | undefined, end: boolean): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) && end ? `${v}T23:59:59.999Z` : v);
  return Number.isFinite(t) ? t : undefined;
}

export const isReportKind = (k: string): k is ReportKind => (REPORT_KINDS as readonly string[]).includes(k);

export class ReportStore {
  readonly root: string;
  private seq = 0;
  private readonly files = new Map<string, ReportFile>();
  private readonly bodies = new Map<string, string>();

  /**
   * `mediaRoots`: the folders a report may copy stills and clips from (review media's root). A path anywhere else in the
   * text is left as written and named back to the worker: the portal serves no other folder of a machine.
   */
  private readonly mediaRoots: () => string[];
  private readonly now: () => Date;

  constructor(dataDir: string, mediaRoots: () => string[] = () => [], now: () => Date = () => new Date()) {
    this.mediaRoots = mediaRoots;
    this.now = now;
    this.root = path.join(dataDir, 'reports');
    fs.mkdirSync(this.root, { recursive: true });
    this.seq = readJsonDurable<{ seq: number }>(path.join(this.root, 'seq.json'), { check: (v) => (isObject(v) && typeof v.seq === 'number' ? undefined : 'not a report counter') })?.seq ?? 0;
    for (const d of fs.readdirSync(this.root)) {
      if (!REPORT_ID.test(d)) continue;
      const f = readJsonDurable<ReportFile>(path.join(this.root, d, 'report.json'), { check: (v) => (isObject(v) && v.id === d && Array.isArray(v.history) ? undefined : 'not a report') });
      if (!f || !f.history.length) continue;
      const last = f.history.at(-1)!.n;
      let body = '';
      try {
        body = fs.readFileSync(path.join(this.root, d, `rev-${last}.md`), 'utf8');
      } catch (e) {
        console.warn(`reports: ${d} revision ${last} is unreadable: ${(e as Error).message}`);
      }
      f.media ??= {};
      f.attachments ??= [];
      this.files.set(d, f);
      this.bodies.set(d, body);
      this.seq = Math.max(this.seq, Number(d.slice(1)));
    }
  }

  private dir = (id: string) => path.join(this.root, id);

  private summary(f: ReportFile): ReportSummary {
    const { history, media: _media, ...rest } = f;
    const text = plainText(this.bodies.get(f.id) ?? '');
    return { ...rest, revisions: history.length, excerpt: text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text };
  }

  /** Every report, newest first. */
  all(): ReportSummary[] {
    return [...this.files.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || Number(b.id.slice(1)) - Number(a.id.slice(1))).map((f) => this.summary(f));
  }

  /** The reports of one request, oldest first. */
  forWork(workId: string): ReportSummary[] {
    return this.all()
      .filter((r) => r.workId === workId)
      .reverse();
  }

  /** The attachment ids reports hold: kept as long as the report (AttachmentStore's prune keeps them). */
  attachmentIds(): Set<string> {
    return new Set([...this.files.values()].flatMap((f) => f.attachments.map((a) => a.id)));
  }

  /** A report with the latest text, or revision `rev`. undefined when there is no such report or revision. */
  get(id: string, rev?: number): Report | undefined {
    const f = this.files.get(id);
    if (!f) return undefined;
    const n = rev ?? f.history.at(-1)!.n;
    if (!f.history.some((h) => h.n === n)) return undefined;
    let body = this.bodies.get(id) ?? '';
    if (n !== f.history.at(-1)!.n) {
      try {
        body = fs.readFileSync(path.join(this.dir(id), `rev-${n}.md`), 'utf8');
      } catch {
        return undefined;
      }
    }
    return { ...this.summary(f), body, rev: n, history: f.history };
  }

  /** The file behind /api/reports/<id>/media/<name>, or undefined. */
  mediaFile(id: string, name: string): string | undefined {
    if (!this.files.has(id) || name !== safeName(name)) return undefined;
    const file = path.join(this.dir(id), 'media', name);
    return fs.existsSync(file) ? file : undefined;
  }

  /** The reports `filter` picks, newest first; `query` matches every word in its title, text, kind, request or operators. */
  list(filter: ReportFilter = {}): ReportSummary[] {
    return this.search(filter).map((h) => h.report);
  }

  /** The same, each with the words around its first match in the text (or its excerpt). */
  search(filter: ReportFilter = {}): ReportHit[] {
    const q = words(filter.query ?? '');
    const person = filter.person?.trim().toLowerCase();
    const since = bound(filter.since, false);
    const until = bound(filter.until, true);
    const out: ReportHit[] = [];
    for (const r of this.all()) {
      if (filter.kind && r.kind !== filter.kind) continue;
      if (filter.request && r.workId !== filter.request) continue;
      if (person && !r.requesters.some((p) => p.userId.toLowerCase() === person || p.displayName.toLowerCase() === person)) continue;
      const t = Date.parse(r.updatedAt);
      if (since !== undefined && t < since) continue;
      if (until !== undefined && t > until) continue;
      const text = plainText(this.bodies.get(r.id) ?? '');
      if (q.length) {
        const hay = [r.id, r.title, r.kind, r.workId, r.workTitle, ...r.requesters.map((p) => `${p.displayName} ${p.userId}`), text].join('\n').toLowerCase();
        if (!q.every((w) => hay.includes(w))) continue;
      }
      out.push({ report: r, snippet: snippet(text, q) || r.excerpt });
    }
    return out;
  }

  /**
   * File a new report for `work`, or revise one of its reports (`input.id`). The text keeps every word as written (its
   * evidence labels too); secrets are redacted and stills and clips under review media are copied in, their paths
   * rewritten to the report's own. Throws ReportError.
   */
  file(input: FileReportInput, work: ReportWork, sessionId: string | undefined): FiledReport {
    const title = redactValue(String(input.title ?? '').trim()).slice(0, MAX_TITLE);
    const kind = String(input.kind ?? '').trim();
    const raw = String(input.body ?? '');
    if (!title) throw new ReportError(400, 'A report needs a title: what it is about, in a few words.');
    if (!isReportKind(kind)) throw new ReportError(400, `kind must be one of ${REPORT_KINDS.join(', ')}.`);
    if (!raw.trim()) throw new ReportError(400, 'A report needs its text (body, Markdown).');
    if (raw.length > MAX_REPORT_BODY) throw new ReportError(413, `The text is ${raw.length} characters; a report holds at most ${MAX_REPORT_BODY}. Put long data in an attachment.`);
    const note = input.note ? redactValue(String(input.note).trim()).slice(0, MAX_NOTE) : undefined;
    const at = this.now().toISOString();
    let f: ReportFile;
    let created = false;
    if (input.id) {
      const old = this.files.get(input.id);
      if (!old) throw new ReportError(404, `There is no report ${input.id}.`);
      if (old.workId !== work.id) throw new ReportError(403, `${input.id} is ${old.workId}'s report; a worker revises only its own request's reports.`);
      f = { ...old, history: [...old.history], media: { ...old.media }, attachments: [...old.attachments] };
    } else {
      const id = `r${this.seq + 1}`;
      f = { id, title, kind, workId: work.id, workTitle: work.title, requesters: work.requesters.map((r) => ({ userId: r.userId, displayName: r.displayName })), createdAt: at, updatedAt: at, history: [], media: {}, attachments: [] };
      created = true;
    }
    const dir = this.dir(f.id);
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    if (created) {
      this.seq = Number(f.id.slice(1));
      writeJsonDurable(path.join(this.root, 'seq.json'), { seq: this.seq });
    }
    const { body, notKept } = this.keepMedia(f, redactValue(raw));
    const n = (f.history.at(-1)?.n ?? 0) + 1;
    writeFileDurable(path.join(dir, `rev-${n}.md`), body, { generations: 0 });
    f.title = title;
    f.kind = kind;
    f.updatedAt = at;
    f.sessionId = sessionId;
    f.workTitle = work.title;
    // The operators of the request now: one added later (a merge, a +1) is an operator of its report too.
    for (const r of work.requesters) if (!f.requesters.some((p) => p.userId.toLowerCase() === r.userId.toLowerCase())) f.requesters.push({ userId: r.userId, displayName: r.displayName });
    for (const a of input.attachments ?? []) if (!f.attachments.some((x) => x.id === a.id)) f.attachments.push(a);
    f.history.push({ n, at, ...(sessionId ? { sessionId } : {}), ...(note ? { note } : {}), title });
    writeJsonDurable(path.join(dir, 'report.json'), f, { indent: 2 });
    this.files.set(f.id, f);
    this.bodies.set(f.id, body);
    return { report: this.summary(f), rev: n, notKept, created };
  }

  /**
   * Copy each local still or clip the text links to from review media into the report's media/ folder and point the
   * link at it. A local path elsewhere stays as written and is returned: nobody but its own computer can open it.
   */
  private keepMedia(f: ReportFile, body: string): { body: string; notKept: string[] } {
    const roots = this.mediaRoots().map((r) => path.resolve(r).toLowerCase());
    const under = (file: string) => roots.some((r) => file.toLowerCase().startsWith(r + path.sep));
    const notKept = new Set<string>();
    let copied = 0;
    const keep = (p: string): string | undefined => {
      if (p.startsWith(`/api/reports/${f.id}/media/`)) return p;
      const file = path.resolve(p);
      const key = file.toLowerCase();
      if (f.media[key]) return `/api/reports/${f.id}/media/${f.media[key]}`;
      if (!under(file) || copied >= MAX_MEDIA_FILES) return undefined;
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        return undefined;
      }
      if (!st.isFile() || st.size > MAX_MEDIA_BYTES) return undefined;
      const taken = new Set(Object.values(f.media));
      const base = safeName(path.basename(file));
      const ext = path.extname(base);
      let name = base;
      for (let k = 2; taken.has(name); k++) name = `${base.slice(0, base.length - ext.length)}-${k}${ext}`;
      fs.copyFileSync(file, path.join(this.dir(f.id), 'media', name));
      f.media[key] = name;
      copied++;
      return `/api/reports/${f.id}/media/${name}`;
    };
    // Markdown images and links whose target is a local path: ![a](<F:\x\y.png>), [clip](/srv/review/w1/c.mp4).
    const out = body.replace(/(!?\[[^\]\n]*\]\(\s*)(?:<([^>\n]+)>|([^\s)]+))/g, (m, head: string, angled?: string, bare?: string) => {
      const target = angled ?? bare ?? '';
      const p = localPath(target);
      if (!p || p.startsWith('/api/')) return m;
      const kept = keep(p);
      if (!kept) {
        notKept.add(p);
        return m;
      }
      return `${head}<${kept}>`;
    });
    return { body: out, notKept: [...notKept] };
  }
}

/** The words around the first match of any of `q` in `text`, with "…" where it is cut. */
function snippet(text: string, q: string[]): string {
  if (!q.length) return '';
  const lower = text.toLowerCase();
  const at = Math.min(...q.map((w) => lower.indexOf(w)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return '';
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, start + SNIPPET);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

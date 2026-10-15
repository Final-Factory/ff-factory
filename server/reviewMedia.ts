// Review media shown inline, never as a bare path (w1384, Ben, 2026-10-13: "you have to inline preview videos in this chat
// for me to verify them"; 2026-10-15: "I need to see the preview video for the fog. Stop giving me paths to videos and
// inline the videos like you should be doing and I've reminded you as such like 100 times").
//
// What a path to review media stands for, on the portal's own disk (the review root, docs/review.md): a file is itself when
// it exists; a folder is its stills and clips, newest first, without its `.preview/` encodes; a wildcard is what it matches;
// a bare file name is the file of that name in a folder the text names, in the request's own topic, or in any topic. Each
// is written `![name](<absolute path>)`, which the page shows as an inline still or a player (/api/image).
//
// Two users: the [needs you] payload (server/needsYou.ts) lists what to look at this way, and every reply a personal
// orchestrator writes to its person goes through inlineReviewMedia before it is stored and shown (Store.assistantText): a
// bare path, folder or relative name gets its media inserted after the paragraph that names it.
import fs from 'node:fs';
import path from 'node:path';

/** The stills and clips the page shows inline. */
export const MEDIA_FILE = /\.(?:mp4|webm|mov|png|jpe?g|gif|webp)$/i;
/** How many files a folder or a wildcard stands for, at most (the newest). */
export const MEDIA_PER_FOLDER = 8;
/** How many files one text gets inline, at most. */
const MEDIA_PER_TEXT = 24;
/** The review root's name on the portal host, as workers and orchestrators write it (docs/review.md). */
export const PORTAL_REVIEW_ROOT = '/srv/fff/review';

export interface ReviewMediaOptions {
  /** The review root on this computer (config review.root, default `<sandboxRoot>/_review`). */
  root: string;
  /** Request ids whose topics a bare file name is looked for in first ("w1241": `w1241-*`). */
  ids?: readonly string[];
}

/** The review root of a config, as server/index.ts makes it. */
export function reviewRootOf(cfg: { sandboxRoot: string; review?: { root?: string } }): string {
  return path.resolve(cfg.review?.root ?? path.join(cfg.sandboxRoot, '_review'));
}

const slash = (p: string) => p.replace(/\\/g, '/');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exists = (p: string) => fs.existsSync(p);
const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const mtime = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0;

/** The prefixes a review path is written with: the root itself and the portal's name for it. */
function prefixes(root: string): string[] {
  return [...new Set([slash(path.resolve(root)), PORTAL_REVIEW_ROOT])].sort((a, b) => b.length - a.length);
}

/** A written review path ("/srv/fff/review/w1/a.mp4", either slash) as the file on this computer, or undefined when it is not one. */
export function onDisk(ref: string, root: string): string | undefined {
  const r = slash(ref);
  for (const p of prefixes(root)) {
    if (r === p || r.toLowerCase().startsWith(`${p.toLowerCase()}/`)) {
      const rest = r.slice(p.length).replace(/^\/+/, '');
      const full = path.resolve(root, rest);
      // Belt and braces: a "../" never leaves the root.
      if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) return undefined;
      return full;
    }
  }
  return undefined;
}

/** The newest first (its mtime, then its name: v4 before v3), the files under `dir` (two levels, no dot-folders such as .preview). */
function mediaIn(dir: string, depth = 2): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (left > 1) walk(p, left - 1);
      } else if (MEDIA_FILE.test(e.name)) out.push(p);
    }
  };
  walk(dir, depth);
  return out.sort((a, b) => mtime(b) - mtime(a) || b.localeCompare(a));
}

/** What a wildcard in the last part of a path matches ("w1360b-*.png"), newest first. */
function globIn(full: string): string[] {
  const dir = path.dirname(full);
  const re = new RegExp(`^${path.basename(full).split('*').map(escape).join('.*')}$`, 'i');
  return mediaIn(dir, 1).filter((p) => path.dirname(p) === dir && re.test(path.basename(p)));
}

/**
 * The media files a written review path stands for, newest first: a file that exists, a folder's stills and clips, a
 * wildcard's matches. [] when it is none of them here (a name cut off mid-word, "glow_800_closeup.jp", w1241).
 */
export function mediaFor(ref: string, o: ReviewMediaOptions): string[] {
  const full = onDisk(ref.replace(/[.,:;!?]+$/, ''), o.root);
  if (!full) return [];
  if (full.includes('*')) return globIn(full).slice(0, MEDIA_PER_FOLDER);
  if (isDir(full)) return mediaIn(full).slice(0, MEDIA_PER_FOLDER);
  if (MEDIA_FILE.test(full) && exists(full)) return [full];
  // A file that is not there (its name cut off, "glow_800_closeup.jp" in a clipped report, w1241; or renamed): what its
  // topic folder has instead, when that folder is a topic of the root.
  const dir = path.dirname(full);
  return dir !== path.resolve(o.root) && isDir(dir) ? mediaIn(dir).slice(0, MEDIA_PER_FOLDER) : [];
}

/** The topics a bare file name is looked for in: the folders already named, the requests' own topics, then every topic, newest first. */
function nameIn(name: string, folders: readonly string[], o: ReviewMediaOptions): string | undefined {
  const root = path.resolve(o.root);
  let topics: string[] = [];
  try {
    topics = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(root, e.name));
  } catch {
    return undefined;
  }
  const ids = (o.ids ?? []).map((i) => i.toLowerCase());
  const own = topics.filter((t) => ids.some((i) => path.basename(t).toLowerCase().startsWith(`${i}-`)));
  const rest = topics.filter((t) => !own.includes(t)).sort((a, b) => mtime(b) - mtime(a));
  for (const d of [...folders, ...own]) {
    const hit = mediaIn(d).find((p) => path.basename(p).toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  // Any other topic: only its own top level, one existence check each (hundreds of topics on the portal).
  for (const d of rest) if (exists(path.join(d, name))) return path.join(d, name);
  return undefined;
}

/** A still or a clip as the page shows it inline. */
export const mediaLine = (p: string) => `![${path.basename(p)}](<${p}>)`;

/** Review paths written in a text (files, folders, wildcards), in order. */
function reviewRefsIn(text: string, root: string): { ref: string; at: number }[] {
  const re = new RegExp(`(?:${prefixes(root).map((p) => escape(p).replace(/\//g, '[\\\\/]')).join('|')})(?:[\\\\/][^\\s)'"\`\\]>,;]*)?`, 'gi');
  return [...text.matchAll(re)].map((m) => ({ ref: m[0].replace(/[.,:;!?]+$/, ''), at: m.index! }));
}

/** Other absolute media paths written in a text ("C:\\…\\a.png", "/Users/…/clip.mp4"): shown as they are, the page reads them where it can. */
function otherMediaIn(text: string): { ref: string; at: number }[] {
  return [...text.matchAll(/(?<![\w:/.])(?:[A-Za-z]:[\\/]|\/)[^\s)'"`\]>,;<]*\.(?:mp4|webm|mov|png|jpe?g|gif|webp)\b/gi)].map((m) => ({ ref: m[0], at: m.index! }));
}

/** Bare media file names ("glow_800_closeup.jpg") not part of a path. */
function namesIn(text: string): { ref: string; at: number }[] {
  return [...text.matchAll(/(?<![\w./\\-])[\w-][\w.-]*\.(?:mp4|webm|mov|png|jpe?g|gif|webp)\b(?![\w/\\])/gi)].map((m) => ({ ref: m[0], at: m.index! }));
}

/** The images and players a text already has: `![..](<target>)` or `![..](target)`, with their spans. */
function embedsIn(text: string): { target: string; start: number; end: number }[] {
  return [...text.matchAll(/!\[[^\]]*\]\((?:<([^>]*)>|([^)\s]*))\)/g)].map((m) => ({ target: m[1] ?? m[2] ?? '', start: m.index!, end: m.index! + m[0].length }));
}

/**
 * The media files a set of texts names, newest first per reference, each once, as absolute paths on this computer: what
 * the [needs you] payload lists (w1384). Folders are expanded, wildcards matched, bare names found, and what does not
 * exist dropped. When the review root is not on this computer at all, files are kept as written and folders kept as
 * folders (`folders`), so nothing named is lost.
 */
export function mediaNamed(texts: readonly (string | undefined)[], o: ReviewMediaOptions): { files: string[]; folders: string[] } {
  const files: string[] = [];
  const folders: string[] = [];
  const add = (p: string) => {
    if (!files.includes(p) && files.length < MEDIA_PER_TEXT) files.push(p);
  };
  const here = isDir(o.root);
  const named: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const { ref } of reviewRefsIn(text, o.root)) {
      if (!here) {
        if (MEDIA_FILE.test(ref) && !ref.includes('*')) add(ref);
        else if (!folders.includes(ref)) folders.push(ref);
        continue;
      }
      const full = onDisk(ref, o.root);
      if (full && isDir(full)) named.push(full);
      else if (full) named.push(path.dirname(full));
      for (const p of mediaFor(ref, o)) add(p);
    }
    for (const { ref } of otherMediaIn(text)) if (!onDisk(ref, o.root)) add(ref);
    if (here) {
      for (const { ref } of namesIn(text)) {
        if (files.some((f) => path.basename(f).toLowerCase() === ref.toLowerCase())) continue;
        const hit = nameIn(ref, named, o);
        if (hit) add(hit);
      }
    }
  }
  return { files, folders };
}

/** The review folders a text names (a file's folder for a file), on this computer. */
function foldersNamed(text: string, o: ReviewMediaOptions): string[] {
  if (!isDir(o.root)) return [];
  const all = reviewRefsIn(text, o.root).map((r) => onDisk(r.ref, o.root)).filter((p): p is string => !!p);
  return [...new Set(all.map((p) => (isDir(p) ? p : path.dirname(p))).filter((d) => d !== path.resolve(o.root) && isDir(d)))];
}

/**
 * Image targets with no folder (`![x.mp4](<x.mp4>)`, which the page cannot find) made absolute: the file of that name in a
 * folder the text names, the request's own topic, or any topic. `fixed`: how many.
 */
export function absoluteTargets(text: string, o: ReviewMediaOptions): { text: string; fixed: number } {
  if (!isDir(o.root) || !/!\[/.test(text)) return { text, fixed: 0 };
  const folders = foldersNamed(text, o);
  let fixed = 0;
  const out = text.replace(/!\[([^\]]*)\]\((?:<([^>/\\]+)>|([^)\s/\\]+))\)/g, (all, alt: string, a?: string, b?: string) => {
    const name = a ?? b ?? '';
    if (!MEDIA_FILE.test(name)) return all;
    const hit = nameIn(name, folders, o);
    if (!hit) return all;
    fixed++;
    return `![${alt}](<${hit}>)`;
  });
  return { text: out, fixed };
}

/**
 * A reply to a person with its review media inline (w1384, the outgoing check): every review path, folder, wildcard,
 * bare media name or other absolute media path that the text names and does not already show as `![..](..)` gets its
 * stills and clips inserted, as `![name](<absolute path>)` lines, after the paragraph (or code block) that names it; a
 * relative image target (`![x.mp4](<x.mp4>)`) becomes absolute. The words are left as written. `added`: how many files.
 */
export function inlineReviewMedia(text: string, o: ReviewMediaOptions): { text: string; added: number } {
  if (!text || !/\.(?:mp4|webm|mov|png|jpe?g|gif|webp)\b|review/i.test(text)) return { text, added: 0 };
  const here = isDir(o.root);
  const { text: out, fixed } = absoluteTargets(text, o);
  const folders = foldersNamed(out, o);
  const shown = new Set(embedsIn(out).map((e) => slash(onDisk(e.target, o.root) ?? e.target).toLowerCase()));
  const inEmbed = (at: number, spans: { start: number; end: number }[]) => spans.some((s) => at >= s.start && at < s.end);
  // Paragraphs and fenced code blocks, in order: what each names gets its media after it.
  const blocks = out.split(/(\n```[\s\S]*?\n```[^\n]*|\n{2,})/);
  let added = 0;
  const result: string[] = [];
  for (const block of blocks) {
    result.push(block);
    if (!block.trim() || /^\n{2,}$/.test(block)) continue;
    const spans = embedsIn(block);
    const refs = [...reviewRefsIn(block, o.root), ...otherMediaIn(block).filter((r) => !onDisk(r.ref, o.root)), ...(here ? namesIn(block) : [])].filter((r) => !inEmbed(r.at, spans));
    const lines: string[] = [];
    for (const { ref } of refs) {
      let files: string[];
      if (!onDisk(ref, o.root) && !/[\\/]/.test(ref)) files = (() => { const hit = nameIn(ref, folders, o); return hit ? [hit] : []; })();
      else if (onDisk(ref, o.root) && here) files = mediaFor(ref, o);
      else files = MEDIA_FILE.test(ref) && !ref.includes('*') ? [ref] : [];
      for (const f of files) {
        const key = slash(f).toLowerCase();
        if (shown.has(key) || added >= MEDIA_PER_TEXT) continue;
        shown.add(key);
        lines.push(mediaLine(f));
        added++;
      }
    }
    if (lines.length) result.push(`\n\n${lines.join('\n\n')}`);
  }
  return { text: result.join(''), added: added + fixed };
}

// post_as_max's `file` (docs/ffbox.md, "Posting as Max"): read on the worker's computer by its daemon, and sent to the portal as
// text. Only a file in the working folder or the session's temp folder, at most POST_FILE_MAX_BYTES, minus its first
// `skip_lines` lines (a release-notes file starts with two lines that are not the post).
import fs from 'node:fs';
import path from 'node:path';
import { publishableFile } from './attachments.ts';
import { POST_FILE_MAX_BYTES, POST_IMAGES_MAX, POST_IMAGES_MAX_BYTES, POST_IMAGE_MAX_BYTES, imageKind, imageName } from '../shared/ffboxPost.ts';

export async function postTextFromFile(cwd: string, file: unknown, skipLines: unknown, roots: string[]): Promise<string> {
  const f = await publishableFile(cwd, file, roots, 'only a file in your working folder or your own temp folder (TMP) may be posted; copy it there first');
  if (f.size > POST_FILE_MAX_BYTES) throw new Error(`${String(file)}: ${f.size} bytes; a message is at most 2000 characters (the file may hold ${POST_FILE_MAX_BYTES / 1024} KB)`);
  const skip = Math.max(0, Math.min(20, Math.floor(Number(skipLines) || 0)));
  const lines = (await fs.promises.readFile(f.path, 'utf8')).replace(/\r\n/g, '\n').split('\n');
  return lines.slice(skip).join('\n');
}

/** One image of a post as the daemon sends it to the portal: its file name and its bytes in base64. */
export interface PostImageWire {
  name: string;
  data: string;
}

const MB = (n: number) => `${n / (1024 * 1024)} MB`;

/**
 * post_as_max's `images` (w2723): PNG or JPEG files in the working folder or the session's temp folder, read here on the
 * worker's computer and sent to the portal with the call; the portal hands them to FFBox in parts. Checked by their
 * first bytes, never by their names, against the caps FFBox holds too.
 */
export async function postImagesFromFiles(cwd: string, images: unknown, roots: string[]): Promise<PostImageWire[]> {
  const list = Array.isArray(images) ? images : typeof images === 'string' && images.trim() ? [images] : [];
  if (!list.length) return [];
  if (list.length > POST_IMAGES_MAX) throw new Error(`images: ${list.length} files; a post carries at most ${POST_IMAGES_MAX}`);
  const out: PostImageWire[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const raw of list) {
    const f = await publishableFile(cwd, raw, roots, 'only an image in your working folder or your own temp folder (TMP) may be posted; copy it there first');
    if (f.size > POST_IMAGE_MAX_BYTES) throw new Error(`${String(raw)}: ${f.size} bytes; an image may be at most ${MB(POST_IMAGE_MAX_BYTES)}`);
    total += f.size;
    if (total > POST_IMAGES_MAX_BYTES) throw new Error(`images: more than ${MB(POST_IMAGES_MAX_BYTES)} together; post fewer or smaller ones`);
    const bytes = await fs.promises.readFile(f.path);
    const kind = imageKind(bytes);
    if (!kind) throw new Error(`${String(raw)}: not a PNG or JPEG image (by its first bytes); only those may be posted`);
    let name = imageName(path.basename(f.path), kind);
    for (let i = 2; names.has(name.toLowerCase()); i++) name = imageName(`${path.basename(f.path).replace(/\.[^.]*$/, '')}-${i}`, kind);
    names.add(name.toLowerCase());
    out.push({ name, data: bytes.toString('base64') });
  }
  return out;
}

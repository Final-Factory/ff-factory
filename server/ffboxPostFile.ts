// post_as_max's `file` (docs/ffbox.md, "Posting as Max"): read on the worker's computer by its daemon, and sent to the portal as
// text. Only a file in the working folder or the session's temp folder, at most POST_FILE_MAX_BYTES, minus its first
// `skip_lines` lines (a release-notes file starts with two lines that are not the post).
import fs from 'node:fs';
import { publishableFile } from './attachments.ts';
import { POST_FILE_MAX_BYTES } from '../shared/ffboxPost.ts';

export async function postTextFromFile(cwd: string, file: unknown, skipLines: unknown, roots: string[]): Promise<string> {
  const f = await publishableFile(cwd, file, roots, 'only a file in your working folder or your own temp folder (TMP) may be posted; copy it there first');
  if (f.size > POST_FILE_MAX_BYTES) throw new Error(`${String(file)}: ${f.size} bytes; a message is at most 2000 characters (the file may hold ${POST_FILE_MAX_BYTES / 1024} KB)`);
  const skip = Math.max(0, Math.min(20, Math.floor(Number(skipLines) || 0)));
  const lines = (await fs.promises.readFile(f.path, 'utf8')).replace(/\r\n/g, '\n').split('\n');
  return lines.slice(skip).join('\n');
}

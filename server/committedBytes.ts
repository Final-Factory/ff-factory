import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface GitRun {
  (args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Only files marked -text and stored in git (not an LFS pointer): the narrow pathspec keeps the look under a second on a
 * 38,000-file game checkout, where a plain `ls-files --eol` reads every file (65 s on beast, w1275).
 */
const PATHSPEC = ':(attr:-text !filter)';

/** git's object id of `bytes` as a blob, in the repo's hash (sha1: 40 hex, sha256: 64). */
export function blobId(bytes: Buffer, hexLength: number): string {
  const h = crypto.createHash(hexLength === 64 ? 'sha256' : 'sha1');
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest('hex');
}

/** `git ls-files -s --eol -z` records whose working file is CRLF where the index has LF and the file is marked -text. */
export function staleEolEntries(lsFiles: string): { path: string; id: string }[] {
  const out: { path: string; id: string }[] = [];
  for (const rec of lsFiles.split('\0')) {
    const m = /^\d+ ([0-9a-f]{40,64}) 0\ti\/(\S*)\s+w\/(\S*)\s+attr\/(.*?)\s*\t(.+)$/.exec(rec);
    if (!m) continue;
    const [, id, index, work, attr, file] = m;
    if (index === 'lf' && (work === 'crlf' || work === 'mixed') && attr.split(/\s+/).includes('-text')) out.push({ path: file, id });
  }
  return out;
}

/**
 * Put back the committed bytes of files marked -text whose working copy differs from them only by CRLF (w1275).
 *
 * A checkout written under core.autocrlf=true before a .gitattributes rule made those files -text keeps its CRLF copies
 * for good: a pull, a merge or a switch rewrites only files whose blob changed, and the index's stat data keeps
 * `git status` clean. The game repo's FMOD mac bundles were such files: FMOD's "Repair FMOD Libraries" dialog on every
 * editor start, and a broken bundle signature. A file whose bytes differ in anything but CR is a person's edit and is
 * left alone. Answers the paths it rewrote.
 */
export async function restoreCommittedBytes(dir: string, git: GitRun): Promise<string[]> {
  const ls = await git(['ls-files', '-s', '--eol', '-z', '--', PATHSPEC]);
  if (ls.code !== 0) throw new Error(`git ls-files failed (${ls.code}): ${ls.stderr.trim()}`);
  const fixed: string[] = [];
  for (const e of staleEolEntries(ls.stdout)) {
    const file = path.join(dir, e.path);
    const lf = Buffer.from(fs.readFileSync(file).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    if (blobId(lf, e.id.length) !== e.id) continue;
    fs.writeFileSync(file, lf);
    fixed.push(e.path);
  }
  // The index still holds the CRLF copy's size, and git calls a file of another size modified without reading it
  // (measured: `git status` shows M, `git diff` nothing, `update-index --refresh` keeps it). Adding the bytes, which hash to
  // the index's own blob, stages nothing new and records their stat.
  if (fixed.length) {
    const add = await git(['--literal-pathspecs', 'add', '--', ...fixed]);
    if (add.code !== 0) throw new Error(`git add failed (${add.code}): ${add.stderr.trim()}`);
  }
  return fixed;
}

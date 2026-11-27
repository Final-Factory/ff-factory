// The nightly lab's fixtures on this computer (w3939, server/labFixtures.ts): the players' saves in
// `<worker root>/nightly-history/fixtures`, which the portal copies into its attachment store so a worker on another
// computer gets them. Strictly read-only: nothing is written, renamed or deleted in that folder, only regular files
// directly in it are served, and a folder on drive C: is never touched (the rule: a worker install never uses C:).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { sendChunks } from './review.ts';

export interface LabFixtureFile {
  name: string;
  size: number;
  sha256: string;
}

export const fixturesDir = (root: string) => path.join(root, 'nightly-history', 'fixtures');

/** A path on drive C: (Windows only), which no worker install reads or writes. */
export const onDriveC = (p: string, platform: string = process.platform): boolean => platform === 'win32' && /^c:/i.test(path.win32.resolve(p));

/**
 * The fixtures folder of a worker root, when this computer offers it: the folder exists and is not on C:. Async (w6486):
 * BEAST's daemon spent 55.8 s in the synchronous realpath here on 2026-11-27, with its event loop held. Its errors are
 * the synchronous version's: a missing folder offers nothing, any other stat or realpath error rejects.
 */
export async function offeredDir(root: string | undefined): Promise<string | undefined> {
  if (!root) return undefined;
  const dir = fixturesDir(root);
  if (onDriveC(dir)) return undefined;
  // as statSync's throwIfNoEntry: false: a missing folder is no folder; any other error throws
  const st = await fs.promises.stat(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  if (!st?.isDirectory()) return undefined;
  // a junction or link from the install folder into C: is C: too (fs.promises.realpath is the native realpath)
  return onDriveC(await fs.promises.realpath(dir)) ? undefined : dir;
}

/** Hashes by (name, size, mtime), so a listing only reads a file that is new or changed. */
const hashed = new Map<string, string>();

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), async function* (src: AsyncIterable<Buffer>) {
    for await (const c of src) h.update(c);
  });
  return h.digest('hex');
}

/** The regular files directly in `dir` (no links, folders, dotfiles or sub-folders' files), each with its SHA-256, by name. The caller got `dir` from offeredDir. */
export async function listFixtures(dir: string): Promise<LabFixtureFile[]> {
  const out: LabFixtureFile[] = [];
  for (const name of (await fs.promises.readdir(dir)).sort()) {
    if (name.startsWith('.')) continue;
    const file = path.join(dir, name);
    const st = await fs.promises.lstat(file).catch(() => undefined);
    if (!st?.isFile() || st.size <= 0) continue;
    const key = `${file}\0${st.size}\0${st.mtimeMs}`;
    let sha256 = hashed.get(key);
    if (!sha256) {
      sha256 = await sha256Of(file);
      hashed.set(key, sha256);
    }
    out.push({ name, size: st.size, sha256 });
  }
  return out;
}

/** The fixtures whose SHA-256 is `sha256` (the same content may be filed under two names). */
export async function findFixtures(dir: string, sha256: string): Promise<LabFixtureFile[]> {
  const want = sha256.toLowerCase();
  return (await listFixtures(dir)).filter((f) => f.sha256 === want);
}

/**
 * Send the fixture with this SHA-256 over the upload the portal opened. The file is hashed again first: it may have changed
 * since it was listed, and the portal checks the same hash on arrival. Refuses a hash that no file of the folder has.
 * Returns the id of the attachment the portal made.
 */
export async function sendFixture(dir: string, sha256: string, upload: { portalUrl: string; token: string; uploadId: string; chunkBytes?: number }): Promise<string> {
  const [f] = await findFixtures(dir, sha256);
  if (!f) throw new Error(`no lab fixture with sha256 ${sha256.slice(0, 12)}… here`);
  const file = path.join(dir, f.name);
  const st = await fs.promises.lstat(file);
  if (!st.isFile() || st.size !== f.size || (await sha256Of(file)) !== f.sha256) throw new Error(`${f.name} changed while it was read; ask again`);
  const url = `${upload.portalUrl.replace(/\/+$/, '')}/machine/attachments/uploads/${encodeURIComponent(upload.uploadId)}`;
  const body = await sendChunks(url, upload.token, file, f.size, upload.chunkBytes, {}, (b) => !!b.attachment);
  return String((body.attachment as { id: string }).id);
}

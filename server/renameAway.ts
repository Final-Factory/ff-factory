import fs from 'node:fs';
import path from 'node:path';

/**
 * Remove-by-rename (w5268). Clean-up renames a folder to `<name>.ffclean-<ms>` before it deletes it, so an entry with a file
 * open inside (Windows) is skipped whole instead of half deleted. When the delete then failed, the next pass renamed the
 * renamed folder again, one suffix more each time, until the name passed the file system's limit (biscuit, 2026-11-23:
 * `ffa-bd1baf7b.ffclean-1791750838504.ffclean-1791777592746.ffclean-…`, ENAMETOOLONG) and nothing could move or remove it.
 * A name now carries one suffix at most, and a name that already carries one, or a rename refused as too long, is removed
 * where it is. The caller's guard decides WHAT may go; this only decides how.
 */

/** Every trailing `.ffclean-<digits>` suffix, however many were stacked. */
const SUFFIXES = /(?:\.ffclean-\d+)+$/;

/** `p` with every trailing `.ffclean-<n>` stripped from its last segment. */
export function withoutCleanSuffix(p: string): string {
  return path.join(path.dirname(p), path.basename(p).replace(SUFFIXES, ''));
}

/** Whether the last segment of `p` already carries a `.ffclean-<n>` suffix (an earlier removal that failed). */
export function hasCleanSuffix(p: string): boolean {
  return SUFFIXES.test(path.basename(p));
}

/** The name `p` is renamed to before its delete: one `.ffclean-<now>` suffix, never more. */
export function doomedName(p: string, now = Date.now()): string {
  return `${withoutCleanSuffix(p)}.ffclean-${now}`;
}

/**
 * Rename `p` out of the way for its delete and answer the path to delete. A name that already carries a suffix is not
 * renamed again (answers `p`), and neither is one whose rename the file system refuses as too long (ENAMETOOLONG). Any
 * other rename error is thrown: the entry is in use and stays whole.
 */
export async function renameAway(p: string, now = Date.now()): Promise<string> {
  if (hasCleanSuffix(p)) return p;
  const doomed = doomedName(p, now);
  try {
    await fs.promises.rename(p, doomed);
    return doomed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENAMETOOLONG') return p;
    throw e;
  }
}

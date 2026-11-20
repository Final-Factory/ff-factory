/**
 * fetch_review (w4926, docs/review.md "Getting review files back"): a worker on a machine gets a copy of review files, the
 * stills, clips and notes publish_review put on the portal's computer, in its own Inbox. publish_review answers paths on the
 * portal's computer, which do not exist on the worker's (w4877: a worker on biscuit could not open its own clips at
 * /srv/fff/review/...). Each file becomes an attachment granted to that machine, and its daemon fetches it over FF Factory's
 * own link as fetch_attachment does (machine/attachments.ts): no share, ssh or new route.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentError, publicRef, publishableFile, type AttachmentStore } from './attachments.ts';
import { reviewTopic } from './review.ts';
import type { AttachmentRef } from '../shared/types.ts';

/** At most this many files in one call (publish_review's own default cap, review.maxFiles). */
export const FETCH_REVIEW_MAX_FILES = 40;

export interface FetchReviewArgs {
  topic?: unknown;
  files?: unknown;
}

/**
 * The review files a call names, as real paths inside the review root: `files` (paths as publish_review answered them, or
 * relative to the root, "w4877-clips/swallow.mp4"), else every published file of `topic` (not its previews or note
 * uploads in progress). Refuses anything outside the root and the root's `.uploads`.
 */
export async function reviewFilesFor(root: string, a: FetchReviewArgs): Promise<string[]> {
  const files = Array.isArray(a.files) ? a.files.map((f) => String(f ?? '').trim()).filter(Boolean) : [];
  const realRoot = await fs.promises.realpath(root).catch(() => path.resolve(root));
  const named: string[] = [];
  if (files.length) named.push(...files);
  else if (typeof a.topic === 'string' && a.topic.trim()) {
    const topic = reviewTopic(a.topic);
    const dir = path.join(root, topic);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (!entries) throw new AttachmentError(404, `no review topic "${topic}" in ${root}`);
    for (const e of entries.sort((x, y) => x.name.localeCompare(y.name))) if (e.isFile() && !e.name.startsWith('.')) named.push(path.join(dir, e.name));
    if (!named.length) throw new AttachmentError(404, `the review topic "${topic}" holds no files`);
  } else throw new AttachmentError(400, 'give files (the paths publish_review answered) or topic');
  if (named.length > FETCH_REVIEW_MAX_FILES) throw new AttachmentError(413, `${named.length} files: at most ${FETCH_REVIEW_MAX_FILES} in one call`);
  const out: string[] = [];
  for (const raw of named) {
    // A path as publish_review answered it, with either separator, on a portal of either OS.
    const f = await publishableFile(root, raw.replace(/[\\/]/g, path.sep), [root], `only files in the review folder (${root}) can be fetched`);
    const rel = path.relative(realRoot, f.path);
    if (rel.split(path.sep)[0] === '.uploads') throw new AttachmentError(403, `${raw}: an upload in progress, not a published review file`);
    if (!out.includes(f.path)) out.push(f.path);
  }
  return out;
}

/** fetch_review on a machine: each file an attachment granted to that machine, for its daemon to fetch into the Inbox. */
export async function reviewFilesForMachine(root: string, attachments: AttachmentStore, machineId: string, a: FetchReviewArgs, by: string): Promise<{ text: string; refs: AttachmentRef[] }> {
  const files = await reviewFilesFor(root, a);
  const realRoot = await fs.promises.realpath(root).catch(() => path.resolve(root));
  const refs: AttachmentRef[] = [];
  for (const f of files) {
    const rel = path.relative(realRoot, f);
    const r = await attachments.addFile(f, { source: `the review folder (${rel}), fetched by ${by} on ${machineId}` });
    refs.push(publicRef(r));
  }
  attachments.grant(machineId, refs.map((r) => r.id));
  console.log(`attachments: ${by} fetches ${refs.length} review file(s) to ${machineId}`);
  return { text: `${refs.length} review file(s) from ${root}, copied to this computer:`, refs };
}

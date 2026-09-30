import { messageImagePaths } from '../shared/imagePaths.ts';
import type { ImageRef, TranscriptEvent } from '../shared/types.ts';
import { IMAGE_EXT, type Store } from './store.ts';

/** The largest image copied into a transcript's store; a bigger one is still shown from its file while it lasts. */
export const MAX_KEPT_IMAGE_BYTES = 10 * 1024 * 1024;

/** Reads one image a session may show (its folders only; an SVG already sanitised), or throws. */
export type SessionImageReader = (file: string) => Promise<{ mediaType: string; data: Buffer }>;

/**
 * Copy the images an agent's message shows (markdown images and bare paths, shared/imagePaths.ts) into the
 * session's store as the message arrives, and record them on the event, so the chat keeps them after the file,
 * its sandbox or its temp folder is gone. A file the session may not show, or cannot be read, is skipped: the
 * page then tries the live file, which the same guard refuses.
 */
export async function keepMessageImages(store: Pick<Store, 'saveImage' | 'amend'>, sessionId: string, ev: TranscriptEvent, read: SessionImageReader): Promise<ImageRef[]> {
  if (ev.kind !== 'assistant' || ev.images) return [];
  const refs: ImageRef[] = [];
  for (const p of messageImagePaths(ev.text)) {
    try {
      const img = await read(p);
      if (!IMAGE_EXT[img.mediaType] || img.data.length > MAX_KEPT_IMAGE_BYTES) continue;
      refs.push({ id: store.saveImage(sessionId, img.mediaType, img.data.toString('base64')), mediaType: img.mediaType, path: p });
    } catch {
      // outside its folders, gone already, or its machine is away
    }
  }
  if (refs.length) store.amend(sessionId, ev.seq, { images: refs });
  return refs;
}

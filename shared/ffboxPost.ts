// What a worker may ask FFBox to post as Max (server/ffboxPost.ts; docs/ffbox.md, "Posting as Max"). Shared by the portal
// and the machine daemon, which reads a `file` into the message.

/** The channels FFBox posts into (its fff_feed.POST_CHANNELS); it refuses any other, and never the bug channels. */
export const POST_CHANNELS = ['dev_patch_notes', 'dev_chat', 'agent_testing'] as const;
export type PostChannel = (typeof POST_CHANNELS)[number];
/** What post_message takes as `channel`: those, or `conversation`, a conversation FFBox holds, bug threads included (w1640). */
export const POST_TARGETS = [...POST_CHANNELS, 'conversation'] as const;
/** Discord's limit for one message. */
export const POST_TEXT_MAX = 2000;
/** The most a `file` may hold before it is read (a message is 2000 characters; the rest is line endings and multi-byte text). */
export const POST_FILE_MAX_BYTES = 16 * 1024;

/**
 * Images on one post (w2723): PNG or JPEG only, at most POST_IMAGES_MAX of them, each at most POST_IMAGE_MAX_BYTES and all
 * together at most POST_IMAGES_MAX_BYTES. FFBox's ffwatch holds the same caps and checks them again.
 */
export const POST_IMAGES_MAX = 4;
export const POST_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const POST_IMAGES_MAX_BYTES = 8 * 1024 * 1024;
/** The file name Discord shows, as FFBox takes it: ends .png, .jpg or .jpeg. */
export const POST_IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** What an image is by its first bytes, or undefined for anything that is not a PNG or a JPEG. */
export function imageKind(head: Uint8Array): 'png' | 'jpeg' | undefined {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length >= png.length && png.every((b, i) => head[i] === b)) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  return undefined;
}

/** A file name for an image of that kind: the given name's safe characters, ending in the kind's extension. */
export function imageName(given: string, kind: 'png' | 'jpeg'): string {
  const stem = given.replace(/\.(png|jpe?g)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 56) || 'image';
  return `${stem}.${kind === 'png' ? 'png' : 'jpg'}`;
}

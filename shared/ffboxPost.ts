// What a worker may ask FFBox to post as Max (server/ffboxPost.ts; docs/ffbox.md, "Posting as Max"). Shared by the portal
// and the machine daemon, which reads a `file` into the message.

/** The channels FFBox posts into (its fff_feed.POST_CHANNELS); it refuses any other, and never the bug channels. */
export const POST_CHANNELS = ['dev_patch_notes', 'dev_chat', 'agent_testing'] as const;
export type PostChannel = (typeof POST_CHANNELS)[number];
/** Discord's limit for one message. */
export const POST_TEXT_MAX = 2000;
/** The most a `file` may hold before it is read (a message is 2000 characters; the rest is line endings and multi-byte text). */
export const POST_FILE_MAX_BYTES = 16 * 1024;

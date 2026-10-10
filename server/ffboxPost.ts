// A worker's message posted as Max through FFBox (docs/ffbox.md, "Posting as Max"; FFBox w901). FFBox holds the Discord
// bot, so a worker on any machine asks FF Factory (the machine tool post_as_max), FF Factory asks FFBox (the
// `post_message` query), and FFBox runs every guard and posts. No Discord credential is involved on this side, and the
// bot token never leaves FFBox. The guards are FFBox's (its README, "Posting as Max"); the checks here only fail fast
// with a sentence, with the same rules, and FFBox answers `refused` with its own reason for anything they let through.
import { type ProviderManager } from './providers.ts';
import { clean } from './ffboxReports.ts';
import type { CliEvent } from './maxEvents.ts';

import { POST_CHANNELS, POST_TEXT_MAX } from '../shared/ffboxPost.ts';

export { POST_CHANNELS, POST_TEXT_MAX };

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SNOWFLAKE = /^\d{15,25}$/;
/** An @ before a word, <@..>, <#..>, @everyone, @here: FFBox refuses all of them. */
const MENTION = /@[\w&!]|<[@#]/;
const LINK = /^https:\/\/discord\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})$/;

export interface PostInput {
  channel: string;
  text: string;
  thread?: string;
  key?: string;
  /** Who asked, for FFBox's log: the request or the session. */
  by?: string;
}

/** The query's args out of a call, or a sentence saying what is wrong with it. */
export function postArgs(input: PostInput): { args: Record<string, string> } | { error: string } {
  const channel = String(input.channel ?? '').trim();
  if (!(POST_CHANNELS as readonly string[]).includes(channel)) {
    return { error: `channel: one of ${POST_CHANNELS.join(', ')} (got ${JSON.stringify(clean(channel, 40))}). #bug-reports and dev_bug_reports belong to FFBox and are never posted into.` };
  }
  const text = String(input.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text || text === '-') return { error: 'text: nothing to post' };
  if ([...text].length > POST_TEXT_MAX) return { error: `text: ${[...text].length} characters; Discord takes ${POST_TEXT_MAX} in one message. Tighten it.` };
  if (MENTION.test(text)) return { error: 'text: mentions someone (an @ before a word, <@..>, <#..>, @everyone or @here); posts through this route never mention anybody.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/.test(text)) return { error: 'text: control characters other than newline and tab' };
  const key = String(input.key ?? '').trim();
  if (key && !KEY.test(key)) return { error: 'key: letters, digits and . _ : - only, at most 80 characters' };
  if (channel === 'dev_patch_notes' && !key) return { error: "key: required for dev_patch_notes, the release's version (e.g. 0.50.0.94), so its notes post once." };
  const thread = String(input.thread ?? '').trim();
  if (thread && !SNOWFLAKE.test(thread)) return { error: 'thread: a Discord thread id (a thread of that channel)' };
  const by = clean(input.by ?? '', 120);
  return { args: { channel, text, ...(thread ? { thread } : {}), ...(key ? { key } : {}), ...(by ? { by } : {}) } };
}

export interface PostResult {
  /** The text for the agent. */
  text: string;
  /** The event for the Max page (docs/max.md), when a message was posted now. */
  event?: CliEvent;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? clean(v, max) : '');

/**
 * Ask FFBox to post one message as Max. Throws an Error with a plain sentence when nothing was posted (or when it could
 * not be told). A repeated key answers the first post's link, with `duplicate`, and posts nothing.
 */
export async function postAsMax(providers: ProviderManager, input: PostInput, session?: string, now: () => Date = () => new Date()): Promise<PostResult> {
  const parsed = postArgs(input);
  if ('error' in parsed) throw new Error(parsed.error);
  const a = await providers.query('post_message', parsed.args);
  const words = [a.reason, a.hint, a.detail].filter(Boolean).join('; ');
  if (!a.live || !a.data) {
    const sure = a.error === 'refused' || a.error === 'rate_limited' || a.error === 'failed' || a.error === 'bad_args' || a.error === 'unsupported' || a.error === 'offline' || a.error === 'switched_off' || a.error === 'disabled';
    throw new Error(
      `FFBox did not post it: ${a.error ?? 'no answer'}${words ? ` (${clean(words, 300)})` : ''}.` +
        (sure
          ? a.error === 'unsupported'
            ? ' FFBox may be updating, or is older than this tool; try again in a few minutes.'
            : ''
          : ` The answer did not come, so it may have been posted: ask again with the same key (a repeat answers the first post's link and never posts twice).`),
    );
  }
  const d = a.data as Record<string, unknown>;
  const link = str(d.link, 200);
  const channel = str(d.channel, 40) || parsed.args.channel;
  const dup = d.duplicate === true;
  const m = LINK.exec(link);
  const facts = `${link || `message ${str(d.message_id, 25)}`} (#${channel.replace(/_/g, '-')}${d.thread ? `, thread ${str(d.thread, 25)}` : ''}, ${Number(d.chars) || '?'} characters)`;
  if (dup) return { text: `Already posted, nothing was sent again: ${facts}. FFBox found the same ${parsed.args.key ? `key "${parsed.args.key}"` : 'text'} posted there before.` };
  return {
    text: `Posted as Max by FFBox: ${facts}. Put the link in your report.`,
    event: {
      v: 1,
      at: now().toISOString(),
      action: 'post',
      ok: true,
      ...(m ? { guild_id: m[1], channel_id: d.thread ? str(d.channel_id, 25) || m[2] : m[2], message_id: m[3] } : {}),
      ...(d.thread ? { thread_id: str(d.thread, 25) } : {}),
      channel,
      text: parsed.args.text,
      ...(session ? { session } : {}),
    },
  };
}

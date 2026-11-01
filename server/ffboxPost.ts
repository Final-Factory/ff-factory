// A worker's or an orchestrator's message posted as Max through FFBox (docs/ffbox.md, "Posting as Max"; FFBox w901), into
// a channel or into a conversation FFBox holds, bug threads included (w1640). FFBox holds the Discord
// bot, so a worker on any machine asks FF Factory (the machine tool post_as_max), FF Factory asks FFBox (the
// `post_message` query), and FFBox runs every guard and posts. No Discord credential is involved on this side, and the
// bot token never leaves FFBox. The guards are FFBox's (its README, "Posting as Max"); the checks here only fail fast
// with a sentence, with the same rules, and FFBox answers `refused` with its own reason for anything they let through.
import { type ProviderManager } from './providers.ts';
import { QUERY_LIMITS } from './providerProtocol.ts';
import { clean } from './ffboxReports.ts';
import type { CliEvent } from './maxEvents.ts';
import { redactSecrets } from './secrets.ts';

import { POST_CHANNELS, POST_TARGETS, POST_TEXT_MAX } from '../shared/ffboxPost.ts';

export { POST_CHANNELS, POST_TARGETS, POST_TEXT_MAX };

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SNOWFLAKE = /^\d{15,25}$/;
const CONVERSATION_ID = /^\d{1,12}$/;
/** A thread's link, or a message's in it: the thread is the second id. */
const THREAD_URL = /^https:\/\/discord\.com\/channels\/\d{15,25}\/(\d{15,25})(?:\/\d{15,25})?$/;
/** An @ before a word, <@..>, <#..>, @everyone, @here: FFBox refuses all of them. */
const MENTION = /@[\w&!]|<[@#]/;
const LINK = /^https:\/\/discord\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})$/;

export interface PostInput {
  channel: string;
  text: string;
  thread?: string;
  /** With channel conversation: FFBox's conversation id. */
  conversation?: string;
  key?: string;
  /** Who asked, for FFBox's log: the request or the session. */
  by?: string;
  /** agent_testing only, no thread: FFBox makes a thread with this name off the posted message (w2670: a thread to try a close on). */
  new_thread?: string;
}

/** The query's args out of a call, or a sentence saying what is wrong with it. */
export function postArgs(input: PostInput): { args: Record<string, string> } | { error: string } {
  const channel = String(input.channel ?? '').trim();
  if (!(POST_TARGETS as readonly string[]).includes(channel)) {
    const bug = channel === 'bug_reports' || channel === 'dev_bug_reports';
    return { error: `channel: one of ${POST_TARGETS.join(', ')} (got ${JSON.stringify(clean(channel, 40))}).${bug ? ' To post in a thread of #bug-reports or dev_bug_reports, use channel "conversation" with its thread.' : ''}` };
  }
  // never a secret's value in a post (w1688): masked as in every transcript, whatever its variable is called
  const text = redactSecrets(String(input.text ?? '').replace(/\r\n/g, '\n').trim());
  if (!text || text === '-') return { error: 'text: nothing to post' };
  if ([...text].length > POST_TEXT_MAX) return { error: `text: ${[...text].length} characters; Discord takes ${POST_TEXT_MAX} in one message. Tighten it.` };
  if (MENTION.test(text)) return { error: 'text: mentions someone (an @ before a word, <@..>, <#..>, @everyone or @here); posts through this route never mention anybody.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/.test(text)) return { error: 'text: control characters other than newline and tab' };
  const key = String(input.key ?? '').trim();
  if (key && !KEY.test(key)) return { error: 'key: letters, digits and . _ : - only, at most 80 characters' };
  if (channel === 'dev_patch_notes' && !key) return { error: "key: required for dev_patch_notes, the release's version (e.g. 0.50.0.94), so its notes post once." };
  const by = clean(input.by ?? '', 120);
  if (channel === 'conversation') {
    const conversation = String(input.conversation ?? '').trim();
    if (conversation && !CONVERSATION_ID.test(conversation)) return { error: "conversation: FFBox's conversation id, digits only (ffbox_activity and FFBox's messages name it)" };
    const given = String(input.thread ?? '').trim();
    const thread = THREAD_URL.exec(given)?.[1] ?? given;
    if (thread && !SNOWFLAKE.test(thread)) return { error: 'thread: the conversation\'s Discord thread, its id or its link (https://discord.com/channels/<guild>/<thread>)' };
    if (!conversation && !thread) return { error: 'conversation: give the FFBox conversation id or the Discord thread (its id or URL)' };
    return { args: { channel, text, ...(conversation ? { conversation } : {}), ...(thread ? { thread } : {}), ...(key ? { key } : {}), ...(by ? { by } : {}) } };
  }
  const thread = String(input.thread ?? '').trim();
  if (thread && !SNOWFLAKE.test(thread)) return { error: 'thread: a Discord thread id (a thread of that channel)' };
  const newThread = clean(String(input.new_thread ?? '').replace(/\s+/g, ' '), 100).trim();
  if (newThread && (channel !== 'agent_testing' || thread)) return { error: 'new_thread: only in agent_testing, and not with a thread (it makes one off the message, for trying a close where no player is)' };
  if (newThread && MENTION.test(newThread)) return { error: 'new_thread: mentions someone' };
  return { args: { channel, text, ...(thread ? { thread } : {}), ...(newThread ? { new_thread: newThread } : {}), ...(key ? { key } : {}), ...(by ? { by } : {}) } };
}

export interface PostResult {
  /** The text for the agent. */
  text: string;
  /** The event for the Max page (docs/max.md), when a message was posted now. */
  event?: CliEvent;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? clean(v, max) : '');

/** Answers that say nothing about whether FFBox posted (or that nothing was posted yet): asked again with the same args. */
const AGAIN = new Set(['timeout', 'no_answer', 'disconnected', 'busy', 'not_ready', 'unavailable']);
/** FFBox's clock against this one's, for "this call's post" (they share the FFBox host's NTP). */
const CLOCK_SLACK_MS = 5_000;

export interface PostRetry {
  /** One ask's longest wait: QUERY_LIMITS.timeoutMsByQuery.post_message. */
  askMs: number;
  /** All the asks of one call, inside the daemon's 90 s for post_as_max (machine/daemon.ts). */
  budgetMs: number;
  /** Before asking again after busy, not_ready or unavailable (FFBox did not take the request). */
  pauseMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const POST_RETRY: PostRetry = { askMs: QUERY_LIMITS.timeoutMsByQuery.post_message, budgetMs: 75_000, pauseMs: 3_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * Ask FFBox to post one message as Max. Throws an Error with a plain sentence when nothing was posted (or when it could
 * not be told). A repeated key answers the first post's link, with `duplicate`, and posts nothing.
 */
export async function postAsMax(providers: ProviderManager, input: PostInput, session?: string, now: () => Date = () => new Date(), opts: PostRetry = POST_RETRY): Promise<PostResult> {
  const parsed = postArgs(input);
  if ('error' in parsed) throw new Error(parsed.error);
  const started = now().getTime();
  let a = await providers.query('post_message', parsed.args);
  // AN ANSWER THAT DID NOT COME IS ASKED AGAIN (w1664; lothsahn: "The patch notes uploaded to discord but the worker thought
  // they didn't"). The same args carry the same key (or the same text, which posts once a day), so FFBox's dedupe answers
  // the first post's link when it went out, and posts it now, once, when it never did: either way the call ends with the
  // link, not "may have been posted". FFBox answers its requests one at a time, so a repeat is answered after the first.
  let asks = 1;
  while (!a.live && AGAIN.has(a.error ?? '') && now().getTime() - started + opts.askMs <= opts.budgetMs) {
    await opts.sleep(a.error === 'busy' || a.error === 'not_ready' || a.error === 'unavailable' ? opts.pauseMs : 0);
    a = await providers.query('post_message', parsed.args);
    asks++;
  }
  const words = [a.reason, a.hint, a.detail].filter(Boolean).join('; ');
  if (!a.live || !a.data) {
    const sure = a.error === 'refused' || a.error === 'rate_limited' || a.error === 'failed' || a.error === 'bad_args' || a.error === 'unsupported' || a.error === 'offline' || a.error === 'switched_off' || a.error === 'disabled';
    throw new Error(
      `FFBox did not post it: ${a.error ?? 'no answer'}${words ? ` (${clean(words, 300)})` : ''}${asks > 1 ? `, asked ${asks} times in ${Math.round((now().getTime() - started) / 1000)} s` : ''}.` +
        (sure
          ? a.error === 'unsupported'
            ? ' FFBox may be updating, or is older than this tool; try again in a few minutes.'
            : ''
          : ` The answer did not come, so it may have been posted: ask again with the same key (a repeat answers the first post's link and never posts twice).`),
    );
  }
  const d = a.data as Record<string, unknown>;
  // A repeat that found the post this call made (its first answer was late) is this call's post, not an old one.
  const postedAt = Date.parse(str(d.posted_at, 40));
  const late = d.duplicate === true && asks > 1 && Number.isFinite(postedAt) && postedAt >= started - CLOCK_SLACK_MS;
  if (late) d.duplicate = false;
  const link = str(d.link, 200);
  const channel = str(d.channel, 40) || parsed.args.channel;
  const dup = d.duplicate === true;
  const m = LINK.exec(link);
  // FFBox answers a conversation post's channel as "conversation <id>".
  const place = channel.startsWith('conversation') ? `FFBox ${channel}` : `#${channel.replace(/_/g, '-')}`;
  const facts = `${link || `message ${str(d.message_id, 25)}`} (${place}${d.thread ? `, thread ${str(d.thread, 25)}` : ''}, ${Number(d.chars) || '?'} characters)`;
  const nt = d.new_thread && typeof d.new_thread === 'object' ? (d.new_thread as Record<string, unknown>) : undefined;
  const made = nt ? ` New thread: ${str(nt.link, 200) || str(nt.id, 25)} (archives itself after a day).` : '';
  if (dup) return { text: `Already posted, nothing was sent again: ${facts}. FFBox found the same ${parsed.args.key ? `key "${parsed.args.key}"` : 'text'} posted there before.${made}` };
  return {
    text: `Posted as Max by FFBox: ${facts}.${made} ${late ? `FFBox's first answer came late; asked again with the same ${parsed.args.key ? 'key' : 'text'}, it answered the post it had made. ` : ''}Put the link in your report.`,
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

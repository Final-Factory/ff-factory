// The bug threads, read from FFBox (w1783; docs/intake.md, "Every bug thread has an owner"). The portal holds no Discord
// token: FFBox holds the bot and already stores every message of its bug_report channels' threads, an operator's plain
// reply included (its engage gate only marks one it does not answer). Its read-only `bug_threads` and `thread_messages`
// queries (the ffbox README, "Read-only queries for FF Factory") hand those stored texts to the bug-thread watch in the
// shapes server/bugThreads.ts reads from Discord. The only message sent is a `query`; nothing reaches Discord.
import type { BugThreadReader, RawThread } from './bugThreads.ts';
import type { DiscordMessage } from './intakeRules.ts';
import type { QueryAnswer } from './providers.ts';

/** What this reader needs of server/providers.ts. */
export interface QueryAsker {
  query(what: string, args?: Record<string, number | string>): Promise<QueryAnswer>;
}

/**
 * Queries one pass may send. The portal sends FFBox at most 30 a minute across every tool (QUERY_LIMITS.perMinute); a
 * pass every 5 minutes that keeps under this leaves the rest to the people and workers asking, and what it did not
 * read it reads next pass (the watch's cursors stay put).
 */
export const FFBOX_QUERIES_PER_PASS = 12;

const ID = /^\d{15,25}$/;
const LINK = /^https:\/\/discord\.com\/channels\/(\d{15,25})\/\d{15,25}$/;

export class QueryBudgetSpent extends Error {
  constructor() {
    super(`the pass's ${FFBOX_QUERIES_PER_PASS} FFBox queries are spent; the rest next pass`);
  }
}

interface FfboxThread {
  id?: unknown;
  channel?: unknown;
  channel_id?: unknown;
  title?: unknown;
  link?: unknown;
  opener?: unknown;
  opener_bot?: unknown;
  messages?: unknown;
  last_message?: unknown;
}

interface FfboxMessage {
  id?: unknown;
  author_id?: unknown;
  author?: unknown;
  bot?: unknown;
  at?: unknown;
  text?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export class FfboxBugThreads implements BugThreadReader {
  /** FFBox always reads; when it cannot, its answer says why and the pass fails with that. */
  readonly hasToken = true;
  guildId: string | undefined;
  operatorIds: Record<string, string> = {};
  private channels = new Map<string, string>();
  private spent = 0;

  private readonly providers: QueryAsker;

  constructor(providers: QueryAsker) {
    this.providers = providers;
  }

  /** A new pass: its query budget starts again. */
  beginPass() {
    this.spent = 0;
  }

  private async ask(what: string, args: Record<string, number | string>): Promise<Record<string, unknown>> {
    if (this.spent >= FFBOX_QUERIES_PER_PASS) throw new QueryBudgetSpent();
    this.spent++;
    const a = await this.providers.query(what, args);
    // Only a live answer: a kept one would show threads as they were.
    if (!a.live || !a.ok || !a.data) {
      const words = [a.error ?? 'no answer', a.reason ?? a.detail ?? a.hint].filter(Boolean).join(': ');
      throw new Error(`FFBox could not answer "${what}": ${words}`);
    }
    return a.data;
  }

  channelIdOf(alias: string): string | undefined {
    return this.channels.get(alias);
  }

  /** The bug channels' threads opened or written in since `since` (epoch ms), with the channel alias each is in. */
  async listThreads(since: number, channels: string[]): Promise<(RawThread & { channel: string })[]> {
    const out: (RawThread & { channel: string })[] = [];
    const want = new Set(channels);
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const d = await this.ask('bug_threads', { since: Math.floor(since / 1000), offset });
      if (d.operators && typeof d.operators === 'object') {
        const ops: Record<string, string> = {};
        for (const [id, name] of Object.entries(d.operators as Record<string, unknown>)) if (ID.test(id) && typeof name === 'string') ops[id] = name.toLowerCase();
        this.operatorIds = ops;
      }
      for (const t of (Array.isArray(d.threads) ? d.threads : []) as FfboxThread[]) {
        const id = str(t.id);
        const alias = str(t.channel);
        if (!id || !ID.test(id) || !alias || !want.has(alias)) continue;
        const cid = str(t.channel_id);
        if (cid && ID.test(cid)) this.channels.set(alias, cid);
        const g = LINK.exec(str(t.link) ?? '');
        if (g) this.guildId = g[1];
        const last = str(t.last_message);
        out.push({
          id,
          channel: alias,
          ...(cid ? { parent_id: cid } : {}),
          name: str(t.title) ?? 'Untitled',
          ...(str(t.opener) && ID.test(str(t.opener)!) ? { owner_id: str(t.opener) } : {}),
          ...(typeof t.messages === 'number' ? { message_count: t.messages } : {}),
          last_message_id: last && ID.test(last) ? last : null,
          by_bot: t.opener_bot === true,
        });
      }
      if (typeof d.next_offset !== 'number' || d.next_offset <= offset) break;
      offset = d.next_offset;
    }
    return out;
  }

  async activeThreads(): Promise<RawThread[]> {
    return [];
  }

  async archivedThreads(): Promise<{ threads: RawThread[]; hasMore: boolean }> {
    return { threads: [], hasMore: false };
  }

  /** One message: here only the thread's opening post (its id is the thread's) is asked for. */
  async message(threadId: string, messageId: string): Promise<DiscordMessage> {
    const d = await this.ask('thread_messages', { thread: threadId, limit: 1 });
    const m = this.messages(d)[0];
    if (!m || m.id !== messageId) throw new Error(`FFBox holds no message ${messageId} in thread ${threadId}`);
    return m;
  }

  async messagesAfter(threadId: string, after?: string): Promise<DiscordMessage[]> {
    const d = await this.ask('thread_messages', { thread: threadId, ...(after ? { after } : {}), limit: 50 });
    const msgs = this.messages(d);
    // `more` with fewer than a page (the answer's size cut it): the watch reads the rest next pass from its cursor.
    return msgs;
  }

  private messages(d: Record<string, unknown>): DiscordMessage[] {
    const out: DiscordMessage[] = [];
    for (const m of (Array.isArray(d.messages) ? d.messages : []) as FfboxMessage[]) {
      const id = str(m.id);
      if (!id || !ID.test(id)) continue;
      const author = str(m.author_id);
      out.push({
        id,
        content: str(m.text) ?? '',
        author: { ...(author && ID.test(author) ? { id: author } : {}), ...(str(m.author) ? { username: str(m.author) } : {}), bot: m.bot === true },
      });
    }
    return out;
  }
}

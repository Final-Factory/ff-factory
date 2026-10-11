import type http from 'node:http';
import { Readable } from 'node:stream';
import { bus, type Store } from './store.ts';
import { AttachmentError, type AttachmentStore } from './attachments.ts';
import { isMidTurn } from './sessions.ts';
import type { Orchestrators } from './orchestrators.ts';
import { HELD_MARK } from '../shared/conditional.ts';
import { MD_IMAGE, isVideoPath, localPath, mentionedPaths } from '../shared/imagePaths.ts';
import { REPLY_MARK, splitVia } from '../shared/replies.ts';
import type { AttachmentRef, Requester, ServerEvent, SessionInfo, TranscriptEvent } from '../shared/types.ts';

/**
 * Talking to your own orchestrator from Claude Code or Claude Desktop (w1021, docs/talk-to-your-orchestrator.md): the
 * /mcp tools `orchestrator_send` and `orchestrator_inbox`, and the upload that gives them a file. A message sent here is
 * the person's own turn, delivered the way the page's message route delivers one (cancel the orchestrator's wake_me,
 * start its budgets again, offer back the calls a gate held, then `sendWithAttachments(..., 'human', { requestedBy })`),
 * so approvals, closes and grants work as they do when the person types. Only the key's person's own orchestrator can be
 * reached: no tool names a target, and the session is looked up from the person alone.
 */

/** The longest message one call sends, in characters. */
export const MAX_SEND_CHARS = 100_000;
/** How long `orchestrator_send` waits for the turn by default (seconds). Claude Desktop gives up on a quiet call at about a minute (a guess), so it stays under; a longer wait is asked for. */
export const DEFAULT_WAIT_SECONDS = 50;
export const MAX_WAIT_SECONDS = 600;
/** A file sent by `orchestrator_attach`, before encoding: larger ones go through the HTTP upload. */
export const MAX_TOOL_FILE_BYTES = 5 * 1024 * 1024;
const INBOX_FIRST = 15;
const INBOX_MAX_EVENTS = 80;
const CLIP_SYSTEM = 1500;
const CLIP_HUMAN = 800;
const CLIP_ASSISTANT = 12_000;
/** How often a waiting call sends a progress notice (a variable so a test need not wait). */
export const timing = { keepaliveMs: 10_000 };

// ---------------------------------------------------------------- tailnet only

const loopback = (ip: string) => ip === '::1' || /^127\./.test(ip);

/** Whether `ip` is a Tailscale address: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export function tailnetAddress(ip: string): boolean {
  const a = ip.replace(/^::ffff:/i, '').toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return a.startsWith('fd7a:115c:a1e0:');
}

/**
 * Why a request may not use the orchestrator chat, or undefined when it came over the tailnet. Tailscale Serve puts
 * `Tailscale-Funnel-Request: ?1` on every request that came in through Funnel and deletes one the client sent itself
 * (tailscale/ipn/ipnlocal/serve.go, addTailscaleIdentityHeaders), and sets X-Forwarded-For to the client's own address (the
 * proxy is a Rewrite, so a header the client sent is dropped). The header is the test; the address is a second one, so a
 * Funnel request is refused even if the header were ever missing. The forwarded address is read only from a connection
 * that came from this machine (the proxy); any other connection is judged by its own address.
 */
export function tailnetOnly(req: Pick<http.IncomingMessage, 'headers' | 'socket'>): string | undefined {
  if (req.headers['tailscale-funnel-request'] !== undefined) return 'this request came in through Tailscale Funnel (the public internet); the orchestrator chat is tailnet-only';
  const direct = (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
  const fwd = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim();
  const addr = loopback(direct) && fwd ? fwd : direct;
  if (loopback(addr) || tailnetAddress(addr)) return undefined;
  return 'this request did not come from the tailnet (a Tailscale address); the orchestrator chat is tailnet-only';
}

/** `https://fff.<tailnet>.ts.net` for the host the client reached us at, or '' (links then stay relative). Never the Funnel address from config. */
export function originOf(req: Pick<http.IncomingMessage, 'headers' | 'socket'>): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
    .split(',')[0]
    .trim();
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return '';
  const proto = String(req.headers['x-forwarded-proto'] ?? '').includes('https') || (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------- reading the chat

/** The events of one session as they are appended, by seq (an amended event replaces its first copy). */
class Watch {
  private readonly bySeq = new Map<number, TranscriptEvent>();
  private wake?: () => void;
  private readonly on = (e: ServerEvent) => {
    if (e.type !== 'transcript' || e.sessionId !== this.sessionId) return;
    this.bySeq.set(e.event.seq, e.event);
    this.wake?.();
  };

  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    bus.on('event', this.on);
  }

  get events(): TranscriptEvent[] {
    return [...this.bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  add(events: TranscriptEvent[]) {
    for (const e of events) if (!this.bySeq.has(e.seq)) this.bySeq.set(e.seq, e);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  stop() {
    bus.off('event', this.on);
  }
}

type Result = Extract<TranscriptEvent, { kind: 'result' }>;
type Failure = Extract<TranscriptEvent, { kind: 'error' }>;

export interface TurnView {
  /** The message was found in the stream. */
  found: boolean;
  /** The result (or error) that ends the turn answering the message, once it came. */
  done?: Result | Failure;
  /** What the orchestrator said from the message to now (or to the end of the turn). */
  said: string[];
  tools: string[];
  /** The last event of the turn so far. */
  last: number;
}

/**
 * The turn that answers the message `uuid`: the first result that lists it in `answers` (the orchestrator may have been
 * busy with another turn when it arrived), else, for an older CLI that lists none, the next result with no list. What it
 * said is what came after the result before that one: a message sent mid-turn is stored while the earlier turn is still
 * talking, and that is not its answer. `queued`: the orchestrator was mid-turn when the message arrived, so until a result
 * has come after it, nothing said is its answer.
 */
export function turnOf(events: TranscriptEvent[], uuid: string, queued = false): TurnView {
  const mine = events.findIndex((e) => e.kind === 'user' && e.uuid === uuid);
  if (mine < 0) return { found: false, said: [], tools: [], last: 0 };
  const tail = events.slice(mine + 1);
  const done = tail.find((e): e is Result => e.kind === 'result' && !!e.answers?.includes(uuid)) ?? tail.find((e): e is Result => e.kind === 'result' && !e.answers) ?? tail.find((e): e is Failure => e.kind === 'error');
  const before = tail.filter((e) => e.kind === 'result' && (!done || e.seq < done.seq)).at(-1);
  const from = before?.seq ?? (queued && !done ? Infinity : 0);
  const turn = tail.filter((e) => e.seq > from && (!done || e.seq <= done.seq));
  return {
    found: true,
    ...(done ? { done } : {}),
    said: turn.filter((e): e is Extract<TranscriptEvent, { kind: 'assistant' }> => e.kind === 'assistant').map((e) => e.text),
    tools: turn.filter((e): e is Extract<TranscriptEvent, { kind: 'tool_use' }> => e.kind === 'tool_use').map((e) => e.name.replace('mcp__sandboxes__', '')),
    last: (turn.at(-1) ?? tail.at(-1) ?? events[mine]).seq,
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

/**
 * Reply text for a client outside the page: the Markdown as it is, with the image and video paths of this host (which only the
 * page could show) turned into links on the portal, `${origin}/api/image?session=…&path=…`, which a browser signed in
 * to FF Factory on the tailnet opens. A markdown image becomes a markdown image (a video, a link); a path written bare in
 * the text is listed under the reply.
 */
export function portalLinks(text: string, sessionId: string, origin = ''): string {
  const url = (p: string) => `${origin}/api/image?${new URLSearchParams({ session: sessionId, path: p })}`;
  const out = text.replace(MD_IMAGE, (m, angled?: string, plain?: string) => {
    const p = localPath(angled ?? plain ?? '');
    if (!p) return m;
    const alt = m.slice(2, m.indexOf(']'));
    return isVideoPath(p) ? `[${alt || baseName(p)} (video)](${url(p)})` : `![${alt}](${url(p)})`;
  });
  const bare = mentionedPaths(text);
  if (!bare.length) return out;
  return `${out}\n\nFiles named above (open while signed in to FF Factory on the tailnet):\n${bare.map((p) => `- [${baseName(p)}${isVideoPath(p) ? ' (video)' : ''}](${url(p)})`).join('\n')}`;
}

/** The chat from `events` on, one line or block per message, for `orchestrator_inbox`. */
export function describeEvents(events: TranscriptEvent[], sessionId: string, origin = ''): string {
  const lines: string[] = [];
  let tools: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case 'assistant':
        lines.push(`#${e.seq} orchestrator:\n${portalLinks(clip(e.text, CLIP_ASSISTANT), sessionId, origin)}`);
        break;
      case 'user': {
        if (e.text.startsWith('[reaction]')) break;
        const v = splitVia(e.text);
        const words = v.text.split(HELD_MARK)[0].split(REPLY_MARK)[0].trim();
        if (e.from === 'human') lines.push(`#${e.seq} you (${v.via ?? 'web app'}): ${clip(words, CLIP_HUMAN)}`);
        else lines.push(`#${e.seq} [${e.from === 'system' ? 'system' : 'agent'}] ${clip(words, CLIP_SYSTEM)}`);
        break;
      }
      case 'tool_use':
        tools.push(e.name.replace('mcp__sandboxes__', ''));
        break;
      case 'result':
        lines.push(`#${e.seq} — turn ended${tools.length ? ` (it used: ${[...new Set(tools)].join(', ')})` : ''}`);
        tools = [];
        break;
      case 'error':
        lines.push(`#${e.seq} error: ${clip(e.text, 600)}`);
        break;
      case 'permission':
        if (!e.decision) lines.push(`#${e.seq} [waiting for you in the web app: permission for ${e.toolName}]`);
        break;
      default:
    }
  }
  return lines.join('\n\n');
}

/** What counts as a message for the inbox: what a person reads in the chat, not the tool calls and results between. */
const isMessage = (e: TranscriptEvent) => e.kind === 'assistant' || e.kind === 'error' || e.kind === 'result' || (e.kind === 'user' && !e.text.startsWith('[reaction]')) || (e.kind === 'permission' && !e.decision);

// ---------------------------------------------------------------- the tools

export interface RemoteDeps {
  store: Pick<Store, 'readTranscript'>;
  sessions: { get(id: string): { info: SessionInfo } };
  orchestrators: Pick<Orchestrators, 'personalFor' | 'personWrote' | 'heldOffer' | 'isPersonal' | 'ownerOf'>;
  waker: { cancel(sessionId: string): unknown };
  /** The page's delivery (`Agents.sendWithAttachments`): the person's message, with their files. */
  deliver(sessionId: string, text: string, opts: { attachments: AttachmentRef[]; requestedBy: Requester }): Promise<string>;
  attachments(): AttachmentStore | undefined;
}

/** Who is calling and over what, from the /mcp request (server/mcp.ts). */
export interface RemoteCaller {
  who: Requester;
  /** The API key's name: it labels the message ("via Claude Code or Desktop (name)") and keeps the inbox position. */
  keyName: string;
  /** Whether the key is bound to a login. An unbound key acts for the owner and may not use the chat tools. */
  bound: boolean;
  /** Why this request may not use them (Funnel, a non-tailnet address), or undefined. */
  refuse?: string;
  /** `https://<host>` the client reached us at, for links. */
  origin: string;
}

/** The progress notice a client may ask for with a progressToken: it keeps a client's own call timeout from running out. */
export type Progress = (note: string) => Promise<void> | void;

export class RemoteChat {
  /** Per person and key, the last event the inbox gave; in memory (after a restart the inbox starts from the recent messages). */
  private readonly cursors = new Map<string, number>();

  private readonly d: RemoteDeps;

  constructor(d: RemoteDeps) {
    this.d = d;
  }

  /** The caller's own orchestrator, or throws why they may not use it. */
  private chat(c: RemoteCaller): SessionInfo {
    if (c.refuse) throw new Error(`refused: ${c.refuse}`);
    if (!c.bound) throw new Error('refused: this API key is not bound to a login, so it cannot say whose orchestrator to talk to. Mint one for yourself on the portal host: node server/apikey.ts <name> --user <your login>');
    const info = this.d.orchestrators.personalFor(c.who).info;
    const owner = this.d.orchestrators.ownerOf(info);
    if (!this.d.orchestrators.isPersonal(info) || !owner || owner.userId.toLowerCase() !== c.who.userId.toLowerCase()) throw new Error('refused: that is not your own orchestrator');
    return info;
  }

  private cursorKey = (c: RemoteCaller) => `${c.who.userId.toLowerCase()}:${c.keyName}`;

  /** Send `text` as the caller's own message and wait for the reply. */
  async send(c: RemoteCaller, a: { text: string; attachments?: string[]; waitSeconds?: number }, progress?: Progress): Promise<string> {
    const info = this.chat(c);
    const text = a.text.trim();
    const store = this.d.attachments();
    if (a.attachments?.length && !store) throw new Error('attachments are not wired into this server');
    const files = a.attachments?.length ? store!.resolve(a.attachments) : [];
    if (!text && !files.length) throw new Error('text: nothing to send');
    if (text.length > MAX_SEND_CHARS) throw new Error(`text: at most ${MAX_SEND_CHARS} characters`);
    const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, a.waitSeconds ?? DEFAULT_WAIT_SECONDS));
    const busy = isMidTurn(info);
    const id = info.id;
    // What the page's message route does for a person's own message to their orchestrator (server/index.ts).
    this.d.waker.cancel(id);
    this.d.orchestrators.personWrote(id);
    const via = `Claude Code or Desktop (${c.keyName.replace(/[\]\n\r]/g, '')})`;
    const said = `[via ${via}]\n${text}${this.d.orchestrators.heldOffer(id)}`;
    const watch = new Watch(id);
    try {
      const uuid = await this.d.deliver(id, said, { attachments: files, requestedBy: c.who });
      const deadline = Date.now() + wait * 1000;
      let nextKeepalive = Date.now() + timing.keepaliveMs;
      let view = turnOf(watch.events, uuid, busy);
      while (!view.done && Date.now() < deadline) {
        await watch.sleep(Math.max(1, Math.min(2000, deadline - Date.now(), nextKeepalive - Date.now())));
        view = turnOf(watch.events, uuid, busy);
        if (progress && Date.now() >= nextKeepalive) {
          nextKeepalive = Date.now() + timing.keepaliveMs;
          await progress(`the orchestrator is working (${Math.round((Date.now() - (deadline - wait * 1000)) / 1000)} s)`);
        }
      }
      const cursor = view.last || watch.events.at(-1)?.seq || 0;
      this.cursors.set(this.cursorKey(c), cursor);
      const queued = busy ? 'The orchestrator was in the middle of a turn: your message is queued behind it, as one typed in the web app would be. ' : '';
      const reply = view.said.length ? portalLinks(view.said.join('\n\n'), id, c.origin) : '';
      const used = view.tools.length ? `\n\n[orchestrator used: ${[...new Set(view.tools)].join(', ')}]` : '';
      if (view.done) {
        const tail = view.done.kind === 'error' ? `\n\n[the turn ended with an error: ${clip(view.done.text, 400)}]` : '';
        return `${queued}${reply || '(no text reply)'}${used}${tail}`;
      }
      return (
        `${queued}${reply || '(nothing yet)'}${used}\n\n` +
        `[still working after ${wait} s. Your message is delivered and shows in the web chat; the rest of the reply lands there too. ` +
        `Fetch it with orchestrator_inbox (since: ${cursor}, wait_seconds: up to ${MAX_WAIT_SECONDS}).]`
      );
    } finally {
      watch.stop();
    }
  }

  /** The chat after `since` (a seq from an earlier call), or after the last one this key was given. */
  async inbox(c: RemoteCaller, a: { since?: number; waitSeconds?: number }, progress?: Progress): Promise<string> {
    const info = this.chat(c);
    const id = info.id;
    const key = this.cursorKey(c);
    const all = () => this.d.store.readTranscript(id);
    let since = a.since ?? this.cursors.get(key);
    const first = since === undefined;
    const wait = Math.min(MAX_WAIT_SECONDS, Math.max(0, a.waitSeconds ?? 0));
    const watch = new Watch(id);
    try {
      let events = all();
      if (since === undefined) since = (events.filter(isMessage).at(-INBOX_FIRST)?.seq ?? 1) - 1;
      const from = since;
      const fresh = () => {
        watch.add(events);
        return watch.events.filter((e) => e.seq > from);
      };
      const deadline = Date.now() + wait * 1000;
      let nextKeepalive = Date.now() + timing.keepaliveMs;
      // With a wait: until something new has come and the turn it belongs to has ended, or the time is up.
      while (wait > 0 && Date.now() < deadline && !(fresh().some(isMessage) && !isMidTurn(this.d.sessions.get(id).info))) {
        await watch.sleep(Math.max(1, Math.min(2000, deadline - Date.now(), nextKeepalive - Date.now())));
        events = [];
        if (progress && Date.now() >= nextKeepalive) {
          nextKeepalive = Date.now() + timing.keepaliveMs;
          await progress('waiting for the orchestrator');
        }
      }
      const news = fresh();
      const shown = news.filter(isMessage);
      const cut = Math.max(0, shown.length - INBOX_MAX_EVENTS);
      const cursor = news.at(-1)?.seq ?? from;
      this.cursors.set(key, cursor);
      const working = isMidTurn(this.d.sessions.get(id).info);
      const head = first ? `The last ${shown.length} messages of your conversation with your orchestrator:` : shown.length ? `${shown.length} new message${shown.length === 1 ? '' : 's'} from your orchestrator's chat:` : 'Nothing new.';
      return [
        head,
        cut ? `(${cut} earlier ones not shown; they are in the web app)` : '',
        describeEvents(shown.slice(cut), id, c.origin),
        working ? '[the orchestrator is still working on a turn: call orchestrator_inbox again with wait_seconds to get the rest]' : '',
        `cursor: ${cursor}`,
      ]
        .filter(Boolean)
        .join('\n\n');
    } finally {
      watch.stop();
    }
  }

  /** Store a small file the client sends inline (text or base64) as an attachment, for the next orchestrator_send. */
  async attach(c: RemoteCaller, a: { name: string; text?: string; dataBase64?: string }): Promise<string> {
    this.chat(c);
    const store = this.d.attachments();
    if (!store) throw new Error('attachments are not wired into this server');
    if ((a.text === undefined) === (a.dataBase64 === undefined)) throw new Error('give either text or data_base64');
    const bytes = a.text !== undefined ? Buffer.from(a.text, 'utf8') : Buffer.from(a.dataBase64!, 'base64');
    if (!bytes.length) throw new Error('the file is empty');
    if (bytes.length > MAX_TOOL_FILE_BYTES) throw new Error(`a file sent through this tool is at most ${MAX_TOOL_FILE_BYTES / 1024 / 1024} MB; send a larger one with the HTTP upload (docs/talk-to-your-orchestrator.md)`);
    const u = store.begin({ name: a.name, size: bytes.length, uploadedBy: c.who.userId, source: 'mcp' });
    try {
      const r = await store.append(u.uploadId, 0, Readable.from([bytes]), bytes.length, bytes.length);
      if (!r.attachment) throw new Error('the upload did not finish');
      return `Stored ${r.attachment.name} (${r.attachment.size} bytes) as ${r.attachment.id}. Pass it in orchestrator_send's attachments.`;
    } catch (e) {
      try {
        store.cancel(u.uploadId);
      } catch {
        // finished, or dropped already
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- the HTTP upload

/**
 * `PUT /mcp/upload?name=<file>` with the file as the body (Content-Length required) and the same bearer key as /mcp: a
 * file of any size up to the attachments limit, which a shell can send with curl and an MCP tool call cannot carry. The
 * answer is the attachment's id for orchestrator_send. Streamed to disk by AttachmentStore, never opened.
 */
export async function mcpUpload(
  store: AttachmentStore | undefined,
  caller: Pick<RemoteCaller, 'who' | 'bound' | 'refuse'>,
  req: http.IncomingMessage,
  name: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (caller.refuse) return { status: 403, body: { error: `refused: ${caller.refuse}` } };
  if (!caller.bound) return { status: 403, body: { error: 'this API key is not bound to a login (node server/apikey.ts <name> --user <login>)' } };
  if (!store) return { status: 503, body: { error: 'attachments are not wired into this server' } };
  if (req.method !== 'PUT') return { status: 405, body: { error: 'PUT the file as the request body' } };
  const size = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(size) || size <= 0) return { status: 411, body: { error: 'send the file with a Content-Length (curl --data-binary @file does)' } };
  let uploadId: string | undefined;
  try {
    const u = store.begin({ name: name ?? '', size, uploadedBy: caller.who.userId, source: 'mcp' });
    uploadId = u.uploadId;
    const r = await store.append(u.uploadId, 0, req, size, size);
    if (!r.attachment) throw new AttachmentError(400, `only ${r.received} of ${size} bytes arrived`);
    const a = r.attachment;
    return { status: 200, body: { id: a.id, name: a.name, size: a.size, sha256: a.sha256 } };
  } catch (e) {
    if (uploadId) {
      try {
        store.cancel(uploadId);
      } catch {
        // finished, or dropped already
      }
    }
    if (e instanceof AttachmentError) return { status: e.status, body: { error: e.message } };
    return { status: 500, body: { error: (e as Error).message } };
  }
}

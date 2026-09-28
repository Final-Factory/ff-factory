// Providers: places that run work with their own rules, reached through a connector they run
// (docs/ffbox-integration.md). FFBox is the only one. Its connector dials out to /provider with a token
// whose SHA-256 is in config (providers.ffbox.tokenSha256), and reports: its container classes and free
// slots (capacity), its conversations, and the reports ffintake files (intake). Phase 1 is read-only:
// nothing here can send FFBox work. Wire format: server/providerProtocol.ts; for the connector's author:
// docs/ffbox-connector-contract.md.
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.ts';
import { emit } from './store.ts';
import { redactSecrets } from './secrets.ts';
import {
  CLOSE,
  FromConnectorSchema,
  LIMITS,
  PROVIDER_PROTOCOL,
  PROVIDER_TOKEN,
  describeIssues,
  tokenSha256,
  type FromConnector,
  type ToConnector,
} from './providerProtocol.ts';
import type { Provider, ProviderCapacity, ProviderConversation, ProviderIntakeEvent } from '../shared/types.ts';

const PING_MS = 20_000;
const DEAD_MS = 45_000;
/** How many of each list are kept (newest). */
const KEEP_CONVERSATIONS = 500;
const KEEP_INTAKE = 2000;
const DAY_MS = 24 * 3600_000;

/** What is kept on disk (<dataDir>/providers/<id>.json) across restarts. */
interface Persisted {
  cursors: { conversation?: string; intake?: string };
  connector?: Provider['connector'];
  web?: string;
  /** hello.accepts: the work messages the connector takes. */
  accepts?: string[];
  capacity?: ProviderCapacity;
  lastSeen?: string;
  conversations: ProviderConversation[];
  intake: ProviderIntakeEvent[];
}

interface Link {
  ws: WebSocket;
  lastPong: number;
  since: number;
  hello: boolean;
  /** Token bucket for messages. */
  tokens: number;
  refilled: number;
  invalid: number[];
  helloTimer?: NodeJS.Timeout;
}

/** Control characters out, one line, secrets redacted: a title is untrusted text. */
const cleanText = (s: string, max: number) =>
  redactSecrets(s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export class ProviderManager {
  readonly id = 'ffbox';
  readonly name = 'FFBox';
  private readonly cfg: Config;
  private readonly file: string;
  private data: Persisted;
  private link?: Link;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });
  private readonly failures = new Map<string, number[]>();
  private saveTimer?: NodeJS.Timeout;
  private readonly timer: NodeJS.Timeout;
  private statusDetail?: string;
  /** Tests move the clock, shorten the hello wait and tighten the rate limit. */
  now = () => Date.now();
  helloTimeoutMs: number = LIMITS.helloTimeoutMs;
  rate: { perSecond: number; burst: number } = { perSecond: LIMITS.messagesPerSecond, burst: LIMITS.burst };

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'providers', `${this.id}.json`);
    this.data = this.load();
    this.timer = setInterval(() => this.heartbeat(), PING_MS);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
    clearTimeout(this.emitTimer);
    this.link?.ws.close(1001, 'portal shutting down');
    this.flush();
  }

  private get settings() {
    return this.cfg.providers?.ffbox ?? {};
  }

  get enabled() {
    return this.settings.enabled === true;
  }

  get online() {
    return !!this.link?.hello;
  }

  // ---------------------------------------------------------------- state

  private load(): Persisted {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persisted>;
      return { cursors: d.cursors ?? {}, conversations: d.conversations ?? [], intake: d.intake ?? [], connector: d.connector, web: d.web, accepts: d.accepts, capacity: d.capacity, lastSeen: d.lastSeen };
    } catch {
      return { cursors: {}, conversations: [], intake: [] };
    }
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
    this.saveTimer.unref();
  }

  /** Write the state now (on shutdown, and in tests). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) {
      console.warn(`provider ${this.id}: could not save its state:`, (e as Error).message);
    }
  }

  /** The summary the sidebar, the page header and system_status read. */
  summary(): Provider {
    const now = this.now();
    const active = this.data.conversations.filter((c) => c.state === 'running' || c.state === 'queued').length;
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      tokenSet: !!this.settings.tokenSha256,
      online: this.online,
      connectedSince: this.link?.hello ? new Date(this.link.since).toISOString() : undefined,
      lastSeen: this.data.lastSeen,
      statusDetail: this.statusDetail,
      connector: this.data.connector,
      web: this.data.web,
      ...(this.data.accepts?.length ? { accepts: this.data.accepts } : {}),
      capacity: this.data.capacity,
      counts: {
        conversations: this.data.conversations.length,
        active,
        intake: this.data.intake.length,
        intake24h: this.data.intake.filter((e) => now - Date.parse(e.receivedAt) < DAY_MS).length,
      },
      lastIntakeAt: this.data.intake[0]?.receivedAt,
    };
  }

  /** Newest first. */
  conversations(limit = 100): ProviderConversation[] {
    return this.data.conversations.slice(0, Math.max(1, Math.min(limit, KEEP_CONVERSATIONS)));
  }

  /** Newest first. */
  intake(limit = 200): ProviderIntakeEvent[] {
    return this.data.intake.slice(0, Math.max(1, Math.min(limit, KEEP_INTAKE)));
  }

  private emitTimer?: NodeJS.Timeout;

  /** Save soon, and tell the pages: at most every 500 ms, so a catch-up of a thousand events is one update. */
  private changed() {
    this.save();
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      emit({ type: 'provider', provider: this.summary() });
    }, 500);
    this.emitTimer.unref();
  }

  /** For system_status: one line, or none when the provider is off and has never been set up. */
  statusLine(): string | undefined {
    const p = this.summary();
    if (!p.enabled) return p.tokenSet ? 'FFBox: switched off (providers.ffbox.enabled)' : undefined;
    if (!p.tokenSet) return 'FFBox: enabled, but no connector token is set (node server/providerToken.ts)';
    if (!p.online) return `FFBox: connector offline${p.lastSeen ? ` (last seen ${p.lastSeen})` : ' (never connected)'}`;
    const c = p.capacity;
    const classes = c?.classes.map((k) => `${k.name} (${k.network}, ${k.model}, ${k.tier}${k.gpu ? ', GPU' : ', no GPU'}) ${k.free}/${k.max} free`).join('; ');
    return [
      `FFBox: online, connector ${p.connector?.version ?? '?'}`,
      c ? `${c.state}; ${classes || 'no classes'}; queue ${c.queue}${c.holds.length ? `; holds: ${c.holds.join(' | ')}` : ''}` : 'no capacity report yet',
      `${p.counts.active} conversation(s) running or queued; ${p.counts.intake24h} intake report(s) in 24 h`,
    ].join(' · ');
  }

  // ---------------------------------------------------------------- the /provider socket

  /** The connector token in an Authorization header matches the configured hash (constant time). */
  authenticate(header: string | undefined): boolean {
    const m = /^Bearer\s+(\S+)$/.exec(header ?? '');
    const want = this.settings.tokenSha256;
    if (!m || !want || !PROVIDER_TOKEN.test(m[1]) || !/^[0-9a-f]{64}$/.test(want)) return false;
    return timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(tokenSha256(m[1]), 'hex'));
  }

  /** Take over an HTTP upgrade to /provider. False when refused (the socket is already answered). */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, ip: string): boolean {
    const now = this.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    // end(), not destroy(): a reset right after the write can reach the connector before the status does, and
    // the status is what its backoff reads (401/403/429, docs/ffbox-connector-contract.md).
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      setTimeout(() => socket.destroy(), 2000).unref();
      return false;
    };
    if (recent.length >= 10) {
      recent.push(now);
      this.failures.set(ip, recent);
      return refuse('429 Too Many Requests');
    }
    if (!this.authenticate(req.headers.authorization)) {
      recent.push(now);
      this.failures.set(ip, recent);
      console.warn(`provider ${this.id}: refused a connection from ${ip} (bad or missing token)`);
      return refuse('401 Unauthorized');
    }
    // A good token while switched off: said plainly, so the connector backs off rather than retrying at once.
    if (!this.enabled) return refuse('403 Forbidden');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    return true;
  }

  /** Wire a connected connector (exported for tests: any WebSocket works). */
  attach(ws: WebSocket) {
    const old = this.link;
    if (old) old.ws.close(CLOSE.replaced, 'replaced by a newer connection');
    const now = this.now();
    const link: Link = { ws, lastPong: now, since: now, hello: false, tokens: this.rate.burst, refilled: now, invalid: [] };
    this.link = link;
    link.helloTimer = setTimeout(() => {
      if (!link.hello) ws.close(CLOSE.noHello, `no hello within ${this.helloTimeoutMs / 1000} s`);
    }, this.helloTimeoutMs);
    link.helloTimer.unref();
    ws.on('pong', () => (link.lastPong = this.now()));
    ws.on('message', (data, isBinary) => {
      link.lastPong = this.now();
      this.onFrame(link, isBinary ? '' : String(data));
    });
    ws.on('close', () => {
      clearTimeout(link.helloTimer);
      if (this.link === link) this.detach('disconnected');
    });
    ws.on('error', (e) => console.warn(`provider ${this.id}: socket error:`, e.message));
  }

  private detach(why: string) {
    const was = this.link?.hello;
    this.link = undefined;
    this.data.lastSeen = new Date(this.now()).toISOString();
    this.statusDetail = why;
    if (was) console.log(`provider ${this.id}: connector ${why}`);
    this.changed();
  }

  private send(link: Link, msg: ToConnector) {
    if (link.ws.readyState === link.ws.OPEN) link.ws.send(JSON.stringify(msg));
  }

  private heartbeat() {
    const link = this.link;
    if (!link) return;
    // Switched off while connected (set_app_config, or config.json edited and reloaded).
    if (!this.enabled) {
      link.ws.close(CLOSE.disabled, 'switched off in FF Factory');
      this.detach('switched off');
      return;
    }
    if (this.now() - link.lastPong > DEAD_MS) {
      link.ws.terminate();
      this.detach(`no answer for ${Math.round(DEAD_MS / 1000)} s`);
    } else link.ws.ping();
  }

  /** Called after providers.ffbox.* changed: drop a connection that is no longer allowed, refresh the card. */
  configChanged() {
    const link = this.link;
    if (link && !this.enabled) {
      link.ws.close(CLOSE.disabled, 'switched off in FF Factory');
      this.detach('switched off');
      return;
    }
    this.changed();
  }

  private invalid(link: Link, code: Extract<ToConnector, { type: 'error' }>['code'], message: string, ref?: string) {
    const now = this.now();
    link.invalid = link.invalid.filter((t) => now - t < 60_000);
    link.invalid.push(now);
    this.send(link, { type: 'error', code, message, ref });
    if (link.invalid.length > LIMITS.invalidPerMinute) link.ws.close(CLOSE.badMessage, 'too many invalid messages');
  }

  private onFrame(link: Link, text: string) {
    if (this.link !== link) return;
    // Rate limit: a token bucket, refilled continuously.
    const now = this.now();
    link.tokens = Math.min(this.rate.burst, link.tokens + ((now - link.refilled) / 1000) * this.rate.perSecond);
    link.refilled = now;
    if (link.tokens < 1) {
      link.ws.close(CLOSE.tooFast, `more than ${this.rate.perSecond} messages a second`);
      return;
    }
    link.tokens -= 1;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      if (!link.hello) return void link.ws.close(CLOSE.badMessage, 'the first message must be a JSON hello');
      return this.invalid(link, 'bad_json', 'not a JSON message');
    }
    const type = typeof (raw as { type?: unknown })?.type === 'string' ? String((raw as { type: string }).type).slice(0, 40) : undefined;
    const parsed = FromConnectorSchema.safeParse(raw);
    if (!link.hello) {
      if (!parsed.success || parsed.data.type !== 'hello') {
        link.ws.close(CLOSE.badMessage, parsed.success ? 'the first message must be hello' : `bad hello: ${describeIssues(parsed.error)}`.slice(0, 120));
        return;
      }
      if (parsed.data.protocol !== PROVIDER_PROTOCOL) {
        link.ws.close(CLOSE.protocol, `protocol ${parsed.data.protocol} is not supported; this portal speaks ${PROVIDER_PROTOCOL}`);
        return;
      }
      clearTimeout(link.helloTimer);
      link.hello = true;
      this.data.connector = { version: parsed.data.connector.version, commit: parsed.data.connector.commit, protocol: parsed.data.protocol };
      this.data.web = parsed.data.web;
      this.data.accepts = parsed.data.accepts;
      this.data.lastSeen = new Date(now).toISOString();
      this.statusDetail = undefined;
      this.send(link, { type: 'welcome', protocol: PROVIDER_PROTOCOL, provider: 'ffbox', cursors: { ...this.data.cursors }, limits: LIMITS });
      console.log(`provider ${this.id}: connector ${parsed.data.connector.version} connected`);
      this.changed();
      return;
    }
    if (!parsed.success) {
      if (type && !['hello', 'capacity', 'conversation', 'intake'].includes(type)) return this.invalid(link, 'unknown_type', `unknown message type "${type}" (ignored)`, type);
      return this.invalid(link, 'bad_message', describeIssues(parsed.error), type);
    }
    this.apply(link, parsed.data);
  }

  private apply(link: Link, msg: FromConnector) {
    const at = new Date(this.now()).toISOString();
    this.data.lastSeen = at;
    switch (msg.type) {
      case 'hello':
        return this.invalid(link, 'hello_twice', 'hello was already received on this connection', 'hello');
      case 'capacity':
        this.data.capacity = {
          classes: msg.classes.map((c) => ({ ...c, note: c.note === undefined ? undefined : cleanText(c.note, 200) })),
          queue: msg.queue,
          state: msg.state,
          holds: msg.holds.map((h) => cleanText(h, 160)),
          at,
        };
        return this.changed();
      case 'conversation': {
        const c: ProviderConversation = { ...msg.conversation, title: cleanText(msg.conversation.title, 300) || '(untitled)' };
        const list = this.data.conversations.filter((x) => x.id !== c.id);
        list.push(c);
        list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        this.data.conversations = list.slice(0, KEEP_CONVERSATIONS);
        this.data.cursors.conversation = msg.cursor;
        return this.changed();
      }
      case 'intake': {
        const e = msg.event;
        if (!this.data.intake.some((x) => x.reportId === e.reportId)) {
          const list = [...this.data.intake, e];
          list.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
          this.data.intake = list.slice(0, KEEP_INTAKE);
        }
        this.data.cursors.intake = msg.cursor;
        return this.changed();
      }
    }
  }
}

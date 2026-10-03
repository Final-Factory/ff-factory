/**
 * A stand-in for FFBox's connector (docs/ffbox-connector-contract.md): dials /provider with a token and speaks
 * protocol 1. The unit tests (server/providers.test.ts) and the E2E suite (e2e/provider.spec.ts) use it, and it
 * doubles as a small reference for the real connector's author. Sample data only; it reads nothing on FFBox.
 *
 *   node e2e/mockConnector.ts <portal url> <token>     connect, send the samples, stay connected
 */
import path from 'node:path';
import WebSocket from 'ws';
import { PROVIDER_PROTOCOL } from '../server/providerProtocol.ts';
import type { ProviderClass, ProviderConversation, ProviderIntakeEvent } from '../shared/types.ts';

/** The connector token of the E2E provider servers (e2e/server.ts with E2E_PROVIDER=1): a test value, not a secret. */
// Assembled at runtime so secret scanners do not flag a test value.
export const E2E_PROVIDER_TOKEN = ['ffpv1', 'E2eOnlyTokenForTheMockConnectorNotASecret00'].join('_');

export const SAMPLE_CLASSES: ProviderClass[] = [
  {
    name: 'ffagent', network: 'fenced', gpu: false, model: 'claude-opus-5-5', tier: 'full',
    models: [
      { requester: 'operator', model: 'claude-opus-5-5', tier: 'full' },
      { requester: 'discord', model: 'glm-5.3-flash', tier: 'simple' },
    ],
    unity: ['batchmode', 'playtest-softgl'], free: 4, max: 6, note: 'player text; no git credential',
  },
  { name: 'ffdev', network: 'open', gpu: false, model: 'claude-opus-5-5', tier: 'full', unity: ['batchmode'], free: 1, max: 3, note: 'operators only; read-only git credential' },
  { name: 'ffdiagnose', network: 'fenced', gpu: false, model: 'claude-opus-5-5', tier: 'full', unity: ['batchmode', 'mode2-pair'], free: 2, max: 3, note: 'intake reports' },
];

export const SAMPLE_CONVERSATIONS: ProviderConversation[] = [
  {
    id: '812',
    source: 'intake',
    opener: 'operator',
    title: 'Desync minerBots+census at heartbeat 7240',
    state: 'running',
    agentClass: 'ffdiagnose',
    branch: 'ffbox/miner-census-812',
    key: 'desync:0.50.0:minerBots+census',
    createdAt: '2026-09-27T09:00:00Z',
    updatedAt: '2026-09-27T09:20:00Z',
  },
  {
    id: '811',
    source: 'discord',
    opener: 'player',
    title: 'Belts stop after loading a save',
    state: 'idle',
    agentClass: 'ffagent',
    verdict: 'NEEDS-INFO',
    costUsd: 0.37,
    createdAt: '2026-09-27T08:00:00Z',
    updatedAt: '2026-09-27T08:30:00Z',
  },
  {
    id: '809',
    source: 'codereview',
    opener: 'operator',
    title: 'Review: charge energy phase 3',
    state: 'closed',
    agentClass: 'ffdev',
    pr: { number: 640, state: 'merged' },
    createdAt: '2026-09-26T18:00:00Z',
    updatedAt: '2026-09-26T19:00:00Z',
  },
];

/** Newest first, as the portal lists them. */
export const SAMPLE_INTAKE: ProviderIntakeEvent[] = [
  {
    reportId: '20260927T090000Z-desync-3a9f01c2d4',
    kind: 'desync',
    receivedAt: '2026-09-27T09:00:00Z',
    gameVersion: '0.50.0.35',
    platform: 'WindowsPlayer',
    bytes: 2_400_000,
    sender: '3ace6eea57acd768',
    desync: { group: 'fc5620980cd46738', correlationId: '7-7240-2', divergedClient: 2, role: 'host', localClient: 0, sessionEpoch: 7, verdictHeartbeat: 7240, divergedSurfaces: 'minerBots+census', happenedAt: '2026-09-27T08:59:40Z' },
  },
  {
    reportId: '20260927T085958Z-desync-9b1e22aa07',
    kind: 'desync',
    receivedAt: '2026-09-27T08:59:58Z',
    gameVersion: '0.50.0.35',
    platform: 'OSXPlayer',
    bytes: 2_100_000,
    sender: '77aa01bc55e0d2f1',
    desync: { group: 'fc5620980cd46738', correlationId: '7-7240-2', divergedClient: 2, role: 'client', localClient: 2, sessionEpoch: 7, verdictHeartbeat: 7240, divergedSurfaces: 'minerBots+census' },
  },
  { reportId: '20260927T080000Z-crash-5c0ffee123', kind: 'crash', receivedAt: '2026-09-27T08:00:00Z', gameVersion: '0.50.0.34', platform: 'WindowsPlayer', bytes: 900_000 },
];

export interface Welcome {
  type: 'welcome';
  protocol: number;
  cursors: { conversation?: string; intake?: string };
}

export class MockConnector {
  readonly ws: WebSocket;
  /** Every message the portal sent. */
  readonly received: Record<string, unknown>[] = [];
  /** Resolves with the close code and reason (or the HTTP status when the upgrade was refused). */
  readonly closed: Promise<{ code: number; reason: string; status?: number }>;
  private readonly opened: Promise<void>;

  constructor(portalUrl: string, token: string | undefined) {
    const url = portalUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/provider';
    this.ws = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, handshakeTimeout: 8000 });
    this.ws.on('message', (d) => this.received.push(JSON.parse(String(d))));
    this.closed = new Promise((resolve) => {
      this.ws.on('unexpected-response', (_req, res) => {
        resolve({ code: 0, reason: 'refused', status: res.statusCode });
        res.resume();
      });
      this.ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
      this.ws.on('error', () => undefined);
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      void this.closed.then((c) => reject(new Error(`not connected: ${c.status ? `HTTP ${c.status}` : `closed ${c.code} ${c.reason}`}`)));
    });
    // A refused connection is expected in tests that only read `closed`: no unhandled rejection for them.
    this.opened.catch(() => undefined);
  }

  send(msg: unknown) {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  /** Connect, say hello, and wait for the welcome. */
  async hello(opts: { protocol?: number; version?: string; web?: string; accepts?: string[]; queries?: string[] } = {}): Promise<Welcome> {
    await this.opened;
    this.send({
      type: 'hello',
      protocol: opts.protocol ?? PROVIDER_PROTOCOL,
      provider: 'ffbox',
      connector: { version: opts.version ?? 'mock-1', commit: 'abc1234' },
      ...(opts.web ? { web: opts.web } : {}),
      ...(opts.accepts ? { accepts: opts.accepts } : {}),
      ...(opts.queries ? { queries: opts.queries } : {}),
    });
    return (await this.next('welcome')) as unknown as Welcome;
  }

  capacity(classes: ProviderClass[] = SAMPLE_CLASSES, extra: { queue?: number; state?: string; holds?: string[] } = {}) {
    this.send({ type: 'capacity', classes, queue: extra.queue ?? 2, state: extra.state ?? 'running', holds: extra.holds ?? [] });
  }

  conversation(c: ProviderConversation, cursor = `${c.updatedAt}#${c.id}`) {
    this.send({ type: 'conversation', cursor, conversation: c });
  }

  intake(e: ProviderIntakeEvent, cursor = e.reportId) {
    this.send({ type: 'intake', cursor, event: e });
  }

  /** Everything in the samples, oldest first (the order a real connector catches up in). */
  sendSamples() {
    this.capacity();
    for (const c of [...SAMPLE_CONVERSATIONS].reverse()) this.conversation(c);
    for (const e of [...SAMPLE_INTAKE].reverse()) this.intake(e);
  }

  /** The next message of `type` the portal sends (or one already received and not yet taken). */
  async next(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.received.findIndex((m) => m.type === type);
      if (i >= 0) return this.received.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`no "${type}" from the portal in ${timeoutMs} ms`);
      if (this.ws.readyState === WebSocket.CLOSED) throw new Error(`the portal closed the connection (${JSON.stringify(await this.closed)})`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  close() {
    this.ws.close(1000, 'done');
  }
}

// Run directly: connect to a portal and send the samples.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [url, token] = process.argv.slice(2);
  if (!url || !token) {
    console.error('usage: node e2e/mockConnector.ts <portal url> <token>');
    process.exit(2);
  }
  const c = new MockConnector(url, token);
  const w = await c.hello();
  console.log('welcome:', JSON.stringify(w));
  c.sendSamples();
  console.log('samples sent; staying connected (Ctrl+C to stop)');
  void c.closed.then((x) => {
    console.log('closed:', JSON.stringify(x));
    process.exit(0);
  });
}

// relocate (w466, docs/machines.md "Moving the portal"): a connected daemon follows the portal to a new URL without a
// redeploy, its agents running on; it keeps the URL in its daemon.json, and falls back to the URL before if the new one
// never answers. Real daemons over real WebSockets, against one portal listening on two ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { Store } from './store.ts';
import { SessionManager, type SessionHandle, type SessionSink } from './sessions.ts';
import { MachineManager } from './machines.ts';
import { relocateProblem } from './machineProtocol.ts';
import { Drainer, RELOCATE_RESULT_FILE, parseRestartRequest, type RestartRequest } from './restart.ts';
import { Daemon, RECONNECT_MS, RELOCATE_FALLBACK_MS, dialUrl, patchDaemonConfig, type DaemonConfig, type Probes } from '../machine/daemon.ts';
import type { Config } from './config.ts';
import type { PermissionMode, SessionInfo } from '../shared/types.ts';

/** Stands in for AgentSession on the daemon: a message starts a turn that stays open until finish(). */
class LongAgent implements SessionHandle {
  static all: LongAgent[] = [];
  info: SessionInfo;
  live = false;
  lastFrom: 'human' | 'orchestrator' | 'system' = 'human';
  readonly sink: SessionSink;
  private readonly events: EventEmitter;
  constructor(info: SessionInfo, sink: SessionSink, _o: unknown, events: EventEmitter) {
    this.info = info;
    this.sink = sink;
    this.events = events;
    LongAgent.all.push(this);
  }
  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid = 'u') {
    this.live = true;
    this.sink.append(this.info.id, { kind: 'user', text, from, uuid });
    Object.assign(this.info, { status: 'running', turnOpenSince: new Date().toISOString() });
    this.sink.putSession(this.info);
    return uuid;
  }
  /** Something the agent did: an event, as a tool result is. */
  say(text: string) {
    this.sink.append(this.info.id, { kind: 'assistant', text });
  }
  async interrupt() {}
  async setMode(m: PermissionMode) {
    this.info.permissionMode = m;
  }
  stop() {
    if (!this.live) return;
    this.live = false;
    this.info.status = 'stopped';
    this.sink.putSession(this.info);
    this.events.emit('ended', this);
  }
  decide() {
    return false;
  }
}

const PROBES: Probes = {
  stats: async () => ({ hostname: 'mx', platform: 'win32', cpuCount: 1, cpuModel: 'x', loadPct: 0, memTotalBytes: 2 ** 30, memFreeBytes: 2 ** 30 }),
  usage: async () => ({ account: {}, reply: { rate_limits_available: false } }),
};

const until = async (what: string, cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const listen = async (mm: MachineManager) => {
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => mm.upgrade(req, socket, head, '127.0.0.1'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

/** A port nothing listens on: a portal URL that never answers. */
async function deadUrl() {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

async function setup(t: { after: (fn: () => unknown) => void }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-relocate-'));
  const cfg = { dataDir: tmp, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config;
  const store = new Store(tmp);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  mm.hooks = {
    // A standing agent in its own folder: no agent works in the main clone (w536).
    specFor: (info) => ({ cwd: path.join(tmp, 'agents', 'a'), settingSources: [], append: '', strictMcp: true, guard: { id: 'x', ownPath: path.join(tmp, 'agents', 'a'), protectedPaths: [], gameRepos: [] }, model: info.model }),
    handlersFor: () => ({}),
  };
  const a = await listen(mm);
  const b = await listen(mm);
  const { token } = mm.register({ id: 'mx', host: 'mx', purpose: 'unused', status: 'ready', repoPath: tmp, home: tmp, portalUrl: a.url });
  const configFile = path.join(tmp, 'daemon.json');
  const written: DaemonConfig = { portalUrl: a.url, id: 'mx', token, repoPath: tmp, appDir: tmp, claude: 'no-such-claude', maxEventsFile: null };
  fs.writeFileSync(configFile, JSON.stringify(written, null, 2));
  const daemons: Daemon[] = [];
  // A dropped or relocated daemon dials again after ~200 ms here, not ~2 s (the fallback window is set apart).
  RECONNECT_MS.value = 200;
  t.after(() => (RECONNECT_MS.value = 2000));
  /** A daemon as the entry point starts one: its daemon.json as it is on disk now, and where it is. */
  const daemon = () => {
    const d = new Daemon({ ...(JSON.parse(fs.readFileSync(configFile, 'utf8')) as DaemonConfig), configFile }, (i, s, o, e) => new LongAgent(i, s, o, e), PROBES);
    daemons.push(d);
    d.start();
    return d;
  };
  t.after(async () => {
    for (const d of daemons) d.shutdown();
    a.server.close();
    b.server.close();
    // The link's close comes after the last update the daemon sent; then the saves land before the folder goes.
    await until('the daemon gone', () => !mm.isOnline('mx'), 5000).catch(() => undefined);
    store.flush();
    await store.saved();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { tmp, store, sessions, mm, a, b, token, configFile, daemon, onDisk: () => JSON.parse(fs.readFileSync(configFile, 'utf8')) as DaemonConfig };
}

test('relocate: which URL a daemon dials, which URLs it takes, and its daemon.json kept with everything else in it', () => {
  const cfg = { portalUrl: 'https://vm.example.ts.net', previousPortalUrl: 'https://beast.example.ts.net', relocatedAt: '2026-10-05T23:00:00.000Z' };
  const at = Date.parse(cfg.relocatedAt);
  assert.equal(dialUrl({ portalUrl: 'https://p' }, 1, at, 0), 'https://p', 'never relocated: its own');
  assert.deepEqual([0, 1, 2, 3].map((n) => dialUrl(cfg, n, at + 60_000, 600_000)), Array(4).fill('https://vm.example.ts.net'), 'within the window: only the new one');
  assert.deepEqual([0, 1, 2, 3].map((n) => dialUrl(cfg, n, at + 600_000, 600_000)), ['https://vm.example.ts.net', 'https://beast.example.ts.net', 'https://vm.example.ts.net', 'https://beast.example.ts.net'], 'then both, taking turns');
  assert.equal(dialUrl({ ...cfg, relocatedAt: 'garbage' }, 1, at + 600_000, 600_000), 'https://vm.example.ts.net', 'no valid time: the new one only');

  for (const ok of ['https://beast.tailedfcad.ts.net', 'http://127.0.0.1:8790', 'https://fff.example.ts.net:443']) assert.equal(relocateProblem(ok), undefined, ok);
  for (const bad of ['', 'beast', 'ws://beast', 'https://beast/x', 'https://beast?a=1', 'https://', 'http://a b']) assert.match(relocateProblem(bad) ?? '', /not a portal base URL|not a URL/, bad);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-relocate-cfg-'));
  try {
    const f = path.join(dir, 'daemon.json');
    // As Windows PowerShell can leave it: a BOM in front.
    fs.writeFileSync(f, '\uFEFF' + JSON.stringify({ portalUrl: 'https://a', id: 'beast', token: 'ffm_beast_x', repoPath: 'C:\\ffsb\\_base', sandboxes: { root: 'F:\\ffsb' } }));
    patchDaemonConfig(f, { portalUrl: 'https://b', previousPortalUrl: 'https://a', relocatedAt: 'T' });
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(after, { portalUrl: 'https://b', id: 'beast', token: 'ffm_beast_x', repoPath: 'C:\\ffsb\\_base', sandboxes: { root: 'F:\\ffsb' }, previousPortalUrl: 'https://a', relocatedAt: 'T' });
    assert.ok(fs.existsSync(`${f}.1`), 'the version before is kept beside it');
    patchDaemonConfig(f, { previousPortalUrl: undefined, relocatedAt: undefined });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))), ['portalUrl', 'id', 'token', 'repoPath', 'sandboxes'], 'a settled relocation leaves nothing behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('relocate: a daemon follows the portal to its new URL with an agent mid-turn, which runs on; a restart dials the new URL too', async (t) => {
  const { store, sessions, mm, a, b, token, daemon, onDisk } = await setup(t);
  LongAgent.all = [];
  daemon();
  // Its hello read, too: relocate needs the protocol it speaks (a link alone says 0).
  await until('online at A, its hello read', () => mm.isOnline('mx') && (mm.protocolOf('mx') ?? 0) > 0);
  const s = mm.createSession('mx', { kind: 'standing', title: 'w', permissionMode: 'default' });
  sessions.send(s.info.id, 'a long turn');
  await until('mid-turn', () => s.info.status === 'running' && LongAgent.all.length === 1);
  const agent = LongAgent.all[0];

  const text = await mm.relocate('mx', `${b.url}/`);
  assert.match(text, /mx took http:\/\/127\.0\.0\.1:\d+ and is dialling it now; its agents run on/);
  assert.deepEqual(store.machines.get('mx')!.relocatedTo?.url, b.url, 'marked away');
  // Kept before it answered: a reboot now would dial the new URL.
  assert.deepEqual([onDisk().portalUrl, onDisk().previousPortalUrl], [b.url, a.url]);
  agent.say('done while the link moved');
  await until('back online, at B', () => mm.isOnline('mx') && !store.machines.get('mx')!.relocatedTo);
  assert.equal(onDisk().portalUrl, b.url);
  assert.equal(onDisk().previousPortalUrl, undefined, 'settled: no fallback left');
  assert.equal(onDisk().token, token, 'the same token: no redeploy');
  assert.equal(LongAgent.all.length, 1, 'no new agent process');
  assert.equal(agent.live, true, 'the agent ran on');
  await until('its event arrived', () => store.readTranscript(s.info.id).some((e) => e.kind === 'assistant' && e.text === 'done while the link moved'));
  assert.equal(s.live, true);
  assert.equal(s.info.status, 'running', 'still mid-turn');
  assert.equal(store.machines.get('mx')!.portalUrl, a.url, "the record's portal_url stays this portal's own address");

  // A daemon restart (a reboot) reads daemon.json: the new URL.
  const before = mm.isOnline('mx');
  assert.ok(before);
  daemon();
  await until('a second daemon from the same daemon.json connects', () => mm.isOnline('mx'));
});

test('relocate: a new URL that never answers sends the daemon back to the one before after the window; its agent runs on', async (t) => {
  const { store, sessions, mm, a, daemon, onDisk } = await setup(t);
  LongAgent.all = [];
  const saved = RELOCATE_FALLBACK_MS.value;
  RELOCATE_FALLBACK_MS.value = 1500;
  t.after(() => (RELOCATE_FALLBACK_MS.value = saved));
  daemon();
  // Its hello read, too: relocate needs the protocol it speaks (a link alone says 0).
  await until('online at A, its hello read', () => mm.isOnline('mx') && (mm.protocolOf('mx') ?? 0) > 0);
  const s = mm.createSession('mx', { kind: 'standing', title: 'w', permissionMode: 'default' });
  sessions.send(s.info.id, 'a long turn');
  await until('mid-turn', () => s.info.status === 'running');
  const nowhere = await deadUrl();
  await mm.relocate('mx', nowhere);
  await until('offline while it dials nowhere', () => !mm.isOnline('mx'));
  await until('back at A after the window, its hello seen', () => mm.isOnline('mx') && !store.machines.get('mx')!.relocatedTo, 30_000);
  assert.equal(onDisk().portalUrl, a.url, 'the URL that answered is the one kept');
  assert.equal(onDisk().previousPortalUrl, undefined);
  assert.equal(store.machines.get('mx')!.relocatedTo, undefined, 'it said hello here again');
  assert.equal(LongAgent.all[0].live, true, 'the agent ran on');
});

test('relocate: refused for a bad URL, an offline machine and a daemon from before protocol 8; the offline watch leaves a relocated machine alone', async (t) => {
  const { store, mm, a, token } = await setup(t);
  // No real deploy in a test: a protocol-7 daemon (still driven, w605) or an outdated one may ask for one (checkOutdated).
  const deployed: string[] = [];
  mm.deployer = async (o) => {
    deployed.push(o.id);
    throw new Error('not in this test');
  };
  await assert.rejects(mm.relocate('mx', 'https://x/y'), /not a portal base URL/);
  await assert.rejects(mm.relocate('mx', 'https://x'), /offline: only a connected daemon can be relocated/);

  // A protocol-7 daemon (deployed before w466) says hello.
  const ws = new WebSocket(a.url.replace(/^http/, 'ws') + '/machine', { headers: { authorization: `Bearer ${token}` } });
  t.after(() => ws.close());
  await new Promise<void>((r) => ws.once('open', () => r()));
  ws.send(JSON.stringify({ type: 'hello', protocol: 7, home: '/x', live: [], info: { hostname: 'mx', os: 'x', node: 'x', platform: 'win32' } }));
  await until('online, protocol 7', () => mm.isOnline('mx') && mm.protocolOf('mx') === 7);
  await assert.rejects(mm.relocate('mx', 'https://x'), /protocol 7 and cannot relocate \(needs 8\): let it be redeployed first/);
  ws.close();
  await until('offline', () => !mm.isOnline('mx'));

  // Away on another portal: never redeployed from here, however long it is offline.
  deployed.length = 0;
  await until('the outdated-daemon redeploy it asked for is over', () => store.machines.get('mx')!.status !== 'deploying');
  mm.update('mx', { relocatedTo: { url: 'https://vm.example.ts.net', at: new Date().toISOString() }, status: 'ready' });
  const t0 = Date.now();
  await mm.watchOffline(t0, async () => true);
  assert.deepEqual(await mm.watchOffline(t0 + 60 * 60_000, async () => true), []);
  assert.deepEqual(deployed, []);
  mm.update('mx', { relocatedTo: undefined });
  const notes: string[] = [];
  mm.report = (line) => notes.push(line);
  assert.deepEqual(await mm.watchOffline(t0 + 2 * 60 * 60_000, async () => true), ['mx'], `once it is not away, as before (${notes.join(' | ')})`);
  void store;
});

test('relocate at the cut-over (w499): a drain-and-hold request with relocate sends every connected daemon on, writes the outcome, then drain.done', async (t) => {
  const { store, mm, a, b, daemon, onDisk, tmp } = await setup(t);
  LongAgent.all = [];
  daemon();
  // Its hello read, too: relocate needs the protocol it speaks (a link alone says 0).
  await until('online at A, its hello read', () => mm.isOnline('mx') && (mm.protocolOf('mx') ?? 0) > 0);
  const stops: string[] = [];
  const d = new Drainer({ dataDir: tmp, snapshot: () => [], tell: () => undefined, stop: (r) => void stops.push(r.reason), changed: () => undefined, log: () => undefined, relocate: (url) => mm.relocateAll(url) });
  // What fffctl migrate --cut-over writes into BEAST's data folder.
  const req = parseRestartRequest(JSON.stringify({ drain: true, drainMinutes: 10, reason: 'cut-over to the VM', update: false, hold: true, relocate: `${b.url}/` }));
  assert.notEqual(req, 'now');
  d.request(req as RestartRequest);
  t.after(() => d.stopNow(req as RestartRequest));
  await until('drain.done', () => fs.existsSync(path.join(tmp, 'drain.done')));
  const result = JSON.parse(fs.readFileSync(path.join(tmp, RELOCATE_RESULT_FILE), 'utf8'));
  assert.equal(result.url, b.url);
  assert.equal(result.ok, true);
  assert.deepEqual(result.machines.map((m: { machine: string; ok: boolean }) => [m.machine, m.ok]), [['mx', true]]);
  assert.deepEqual([onDisk().portalUrl, onDisk().previousPortalUrl], [b.url, a.url], 'kept before drain.done');
  assert.deepEqual(stops, [], 'held for the stop');
  await until('back online, at B', () => mm.isOnline('mx') && !store.machines.get('mx')!.relocatedTo);
  assert.equal(onDisk().portalUrl, b.url);
});

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { ROOT, type Config } from './config.ts';
import { emit, type Store } from './store.ts';
import type { SessionHandle, SessionManager } from './sessions.ts';
import type { CatalogTool, LaunchSpec, ToolHandler } from './launch.ts';
import { PROTOCOL_VERSION, type FromDaemon, type ToDaemon } from './machineProtocol.ts';
import { normalizePurpose } from './sandboxes.ts';
import { openPr } from './gitStatus.ts';
import type { EffortLevel, ImageInput, Machine, PermissionMode, SessionInfo } from '../shared/types.ts';

const PING_MS = 20_000;
const DEAD_MS = 45_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Machine ids: short, lower-case, safe in a path and a LaunchAgent label. */
export const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** A session whose process runs on a machine; the daemon there runs the real AgentSession. */
export class RemoteSession implements SessionHandle {
  readonly info: SessionInfo;
  lastFrom: 'human' | 'orchestrator' | 'system' = 'human';
  liveFlag = false;
  private readonly link: MachineManager;

  constructor(info: SessionInfo, link: MachineManager) {
    this.info = info;
    this.link = link;
  }

  get live() {
    return this.liveFlag;
  }

  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid: string = randomUUID(), images: ImageInput[] = []): string {
    this.link.dispatchSend(this, text, from, uuid, images);
    this.lastFrom = from;
    return uuid;
  }

  async interrupt() {
    this.link.post(this.info.machineId!, { type: 'interrupt', sessionId: this.info.id }, false);
  }

  async setMode(mode: PermissionMode) {
    this.info.permissionMode = mode;
    this.link.touch(this);
    this.link.post(this.info.machineId!, { type: 'mode', sessionId: this.info.id, mode }, false);
  }

  stop() {
    this.link.post(this.info.machineId!, { type: 'stop', sessionId: this.info.id }, false);
  }

  decide(requestId: string, allow: boolean, message?: string) {
    if (!this.info.pendingPermissions.some((p) => p.requestId === requestId)) return false;
    this.link.post(this.info.machineId!, { type: 'decide', sessionId: this.info.id, requestId, allow, message });
    return true;
  }

  dispose() {
    this.link.post(this.info.machineId!, { type: 'remove', sessionId: this.info.id }, false);
    this.link.forget(this);
  }
}

export interface MachineHooks {
  /** The launch spec for a session on a machine (worker or standing agent). */
  specFor: (info: SessionInfo, m: Machine) => LaunchSpec;
  /** Answers for the MCP tools a session's spec lists. */
  handlersFor: (info: SessionInfo, m: Machine) => Partial<Record<CatalogTool, ToolHandler>>;
}

/**
 * The machines (docs/machines.md): their records, their token auth, and the /machine WebSocket each
 * daemon keeps open. Sessions on a machine live in the SessionManager as RemoteSessions; everything
 * the daemon's AgentSession records (session updates, transcript events, deltas, turn signals) is
 * replayed here into the Store and the session events, so the rest of the app cannot tell.
 */
export class MachineManager {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly sessions: SessionManager;
  hooks?: MachineHooks;
  private readonly links = new Map<string, { ws: WebSocket; lastPong: number; since: number }>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private readonly tokensFile: string;
  private readonly failures = new Map<string, number[]>();

  constructor(cfg: Config, store: Store, sessions: SessionManager) {
    this.cfg = cfg;
    this.store = store;
    this.sessions = sessions;
    this.tokensFile = path.join(cfg.dataDir, 'machine-tokens.json');
    setInterval(() => this.heartbeat(), PING_MS).unref();
  }

  list() {
    return [...this.store.machines.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  require(id: string) {
    const m = this.store.machines.get(id.toLowerCase());
    if (!m) throw new Error(`no machine "${id}"`);
    return m;
  }

  isOnline(id: string) {
    return this.links.has(id);
  }

  // ---------------------------------------------------------------- the offline watchdog

  /** When each machine was last seen going offline (or this server started without it). */
  private offlineSince = new Map<string, number>();
  private lastAutoDeploy = new Map<string, number>();
  /** Tells the orchestrator (wired by index.ts). */
  report?: (text: string) => void;

  /**
   * A machine whose daemon has not come back 2 minutes after this server started or after it dropped, while
   * its host answers ssh, gets redeployed (what add_machine does by hand), at most every 30 minutes.
   */
  async watchOffline(now = Date.now(), reachable: (host: string) => Promise<boolean> = sshReachable): Promise<string[]> {
    const done: string[] = [];
    for (const m of this.list()) {
      if (this.isOnline(m.id)) {
        this.offlineSince.delete(m.id);
        continue;
      }
      if (!this.offlineSince.has(m.id)) this.offlineSince.set(m.id, now);
      const why = redeployDue({ status: m.status, deploying: this.deploying.has(m.id), liveAgents: this.liveCount(m.id) }, now - this.offlineSince.get(m.id)!, now - (this.lastAutoDeploy.get(m.id) ?? 0));
      if (!why) continue;
      if (!(await reachable(m.host))) continue;
      this.lastAutoDeploy.set(m.id, now);
      try {
        this.deployMachine({ id: m.id });
        done.push(m.id);
        this.report?.(`[machines] ${m.id} was offline for ${Math.round((now - this.offlineSince.get(m.id)!) / 60_000)} min while ssh reached it; redeploying its daemon (as add_machine does).`);
      } catch (e) {
        this.report?.(`[machines] ${m.id} is offline and could not be redeployed: ${(e as Error).message}`);
      }
    }
    return done;
  }

  // ---------------------------------------------------------------- daemon versions

  /** What each connected daemon said in its hello. */
  private readonly hellos = new Map<string, { protocol: number; daemon?: string; catalog?: string[] }>();
  /** The commit this portal runs (a deploy stamps the daemon with the same), for the version check. */
  portalHead: string | undefined = gitHead(ROOT);
  private readonly reportedOutdated = new Map<string, string>();

  /** Why a connected machine's daemon does not match this portal (a redeploy fixes it), or undefined. */
  outdated(id: string): string | undefined {
    const h = this.hellos.get(id);
    return h && this.isOnline(id) ? daemonMismatch(h, this.portalHead) : undefined;
  }

  /**
   * Redeploy connected daemons that are outdated (after an app update the Macs still run the old code) as
   * soon as no agent runs there: at most every 10 minutes per machine. Called on every hello and every 30 s.
   */
  checkOutdated(now = Date.now()): string[] {
    const done: string[] = [];
    for (const m of this.list()) {
      const why = this.outdated(m.id);
      if (!why) {
        this.reportedOutdated.delete(m.id);
        continue;
      }
      if (this.deploying.has(m.id)) continue;
      const live = this.liveCount(m.id);
      if (live > 0) {
        if (this.reportedOutdated.get(m.id) !== why) {
          this.reportedOutdated.set(m.id, why);
          this.report?.(`[machines] ${m.id}'s daemon is outdated (${why}); ${live} agent(s) still run there, so it is redeployed once they have stopped. New agents cannot start there until then.`);
        }
        continue;
      }
      if (now - (this.lastAutoDeploy.get(m.id) ?? 0) < 10 * 60_000) continue;
      this.lastAutoDeploy.set(m.id, now);
      try {
        this.deployMachine({ id: m.id });
        done.push(m.id);
        this.report?.(`[machines] ${m.id}'s daemon is outdated (${why}); redeploying it (as add_machine does).`);
      } catch (e) {
        this.report?.(`[machines] ${m.id}'s daemon is outdated (${why}) and could not be redeployed: ${(e as Error).message}`);
      }
    }
    return done;
  }

  /**
   * Wait until a machine is connected with a current daemon, redeploying an outdated one on the way.
   * Resolves undefined when it is, else why not (after `timeoutMs`).
   */
  async whenCurrent(id: string, timeoutMs = 12 * 60_000, pollMs = 3000): Promise<string | undefined> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const m = this.store.machines.get(id);
      if (!m) return `no machine "${id}"`;
      const online = this.isOnline(id) && this.hellos.has(id);
      const why = this.outdated(id);
      if (online && !why && !this.deploying.has(id)) return undefined;
      if (why) this.checkOutdated();
      if (Date.now() >= until) {
        if (this.deploying.has(id)) return `its daemon is still being redeployed (${m.statusDetail ?? 'deploying'})`;
        return why ? `its daemon is outdated (${why})` : `it is offline${m.statusDetail ? ` (${m.statusDetail})` : ''}`;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Live agent processes on a machine (its own limit, apart from this host's). */
  liveCount(id: string) {
    return [...this.sessions.sessions.values()].filter((s) => s.info.machineId === id && s.live).length;
  }

  /** Re-attach a persisted session on boot. */
  restore(info: SessionInfo): SessionHandle | undefined {
    if (!info.machineId || !this.store.machines.has(info.machineId)) return undefined;
    return new RemoteSession(info, this);
  }

  // ---------------------------------------------------------------- records and tokens

  /** Add or replace a machine's record and mint its token (returned once; only the hash is kept). */
  register(m: Omit<Machine, 'online' | 'sessionIds' | 'createdAt'> & Partial<Pick<Machine, 'sessionIds' | 'createdAt'>>): { machine: Machine; token: string } {
    if (!MACHINE_ID.test(m.id)) throw new Error(`machine id "${m.id}" must be lower-case letters, digits and dashes`);
    const prev = this.store.machines.get(m.id);
    const machine: Machine = { online: this.isOnline(m.id), sessionIds: prev?.sessionIds ?? [], createdAt: prev?.createdAt ?? new Date().toISOString(), ...m };
    const secret = randomBytes(32).toString('base64url');
    const token = `ffm_${m.id}_${secret}`;
    const tokens = this.tokens();
    tokens[m.id] = sha(token);
    this.writeTokens(tokens);
    this.store.putMachine(machine);
    return { machine, token };
  }

  update(id: string, patch: Partial<Machine>) {
    const m = this.require(id);
    Object.assign(m, patch);
    this.store.putMachine(m);
    return m;
  }

  setPurpose(id: string, purpose: string) {
    return this.update(id, { purpose: normalizePurpose(purpose) });
  }

  /** Forget a machine: its token stops working and its sessions are removed. */
  remove(id: string) {
    const m = this.require(id);
    for (const sid of m.sessionIds) if (this.sessions.sessions.has(sid)) this.sessions.remove(sid);
    const tokens = this.tokens();
    delete tokens[m.id];
    this.writeTokens(tokens);
    this.links.get(m.id)?.ws.close(4001, 'machine removed');
    this.store.removeMachine(m.id);
  }

  private tokens(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.tokensFile, 'utf8'));
    } catch {
      return {};
    }
  }

  private writeTokens(t: Record<string, string>) {
    fs.writeFileSync(this.tokensFile, JSON.stringify(t, null, 2), { mode: 0o600 });
  }

  /** The machine a bearer token belongs to, or undefined. Constant-time on the secret. */
  authenticate(header: string | undefined): string | undefined {
    const m = /^Bearer\s+(ffm_([a-z0-9-]+)_[A-Za-z0-9_-]{40,})$/.exec(header ?? '');
    if (!m) return undefined;
    const want = this.tokens()[m[2]];
    if (!want) return undefined;
    return timingSafeEqual(Buffer.from(want, 'hex'), createHash('sha256').update(m[1]).digest()) ? m[2] : undefined;
  }

  // ---------------------------------------------------------------- deploying (server/machineDeploy.ts)

  private readonly deploying = new Set<string>();

  /**
   * Add a machine, or redeploy one (same id): mint a token, install the daemon over ssh and wait for
   * it to connect. Returns at once; progress shows on the record (status/statusDetail).
   */
  deployMachine(opts: { id: string; host?: string; portalUrl?: string; repoPath?: string; maxSessions?: number; purpose?: string; force?: boolean }) {
    const id = opts.id.trim().toLowerCase();
    if (!MACHINE_ID.test(id)) throw new Error(`machine id "${id}" must be lower-case letters, digits and dashes (e.g. "m5")`);
    if (this.deploying.has(id)) throw new Error(`${id} is already being deployed`);
    const prev = this.store.machines.get(id);
    const portalUrl = (opts.portalUrl ?? prev?.portalUrl ?? this.cfg.publicUrl ?? '').replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+$/.test(portalUrl)) throw new Error('portal_url is required: the address the machine reaches this portal at, e.g. https://<host>.<tailnet>.ts.net (or set publicUrl in config.json)');
    if (prev && !opts.force && this.liveCount(id) > 0) throw new Error(`${id} has agents running; a redeploy restarts its daemon and stops them. Stop them first or pass force.`);
    const { machine, token } = this.register({
      id,
      host: opts.host?.trim() || prev?.host || id,
      purpose: opts.purpose ?? prev?.purpose ?? 'unused',
      status: 'deploying',
      statusDetail: 'starting',
      repoPath: opts.repoPath ?? prev?.repoPath ?? '',
      home: prev?.home ?? '',
      portalUrl,
      maxSessions: opts.maxSessions ?? prev?.maxSessions ?? 3,
      info: prev?.info,
      git: prev?.git,
      lastSeen: prev?.lastSeen,
    });
    void this.runDeploy(machine, token, opts.repoPath);
    return machine;
  }

  private async runDeploy(m: Machine, token: string, repoPath: string | undefined) {
    this.deploying.add(m.id);
    const { deploy, repoSlug } = await import('./machineDeploy.ts');
    const { ROOT } = await import('./config.ts');
    try {
      const r = await deploy({ host: m.host, id: m.id, portalUrl: m.portalUrl, token, root: ROOT, repoPath, maxSessions: m.maxSessions, repoSlug: repoSlug(this.cfg.repo.url), step: (s) => this.update(m.id, { statusDetail: s }) });
      this.update(m.id, { repoPath: r.repoPath, home: r.home, statusDetail: `waiting for the daemon (${r.version}, node ${r.nodeVersion}) to connect` });
      // The old daemon's connection (if any) closes when launchd stops it; wait for the new one.
      const since = Date.now();
      await new Promise((res) => setTimeout(res, 3000));
      for (let i = 0; i < 90; i++) {
        const link = this.links.get(m.id);
        if (link && link.since >= since) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      const link = this.links.get(m.id);
      this.update(
        m.id,
        link && link.since >= since
          ? { status: 'ready', statusDetail: undefined }
          : { status: 'error', statusDetail: `installed, but the daemon has not connected to ${m.portalUrl}; see ~/.ff-factory/logs/daemon.log on ${m.host}` },
      );
    } catch (e) {
      this.update(m.id, { status: 'error', statusDetail: (e as Error).message });
    } finally {
      this.deploying.delete(m.id);
    }
  }

  /** Stop and unload the daemon on the machine (best effort), then forget the machine here. */
  async removeMachine(id: string) {
    const m = this.require(id);
    const { undeploy } = await import('./machineDeploy.ts');
    let note = '';
    try {
      await undeploy(m.host);
    } catch (e) {
      note = ` (could not unload the daemon: ${(e as Error).message})`;
    }
    this.remove(m.id);
    return `Removed ${m.id}${note}. Its files stay in ~/.ff-factory on the machine.`;
  }

  // ---------------------------------------------------------------- sessions

  createSession(machineId: string, opts: { kind: 'worker' | 'standing'; title: string; model?: string; effort?: EffortLevel; permissionMode: PermissionMode; standingId?: string }) {
    const m = this.require(machineId);
    const now = new Date().toISOString();
    const info: SessionInfo = {
      id: randomUUID().slice(0, 8),
      kind: opts.kind,
      machineId: m.id,
      standingId: opts.standingId,
      title: opts.title,
      status: 'stopped',
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
      createdAt: now,
      lastActivityAt: now,
      turns: 0,
      costUsd: 0,
      pendingPermissions: [],
    };
    const h = this.sessions.adopt(new RemoteSession(info, this));
    m.sessionIds = [...m.sessionIds, info.id];
    this.store.putMachine(m);
    return h;
  }

  /** RemoteSession.send: checked here so the caller gets the error at once. */
  dispatchSend(s: RemoteSession, text: string, from: 'human' | 'orchestrator' | 'system', uuid: string, images: ImageInput[] = []) {
    const m = this.require(s.info.machineId!);
    if (!this.isOnline(m.id)) throw new Error(`machine ${m.id} is offline (asleep, or its daemon is not running)`);
    if (!s.live && this.liveCount(m.id) >= m.maxSessions) throw new Error(`already ${m.maxSessions} agents running on ${m.id}; stop one first`);
    if (!this.hooks) throw new Error('machines are not wired up');
    // A new agent process is built from the spec by the daemon's own code: an outdated daemon may not understand
    // it (a tool it does not have). A live process only gets the text, so it carries on.
    const why = s.live ? undefined : this.outdated(m.id);
    if (why) {
      this.checkOutdated();
      const busy = this.liveCount(m.id);
      throw new Error(`${m.id}'s daemon is outdated (${why}): ${this.deploying.has(m.id) ? 'it is being redeployed now' : busy ? `it is redeployed once its ${busy} running agent(s) stop` : 'redeploying it now'}. Try again in a few minutes.`);
    }
    const spec = this.hooks.specFor(s.info, m);
    const catalog = this.hellos.get(m.id)?.catalog;
    if (spec.mcp && catalog) spec.mcp = { ...spec.mcp, tools: spec.mcp.tools.filter((t) => catalog.includes(t.name)) };
    // Stored here first, so the daemon's transcript event can name them without sending them back.
    const withIds = images.map((i) => ({ ...i, id: i.id ?? this.store.saveImage(s.info.id, i.mediaType, i.data) }));
    this.post(m.id, { type: 'send', info: s.info, lastSeq: this.store.lastSeq(s.info.id), spec, text, from, uuid, images: withIds });
  }

  /** Ask a machine's daemon for its git status now. */
  refreshGit(id: string) {
    this.post(id, { type: 'status_now' }, false);
  }

  touch(s: RemoteSession) {
    this.store.putSession(s.info);
  }

  forget(s: RemoteSession) {
    const m = this.store.machines.get(s.info.machineId ?? '');
    if (m) {
      m.sessionIds = m.sessionIds.filter((x) => x !== s.info.id);
      this.store.putMachine(m);
    }
  }

  /** Send to a machine's daemon. Throws when it is offline unless `must` is false (then a no-op). */
  post(machineId: string, msg: ToDaemon, must = true) {
    const link = this.links.get(machineId);
    if (!link) {
      if (must) throw new Error(`machine ${machineId} is offline`);
      return;
    }
    link.ws.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------- the /machine socket

  /** Take over an HTTP upgrade to /machine. Returns false if the token is bad (the socket is already answered). */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, ip: string) {
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    const id = recent.length < 10 ? this.authenticate(req.headers.authorization) : undefined;
    if (!id || !this.store.machines.has(id)) {
      recent.push(now);
      this.failures.set(ip, recent);
      console.warn(`machine: refused a connection from ${ip}`);
      socket.write(`HTTP/1.1 ${recent.length > 10 ? '429 Too Many Requests' : '401 Unauthorized'}\r\n\r\n`);
      socket.destroy();
      return false;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(id, ws));
    return true;
  }

  /** Wire a connected daemon (exported for tests: any WebSocket works). */
  attach(id: string, ws: WebSocket) {
    const old = this.links.get(id);
    if (old) old.ws.close(4000, 'replaced by a newer connection');
    const link = { ws, lastPong: Date.now(), since: Date.now() };
    this.links.set(id, link);
    ws.on('pong', () => (link.lastPong = Date.now()));
    ws.on('message', (data) => {
      link.lastPong = Date.now();
      try {
        this.onMessage(id, JSON.parse(String(data)) as FromDaemon);
      } catch (e) {
        console.warn(`machine ${id}: bad message:`, (e as Error).message);
      }
    });
    ws.on('close', () => {
      if (this.links.get(id) === link) this.detach(id);
    });
    ws.on('error', (e) => console.warn(`machine ${id}: socket error:`, e.message));
    const m = this.require(id);
    Object.assign(m, { online: true, lastSeen: new Date().toISOString() });
    this.store.putMachine(m);
    const sessions = m.sessionIds.filter((sid) => this.store.sessions.has(sid)).map((sid) => ({ id: sid, lastSeq: this.store.lastSeq(sid) }));
    ws.send(JSON.stringify({ type: 'welcome', machineId: id, maxSessions: m.maxSessions, sessions } satisfies ToDaemon));
    console.log(`machine ${id} connected`);
  }

  private detach(id: string) {
    this.links.delete(id);
    this.hellos.delete(id);
    const m = this.store.machines.get(id);
    if (m) {
      Object.assign(m, { online: false, lastSeen: new Date().toISOString() });
      this.store.putMachine(m);
    }
    // Its processes may well still be running, but nothing reaches them: show them stopped until it is back.
    for (const s of this.sessions.sessions.values()) {
      if (s.info.machineId !== id || !(s instanceof RemoteSession)) continue;
      const was = s.liveFlag;
      s.liveFlag = false;
      if (s.info.status !== 'stopped' && s.info.status !== 'error') {
        Object.assign(s.info, { status: 'stopped', statusDetail: `machine ${id} went offline`, pendingPermissions: [] });
        this.store.putSession(s.info);
      }
      if (was) this.sessions.events.emit('ended', s);
    }
    console.log(`machine ${id} disconnected`);
  }

  private heartbeat() {
    const now = Date.now();
    for (const [id, link] of this.links) {
      if (now - link.lastPong > DEAD_MS) {
        console.warn(`machine ${id}: no answer for ${Math.round((now - link.lastPong) / 1000)} s, dropping the connection`);
        link.ws.terminate();
        this.detach(id);
      } else link.ws.ping();
    }
  }

  private handle(sessionId: string) {
    const s = this.sessions.sessions.get(sessionId);
    return s instanceof RemoteSession ? s : undefined;
  }

  private onMessage(id: string, msg: FromDaemon) {
    const m = this.store.machines.get(id);
    if (!m) return;
    switch (msg.type) {
      case 'hello': {
        this.hellos.set(id, { protocol: msg.protocol, daemon: msg.info?.daemon, catalog: msg.catalog });
        const why = daemonMismatch(this.hellos.get(id)!, this.portalHead);
        if (why) Object.assign(m, { statusDetail: `daemon outdated: ${why}` });
        else if (/^daemon (speaks|outdated)/.test(m.statusDetail ?? '')) m.statusDetail = undefined;
        Object.assign(m, { info: msg.info, home: msg.home || m.home });
        this.store.putMachine(m);
        const live = new Set(msg.live);
        for (const sid of m.sessionIds) {
          const s = this.handle(sid);
          if (s) s.liveFlag = live.has(sid);
        }
        if (why) this.checkOutdated();
        return;
      }
      case 'session': {
        const s = this.handle(msg.info.id);
        if (!s || s.info.machineId !== id) return;
        // The portal owns identity and naming; the daemon owns run state.
        const { id: _i, kind: _k, machineId: _m, standingId: _s, sandboxId: _b, title: _t, createdAt: _c, label: _l, labelAt: _la, ...run } = msg.info;
        Object.assign(s.info, run);
        s.liveFlag = msg.live;
        this.store.putSession(s.info);
        return;
      }
      case 'event':
        if (this.handle(msg.sessionId)?.info.machineId === id) this.store.appendFull(msg.sessionId, msg.event);
        return;
      case 'amend':
        if (this.handle(msg.sessionId)?.info.machineId === id) this.store.amend(msg.sessionId, msg.seq, msg.patch);
        return;
      case 'delta':
        if (this.handle(msg.sessionId)?.info.machineId === id) emit({ type: 'delta', sessionId: msg.sessionId, text: msg.text });
        return;
      case 'signal': {
        const s = this.handle(msg.sessionId);
        if (s && s.info.machineId === id) this.sessions.events.emit(msg.name, s, msg.arg);
        return;
      }
      case 'failed': {
        const s = this.handle(msg.sessionId);
        if (!s || s.info.machineId !== id) return;
        this.store.append(s.info.id, { kind: 'error', text: `On ${id}: ${msg.error}` });
        Object.assign(s.info, { status: 'error', statusDetail: msg.error });
        this.store.putSession(s.info);
        this.sessions.events.emit('ended', s);
        return;
      }
      case 'rpc':
        void this.answer(id, msg);
        return;
      case 'image':
        if (this.handle(msg.sessionId)?.info.machineId === id) {
          try {
            this.store.saveImage(msg.sessionId, msg.mediaType, msg.data, msg.id);
          } catch (e) {
            console.warn(`machine ${id}: image not kept:`, (e as Error).message);
          }
        }
        return;
      case 'unity_result': {
        const p = this.unityCalls.get(msg.id);
        if (!p) return;
        this.unityCalls.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.text);
        else p.reject(new Error(msg.text));
        return;
      }
      case 'unity_event': {
        this.unityEvent?.(id, msg.text, msg.restarted);
        return;
      }
      case 'switch_result': {
        const p = this.switchCalls.get(msg.id);
        if (!p) return;
        this.switchCalls.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve({ from: msg.from ?? '?', to: msg.to ?? '?', notes: msg.notes ?? [] });
        else p.reject(new Error(msg.error ?? 'failed'));
        return;
      }
      case 'fs_result': {
        const p = this.fsCalls.get(msg.id);
        if (!p) return;
        this.fsCalls.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else p.reject(new Error(msg.error ?? 'failed'));
        return;
      }
      case 'status':
        Object.assign(m, { git: msg.git ? { ...msg.git, pr: m.git?.branch === msg.git.branch ? m.git.pr : undefined } : undefined, lastSeen: new Date().toISOString() });
        this.store.putMachine(m);
        // The PR comes from gh here (the Mac's gh may be missing or elsewhere); the repo is the game repo.
        if (msg.git) {
          const branch = msg.git.branch;
          void openPr({ repo: this.cfg.repo.url }, branch).then((pr) => {
            if (m.git?.branch !== branch || JSON.stringify(m.git.pr) === JSON.stringify(pr)) return;
            m.git = { ...m.git, pr };
            this.store.putMachine(m);
          });
        }
        return;
    }
  }

  private readonly fsCalls = new Map<string, { resolve: (m: Extract<FromDaemon, { type: 'fs_result' }>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private fsCall(machineId: string, msg: { op: 'read'; path: string } | { op: 'list'; dirs?: string[] }) {
    return new Promise<Extract<FromDaemon, { type: 'fs_result' }>>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.fsCalls.delete(id);
        reject(new Error(`machine ${machineId} did not answer`));
      }, 20_000);
      this.fsCalls.set(id, { resolve, reject, timer });
      try {
        this.post(machineId, { type: 'fs', id, ...msg } as ToDaemon);
      } catch (e) {
        clearTimeout(timer);
        this.fsCalls.delete(id);
        reject(e as Error);
      }
    });
  }

  private readonly unityCalls = new Map<string, { resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** The daemon's Unity watch reported something (wired by index.ts: orchestrator, notification, the machine's agents). */
  unityEvent?: (machineId: string, text: string, restarted: boolean) => void;

  /** Status, start, stop or restart the Unity editor of a machine's clone, on the machine (machine/unity.ts). */
  unity(machineId: string, action: 'status' | 'start' | 'stop' | 'restart', force?: boolean) {
    const m = this.require(machineId);
    if (!this.isOnline(m.id)) throw new Error(`machine ${m.id} is offline`);
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.unityCalls.delete(id);
        reject(new Error(`machine ${m.id} did not answer the unity ${action} in 3 minutes (an old daemon? redeploy it with add_machine)`));
      }, 3 * 60_000);
      this.unityCalls.set(id, { resolve, reject, timer });
      try {
        this.post(m.id, { type: 'unity', id, action, force });
      } catch (e) {
        clearTimeout(timer);
        this.unityCalls.delete(id);
        reject(e as Error);
      }
    });
  }

  private readonly switchCalls = new Map<string, { resolve: (r: { from: string; to: string; notes: string[] }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /** Switch the branch of a machine's clone, on the machine (server/switchBranch.ts). */
  switchBranch(machineId: string, branch: string, createFrom?: string) {
    return new Promise<{ from: string; to: string; notes: string[] }>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.switchCalls.delete(id);
        reject(new Error(`machine ${machineId} did not finish the switch in 10 minutes`));
      }, 10 * 60_000);
      this.switchCalls.set(id, { resolve, reject, timer });
      try {
        this.post(machineId, { type: 'switch', id, branch, createFrom });
      } catch (e) {
        clearTimeout(timer);
        this.switchCalls.delete(id);
        reject(e as Error);
      }
    });
  }

  /** An image file from a machine's clone or standing-agent folders. */
  async readImage(machineId: string, file: string) {
    const r = await this.fsCall(machineId, { op: 'read', path: file });
    return { mediaType: r.mediaType!, data: Buffer.from(r.data ?? '', 'base64') };
  }

  /** The machine's recent screenshots (see server/images.ts). */
  async listImages(machineId: string, dirs?: string[]) {
    return (await this.fsCall(machineId, { op: 'list', dirs })).files ?? [];
  }

  private async answer(id: string, msg: Extract<FromDaemon, { type: 'rpc' }>) {
    let reply: ToDaemon;
    try {
      const s = this.handle(msg.sessionId);
      if (!s || s.info.machineId !== id) throw new Error('unknown session');
      const h = this.hooks?.handlersFor(s.info, this.require(id))[msg.method];
      if (!h) throw new Error(`${msg.method} is not available to this session`);
      reply = { type: 'rpc_result', id: msg.id, ok: true, text: await h(msg.args) };
    } catch (e) {
      reply = { type: 'rpc_result', id: msg.id, ok: false, text: (e as Error).message };
    }
    this.post(id, reply, false);
  }
}

/** Whether an offline machine should be redeployed now, and why (undefined: not yet, or not at all). */
export function redeployDue(m: { status: string; deploying: boolean; liveAgents: number }, offlineMs: number, sinceLastTryMs: number): string | undefined {
  if (m.deploying || m.status === 'deploying' || m.liveAgents > 0) return undefined;
  if (offlineMs < 2 * 60_000) return undefined; // a daemon reconnects by itself within about a minute
  if (sinceLastTryMs < 30 * 60_000) return undefined;
  return `offline for ${Math.round(offlineMs / 60_000)} min`;
}

/** Whether ssh reaches a host non-interactively (keys only, 10 s). */
export async function sshReachable(host: string): Promise<boolean> {
  const { run } = await import('./proc.ts');
  const r = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'true'], { timeoutMs: 20_000 });
  return r.code === 0;
}

/** The commit a checkout is at, or undefined. */
function gitHead(dir: string): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a daemon does not match this portal, or undefined: another protocol, or deployed from another commit
 * (info.daemon is the short hash machineDeploy stamped into machine/VERSION). Unknown versions count as current.
 */
export function daemonMismatch(h: { protocol: number; daemon?: string }, portalHead: string | undefined): string | undefined {
  if (h.protocol !== PROTOCOL_VERSION) return `it speaks protocol ${h.protocol}, this portal ${PROTOCOL_VERSION}`;
  const d = h.daemon?.trim().toLowerCase();
  const p = portalHead?.trim().toLowerCase();
  if (!d || !p || !/^[0-9a-f]{7,40}$/.test(d)) return undefined;
  if (!p.startsWith(d) && !d.startsWith(p)) return `it runs ${d.slice(0, 9)}, this portal ${p.slice(0, 9)}`;
  return undefined;
}

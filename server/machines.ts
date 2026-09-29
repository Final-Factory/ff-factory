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
import { PROTOCOL_VERSION, SANDBOX_PROTOCOL, type DaemonSandbox, type FromDaemon, type ToDaemon } from './machineProtocol.ts';
import type { OutsideWatchConfig } from '../machine/outsideWatch.ts';
import { branchProblem, normalizePurpose, slugify } from './sandboxes.ts';
import { winDir } from './machineDeployWin.ts';
import type { MachineDirs } from './machineDeploy.ts';
import { openPr } from './gitStatus.ts';
import { HOST_LOGIN, machineLogin, type AccountIdentity } from './usage.ts';
import type { EffortLevel, ImageInput, Machine, MachinePlatform, MachineSandbox, MachineStats, PermissionMode, PlanUsage, Requester, SandboxPoolSettings, SessionInfo } from '../shared/types.ts';

const PING_MS = 20_000;
const DEAD_MS = 45_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Machine ids: short, lower-case, safe in a path and a LaunchAgent label. */
export const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

const SANDBOX_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A machine's sandbox limits as add_machine takes them (docs/machines.md, "Machine sandboxes"). */
export interface SandboxLimits {
  maxSandboxes?: number;
  maxAgentsPerSandbox?: number;
  maxUnity?: number;
  diskWarnGB?: number;
  diskCriticalGB?: number;
}

/** The pool settings of a machine (its sandbox_root and limits, with defaults), or null when it has no sandbox_root. Exported for tests. */
export function poolSettingsOf(m: Pick<Machine, 'sandboxRoot'> & SandboxLimits): SandboxPoolSettings | null {
  if (!m.sandboxRoot) return null;
  const warn = m.diskWarnGB ?? 50;
  return {
    root: m.sandboxRoot,
    maxSandboxes: m.maxSandboxes ?? 3,
    maxAgentsPerSandbox: m.maxAgentsPerSandbox ?? 2,
    maxUnity: m.maxUnity ?? 2,
    diskWarnGB: warn,
    diskCriticalGB: Math.min(m.diskCriticalGB ?? 20, warn),
  };
}

/** The limits a deploy stores: each given one checked, an unset one kept from the previous deploy. Exported for tests. */
export function limitOptions(opts: SandboxLimits, prev: SandboxLimits | undefined): SandboxLimits {
  const pick = (k: keyof SandboxLimits, min: number, max: number) => {
    const v = opts[k] ?? prev?.[k];
    if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) throw new Error(`${k} must be a whole number from ${min} to ${max}`);
    return v;
  };
  const out = { maxSandboxes: pick('maxSandboxes', 1, 8), maxAgentsPerSandbox: pick('maxAgentsPerSandbox', 1, 8), maxUnity: pick('maxUnity', 0, 8), diskWarnGB: pick('diskWarnGB', 1, 10_000), diskCriticalGB: pick('diskCriticalGB', 1, 10_000) };
  if (out.diskWarnGB !== undefined && out.diskCriticalGB !== undefined && out.diskCriticalGB > out.diskWarnGB) throw new Error('disk_critical_gb must not be above disk_warn_gb');
  return out;
}

/**
 * A machine's sandboxes after a daemon snapshot: the daemon's facts (folder, branch, status, editor, git) with the
 * portal's purpose and agents kept by id; `pending` gives the purpose of sandboxes just asked for. Exported for tests.
 */
export function mergeSandboxes(prev: MachineSandbox[] | undefined, list: DaemonSandbox[], pending: ReadonlyMap<string, string> = new Map()): MachineSandbox[] {
  const old = new Map((prev ?? []).map((s) => [s.id, s]));
  return list.map((d) => ({ ...d, purpose: old.get(d.id)?.purpose ?? pending.get(d.id) ?? 'unused', sessionIds: old.get(d.id)?.sessionIds ?? [] }));
}

/** "lothdesktop/sb1" as a machine sandbox reference, or undefined for a plain (host) sandbox id. */
export function parseSandboxRef(ref: string): { machine: string; sandbox: string } | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9-]*)\s*[/:]\s*([A-Za-z0-9][A-Za-z0-9 _.-]*?)\s*$/.exec(ref);
  return m ? { machine: m[1].toLowerCase(), sandbox: slugify(m[2]) } : undefined;
}

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

  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid: string = randomUUID(), images: ImageInput[] = [], requestedBy?: Requester): string {
    if (requestedBy && from !== 'system') this.info.lastRequestedBy = requestedBy;
    this.link.dispatchSend(this, text, from, uuid, images, requestedBy);
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

  /** Each online machine's load, as its daemon last reported it (protocol 4); kept in memory only. */
  private readonly stats = new Map<string, MachineStats>();

  statsOf(id: string): MachineStats | undefined {
    return this.stats.get(id);
  }

  allStats(): Record<string, MachineStats> {
    return Object.fromEntries(this.stats);
  }

  /** A daemon reported its Mac's own Claude login's usage (wired by index.ts to the UsageTracker). */
  onUsage?: (machineId: string, account: AccountIdentity, usage: PlanUsage) => void;

  // ---------------------------------------------------------------- the offline watchdog

  /** When each machine was last seen going offline (or this server started without it). */
  private offlineSince = new Map<string, number>();
  private lastAutoDeploy = new Map<string, number>();
  /** The outside-watch config for a machine (null: it does not watch; wired by index.ts). */
  outsideWatchFor?: (machineId: string) => OutsideWatchConfig | null;

  /** Send every connected daemon its outside-watch config (after it changed). */
  pushOutsideWatch() {
    for (const id of this.links.keys()) {
      const c = this.outsideWatchFor?.(id);
      if (c !== undefined) this.post(id, { type: 'outside_watch', config: c }, false);
    }
  }

  /** Tells the orchestrator (wired by index.ts). */
  report?: (text: string) => void;

  /** A machine's clean-up settings (config machines.cleanup; wired by index.ts). */
  cleanupFor?: (machineId: string) => { everyMinutes: number; softFreeGB: number };
  /** A machine's clean-up could not get above its soft threshold (wired by index.ts: the orchestrator and a push). */
  cleanupNotice?: (machineId: string, text: string) => void;

  /** Send every connected daemon its clean-up settings (after they changed). */
  pushCleanupConfig() {
    for (const id of this.links.keys()) {
      const c = this.cleanupFor?.(id);
      if (c) this.post(id, { type: 'cleanup_config', config: c }, false);
    }
  }

  /** A clean-up pass on the machine now; its result arrives as the machine's lastCleanup. */
  cleanupNow(machineId: string): string {
    const m = this.require(machineId);
    if (!this.links.has(m.id)) throw new Error(`machine ${m.id} is offline`);
    this.post(m.id, { type: 'cleanup_now' });
    return `Asked ${m.id} for a clean-up pass; list_machines shows its result (last clean-up) in a minute or two.`;
  }

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
      if (m.daemonStopped) continue; // stopped on purpose (machine_daemon stop): it stays down until started
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

  /** Live agents in one place of a machine: a sandbox, or (sandbox undefined) its main clone and standing agents. */
  liveIn(id: string, sandbox: string | undefined) {
    return [...this.sessions.sessions.values()].filter((s) => s.info.machineId === id && s.info.machineSandbox === sandbox && s.live).length;
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
  deployMachine(opts: { id: string; host?: string; portalUrl?: string; repoPath?: string; maxSessions?: number; purpose?: string; force?: boolean } & MachineDirs & SandboxLimits) {
    const typed = opts.id.trim();
    const id = typed.toLowerCase();
    if (!MACHINE_ID.test(id)) throw new Error(`machine id "${id}" must be lower-case letters, digits and dashes (e.g. "m5")`);
    if (this.deploying.has(id)) throw new Error(`${id} is already being deployed`);
    const prev = this.store.machines.get(id);
    const portalUrl = (opts.portalUrl ?? prev?.portalUrl ?? this.cfg.publicUrl ?? '').replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+$/.test(portalUrl)) throw new Error('portal_url is required: the address the machine reaches this portal at, e.g. https://<host>.<tailnet>.ts.net (or set publicUrl in config.json)');
    if (prev && !opts.force && this.liveCount(id) > 0) throw new Error(`${id} has agents running; a redeploy restarts its daemon and stops them. Stop them first or pass force.`);
    const dirs = dirOptions(opts, prev);
    const limits = limitOptions(opts, prev);
    if (prev?.sandboxRoot && dirs.sandboxRoot !== prev.sandboxRoot && prev.sandboxes?.length) {
      throw new Error(`${id} has ${prev.sandboxes.length} sandbox(es) in ${prev.sandboxRoot}; delete them before moving sandbox_root`);
    }
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
      platform: prev?.platform,
      name: typed !== id ? typed : prev?.name,
      sandboxes: prev?.sandboxes,
      ...dirs,
      ...limits,
    });
    void this.runDeploy(machine, token, opts.repoPath, prev?.appDir);
    return machine;
  }

  private async runDeploy(m: Machine, token: string, repoPath: string | undefined, previousAppDir: string | undefined) {
    this.deploying.add(m.id);
    const { deploy, repoSlug } = await import('./machineDeploy.ts');
    const { ROOT } = await import('./config.ts');
    try {
      const dirs = { appDir: m.appDir, unityEditorRoot: m.unityEditorRoot, unityPath: m.unityPath, tempDir: m.tempDir, sandboxRoot: m.sandboxRoot };
      const r = await deploy({ host: m.host, id: m.id, portalUrl: m.portalUrl, token, root: ROOT, repoPath, maxSessions: m.maxSessions, repoSlug: repoSlug(this.cfg.repo.url), dirs, sandboxes: poolSettingsOf(m), previousAppDir, step: (s) => this.update(m.id, { statusDetail: s }), onPlatform: (platform) => this.update(m.id, { platform }) });
      this.update(m.id, { repoPath: r.repoPath, home: r.home, platform: r.platform, statusDetail: `waiting for the daemon (${r.version}, node ${r.nodeVersion}) to connect` });
      if (r.started === false) {
        // Windows: the task runs only in the user's logged-on session (docs/machines.md).
        this.update(m.id, { status: 'error', statusDetail: `installed, but nobody is logged on to ${m.host}: the daemon starts when its user logs on to the desktop` });
        return;
      }
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
          : { status: 'error', statusDetail: `installed, but the daemon has not connected to ${m.portalUrl}; see ${daemonLogPath(r.platform, m.appDir)} on ${m.host}` },
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
      await undeploy(m.host, m.platform, m.appDir);
    } catch (e) {
      note = ` (could not unload the daemon: ${(e as Error).message})`;
    }
    this.remove(m.id);
    return `Removed ${m.id}${note}. Its files stay in ${m.appDir ?? 'the .ff-factory folder in its home'} on the machine.`;
  }

  /**
   * Start, stop or restart a machine's daemon over ssh. Stopping or restarting ends its agents, so it is refused
   * while any run unless forced (as a redeploy is). A stopped daemon is left alone by the offline redeploy until
   * it is started (or redeployed) again.
   */
  async controlDaemon(id: string, action: 'start' | 'stop' | 'restart', force = false): Promise<string> {
    const m = this.require(id);
    if (this.deploying.has(m.id)) throw new Error(`${m.id} is being deployed right now`);
    const live = this.liveCount(m.id);
    if (action !== 'start' && live > 0 && !force) throw new Error(`${m.id} has ${live} agent(s) running; a daemon ${action} stops them. Stop them first or pass force.`);
    const { controlDaemon } = await import('./machineDeploy.ts');
    const done = await controlDaemon(m.host, m.platform, action, m.appDir);
    this.update(m.id, { daemonStopped: action === 'stop' ? true : undefined });
    return `${m.id}: ${done}.`;
  }

  // ---------------------------------------------------------------- sessions

  createSession(machineId: string, opts: { kind: 'worker' | 'standing'; title: string; model?: string; effort?: EffortLevel; permissionMode: PermissionMode; standingId?: string; requestedBy?: Requester; sandbox?: string }) {
    const m = this.require(machineId);
    const sb = opts.sandbox ? this.requireSandbox(m.id, opts.sandbox) : undefined;
    const now = new Date().toISOString();
    const info: SessionInfo = {
      id: randomUUID().slice(0, 8),
      kind: opts.kind,
      machineId: m.id,
      ...(sb ? { machineSandbox: sb.id } : {}),
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
      ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
    };
    const h = this.sessions.adopt(new RemoteSession(info, this));
    m.sessionIds = [...m.sessionIds, info.id];
    if (sb) sb.sessionIds = [...sb.sessionIds, info.id];
    this.store.putMachine(m);
    return h;
  }

  /** RemoteSession.send: checked here so the caller gets the error at once. */
  dispatchSend(s: RemoteSession, text: string, from: 'human' | 'orchestrator' | 'system', uuid: string, images: ImageInput[] = [], requestedBy?: Requester) {
    const m = this.require(s.info.machineId!);
    if (!this.isOnline(m.id)) throw new Error(`machine ${m.id} is offline (asleep, or its daemon is not running)`);
    const sbId = s.info.machineSandbox;
    if (sbId && !s.live) {
      const sb = this.requireSandbox(m.id, sbId);
      this.requireSandboxDaemon(m.id);
      if (sb.status !== 'ready') throw new Error(`sandbox ${m.id}/${sb.id} is ${sb.status}${sb.statusDetail ? ` (${sb.statusDetail})` : ''}`);
      const max = poolSettingsOf(m)?.maxAgentsPerSandbox ?? 2;
      if (this.liveIn(m.id, sb.id) >= max) throw new Error(`already ${max} agents running in sandbox ${m.id}/${sb.id} (max_agents_per_sandbox); stop one first`);
    } else if (!s.live && this.liveIn(m.id, undefined) >= m.maxSessions) throw new Error(`already ${m.maxSessions} agents running in ${m.id}'s main clone; stop one first`);
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
    this.post(m.id, { type: 'send', info: s.info, lastSeq: this.store.lastSeq(s.info.id), spec, text, from, uuid, images: withIds, ...(requestedBy ? { requestedBy } : {}) });
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
      for (const sb of m.sandboxes ?? []) sb.sessionIds = sb.sessionIds.filter((x) => x !== s.info.id);
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

  /**
   * Take over an HTTP upgrade to /machine. Returns false if the token is bad (the socket is already answered).
   * After 10 failures from an address in 15 minutes it is answered 429, and refusals then are not counted: a
   * daemon retrying every half minute would otherwise keep its own lockout going forever. A good token always
   * gets in and clears the address's record (a daemon fixed by a reinstall must not wait out the lockout).
   * Tokens are 240+ random bits checked with one SHA-256, so the lockout is not what stops guessing.
   */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, ip: string) {
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    const auth = this.authenticate(req.headers.authorization);
    const id = auth && this.store.machines.has(auth) ? auth : undefined;
    if (!id) {
      const locked = recent.length >= 10;
      if (!locked) recent.push(now);
      if (recent.length) this.failures.set(ip, recent);
      else this.failures.delete(ip);
      console.warn(`machine: refused a connection from ${ip}${locked ? ' (too many failures)' : ''}`);
      socket.write(`HTTP/1.1 ${locked ? '429 Too Many Requests' : '401 Unauthorized'}

`);
      socket.destroy();
      return false;
    }
    this.failures.delete(ip);
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
    ws.send(JSON.stringify({ type: 'welcome', machineId: id, maxSessions: m.maxSessions, sessions, sandboxes: poolSettingsOf(m) } satisfies ToDaemon));
    const watch = this.outsideWatchFor?.(id);
    if (watch !== undefined) ws.send(JSON.stringify({ type: 'outside_watch', config: watch } satisfies ToDaemon));
    const cleanup = this.cleanupFor?.(id);
    if (cleanup) ws.send(JSON.stringify({ type: 'cleanup_config', config: cleanup } satisfies ToDaemon));
    console.log(`machine ${id} connected`);
  }

  private detach(id: string) {
    this.links.delete(id);
    this.hellos.delete(id);
    if (this.stats.delete(id)) emit({ type: 'machine_stats', id, stats: null });
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
        Object.assign(m, { info: msg.info, home: msg.home || m.home, platform: msg.info?.platform ?? m.platform, daemonStopped: undefined });
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
        const { id: _i, kind: _k, machineId: _m, standingId: _s, sandboxId: _b, title: _t, createdAt: _c, label: _l, labelAt: _la, activeTool: _at, ...run } = msg.info;
        // The portal sees the daemon's events as they come (Store.noteActivity): never step activity back.
        if (run.lastActivityAt && s.info.lastActivityAt && run.lastActivityAt < s.info.lastActivityAt) run.lastActivityAt = s.info.lastActivityAt;
        // "The login of the computer it runs on", there: this Mac's login, not this host's.
        if (run.account === HOST_LOGIN) run.account = machineLogin(id);
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
        if (this.handle(msg.sessionId)?.info.machineId === id) {
          emit({ type: 'delta', sessionId: msg.sessionId, text: msg.text });
          this.store.noteActivity(msg.sessionId);
        }
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
        this.unityEvent?.(id, msg.text, msg.restarted, typeof msg.sandbox === 'string' ? msg.sandbox : undefined);
        return;
      }
      case 'sandboxes': {
        if (!Array.isArray(msg.list)) return;
        m.sandboxes = mergeSandboxes(m.sandboxes, msg.list, this.pendingPurpose);
        for (const sb of m.sandboxes) this.pendingPurpose.delete(sb.id);
        if (msg.disk) this.disks.set(id, msg.disk);
        this.store.putMachine(m);
        return;
      }
      case 'sandbox_result': {
        const p = this.sandboxCalls.get(msg.id);
        if (!p) return;
        this.sandboxCalls.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.text);
        else p.reject(new Error(msg.text));
        return;
      }
      case 'sandbox_event':
        this.sandboxEvent?.(id, msg.text, { sandbox: msg.sandbox, checkpoint: !!msg.checkpoint });
        return;
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
      case 'stats': {
        const stats: MachineStats = { ...msg.stats, at: new Date().toISOString() };
        this.stats.set(id, stats);
        emit({ type: 'machine_stats', id, stats });
        return;
      }
      case 'usage':
        this.onUsage?.(id, msg.account, msg.usage);
        return;
      case 'cleanup':
        m.lastCleanup = msg.summary;
        this.store.putMachine(m);
        if (msg.notice) this.cleanupNotice?.(id, msg.notice);
        return;
      case 'max_event':
        if (typeof msg.line === 'string' && msg.line.length <= 8192) this.maxEvent?.(id, msg.line);
        return;
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
  /** The daemon's Unity watch reported something (wired by index.ts: orchestrator, notification, the agents there). `sandbox`: a sandbox's editor. */
  unityEvent?: (machineId: string, text: string, restarted: boolean, sandbox?: string) => void;
  /** The sandbox pool reported something: the disk guard (checkpoint: ask its busy agents to commit and stop), an idle editor stopped (wired by index.ts). */
  sandboxEvent?: (machineId: string, text: string, e: { sandbox?: string; checkpoint: boolean }) => void;

  // ---------------------------------------------------------------- machine sandboxes (docs/machines.md, machine/sandboxes.ts)

  private readonly sandboxCalls = new Map<string, { resolve: (text: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** Purposes of sandboxes asked for and not yet in a snapshot. */
  private readonly pendingPurpose = new Map<string, string>();
  /** Each machine's sandbox volume, as its daemon last reported it (memory only). */
  private readonly disks = new Map<string, { level: 'ok' | 'warn' | 'critical'; freeBytes?: number }>();

  diskOf(id: string) {
    return this.disks.get(id);
  }

  /** A machine's sandbox by id or name. */
  requireSandbox(machineId: string, sandbox: string): MachineSandbox {
    const m = this.require(machineId);
    const want = slugify(sandbox);
    const sb = (m.sandboxes ?? []).find((s) => s.id === sandbox || s.id === want);
    if (!sb) throw new Error(`no sandbox "${sandbox}" on ${m.id} (have: ${(m.sandboxes ?? []).map((s) => s.id).join(', ') || 'none'})`);
    return sb;
  }

  /** Throws unless the machine is online with a daemon that knows sandboxes (protocol 5+). */
  requireSandboxDaemon(machineId: string) {
    const m = this.require(machineId);
    if (!this.isOnline(m.id)) throw new Error(`machine ${m.id} is offline (asleep, or its daemon is not running)`);
    const h = this.hellos.get(m.id);
    if (!h || h.protocol < SANDBOX_PROTOCOL) {
      this.checkOutdated();
      throw new Error(`${m.id}'s daemon ${h ? `speaks protocol ${h.protocol}` : 'has not said hello yet'} and does not know sandboxes; it is redeployed once no agent runs there. Try again in a few minutes.`);
    }
    return m;
  }

  private sandboxCall(machineId: string, msg: Record<string, unknown>, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.sandboxCalls.delete(id);
        reject(new Error(`machine ${machineId} did not answer in ${Math.round(timeoutMs / 60_000)} minutes`));
      }, timeoutMs);
      this.sandboxCalls.set(id, { resolve, reject, timer });
      try {
        this.post(machineId, { type: 'sandbox', id, ...msg } as ToDaemon);
      } catch (e) {
        clearTimeout(timer);
        this.sandboxCalls.delete(id);
        reject(e as Error);
      }
    });
  }

  /** Create a sandbox on a machine: a worktree of its main clone in its sandbox_root (returns once the daemon recorded it). */
  async createSandbox(machineId: string, req: { name: string; purpose?: string; branch?: string; base?: string; seedLibrary?: boolean; startUnity?: boolean }): Promise<string> {
    const m = this.requireSandboxDaemon(machineId);
    const pool = poolSettingsOf(m);
    if (!pool) throw new Error(`${m.id} has no sandboxes: redeploy it with add_machine sandbox_root (e.g. "D:\\work\\ffsb")`);
    const id = slugify(req.name);
    if (!SANDBOX_ID.test(id)) throw new Error(`"${req.name}" does not make a usable sandbox name`);
    if ((m.sandboxes ?? []).some((s) => s.id === id)) throw new Error(`sandbox "${id}" already exists on ${m.id}`);
    if ((m.sandboxes ?? []).length >= pool.maxSandboxes) throw new Error(`already ${m.sandboxes!.length} sandboxes on ${m.id} (max_sandboxes ${pool.maxSandboxes}); delete one first`);
    const branch = req.branch?.trim() || `sandbox/${id}`;
    const problem = branchProblem(branch);
    if (problem) throw new Error(problem);
    const base = req.base?.trim() || this.cfg.defaultBase;
    const purpose = req.purpose?.trim() ? normalizePurpose(req.purpose) : 'unused';
    this.pendingPurpose.set(id, purpose);
    try {
      return await this.sandboxCall(m.id, { op: 'create', sandbox: id, branch, base, seedLibrary: req.seedLibrary ?? true, startUnity: req.startUnity ?? false }, 2 * 60_000);
    } catch (e) {
      this.pendingPurpose.delete(id);
      throw e;
    }
  }

  /** Delete a machine sandbox (its editor, Library, worktree; the branch stays unless deleteBranch). Returns when it is gone. */
  async deleteSandbox(machineId: string, sandbox: string, deleteBranch = false): Promise<string> {
    const m = this.requireSandboxDaemon(machineId);
    const sb = this.requireSandbox(m.id, sandbox);
    const text = await this.sandboxCall(m.id, { op: 'delete', sandbox: sb.id, deleteBranch }, 60 * 60_000);
    m.sandboxes = (m.sandboxes ?? []).filter((s) => s.id !== sb.id);
    this.store.putMachine(m);
    return text;
  }

  setSandboxPurpose(machineId: string, sandbox: string, purpose: string): MachineSandbox {
    const m = this.require(machineId);
    const sb = this.requireSandbox(m.id, sandbox);
    if (sb.status === 'deleting') throw new Error(`sandbox ${m.id}/${sb.id} is being deleted`);
    sb.purpose = normalizePurpose(purpose);
    this.store.putMachine(m);
    return sb;
  }

  sandboxLog(machineId: string, sandbox: string, lines: number): Promise<string> {
    this.requireSandboxDaemon(machineId);
    return this.sandboxCall(machineId, { op: 'log', sandbox: this.requireSandbox(machineId, sandbox).id, lines }, 60_000);
  }
  /** A line from the Mac's Max events file (server/max.ts validates it). */
  maxEvent?: (machineId: string, line: string) => void;

  /** Status, start, stop or restart the Unity editor of a machine's clone, on the machine (machine/unity.ts). */
  unity(machineId: string, action: 'status' | 'start' | 'stop' | 'restart', force?: boolean, sandbox?: string) {
    const m = this.require(machineId);
    if (!this.isOnline(m.id)) throw new Error(`machine ${m.id} is offline`);
    // Never a sandbox field to a daemon that would ignore it and act on the main clone.
    const sb = sandbox ? (this.requireSandboxDaemon(m.id), this.requireSandbox(m.id, sandbox).id) : undefined;
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.unityCalls.delete(id);
        reject(new Error(`machine ${m.id} did not answer the unity ${action} in 3 minutes (an old daemon? redeploy it with add_machine)`));
      }, 3 * 60_000);
      this.unityCalls.set(id, { resolve, reject, timer });
      try {
        this.post(m.id, { type: 'unity', id, action, force, ...(sb ? { sandbox: sb } : {}) });
      } catch (e) {
        clearTimeout(timer);
        this.unityCalls.delete(id);
        reject(e as Error);
      }
    });
  }

  private readonly switchCalls = new Map<string, { resolve: (r: { from: string; to: string; notes: string[] }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /** Switch the branch of a machine's clone, on the machine (server/switchBranch.ts). */
  switchBranch(machineId: string, branch: string, createFrom?: string, sandbox?: string) {
    const sb = sandbox ? (this.requireSandboxDaemon(machineId), this.requireSandbox(machineId, sandbox).id) : undefined;
    return new Promise<{ from: string; to: string; notes: string[] }>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.switchCalls.delete(id);
        reject(new Error(`machine ${machineId} did not finish the switch in 10 minutes`));
      }, 10 * 60_000);
      this.switchCalls.set(id, { resolve, reject, timer });
      try {
        this.post(machineId, { type: 'switch', id, branch, createFrom, ...(sb ? { sandbox: sb } : {}) });
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

/**
 * Whether ssh reaches a host non-interactively (keys only, 10 s). The command is `exit 0`, which every default
 * shell runs (zsh, bash, cmd.exe, PowerShell); `true` is not a command in cmd.exe or PowerShell.
 */
export async function sshReachable(host: string): Promise<boolean> {
  const { run } = await import('./proc.ts');
  const r = await run('ssh', SSH_REACHABLE_ARGS(host), { timeoutMs: 20_000 });
  return r.code === 0;
}

export const SSH_REACHABLE_ARGS = (host: string) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'exit', '0'];

/** Where a machine's daemon log is, for messages. */
export function daemonLogPath(platform: MachinePlatform | undefined, appDir?: string): string {
  if (platform === 'win32') return `${appDir ?? '%USERPROFILE%\\.ff-factory'}\\logs\\daemon.log (and daemon.err.log, supervisor.log)`;
  return `${appDir ?? '~/.ff-factory'}/logs/daemon.log`;
}

/**
 * A folder option as stored: trimmed, without a trailing slash, a Windows one (C:\... or C:/...) with backslashes.
 * Throws unless absolute. Exported for tests.
 */
export function machineDir(p: string | undefined, what: string): string | undefined {
  const t = p?.trim();
  if (!t) return undefined;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return winDir(t);
  if (t.startsWith('/')) return t.replace(/(?<=.)\/+$/, '');
  throw new Error(`${what} "${t}" must be an absolute path (/Users/... on a Mac, D:\\... on Windows)`);
}

/**
 * The folder options a deploy stores (add_machine): each given one checked and normalised (machineDir), "" back to the
 * default, an unset one kept from the previous deploy. Exported for tests.
 */
export function dirOptions(opts: MachineDirs, prev: MachineDirs | undefined): MachineDirs {
  const pick = (k: keyof MachineDirs, what: string) => (opts[k] === undefined ? prev?.[k] : machineDir(opts[k], what));
  return { appDir: pick('appDir', 'app_dir'), unityEditorRoot: pick('unityEditorRoot', 'unity_editor_root'), unityPath: pick('unityPath', 'unity_path'), tempDir: pick('tempDir', 'temp_dir'), sandboxRoot: pick('sandboxRoot', 'sandbox_root') };
}

/**
 * The machine whose clone, home or daemon folder (app_dir) holds `file` (the orchestrator's inline images), or undefined. A Windows
 * machine's paths compare case-insensitively with either slash; a Mac's exactly.
 */
export function machineForPath<M extends Pick<Machine, 'repoPath' | 'home' | 'platform' | 'appDir'> & { sandboxRoot?: string }>(file: string, machines: M[]): M | undefined {
  const win = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return machines.find((m) =>
    [m.repoPath, m.home, m.appDir, m.sandboxRoot].some((r) => {
      if (!r) return false;
      if (m.platform === 'win32') {
        if (!/^[a-z]:[\\/]/i.test(file)) return false;
        const f = win(file);
        const root = win(r);
        return f === root || f.startsWith(root + '/');
      }
      return file.startsWith('/') && (file === r || file.startsWith(r.replace(/\/+$/, '') + '/'));
    }),
  );
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

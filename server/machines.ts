import { MACHINE_ID, dropStagedToken, enrolledMachines, issueMachineToken, machineTokensFile, promoteStagedToken, readMachineTokens, revokeMachineToken, stageMachineToken, stagedKey, tokenSha } from './machineTokens.ts';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_USAGE_POLL_MINUTES, ROOT, type Config } from './config.ts';
import { emit, type Store } from './store.ts';
import { isMidTurn, type SessionHandle, type SessionManager } from './sessions.ts';
import type { CatalogTool, LaunchSpec, ToolHandler } from './launch.ts';
import type { RemoteVoiceStatus } from '../shared/voice.ts';
import { ATTACHMENT_PROTOCOL, MAIN_CLONE_NO_AGENTS, RELOCATE_FALLBACK_MINUTES, RELOCATE_PROTOCOL, SANDBOX_PROTOCOL, protocolProblem, relocateProblem, type DaemonSandbox, type FromDaemon, type ToDaemon } from './machineProtocol.ts';
import type { OutsideWatchConfig } from '../machine/outsideWatch.ts';
import { branchProblem, normalizePurpose, slugify } from './sandboxes.ts';
import { winDir } from './machineDeployWin.ts';
import type { DaemonExtras, DeployOptions, DeployResult, MachineDirs } from './machineDeploy.ts';
import { openPr } from './gitStatus.ts';
import { movedNote } from './placeAgain.ts';
import { safeImage } from './images.ts';
import { HOST_LOGIN, machineLogin, type AccountIdentity } from './usage.ts';
import type { AttachmentStore } from './attachments.ts';
import type { DeliveredAttachment, EffortLevel, ImageInput, Machine, MachineGuardSettings, MachinePlatform, MachineSandbox, MachineStats, PermissionMode, PlanUsage, Requester, SandboxPoolSettings, SessionInfo, CleanupSummary } from '../shared/types.ts';
import { DISK_CRITICAL_GB_DEFAULT, DISK_WARN_GB_DEFAULT } from '../shared/types.ts';
import type { StaleContext } from './staleOutput.ts';
import { checkStringMap, readJsonDurable, writeJsonDurable } from './durable.ts';
import { DRY_RUN_WHY, dryRun, refuseInDryRun } from './dryRun.ts';
import { writeKnownHosts, type MachineSsh } from './machineSsh.ts';

const PING_MS = 20_000;
const DEAD_MS = 45_000;
/**
 * A clip goes to a machine's GPU Whisper with a ping ahead of it (w615): no pong or message within this long and the
 * link is taken for dead, so the clip falls back at once instead of waiting out its timeout, and later clips skip that
 * machine until it is heard from again. The heartbeat alone drops a dead link only after DEAD_MS (45-65 s). BEAST to the
 * portal VM measured 31 ms (tailscale ping, 2026-10-07). Tests shorten it.
 */
export const VOICE_PING_MS = { value: 2000 };
/**
 * After a clip to a machine timed out on a live link (its Whisper hung, say), the next clips go straight to the portal's
 * own Whisper for this long, or until the machine re-offers its Whisper (a `voice` status or a new hello); then one clip
 * tries it again (w615, lothsahn: later clips must not wait on it every time). Tests shorten it.
 */
export const VOICE_RETRY_MS = { value: 2 * 60_000 };
/** Statuses of an agent in the middle of a turn. */
const MID_TURN = new Set(['running', 'starting', 'waiting_permission']);
/** Run-state fields the daemon clears (absent from its JSON report once cleared). */
const CLEARABLE = ['turnOpenSince', 'backgroundTasks', 'backgroundJobs', 'statusDetail'] as const;

/**
 * Whether a machine worker counts as cut off mid-turn when its link drops: its daemon reported its process live on
 * that link (`seenLive`), it is in a turn (status, or the turn mark a daemon going down keeps), it was not stopped
 * on purpose, and it was active within RESUME_WITHIN_MS. The portal's own marks and activity times are not enough:
 * a mark the daemon never cleared (the agent is not in its memory any more) and an error line from a refused
 * resume (which moves lastActivityAt) made 8 agents finished for hours look cut off when M5's outdated daemon was
 * redeployed (2026-09-29). Every daemon version reports `live`. Exported for tests.
 */
export function cutOffMidTurn(i: Pick<SessionInfo, 'kind' | 'status' | 'turnOpenSince' | 'lastActivityAt' | 'stoppedOnPurpose'>, seenLive: boolean, now: number): boolean {
  if (i.kind !== 'worker' || !seenLive || i.stoppedOnPurpose || !(MID_TURN.has(i.status) || i.turnOpenSince)) return false;
  return now - (Date.parse(i.lastActivityAt) || 0) <= RESUME_WITHIN_MS;
}

/** Agents cut off longer ago than this are reported, not resumed. */
const RESUME_WITHIN_MS = 6 * 3_600_000;
/** How long after a daemon's hello the resume messages go out. */
export const RESUME_DELAY_MS = { value: 3000 };
export { MAIN_CLONE_NO_AGENTS };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');


/** Machine ids: short, lower-case, safe in a path and a LaunchAgent label. */
export { MACHINE_ID, enrolledMachines, issueMachineToken, revokeMachineToken };

const SANDBOX_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A machine's sandbox limits as add_machine takes them (docs/machines.md, "Machine sandboxes"). */
export interface SandboxLimits {
  maxSandboxes?: number;
  maxAgentsPerSandbox?: number;
  maxUnity?: number;
  diskWarnGB?: number;
  diskCriticalGB?: number;
  /** Live agents across all its sandboxes (unset: no total). */
  maxSandboxAgents?: number;
}

/** A machine's pool extras (docs/beast-machine.md): the Library seed, editor priority and the folders never to touch. */
export type PoolExtras = Pick<Machine, 'librarySeed' | 'librarySeedCopy' | 'librarySeedGB' | 'unityBelowNormal' | 'protectedPaths'>;

/** The pool settings of a machine (its sandbox_root and limits, with defaults), or null when it has no sandbox_root. Exported for tests. */
export function poolSettingsOf(m: Pick<Machine, 'sandboxRoot'> & SandboxLimits & PoolExtras): SandboxPoolSettings | null {
  if (!m.sandboxRoot) return null;
  const warn = m.diskWarnGB ?? DISK_WARN_GB_DEFAULT;
  return {
    root: m.sandboxRoot,
    maxSandboxes: m.maxSandboxes ?? 3,
    maxAgentsPerSandbox: m.maxAgentsPerSandbox ?? 2,
    maxUnity: m.maxUnity ?? 2,
    diskWarnGB: warn,
    diskCriticalGB: Math.min(m.diskCriticalGB ?? DISK_CRITICAL_GB_DEFAULT, warn),
    ...(m.maxSandboxAgents !== undefined ? { maxAgents: m.maxSandboxAgents } : {}),
    ...(m.librarySeed ? { librarySeed: m.librarySeed } : {}),
    ...(m.librarySeedCopy ? { librarySeedCopy: m.librarySeedCopy } : {}),
    ...(m.librarySeedGB !== undefined ? { librarySeedGB: m.librarySeedGB } : {}),
    ...(m.unityBelowNormal ? { belowNormal: true } : {}),
    ...(m.protectedPaths?.length ? { protectedPaths: m.protectedPaths } : {}),
  };
}

/**
 * Standing agents a machine without sandboxes may run at once (w536): it takes no workers, so this caps its standing
 * agents alone, as the old main-clone default did.
 */
export const STANDING_CAP_NO_POOL = 2;

/**
 * A machine's one live-agent cap (w536): the agents mid-turn in its sandboxes and its standing agents together. With a
 * pool it is max_sandbox_agents, else every sandbox full (max_sandboxes x max_agents_per_sandbox).
 */
export function agentCap(m: Pick<Machine, 'sandboxRoot'> & SandboxLimits & PoolExtras): number {
  const pool = poolSettingsOf(m);
  return pool ? (pool.maxAgents ?? pool.maxSandboxes * pool.maxAgentsPerSandbox) : STANDING_CAP_NO_POOL;
}

/**
 * What the portal's own host takes from this server's config when it becomes a machine (add_machine local, docs/
 * beast-machine.md): the base clone as its main clone, config sandboxRoot as its sandbox root, protected paths (plus
 * this app and its data) and disk thresholds, editors below normal (the live game wins), and this server's own loopback
 * address. Its limits and Library seed are add_machine's own (max_sandboxes, max_unity, library_seed, …; the portal's
 * own pool's limits went with it, w510). Anything add_machine is given explicitly wins. Exported for tests.
 */
export function localMachineDefaults(cfg: Pick<Config, 'port' | 'repo' | 'sandboxRoot' | 'protectedPaths' | 'dataDir' | 'hostGuard'>, root = ROOT) {
  return {
    host: 'localhost',
    portalUrl: `http://127.0.0.1:${cfg.port}`,
    repoPath: cfg.repo.basePath,
    sandboxRoot: cfg.sandboxRoot,
    diskWarnGB: cfg.hostGuard.warnFreeGB,
    diskCriticalGB: Math.min(cfg.hostGuard.criticalFreeGB, cfg.hostGuard.warnFreeGB),
    protectedPaths: [...new Set([...cfg.protectedPaths, root, cfg.dataDir].filter(Boolean))],
    unityBelowNormal: true,
  };
}

/**
 * A machine's record turned from the portal's own host (`local`) into one reached over ssh, or back (convert_machine,
 * w466; docs/portal-on-ffbox-host.md change 3). Only how it is reached changes: its id, token, sandboxes, agents,
 * limits, pool settings and protected paths stay, so nothing on the machine moves. To ssh: `sshHost` and a portal URL
 * it can reach (not a loopback one) are needed, and `extras` (the daemon.json settings a local deploy took from the
 * portal's config) are kept for its redeploys. Back to local: this portal's loopback address unless given. Exported for
 * tests and the migration script, which rewrites a copy of state.json the same way.
 */
export function convertMachineRecord(m: Machine, to: 'ssh' | 'local', o: { sshHost?: string; portalUrl?: string; port: number; publicUrl?: string; extras?: DaemonExtras }): Machine {
  const next: Machine = { ...m };
  if (to === 'ssh') {
    if (!m.local) throw new Error(`${m.id} is reached over ssh already`);
    const host = o.sshHost?.trim();
    if (!host || /\s/.test(host)) throw new Error('ssh_host is required: the ssh host alias this portal reaches the machine by (e.g. "beast")');
    const url = (o.portalUrl ?? o.publicUrl ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s?#]+$/.test(url)) throw new Error('portal_url is required: the address the machine reaches this portal at, e.g. https://<host>.<tailnet>.ts.net');
    if (/^https?:\/\/(localhost|127\.[\d.]+|\[::1\])(:\d+)?$/i.test(url)) throw new Error(`${url} is a loopback address: a machine reached over ssh reaches the portal by its network address`);
    delete next.local;
    next.host = host;
    next.portalUrl = url;
    const keep = { ...(o.extras?.unityMcpServer ? { unityMcpServer: o.extras.unityMcpServer } : {}), ...(o.extras?.sandboxIdleStopMinutes !== undefined ? { sandboxIdleStopMinutes: o.extras.sandboxIdleStopMinutes } : {}), ...(o.extras?.hostGuard ? { hostGuard: o.extras.hostGuard } : {}) };
    if (Object.keys(keep).length) next.daemonExtras = keep;
    return next;
  }
  if (m.local) throw new Error(`${m.id} is the portal's own host already`);
  const url = (o.portalUrl ?? `http://127.0.0.1:${o.port}`).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s?#]+$/.test(url)) throw new Error(`portal_url ${url} is not a base URL`);
  next.local = true;
  next.host = 'localhost';
  next.portalUrl = url;
  delete next.daemonExtras;
  return next;
}

/**
 * daemon.json extras for the portal's own host (MachineManager.localExtras), from this server's config: the MCP-for-Unity
 * server its workers had, no Max events file of its own, the idle-editor stop, no clean-up of its own, and the host
 * guard (w466). The migration to the VM (server/vmMigration.ts, w499) keeps the ssh-relevant ones when BEAST stops being
 * the portal's host.
 */
export function localDaemonExtras(cfg: Pick<Config, 'unity' | 'hostGuard' | 'hostDiskPaths' | 'limits'>): DaemonExtras {
  const u = cfg.unity;
  return {
    ...(u.mcpServer ? { unityMcpServer: { command: u.mcpServer.command, args: u.mcpServer.args, ...(u.mcpServer.env ? { env: u.mcpServer.env } : {}) } } : {}),
    maxEventsFile: null,
    sandboxIdleStopMinutes: u.idleStopMinutes,
    // No clean-up of its own even before the portal's first welcome: this host's guard cleans this computer.
    cleanup: { everyMinutes: 0, softFreeGB: 0 },
    // The drive watch and remount, its disks and the reaper run in its daemon (w466, D11): the portal hands them over
    // as soon as the daemon's hello says its guard runs, and they stay with BEAST when the portal moves to its VM.
    ...((cfg.hostGuard?.pollSeconds ?? 0) > 0 ? { hostGuard: guardSettingsOf(cfg) } : {}),
  };
}

/** The host guard settings the portal's own host's daemon gets (w466): this server's own guard's, for the same computer. Exported for tests. */
export function guardSettingsOf(cfg: Pick<Config, 'hostGuard' | 'hostDiskPaths' | 'limits'>): MachineGuardSettings {
  const g = cfg.hostGuard;
  return { pollSeconds: g.pollSeconds, warnFreeGB: g.warnFreeGB, criticalFreeGB: g.criticalFreeGB, hysteresisGB: g.hysteresisGB, remountMinFreeGB: g.remountMinFreeGB, hostDiskPaths: [...cfg.hostDiskPaths], reapBrowsersAfterHours: g.reapBrowsersAfterHours, reapEveryMinutes: g.reapEveryMinutes, minFreeRamGB: cfg.limits.minFreeRamGB };
}

/** The limits a deploy stores: each given one checked, an unset one kept from the previous deploy. Exported for tests. */
export function limitOptions(opts: SandboxLimits, prev: SandboxLimits | undefined): SandboxLimits {
  const pick = (k: keyof SandboxLimits, min: number, max: number) => {
    const v = opts[k] ?? prev?.[k];
    if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) throw new Error(`${k} must be a whole number from ${min} to ${max}`);
    return v;
  };
  const out = { maxSandboxes: pick('maxSandboxes', 1, 8), maxAgentsPerSandbox: pick('maxAgentsPerSandbox', 1, 8), maxUnity: pick('maxUnity', 0, 8), diskWarnGB: pick('diskWarnGB', 1, 10_000), diskCriticalGB: pick('diskCriticalGB', 1, 10_000), maxSandboxAgents: pick('maxSandboxAgents', 1, 16) };
  if (out.diskWarnGB !== undefined && out.diskCriticalGB !== undefined && out.diskCriticalGB > out.diskWarnGB) throw new Error('disk_critical_gb must not be above disk_warn_gb');
  return out;
}

/**
 * A machine's sandboxes after a daemon snapshot: the daemon's facts (folder, branch, status, editor, git) with the
 * portal's agents kept by id. The label is the sandbox's name and never changes (w575): slot1..N on a worker root,
 * the old names (agent-mcp, shader-blackhole) elsewhere; what a sandbox is doing shows as its agents' titles. Exported
 * for tests.
 */
export function mergeSandboxes(prev: MachineSandbox[] | undefined, list: DaemonSandbox[]): MachineSandbox[] {
  const old = new Map((prev ?? []).map((s) => [s.id, s]));
  return list.map((d) => ({ ...d, purpose: d.id, sessionIds: old.get(d.id)?.sessionIds ?? [] }));
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
  /** Its daemon reported its process live on the current link (hello or a session report); reset when the link drops. */
  seenLive = false;
  private readonly link: MachineManager;

  constructor(info: SessionInfo, link: MachineManager) {
    this.info = info;
    this.link = link;
  }

  get live() {
    return this.liveFlag;
  }

  send(text: string, from: 'human' | 'orchestrator' | 'system' = 'human', uuid: string = randomUUID(), images: ImageInput[] = [], requestedBy?: Requester, attachments: DeliveredAttachment[] = []): string {
    if (requestedBy && from !== 'system') this.info.lastRequestedBy = requestedBy;
    this.link.dispatchSend(this, text, from, uuid, images, requestedBy, attachments);
    this.lastFrom = from;
    // A new turn: the stop is over (as AgentSession.send), and so is the hold on its sandbox after its daemon went (w613).
    if (this.info.stoppedOnPurpose || this.info.heldSince) {
      delete this.info.stoppedOnPurpose;
      delete this.info.heldSince;
      this.link.touch(this);
    }
    return uuid;
  }

  async interrupt() {
    this.link.stoppedOnPurpose(this);
    this.link.post(this.info.machineId!, { type: 'interrupt', sessionId: this.info.id }, false);
  }

  async setMode(mode: PermissionMode) {
    this.info.permissionMode = mode;
    this.link.touch(this);
    this.link.post(this.info.machineId!, { type: 'mode', sessionId: this.info.id, mode }, false);
  }

  stop(onPurpose = true) {
    if (onPurpose) this.link.stoppedOnPurpose(this);
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
  /** The attachment store (docs/attachments.md): what daemons may fetch, granted as files are sent to their agents. */
  attachments?: AttachmentStore;
  /** `hash`: the credential hash the link authenticated with (or the portal re-issued since, register): dropRevoked compares it. */
  private readonly links = new Map<string, { ws: WebSocket; lastPong: number; since: number; hash?: string }>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private readonly tokensFile: string;
  private readonly failures = new Map<string, number[]>();

  constructor(cfg: Config, store: Store, sessions: SessionManager) {
    this.cfg = cfg;
    this.store = store;
    this.sessions = sessions;
    sessions.placeFull = (s) => this.placeFull(s);
    this.tokensFile = machineTokensFile(cfg.dataDir);
    // A deploy runs in this process: one still marked at boot was cut short by a restart. Left 'deploying', the
    // offline watch (redeployDue) would never redeploy it; its daemon's hello clears the error if it did start.
    for (const m of store.machines.values()) {
      if (m.status !== 'deploying') continue;
      Object.assign(m, { status: 'error', statusDetail: `a portal restart interrupted its deploy${m.statusDetail ? ` (at: ${m.statusDetail})` : ''}` });
      store.putMachine(m);
    }
    // max_agents went with main-clone workers (w536): an old record's is dropped, and said once, after index.ts has
    // wired report.
    const dropped: string[] = [];
    for (const m of store.machines.values() as Iterable<Machine & { maxSessions?: number }>) {
      if (m.maxSessions === undefined) continue;
      delete m.maxSessions;
      store.putMachine(m);
      dropped.push(m.id);
    }
    if (dropped.length) {
      const text = `[machines] max_agents is gone (w536): workers run in sandboxes only and standing agents count against the machine's agent cap; dropped it from ${dropped.join(', ')}`;
      setImmediate(() => (this.report ? this.report(text) : console.log(text)));
    }
    // Labels set before w575 (a worker's set_label, set_sandbox_label) give way to the sandbox's name.
    for (const m of store.machines.values()) {
      if (!m.sandboxes?.some((sb) => sb.purpose !== sb.id)) continue;
      m.sandboxes = m.sandboxes.map((sb) => ({ ...sb, purpose: sb.id }));
      store.putMachine(m);
    }
    setInterval(() => this.heartbeat(), PING_MS).unref();
  }

  /** Whose ~/.ssh holds the pinned host keys: the portal account's home (tests point it at a folder of their own). */
  sshHome?: string;

  /**
   * The portal's ~/.ssh/known_hosts2 from its machines' registered host keys (server/machineSsh.ts, w568). The pins
   * live in the records (state.json), so the server writes the file again at start (index.ts): a rebuilt or moved
   * portal keeps them.
   */
  pinHostKeys(home = this.sshHome) {
    try {
      const r = writeKnownHosts(this.list(), home);
      if (r === 'not ours') console.warn("machines: ~/.ssh/known_hosts2 is not the portal's (no FF Factory header); the machines' host keys are not pinned there");
    } catch (e) {
      console.warn(`machines: could not write ~/.ssh/known_hosts2: ${(e as Error).message}`);
    }
  }

  /** How the portal checks it gets in over ssh (tests replace it). */
  sshCheck: (host: string) => Promise<{ reachable: boolean; detail: string }> = sshCheck;

  /**
   * A worker installer's ssh registration (POST /machine/ssh, w568): the user and name the portal reaches the machine
   * by, and its sshd's host keys. Kept on the record, pinned in known_hosts2, and the record's ssh host becomes
   * user@host; then a check that ssh gets in with the key the installer authorized there.
   */
  async registerSsh(id: string, ssh: MachineSsh): Promise<{ host: string; reachable: boolean; detail: string }> {
    refuseInDryRun(`registering ${id}'s ssh`);
    const m = this.require(id);
    const host = `${ssh.user}@${ssh.host}`;
    this.update(m.id, { ssh, host });
    this.pinHostKeys();
    const r = await this.sshCheck(host);
    console.log(`machine ${m.id}: ssh registered as ${host} (${ssh.hostKeys.length} host key(s) pinned); ${r.reachable ? 'the portal gets in' : `the portal does not get in yet: ${r.detail}`}`);
    return { host, ...r };
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

  // ---------------------------------------------------------------- agents cut off by a dropped link

  /** Agents that were mid-turn when a machine's link dropped: resumed if its daemon comes back without them. */
  private readonly cutOff = new Map<string, { at: number; why: string; sessions: string[] }>();
  /** Why the next drop of a machine's link is expected (a forced redeploy, a daemon restart); false: do not resume. */
  private readonly dropWhy = new Map<string, string | false>();

  /**
   * Say why a machine's link is about to drop: the resume message names it, and `false` (a daemon stopped on
   * purpose) means its agents stay stopped.
   */
  expectDrop(machineId: string, why: string | false) {
    this.dropWhy.set(machineId, why);
    // Stopped on purpose, also when its link was already down: nothing cut off earlier is resumed later.
    if (why === false) this.cutOff.delete(machineId);
  }

  /**
   * An agent stopped or interrupted on purpose (stop_agent, interrupt_agent, the UI): its turn is over, whatever the
   * daemon still has or reports, so no dropped link resumes it, one that already dropped included, until it is sent
   * a message again (RemoteSession.send). Kept in the store: a portal restart does not forget it.
   */
  stoppedOnPurpose(s: RemoteSession) {
    s.info.stoppedOnPurpose = true;
    delete s.info.heldSince;
    delete s.info.turnOpenSince;
    delete s.info.backgroundTasks;
    delete s.info.backgroundJobs;
    // No process to report back (the daemon lost it, or the link is down): it is not running.
    if (!s.live && MID_TURN.has(s.info.status)) Object.assign(s.info, { status: 'stopped', pendingPermissions: [] });
    for (const c of this.cutOff.values()) c.sessions = c.sessions.filter((sid) => sid !== s.info.id);
    this.store.putSession(s.info);
  }

  /**
   * The daemon is back (hello): agents that were mid-turn when its link dropped and that it no longer runs (it
   * was redeployed, restarted or crashed; not a network blip, after which they are still live) get a resume
   * message, as after a portal restart. Only an outdated daemon (a protocol this portal no longer drives) cannot start
   * them: that waits for its redeploy. One that merely has an update available resumes them at once (w605).
   */
  private resumeCutOff(machineId: string, live: Set<string>, now = Date.now()) {
    const c = this.cutOff.get(machineId);
    if (!c || this.outdated(machineId)) return;
    this.cutOff.delete(machineId);
    const gone = c.sessions.filter((sid) => !live.has(sid) && this.handle(sid) && !this.handle(sid)!.info.stoppedOnPurpose);
    if (!gone.length) return;
    const when = new Date(c.at).toLocaleTimeString();
    if (now - c.at > RESUME_WITHIN_MS) {
      this.report?.(`[machines] ${machineId} is back; ${gone.length} agent(s) were mid-turn when its daemon ${c.why} at ${when}, too long ago to resume by themselves: ${gone.join(', ')}. Message them to continue.`);
      return;
    }
    const resumed: string[] = [];
    for (const sid of gone) {
      try {
        this.sessions.send(
          sid,
          `[machine ${machineId}] The FF Factory daemon on this machine ${c.why} at ${when} while you were mid-turn, which stopped your turn. Your folder is as you left it. Check git status for half-written edits, re-pin your Unity instance if you use one (mcpforunity://instances, then set_active_instance; the editor may have restarted), and continue where you left off.`,
          'system',
        );
        resumed.push(sid);
      } catch (e) {
        this.report?.(`[machines] ${machineId}: could not resume ${sid} after its daemon ${c.why}: ${(e as Error).message}`);
      }
    }
    if (resumed.length) this.report?.(`[machines] ${machineId} is back after its daemon ${c.why}; resumed ${resumed.length} agent(s) that were mid-turn: ${resumed.join(', ')}.`);
  }

  /** A machine's clean-up settings (config machines.cleanup; wired by index.ts). */
  cleanupFor?: (machineId: string) => { everyMinutes: number; softFreeGB: number; staleOutput?: unknown };
  /** The ledger's facts for the stale-output rules (w459; wired by index.ts): sent at connect, every few minutes and before a pass asked for. */
  cleanupContext?: () => StaleContext;
  /** A machine's clean-up pass, in full (what it removed, planned and listed, with why): kept on the portal (wired by index.ts). */
  cleanupLog?: (machineId: string, entry: Record<string, unknown>) => void;
  private readonly cleanupCalls = new Map<string, { resolve: (s: CleanupSummary) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** A machine's clean-up could not get above its soft threshold (wired by index.ts: the orchestrator and a push). */
  cleanupNotice?: (machineId: string, text: string) => void;

  /** Send every connected daemon its clean-up settings (after they changed). */
  pushCleanupConfig() {
    for (const id of this.links.keys()) {
      const c = this.cleanupFor?.(id);
      if (c) this.post(id, { type: 'cleanup_config', config: c }, false);
    }
  }

  /** Send every connected daemon the ledger's facts for the stale-output rules (w459). */
  pushCleanupContext() {
    const ctx = this.cleanupContext?.();
    if (!ctx) return;
    for (const id of this.links.keys()) if (!this.store.machines.get(id)?.local) this.post(id, { type: 'cleanup_context', context: ctx }, false);
  }

  /** Send every connected daemon the usage poll interval (config usagePollMinutes, after it changed). */
  pushUsageConfig() {
    for (const id of this.links.keys()) this.post(id, { type: 'usage_config', config: { everyMinutes: this.cfg.usagePollMinutes ?? DEFAULT_USAGE_POLL_MINUTES } }, false);
  }

  /** Ask every connected daemon for its login's usage now (the meters' Refresh). Returns how many were asked. */
  requestUsage(): number {
    const ids = [...this.links.keys()];
    for (const id of ids) this.post(id, { type: 'usage_now' }, false);
    return ids.length;
  }

  /**
   * A clean-up pass on the machine now, stale output included, and its result in full: what went (or, `dryRun`, what
   * would go: nothing is removed) and what it kept because it could not attribute it. A daemon from before w459 runs
   * a real pass and never answers: then this says so after `timeoutMs`.
   */
  async cleanupNow(machineId: string, opts: { dryRun?: boolean; timeoutMs?: number } = {}): Promise<CleanupSummary> {
    const m = this.require(machineId);
    if (m.local) throw new Error(`${m.id} is this host: its disk is cleaned by this host's guard (host_recovery "cleanup"), not by its daemon`);
    if (!this.links.has(m.id)) throw new Error(`machine ${m.id} is offline`);
    const ctx = this.cleanupContext?.();
    if (ctx) this.post(m.id, { type: 'cleanup_context', context: ctx });
    const id = randomUUID();
    return new Promise<CleanupSummary>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cleanupCalls.delete(id);
        reject(new Error(`${m.id} did not answer within ${Math.round((opts.timeoutMs ?? 15 * 60_000) / 60_000)} min (a daemon from before w459 runs a real pass and does not answer; list_machines shows its last clean-up)`));
      }, opts.timeoutMs ?? 15 * 60_000);
      this.cleanupCalls.set(id, { resolve, reject, timer });
      try {
        this.post(m.id, { type: 'cleanup_now', id, ...(opts.dryRun ? { dryRun: true } : {}) });
      } catch (e) {
        clearTimeout(timer);
        this.cleanupCalls.delete(id);
        reject(e as Error);
      }
    });
  }

  /**
   * A machine whose daemon has not come back 2 minutes after this server started or after it dropped, while
   * its host answers ssh, gets redeployed (what add_machine does by hand), at most every 30 minutes.
   */
  async watchOffline(now = Date.now(), reachable: (host: string) => Promise<boolean> = sshReachable): Promise<string[]> {
    const done: string[] = [];
    // A dry run (server/dryRun.ts) probes and redeploys nothing: every machine belongs to the real portal.
    if (dryRun()) return done;
    for (const m of this.list()) {
      if (this.isOnline(m.id)) {
        this.offlineSince.delete(m.id);
        continue;
      }
      if (!this.offlineSince.has(m.id)) this.offlineSince.set(m.id, now);
      if (m.daemonStopped) continue; // stopped on purpose (machine_daemon stop): it stays down until started
      if (m.relocatedTo) continue; // sent to another portal (relocate): a redeploy from here would pull it back
      if (m.root) continue; // a worker root install (w513) is started and updated on its computer, never over ssh
      const why = redeployDue({ status: m.status, deploying: this.deploying.has(m.id), liveAgents: this.liveCount(m.id) }, now - this.offlineSince.get(m.id)!, now - (this.lastAutoDeploy.get(m.id) ?? 0));
      if (!why) continue;
      // The portal's own host needs no ssh: it is always there when this code runs.
      if (!m.local && !(await reachable(m.host))) continue;
      this.lastAutoDeploy.set(m.id, now);
      try {
        this.deployMachine({ id: m.id });
        done.push(m.id);
        this.report?.(`[machines] ${m.id} was offline for ${Math.round((now - this.offlineSince.get(m.id)!) / 60_000)} min${m.local ? '' : ' while ssh reached it'}; redeploying its daemon (as add_machine does).`);
      } catch (e) {
        this.report?.(`[machines] ${m.id} is offline and could not be redeployed: ${(e as Error).message}`);
      }
    }
    return done;
  }

  // ---------------------------------------------------------------- daemon versions

  /** What each connected daemon said in its hello. */
  private readonly hellos = new Map<string, { protocol: number; oldestPortal?: number; daemon?: string; catalog?: string[]; guard?: boolean; agentHosts?: boolean }>();

  /** Each connected daemon's GPU Whisper (w615), from its hello and its `voice` messages. */
  private readonly voices = new Map<string, RemoteVoiceStatus>();
  /**
   * Machines whose voice is taken as down (w615), skipped by voiceMachines: `silent`, its ping before a clip went
   * unanswered, until anything is heard from it; `timeout`, a clip timed out on a live link, until it re-offers its
   * Whisper or VOICE_RETRY_MS has passed.
   */
  private readonly voiceDown = new Map<string, { kind: 'silent' | 'timeout'; until: number }>();

  /** Whether a machine's voice is taken as down now (an expired timeout mark is dropped here). */
  private voiceIsDown(id: string): boolean {
    const d = this.voiceDown.get(id);
    if (!d) return false;
    if (Date.now() < d.until) return true;
    this.voiceDown.delete(id);
    return false;
  }
  private readonly transcribeCalls = new Map<string, { machine: string; resolve: (r: Extract<FromDaemon, { type: 'transcribe_result' }>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /** The online machines whose daemon offers its GPU Whisper (w615), with its state; first the ones in `order`. */
  voiceMachines(order: string[] = []): { machine: string; status: RemoteVoiceStatus }[] {
    const rank = (id: string) => {
      const i = order.findIndex((o) => o.toLowerCase() === id.toLowerCase());
      return i < 0 ? order.length : i;
    };
    return [...this.voices]
      .filter(([id]) => this.isOnline(id) && !this.outdated(id) && !this.voiceIsDown(id))
      .map(([machine, status]) => ({ machine, status }))
      .sort((a, b) => rank(a.machine) - rank(b.machine) || a.machine.localeCompare(b.machine));
  }

  /**
   * Transcribe a clip on a machine's GPU Whisper (w615): resolves with its answer, rejects on its error, after
   * `timeoutMs`, at once when its link drops, and after VOICE_PING_MS when the ping sent ahead of the clip is not
   * answered (a machine asleep or cut off whose socket is not closed yet). Neither the audio nor the text is logged.
   */
  transcribeOn(machine: string, req: { audio: string; prompt?: string; language?: string | null }, timeoutMs: number): Promise<Extract<FromDaemon, { type: 'transcribe_result' }>> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.transcribeCalls.delete(id);
        this.voiceDown.set(machine, { kind: 'timeout', until: Date.now() + VOICE_RETRY_MS.value });
        console.warn(`machine ${machine}: a clip timed out after ${(timeoutMs / 1000).toFixed(1)} s; voice goes to the portal's own Whisper for ${Math.round(VOICE_RETRY_MS.value / 60_000)} min or until it offers its Whisper again`);
        reject(new Error(`${machine} did not answer within ${(timeoutMs / 1000).toFixed(1)} s`));
      }, timeoutMs);
      this.transcribeCalls.set(id, { machine, resolve, reject, timer });
      const link = this.links.get(machine);
      const sent = Date.now();
      try {
        // The ping goes first, so its pong does not wait behind the clip's upload.
        link?.ws.ping();
        this.post(machine, { type: 'transcribe', id, ...req });
      } catch (e) {
        clearTimeout(timer);
        this.transcribeCalls.delete(id);
        reject(e as Error);
        return;
      }
      setTimeout(() => {
        const c = this.transcribeCalls.get(id);
        if (!c || !link || link.lastPong >= sent) return;
        clearTimeout(c.timer);
        this.transcribeCalls.delete(id);
        this.voiceDown.set(machine, { kind: 'silent', until: Infinity });
        console.warn(`machine ${machine}: no answer to a ping in ${(VOICE_PING_MS.value / 1000).toFixed(1)} s; voice goes to the portal's own Whisper until it is heard from`);
        c.reject(new Error(`${machine} did not answer a ping within ${(VOICE_PING_MS.value / 1000).toFixed(1)} s (its link looks dead)`));
      }, VOICE_PING_MS.value).unref();
    });
  }

  /** A recording started: have the machine load its model now (w615). */
  warmVoice(machine: string) {
    if (this.voices.has(machine)) this.post(machine, { type: 'voice_warm' }, false);
  }

  /** Whether a connected machine's daemon runs the host guard (w466): its hello said so. */
  guards(id: string): boolean {
    return this.isOnline(id) && !!this.hellos.get(id)?.guard;
  }

  /** A machine's host guard has news for people (wired by index.ts: as the portal's own guard reports). */
  hostReport?: (machineId: string, title: string, body: string) => void;
  /** The commit this portal runs (a deploy stamps the daemon with the same): another one only means an update is available. */
  portalHead: string | undefined = gitHead(ROOT);
  private readonly reportedOutdated = new Map<string, string>();

  /** Whether a connected daemon runs its agents in agent hosts that outlive it (w605): its hello said so. */
  agentHostsOf(id: string): boolean {
    return this.isOnline(id) && !!this.hellos.get(id)?.agentHosts;
  }

  /** The protocol a connected daemon said hello with, or undefined. */
  protocolOf(id: string): number | undefined {
    return this.isOnline(id) ? this.hellos.get(id)?.protocol : undefined;
  }

  /**
   * Why a connected machine's daemon cannot work with this portal, or undefined: its protocol is outside the range
   * both sides serve (protocolProblem, w605). Only this refuses new agents and resumes; a redeploy or a re-run of its
   * installer fixes it.
   */
  outdated(id: string): string | undefined {
    const h = this.hellos.get(id);
    return h && this.isOnline(id) ? protocolProblem(h) : undefined;
  }

  /**
   * A connected daemon installed from another commit than this portal's, which speaks a protocol both serve: an update
   * is available, and nothing waits for it (w605: after a portal update every daemon was refused its paused agents).
   */
  updateAvailable(id: string): string | undefined {
    const h = this.hellos.get(id);
    return h && this.isOnline(id) && !protocolProblem(h) ? daemonBehind(h, this.portalHead) : undefined;
  }

  /**
   * Redeploy connected daemons that are outdated (a protocol this portal no longer drives) as soon as no agent runs
   * there: at most every 10 minutes per machine. A daemon that only has an update available keeps working; one this
   * portal deployed over ssh is redeployed the same way once idle, and a worker root install is told about it once.
   * Called on every hello and every 30 s.
   */
  checkOutdated(now = Date.now()): string[] {
    const done: string[] = [];
    if (dryRun()) return done;
    for (const m of this.list()) {
      const why = this.outdated(m.id);
      const behind = why ? undefined : this.updateAvailable(m.id);
      const key = why ?? (behind ? `update: ${behind}` : undefined);
      if (!key) {
        this.reportedOutdated.delete(m.id);
        continue;
      }
      if (this.deploying.has(m.id)) continue;
      const once = (text: string) => {
        if (this.reportedOutdated.get(m.id) === key) return;
        this.reportedOutdated.set(m.id, key);
        this.report?.(text);
      };
      // A worker root install (w513) updates by running its installer again there: say so once, never redeploy over ssh.
      if (m.root) {
        once(
          why
            ? `[machines] ${m.id}'s daemon is outdated (${why}). It is a worker root install (${m.root}): update it there by running its installer again (docs/worker-install.md, "Updating").`
            : `[machines] ${m.id}'s daemon has an update available (${behind}). It keeps taking, starting and resuming agents meanwhile; to update it, run its installer again there (docs/worker-install.md, "Updating").`,
        );
        continue;
      }
      const live = this.liveCount(m.id);
      // Only an update: not while an agent there is mid-turn by its record or waits to be resumed (its daemon just came
      // back), nor while any process runs.
      if (!why && (this.cutOff.has(m.id) || [...this.sessions.sessions.values()].some((s) => s.info.machineId === m.id && (MID_TURN.has(s.info.status) || !!s.info.turnOpenSince)))) continue;
      if (live > 0) {
        if (why) once(`[machines] ${m.id}'s daemon is outdated (${why}); ${live} agent(s) still run there, so it is redeployed once they have stopped. New agents cannot start there until then.`);
        continue;
      }
      if (now - (this.lastAutoDeploy.get(m.id) ?? 0) < 10 * 60_000) continue;
      this.lastAutoDeploy.set(m.id, now);
      const what = why ? `is outdated (${why})` : `has an update available (${behind})`;
      try {
        this.deployMachine({ id: m.id });
        done.push(m.id);
        this.report?.(`[machines] ${m.id}'s daemon ${what}; redeploying it while no agent runs there (as add_machine does).`);
      } catch (e) {
        this.report?.(`[machines] ${m.id}'s daemon ${what} and could not be redeployed: ${(e as Error).message}`);
      }
    }
    return done;
  }

  /**
   * Wait until a machine is connected with a daemon this portal can drive (an update available is fine, w605),
   * redeploying an outdated one on the way. Resolves undefined when it is, else why not (after `timeoutMs`).
   */
  async whenCurrent(id: string, timeoutMs = 12 * 60_000, pollMs = 3000): Promise<string | undefined> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const m = this.store.machines.get(id);
      if (!m) return `no machine "${id}"`;
      const online = this.isOnline(id) && this.hellos.has(id);
      const why = this.outdated(id);
      if (online && !why && !this.deploying.has(id)) return undefined;
      if (this.outdated(id)) this.checkOutdated();
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

  /** Live agents in one place of a machine: a sandbox, or (sandbox undefined) its standing agents. */
  liveIn(id: string, sandbox: string | undefined) {
    return [...this.sessions.sessions.values()].filter((s) => s.info.machineId === id && s.info.machineSandbox === sandbox && s.live).length;
  }

  /**
   * Mid-turn agents in one place of a machine (sandbox undefined: its standing agents), or in all its sandboxes
   * (sandbox '*'): what max_agents_per_sandbox and the machine's agent cap count (w384, w536). Idle agents, their
   * process up or not, take no slot.
   */
  runningIn(id: string, sandbox: string | undefined | '*') {
    return [...this.sessions.sessions.values()].filter((s) => s.info.machineId === id && (sandbox === '*' ? !!s.info.machineSandbox : s.info.machineSandbox === sandbox) && isMidTurn(s.info)).length;
  }

  /**
   * Why an agent of this kind may never start outside a sandbox on `m`, or undefined: every worker runs in a sandbox
   * (w536, Lothsahn on 2026-10-06: "Can't we get rid of this code so the settings doesn't matter?"), since a main clone
   * is a person's own or the base its sandboxes are worktrees of. Standing agents work in their own folder and are
   * never refused here. Names its sandboxes.
   */
  mainCloneRefusal(m: Machine, kind?: SessionInfo['kind']): string | undefined {
    if (kind === 'standing') return undefined;
    const sbs = (m.sandboxes ?? []).map((s) => `${m.id}/${s.id}`);
    const use = sbs.length ? `one of its sandboxes (${sbs.join(', ')})` : poolSettingsOf(m) ? `a sandbox there (it has none yet: create_sandbox with machine "${m.id}")` : 'a sandbox, on a computer that has a sandbox root (it has none)';
    return `${m.id} runs workers in sandboxes only: start this one in ${use}`;
  }

  /**
   * A worker that released its sandbox while it waited (w640, server/placeAgain.ts): why its message waits to be placed
   * again (another sandbox being switched to its branch, none free), or undefined when it may go. Wired by Agents.
   */
  placeAgain?: (info: SessionInfo) => string | undefined;

  /** Why a message to this machine session must wait for a free running slot, or undefined (SessionManager.placeFull). */
  placeFull(s: SessionHandle): string | undefined {
    const m = this.store.machines.get(s.info.machineId ?? '');
    if (!m) return undefined;
    if (s.info.placeReleased && !s.live) {
      const why = this.placeAgain?.(s.info);
      if (why) return why;
    }
    const sbId = s.info.machineSandbox;
    if (sbId) {
      const pool = poolSettingsOf(m);
      const max = pool?.maxAgentsPerSandbox ?? 2;
      const here = this.runningIn(m.id, sbId);
      if (here >= max) return `${here} agents mid-turn in sandbox ${m.id}/${sbId} (max_agents_per_sandbox ${max})`;
    } else if (this.mainCloneRefusal(m, s.info.kind)) return undefined; // refused outright by dispatchSend: no queue for it
    return this.capFull(m);
  }

  /** Agents mid-turn on a machine, in its sandboxes and standing agents together: what its agent cap counts (w536). */
  midTurnTotal(id: string) {
    return this.runningIn(id, '*') + this.runningIn(id, undefined);
  }

  /** Why `m` is at its agent cap (agentCap), or undefined. */
  capFull(m: Machine): string | undefined {
    const all = this.midTurnTotal(m.id);
    const cap = agentCap(m);
    return all >= cap ? `${all} agents mid-turn on ${m.id}, in sandboxes and standing agents together (its agent cap ${cap})` : undefined;
  }

  /** Re-attach a persisted session on boot. */
  restore(info: SessionInfo, now = Date.now()): SessionHandle | undefined {
    if (!info.machineId || !this.store.machines.has(info.machineId)) return undefined;
    // A turn mark left by the JSON-drop bug on an agent idle for hours is stale: kept, the next restart's resume
    // file (collectResume) would resume it as mid-turn.
    if (info.turnOpenSince && now - (Date.parse(info.lastActivityAt) || 0) > RESUME_WITHIN_MS) delete info.turnOpenSince;
    return new RemoteSession(info, this);
  }

  // ---------------------------------------------------------------- records and tokens

  /**
   * Add or replace a machine's record and mint its token (returned once; only the hash is kept). The token is staged
   * beside the machine's current one, not in its place (w568): both work until the machine's daemon connects with one
   * of them (attach), so a deploy that fails before the machine has the new token leaves it its old one.
   */
  register(m: Omit<Machine, 'online' | 'sessionIds' | 'createdAt'> & Partial<Pick<Machine, 'sessionIds' | 'createdAt'>>): { machine: Machine; token: string } {
    if (!MACHINE_ID.test(m.id)) throw new Error(`machine id "${m.id}" must be lower-case letters, digits and dashes`);
    const prev = this.store.machines.get(m.id);
    const machine: Machine = { online: this.isOnline(m.id), sessionIds: prev?.sessionIds ?? [], createdAt: prev?.createdAt ?? new Date().toISOString(), ...m };
    const token = stageMachineToken(this.cfg.dataDir, m.id);
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

  /**
   * What a machine may know about itself, asked with its own token (GET /machine/whoami, w513): the worker installer
   * checks its credential with it, and the uninstaller which agents still run there before it removes anything.
   */
  selfStatus(id: string) {
    const m = this.require(id);
    const agents = [...this.sessions.sessions.values()]
      .filter((s) => s.info.machineId === id && s.live)
      .map((s) => ({ id: s.info.id, title: s.info.title, sandbox: s.info.machineSandbox, midTurn: isMidTurn(s.info) }));
    // The daemon's code and whether it is outdated (w613): worker.ts update checks the new one is what the portal sees.
    const outdated = this.outdated(id);
    return { id: m.id, online: this.isOnline(id), ...(this.hellos.get(id)?.daemon ? { daemon: this.hellos.get(id)!.daemon } : {}), ...(outdated ? { outdated } : {}), root: m.root, agents, sandboxes: (m.sandboxes ?? []).map((sb) => sb.id) };
  }

  /**
   * A machine leaving on its own (POST /machine/unenroll, w513: the worker uninstaller): its record and token go, as
   * remove_machine does, without touching the computer (the uninstaller stops its own daemon). Refused while an agent
   * there is mid-turn, unless forced; then the agents are stopped on purpose first, so nothing resumes them.
   */
  unenroll(id: string, force = false): { ok: true } | { ok: false; error: string; agents: { id: string; title: string; sandbox?: string }[] } {
    refuseInDryRun(`unenrolling ${id}`);
    const busy = this.selfStatus(id).agents.filter((a) => a.midTurn);
    if (busy.length && !force) return { ok: false, error: `${busy.length} agent(s) are mid-turn on ${id}`, agents: busy };
    for (const sid of this.require(id).sessionIds) {
      const s = this.handle(sid);
      if (s?.live) s.stop();
    }
    this.expectDrop(id, false);
    this.remove(id);
    this.report?.(`[machines] ${id} unenrolled itself (its worker install was uninstalled there); its record and token are gone.`);
    return { ok: true };
  }

  /** Forget a machine: its token stops working and its sessions are removed. */
  remove(id: string) {
    const m = this.require(id);
    for (const sid of m.sessionIds) if (this.sessions.sessions.has(sid)) this.sessions.remove(sid);
    revokeMachineToken(this.cfg.dataDir, m.id);
    this.links.get(m.id)?.ws.close(4001, 'machine removed');
    this.store.removeMachine(m.id);
    if (m.ssh) this.pinHostKeys(); // its pinned host keys go with it (w568)
  }

  private tokens(): Record<string, string> {
    return readMachineTokens(this.tokensFile);
  }

  /**
   * Drop the link of every machine whose credential was revoked or replaced from outside the portal (`fffctl
   * machine-credential revoke` or `issue`, which edit the tokens file while the portal runs), so a leaked credential
   * stops at once, not at its next reconnect. Checked with each heartbeat, so within PING_MS. Its record and sessions stay.
   */
  dropRevoked() {
    if (!this.links.size) return;
    const t = this.tokens();
    for (const [id, link] of this.links) {
      if (t[id] && (!link.hash || t[id] === link.hash)) continue;
      if (link.hash && t[stagedKey(id)] === link.hash) continue; // connected with a deploy's staged credential (w568)
      console.warn(`machine ${id}: its credential was ${t[id] ? 'replaced' : 'revoked'}, dropping the connection`);
      link.ws.close(4001, 'machine credential revoked');
      this.detach(id);
    }
  }

  /** The machine a bearer token belongs to, or undefined. Constant-time on the secret. */
  authenticate(header: string | undefined): string | undefined {
    return this.credential(header)?.id;
  }

  /**
   * The machine a bearer token belongs to, the hash it matched, and whether that is a deploy's staged credential (w568):
   * the current one and a staged one both open the portal until the machine connects with one of them.
   */
  private credential(header: string | undefined): { id: string; hash: string; staged: boolean } | undefined {
    const m = /^Bearer\s+(ffm_([a-z0-9-]+)_[A-Za-z0-9_-]{40,})$/.exec(header ?? '');
    if (!m) return undefined;
    const t = this.tokens();
    const got = createHash('sha256').update(m[1]).digest();
    const same = (want: string | undefined) => !!want && timingSafeEqual(Buffer.from(want, 'hex'), got);
    if (same(t[m[2]])) return { id: m[2], hash: t[m[2]], staged: false };
    if (same(t[stagedKey(m[2])])) return { id: m[2], hash: t[stagedKey(m[2])], staged: true };
    return undefined;
  }

  /**
   * A daemon connected: the credential it has settles a deploy's two (w568). With the staged one, that becomes its only
   * one. With the current one while a staged one waits and no deploy runs (the deploy failed, and the old daemon is the
   * one running), the staged one goes.
   */
  private settleCredential(id: string, staged: boolean) {
    if (staged) promoteStagedToken(this.cfg.dataDir, id);
    else if (!this.deploying.has(id)) dropStagedToken(this.cfg.dataDir, id);
  }

  // ---------------------------------------------------------------- deploying (server/machineDeploy.ts)

  private readonly deploying = new Set<string>();
  /** How long a deploy lets the old daemon's link close, then how often it looks for the new one (tests shorten them). */
  deployWaitMs = { settle: 3000, poll: 1000 };

  /**
   * Add a machine, or redeploy one (same id): mint a token, install the daemon over ssh and wait for
   * it to connect. Returns at once; progress shows on the record (status/statusDetail).
   */
  deployMachine(opts: { id: string; host?: string; portalUrl?: string; repoPath?: string; purpose?: string; force?: boolean; local?: boolean } & MachineDirs & SandboxLimits & PoolExtras) {
    const typed = opts.id.trim();
    const id = typed.toLowerCase();
    refuseInDryRun(`deploying ${id}`);
    if (!MACHINE_ID.test(id)) throw new Error(`machine id "${id}" must be lower-case letters, digits and dashes (e.g. "m5")`);
    if (this.deploying.has(id)) throw new Error(`${id} is already being deployed`);
    const prev = this.store.machines.get(id);
    // A worker root install (w513) is installed and updated on its computer, never over ssh: add_machine changes only
    // its settings (w576: "lower LothDesktop to 5"; a redeploy would have put an old-style daemon into its root).
    if (prev?.root) return this.setRootSettings(prev, opts);
    const local = opts.local ?? prev?.local ?? false;
    if (prev && !!prev.local !== local) throw new Error(`${id} is ${prev.local ? "the portal's own host" : 'a machine reached over ssh'}; remove it first to change that`);
    if (local) {
      const other = this.list().find((m) => m.local && m.id !== id);
      if (other) throw new Error(`${other.id} is already the portal's own host as a machine; there can be only one`);
      if (process.platform !== 'win32' && !this.allowLocalAnywhere) throw new Error("a local machine (the portal's own host) is only supported on a Windows host so far");
    }
    // The portal's own host takes its settings from this server's config where add_machine does not say otherwise.
    const defaults = local && !prev ? localMachineDefaults(this.cfg) : undefined;
    if (defaults) opts = { ...defaults, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)), id: opts.id } as typeof opts;
    const portalUrl = (opts.portalUrl ?? prev?.portalUrl ?? this.cfg.publicUrl ?? '').replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+$/.test(portalUrl)) throw new Error('portal_url is required: the address the machine reaches this portal at, e.g. https://<host>.<tailnet>.ts.net (or set publicUrl in config.json)');
    if (prev && !opts.force && this.liveCount(id) > 0) throw new Error(`${id} has agents running; a redeploy restarts its daemon and stops them. Stop them first or pass force.`);
    if (prev && this.liveCount(id) > 0) this.expectDrop(id, 'was redeployed (add_machine with force)');
    const dirs = dirOptions(opts, prev);
    const limits = limitOptions(opts, prev);
    if (prev?.sandboxRoot && dirs.sandboxRoot !== prev.sandboxRoot && prev.sandboxes?.length) {
      throw new Error(`${id} has ${prev.sandboxes.length} sandbox(es) in ${prev.sandboxRoot}; delete them before moving sandbox_root`);
    }
    const extras: PoolExtras = {
      protectedPaths: opts.protectedPaths ?? prev?.protectedPaths,
      librarySeed: opts.librarySeed === '' ? undefined : (opts.librarySeed ?? prev?.librarySeed),
      librarySeedCopy: opts.librarySeedCopy ?? prev?.librarySeedCopy,
      librarySeedGB: opts.librarySeedGB ?? prev?.librarySeedGB,
      unityBelowNormal: opts.unityBelowNormal ?? prev?.unityBelowNormal,
    };
    const { machine, token } = this.register({
      id,
      ...(local ? { local: true } : {}),
      ...extras,
      host: opts.host?.trim() || prev?.host || id,
      purpose: opts.purpose ?? prev?.purpose ?? 'unused',
      status: 'deploying',
      statusDetail: 'starting',
      repoPath: opts.repoPath ?? prev?.repoPath ?? '',
      home: prev?.home ?? '',
      portalUrl,
      info: prev?.info,
      git: prev?.git,
      lastSeen: prev?.lastSeen,
      platform: prev?.platform,
      name: typed !== id ? typed : prev?.name,
      sandboxes: prev?.sandboxes,
      // Kept from when it was the portal's own host (convert_machine, w466): what its ssh redeploys write.
      ...(!local && prev?.daemonExtras ? { daemonExtras: prev.daemonExtras } : {}),
      ...dirs,
      ...limits,
    });
    // The portal's own host keeps its main clone (the base clone): a redeploy's probe would pick the shortest clone it
    // finds, which on BEAST could be the live game's checkout.
    void this.runDeploy(machine, token, opts.repoPath ?? (local ? machine.repoPath : undefined), prev?.appDir);
    return machine;
  }

  /**
   * add_machine for a worker root install: its limits, label, protected paths and Library seed change on the record and
   * reach its daemon in a new welcome (it applies them at once, machine/daemon.ts). Its folders, host, portal and
   * sandbox count come from its installer (the count also sets its player-folder pairs and their firewall rules, w576),
   * so changing one is refused.
   */
  private setRootSettings(m: Machine, opts: Parameters<MachineManager['deployMachine']>[0]): Machine {
    if (opts.maxSandboxes !== undefined && opts.maxSandboxes !== m.maxSandboxes) {
      throw new Error(`${m.id} is a worker root install (${m.root}): its sandbox count comes from its installer, which also makes the matching player folders (slotK-0, slotK-1) and their firewall rules. Run it again there with --max-sandboxes ${opts.maxSandboxes} (docs/worker-install.md, "Updating"); its next hello brings the count here`);
    }
    const fixed = (['host', 'portalUrl', 'repoPath', 'appDir', 'unityEditorRoot', 'unityPath', 'tempDir', 'sandboxRoot', 'local'] as const).filter(
      (k) => opts[k] !== undefined && opts[k] !== (m as unknown as Record<string, unknown>)[k],
    );
    if (fixed.length) throw new Error(`${m.id} is a worker root install (${m.root}): its ${fixed.join(', ')} come from its installer; run it again there with the new value (docs/worker-install.md, "Updating")`);
    const limits = limitOptions(opts, m);
    Object.assign(m, limits, {
      ...(opts.purpose !== undefined ? { purpose: normalizePurpose(opts.purpose) } : {}),
      ...(opts.protectedPaths !== undefined ? { protectedPaths: opts.protectedPaths } : {}),
      ...(opts.librarySeed !== undefined ? { librarySeed: opts.librarySeed === '' ? undefined : opts.librarySeed } : {}),
      ...(opts.librarySeedCopy !== undefined ? { librarySeedCopy: opts.librarySeedCopy } : {}),
      ...(opts.librarySeedGB !== undefined ? { librarySeedGB: opts.librarySeedGB } : {}),
      ...(opts.unityBelowNormal !== undefined ? { unityBelowNormal: opts.unityBelowNormal } : {}),
    });
    this.store.putMachine(m);
    this.links.get(m.id)?.ws.send(JSON.stringify(this.welcomeOf(m) satisfies ToDaemon));
    return m;
  }

  /** Tests only: allow a local machine on a host that is not Windows (the deploy itself is a fake there). */
  allowLocalAnywhere = false;

  /** The portal's own host as a machine (docs/beast-machine.md), if one is set up. */
  local(): Machine | undefined {
    return this.list().find((m) => m.local);
  }

  /**
   * Turn the portal's own host as a machine into one reached over ssh, or back (convert_machine, w466): the record only
   * (convertMachineRecord). Its daemon stays connected as it is, its agents run on, its token and sandboxes stay; it is
   * how BEAST stays the same machine when the portal moves to the VM, and comes back when it returns. A redeploy (asked
   * for, refused while agents run there) writes the new way into its daemon.json, with a new token.
   */
  convertMachine(id: string, to: 'ssh' | 'local', o: { sshHost?: string; portalUrl?: string; redeploy?: boolean } = {}): string {
    const m = this.require(id);
    if (o.redeploy) refuseInDryRun(`redeploying ${m.id}`);
    if (this.deploying.has(m.id)) throw new Error(`${m.id} is being deployed right now`);
    // Checked before anything changes: a redeploy restarts its daemon, which stops its agents.
    if (o.redeploy && this.liveCount(m.id) > 0) throw new Error(`${m.id} has ${this.liveCount(m.id)} agent(s) running; a redeploy would stop them. Convert without redeploy (its daemon stays connected), or stop them first`);
    if (to === 'local') {
      const other = this.list().find((x) => x.local && x.id !== m.id);
      if (other) throw new Error(`${other.id} is already the portal's own host as a machine; there can be only one`);
      if (process.platform !== 'win32' && !this.allowLocalAnywhere) throw new Error("a local machine (the portal's own host) is only supported on a Windows host so far");
      // The portal's own computer must hold the machine's clone: a machine that is another computer cannot become it.
      if (!m.repoPath || !fs.existsSync(m.repoPath)) throw new Error(`${m.repoPath || 'its main clone'} is not on this computer: ${m.id} cannot be the portal's own host here`);
    }
    const next = convertMachineRecord(m, to, { ...o, port: this.cfg.port, publicUrl: this.cfg.publicUrl, extras: to === 'ssh' ? this.localExtras() : undefined });
    this.store.putMachine(next);
    const kept = `${(next.sandboxes ?? []).length} sandbox(es), ${next.sessionIds.length} agent record(s), its token and limits kept`;
    const how = to === 'ssh' ? `reached over ssh as "${next.host}", portal_url ${next.portalUrl}` : `the portal's own host again (no ssh), portal_url ${next.portalUrl}`;
    const link = this.isOnline(next.id) ? 'Its daemon stays connected as it is, its agents running on' : 'Its daemon is offline now; it dials the URL in its daemon.json (relocate_machines changes that for a connected one)';
    let text = `${next.id} is ${how}; ${kept}. ${link}.`;
    if (o.redeploy) {
      this.deployMachine({ id: next.id });
      text += ` Redeploying it ${to === 'ssh' ? `over ssh to ${next.host}` : 'here, without ssh'}; list_machines shows progress.`;
    } else text += ` Its daemon.json still has the way it was deployed: a redeploy (add_machine, or convert_machine with redeploy) writes this one.`;
    return text;
  }

  /** The install over ssh (server/machineDeploy.ts); replaced by tests. */
  deployer: (opts: DeployOptions) => Promise<DeployResult> = async (opts) => (await import('./machineDeploy.ts')).deploy(opts);

  /**
   * Whether the daemon a deploy installed has connected: a link opened since its install step began, or one whose
   * hello names the version installed. Not "since the install returned": the new daemon often connects before the
   * ssh session that started it has closed, and was then never counted (m5, 2026-09-29: "installed, but the daemon
   * has not connected" while it was connected).
   */
  private deployedDaemonConnected(id: string, installAt: number, version: string) {
    const link = this.links.get(id);
    const hello = this.hellos.get(id);
    if (!link) return false;
    return link.since >= installAt || (!!hello && version !== 'unknown' && hello.daemon === version);
  }

  private async runDeploy(m: Machine, token: string, repoPath: string | undefined, previousAppDir: string | undefined) {
    this.deploying.add(m.id);
    // Whether the machine may have the new token: only the install step writes it there (daemon.json, w568).
    let reachedInstall = false;
    const { repoSlug } = await import('./machineDeploy.ts');
    const { ROOT } = await import('./config.ts');
    try {
      const dirs = { appDir: m.appDir, unityEditorRoot: m.unityEditorRoot, unityPath: m.unityPath, tempDir: m.tempDir, sandboxRoot: m.sandboxRoot };
      // The old daemon goes, and the new one starts, during the install step.
      let installAt = Date.now();
      const step = (s: string) => {
        if (s === 'installing') {
          installAt = Date.now();
          reachedInstall = true;
        }
        this.update(m.id, { statusDetail: s });
      };
      const r = await this.deployer({ host: m.host, id: m.id, portalUrl: m.portalUrl, token, root: ROOT, repoPath, repoSlug: repoSlug(this.cfg.repo.url), dirs, sandboxes: poolSettingsOf(m), previousAppDir, step, onPlatform: (platform) => this.update(m.id, { platform }), ...(m.local ? { local: true, extra: this.localExtras() } : m.daemonExtras ? { extra: m.daemonExtras } : {}) });
      const connected = () => this.deployedDaemonConnected(m.id, installAt, r.version);
      this.update(m.id, { repoPath: r.repoPath, home: r.home, platform: r.platform, statusDetail: `waiting for the daemon (${r.version}, node ${r.nodeVersion}) to connect` });
      if (r.started === false && !connected()) {
        // Windows: the task runs only in the user's logged-on session (docs/machines.md). The hello clears this.
        this.update(m.id, { status: 'error', statusDetail: `installed, but nobody is logged on to ${m.host}: the daemon starts when its user logs on to the desktop` });
        return;
      }
      // The old daemon's connection (if any) closes when launchd stops it; wait for the new one.
      await new Promise((res) => setTimeout(res, this.deployWaitMs.settle));
      for (let i = 0; i < 90 && !connected(); i++) await new Promise((res) => setTimeout(res, this.deployWaitMs.poll));
      this.update(
        m.id,
        connected()
          ? { status: 'ready', statusDetail: undefined }
          : { status: 'error', statusDetail: `installed, but the daemon has not connected to ${m.portalUrl}; see ${daemonLogPath(r.platform, m.appDir)} on ${m.host}` },
      );
    } catch (e) {
      // Failed before the install step: the machine never got the new token, so it keeps the one it has (w568). Failed
      // during it: it may have either, and both stay good until its daemon connects with one (settleCredential).
      if (!reachedInstall) dropStagedToken(this.cfg.dataDir, m.id);
      // A daemon still connected (the old one kept running, or it came back) works: not an error alongside a live
      // link, but the failed redeploy stays in view.
      const live = this.isOnline(m.id) && this.hellos.has(m.id);
      this.update(m.id, live ? { status: 'ready', statusDetail: `the last redeploy failed, so the previous daemon is still the one running: ${(e as Error).message}` } : { status: 'error', statusDetail: (e as Error).message });
    } finally {
      this.deploying.delete(m.id);
      this.dropWhy.delete(m.id); // the old daemon's link has dropped by now, or the deploy never got that far
    }
  }

  /**
   * daemon.json extras for the portal's own host: the MCP-for-Unity server its workers had (config unity.mcpServer), no
   * Max events file of its own (its agents write this server's, which it reads already: the spec names it), and the
   * host's idle-editor stop (config unity.idleStopMinutes).
   */
  private localExtras(): DaemonExtras {
    return localDaemonExtras(this.cfg);
  }

  /** Stop and unload the daemon on the machine (best effort), then forget the machine here. */
  async removeMachine(id: string) {
    const m = this.require(id);
    refuseInDryRun(`removing ${m.id} (its daemon would be unloaded over ssh)`);
    if (m.local && m.sandboxes?.length) throw new Error(`${m.id} still holds ${m.sandboxes.length} sandbox(es): delete them first, or convert it to an ssh machine with convert_machine`);
    const { undeploy } = await import('./machineDeploy.ts');
    let note = '';
    try {
      await undeploy(m.host, m.platform, m.appDir, !!m.local);
    } catch (e) {
      note = ` (could not unload the daemon: ${(e as Error).message})`;
    }
    this.remove(m.id);
    return `Removed ${m.id}${note}. Its files stay in ${m.appDir ?? 'the .ff-factory folder in its home'} on the machine.`;
  }

  /**
   * The machine's own word that its daemon stops on purpose now (POST /machine/stopping, a worker migration, w513): as
   * after machine_daemon stop, the offline redeploy leaves it alone until a daemon says hello (which clears it).
   */
  stoppingOnPurpose(id: string): { ok: true } {
    this.update(id, { daemonStopped: true });
    return { ok: true };
  }

  /**
   * Start, stop or restart a machine's daemon over ssh. Stopping or restarting ends its agents, so it is refused
   * while any run unless forced (as a redeploy is). A stopped daemon is left alone by the offline redeploy until
   * it is started (or redeployed) again.
   */
  async controlDaemon(id: string, action: 'start' | 'stop' | 'restart', force = false): Promise<string> {
    const m = this.require(id);
    refuseInDryRun(`a daemon ${action} on ${m.id}`);
    if (this.deploying.has(m.id)) throw new Error(`${m.id} is being deployed right now`);
    const live = this.liveCount(m.id);
    // A daemon whose agents run in agent hosts (w605) restarts without stopping them; a stop still ends them.
    const keeps = action === 'restart' && this.agentHostsOf(m.id);
    if (action !== 'start' && live > 0 && !force && !keeps) throw new Error(`${m.id} has ${live} agent(s) running; a daemon ${action} stops them. Stop them first or pass force.`);
    // A stop is on purpose: its agents stay stopped. A restart resumes the ones it cut off mid-turn.
    if (action !== 'start') this.expectDrop(m.id, action === 'stop' ? false : 'was restarted (machine_daemon restart)');
    const { controlDaemon } = await import('./machineDeploy.ts');
    const done = await controlDaemon(m.host, m.platform, action, m.appDir, !!m.local);
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
  dispatchSend(s: RemoteSession, text: string, from: 'human' | 'orchestrator' | 'system', uuid: string, images: ImageInput[] = [], requestedBy?: Requester, attachments: DeliveredAttachment[] = []) {
    const m = this.require(s.info.machineId!);
    if (!this.isOnline(m.id)) throw new Error(`machine ${m.id} is offline (asleep, or its daemon is not running)`);
    // Files come with it (docs/attachments.md): only a daemon that fetches them gets them, never one that would drop them.
    const proto = this.hellos.get(m.id)?.protocol ?? 0;
    if (attachments.length && proto < ATTACHMENT_PROTOCOL) {
      this.checkOutdated();
      throw new Error(`${m.id}'s daemon speaks protocol ${proto} and cannot fetch attachments; it is redeployed once no agent runs there. Try again in a few minutes.`);
    }
    const sbId = s.info.machineSandbox;
    if (sbId && !s.live) {
      const sb = this.requireSandbox(m.id, sbId);
      this.requireSandboxDaemon(m.id);
      if (sb.status !== 'ready') throw new Error(`sandbox ${m.id}/${sb.id} is ${sb.status}${sb.statusDetail ? ` (${sb.statusDetail})` : ''}`);
      // The agent limits count mid-turn agents only and are waited for, not refused: SessionManager queues a message
      // until placeFull says a slot is free (w384).
    } else if (!s.live && !sbId) {
      // A worker outside a sandbox is refused (w536); a standing agent waits for the agent cap (placeFull).
      const why = this.mainCloneRefusal(m, s.info.kind);
      if (why) throw new Error(why);
    }
    if (!this.hooks) throw new Error('machines are not wired up');
    // A new agent process is built from the spec by the daemon's own code: a daemon whose protocol this portal no
    // longer drives may not understand it. One from another commit in range does (w605). A live process only gets the
    // text, so it carries on.
    const why = s.live ? undefined : this.outdated(m.id);
    if (why) {
      this.checkOutdated();
      const busy = this.liveCount(m.id);
      throw new Error(`${m.id}'s daemon is outdated (${why}): ${this.deploying.has(m.id) ? 'it is being redeployed now' : busy ? `it is redeployed once its ${busy} running agent(s) stop` : 'redeploying it now'}. Try again in a few minutes.`);
    }
    // Redeployed while idle (an update was available): its daemon is about to stop, so a new process waits for the new one.
    if (!s.live && this.deploying.has(m.id)) throw new Error(`${m.id}'s daemon is being redeployed now. Try again in a few minutes.`);
    const spec = this.hooks.specFor(s.info, m);
    const catalog = this.hellos.get(m.id)?.catalog;
    if (spec.mcp && catalog) spec.mcp = { ...spec.mcp, tools: spec.mcp.tools.filter((t) => catalog.includes(t.name)) };
    // Stored here first, so the daemon's transcript event can name them without sending them back.
    const withIds = images.map((i) => ({ ...i, id: i.id ?? this.store.saveImage(s.info.id, i.mediaType, i.data) }));
    // The daemon fetches each file into the place's Inbox (GET /machine/attachments/<id>), which this lets it do.
    if (attachments.length) this.attachments?.grant(m.id, attachments.map((a) => a.id));
    const files = attachments.map(({ path: _p, error: _e, ...ref }) => ref);
    // Placed again in another sandbox while it was stopped (w640): its first message there says where it is now.
    const moved = !s.live && s.info.movedFrom && sbId ? this.requireSandbox(m.id, sbId) : undefined;
    const said = moved ? `${movedNote(m, s.info.movedFrom!, moved)}\n\n${text}` : text;
    this.post(m.id, { type: 'send', info: s.info, lastSeq: this.store.lastSeq(s.info.id), spec, text: said, from, uuid, images: withIds, ...(requestedBy ? { requestedBy } : {}), ...(files.length ? { attachments: files } : {}) });
    if (moved) {
      delete s.info.movedFrom;
      this.touch(s);
    }
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
    // A dry run (server/dryRun.ts) links no daemon: a daemon that found it (relocated by mistake) keeps dialling and falls
    // back to its own portal (RELOCATE_FALLBACK_MINUTES).
    if (dryRun()) {
      console.warn(`machine: refused a daemon link from ${ip}: ${DRY_RUN_WHY}`);
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return false;
    }
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    const cred = this.credential(req.headers.authorization);
    const id = cred && this.store.machines.has(cred.id) ? cred.id : undefined;
    if (!id) {
      const locked = recent.length >= 10;
      if (!locked) recent.push(now);
      if (recent.length) this.failures.set(ip, recent);
      else this.failures.delete(ip);
      console.warn(`machine: refused a connection from ${ip}${locked ? ' (too many failures)' : ''}`);
      // CRLF as HTTP has it: a bare LF made the daemon's client fail to parse the refusal and log a parse error, not the 401.
      socket.write(`HTTP/1.1 ${locked ? '429 Too Many Requests' : '401 Unauthorized'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return false;
    }
    this.failures.delete(ip);
    const { hash, staged } = cred!;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.attach(id, ws, hash);
      // The token file is written (synchronously, fsynced) after this turn, so the daemon's 101 goes out first; the
      // link keeps the hash it presented, which dropRevoked accepts while it is the staged one (w568).
      setImmediate(() => this.settleCredential(id, staged));
    });
    return true;
  }

  /** The welcome a daemon gets on connecting, and again when its hello moved its pool (w513). */
  private welcomeOf(m: Machine, sessions = m.sessionIds.filter((sid) => this.store.sessions.has(sid)).map((sid) => ({ id: sid, lastSeq: this.store.lastSeq(sid) }))) {
    // A worker root install (w513) whose record has no pool of its own yet keeps daemon.json's until its hello says it.
    const pool = m.sandboxRoot || !m.root ? poolSettingsOf(m) : undefined;
    return { type: 'welcome' as const, machineId: m.id, maxSessions: agentCap(m), sessions, sandboxes: pool };
  }

  /** Wire a connected daemon (exported for tests: any WebSocket works). */
  attach(id: string, ws: WebSocket, hash?: string) {
    const old = this.links.get(id);
    if (old) old.ws.close(4000, 'replaced by a newer connection');
    const link: { ws: WebSocket; lastPong: number; since: number; hash?: string } = { ws, lastPong: Date.now(), since: Date.now(), ...(hash ? { hash } : {}) };
    this.links.set(id, link);
    ws.on('pong', () => {
      link.lastPong = Date.now();
      if (this.links.get(id) === link && this.voiceDown.get(id)?.kind === 'silent') this.voiceDown.delete(id);
    });
    ws.on('message', (data) => {
      link.lastPong = Date.now();
      if (this.links.get(id) === link && this.voiceDown.get(id)?.kind === 'silent') this.voiceDown.delete(id);
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
    ws.send(JSON.stringify(this.welcomeOf(m, sessions) satisfies ToDaemon));
    const watch = this.outsideWatchFor?.(id);
    if (watch !== undefined) ws.send(JSON.stringify({ type: 'outside_watch', config: watch } satisfies ToDaemon));
    const cleanup = this.cleanupFor?.(id);
    if (cleanup) ws.send(JSON.stringify({ type: 'cleanup_config', config: cleanup } satisfies ToDaemon));
    const ctx = m.local ? undefined : this.cleanupContext?.();
    if (ctx) ws.send(JSON.stringify({ type: 'cleanup_context', context: ctx } satisfies ToDaemon));
    ws.send(JSON.stringify({ type: 'usage_config', config: { everyMinutes: this.cfg.usagePollMinutes ?? DEFAULT_USAGE_POLL_MINUTES } } satisfies ToDaemon));
    console.log(`machine ${id} connected`);
  }

  private detach(id: string) {
    this.links.delete(id);
    this.hellos.delete(id);
    this.voices.delete(id);
    this.voiceDown.delete(id);
    for (const [cid, c] of this.transcribeCalls) {
      if (c.machine !== id) continue;
      clearTimeout(c.timer);
      this.transcribeCalls.delete(cid);
      c.reject(new Error(`${id} went offline`));
    }
    if (this.stats.delete(id)) emit({ type: 'machine_stats', id, stats: null });
    const m = this.store.machines.get(id);
    if (m) {
      Object.assign(m, { online: false, lastSeen: new Date().toISOString() });
      this.store.putMachine(m);
    }
    // Workers mid-turn now: resumed when the daemon is back without them (resumeCutOff). Standing runs have their own schedule.
    const why = this.dropWhy.get(id) ?? 'lost its connection to the portal';
    this.dropWhy.delete(id);
    const midTurn = [...this.sessions.sessions.values()]
      .filter((s) => s.info.machineId === id && s instanceof RemoteSession && cutOffMidTurn(s.info, s.seenLive, Date.now()))
      .map((s) => s.info.id);
    if (why === false) this.cutOff.delete(id);
    else if (midTurn.length) {
      const had = this.cutOff.get(id);
      this.cutOff.set(id, { at: had?.at ?? Date.now(), why: had?.why ?? why, sessions: [...new Set([...(had?.sessions ?? []), ...midTurn])] });
    }
    // Its processes may well still be running, but nothing reaches them: show them stopped until it is back.
    for (const s of this.sessions.sessions.values()) {
      if (s.info.machineId !== id || !(s instanceof RemoteSession)) continue;
      const was = s.liveFlag;
      s.liveFlag = false;
      s.seenLive = false;
      // Its process ended because its daemon went away (an update, a restart, a crash), not on purpose (w613): its sandbox
      // stays its, so new work does not take it, until it is messaged, stopped on purpose, or HOLD_PLACE_MS passes.
      if (was && why !== false && !s.info.stoppedOnPurpose && s.info.machineSandbox) s.info.heldSince = new Date().toISOString();
      if (s.info.status !== 'stopped' && s.info.status !== 'error') {
        Object.assign(s.info, { status: 'stopped', statusDetail: `machine ${id} went offline`, pendingPermissions: [] });
        this.store.putSession(s.info);
      }
      // Noted above if it was mid-turn; the mark must not outlive this drop, or every later drop resumes it again.
      if (s.info.turnOpenSince) {
        delete s.info.turnOpenSince;
        this.store.putSession(s.info);
      }
      if (was) this.sessions.events.emit('ended', s);
    }
    console.log(`machine ${id} disconnected`);
  }

  private heartbeat() {
    this.dropRevoked();
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
        this.hellos.set(id, { protocol: msg.protocol, ...(msg.oldestPortal !== undefined ? { oldestPortal: msg.oldestPortal } : {}), daemon: msg.info?.daemon, catalog: msg.catalog, ...(msg.guard ? { guard: true } : {}), ...(msg.agentHosts ? { agentHosts: true } : {}) });
        if (!msg.guard) delete m.guard;
        if (msg.voice && typeof msg.voice === 'object') this.voices.set(id, msg.voice);
        else this.voices.delete(id);
        this.voiceDown.delete(id);
        // Its daemon runs and reached us: an install or connection error from before is over (a deploy in progress
        // settles the status itself). A 'deploying' left by a portal restart mid-deploy is over too.
        if (m.status === 'error' || (m.status === 'deploying' && !this.deploying.has(id))) Object.assign(m, { status: 'ready', statusDetail: undefined });
        // Outdated (a protocol out of range) blocks; another commit only offers an update (w605).
        const why = protocolProblem(this.hellos.get(id)!);
        const behind = why ? undefined : daemonBehind(this.hellos.get(id)!, this.portalHead);
        if (why) Object.assign(m, { statusDetail: `daemon outdated: ${why}` });
        else if (behind) Object.assign(m, { statusDetail: `update available: ${behind}` });
        else if (/^(daemon (speaks|outdated)|update available)/.test(m.statusDetail ?? '')) m.statusDetail = undefined;
        Object.assign(m, { info: msg.info, home: msg.home || m.home, platform: msg.info?.platform ?? m.platform, daemonStopped: undefined, relocatedTo: undefined });
        // A worker root install (w513): its folders; a pool folder that changed goes back to it at once.
        const repool = msg.layout ? adoptLayout(m, msg.layout) : leaveRoot(m);
        this.store.putMachine(m);
        if (repool) this.links.get(id)?.ws.send(JSON.stringify(this.welcomeOf(m) satisfies ToDaemon));
        const live = new Set(msg.live);
        for (const sid of m.sessionIds) {
          const s = this.handle(sid);
          if (!s) continue;
          s.liveFlag = live.has(sid);
          if (s.liveFlag) s.seenLive = true;
          // Taken back alive (w605's agent hosts): the hold on its sandbox (w613) is over.
          if (s.liveFlag && s.info.heldSince) {
            delete s.info.heldSince;
            this.store.putSession(s.info);
          }
        }
        if (why || behind) this.checkOutdated();
        // After the daemon's own session reports (sent right after its hello), so a resume starts from its state.
        // Only for this connection: if it drops first, the next hello tries again.
        const link = this.links.get(id);
        setTimeout(() => this.links.get(id) === link && this.resumeCutOff(id, live), RESUME_DELAY_MS.value).unref();
        return;
      }
      case 'session': {
        const s = this.handle(msg.info.id);
        if (!s || s.info.machineId !== id) return;
        // The portal owns identity, naming and where it works (a worker placed again in another sandbox, w640: the
        // daemon's copy keeps the sandbox it first ran in); the daemon owns run state.
        const { id: _i, kind: _k, machineId: _m, standingId: _s, sandboxId: _b, title: _t, createdAt: _c, label: _l, labelAt: _la, activeTool: _at, stoppedOnPurpose: _sp, machineSandbox: _ms, placeReleased: _pr, movedFrom: _mf, ...run } = msg.info;
        // The portal sees the daemon's events as they come (Store.noteActivity): never step activity back.
        if (run.lastActivityAt && s.info.lastActivityAt && run.lastActivityAt < s.info.lastActivityAt) run.lastActivityAt = s.info.lastActivityAt;
        // "The login of the computer it runs on", there: this Mac's login, not this host's. On the portal's own host
        // it is this host's login, which the usage tracker already polls.
        if (run.account === HOST_LOGIN && !m.local) run.account = machineLogin(id);
        Object.assign(s.info, run);
        // JSON drops a field the daemon cleared: take the absence as cleared, or a finished turn stays marked mid-turn.
        for (const k of CLEARABLE) if (!(k in run)) delete s.info[k];
        s.liveFlag = msg.live;
        if (msg.live) s.seenLive = true;
        if (msg.live) delete s.info.heldSince;
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
        // A refused start is not the agent doing something: its activity time stays (a refused resume made agents
        // finished for hours look active, 2026-09-29).
        const at = s.info.lastActivityAt;
        this.store.append(s.info.id, { kind: 'error', text: `On ${id}: ${msg.error}` });
        Object.assign(s.info, { status: 'error', statusDetail: msg.error, lastActivityAt: at });
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
        m.sandboxes = mergeSandboxes(m.sandboxes, msg.list);
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
      case 'relocate_result': {
        const p = this.relocateCalls.get(msg.id);
        if (!p) return;
        this.relocateCalls.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve();
        else p.reject(new Error(msg.error ?? 'refused'));
        return;
      }
      case 'voice':
        if (msg.status && typeof msg.status === 'object') this.voices.set(id, msg.status);
        // It re-offers its Whisper (a status change: loaded again, say): a timed-out mark is over.
        this.voiceDown.delete(id);
        return;
      case 'transcribe_result': {
        const c = this.transcribeCalls.get(msg.id);
        if (!c || c.machine !== id) return;
        this.transcribeCalls.delete(msg.id);
        clearTimeout(c.timer);
        if (msg.ok) c.resolve(msg);
        else c.reject(new Error(msg.error ?? 'failed'));
        return;
      }
      case 'host_report':
        this.hostReport?.(id, String(msg.title ?? ''), String(msg.body ?? ''));
        return;
      case 'host_health':
        if (msg.health && typeof msg.health === 'object') this.update(id, { guard: msg.health });
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
        const stats: MachineStats = { ...msg.stats, ...(msg.unity ? { unity: msg.unity } : {}), at: new Date().toISOString() };
        this.stats.set(id, stats);
        emit({ type: 'machine_stats', id, stats });
        return;
      }
      case 'usage':
        // The portal's own host: its login is this host's, polled here already (UsageTracker).
        if (!m.local) this.onUsage?.(id, msg.account, msg.usage);
        return;
      case 'cleanup':
        m.lastCleanup = msg.summary;
        this.store.putMachine(m);
        if (msg.notice) this.cleanupNotice?.(id, msg.notice);
        return;
      case 'cleanup_log':
        if (msg.entry && typeof msg.entry === 'object') this.cleanupLog?.(id, msg.entry);
        return;
      case 'cleanup_result': {
        const call = this.cleanupCalls.get(msg.id);
        if (!call) return;
        clearTimeout(call.timer);
        this.cleanupCalls.delete(msg.id);
        if (msg.ok && msg.summary) call.resolve(msg.summary);
        else call.reject(new Error(msg.error ?? `${id}: the clean-up pass failed`));
        return;
      }
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

  private fsCall(machineId: string, msg: { op: 'read'; path: string; sessionId?: string } | { op: 'list'; dirs?: string[] }) {
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
  async createSandbox(machineId: string, req: { name: string; branch?: string; base?: string; seedLibrary?: boolean; startUnity?: boolean }): Promise<string> {
    const m = this.requireSandboxDaemon(machineId);
    const pool = poolSettingsOf(m);
    if (!pool) throw new Error(`${m.id} has no sandboxes: redeploy it with add_machine sandbox_root (e.g. "D:\\work\\ffsb")`);
    const asked = slugify(req.name);
    if (!SANDBOX_ID.test(asked)) throw new Error(`"${req.name}" does not make a usable sandbox name`);
    if ((m.sandboxes ?? []).length >= pool.maxSandboxes) throw new Error(`already ${m.sandboxes!.length} sandboxes on ${m.id} (max_sandboxes ${pool.maxSandboxes}); delete one first`);
    // A worker root install (w513, lothsahn 2026-10-06) names its sandboxes slot1..slotN, N its sandbox limit: the first
    // free one. The name asked for still names the branch, so a slot used again never inherits an old sandbox's branch.
    const id = m.root ? slotName((m.sandboxes ?? []).map((s) => s.id), pool.maxSandboxes) : asked;
    if (!id) throw new Error(`no free slot on ${m.id} (max_sandboxes ${pool.maxSandboxes}); delete one first`);
    if ((m.sandboxes ?? []).some((s) => s.id === id)) throw new Error(`sandbox "${id}" already exists on ${m.id}`);
    const branch = req.branch?.trim() || `sandbox/${asked}`;
    const problem = branchProblem(branch);
    if (problem) throw new Error(problem);
    const base = req.base?.trim() || this.cfg.defaultBase;
    return await this.sandboxCall(m.id, { op: 'create', sandbox: id, branch, base, seedLibrary: req.seedLibrary ?? true, startUnity: req.startUnity ?? false }, 2 * 60_000);
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

  sandboxLog(machineId: string, sandbox: string, lines: number): Promise<string> {
    this.requireSandboxDaemon(machineId);
    return this.sandboxCall(machineId, { op: 'log', sandbox: this.requireSandbox(machineId, sandbox).id, lines }, 60_000);
  }
  /** A line from the Mac's Max events file (server/max.ts validates it). */
  maxEvent?: (machineId: string, line: string) => void;

  /** Status, start, stop or restart the Unity editor of a machine's sandbox, on the machine (machine/unity.ts). */
  unity(machineId: string, action: 'status' | 'start' | 'stop' | 'restart', force?: boolean, sandbox?: string) {
    const m = this.require(machineId);
    if (!sandbox) throw new Error(MAIN_CLONE_NO_AGENTS);
    if (!this.isOnline(m.id)) throw new Error(`machine ${m.id} is offline`);
    // Never a sandbox field to a daemon that would ignore it and act on the main clone.
    const sb = (this.requireSandboxDaemon(m.id), this.requireSandbox(m.id, sandbox).id);
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.unityCalls.delete(id);
        reject(new Error(`machine ${m.id} did not answer the unity ${action} in 3 minutes (an old daemon? redeploy it with add_machine)`));
      }, 3 * 60_000);
      this.unityCalls.set(id, { resolve, reject, timer });
      try {
        this.post(m.id, { type: 'unity', id, action, force, sandbox: sb });
      } catch (e) {
        clearTimeout(timer);
        this.unityCalls.delete(id);
        reject(e as Error);
      }
    });
  }

  private readonly relocateCalls = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /**
   * Send a connected daemon to the portal at `url` (w466, docs/machines.md "Moving the portal"): it keeps the URL in its
   * daemon.json, drops this link and dials the new one, its agents running on (with machines.keepAgentsOnRestart their
   * runs are not this portal's to stop). The drop is on purpose: nothing is resumed here, and the offline watch leaves
   * it alone until it says hello here again (`relocatedTo`). Its record's portal_url stays this portal's address.
   */
  /**
   * relocate() each machine of `ids` (default: every connected one), one after the other; a failure is that machine's
   * outcome, not an error (relocate_machines, and a restart request's relocate at the cut-over, w499).
   */
  async relocateAll(rawUrl: string, ids?: string[]): Promise<{ machine: string; ok: boolean; note: string }[]> {
    const which = ids?.length ? ids.map((x) => x.trim().toLowerCase()) : this.list().filter((m) => this.isOnline(m.id)).map((m) => m.id);
    const out: { machine: string; ok: boolean; note: string }[] = [];
    for (const id of which) {
      try {
        out.push({ machine: id, ok: true, note: await this.relocate(id, rawUrl) });
      } catch (e) {
        out.push({ machine: id, ok: false, note: (e as Error).message });
      }
    }
    return out;
  }

  async relocate(machineId: string, rawUrl: string, timeoutMs = 20_000): Promise<string> {
    const m = this.require(machineId);
    refuseInDryRun(`relocating ${m.id}`);
    const url = rawUrl.trim().replace(/\/+$/, '');
    const bad = relocateProblem(url);
    if (bad) throw new Error(bad);
    if (!this.isOnline(m.id)) throw new Error(`${m.id} is offline: only a connected daemon can be relocated (or redeploy it with portal_url ${url})`);
    const p = this.protocolOf(m.id) ?? 0;
    if (p < RELOCATE_PROTOCOL) throw new Error(`${m.id}'s daemon speaks protocol ${p} and cannot relocate (needs ${RELOCATE_PROTOCOL}): let it be redeployed first`);
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.relocateCalls.delete(id);
        reject(new Error(`${m.id} did not answer the relocate within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.relocateCalls.set(id, { resolve, reject, timer });
      try {
        this.post(m.id, { type: 'relocate', id, url });
      } catch (e) {
        clearTimeout(timer);
        this.relocateCalls.delete(id);
        reject(e as Error);
      }
    });
    // Its link drops in a moment, on purpose: no resume of what it runs, no redeploy while it is away.
    this.expectDrop(m.id, false);
    this.update(m.id, { relocatedTo: { url, at: new Date().toISOString() } });
    return `${m.id} took ${url} and is dialling it now; its agents run on. It falls back to this portal's URL too if ${url} has not answered after ${RELOCATE_FALLBACK_MINUTES} minutes.`;
  }

  private readonly switchCalls = new Map<string, { resolve: (r: { from: string; to: string; notes: string[] }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /** Switch the branch of a machine sandbox, on the machine (server/switchBranch.ts). callerSessionId: the agent asking, which its daemon does not count as busy. */
  switchBranch(machineId: string, branch: string, createFrom?: string, sandbox?: string, callerSessionId?: string) {
    if (!sandbox) return Promise.reject(new Error(MAIN_CLONE_NO_AGENTS));
    const sb = (this.requireSandboxDaemon(machineId), this.requireSandbox(machineId, sandbox).id);
    return new Promise<{ from: string; to: string; notes: string[] }>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.switchCalls.delete(id);
        reject(new Error(`machine ${machineId} did not finish the switch in 10 minutes`));
      }, 10 * 60_000);
      this.switchCalls.set(id, { resolve, reject, timer });
      try {
        this.post(machineId, { type: 'switch', id, branch, createFrom, sandbox: sb, ...(callerSessionId ? { callerSessionId } : {}) });
      } catch (e) {
        clearTimeout(timer);
        this.switchCalls.delete(id);
        reject(e as Error);
      }
    });
  }

  /** An image file from a machine's clone, sandboxes or standing-agent folders, or from that session's temp folder. */
  async readImage(machineId: string, file: string, sessionId?: string) {
    const r = await this.fsCall(machineId, { op: 'read', path: file, ...(sessionId ? { sessionId } : {}) });
    return safeImage({ mediaType: r.mediaType!, data: Buffer.from(r.data ?? '', 'base64') });
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

/** sshReachable with ssh's reason when it does not get in (its last line: host key, permission, timeout). */
export async function sshCheck(host: string): Promise<{ reachable: boolean; detail: string }> {
  const { run } = await import('./proc.ts');
  const r = await run('ssh', SSH_REACHABLE_ARGS(host), { timeoutMs: 20_000 });
  const last = `${r.stderr}`.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  return r.code === 0 ? { reachable: true, detail: 'ok' } : { reachable: false, detail: last || `ssh exited ${r.code}` };
}

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
/**
 * What a worker root install's hello says about its folders (w513), onto its record. A root the record does not know
 * yet (a new install, or a migration from today's layout into a root) is the daemon's to say: its daemon folder, clone,
 * temp folder and sandbox folder replace the record's, and the record's limits stay. The same root again only fills
 * what the record lacks: add_machine and set_app_config stay in charge. Returns whether the pool's folder changed (the
 * portal then sends the daemon its pool settings again). Exported for tests.
 */
export function adoptLayout(m: Machine, layout: NonNullable<Extract<FromDaemon, { type: 'hello' }>['layout']>): boolean {
  const moved = m.root !== layout.root;
  const before = m.sandboxRoot;
  // Moving from today's layout into a root (a migration): keep where it was, for a rollback.
  if (moved && !m.root) m.preRoot = { appDir: m.appDir, repoPath: m.repoPath, tempDir: m.tempDir, sandboxRoot: m.sandboxRoot, librarySeed: m.librarySeed };
  m.root = layout.root;
  if (moved || !m.appDir) m.appDir = layout.appDir;
  if (moved || !m.repoPath) m.repoPath = layout.repoPath;
  if ((moved || !m.tempDir) && layout.tempDir) m.tempDir = layout.tempDir;
  const pool = layout.sandboxes;
  if (pool && (moved || !m.sandboxRoot)) {
    Object.assign(m, {
      sandboxRoot: pool.root,
      maxSandboxes: m.maxSandboxes ?? pool.maxSandboxes,
      maxAgentsPerSandbox: m.maxAgentsPerSandbox ?? pool.maxAgentsPerSandbox,
      maxUnity: m.maxUnity ?? pool.maxUnity,
      diskWarnGB: m.diskWarnGB ?? pool.diskWarnGB,
      diskCriticalGB: m.diskCriticalGB ?? pool.diskCriticalGB,
      ...(m.maxSandboxAgents === undefined && pool.maxAgents !== undefined ? { maxSandboxAgents: pool.maxAgents } : {}),
      ...(pool.librarySeed && (moved || !m.librarySeed) ? { librarySeed: pool.librarySeed } : {}),
    });
  }
  // Its sandbox count is its installer's, every time (w576): the installer also makes that many player-folder pairs
  // (players/slotK-0 and slotK-1) and their firewall rules, which the portal cannot.
  const recount = !!pool && m.maxSandboxes !== pool.maxSandboxes;
  if (pool && recount) m.maxSandboxes = pool.maxSandboxes;
  return m.sandboxRoot !== before || recount;
}

/**
 * A daemon without a root said hello to a record that has one: the migration into the root was rolled back, and the
 * old daemon runs again from its old folders. The record gets those back (kept by adoptLayout). Returns whether the
 * pool's folder changed. Exported for tests.
 */
export function leaveRoot(m: Machine): boolean {
  if (!m.root) return false;
  const before = m.sandboxRoot;
  const p = m.preRoot;
  delete m.root;
  delete m.preRoot;
  if (p) Object.assign(m, { appDir: p.appDir, repoPath: p.repoPath, tempDir: p.tempDir, sandboxRoot: p.sandboxRoot, librarySeed: p.librarySeed });
  return m.sandboxRoot !== before;
}

/** The first free sandbox slot name, slot1..slot<max>, or undefined when all are taken (w513). Exported for tests. */
export function slotName(taken: string[], max: number): string | undefined {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  for (let k = 1; k <= max; k++) if (!used.has(`slot${k}`)) return `slot${k}`;
  return undefined;
}

export function dirOptions(opts: MachineDirs, prev: MachineDirs | undefined): MachineDirs {
  const pick = (k: keyof MachineDirs, what: string) => (opts[k] === undefined ? prev?.[k] : machineDir(opts[k], what));
  const root = pick('root', 'root');
  return { ...(root !== undefined ? { root } : {}), appDir: pick('appDir', 'app_dir'), unityEditorRoot: pick('unityEditorRoot', 'unity_editor_root'), unityPath: pick('unityPath', 'unity_path'), tempDir: pick('tempDir', 'temp_dir'), sandboxRoot: pick('sandboxRoot', 'sandbox_root') };
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
 * How a daemon from another commit than this portal's differs, or undefined (w605: an update is available, nothing
 * else). info.daemon is the short hash machineDeploy or the installer stamped into machine/VERSION; unknown versions
 * count as current. Whether the two can work together is protocolProblem's call alone.
 */
export function daemonBehind(h: { daemon?: string }, portalHead: string | undefined): string | undefined {
  const d = h.daemon?.trim().toLowerCase();
  const p = portalHead?.trim().toLowerCase();
  if (!d || !p || !/^[0-9a-f]{7,40}$/.test(d)) return undefined;
  if (!p.startsWith(d) && !d.startsWith(p)) return `it runs ${d.slice(0, 9)}, this portal ${p.slice(0, 9)}`;
  return undefined;
}

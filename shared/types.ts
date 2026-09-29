// The wire contract between the server and the web UI. Both sides import this file; keep it
// free of runtime code other than constants so the browser bundle and Node's type stripping
// can both load it.

/** 'blocked': the editor is alive but stuck on a modal dialog, or silent for too long while starting (see unity.blocked). */
/** A working tree's real state, read from git (docs: server/gitStatus.ts). */
export interface GitStatus {
  /** The branch actually checked out now ("detached HEAD" when none). */
  branch: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Changed tracked files, and untracked ones. */
  dirty: number;
  untracked: number;
  head?: { sha: string; subject: string; date: string };
  /** The open PR from this branch, if any (gh). */
  pr?: { number: number; url: string; title: string; draft: boolean };
  at: string;
}

export type UnityState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'blocked';

/** Why an editor is blocked (docs/unity-dialogs.md). */
export interface UnityRestart {
  at: string;
  /** Why: "hung: the Unity MCP bridge has not answered for 11 min …", "crashed: …", or "asked for". */
  reason: string;
  /** Started by the hang/crash watch (counts toward its limit), not by a tool. */
  auto: boolean;
}

export interface UnityBlocked {
  reason: 'dialog' | 'stalled' | 'elevated' | 'restart-limit';
  /** The dialog, when reason is 'dialog'. */
  title?: string;
  text?: string;
  buttons?: string[];
  /** KNOWN_DIALOGS id, when the dialog is a known one. */
  dialogId?: string;
  /** What it means and what to do. */
  advice?: string;
  since: string;
  /** The state to return to once the dialog is gone or the log moves again. */
  resumeState: 'starting' | 'running';
}

/** A dialog the watchdog closed by pressing its safe button. */
export interface UnityDismissal {
  at: string;
  title: string;
  button: string;
}

export type SandboxStatus = 'creating' | 'ready' | 'error' | 'deleting';

export interface Sandbox {
  id: string;
  name: string;
  /** Git branch checked out in this sandbox's worktree. */
  branch: string;
  /** What the branch was created from (e.g. "origin/develop"). */
  base: string;
  /** Absolute worktree path on the host. */
  path: string;
  /** Free-text purpose, set by whoever created it ("spec 098", "shader work"). */
  purpose: string;
  status: SandboxStatus;
  /** Human-readable progress line while creating/deleting, or the error when status=error. */
  statusDetail?: string;
  createdAt: string;
  unity: {
    state: UnityState;
    pid?: number;
    startedAt?: string;
    logPath?: string;
    detail?: string;
    blocked?: UnityBlocked;
    /** Dialogs the watchdog dismissed for this editor, newest last (capped). */
    dismissed?: UnityDismissal[];
    /** Restarts of this sandbox's editor after a hang or crash (auto) or through the tools, newest last (capped). */
    restarts?: UnityRestart[];
  };
  /** Session ids (worker agents) that belong to this sandbox, newest last. */
  sessionIds: string[];
  /** Refreshed from git on a timer and after agent turns. */
  git?: GitStatus;
}

export type SessionKind = 'orchestrator' | 'worker' | 'standing';

/**
 * A person FF Factory knows: a login (data/users.json). `userId` is the login name, which never changes; it is
 * what FFBox maps to the account it bills (docs/ffbox-connector-contract.md, `requestedBy`).
 */
export interface Requester {
  userId: string;
  displayName: string;
}

/** owner: runs this portal (Ben). member: a teammate with a login (Lothsahn). Roles are recorded; enforcing them is a later phase. */
export type UserRole = 'owner' | 'member';

export interface UserInfo extends Requester {
  role: UserRole;
}

export type SessionStatus =
  | 'starting'
  | 'running' // a turn is in flight
  | 'idle' // waiting for the next message
  | 'waiting_permission'
  | 'stopped' // process not running; can be resumed by sending a message
  | 'error';

/** The Agent SDK's reasoning effort (Options.effort). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  /** Why it is being asked (blocked path, etc.), when the SDK says. */
  reason?: string;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  sandboxId?: string;
  /** The standing agent that owns this session (kind 'standing'). */
  standingId?: string;
  /** Set when the session runs on a machine (docs/machines.md) rather than on this host. */
  machineId?: string;
  /** The last label this agent gave its sandbox or machine (set_label), restored when a helper there finishes. */
  label?: string;
  labelAt?: string;
  title: string;
  status: SessionStatus;
  statusDetail?: string;
  model?: string;
  permissionMode: PermissionMode;
  /** Reasoning effort for this session's model; unset = the server default (config worker.effort). */
  effort?: EffortLevel;
  /** The Claude Code session id, used to resume after a restart. */
  sdkSessionId?: string;
  /**
   * The Claude account its current process started on, as an account source key (server/usage.ts
   * accountKeyOf: "token:<sha256 prefix>" or "host:login"). Set by this host's own sessions only; a Mac's
   * follow the config (sessionSource).
   */
  account?: string;
  createdAt: string;
  lastActivityAt: string;
  /** A tool call of its own (not a subagent's) still running: the oldest one, since when (Store.noteActivity). */
  activeTool?: { id: string; name: string; since: string };
  turns: number;
  costUsd: number;
  pendingPermissions: PendingPermission[];
  /** Last assistant text of the most recent finished turn, trimmed; for cards and summaries. */
  lastResult?: string;
  /**
   * The person this agent works for: who started it, or had the orchestrator start it (docs/identity.md). A
   * standing agent's is its current run's. Absent on the shared orchestrator and on sessions older than this field.
   */
  requestedBy?: Requester;
  /** Who the latest message a person (or the orchestrator for a person) sent this session came from. */
  lastRequestedBy?: Requester;
  /**
   * Restart bookkeeping (server/restart.ts), saved at once: since when its current turn has been open. Set by a
   * message, cleared when the turn ends or the session is stopped or interrupted on purpose, and kept when the
   * process dies with the server, so a crash cannot make a mid-turn agent look finished.
   */
  turnOpenSince?: string;
  /** Background tasks (a background command, a watcher) still open: they would have re-invoked it; a restart ends them. */
  backgroundTasks?: number;
}

/** An image kept with a session's transcript, served at /api/uploads/<sessionId>/<id>. */
export interface ImageRef {
  id: string;
  mediaType: string;
}

/** An image sent with a message: base64 data, plus its id once stored. */
export interface ImageInput {
  mediaType: string;
  data: string;
  id?: string;
}

/** Image types Claude accepts. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** An image file an agent produced, as listed by a sandbox's or machine's Screenshots gallery. */
export interface ImageFile {
  path: string;
  size: number;
  mtime: string;
}

/** One persisted transcript entry. Streaming deltas are NOT persisted (see ServerEvent). */
export type TranscriptEvent =
  /** requestedBy: the person who wrote it (from 'human'), or for whom the orchestrator or the harness sent it. */
  | { seq: number; t: string; kind: 'user'; text: string; from: 'human' | 'orchestrator' | 'system'; uuid?: string; images?: ImageRef[]; requestedBy?: Requester }
  | { seq: number; t: string; kind: 'assistant'; text: string }
  | { seq: number; t: string; kind: 'thinking'; text: string }
  | { seq: number; t: string; kind: 'tool_use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string | null }
  | { seq: number; t: string; kind: 'tool_result'; toolUseId: string; isError: boolean; text: string; images?: ImageRef[] }
  | { seq: number; t: string; kind: 'result'; ok: boolean; text: string; costUsd: number; turns: number; durationMs: number; answers?: string[] }
  | { seq: number; t: string; kind: 'system'; text: string }
  | { seq: number; t: string; kind: 'error'; text: string }
  | { seq: number; t: string; kind: 'permission'; requestId: string; toolName: string; input: unknown; decision?: 'allow' | 'deny' };

/** One computer's load: the portal's host (SystemStats) or a machine (its daemon reports it, server/system.ts). */
export interface HostStats {
  hostname: string;
  platform: string;
  cpuModel: string;
  cpuCount: number;
  loadPct: number; // 0-100, whole machine
  memTotalBytes: number;
  memFreeBytes: number;
  /**
   * Memory in use as the OS's own monitor counts it. On macOS free memory is mostly file cache, so this is
   * app + wired + compressed memory (Activity Monitor's "Memory Used"); absent: total minus free.
   */
  memUsedBytes?: number;
  /** macOS memory pressure (kern.memorystatus_vm_pressure_level). */
  memPressure?: 'normal' | 'warn' | 'critical';
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  /**
   * `unified`: Apple Silicon, where the GPU shares RAM: memUsedMiB is what the GPU holds in use and
   * memTotalMiB is all of RAM, so utilPct is the number that says how busy it is.
   */
  gpu?: { name: string; memTotalMiB: number; memUsedMiB: number; utilPct: number; unified?: boolean };
}

export interface SystemStats extends HostStats {
  limits: { maxUnity: number; maxSessions: number };
}

/** A machine's load, as its daemon last reported it (protocol 4+); not kept in state.json. */
export interface MachineStats extends HostStats {
  /** When the portal received it. */
  at: string;
}

// ---- machines (docs/machines.md) ----

export type MachineStatus = 'deploying' | 'ready' | 'error';

/** What a machine runs: a Mac (LaunchAgent) or a Windows PC (Task Scheduler), docs/machines.md. */
export type MachinePlatform = 'darwin' | 'win32';

/** "Mac" or "Windows PC", for sentences about a machine (a record from before platforms is a Mac). */
export const platformNoun = (p: MachinePlatform | undefined) => (p === 'win32' ? 'Windows PC' : 'Mac');

/** A machine's daemon folder: its app_dir, else <home>/.ff-factory. */
export const appDirOf = (m: Pick<Machine, 'appDir' | 'home'>) => m.appDir || `${m.home}/.ff-factory`;

export interface Machine {
  /** Short name, e.g. "m5"; also the MCP/label id. Lower-case (MACHINE_ID). */
  id: string;
  /** The id as it was typed when it has capitals, e.g. "LothDesktop" for lothdesktop: shown in its place. */
  name?: string;
  /** ssh host alias this host deploys to. */
  host: string;
  /** The label, like a sandbox's purpose line. */
  purpose: string;
  /** Deployment state; `online` says whether the daemon is connected right now. */
  status: MachineStatus;
  statusDetail?: string;
  online: boolean;
  lastSeen?: string;
  /** Mac or Windows PC; found over ssh at deploy and reported in the daemon's hello. Unset: a Mac (records from before). */
  platform?: MachinePlatform;
  /** The daemon was stopped on purpose (machine_daemon stop): not redeployed while offline until started again. */
  daemonStopped?: boolean;
  /** The machine's main Final Factory clone: where its agents work. */
  repoPath: string;
  home: string;
  /** The daemon's folder (code, logs, agents, daemon.json) when not the default <home>/.ff-factory (add_machine app_dir). */
  appDir?: string;
  /** A folder holding Unity editor versions (<root>/<version>/...), searched before Unity Hub's defaults. */
  unityEditorRoot?: string;
  /** The Unity editor executable itself (Unity.exe, or .../Unity.app/Contents/MacOS/Unity): wins over any lookup. */
  unityPath?: string;
  /** Scratch folder for its agents (TMP, TEMP and TMPDIR of their processes); unset: the system's. */
  tempDir?: string;
  /** Portal URL the daemon connects to. */
  portalUrl: string;
  maxSessions: number;
  sessionIds: string[];
  /** Reported by the daemon. */
  info?: { hostname: string; os: string; node: string; claude?: string; daemon: string; platform?: MachinePlatform };
  git?: GitStatus;
  createdAt: string;
}

// ---- providers (docs/ffbox-integration.md): FFBox, reached through the connector it runs ----

/** What one kind of requester gets in a provider class: operators run on their own Claude plan, Discord strangers on FFBox's model. */
export interface ProviderClassModel {
  requester: 'operator' | 'discord';
  model: string;
  tier: 'full' | 'simple';
}

/** A kind of container a provider offers, as its connector last reported it (server/providerProtocol.ts). */
export interface ProviderClass {
  name: string;
  network: 'fenced' | 'open';
  gpu: boolean;
  /** The model FF Factory's own work (operator-requested or automatic) runs on, e.g. "claude-opus-5-5". */
  model: string;
  /** full: any well-briefed task. simple: small, well-scoped work only. */
  tier: 'full' | 'simple';
  /** The model and tier per kind of requester, when the connector reports them; they win over model and tier. */
  models?: ProviderClassModel[];
  unity: string[];
  free: number;
  max: number;
  note?: string;
}

export interface ProviderCapacity {
  classes: ProviderClass[];
  queue: number;
  state: 'running' | 'draining' | 'updating' | 'stopped';
  holds: string[];
  /** When the portal received it. */
  at: string;
}

/** One FFBox conversation, as reported. `title` is untrusted text (it can carry what a player wrote). */
export interface ProviderConversation {
  id: string;
  source: 'discord' | 'intake' | 'codereview' | 'fff' | 'shell' | 'web' | 'other';
  opener: 'operator' | 'player' | 'fff' | 'system';
  title: string;
  state: 'queued' | 'running' | 'idle' | 'blocked' | 'closed';
  agentClass: string;
  branch?: string;
  pr?: { number: number; state: 'open' | 'merged' | 'closed' };
  verdict?: string;
  costUsd?: number;
  key?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

/** One report ffintake filed: only the facts ffintake computed or pattern-checked; never the report's own text. */
export interface ProviderIntakeEvent {
  reportId: string;
  kind: 'crash' | 'desync';
  receivedAt: string;
  gameVersion: string;
  platform: string;
  bytes: number;
  sender?: string;
  desync?: {
    group?: string | null;
    correlationId?: string;
    divergedClient?: number;
    role?: 'host' | 'client';
    localClient?: number;
    sessionEpoch?: number;
    verdictHeartbeat?: number;
    divergedSurfaces?: string;
    happenedAt?: string;
    why?: string;
  };
}

/** A provider as the sidebar and system_status see it. The lists are fetched separately (GET /api/providers/<id>/…). */
export interface Provider {
  id: string;
  name: string;
  /** config providers.<id>.enabled (default off). */
  enabled: boolean;
  /** Whether a connector token is configured (its hash; the token itself is never kept). */
  tokenSet: boolean;
  online: boolean;
  connectedSince?: string;
  lastSeen?: string;
  statusDetail?: string;
  connector?: { version: string; commit?: string; protocol: number };
  /** The provider's own page, for links. */
  web?: string;
  /** Work messages the connector said it takes (hello.accepts, e.g. "submit"); none yet in phase 1. */
  accepts?: string[];
  capacity?: ProviderCapacity;
  counts: { conversations: number; active: number; intake: number; intake24h: number };
  lastIntakeAt?: string;
}

/** FFBox's intake reports grouped by their coarse signature (shared/intake.ts, docs/ffbox-integration.md section 6). */
export interface IntakeSignature {
  /** `desync:<major.minor.patch>:<diverged surfaces>`, or `crash:<major.minor.patch>` (crashes get a real signature in phase 6). */
  signature: string;
  kind: 'crash' | 'desync';
  versionLine: string;
  surfaces?: string;
  reports: number;
  /** Distinct desync events (the report's group): every peer of one desync is one event. */
  events: number;
  senders: number;
  /** A host and a client report of one event. */
  pair: boolean;
  /** Clears the trust bar for an automatic investigation: 2+ distinct senders, or a host and client pair. Never for crashes yet. */
  trusted: boolean;
  firstAt: string;
  lastAt: string;
  versions: string[];
  platforms: string[];
  /** Report ids, newest first (at most 20). */
  reportIds: string[];
}

/** The numbers automatic investigations will be bounded by (docs/ffbox-integration.md, step 4). */
export interface IntakeBudget {
  /** Phase 4 (automatic investigations) is not built yet: these are what it would use. */
  live: false;
  perDay: number;
  perHour: number;
  /** Signatures first seen in the last 24 h / hour. */
  newToday: number;
  newLastHour: number;
  /** New today and past the trust bar: what would be started, before the caps. */
  trustedToday: number;
  /** min(trustedToday, perDay). */
  wouldStartToday: number;
  /** More than 5 new signatures in an hour stops automatic starts. */
  stormBreaker: { threshold: number; tripped: boolean };
}

export interface IntakeGroups {
  signatures: IntakeSignature[];
  budget: IntakeBudget;
  /** How many reports were grouped (the portal keeps the newest 2000). */
  reports: number;
}

// ---- Max, the Discord bot our agents post as (docs/max.md) ----

export type MaxAction = 'post' | 'reply' | 'ask' | 'edit' | 'thread_create' | 'close' | 'rename';

/** One thing an FF Factory agent did as Max, reported by the ffdiscord CLI through the events file. Text is ours but still shown as plain text. */
export interface MaxEvent {
  id: string;
  at: string;
  action: MaxAction;
  ok: boolean;
  channelId?: string;
  /** "#dev-chat", or the alias the agent passed, as best known. */
  channel?: string;
  /** Set when the channel is a thread: the thread's name and its parent channel. */
  thread?: { id: string; name?: string; parent?: string };
  messageId?: string;
  url?: string;
  /** The first line of what was posted (or the thread name), cleaned; never the whole message. */
  text?: string;
  /** Why it failed, e.g. "403 Missing Permissions". */
  error?: string;
  sessionId?: string;
  /** The session's title when the event arrived. */
  session?: string;
  /** "worker", "standing: <name>", "orchestrator", or "outside FF Factory". */
  agent?: string;
  /** "host" or a machine id. */
  where: string;
}

export interface MaxInboundItem {
  id: string;
  kind: 'message' | 'thread';
  author?: string;
  /** Untrusted Discord text: cleaned, cut short, shown as plain text only. */
  text: string;
  at: string;
  url?: string;
  unread: boolean;
  /** A forum thread's message count. */
  replies?: number;
}

export interface MaxInboundChannel {
  alias: string;
  channelId?: string;
  name?: string;
  kind?: 'text' | 'forum';
  unread: number;
  lastAt?: string;
  error?: string;
}

export interface MaxSummary {
  /** Where the bot token was looked for (a path or a variable name; never the token). */
  token: { found: boolean; source: string; problem?: string };
  health: { state: 'ok' | 'error' | 'unknown' | 'no_token'; bot?: string; checkedAt?: string; error?: string };
  lastError?: { at: string; message: string; channel?: string; action?: string; session?: string };
  lastPost?: { at: string; channel?: string; session?: string };
  counts: { events: number; posts24h: number; errors24h: number };
  inbound: { enabled: boolean; channels: MaxInboundChannel[]; polledAt?: string; nextPollAt?: string };
  /** The file the CLI appends events to on the host (FF_MAX_EVENTS). */
  eventsFile: string;
}

// ---- standing agents (docs/standing-agents.md) ----

export type StandingTrigger = { kind: 'interval'; minutes: number } | { kind: 'cron'; expr: string } | { kind: 'manual' };

/** Tool groups a standing agent may get on top of read-only file access. */
export type StandingToolGroup = 'shell_read' | 'github_comment' | 'delegate';

export const STANDING_TOOL_GROUPS: { value: StandingToolGroup; label: string; hint: string }[] = [
  { value: 'shell_read', label: 'Read-only shell', hint: 'git and gh for reading repos, plus cat/grep/ls-style utilities' },
  { value: 'github_comment', label: 'GitHub comments', hint: 'gh pr/issue comment and comment-only reviews; never approve, merge or close' },
  { value: 'delegate', label: 'Delegate', hint: 'ask for a worker in an unused sandbox (the user approves)' },
];

export type StandingRunTrigger = 'schedule' | 'manual' | 'message';

export type StandingRunOutcome = 'running' | 'ok' | 'error' | 'budget' | 'timeout' | 'stopped' | 'skipped' | 'interrupted';

export interface StandingRun {
  id: string;
  trigger: StandingRunTrigger;
  /** When it came due (schedule) or was asked for. */
  dueAt: string;
  startedAt?: string;
  endedAt?: string;
  outcome: StandingRunOutcome;
  costUsd: number;
  /** The agent's final message, clipped; or why it was skipped/stopped. */
  summary?: string;
  /** Who asked for it: the person for a manual or message run, the system payer (config systemPayer) for a scheduled one. */
  requestedBy?: Requester;
}

/** What the agent is doing now. */
export type StandingState = 'asleep' | 'waiting' | 'running' | 'paused';

export interface StandingAgent {
  id: string;
  name: string;
  charter: string;
  model: string;
  trigger: StandingTrigger;
  /** Absolute working folder on the host (holds NOTES.md). */
  folder: string;
  enabled: boolean;
  budget: { perRunUsd: number; perDayUsd: number; maxMinutes: number };
  tools: StandingToolGroup[];
  /** The one long-lived Claude session this agent resumes every run. */
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  state: StandingState;
  /** Why it is waiting, or the last scheduling problem. */
  stateDetail?: string;
  /** Next scheduled run; undefined for manual-only or paused agents. */
  nextRunAt?: string;
  /** A run that is due but has not started (waiting for a free agent slot). At most one. */
  pending?: { trigger: StandingRunTrigger; dueAt: string; deadline: string; text?: string; requestedBy?: Requester };
  /** Runs on this machine instead of this host (its folder is then on that machine). */
  machineId?: string;
  /** Start this agent's delegation requests without the user's approval, within these limits. */
  autoApprove?: AutoApprove;
  /** Spend on the host's local date `day` (YYYY-MM-DD). */
  spend: { day: string; usd: number };
  /** Newest last, capped. */
  runs: StandingRun[];
}

export interface StandingAgentInput {
  name: string;
  charter: string;
  model?: string;
  trigger: StandingTrigger;
  enabled?: boolean;
  budget?: Partial<StandingAgent['budget']>;
  tools?: StandingToolGroup[];
  /** A machine id to run on, or '' / undefined for this host. */
  machineId?: string;
  autoApprove?: Partial<AutoApprove>;
}

/** Auto-approval of a standing agent's delegation requests (docs/standing-agents.md). */
export interface AutoApprove {
  enabled: boolean;
  maxPerRun: number;
  maxPerDay: number;
  model: string;
  effort: EffortLevel;
  /** Where workers may start: unused sandboxes first, then idle machines; or only one kind. */
  targets: 'sandboxes-then-machines' | 'sandboxes' | 'machines';
  /** A request that finds no free target is retried until this many hours after it was filed. */
  expiryHours: number;
  /** Sandbox or machine ids never used, whatever their label. */
  exclude: string[];
}

export type DelegationStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface DelegationRequest {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  task: string;
  createdAt: string;
  status: DelegationStatus;
  decidedAt?: string;
  /** Set once approved: where the worker runs. */
  sandboxId?: string;
  machineId?: string;
  sessionId?: string;
  note?: string;
  /** Auto-approval: queued waiting for a free target until `expiresAt`, or started without the user. */
  auto?: 'queued' | 'started';
  autoApproved?: boolean;
  expiresAt?: string;
  /** The run it was filed in (the per-run limit). */
  runId?: string;
  model?: string;
  effort?: EffortLevel;
  /** When the delegated worker first finished a turn. */
  finishedAt?: string;
  /** What happened to it, oldest first: "10:02 queued: no free target", "10:05 started in sb2". */
  log?: string[];
  /** Who the run that filed it was for (the system payer for a scheduled run). */
  requestedBy?: Requester;
  /** The person who approved it; absent when auto-approved. Its worker is requested by them. */
  approvedBy?: Requester;
}

/** Facts about the host process itself, for the dashboard banner. */
export interface HostStatus {
  /** The server runs with administrator rights, so it refuses to start Unity editors. */
  elevated: boolean;
  /** Why it is still elevated and what fixes it. */
  elevatedWhy?: string;
  /** A restart is waiting for busy agents to finish (scripts/restart.ps1 or request_app_update). */
  drain?: DrainStatus;
  /** Disks, the sandbox drive, memory, and what the guard is doing about them (server/hostHealth.ts). */
  health?: HostHealth;
}

export type DiskLevel = 'ok' | 'warn' | 'critical';

export interface HostHealth {
  checkedAt: string;
  /** Each watched volume (the sandbox root's and config hostDiskPaths'), with its guard level. */
  disks: { path: string; freeBytes?: number; totalBytes?: number; level: DiskLevel }[];
  /** The worst disk level. */
  level: DiskLevel;
  /** The sandbox drive: there, gone, being reattached, or given up on (see detail). */
  sandboxRoot: 'ok' | 'missing' | 'remounting' | 'failed';
  detail?: string;
  memFreeBytes: number;
  memTotalBytes: number;
  /** Why new editors and new agent processes are refused right now, if they are. */
  blocked?: string;
  lastCleanup?: { at: string; removed: number; freedBytes?: number };
  /** Automatic Unity restarts in the last hour, per sandbox (docs/unity-lifecycle.md). */
  unityRestarts?: { sandbox: string; at: string; reason: string }[];
  /** The orphan headless-browser reaper's last pass that found something (server/reaper.ts). */
  lastReap?: { at: string; killed: number; lines: string[] };
}

export interface DrainStatus {
  reason: string;
  update: boolean;
  startedAt: string;
  deadline: string;
  /** Sessions still mid-turn. */
  waitingFor: string[];
}

// ---- notifications ----

export type NotifyKind = 'permission' | 'turnEnd' | 'error' | 'standing' | 'delegation' | 'unity' | 'host';
export type NotifyPrefs = Record<NotifyKind, boolean>;

export const NOTIFY_KINDS: { value: NotifyKind; label: string; hint: string }[] = [
  { value: 'permission', label: 'Needs permission', hint: 'an agent is waiting for you to allow a tool' },
  { value: 'turnEnd', label: 'Turn finished', hint: 'the orchestrator or a worker finished a turn' },
  { value: 'error', label: 'Errors', hint: 'a session stopped with an error' },
  { value: 'standing', label: 'Standing agent problems', hint: 'a run failed, hit its budget or ran out of time' },
  { value: 'delegation', label: 'Delegation requests', hint: 'a standing agent asks for a worker' },
  { value: 'unity', label: 'Unity editor stuck', hint: 'an editor is blocked on a dialog or has gone silent while starting' },
  { value: 'host', label: 'Host health', hint: 'disk space low, the sandbox drive gone or back, automatic recovery steps' },
];

/** One plan usage meter (server/usage.ts). */
export interface UsageMeter {
  label: string;
  /** Share of the window used, 0-100. */
  percent: number;
  resetsAt?: string;
  /** The server's grading ('normal', 'warning', 'critical'), when it gives one. */
  severity?: string;
}

/** the user's Claude plan usage limits, from the claude.ai usage endpoint via the Agent SDK. */
export interface PlanUsage {
  available: boolean;
  /** When these numbers were fetched. */
  asOf: string;
  /** 'max', 'pro', ... */
  plan?: string;
  weekly?: UsageMeter;
  /** The 5-hour session window. */
  session?: UsageMeter;
  /** Per-model weekly windows (e.g. "Weekly Fable"). */
  models: UsageMeter[];
  /** Why the plan numbers are unavailable. */
  why?: string;
  /** The last refresh failed; the numbers are from asOf. */
  error?: string;
  /** Where the numbers came from when not the usage endpoint, e.g. "rate-limit headers" (weekly and session only). */
  source?: string;
  /** Only when unavailable: FF Factory's own agent spend over the last 7 days (spend, not the plan limit). */
  spendWeekUsd?: number;
}

/**
 * One Claude account the portal's agents or the user's machines run on, with its plan usage. Identified
 * safely: the last 4 characters of a token, or a login's email; never the credential itself.
 */
export interface AccountUsage {
  /** Stable key: "token:<sha256 prefix>", "email:<address>", or "login:<where>" while a login's email is unknown. */
  id: string;
  kind: 'token' | 'login';
  /** "host token …9AAA", or the login's email. */
  label: string;
  email?: string;
  /**
   * The credentials that are this account: "token:<sha256 prefix>", "host:login" (this host's own claude.ai
   * login) or "login:<machine id>" (a Mac's own login). Several when one login is signed in on several computers.
   */
  sources: string[];
  /** Where it is used, for people: "BEAST login", "m3 login", "the agents' token on BEAST, m5". */
  where: string[];
  /** The portal's agents that run on it now, by session id. */
  sessionIds: string[];
  usage?: PlanUsage;
}

/** One transcript search result: where, when, and the text around the match. */
export interface SearchHit {
  sessionId: string;
  seq: number;
  t: string;
  kind: TranscriptEvent['kind'];
  snippet: string;
  title: string;
  sessionKind?: SessionKind;
  sandboxId?: string;
  machineId?: string;
  standingId?: string;
}

/** Server-wide settings the user changes from the UI (or the orchestrator's tools). */
export interface AppSettings {
  /** Wake the orchestrator every N minutes while any worker is mid-turn; null = off. */
  heartbeatMinutes: number | null;
}

/** This app's version (root package.json) and the short git SHA of the running checkout. */
export interface AppVersion {
  version: string;
  sha?: string;
}

export interface AppState {
  /** The running server's version; absent from a server older than 0.1.0. */
  app?: AppVersion;
  sandboxes: Sandbox[];
  sessions: SessionInfo[];
  standingAgents: StandingAgent[];
  delegations: DelegationRequest[];
  machines: Machine[];
  /** Providers (FFBox); absent from a server older than this field. */
  providers?: Provider[];
  /** FFBox's summary even while it is off (the External strip and its setup page); absent from older servers. */
  ffbox?: Provider;
  /** Max, the Discord bot our agents post as (docs/max.md); absent from a server older than this field. */
  max?: MaxSummary;
  system?: SystemStats;
  host: HostStatus;
  usage?: PlanUsage;
  /** Every Claude account in use, with its plan usage; absent from a server older than this field. */
  accounts?: AccountUsage[];
  /** Each online machine's load, by machine id; absent from a server older than this field. */
  machineStats?: Record<string, MachineStats>;
  /** The id of the main-page orchestrator session. */
  orchestratorId: string;
  config: { defaultModel: string; models: string[]; defaultBase: string };
  settings: AppSettings;
}

/** Pushed over the WebSocket at /ws. */
export type ServerEvent =
  | { type: 'state'; state: AppState }
  | { type: 'sandbox'; sandbox: Sandbox }
  | { type: 'sandbox_removed'; id: string }
  | { type: 'session'; session: SessionInfo }
  | { type: 'session_removed'; id: string }
  | { type: 'standing'; agent: StandingAgent }
  | { type: 'standing_removed'; id: string }
  | { type: 'delegation'; request: DelegationRequest }
  | { type: 'machine'; machine: Machine }
  /** Something worth a notification; pages without a push subscription may show it themselves. */
  | { type: 'notify'; notice: { kind: NotifyKind; title: string; body: string; url: string; tag: string } }
  | { type: 'machine_removed'; id: string }
  | { type: 'provider'; provider: Provider }
  | { type: 'max'; max: MaxSummary }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'transcript'; sessionId: string; event: TranscriptEvent }
  /** Live assistant text while a turn streams; the UI shows it until the 'assistant' event lands. */
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'system'; system: SystemStats }
  | { type: 'host'; host: HostStatus }
  | { type: 'usage'; usage: PlanUsage }
  | { type: 'accounts'; accounts: AccountUsage[] }
  /** null: the machine went offline and its numbers are gone. */
  | { type: 'machine_stats'; id: string; stats: MachineStats | null }
  /** Keep-alive, every SOCKET_PING_MS: a page that hears nothing for longer treats its socket as dead. */
  | { type: 'ping' };

/** How often the server pings every browser socket (server/index.ts); the page's staleness limit is a few of these. */
export const SOCKET_PING_MS = 15_000;

// ---- REST request bodies ----

export interface CreateSandboxRequest {
  name: string;
  /** Branch to create or check out. Defaults to "sandbox/<name>". */
  branch?: string;
  /** Base ref for a new branch. Defaults to config.defaultBase. */
  base?: string;
  purpose?: string;
  /** Copy the warm Library seed into the worktree (needed for a fast Unity start). Default true. */
  seedLibrary?: boolean;
  startUnity?: boolean;
}

export interface StartSessionRequest {
  effort?: EffortLevel;
  /** Exactly one of sandboxId and machineId. */
  sandboxId?: string;
  machineId?: string;
  prompt: string;
  title?: string;
  model?: string;
  permissionMode?: PermissionMode;
}

export interface SendMessageRequest {
  text: string;
  images?: ImageInput[];
}

export interface PermissionDecisionRequest {
  requestId: string;
  allow: boolean;
  message?: string;
}

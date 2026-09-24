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
export interface UnityBlocked {
  reason: 'dialog' | 'stalled' | 'elevated';
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
  };
  /** Session ids (worker agents) that belong to this sandbox, newest last. */
  sessionIds: string[];
  /** Refreshed from git on a timer and after agent turns. */
  git?: GitStatus;
}

export type SessionKind = 'orchestrator' | 'worker' | 'standing';

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
  title: string;
  status: SessionStatus;
  statusDetail?: string;
  model?: string;
  permissionMode: PermissionMode;
  /** Reasoning effort for this session's model; unset = the server default (config worker.effort). */
  effort?: EffortLevel;
  /** The Claude Code session id, used to resume after a restart. */
  sdkSessionId?: string;
  createdAt: string;
  lastActivityAt: string;
  turns: number;
  costUsd: number;
  pendingPermissions: PendingPermission[];
  /** Last assistant text of the most recent finished turn, trimmed; for cards and summaries. */
  lastResult?: string;
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
  | { seq: number; t: string; kind: 'user'; text: string; from: 'human' | 'orchestrator' | 'system'; uuid?: string; images?: ImageRef[] }
  | { seq: number; t: string; kind: 'assistant'; text: string }
  | { seq: number; t: string; kind: 'thinking'; text: string }
  | { seq: number; t: string; kind: 'tool_use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string | null }
  | { seq: number; t: string; kind: 'tool_result'; toolUseId: string; isError: boolean; text: string; images?: ImageRef[] }
  | { seq: number; t: string; kind: 'result'; ok: boolean; text: string; costUsd: number; turns: number; durationMs: number; answers?: string[] }
  | { seq: number; t: string; kind: 'system'; text: string }
  | { seq: number; t: string; kind: 'error'; text: string }
  | { seq: number; t: string; kind: 'permission'; requestId: string; toolName: string; input: unknown; decision?: 'allow' | 'deny' };

export interface SystemStats {
  hostname: string;
  platform: string;
  cpuModel: string;
  cpuCount: number;
  loadPct: number; // 0-100, whole machine
  memTotalBytes: number;
  memFreeBytes: number;
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  gpu?: { name: string; memTotalMiB: number; memUsedMiB: number; utilPct: number };
  limits: { maxUnity: number; maxSessions: number };
}

// ---- machines (docs/machines.md) ----

export type MachineStatus = 'deploying' | 'ready' | 'error';

export interface Machine {
  /** Short name, e.g. "m5"; also the MCP/label id. */
  id: string;
  /** ssh host alias this host deploys to. */
  host: string;
  /** The label, like a sandbox's purpose line. */
  purpose: string;
  /** Deployment state; `online` says whether the daemon is connected right now. */
  status: MachineStatus;
  statusDetail?: string;
  online: boolean;
  lastSeen?: string;
  /** The Mac's main Final Factory clone: where its agents work. */
  repoPath: string;
  home: string;
  /** Portal URL the daemon connects to. */
  portalUrl: string;
  maxSessions: number;
  sessionIds: string[];
  /** Reported by the daemon. */
  info?: { hostname: string; os: string; node: string; claude?: string; daemon: string };
  git?: GitStatus;
  createdAt: string;
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
  pending?: { trigger: StandingRunTrigger; dueAt: string; deadline: string; text?: string };
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
}

/** Facts about the host process itself, for the dashboard banner. */
export interface HostStatus {
  /** The server runs with administrator rights, so it refuses to start Unity editors. */
  elevated: boolean;
  /** Why it is still elevated and what fixes it. */
  elevatedWhy?: string;
  /** A restart is waiting for busy agents to finish (scripts/restart.ps1 or request_app_update). */
  drain?: DrainStatus;
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

export type NotifyKind = 'permission' | 'turnEnd' | 'error' | 'standing' | 'delegation' | 'unity';
export type NotifyPrefs = Record<NotifyKind, boolean>;

export const NOTIFY_KINDS: { value: NotifyKind; label: string; hint: string }[] = [
  { value: 'permission', label: 'Needs permission', hint: 'an agent is waiting for you to allow a tool' },
  { value: 'turnEnd', label: 'Turn finished', hint: 'the orchestrator or a worker finished a turn' },
  { value: 'error', label: 'Errors', hint: 'a session stopped with an error' },
  { value: 'standing', label: 'Standing agent problems', hint: 'a run failed, hit its budget or ran out of time' },
  { value: 'delegation', label: 'Delegation requests', hint: 'a standing agent asks for a worker' },
  { value: 'unity', label: 'Unity editor stuck', hint: 'an editor is blocked on a dialog or has gone silent while starting' },
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
  /** Only when unavailable: FF Factory's own agent spend over the last 7 days (spend, not the plan limit). */
  spendWeekUsd?: number;
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

export interface AppState {
  sandboxes: Sandbox[];
  sessions: SessionInfo[];
  standingAgents: StandingAgent[];
  delegations: DelegationRequest[];
  machines: Machine[];
  system?: SystemStats;
  host: HostStatus;
  usage?: PlanUsage;
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
  | { type: 'settings'; settings: AppSettings }
  | { type: 'transcript'; sessionId: string; event: TranscriptEvent }
  /** Live assistant text while a turn streams; the UI shows it until the 'assistant' event lands. */
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'system'; system: SystemStats }
  | { type: 'host'; host: HostStatus }
  | { type: 'usage'; usage: PlanUsage };

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

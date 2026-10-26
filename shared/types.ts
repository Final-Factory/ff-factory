// The wire contract between the server and the web UI. Both sides import this file; keep it
// free of runtime code other than constants so the browser bundle and Node's type stripping
// can both load it.
import type { TurnUsage } from './spend.ts';
import type { GithubPermissionId } from './githubRequirements.ts';
import type { GhLogin } from './ghLogin.ts';
import type { Ask } from './ask.ts';

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
  /** Only a person at the desktop can resolve it (server/watchdog.ts agentAnswers); otherwise its agents are asked. */
  person?: boolean;
  since: string;
  /** The state to return to once the dialog is gone or the log moves again. */
  resumeState: 'starting' | 'running';
}

/** A dialog the watchdog closed by pressing its safe button. */
export interface UnityDismissal {
  at: string;
  title: string;
  button: string;
  /** 'agent': pressed by an agent through the unity tool's answer_dialog; absent: by the watchdog itself. */
  by?: 'agent';
}

/**
 * 'cleanup' (w898): the released sandbox's Library caches (BuildCache, BurstCache) are being trimmed before it goes to the next
 * worker. Not free, takes no agent and no editor; it goes back to 'ready' by itself when the trim ends or times out.
 */
export type SandboxStatus = 'creating' | 'ready' | 'error' | 'deleting' | 'cleanup';

export interface Sandbox {
  id: string;
  name: string;
  /** Git branch checked out in this sandbox's worktree. */
  branch: string;
  /** What the branch was created from (e.g. "origin/master"). */
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

/** ops: the one orchestration worker in the portal VM (w597, docs/ops-worker.md). */
export type SessionKind = 'orchestrator' | 'worker' | 'standing' | 'ops';

/**
 * What an orchestrator is (docs/orchestrators.md): the portal's one dispatcher, which owns every tool that changes
 * something, or a person's own orchestrator, which talks with that person and files work requests with the dispatcher.
 */
export type OrchestratorRole = 'dispatcher' | 'personal';

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

/** A message from another person, unread in its recipient's chat (SessionInfo.personMessages, w1546). */
export interface PersonMessageMark {
  /** Absent on marks saved before w1546, which `at` stands in for. */
  id?: string;
  from: Requester;
  at: string;
  /** The sender's words as their orchestrator wrote them (at most PERSON_MESSAGE_CHARS); absent before w1546. */
  text?: string;
}

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  sandboxId?: string;
  /** The standing agent that owns this session (kind 'standing'). */
  standingId?: string;
  /** Set when the session runs on a machine (docs/machines.md) rather than on this host. */
  machineId?: string;
  /** With machineId: the machine sandbox it works in (docs/machines.md, "Machine sandboxes"), not the machine's main clone. */
  machineSandbox?: string;
  /** Retired (w575): the label an agent gave its sandbox or machine with set_label. Old records may still carry it. */
  label?: string;
  labelAt?: string;
  title: string;
  status: SessionStatus;
  statusDetail?: string;
  /** w1969: the worker's last timed_place verdict, kept with the session so a portal restart does not drop it (w1829). */
  timedVerdict?: TimedVerdict;
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
  /**
   * The Claude account its current process was started on, in words safe to show and to keep with its spend (w1031):
   * "vault token vault-lothsahn-1 …EAAA (lothsahn's pool, docs/vault.md)", "host token …9AAA". Set at each process start
   * by the portal that built the launch; spend_report attributes a turn to the account its session ran on.
   */
  ranAs?: string;
  /**
   * The person whose own Claude tokens (their vault pool or their own token) its current process was started on (w1076);
   * absent when it ran on the machine's account. A live process whose requests now name another person is restarted at
   * its next turn boundary (SessionManager.accountMove), so the next turn runs on theirs.
   */
  ranFor?: string;
  /**
   * The FF Factory commit of the daemon that started its current process (w1166), as the machine's hello gave it. An agent
   * host keeps the code it started with (its guard, its system prompt) across daemon updates: on 2026-10-12 workers
   * started before ba015be opened game PRs into the retired develop for an hour after it rolled out. A worker whose
   * machine now runs another commit restarts on it at its next turn boundary (SessionManager.codeMove), and the first
   * message of the new process says FF Factory changed under it.
   */
  ranOn?: string;
  createdAt: string;
  lastActivityAt: string;
  /** A tool call of its own (not a subagent's) still running: the oldest one, since when (Store.noteActivity). */
  activeTool?: { id: string; name: string; since: string };
  turns: number;
  costUsd: number;
  /**
   * The CLI's own running total (`total_cost_usd`) at this session's last result, any process (w1161). A resumed process
   * continues from the total its transcript saved, so its first result is this plus the new turn; costUsd may run
   * ahead of it (a process that started from zero adds to costUsd, not to this). Absent on sessions older than w1161.
   */
  sdkCostUsd?: number;
  pendingPermissions: PendingPermission[];
  /** Last assistant text of the most recent finished turn, trimmed; for cards and summaries. */
  lastResult?: string;
  /** When that turn ended (w1504): a person-wait its report names is settled by a note or a merge after it. Absent on sessions older than this field and not backfilled (Store.backfillResultTimes). */
  lastResultAt?: string;
  /**
   * The person this agent works for: who started it, or had the orchestrator start it (docs/identity.md). A
   * standing agent's is its current run's; a personal orchestrator's is its person. Absent on the dispatcher and on
   * sessions older than this field.
   */
  requestedBy?: Requester;
  /** Kind 'orchestrator' only: the dispatcher or a person's own. Absent on an orchestrator older than this field. */
  orchestratorRole?: OrchestratorRole;
  /** Who the latest message a person (or the orchestrator for a person) sent this session came from. */
  lastRequestedBy?: Requester;
  /**
   * A person's own orchestrator only: messages other people sent its person (message_person, docs/orchestrators.md)
   * that they have not read yet, oldest first. Shown in the bubble over the message box until they clear them there
   * (w1546): opening or writing to the chat, and the orchestrator relaying one, leave them unread.
   */
  personMessages?: PersonMessageMark[];
  /**
   * Restart bookkeeping (server/restart.ts), saved at once: since when its current turn has been open. Set by a
   * message, cleared when the turn ends or the session is stopped or interrupted on purpose, and kept when the
   * process dies with the server, so a crash cannot make a mid-turn agent look finished.
   */
  turnOpenSince?: string;
  /** Background tasks (a background command, a watcher) still open: they would have re-invoked it; a restart ends them. */
  backgroundTasks?: number;
  /** Its pending wake_me (w475): when it comes due (ISO). Kept in step by the server (Agents.syncWaiting). */
  wakeAt?: string;
  /** That wake_me's note, cut (w509): what the agent said it will check, shown as what it waits on. */
  wakeNote?: string;
  /**
   * Its live background jobs (w509), from the SDK's background_tasks_changed set without the ambient ones: the
   * description the agent gave each ("CI on PR #1098", "player build") and its kind. At most 5. Gone with its process.
   */
  backgroundJobs?: { type: string; description: string }[];
  /** Why a message to it waits in the send queue for a free slot (w475, w384), while one does. */
  queuedSend?: string;
  /**
   * What holds that message (w643): `capacity` (no free agent slot or sandbox: Queued) or `machine` (its machine is
   * offline or its daemon outdated: Blocked on that machine) or `pool` (its person's Claude pool is held, w1129: Blocked on
   * that usage limit). Absent: capacity.
   */
  queuedOn?: 'capacity' | 'machine' | 'pool';
  /**
   * w1949: its last start of its sandbox's editor, refused for want of a Unity slot on its machine (machine/unitySlots.ts
   * startRefusal), when and why. Cleared by a start, restart or stop that goes through, and when its next turn opens. While
   * it is stopped with a check-in and the machine has no slot free, its request shows Blocked on a Unity editor slot.
   */
  editorRefused?: { machine: string; sandbox: string; at: string; why: string };
  /**
   * The worker declared that only a person can move it on (w691: the waiting_on_person tool): who, and what they must do.
   * The ledger shows its requests Waiting on input (on <who>), also while a check-in of its own is pending, and the agent
   * as Needs you. Kept by the portal, never by the daemon; gone with its next message (a new turn: it declares again if
   * it still waits). `request` limits it to one request when the worker serves several.
   */
  waitingOn?: { who: string; what: string; at: string; request?: string; asks?: Ask[]; about?: string; after?: string };
  /**
   * A person's own orchestrator (w1868): its ask_person questions still open, each a card on its person's Waiting on input
   * tab with one-click answers (lothsahn: "make sure that all pending questions that you have show up on the intake portal so
   * that I can click through them quickly"). One goes when it is answered (a click or a reply to it), asked again, withdrawn
   * (close_question) or its request closes. Server/orchestrators.ts observeAsk keeps it.
   */
  openAsks?: OpenAsk[];
  /**
   * Machine sessions (w691): a message to it found no agent host to run in ("could not start its agent host: …"). Nothing
   * runs for it whatever its status says (an older daemon went on reporting it mid-turn): the ledger shows its request
   * Blocked on its machine and the agent as Blocked. Kept by the portal; gone when its host's first event arrives.
   */
  hostFailure?: { at: string; error: string };
  /**
   * The context its next model call reads, in tokens (w535): the last call's input, cached and uncached, plus its
   * output, as the SDK reported it; after a compaction, the size Claude Code measured. This host's sessions only.
   */
  contextTokens?: number;
  /**
   * The model its last reply came from (w1358): the `model` Claude Code put on the assistant message, the same per-call
   * model the spend tracking counts, so a switch (the coordinators' routine model, w1158; an alias; a fallback) shows at
   * once. `model` above is only what the process was started with. Absent until its first reply.
   */
  activeModel?: string;
  /** What its last finished turn cost, in USD (w535): what the automatic compaction's cost trigger reads. */
  lastTurnCostUsd?: number;
  /** Its last compaction (w518, w535), whoever started it. */
  lastCompaction?: CompactionRecord;
  /**
   * An automatic compaction FF Factory owes this orchestrator (w1749, server/autoCompact.ts): set when one is due, cleared
   * when one finishes. Saved, so a portal restart, a stop or a closed session runs or retries it; while an attempt runs or
   * a retry is owed, messages to it wait in the send queue and go after it.
   */
  compactOwed?: CompactionOwed;
  /**
   * Machine sessions: stopped or interrupted on purpose (stop_agent, interrupt_agent, the UI) since its last message.
   * Kept by the portal, never by the daemon: no dropped link or restart resumes it until it is sent a message again.
   */
  stoppedOnPurpose?: boolean;
  /**
   * Workers (w1984): stop_agent move_to moved its requests off `machine` to `to` at `at`. Its waiting bench tickets left
   * in that machine's queue are marked away there (Agents.benchPriorities) for BENCH_MOVED_AWAY_MS, so they hold nobody
   * back while its old processes wind down.
   */
  movedAway?: { machine: string; to: string; at: string };
  /**
   * Machine sessions (w613): its process ended because its daemon went away (a worker update, a restart, a crash) and
   * not on purpose, at this time. Its sandbox stays its (holdsSandbox, shared/agentState.ts) until it is messaged, stopped
   * on purpose, or released: HOLD_PLACE_MS (30 min, w656) after this, the release pass (server/placeAgain.ts) releases
   * it like a far check-in's, its worktree clean, so new work does not take the sandbox it was in before then.
   */
  heldSince?: string;
  /**
   * Machine sandbox workers (w656): FF Factory stopped it while it was idle with nothing pending (no check-in, job or
   * queued message), or its work over, and this is why. Its sandbox stays its (holdsSandbox) until the release pass
   * releases it (placeReleased) or it is messaged, so new work never starts on its branch or over its uncommitted files.
   */
  /**
   * `workedAt`: its last activity when the release pass decided to stop it (w890): the stop's own transcript line moves
   * `lastActivityAt`, and a git state read before that is not stale, since nothing was worked in between.
   */
  releaseDue?: { at: string; why: string; workedAt?: string };
  /**
   * Machine sandbox workers (w640, w656): stopped with its check-in far away (more than RELEASE_AFTER_MS), its requests
   * over, its w613 hold past, or stopped while idle (releaseDue), its worktree clean, so its sandbox no longer counts as its (holdsSandbox, shared/agentState.ts) and may take
   * other work. The branch it was on is kept here: when it resumes it is placed again on it (server/placeAgain.ts).
   */
  placeReleased?: { at: string; sandbox: string; branch: string; why: string };
  /**
   * w1856 (server/releaseHandBack.ts): its switch_branch put a sandbox on a release branch (urgent/<v>, release/<v>) from
   * `from`; build_plan done switches the sandbox back to `from` if it is still on `to`, then this goes.
   */
  releaseSwitch?: { machine: string; sandbox: string; from: string; to: string; at: string };
  /**
   * Its uncommitted work was committed on its branch before its sandbox was released (w656, server/saveWork.ts): its
   * next message says so, then this goes.
   */
  savedWork?: { sha: string; files: number; pushed: boolean; branch: string; at: string };
  /** Placed again in another sandbox than the one it stopped in (w640): its next message says where, then this goes. */
  /** `shared` (w1135): work that is not the game's, resumed on an agent seat beside another agent; its game tree is that agent's. */
  movedFrom?: { sandbox: string; path: string; at: string; why: string; branch: string; shared?: true };
  /**
   * Its Live view ended because its sandbox was released while it waited (w1582, server/placeAgain.ts liveLostNote): its
   * next message asks it to stage the view again with these settings, then this goes.
   */
  liveLost?: { at: string; why: string; materials: string[]; fps: number; width: number };
}

/**
 * Who started a compaction (w535): a person's `/compact` or the menu (`person`), FF Factory because the context or a
 * turn's cost passed its threshold (`tokens`, `cost`), the orchestrator itself (`self`, compact_conversation), or Claude
 * Code at its own hard limit (`claude`).
 */
export type CompactionTrigger = 'person' | 'tokens' | 'cost' | 'self' | 'claude' | 'wait';

/** One finished compaction of a session's conversation (w535): when, why, and the context before and after. */
/** An automatic compaction not done yet (w1749): why, its focus when the orchestrator gave one, and its attempts so far. */
export interface CompactionOwed {
  trigger: Exclude<CompactionTrigger, 'person' | 'claude'>;
  reason: string;
  /** compact_conversation's own focus (w535); absent: the default one. */
  focus?: string;
  /** When it first came due. */
  since: string;
  /** Attempts started (0 while it waits for quiet, w1538). */
  attempts: number;
  lastAttemptAt?: string;
  /** Why the last attempt failed. */
  lastError?: string;
}

export interface CompactionRecord {
  at: string;
  trigger: CompactionTrigger;
  /** The context it compacted, in tokens (Claude Code's compact_boundary pre_tokens). */
  before: number;
  /** The context afterwards, in tokens, when it could be measured. */
  after?: number;
  /** The session's turn count then: automatic compaction waits a few turns before the next. */
  turns: number;
}

/** An image kept with a session's transcript, served at /api/uploads/<sessionId>/<id>. */
export interface ImageRef {
  id: string;
  mediaType: string;
  /** The file an agent's message showed, copied here when the message arrived (server/inlineImages.ts). */
  path?: string;
}

/** An image sent with a message: base64 data, plus its id once stored. */
export interface ImageInput {
  mediaType: string;
  data: string;
  id?: string;
}

/**
 * A file a person attached to a message (docs/attachments.md): a save, a bug-report zip, a log, a desync report.
 * Stored once by its SHA-256 in the portal's data folder, never unpacked or run there; served for download only.
 */
export interface AttachmentRef {
  /** "att_" and 12 lowercase letters or digits (shared/attachments.ts ATTACHMENT_ID): what orchestrators pass on. */
  id: string;
  /** Its file name as uploaded, made safe (attachmentName). */
  name: string;
  size: number;
  sha256: string;
  /** What it is from its name alone (never opened): "Final Factory bug report (zip)", "Unity Player.log", ... */
  kind: string;
  mediaType: string;
}

/** An attachment as one agent got it: where its copy is for that agent, or why it is not there. */
export interface DeliveredAttachment extends AttachmentRef {
  /** The file the agent reads: its Inbox copy (a worker), or the stored file (an orchestrator). */
  path?: string;
  error?: string;
}

/** The attachment limits the page needs (config attachments). */
export interface AttachmentSettings {
  maxBytes: number;
  retentionDays: number;
  maxPerMessage: number;
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
  /** attachments: the files that came with it (docs/attachments.md), with where this agent's copy is. */
  | { seq: number; t: string; kind: 'user'; text: string; from: 'human' | 'orchestrator' | 'system'; uuid?: string; images?: ImageRef[]; attachments?: DeliveredAttachment[]; requestedBy?: Requester }
  /** images: the files it shows (shared/imagePaths.ts), kept once copied, so they outlive their folder. */
  | { seq: number; t: string; kind: 'assistant'; text: string; images?: ImageRef[] }
  | { seq: number; t: string; kind: 'thinking'; text: string }
  | { seq: number; t: string; kind: 'tool_use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string | null }
  | { seq: number; t: string; kind: 'tool_result'; toolUseId: string; isError: boolean; text: string; images?: ImageRef[] }
  | { seq: number; t: string; kind: 'result'; ok: boolean; text: string; costUsd: number; turns: number; durationMs: number; answers?: string[]; usage?: TurnUsage }
  | { seq: number; t: string; kind: 'system'; text: string }
  | { seq: number; t: string; kind: 'error'; text: string }
  /** decidedBy: the person who answered it in the portal (w891). */
  | { seq: number; t: string; kind: 'permission'; requestId: string; toolName: string; input: unknown; reason?: string; decision?: 'allow' | 'deny'; decidedBy?: Requester };

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

/** The portal's own host's load (its limits went with its own sandbox pool, w510). */
export type SystemStats = HostStats;

/**
 * Every Unity editor on a machine against its limit, as its daemon counts them (w469, machine/unitySlots.ts): all
 * top-level Unity processes, whoever started them, and the launches waiting for a slot or holding one.
 */
export interface UnitySlotsReport {
  /** max_unity; absent: no limit there (counted only). */
  limit?: number;
  /** Slots in use: running editors and batch runs, and slots granted whose Unity has not started yet. */
  used: number;
  /** w1962: of `used`, sandbox editors whose start is queued in the bench queue or booting (no Unity yet); absent: none, or a daemon before w1962. */
  starting?: number;
  interactive: number;
  batch: number;
  /** Of those, started outside the slot gate and not a sandbox's or the main clone's editor. */
  outside: number;
  /** Built game players running (not counted). */
  players: number;
  /**
   * Each game player with its owner and age (w1196, machine/leftovers.ts): `live` while its worker runs, `stopped` once it
   * has stopped (it ends `endsInMin` from now), `orphan` with no owner (it ends too), `held` with no session named but a
   * live starter, slot lease or sandbox worker. Absent from a daemon before w1196.
   */
  playerList?: PlayerSeen[];
  /** Other processes of stopped workers still here, ending within their grace (w1197). */
  leftoverProcesses?: number;
  overLimit: boolean;
  ramPct?: number;
  /** New launches wait at or above this RAM use. */
  ramLimitPct: number;
  /** w1949: `session`, the worker that ran it (FF_SESSION_ID), and `position` in the queue (1 first), from a daemon since w1949. */
  waiting: { label: string; count: number; holder: string; since: string; why: string; session?: string; position?: number }[];
  granted: { label: string; count: number; holder: string; since: string }[];
  at: string;
}

/** One game player as its machine's daemon saw it (UnitySlotsReport.playerList, w1196). */
export interface PlayerSeen {
  pid: number;
  /** Its player slot folder ("slot1-1"), when it runs from one. */
  slot?: string;
  /** The worker session that started it. */
  session?: string;
  sandbox?: string;
  ageMin?: number;
  owner: 'live' | 'stopped' | 'orphan' | 'held';
  endsInMin?: number;
}

/** A machine's load, as its daemon last reported it (protocol 4+); not kept in state.json. */
export interface MachineStats extends HostStats {
  /** When the portal received it. */
  at: string;
  /** Its Unity editors against max_unity (w469); absent from a daemon before it. */
  unity?: UnitySlotsReport;
  /** Its bench lock while a timed run holds it (w1600, machine/benchLock.ts); absent: free, or a daemon before it. */
  benchLock?: BenchLock;
  /** The timed legs in its bench queue, running or waiting (w1628, machine/benchLock.ts readBenchQueue); absent: none. */
  benchQueue?: BenchQueueReport;
  /** Its bench queue's mode, holders and waiters now (w1835, machine/benchState.ts); absent: a daemon before it. */
  bench?: BenchState;
  /** A person plays Final Factory there now, or its grace after runs (w1894, machine/personPlay.ts); absent: nobody. */
  personPlay?: PersonPlayReport;
}

/**
 * A person playing Final Factory on a machine (w1894, machine/personPlay.ts), as its daemon reports it: who (config
 * machines.personPlay.who), the game's pids (empty once it closed), since when, and once it closed when the grace ends; what
 * the turn did for them. The portal holds the machine meanwhile (Agents.placement(), server/personPlay.ts).
 */
export interface PersonPlayReport {
  who: string;
  pids: number[];
  since: string;
  until?: string;
  graceMinutes: number;
  editorsClosed: number;
  playersAsked: number;
  buildsLowered: number;
}

/**
 * The timed (exclusive) legs in a machine's bench queue (w1628): `timed` running or waiting, `first` the oldest one's
 * "what". lothsahn, 2026-10-20: "Yes, let's make the change you recommend to move things off when there are timed runs":
 * a release build goes to another build computer while one is there (server/placement.ts, server/buildPlans.ts).
 */
/**
 * A worker's place in its machine's bench queue by priority (w1628). lothsahn, 2026-10-20: "Yes, the queue should first
 * sort by priority, using the logic the worker is working on within each priority group": the highest priority of its
 * open requests, and those requests.
 */
export interface BenchPriority {
  priority: WorkPriority;
  requests: string[];
  /**
   * The work the bench queue never pre-empts (w1832; lothsahn: "Let's avoid preempting urgent release builds and the
   * nightly"): `release`, the urgent release lane's builder (BuildPlans.releaseBuilder); `nightly`, the worker of the
   * scheduled nightly run (a request filed by the portal's nightly schedule, source kind nightly-run). Set by the portal
   * only: the game repo's bench_queue.py reads it from priorities.json, keyed by the session a ticket carries
   * (FF_SESSION_ID, or FF_BENCH_SESSION for the nightly), so a worker has no flag to mark its own job; only a ticket
   * taken under another session's id would carry that session's mark.
   */
  exempt?: 'release' | 'nightly';
  /** w1962 (machine/benchRaise.ts, the daemon only): a session raised to the top while its shared ticket `raisedFor`,
   * which an exclusive turn has passed, waits; `raisedFrom` is its own priority. bench_queue.py reads only `priority`. */
  raisedFrom?: WorkPriority;
  raisedFor?: string;
  /** w1969: the worker's last timed_place verdict while it holds; the guard lets its exclusive timing tickets through only on "here". */
  timed?: TimedVerdict;
  /**
   * w1984 (server/agents.ts benchAway): its worker is away from this machine's queue, so its waiting tickets hold
   * nobody back (bench_queue.py parks them, and queues them again at the back once the mark goes).
   */
  away?: BenchAway;
}

/** Why a worker's waiting bench tickets are parked (w1984); `exclusive_only`: only its timed (exclusive) tickets. */
export interface BenchAway {
  why: string;
  exclusive_only?: true;
}

/** What timed_place decided for a worker's timed leg (w1969, server/timedAsk.ts). */
export type TimedVerdictKind = 'here' | 'elsewhere';

/** A worker's timed_place verdict as its machine keeps it (w1969, BenchPriority.timed). */
export interface TimedVerdict {
  verdict: TimedVerdictKind;
  why: string;
  /** ISO time it holds until. */
  until: string;
  /** elsewhere: the request its leg was filed as, or the play-only computer of its timed_run. */
  leg?: string;
  timedRun?: string;
  /**
   * here: given as w2048's big-computer fallback (every small computer unavailable then), on this platform. Such a "here" is
   * withdrawn once a small computer that takes timed runs is idle (w2277, Agents.withdrawStaleTimedHere).
   */
  fallback?: boolean;
  platform?: string;
}

/**
 * Whether a machine's workers ask before an exclusive timing ticket (w1969, server/timedAsk.ts timedAskMark), as the
 * portal sends it with the bench priorities: a big computer asks, a small one does not.
 */
export interface TimedAskMark {
  required: boolean;
  why: string;
}

/**
 * A machine that takes no timed runs (w1861, Machine.noTimedRuns), as the portal sends it with the bench priorities: the
 * reason, and the machines that take them (online first), for the bench queue's refusal to name.
 */
export interface NoTimedRuns {
  why: string;
  elsewhere: string[];
}

/**
 * A holder's turn warning (w1832): the game repo's bench_queue.py set a deadline on its ticket because another worker
 * waits, and warned it five minutes before (the ticket's limit.json). The daemon reports each with its stats; the portal
 * messages the worker once per deadline (server/benchWarnings.ts).
 */
export interface BenchWarning {
  ticket: string;
  session: string;
  mode: 'shared' | 'exclusive';
  what: string;
  /** When its turn ends (epoch ms), and why (bench_queue.py's words). */
  deadline: number;
  why: string;
  /** Set by an urgent release taking the machine (it cannot be waited out). */
  release?: boolean;
  /** Its checkout's state when the daemon read it: uncommitted files, commits not pushed (undefined: no upstream). */
  dirty?: number;
  unpushed?: number;
  branch?: string;
}

/**
 * One ticket in a machine's bench queue, as the machine view shows it (w1835): who took it, for what, and its times. `since`
 * is when it was granted (a holder) or taken (a waiter); `until` a holder's hold bound (bench_queue.py max_min).
 */
export interface BenchTicketGlance {
  ticket: string;
  mode: 'shared' | 'exclusive';
  what: string;
  session?: string;
  requests?: string[];
  host?: string;
  sandbox?: string;
  since?: string;
  /** When its turn ends: the deadline a waiter set (`deadline`), else an exclusive ticket's turn (granted + `turnMin`, which
   * it outlasts while nobody waits); none for an exempt ticket or a shared one nothing waits behind (w1832). */
  until?: string;
  /** An exclusive ticket's turn in minutes (bench_queue.py turn_min, 30; a ticket from an older copy keeps its max_min). */
  turnMin?: number;
  /** The deadline a waiter set on its turn (limit.json, w1832), when it was warned, why, and whether an urgent release set it. */
  deadline?: string;
  warned?: string;
  why?: string;
  release?: boolean;
  /** Work FF Factory exempts from the turn limits (priorities.json, w1832): the urgent release lane's builder or the nightly's worker. */
  exempt?: 'release' | 'nightly';
  /** The urgent release lane's own ticket (it pre-empts the holders, w1656). */
  preempt?: boolean;
  /**
   * w1860: it keeps the lock until it lets go, because only lower-priority work waits behind it (bench_queue.py keep.json;
   * a shared group's priority is its highest running ticket's): since when, why, and the holder's (or group's) priority.
   * No `until` then: no turn end applies until a ticket of its priority or higher waits.
   */
  keeps?: { since: string; why?: string; priority?: string };
}

/**
 * What a machine's bench queue does now (w1835; lothsahn, 2026-10-23: "Please display on FF factory's webpage for the
 * machine view whether each machine is in shared or exclusive lock mode"): `exclusive` while a timed leg (or an old-style
 * bench lock, `legacy`) holds it, `shared` while only shared tickets run (builds, compiles, editor boots), else `free`.
 * `running` lists the holders (at most BENCH_STATE_MAX_RUNNING; `runningCount` counts them all), `waiting` the tickets not
 * granted yet, and `nextExclusive` the first timed leg among them in the queue's own order, with `ahead` waiters before it.
 */
export interface BenchState {
  mode: 'free' | 'shared' | 'exclusive';
  running: BenchTicketGlance[];
  runningCount: number;
  waiting: number;
  nextExclusive?: BenchTicketGlance & { ahead: number };
  /**
   * w1949: the tickets not granted yet, in the queue's own order (a waiting urgent release first), each with `ahead` waiters
   * before it; at most BENCH_STATE_MAX_WAITERS. The ledger shows a request Blocked on the lock while its worker's ticket is
   * here (shared/queueWaits.ts). Absent while nothing waits, and from a daemon before w1949.
   */
  waiters?: (BenchTicketGlance & { ahead: number })[];
  /** An old-style lock's owner line (quiet_gate.sh before w1615): no ticket, so no request or worker. */
  legacy?: { owner: string; since: string };
  /** A machine FF Factory runs one worker on (priorities.json single_worker): no turn limits, warnings or pre-emptions. */
  singleWorker?: boolean;
  /** What an exclusive turn closed for its run (w1829, machine/benchTurn.ts): the sandboxes whose editors it closed and the
   * game players it asked to quit. */
  closed?: { editors: string[]; players: number };
  /**
   * w1923: timing calls of the last hour made outside an exclusive ticket (the queue's timing.jsonl: refused, or let
   * through by a `// ff-not-timing:` comment), newest first, at most BENCH_STATE_MAX_UNTIMED; `untimedCount` counts them all.
   */
  untimed?: UntimedTiming[];
  untimedCount?: number;
}

/** One timing call outside an exclusive ticket (w1923; the game repo's scripts/bench/timing_gate.py log). */
export interface UntimedTiming {
  at: string;
  via: string;
  outcome: 'refused' | 'not-timing';
  session?: string;
  sandbox?: string;
  markers?: string[];
  why?: string;
}

export interface BenchQueueReport {
  timed: number;
  first?: string;
}

/**
 * A machine's bench lock as its daemon reads it (w1600, machine/benchLock.ts): the owner line the game repo's
 * scripts/bench/quiet_gate.sh wrote (`<host> pid <pid> <user> <time> <what> (<dir>)`), and since when (the lock's mtime).
 */
export interface BenchLock {
  owner: string;
  since: string;
}

/**
 * Whether the run holding `lock` runs in the folder `dir` or below it (w1607): the owner line ends with the run's folder,
 * `($PWD)`, which Git Bash writes as /f/ffw/... for F:\ffw\.... Compared without case and slash differences.
 */
export function benchLockIn(lock: BenchLock | undefined, dir: string): boolean {
  const ran = /\(([^()]+)\)\s*$/.exec(lock?.owner ?? '')?.[1];
  if (!ran) return false;
  const key = (p: string) =>
    p
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/([a-z])\//i, '$1:/')
      .replace(/\/+$/, '')
      .toLowerCase();
  const [a, b] = [key(ran), key(dir)];
  return !!b && (a === b || a.startsWith(`${b}/`));
}

// ---- machines (docs/machines.md) ----

export type MachineStatus = 'deploying' | 'ready' | 'error';

/** What a machine runs: a Mac (LaunchAgent), a Windows PC (Task Scheduler) or a Linux PC (a systemd user service), docs/machines.md. */
export type MachinePlatform = 'darwin' | 'win32' | 'linux';

/** "Mac", "Windows PC" or "Linux PC", for sentences about a machine (a record from before platforms is a Mac). */
export const platformNoun = (p: MachinePlatform | undefined) => (p === 'win32' ? 'Windows PC' : p === 'linux' ? 'Linux PC' : 'Mac');

/**
 * A machine's kind, for people. A record waiting for its install (a join code, add_machine worker_install) has no platform
 * until its PC tells the portal, so it is not called a Mac (w1603: desktop-coosego, a Windows PC, showed as a Mac).
 */
export const machineKind = (m: { platform?: MachinePlatform; awaitingInstall?: string }) => (!m.platform && m.awaitingInstall ? 'new machine, its system not known until it joins' : platformNoun(m.platform));

/** A Node `process.platform` as a machine platform (anything that is neither Windows nor Linux is taken for a Mac). */
export const machinePlatformOf = (p: string): MachinePlatform => (p === 'win32' ? 'win32' : p === 'linux' ? 'linux' : 'darwin');

/** A machine's daemon folder: its app_dir, else <home>/.ff-factory. */
export const appDirOf = (m: Pick<Machine, 'appDir' | 'home'>) => m.appDir || `${m.home}/.ff-factory`;

/** A machine's pause settings (w1532), kept by its daemon in pause.json and changed from its tray app. Times are its local time. */
export interface MachinePauseSettings {
  /** Work runs only inside the window: it unpauses at `start` and pauses at `end` ("HH:MM"; an end not after the start is the next day). `days`: 0 Sunday to 6 Saturday, the day a window starts. */
  schedule: { enabled: boolean; start: string; end: string; days: number[] };
  /** A key or click no program injected pauses it until `idleMinutes` pass without one. */
  activity: { enabled: boolean; idleMinutes: number };
}

/** A machine's pause state as its daemon reports it (w1532, machine/pauseRules.ts). */
export interface MachinePause {
  paused: boolean;
  /** Why: the tray (manual), the schedule, or a person's input (activity). Running without a reason: no schedule set. */
  reason?: 'manual' | 'schedule' | 'activity';
  /** One line for people: "someone is using this PC: work resumes 90 min after the last key or click (at 15:40 …)". */
  detail: string;
  /** When this state began, and when it changes by itself next (ISO). */
  since?: string;
  until?: string;
  settings?: MachinePauseSettings;
  /** The tray app: "running" in the logged-on session, or why it is not. */
  tray?: string;
  /** When the daemon reported it. */
  at?: string;
}

export interface Machine {
  /** Short name, e.g. "m5"; also the MCP/label id. Lower-case (MACHINE_ID). */
  id: string;
  /** The id as it was typed when it has capitals, e.g. "LothDesktop" for lothdesktop: shown in its place. */
  name?: string;
  /** ssh host alias this host deploys to (user@host once its worker installer registered its ssh, w568). */
  host: string;
  /**
   * What its worker installer registered for the portal's ssh (w568, server/machineSsh.ts): the user and name the
   * portal reaches it by, and its sshd's host keys, pinned in the portal's known_hosts2.
   */
  ssh?: { user: string; host: string; hostKeys: string[]; at: string };
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
  /**
   * Its owner paused FF Factory work on it (w1532, docs/machines.md "Pausing a machine"): from its tray app, its schedule or
   * a person's input there, as its daemon last reported. While `paused`, it counts as held (placement.hold) and its workers
   * hand their requests back. Absent: a daemon before w1532 (never paused).
   */
  pause?: MachinePause;
  /**
   * daemon.json settings its redeploys over ssh write, kept from when it was the portal's own host (convert_machine,
   * w466): the MCP-for-Unity server and the idle-editor stop it had from the portal's config.
   */
  daemonExtras?: { unityMcpServer?: { command: string; args: string[]; env?: Record<string, string> }; sandboxIdleStopMinutes?: number; hostGuard?: MachineGuardSettings };
  /** Its daemon runs the host guard (w466, machine/hostGuard.ts) and this is its last state: the sandbox drive, disk levels, what waits. */
  guard?: Pick<HostHealth, 'checkedAt' | 'sandboxRoot' | 'level' | 'detail' | 'blocked'>;
  /**
   * Its daemon was sent to another portal URL (relocate_machines, w466): this portal does not redeploy it while it is
   * away (that would pull it back). Cleared when it says hello here again.
   */
  relocatedTo?: { url: string; at: string };
  /** The machine's main Final Factory clone: where its agents work. */
  repoPath: string;
  home: string;
  /**
   * The worker root it was installed in (w513, scripts/worker; docs/worker-install.md): one folder holding its daemon,
   * clone, sandboxes, player slots, nightly lab and temp. Reported in the daemon's hello; a redeploy keeps it.
   */
  root?: string;
  /**
   * When add_machine worker_install made this record (w676): a new machine waiting for its worker installer, which
   * runs on the machine itself. Never deployed over ssh while set; its daemon's first hello clears it.
   */
  awaitingInstall?: string;
  /** Its folders before it moved into a root (w513 migration), restored if its daemon comes back without one (a rollback). */
  preRoot?: { appDir?: string; repoPath: string; tempDir?: string; sandboxRoot?: string; librarySeed?: string };
  /** The daemon's folder (code, logs, agents, daemon.json) when not the default <home>/.ff-factory (add_machine app_dir). */
  appDir?: string;
  /** A folder holding Unity editor versions (<root>/<version>/...), searched before Unity Hub's defaults. */
  unityEditorRoot?: string;
  /** The Unity editor executable itself (Unity.exe, or .../Unity.app/Contents/MacOS/Unity): wins over any lookup. */
  unityPath?: string;
  /** Scratch folder for its agents (TMP, TEMP and TMPDIR of their processes); unset: the system's. */
  tempDir?: string;
  /** The folder its sandboxes (git worktrees of repoPath) live in; unset: the machine has no sandboxes. */
  sandboxRoot?: string;
  /** Sandboxes that may exist there at once (default 3 once sandboxRoot is set). */
  maxSandboxes?: number;
  /** Agents that may run at once in one of its sandboxes (default 2). */
  maxAgentsPerSandbox?: number;
  /** Unity editors of its sandboxes that may run at once (default 2; the main clone's editor is not counted). */
  maxUnity?: number;
  /** Its disk guard: below this many GB free on the sandbox volume, no new sandboxes or sandbox editors (default 15, DISK_WARN_GB_DEFAULT). */
  diskWarnGB?: number;
  /** Below this, idle sandbox editors are stopped and busy sandbox agents asked to checkpoint (default 10, DISK_CRITICAL_GB_DEFAULT). */
  diskCriticalGB?: number;
  /** Its sandboxes, as its daemon last reported them (portal-owned: purpose and sessionIds). */
  sandboxes?: MachineSandbox[];
  /**
   * The portal's own host (docs/beast-machine.md): its daemon runs on this computer, is deployed and controlled
   * without ssh, and takes over the host's sandboxes. Its unset settings follow the portal's config (sandboxRoot,
   * limits, protectedPaths, librarySeed, the workers' Claude account). At most one machine is local.
   */
  local?: boolean;
  /** Live agents that may run at once across all its sandboxes (unset: only max_agents_per_sandbox limits them). */
  maxSandboxAgents?: number;
  /** Folders its agents must never touch and its clean-up never deletes, besides its main clone and daemon folder (e.g. a live game). */
  protectedPaths?: string[];
  /** A warm Library folder new sandboxes are seeded from first (else the main clone's, else a sandbox's). */
  librarySeed?: string;
  /** How the seed is copied on Windows: "clone" (Copy-Item, which block-clones on a ReFS Dev Drive) or "robocopy" (the default). */
  librarySeedCopy?: 'robocopy' | 'clone';
  /** Room a Library copy needs, in GB, on top of disk_warn_gb (default 30). */
  librarySeedGB?: number;
  /** Its sandbox editors run at below-normal priority, so a game the user plays there wins every contest for the CPU. */
  unityBelowNormal?: boolean;
  /**
   * Why it takes no timed runs (w1861, add_machine no_timed_runs; server/machines.ts noTimedRunsOf): its bench queue refuses
   * a timing ticket and placement sends timed work elsewhere. Unset: the default (NO_TIMED_RUNS: m5); "" clears it.
   */
  noTimedRuns?: string;
  /**
   * Why it is play-only (w1946, add_machine play_only; docs/machines.md "A play-only timing machine"): it takes no workers,
   * no standing agents and no sandbox, and runs the timed A/B legs other computers build (timed_run, server/timedRuns.ts)
   * under its own exclusive bench ticket. Unset or "": an ordinary computer.
   */
  playOnly?: string;
  /** Portal URL the daemon connects to. */
  portalUrl: string;
  sessionIds: string[];
  /** Reported by the daemon. */
  info?: { hostname: string; os: string; node: string; claude?: string; daemon: string; platform?: MachinePlatform };
  /** Its own gh login as its daemon last read it (w1463, shared/ghLogin.ts): the account and scope names, never the token. */
  gh?: GhLogin;
  git?: GitStatus;
  /** The daemon's last clean-up pass (server/cleanup.ts). */
  lastCleanup?: CleanupSummary;
  createdAt: string;
}

/**
 * A sandbox on a machine (docs/machines.md, "Machine sandboxes"): a git worktree of the machine's main clone in its
 * sandboxRoot, on its own branch, with its own Library and Unity editor. The daemon owns the folder, git and Unity
 * state; the portal owns purpose and sessionIds.
 */
export interface MachineSandbox {
  /** The folder name, also the Unity project and MCP instance name ("<id>@<hash>"). Addressed as "<machine>/<id>". */
  id: string;
  branch: string;
  base: string;
  path: string;
  purpose: string;
  status: SandboxStatus;
  statusDetail?: string;
  createdAt: string;
  unity: MachineSandboxUnity;
  sessionIds: string[];
  git?: GitStatus;
  /**
   * Old agent hosts whose process trees still run here while the daemon stops them (w799): the sandbox is not free
   * until they are gone. Sent by daemons from w799 on; an older portal ignores it.
   */
  lingering?: { sessionId: string; pid: number; since: string }[];
  /**
   * Its editor was closed because its Live view sat idle (w1746, docs/live-view.md "Idle editors close"): when, after how
   * many idle minutes, and the scenes saved first. It starts again at the next message to a worker there. Cleared when the
   * editor starts by any path. Sent by daemons from w1746 on; an older portal ignores it.
   */
  idleClosed?: MachineSandboxIdleClosed;
  /**
   * Free to take, as list_sandboxes marks it FREE (server/agents.ts free(): no live agent, none spoken for or held, no
   * bench lock or lingering host). Set by the portal on what it sends a page (w2067, server/index.ts machineView), never
   * by a daemon and never saved: the dashboard counts in-use sandboxes from it.
   */
  free?: boolean;
}

export interface MachineSandboxIdleClosed {
  at: string;
  minutes: number;
  saved?: string[];
}

export interface MachineSandboxUnity {
  state: 'stopped' | 'starting' | 'running' | 'crashed';
  pid?: number;
  detail?: string;
  logPath?: string;
}

/**
 * The disk guard's defaults, in GB free on the sandbox volume (w628, measured on BEAST 2026-10-07 in a warm sandbox):
 * opening the editor and force-reimporting every script grew its Library by under 10 MB, a development player build
 * wrote 2.1 GB of output and 0.25 GB of Library, a release build 2.0 GB of output and 2.5 GB of Temp (gone when the
 * editor closes), and a whole day's sandbox session (a develop merge, Burst recompiles, one build) at most 7.6 GB. So
 * an editor needs about 10 GB on top of the 10 GB floor, where idle editors stop and busy agents checkpoint. Since w1951
 * (lothsahn, 2026-10-23: "Let's set 10,15,20 as defaults in code for all new installs"): critical 10, warn 15, and the
 * clean-up soft threshold 20 above them (CLEANUP_SOFT_GB_DEFAULT), so a machine cleans up before its guard refuses work.
 */
export const DISK_WARN_GB_DEFAULT = 15;
export const DISK_CRITICAL_GB_DEFAULT = 10;
/** A machine's clean-up soft threshold (config machines.cleanup.softFreeGB) when config names none: 20 GB (w1951; it was 80). */
export const CLEANUP_SOFT_GB_DEFAULT = 20;

/** The pool settings the portal sends a daemon (welcome) and a deploy writes into daemon.json. */
export interface SandboxPoolSettings {
  root: string;
  maxSandboxes: number;
  maxAgentsPerSandbox: number;
  maxUnity: number;
  diskWarnGB: number;
  diskCriticalGB: number;
  /** Protocol 6 (docs/beast-machine.md): live agents across all sandboxes; unset: no total. */
  maxAgents?: number;
  /** Protocol 6: the Library new sandboxes are seeded from first. */
  librarySeed?: string;
  librarySeedCopy?: 'robocopy' | 'clone';
  librarySeedGB?: number;
  /** Protocol 6: start sandbox editors at below-normal priority. */
  belowNormal?: boolean;
  /** Protocol 6: folders clean-up never deletes (a live game), besides the clone, the sandboxes and the daemon's folder. */
  protectedPaths?: string[];
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
  /** Protocol 2: the Discord thread (or reply-chain root message) the conversation lives in. */
  threadId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One FFBox conversation as FF Factory shows it (w426): FFBox's own page is on Lothsahn's network only, so the web UI
 * renders the connector's `conversation` answer (docs/ffbox-connector-contract.md, "Read-only queries"). Every field is
 * checked and every text cleaned on the server; all of it is FFBox data, players' words included, shown as plain text.
 */
export interface ProviderConversationView {
  id: string;
  /** Answered by FFBox just now; false: the last answer kept for this conversation (`receivedAt`), or none (`error`). */
  live: boolean;
  /** When FFBox wrote the answer, and when FF Factory got it. */
  at?: string;
  receivedAt?: string;
  /** Why there is no live answer (FFBox's error code), with its own words when it gave them. */
  error?: string;
  reason?: string;
  /** What the conversation list holds for it (title, state, PR, and `url`, FFBox's page on Lothsahn's network). */
  summary?: ProviderConversation;
  conversation?: { title?: string; state?: string; kind?: string; agentClass?: string; branch?: string; verdict?: string; costUsd?: number; discordLink?: string; reportIds?: string[]; ledger?: string; updatedAt?: string };
  /** Newest first. */
  turns: ProviderTurn[];
  page?: { offset: number; limit: number; total: number };
}

export interface ProviderTurn {
  id?: number;
  seq?: number;
  trigger?: string;
  status?: string;
  requester?: 'operator' | 'player';
  venue?: 'public' | 'private';
  queuedAt?: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  /** The turn's own last words. */
  summary?: string;
  runs: { state?: string; costUsd?: number; numTurns?: number; agentSecs?: number; branch?: string; pushed?: boolean; pr?: number; noBranchReason?: string; verification?: { ran?: boolean; compiled?: boolean; testsRun?: number; testsPassed?: number; testsFailed?: number } }[];
  /** The messages it answered: who as a role (a player's display name at most), never an id. */
  messages: { at?: string; from?: 'operator' | 'player' | 'bot'; name?: string; text?: string }[];
  /** What FFBox posted; a held or refused reply has a status and no text. */
  replies: { at?: string; status?: string; text?: string }[];
}

/** One report ffintake filed: only the facts ffintake computed or pattern-checked; never the report's own text. */
export interface ProviderIntakeEvent {
  reportId: string;
  kind: 'crash' | 'desync' | 'hang';
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

/** FFBox's load, memory and disks, as its connector pushes them (docs/ffbox-connector-contract.md, "metrics"). */
export interface ProviderMetrics {
  /** When FFBox measured them. */
  at: string;
  /** When the portal received them: stale after shared/providerMetrics.ts METRICS_STALE_MS. */
  receivedAt: string;
  cpu?: { load1: number; load5: number; load15: number; cores: number };
  mem?: { totalBytes: number; usedBytes: number; swapTotalBytes?: number; swapUsedBytes?: number };
  /** By role (root, state, cache, ...; joined with "+" where they share a filesystem), never by path. */
  disks: { role: string; totalBytes: number; freeBytes: number }[];
}

/** One checkout FFBox's self-updater pulls (ffbox itself, the agents checkout), as its last pass found it. */
export interface ProviderUpdaterCheckout {
  /** "ffbox", "agents", or another short name. */
  name: string;
  /** ok, ahead, diverged, dirty, failed, missing, disabled, or a newer word. FFBox's `ok` is what decides health. */
  status: string;
  ok: boolean;
  path?: string;
  /** The checkout's HEAD and origin's commit, when known. */
  local?: string;
  origin?: string;
  /** The updater's own words, e.g. "diverged from origin/master; not taking its commits. Fix it by hand". */
  message?: string;
  /** When this status began. */
  since?: string;
  checkedAt?: string;
  /** The last pass that found it ok, and the last that moved it to new commits. */
  okAt?: string;
  updatedAt?: string;
}

/** FFBox's self-updater (docs/ffbox-connector-contract.md, "updater"); shared/updaterHealth.ts decides red or green. */
export interface ProviderUpdater {
  /** When the last pass ended. */
  at: string;
  /** The timer's interval (180 on FFBox): a stall is UPDATER_STALE_INTERVALS of these with no pass. */
  intervalSecs?: number;
  ok: boolean;
  /** Since when `ok` has been what it is. */
  since?: string;
  /** Set while a pass is running, from its start. */
  runningSince?: string;
  checkouts: ProviderUpdaterCheckout[];
  /** The WARNING and ERROR lines of the last pass. */
  warnings: string[];
  /** When the portal received it. */
  receivedAt: string;
}

/**
 * FFBox's operators' dev requests, from its `status` answer's `dev_requests` block (docs/ffbox-connector-contract.md,
 * "status"; shared/devRequestsHealth.ts): its last 24 hours of operators' ffdev turns. ok false: the newest one it
 * decided fell back and ran on FFBox instead of coming here as a dev request.
 */
export interface ProviderDevRequests {
  mode: 'prefer' | 'off';
  ok: boolean;
  windowHours?: number;
  /** Handed to this portal; of those, taken (filed or delivered); run on FFBox after a failed hand-over; not eligible by
   * design; finished without a run by a linked thread's block (somebody else's message there). */
  handed?: number;
  taken?: number;
  fallback?: number;
  skipped?: number;
  blocked?: number;
  /** The newest fallback: when, FFBox's conversation and turn, and its error code (no_ack, connector_not_running, ...). */
  lastFallback?: { at?: string; conversation?: number; turn?: number; error?: string };
  /** When the portal received the status answer it came in. */
  receivedAt: string;
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
  /** From the hello. protocol is information only, and absent when the hello did not say one. */
  connector?: { version: string; commit?: string; protocol?: number };
  /** The provider's own page, for links. */
  web?: string;
  /** What the connector said it takes (hello.accepts, e.g. "board", "query"): information only. */
  accepts?: string[];
  /** The read-only queries the connector said it answers (hello.queries): information only, every query is asked. */
  queries?: string[];
  /** The address the last connection that said hello came from. */
  remote?: string;
  /** The first 12 hex of that connection's token SHA-256 (what FFBox's `fffconnector.py set-token` prints). */
  tokenFingerprint?: string;
  /** ffwatch on FFBox, as the last capacity said: up false means down or restarting since `at`. Absent when unknown. */
  ffwatch?: { up: boolean; at?: string; receivedAt: string };
  /** The last query sent to FFBox and how it came back (error: FFBox's code, or timeout / disconnected). */
  lastQuery?: { what: string; ok: boolean; error?: string; at: string };
  /** How the last link closed: the code and reason sent, by whom (portal: FF Factory closed it). */
  lastClose?: { code: number; reason: string; by: 'portal' | 'connector'; at: string };
  /** FFBox's load, memory and disks, as last pushed (shared/providerMetrics.ts); absent from a connector that sends none. */
  metrics?: ProviderMetrics;
  /** FFBox's self-updater as last pushed (shared/updaterHealth.ts); absent from a connector from before w265. */
  updater?: ProviderUpdater;
  /** FFBox's dev requests, from its last status answer (asked every few minutes while connected); absent until one says. */
  devRequests?: ProviderDevRequests;
  capacity?: ProviderCapacity;
  counts: { conversations: number; active: number; intake: number; intake24h: number };
  lastIntakeAt?: string;
}

/** FFBox's intake reports grouped by their coarse signature (shared/intake.ts, docs/ffbox-integration.md section 6). */
export interface IntakeSignature {
  /** `desync:<major.minor.patch>:<diverged surfaces>`, `crash:<major.minor.patch>` or `hang:<major.minor.patch>` (crashes and hangs get a real signature in phase 6). */
  signature: string;
  kind: 'crash' | 'desync' | 'hang';
  versionLine: string;
  surfaces?: string;
  reports: number;
  /** Distinct desync events (the report's group): every peer of one desync is one event. */
  events: number;
  senders: number;
  /** A host and a client report of one event. */
  pair: boolean;
  /** Clears the trust bar: 2+ distinct senders, or a host and client pair. Never for crashes yet. */
  trusted: boolean;
  firstAt: string;
  lastAt: string;
  versions: string[];
  platforms: string[];
  /** Report ids, newest first (at most 20). */
  reportIds: string[];
}

export interface IntakeGroups {
  signatures: IntakeSignature[];
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
  pending?: {
    trigger: StandingRunTrigger;
    dueAt: string;
    deadline: string;
    text?: string;
    requestedBy?: Requester;
    /** w1126: its start was refused because its person's Claude pool is held: why, when it frees (if known), when to try again. */
    poolWait?: { why: string; next?: string; retryAt: string };
  };
  /** Runs on this machine instead of this host (its folder is then on that machine). */
  machineId?: string;
  /** File this agent's delegation requests into the ledger without the user's approval, within these limits (w527). */
  autoApprove?: AutoApprove;
  /**
   * The person it works for (w527): its delegations are filed in the ledger as their requests. Set when it is created;
   * absent on agents from before, which use the system payer (config systemPayer, else the owner).
   */
  owner?: Requester;
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
  /** Who it works for (StandingAgent.owner); create sets the person who made it when this is absent. */
  owner?: Requester;
}

/**
 * Auto-approval of a standing agent's delegation requests (docs/standing-agents.md, w527): within these limits a
 * request is filed in the ledger with no click, and the dispatcher queues and places it like any request. One that
 * spends money, publishes, changes settings or releases always waits for a person, whatever these say.
 */
export interface AutoApprove {
  enabled: boolean;
  maxPerRun: number;
  maxPerDay: number;
  /** The model and effort suggested to the dispatcher for its worker (it decides). */
  model: string;
  effort: EffortLevel;
}

/**
 * pending: waits for a person. approved: filed in the ledger as `workId` (by a person, or by the auto-approve rules).
 * rejected. expired: only on requests from before w527, whose auto-approval ran out while no free sandbox was found.
 */
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
  /**
   * The ledger request it was filed as, once approved (w527), or the one that already covered it (`repeat`). The
   * dispatcher queues, places and starts it; its status, workers and PRs are that request's.
   */
  workId?: string;
  /** It asked for work an open or recently finished request of the same agent already covers: not filed again. */
  repeat?: boolean;
  /** Before w527: where an approved request's worker ran, which the portal picked itself. */
  sandboxId?: string;
  machineId?: string;
  sessionId?: string;
  note?: string;
  /** Before w527: auto-approval queued waiting for a free target, or started. */
  auto?: 'queued' | 'started';
  autoApproved?: boolean;
  /** Before w527: when an auto-approved request waiting for a free target expired. */
  expiresAt?: string;
  /** The run it was filed in (the per-run limit). */
  runId?: string;
  model?: string;
  effort?: EffortLevel;
  /** When the delegated worker first finished a turn. */
  finishedAt?: string;
  /** What happened to it, oldest first: "10:02 queued: no free target", "10:05 started in sb2". */
  log?: string[];
  /** Who it is for: the agent's owner (w527; before, the person the run that filed it was for). */
  requestedBy?: Requester;
  /** The person who approved it; absent when auto-approved. */
  approvedBy?: Requester;
}

/** Facts about the host process itself, for the dashboard banner. */
export interface HostStatus {
  /** The server runs with administrator rights, so it refuses to start Unity editors. */
  elevated: boolean;
  /** Why it is still elevated and what fixes it. */
  elevatedWhy?: string;
  /** This portal is a dry run (FFSB_DRY_RUN=1, server/dryRun.ts): what it keeps off. */
  dryRun?: string;
  /** A restart is waiting for busy agents to finish (scripts/restart.ps1 or request_app_update). */
  drain?: DrainStatus;
  /** Disks, the sandbox drive, memory, and what the guard is doing about them (server/hostHealth.ts). */
  health?: HostHealth;
  /** The path from the internet through Funnel to this portal, as the FFBox host's watchdog reports it (server/pathHealth.ts). */
  pathHealth?: PathHealth;
  /** What the VM's unit watchdog (fff-health) did about critical systemd units (server/unitWatchdog.ts). */
  unitWatchdog?: UnitWatchdog;
  /** Claude token pools that need a person's eye, and the dispatcher's reserve in use (server/index.ts tokenWarnings, w739). */
  tokenWarnings?: TokenWarning[];
}

/** One banner about the Claude token pools. No token, only its last four characters. */
export interface TokenWarning {
  /** "pool:<person>" or "reserve:<credential>": a banner's identity, so a dismissed one returns when its text changes. */
  id: string;
  /**
   * exhausted: every token of the person is used up; held: every token is at a limit (new work waits); reserve: runs are
   * inside the dispatcher's buffer; ci-read: the portal's GitHub token cannot read CI on pull requests (w889); github-token:
   * a GitHub token lacks a required repository or permission, or nears its expiry (w904); github-rate-limit: GitHub is rate
   * limiting a token's account, which says nothing about the token's permissions (w1186).
   */
  kind: 'exhausted' | 'held' | 'reserve' | 'ci-read' | 'github-token' | 'github-rate-limit';
  /** The user id whose pool it is: only that person's pages show it (server/index.ts hostForUser). Absent: for everyone. */
  person?: string;
  /** The owners see it too, besides `person` (w904: a GitHub token that lacks a requirement). */
  owners?: boolean;
  text: string;
}

/** One layer of the path from the internet to the portal (deploy/vm/host/pathwatch.sh). */
export interface PathLayer {
  /** "ssh", "1" to "9", "disk", "clock", "loop", "ntfy". */
  id: string;
  /** "tailscaled", "Serve/Funnel route", "tailnet policy", ... */
  name: string;
  verdict: 'ok' | 'warn' | 'fail' | 'skip' | 'none';
  /** When it got this verdict (ISO). */
  since: string;
  checkedAt: string;
  /** The evidence: the log line. No secrets (the watchdog removes them). */
  line: string;
  /** Who must act, for a failure; empty otherwise. */
  who: string;
  /** The last repair the watchdog tried, and how it went. */
  repair: string;
}

/**
 * What the FFBox host's watchdog (fff-vm watch) found along the path from the internet through Tailscale Funnel to the
 * portal, handed to the portal in a file in the VM. The banner shows `problems` (failures nobody has fixed, or that a
 * repair did not fix); `warnings` are for system_status.
 */
export interface PathHealth {
  /** When the watchdog wrote it (ISO). */
  updatedAt: string;
  /** The host that watches. */
  host: string;
  /** The portal's Funnel name. */
  dns: string;
  /** No problem needs a person. */
  ok: boolean;
  problems: PathLayer[];
  warnings: PathLayer[];
  /** Set by the portal when the watchdog has not reported for this many minutes: what is shown may be old. */
  silentMinutes?: number;
}

/** One critical systemd unit the VM's watchdog keeps up (fff-health, every 30 s). */
export interface UnitWatchdogUnit {
  unit: string;
  /** systemd's ActiveState: "active", "inactive", "failed", "activating", ... */
  active: string;
  /** systemd's unit file state: "enabled", "disabled", "static", "masked", ... */
  enabled: string;
  /**
   * ok: healthy. backoff: failing, waiting before the next restart (nextTryAt). gave-up: restarted `attempts` times
   * without staying up, the watchdog stopped trying and a person must act. paused: restarts switched off on purpose.
   * held: the portal is held until reboot on purpose (fffctl prepare-shutdown): not a problem. unknown: a state this
   * portal does not know.
   */
  state: 'ok' | 'backoff' | 'gave-up' | 'paused' | 'held' | 'unknown';
  attempts: number;
  /** When the next restart is tried (ISO), or empty. */
  nextTryAt: string;
}

/** One thing the VM's watchdog did to a unit. */
export interface UnitWatchdogEvent {
  /** ISO. */
  at: string;
  unit: string;
  action: 'restart' | 'enable' | 'gave-up';
  /** Why: "inactive (dead) while it should be active". */
  why: string;
  attempt: number;
  /** The action worked. */
  ok: boolean;
}

/**
 * What the VM's unit watchdog (fff-health) reports in <dataDir>/unit-watchdog.json. On HostStatus the server sends only
 * the units that are not ok or held and the events of the last 24 hours.
 */
export interface UnitWatchdog {
  /** When the watchdog wrote it (ISO). */
  updatedAt: string;
  host: string;
  units: UnitWatchdogUnit[];
  /** Newest last. */
  events: UnitWatchdogEvent[];
  /** Set by the portal when the watchdog has not written for this many minutes: the units shown may be old. */
  silentMinutes?: number;
}

export type DiskLevel = 'ok' | 'warn' | 'critical';

export interface HostHealth {
  checkedAt: string;
  /** Each watched volume (the sandbox root's and config hostDiskPaths'), with its guard level. */
  disks: { path: string; freeBytes?: number; totalBytes?: number; level: DiskLevel; growthBytes?: number }[];
  /** The worst disk level. */
  level: DiskLevel;
  /** The sandbox drive: there, gone, being reattached, or given up on (see detail). */
  sandboxRoot: 'ok' | 'missing' | 'remounting' | 'failed';
  detail?: string;
  memFreeBytes: number;
  memTotalBytes: number;
  /** Why new editors and new agent processes are refused right now, if they are. */
  blocked?: string;
  /** The last clean-up pass (server/cleanup.ts). */
  lastCleanup?: CleanupSummary;
  /** The orphan headless-browser reaper's last pass that found something (server/reaper.ts). */
  lastReap?: { at: string; killed: number; lines: string[] };
}

/**
 * The host guard a machine's daemon runs (w466, machine/hostGuard.ts): the portal's config hostGuard, hostDiskPaths and
 * limits.minFreeRamGB, written into the daemon.json of the portal's own host at deploy.
 */
export interface MachineGuardSettings {
  /** How often it looks (seconds); 0: off. */
  pollSeconds: number;
  warnFreeGB: number;
  criticalFreeGB: number;
  hysteresisGB: number;
  /** The drive is reattached only with this much free on the volumes that hold its VHDX. */
  remountMinFreeGB: number;
  /** The volumes that hold the Dev Drive's VHDX (config hostDiskPaths, e.g. ["C:/"]). */
  hostDiskPaths: string[];
  /**
   * The VHDX and its maximum size in GB (w1070): its volume is then judged by whether the file can still grow that far
   * (server/hostHealth.ts roomLevel), not by warnFreeGB. Without them, by warnFreeGB as before.
   */
  devDriveVhdx?: string;
  devDriveMaxGB?: number;
  /** Automation browsers older than this, and orphans, are ended (hours; 0: never), every reapEveryMinutes. */
  reapBrowsersAfterHours: number;
  reapEveryMinutes: number;
  /** An editor waits below this much free RAM (limits.minFreeRamGB; 0: no check). */
  minFreeRamGB?: number;
}

/** One clean-up pass on a computer (server/cleanup.ts): the host guard's or a machine daemon's. */
export interface MediaTally {
  files: number;
  bytes: number;
}

/** The media retention's part of a clean-up pass (w2268, server/mediaRetention.ts). */
export interface MediaSummary {
  days: number;
  /** Pictures and videos removed (dry run: that would go), and their bytes. */
  removedFiles: number;
  freedBytes: number;
  /** What is there before the pass, by store. */
  inventory: { uploads: MediaTally; review: MediaTally };
  /** Old enough, kept because something live points at it (an open request, a pending question, a waiting card, a running session). */
  keptReferenced: MediaTally;
  /** Not old enough yet. */
  keptYoung: MediaTally;
  dryRun?: boolean;
}

export interface CleanupSummary {
  at: string;
  /** hourly: the regular pass; low-space: below the soft threshold; critical: the host guard's critical level; asked: by hand. */
  trigger: 'hourly' | 'low-space' | 'critical' | 'asked';
  removed: number;
  freedBytes?: number;
  /** Entries skipped (in use, refused by the guard, or only partly removed). */
  failed?: number;
  /** Free space after the pass on the fullest disk volume it watches (home, data, ...): never a RAM-backed one (w566). */
  freeBytes?: number;
  /** Temp folders on a volume apart from that disk, each as RAM (a tmpfs) or a disk volume of its own: shown, never counted. */
  temp?: { path: string; freeBytes?: number; totalBytes?: number; ram: boolean }[];
  softFreeGB: number;
  /** The machine's worker install folder (w896): clean-up deletes only inside it. Absent: the machine has none. */
  root?: string;
  /** Still below the soft threshold after the pass. */
  belowSoft?: boolean;
  /** The biggest entries it removed. */
  top?: { path: string; bytes: number; rule: string; why?: string }[];
  /** It covered the stale build and run output (w459): its daily turn, low space, or asked. */
  stale?: boolean;
  /** Only planned, nothing removed (a dry run asked for by hand). */
  dryRun?: boolean;
  /** What it would remove (a dry run, or stale output in dry-run mode), biggest first, with why. */
  planned?: { path: string; bytes: number; rule: string; why: string }[];
  plannedBytes?: number;
  /** Stale-looking output it could not attribute to a closed request or a commit: kept, for a person. */
  listed?: { path: string; bytes: number; why: string }[];
  /** Rebuildable caches a low pass saw in a worker's temp folder and kept, with the check that kept them (w1813). */
  held?: { path: string; bytes: number; why: string }[];
  /** When it could not get above the soft threshold: the biggest remaining consumers. */
  consumers?: { path: string; bytes: number }[];
  /** Unity Libraries of projects not opened for a long time: reported, removed only past a longer age. */
  staleLibraries?: { path: string; days: number }[];
  /** The portal host's media retention (w2268): what it removed and kept, and what was there. */
  media?: MediaSummary;
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

export type NotifyKind = 'permission' | 'person' | 'turnEnd' | 'error' | 'standing' | 'delegation' | 'unity' | 'host';
export type NotifyPrefs = Record<NotifyKind, boolean>;

export const NOTIFY_KINDS: { value: NotifyKind; label: string; hint: string }[] = [
  { value: 'permission', label: 'Needs permission', hint: 'an agent is waiting for you to allow a tool' },
  { value: 'person', label: 'Messages from people', hint: 'someone sent you a message through their orchestrator' },
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
  /**
   * Set on the reading the scheduler and system_status use (server/usage.ts effectiveUsage, w1041) when it is not one this
   * portal just read: `persisted` (read earlier, kept in data/usage.json, the latest poll failed or has not answered yet),
   * `stale` (the same, older than STALE_READING_MS: a window not yet reset counts as at least 50%). A window whose reset time
   * passed counts as 0% either way. Never stored; computed when the numbers are read.
   */
  reading?: { kind: 'persisted' | 'stale'; asOf: string; ageMs: number; why: string };
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
  /** A vault token only: the account email a person recorded on the vault entry (w785), shown instead of the vault name (w1389). Display only: no gate or pool reads it, and it is never read from the token. */
  vaultEmail?: string;
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
  /** A vault Claude token in a person's pool (w971): its pool label (w979): "pool:ok priority", "pool:one-at-a-time", "pool:held" ..., priority on the one a new job gets. No token. */
  pool?: { person: string; state: string; text: string };
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
  /** With machineId: the machine sandbox the session works in. */
  machineSandbox?: string;
  standingId?: string;
}

/** Server-wide settings the user changes from the UI (or the orchestrator's tools). */
export interface AppSettings {
  /** The one heartbeat from before each person had their own orchestrator: moved into `heartbeat` (the owner's) at startup. */
  heartbeatMinutes: number | null;
  /** Each person's heartbeat, by user id: while their workers are mid-turn, their orchestrator is woken every N minutes. */
  heartbeat?: Record<string, number>;
  /**
   * The events each person closed a banner about, by user id (lowercase): a restart the VM watchdog made, as
   * `shared/dismissals.ts` unitEventKey. The banner stays hidden for those events and returns for a new one (w751).
   */
  dismissedEvents?: Record<string, string[]>;
  /**
   * Whose Claude pool each person's work runs on, by user id (w1717, docs/vault.md section 4, "Whose pool"): another
   * person's user id; a person with no key runs on their own ("self"). Each operator sets their own, in Settings or with
   * set_pool. Only the Claude token follows it: the GitHub token stays the person's own.
   */
  pool?: Record<string, string>;
}

/** A person as the Settings pool menu lists them (w1717): whether they have a Claude pool another's work could run on. */
export interface PoolPerson {
  userId: string;
  displayName: string;
  /** An enabled Claude token of theirs is in the vault (its metadata; the server checks that it opens before it takes a pick). */
  hasPool: boolean;
}

// ---- the work ledger (docs/orchestrators.md) ----

/**
 * Where a work request stands. The first five are open. `queued` waits for capacity only, `blocked` for a thing named in
 * `blocked` (w643, docs/orchestrators.md "Waiting, Queued, Blocked"). `stalled` is not open: the cleanup
 * (docs/orchestrators.md, "Ledger cleanup") moved it out of the active list because nothing is working on it; only its
 * person closes or reopens it.
 */
export type WorkStatus = 'new' | 'question' | 'queued' | 'blocked' | 'active' | 'stalled' | 'merged' | 'done' | 'rejected' | 'cancelled';
export const WORK_OPEN: readonly WorkStatus[] = ['new', 'question', 'queued', 'blocked', 'active'];

export type WorkPriority = 'low' | 'normal' | 'high' | 'urgent';
export const WORK_PRIORITIES: readonly WorkPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Work in flight or recently done that a new request may repeat, as the server found it when the request was filed. */
export interface WorkOverlap {
  /** A work item ("w12"), a session id, a delegation id or a commit. */
  ref: string;
  kind: 'work' | 'session' | 'delegation' | 'commit';
  title: string;
  /** 0 to 1; 0.8 and over is strong: the dispatcher then gives a reason to start work anyway. */
  score: number;
  /** "same spec 098", "same PR #412", "similar title". */
  why: string;
}

/** A leg of a request queued for named computers (w1863, WorkItem.legs): since when, where, and what it is. */
export interface QueuedLeg {
  at: string;
  needs: string[];
  what: string;
}

/**
 * A pair run (w1945, lothsahn: "Can we make the dispatcher smart enough so it queues work properly that requires running
 * together across multiple machines and doesn't waste slots?"): work that needs `legs` computers at once, one worker on each,
 * started together (start_agent with pair_sandboxes), such as a two-machine multiplayer determinism check: leg 1 hosts, the
 * others join. It counts as room only where that many computers that fit have room at once (shared/capacity.ts pairRoom).
 */
export interface WorkPair {
  /** Computers at once, one worker on each (2 to PAIR_MAX_LEGS). */
  legs: number;
  /** The request whose worker asked for it with request_pair, and that worker: Blocked on this one's report meanwhile. */
  for?: string;
  forSession?: string;
  /**
   * Why the legs must run on different operating systems (the game repo's Determinism-Test-Strategy.md "Which machines",
   * w1692: float or math-library use in the simulation, Burst or IL2CPP codegen, platform APIs or paths, the desync hash, a
   * desync seen only across OSes): its legs then go on two operating systems. With it or without, one Mac may take leg 1,
   * the host, and no other leg (a Mac refuses a multiplayer client, w665; w2282).
   */
  crossOs?: string;
  /** A leg takes timing measurements (exclusive bench tickets): never on a computer that takes no timed runs (m5, w1861). */
  timed?: boolean;
  /** When its legs started together, and where: leg 1 (the host) first. */
  started?: { at: string; legs: { session: string; sandbox: string }[] };
  /**
   * A retry (w2041): the earlier pair run of the same request it replaces (cancelled when this one was filed), and the
   * computers none of its legs may go on: an earlier leg's computer that was offline, whose worker errored or never said
   * DONE while another leg did (w1976: lothlaptop's Tailscale was stuck), or one the asking worker named.
   */
  retryOf?: string;
  avoid?: string[];
  /**
   * The pull request ("owner/repo#N") and the commit its legs run (w2057, request_pair pr and commit): a filing for the same
   * pull request joins this run while it is open, and is answered with its result once it finished on the same commit.
   * Absent on a run filed by hand: server/pairRuns.ts reads them from its title and brief.
   */
  pr?: string;
  commit?: string;
  /** The requests its finished result was sent to (w2057, Orchestrators.pairFinished): each told once. */
  told?: string[];
  /**
   * The last time FF Factory re-queued it as a unit after a leg broke mid-run (w2304, Orchestrators.requeuePair): when, why,
   * how many times so far, and `gaveUp` once it stopped re-queuing it (PAIR_REQUEUE_MAX).
   */
  requeued?: { at: string; why: string; count: number; gaveUp?: string };
}

/** A request for work that a person's orchestrator filed with the dispatcher, and what became of it. */
export interface WorkItem {
  id: string;
  title: string;
  brief: string;
  constraints?: string;
  priority: WorkPriority;
  /** Ids the requester named: a spec, a PR, a session, a sandbox, a delegation, another work item. */
  relatedIds?: string[];
  /** Its people's update_work notes, oldest first (w496: every worker started for it gets them with the brief). */
  notes?: { at: string; by: string; text: string }[];
  /** What overlaps are matched on: "spec:098", "pr:412", "branch:098-belts", "session:ab12cd34". */
  keys: string[];
  /**
   * The Discord threads and player reports its filer said it is the work for (request_work `subjects`), as keys
   * ("discord:<thread>", "report:<id>"). With its title, its dev links and a broad scope, the only place its thread and
   * report keys may come from (w343): a brief's ids are references.
   */
  subjects?: string[];
  /** Who filed it: its workers run on their account. */
  requestedBy: Requester;
  /**
   * Filed by the intake for nobody by name (w512): `requestedBy` is the system payer by default, and the token vault gives
   * its workers the tokens config vault.unattributed names for where it came from (docs/vault.md, "Whose tokens").
   */
  unattributed?: boolean;
  /**
   * Whose Claude pool and GitHub token its workers run on from now on (w1031): the person who last acted on it in FF Factory
   * (answered its question, approved, declined, added a note, reopened, changed its priority, or joined it from Discord or
   * FFBox). Wins over `unattributed` and `requestedBy` (server/vault.ts tokenPersonForWork). Absent: nobody has acted since
   * it was filed, so the filer's (or the intake's default) apply. `why` is the log line's words; `at` the action's time.
   */
  runsFor?: { userId: string; displayName: string; at: string; why: string };
  /** Everyone it is for, the filer first, then the people whose requests were merged into it. They hear its news. */
  requesters: Requester[];
  /** Filed in a turn the person started (their own message), which the destructive tools require. */
  humanAsked: boolean;
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
  /** When merged: the item it continues as. */
  mergedInto?: string;
  /** The workers started, messaged or linked for it. */
  sessionIds: string[];
  /**
   * When each worker was last given it (w418), by session id: `sent` by a start or a message with its work_id, `linked` by
   * decide_work link. Which request a worker on several is working on now is read from these (shared/workState.ts).
   */
  links?: Record<string, { at: string; how: 'sent' | 'linked' }>;
  /**
   * Workers that let this request go while still on other work (w915), by session id. A worker that was sent it and has not
   * said DONE holds it (shared/workState.ts holdsOf) and shows Working while it is busy, even on a later request; this is
   * how that ends. `paused`: the worker wrote `<id>: paused: <why>` (set it aside until `for` is done; shown Paused).
   * `released`: asked to wrap it up (wrapUpBefore), it said nothing about it. Void once the worker is sent it again
   * (links[session].at after `at`); a pause also ends when `for` closes or the worker says DONE for it.
   */
  setAside?: Record<string, { at: string; kind: 'paused' | 'released'; for?: string; text?: string }>;
  /**
   * Its workers that said `DONE: <id>` for their part, by session id, with when and the report's first line (w434): the
   * request closes once none of its workers is still on it (each said DONE, ended, or moved on to newer work). `text`:
   * the full text of that worker's DONE reports on it, newest last (the last 4000 characters), which a refused DONE is
   * checked against again when its PRs change (w515; absent on DONEs recorded before).
   */
  done?: Record<string, { at: string; report: string; text?: string; told?: string }>;
  /**
   * When a person (or an owner for them) last reopened it from closed (w731; absent when never). A reopen invalidates
   * what came before it: the workers' DONEs are dropped, the earlier PRs are no longer its own (a PR created before this
   * time never links to it), and the ledger cleanup closes it again only on a DONE, a report or a merge after this time.
   */
  reopenedAt?: string;
  /** Files its person attached (request_work attachments): every worker started for it gets a copy. */
  attachments?: AttachmentRef[];
  /** What it may repeat, found when it was filed; strongest first. */
  overlaps: WorkOverlap[];
  /** The latest outcome: a worker's last word, or the note it was closed with. */
  outcome?: string;
  /** Questions the dispatcher asked about it (at most 3). */
  asks: number;
  /**
   * Its workers may list and read every open and stalled request (w642, docs/orchestrators.md "Workers read the ledger"),
   * for a ledger task: set by its person's orchestrator (request_work or update_work ledger_read), never by its text.
   */
  ledgerRead?: { by: string; at: string };
  /**
   * Its workers on `machine` may work in that machine's main clone: quit the editor open there, back up, git fetch and
   * checkout, reopen Unity (w936, docs/orchestrators.md "Work in a machine's main clone"). Set by its person's orchestrator
   * in a turn of theirs (request_work or update_work main_clone), never by its text; the guard reads it
   * (server/mainCloneGuard.ts).
   */
  mainCloneAccess?: { machine: string; by: string; at: string };
  /**
   * The question it waits on, from the dispatcher (decide_work ask) to its requester, until a note answers it (w278:
   * FFBox posts it in the requester's thread). A design question is `flag` instead. `asks` (w1597): the questions as the
   * card asks them, each with its 2-4 answers (shared/questionCard.ts).
   */
  question?: { text: string; at: string; asks?: Ask[] };
  /**
   * The newest wait on a person that went to their own orchestrators as a `[needs you]` message (w1378, Ben: "Those should
   * just be surfaced to you the orchestrator and then I'll answer you and you send the response back"): the question in
   * full with its context, so the page shows it whole and the message goes once per question (server/needsYou.ts).
   */
  needsYou?: WorkNeedsYou;
  /** What happened, oldest first: "10:02 filed by Lothsahn", "10:03 merged into w11: same fix". */
  log: string[];
  /**
   * Recorded, not filed: a worker that started outside the ledger (the dispatcher's direct start, the dashboard, /mcp,
   * a delegation) and is listed so the ledger shows all work. It does not count against its person's filing limits.
   */
  recorded?: boolean;
  /** Where it came from when not a person's orchestrator: Discord or FFBox, through the intake (docs/intake.md). */
  source?: WorkSource;
  /**
   * Filed from a standing agent's delegation request (w527, docs/standing-agents.md "Delegations"), for the agent's
   * owner: the request, the agent, and whether the agent's auto-approve rules filed it (else `approvedBy` did).
   */
  delegation?: WorkDelegation;
  /** The intake's classification, with its reason: an obvious bug may be worked without a person; anything else needs one. */
  triage?: WorkTriage;
  /**
   * Intake requests wait for a person (or an auto-approve rule) before the dispatcher hears of them; start_agent
   * refuses them until then. Absent on requests people filed.
   */
  approval?: WorkApproval;
  /** The fix's way to players: the commit that landed it, the Discord reply and close, the release it shipped in. */
  delivery?: WorkDelivery;
  /** The pull requests of its workers (the ledger links them, docs/orchestrators.md "Pull requests"), oldest first. */
  prs?: WorkPr[];
  /** Why the cleanup stalled it (status `stalled`). */
  stalled?: WorkStalled;
  /**
   * What it waits on (status `blocked`, w643): a thing, never a person and never capacity. It clears by itself
   * (server/blockerWatch.ts) and the dispatcher is told to start it.
   *
   * w754: a GATE, not a status note. It survives a hold (decide_work ask) and a person's "go": starting the work
   * while a gate is open needs override_gate (the person's words). Only a start (with the override), the gates
   * clearing, a stall or a close drops it. With several gates this is the first and `alsoBlocked` holds the rest; the
   * request starts when all have cleared (shared/blockers.ts gatesOf).
   */
  blocked?: WorkBlocker;
  /** w754: the other gates of a request that waits on several things (w750: w727's PR and w752). Absent for one. */
  alsoBlocked?: WorkBlocker[];
  /**
   * w829: the workers' own wake_me check-ins a block cancelled (w814: the dispatcher blocked it on CI, cancelled its
   * worker's 8-minute check-in, and the block never cleared). Kept while it is blocked so it is never left with nobody to
   * wake it: when its gates clear, or its CI cannot be read, each is handed back and fires at once. Dropped with the gates.
   */
  heldCheckIns?: HeldCheckIn[];
  /**
   * w1094: the workers its gates' clearing resumed, until each is seen to take the message (it shows in its transcript).
   * The blocker watch's sweep resumes again, loudly, one that has nothing pending for it 5 minutes later (no check-in
   * waiting to fire, no message waiting for a sandbox), and tells the dispatcher after a few tries.
   */
  gateResumes?: GateResume[];
  /** w2140: the held deploy's head (a red CI on the portal's main) whose fix this request's worker was resumed for, once. */
  deployHeldTold?: string;
  /**
   * w830: decisions a person gave on this request that wait for a fact ("close w811 as a duplicate once #1314 merges"),
   * recorded in their own turn with their words; the blocker watch carries each out, or drops it, when its condition is met.
   */
  conditional?: ConditionalDecision[];
  /**
   * w2217 (w2192 sat 3 h as "the dispatcher has it to decide"): how long it has sat undecided, status `new`. `since`: when
   * the blocker watch first saw it so (its updatedAt then); `reofferedAt`: when FF Factory offered it to the dispatcher again,
   * once, past UNDECIDED_BOUND_MS (shared/workState.ts). Cleared when it leaves `new`.
   */
  undecided?: { since: string; reofferedAt?: string };
  /** The computers the dispatcher said can take it when it queued it for capacity (decide_work queue `needs`, w643). */
  queuedFor?: { at: string; needs?: string[] };
  /**
   * w1863: legs held for named computers while the request's own worker carries on elsewhere (decide_work queue with `needs`
   * on a request that has a worker): "queued for capacity on m5, I start a timing worker there when a slot frees". Not its
   * status: a leg outlives the request going active again (a message to its worker), that worker's reports and its PRs
   * merging, and goes only when a worker starts or is sent for it on a computer it names, or the request closes.
   */
  legs?: QueuedLeg[];
  /** A pair run (w1945): it needs this many computers at once, its legs started together. */
  pair?: WorkPair;
  /**
   * A timed leg handed off to a small computer (w1969, timed_place): the request whose worker asked and that worker (Blocked
   * on this one's report meanwhile), where it came from and the small computers it waits on. Queued for those; after
   * TIMED_LEG_WAIT_MS (server/timedAsk.ts) its needs widen to every computer that takes timed runs, and `widened` says when.
   */
  timedLeg?: { for: string; forSession: string; from: string; small: string[]; widened?: string; platform?: string };
  /**
   * Its last hand-back (w1532, server/machinePause.ts): its worker's machine was paused, so it was taken off that worker and
   * Queued for another computer, whose worker picks it up from `branch` with `note` (the worker's own line, or where it
   * stopped) and the `message` that would have resumed it, in its handover.
   */
  handedBack?: { at: string; from: string; session: string; branch?: string; why: string; note: string; how: string; saved?: string; message?: string; to?: string };
  /**
   * The workers it was taken off (Orchestrators.moveOff: a move, a hand-back, a new session), session id to when (w1983): for
   * such a worker its work here is over (Agents.workOver), so a check-in it set before the move no longer pins its sandbox.
   */
  movedOff?: Record<string, string>;
  /**
   * The repository the work is in, "owner/name" (w1098; request_work `repo`). Placement reads `needs`, which is derived
   * from it when the request is filed, never guessed later from the brief.
   */
  repo?: string;
  /**
   * What the work needs of a computer (w1098, lothsahn: "FFBox and FF Factory updates don't need unity editors"): `game`,
   * a game sandbox with an editor's worth of RAM (the game repo, or unknown: the safe default), or `agent`, only an
   * agent slot (FF Factory, FFBox, the ff-agents plugin, any non-Unity repo). Absent on requests filed before it: game.
   */
  needs?: 'game' | 'agent';
  /**
   * A worker on it started a Live view (w1600, docs/live-view.md): it needs one from then on, so it is placed on
   * placement.live first (BEAST), and a move of it says to stage the view again. The first start, kept.
   */
  liveView?: { at: string; session: string; machine: string };
  /**
   * A worker on it declared a build coming (w1606, the build_plan tool): it builds a player from then on, so it is placed
   * on placement.build first (BEAST). The first declaration, kept.
   */
  build?: { at: string; session: string; machine: string };
  /** The cleanup's last "Is it done?" to a worker about this merged request (w419): at most one a day. */
  followUp?: { at: string; sessionId: string };
  /** Workers the cleanup already resumed once after they were cut off, by session id: never a second time. */
  resumedBy?: Record<string, string>;
  /** Set when the intake closed it as done because its work already merged (docs/intake.md, "Closed when it merged"). */
  autoClosed?: WorkAutoClosed;
  /**
   * A question for people, open until they answer: a design decision the worker raised instead of fixing (`design`), or
   * an error the ledger cleanup could not fix by resuming the worker, escalated to the request's person and an operator
   * (`error`, w1870).
   */
  flag?: { kind: 'design' | 'error'; text: string; at: string; for: Requester[] };
  /**
   * What the ledger cleanup did about a worker's last turn that ended in an error or an interrupt instead of a report
   * (w1870), by session id: never closed as done on such a turn, it is resumed, re-placed or escalated, once per turn.
   */
  errorHandled?: Record<string, WorkErrorHandled>;
  /** Handed to FFBox (docs/intake.md, "Ledger → FFBox"): the submit's id, and what FFBox said about it. */
  ffbox?: WorkFfbox;
  /**
   * What a broad request covers (docs/ffbox.md, "Dev requests"): the Discord threads its brief lists, or a channel's
   * conversations in a time window. An FFBox dev request inside an open request's scope joins it instead of being filed.
   */
  scope?: WorkScope;
  /**
   * The FFBox dev requests filed as, or joined to, this request (docs/ffbox.md, "Dev requests"): where an operator's
   * follow-ups come from and where reply_to_ffbox and the automatic "done" reply go. Oldest first, at most 20.
   */
  ffboxDev?: WorkFfboxDev[];
}

/** The standing agent's delegation request a ledger request was filed from (w527). */
export interface WorkDelegation {
  id: string;
  agentId: string;
  agentName: string;
  auto: boolean;
  approvedBy?: Requester;
}

/** One pull request linked to a request: where it is, and what it did. */
/** A wait on a person that reached their orchestrators as `[needs you]` (w1378, server/needsYou.ts). */
export interface WorkNeedsYou {
  /** What the wait is, for de-duplication: the dispatcher's question, a worker's declaration, or the "still open" line of its report. */
  key: string;
  kind: 'question' | 'declared' | 'report';
  /** The question in full: the dispatcher's words, or the worker's "what" and its report's line. */
  question: string;
  /** Who it waits on, as the page and the message name them. */
  who: string[];
  /** The people whose orchestrators were sent it (user ids). */
  to: string[];
  /** When it was sent (ISO). */
  at: string;
  /** The worker that waits, resumed with the answer. Absent for a dispatcher question with no worker. */
  worker?: string;
  /** The end of that worker's last report, for its context (at most NEEDS_YOU_REPORT_CHARS). */
  report?: string;
  /** Review stills, clips and folders the question or report names. */
  previews: string[];
  /** Pull requests it names ("Final-Factory/FinalFactory#1799"). */
  prs: string[];
  /**
   * The questions as the card asks them, one at a time, each with its 2-4 answers, the recommended one first (w1597: the
   * worker's waiting_on_person questions, or the dispatcher's decide_work ask). Absent on a free-text question: the card shows
   * it cleaned with a free answer box (shared/questionCard.ts).
   */
  asks?: Ask[];
  /** What the request is, in one plain line, as its worker put it for the card (w1868, waiting_on_person about). */
  about?: string;
  /** What happens once it is answered, as its worker put it (w1868, waiting_on_person after). */
  after?: string;
  /** Sent in the one-off digest of waits already open when w1378 shipped, or after a restart. */
  digest?: boolean;
  /** A person answered it with a note in their own turn: who and when, and on which request when not this one (w1812). */
  answered?: { by: string; at: string; on?: string };
  /**
   * Of several questions, the ones a person's note answered so far, by index into `asks` (w1868, w1821: the frame look was
   * answered and the Station strip question still waited). The record is answered, and its worker resumes, once all are.
   */
  answeredAsks?: number[];
  /** When the worker raised it (its declaration, or its report), where known: an answer before it answers something else (w1812). */
  raisedAt?: string;
  /**
   * The request whose `[needs you]` carries this same question (w1812): the same worker raised it on both, it went to the
   * person once, there, and an answer on either answers both. Nothing was sent for this request.
   */
  sharedWith?: string;
  /** The other requests the one message named as carrying the same question (w1812). */
  also?: string[];
  /**
   * The asked person's notes on this request and its related requests, newest last, cut (w2085, server/priorDecisions.ts):
   * the card shows them, so the orchestrator checks none decides the question before it asks.
   */
  prior?: { on: string; at: string; by: string; text: string }[];
  /** Those notes that may already decide it, and what each names that the question names too (w2085). */
  possiblyDecided?: { on: string; at: string; by: string; why: string[] }[];
}

/** An ask_person question its person has not answered yet (w1868, SessionInfo.openAsks). */
export interface OpenAsk {
  /** The question's event in the orchestrator's chat: a click answers it there (POST /api/sessions/<id>/answer). */
  seq: number;
  at: string;
  ask: Ask;
  /** The request it is about, when it names one. */
  request?: string;
  /** What happens once it is answered, as the orchestrator put it. */
  after?: string;
}

export interface WorkPr {
  /** GitHub owner/name. */
  repo: string;
  number: number;
  url?: string;
  title?: string;
  head?: string;
  state: 'open' | 'merged' | 'closed';
  /** When it merged or closed. */
  at?: string;
  /** The merge commit. */
  sha?: string;
  /** The strong evidence that linked it (server/ledgerRules.ts prsOf): its Request line, its own worker opened it, its head branch is the request's, or its title names it (title, w631: titleIdsIn). Absent on links made before w340, which are checked again. */
  via?: 'line' | 'worker' | 'branch' | 'title';
  /** Its description says `Part of: <id>` (w424): one step of the request, whose merge leaves it open for what follows. */
  partOf?: boolean;
  /** What the log already said about it, so a sweep notes a state once ("merged:release", "closed"). */
  noted?: string;
}

/**
 * What a blocked request waits on (w643; shared/blockers.ts says when each clears): another request finishing or
 * reporting, a deploy of the portal or a machine's update, a machine coming back, a Claude account's usage limit, a lock
 * (the nightly lab.lock), a time, the CI checks of a pull request, or (w754) a pull request merging.
 */
export type WorkBlockerKind = 'request' | 'deploy' | 'machine' | 'usage' | 'lock' | 'time' | 'ci' | 'pr';
export const WORK_BLOCKER_KINDS: readonly WorkBlockerKind[] = ['request', 'deploy', 'machine', 'usage', 'lock', 'time', 'ci', 'pr'];

/** A worker a gate's clearing resumed (w1094, WorkItem.gateResumes). */
export interface GateResume {
  session: string;
  /** When it was resumed (ISO), and the start of the message it was sent, which its transcript shows once delivered. */
  at: string;
  mark: string;
  /** The message in full, to send again. */
  note: string;
  /** Its transcript's last sequence number when it was resumed: the message comes after it. */
  seq: number;
  tries: number;
}

export interface WorkBlocker {
  kind: WorkBlockerKind;
  /**
   * What it names. request: the request id ("w633"). deploy: a machine id for that machine's daemon update, absent for
   * the portal. machine: the machine id. usage: the Claude account (its email or label). lock: the lock ("lab.lock").
   * ci and pr: the pull request ("owner/repo#123"). time: absent.
   */
  ref?: string;
  /** request (and a lock some request holds): clears when that request closes as done (`done`, default) or reports. */
  on?: 'done' | 'report';
  /** lock: the request holding it, whose close or report frees it. */
  holder?: string;
  /** time: when it clears. lock: when to look again at the latest. */
  until?: string;
  /** What it waits for, in a few words: "w633's timing table", "the next portal deploy". */
  what: string;
  at: string;
  /** Who set it: "dispatcher", "worker <id>" (its blocked_on tool, w754) or "ledger cleanup" (a merged request whose only step left is a deploy). */
  by: string;
  /** deploy: the commit the portal (or the machine's daemon) ran when it was set; a different one is the deploy. */
  sha?: string;
  /**
   * ci: what the blocker watch last read of its checks, and when (w1094: w1078 read "Blocked on CI" for 20 minutes while
   * its nested-VM workflow still ran, and the people saw only the worker's own words, so it looked stale).
   */
  read?: { at: string; text: string };
  /**
   * ci, the merge-on-green pilot (w2045, docs/orchestrators.md "Merge on green, a pilot"): FF Factory merges the pull request
   * itself when every check passed, at this head (--match-head-commit), and files `report` as the worker's report, with no model
   * turn. On red, or a merge that fails, the worker is resumed as without it. `session`: the worker that set it.
   */
  mergeOnGreen?: { head: string; report: string; session: string };
  /**
   * deploy (w2140): the portal's automatic deploy is held because CI failed on the head of its main, so this gate cannot
   * clear until that is fixed. `text` is what the request's live state says ("deploy held: master CI failed on 5a1909756
   * (Windows tests: failure)"); `sha` the held head, whose hold its person was told of once.
   */
  held?: { sha: string; text: string; at: string };
}

/**
 * A person's decision that waits for a checked fact (w830, docs/orchestrators.md "Conditional decisions"): recorded by
 * their orchestrator in a turn of theirs, with their own words, and carried out by the server under their authority.
 */
export interface ConditionalDecision {
  /** "c1", "c2", … unique on its request. */
  id: string;
  /** Whose decision it is, and when it was recorded (ISO). */
  by: Requester;
  at: string;
  /** Their own words, verbatim from a message of theirs. */
  words: string;
  /** What is done: approve or decline an intake request, or close it as done or cancelled. */
  action: 'approve' | 'decline' | 'done' | 'cancelled';
  /** The note the action carries (a decline's or a close's reason). */
  note?: string;
  /** The fact it waits for: a pull request ("owner/repo#123") merged, or closed either way; a request closed as done. */
  when: { kind: 'pr_merged' | 'pr_closed' | 'request_done'; ref: string };
  /** When it is dropped unmet (ISO), its person told. */
  expires: string;
}

/** A worker's wake_me check-in that a block cancelled (w829), kept to be handed back when the block ends. */
export interface HeldCheckIn {
  /** The worker's session id. */
  session: string;
  /** When it was due (ISO). */
  at: string;
  /** Its note, as the worker wrote it. */
  note: string;
  /** w1128: a gate's resume that came after the request was blocked again (Orchestrators.staleResume), not the worker's own check-in. */
  resume?: true;
}

/** What a request's flag (WorkItem.flag) is, as the ledger and the Waiting tab name it. */
export const FLAG_LABEL: Record<'design' | 'error', string> = { design: 'Design question', error: 'Error escalated by the ledger cleanup' };

/** The ledger cleanup's handling of one worker's errored or interrupted turn (w1870, WorkItem.errorHandled). */
export interface WorkErrorHandled {
  /** When that turn ended (the worker's lastResultAt): a later errored turn is a new one. */
  turnAt: string;
  /** What the cleanup did: resumed the worker, asked the dispatcher to place it again, escalated it, or left it to the dispatcher. */
  how: 'resumed' | 're-placed' | 'escalated' | 'left';
  at: string;
  /** The error in one line (errorKey tells the same one again). */
  error: string;
  /** The cleanup's resumes of this worker for errors on this request so far. */
  resumes: number;
}

/** Why a request is stalled, and what kind of stop it was. */
export interface WorkStalled {
  at: string;
  /** blocked (w643): what it was blocked on stalled, closed without delivering, or did not clear in time. */
  kind: 'idle' | 'cut-off' | 'superseded' | 'unsure' | 'blocked';
  reason: string;
  /** superseded: the finished request that probably covers it. */
  by?: string;
}

/** Why and how the intake closed a request on its own: its branch or PR merged, or the request it is linked to is done. */
export interface WorkAutoClosed {
  at: string;
  /** branch: a merged PR or commit names the branch; pr: the PR it names merged; thread: a merged PR carries its Discord thread; ancestor: every commit of the branch is on the base branch; linked: a linked request is done; prs: every pull request linked to it merged and nothing was left to do; report: its worker's final report said it was delivered; deploy: its PRs merged and the deploy left after them is done (the portal, and the machines when asked, run the merge, w631). */
  how: 'branch' | 'pr' | 'thread' | 'ancestor' | 'linked' | 'prs' | 'report' | 'deploy';
  /** The merging PR's number, the merge commit and when it merged (absent for a linked request). */
  pr?: number;
  sha?: string;
  mergedAt?: string;
  /** The done request it was linked to ("w12"). */
  by?: string;
  /** The line the log carries: "merged as #946 (abc123def456) on 2026-10-03". */
  text: string;
}

/** A request's scope: its threads, or a source and channel's conversations created between since and until. */
export interface WorkScope {
  /** Discord thread ids (snowflakes). */
  threads?: string[];
  /** FFBox's conversation source: discord, codereview, shell, web. */
  source?: string;
  /** FFBox's watch alias for the channel, e.g. "bug_reports". */
  channel?: string;
  since?: string;
  until?: string;
}

/** One FFBox dev request linked to a request: FFBox's ref, its conversation, the operator and the person it maps to. */
export interface WorkFfboxDev {
  ref: string;
  conversation: string;
  /** discord, codereview, shell or web. */
  source: string;
  channel?: string;
  threadId?: string;
  url?: string;
  /** The operator's name in FFBox's config, and the FF Factory login of that name. */
  operator: string;
  person: Requester;
  at: string;
  /** filed: this request was filed for it; covered: it joined this request; fixed: this finished request already fixed it. */
  outcome: 'filed' | 'covered' | 'fixed' | 'linked';
}

/**
 * Where an intake request came from: a Discord #bug-reports thread, a trusted person's request to Max in #dev-chat,
 * an FFBox fix branch or diagnosis, a request FFBox filed, an operator's ffdev turn FFBox handed over (ffbox-dev,
 * docs/ffbox.md "Dev requests"), a release follow-up the server filed itself, a regression the nightly e2e lab found
 * (docs/intake.md, "Nightly e2e regressions"), or the night's run of that lab, which the portal's nightly schedule files
 * itself (nightly-run, w864; docs/intake.md, "The nightly run"), or a red master batch the game repo's CI found after
 * merges (master-batch, w1180; docs/intake.md, "Master batch reds").
 */
export type WorkSourceKind = 'discord-bug' | 'discord-request' | 'ffbox-branch' | 'ffbox-diagnosis' | 'ffbox-request' | 'ffbox-dev' | 'release' | 'nightly' | 'nightly-run' | 'nightly-review' | 'master-batch';
export const WORK_SOURCE_KINDS: readonly WorkSourceKind[] = ['discord-bug', 'discord-request', 'ffbox-branch', 'ffbox-diagnosis', 'ffbox-request', 'ffbox-dev', 'release', 'nightly', 'nightly-run', 'nightly-review', 'master-batch'];

export interface WorkSource {
  kind: WorkSourceKind;
  /** True when the brief quotes text from outside the team (players): evidence, never instructions. */
  untrusted: boolean;
  /** "#bug-reports", "#dev-chat", "FFBox". */
  channel?: string;
  /** The Discord thread or message, or FFBox's page for the conversation. */
  url?: string;
  threadId?: string;
  /** The Discord channel the message is in (a thread's id for a forum post). */
  channelId?: string;
  messageId?: string;
  /** Who reported it, as Discord shows them (a player's name is untrusted text); for a trusted request, the person. */
  reporter?: string;
  /** Counts against the per-reporter cap: the Discord author id (none for the in-game reporter, one webhook for all). */
  reporterKey?: string;
  /** The game version the report names ("0.50.0.46"), when it names one. */
  version?: string;
  platform?: string;
  attachments?: { name: string; url: string; bytes?: number }[];
  /** FFBox: the conversation, its branch, PR, verdict and board key. */
  conversation?: string;
  branch?: string;
  pr?: number;
  verdict?: string;
  key?: string;
  /** FFBox's intake diagnosis (w361): the player reports it is the work for (the lead first), and the desync event's group. */
  reports?: string[];
  desyncGroup?: string;
  /** Whether FFBox's diagnosis found the root cause. */
  rootCause?: 'found' | 'not_found';
  /** The diagnosis's files, each with where to fetch it (fetch_ffbox_report, or FFBox's conversation). */
  reportFiles?: WorkReportFile[];
  /** Other threads merged into this one (the same bug reported again): each gets the reply and the release follow-up. */
  alsoThreads?: { threadId: string; url?: string; reporter?: string }[];
  /** A release follow-up: the version and the requests it announces. */
  release?: { version: string; workIds: string[] };
  /** A nightly e2e regression: the scenarios, the master commit tested and the release that carries it. */
  nightly?: WorkNightly;
  /** The night's run of the nightly e2e lab (w864): the night (its date where the schedule fired) and the machine it runs on. */
  nightlyRun?: { date: string; machine: string };
  /**
   * The night's merge review (w905, the Nightly Regression Sentry folded into the job timers): the night, its machine, and
   * the master commit the last review got to (it reviews the merges after it).
   */
  nightlyReview?: { date: string; machine: string; since?: string };
  /**
   * A red master batch (w1180): the Actions run, the tip it tested, and what the request is for: `culprit` (revert the merge
   * `sha` of PR `pr`), `no-results` (nothing ran at the tip: a compile error or a crash) or `unbisected` (failing tests no
   * merge in the window explains). Not `pr` or `branch` above: those would make the merge watch close it when the culprit's PR merged.
   */
  masterBatch?: { run: string; tip: string; kind: 'culprit' | 'no-results' | 'unbisected'; sha?: string; pr?: number };
}

/** One night's merge review as the portal saw it (w905): fired, then done with what it filed, or missing. */
export interface NightlyReview {
  date: string;
  /** running: fired, its worker not done yet; done: it reported REVIEWED-THROUGH; missing: it ended or timed out without. */
  status: 'running' | 'done' | 'missing';
  firedAt?: string;
  workId?: string;
  /** The master commit the review started after (the last review's REVIEWED-THROUGH), and the one it got to. */
  since?: string;
  reviewedThrough?: string;
  /** The verifier and test-writer requests it filed (Duty A and B). */
  jobs?: string[];
  cause?: string;
  alarmAt?: string;
}

/**
 * One night of the nightly e2e lab as the portal saw it (w864): fired by the schedule, then reported by the lab, or
 * missing. Lothsahn: "We shouldn't assume silence means a successful (or failed) run."
 */
export interface NightlyNight {
  /** The night, as YYYY-MM-DD in the schedule's time zone. */
  date: string;
  /** running: fired, no report yet; passed, failed, broken: what the lab reported; missing: no report by dueBy. */
  status: 'running' | 'passed' | 'failed' | 'broken' | 'missing';
  /** When the schedule fired it and the run request it filed (absent for a report the schedule did not fire). */
  firedAt?: string;
  workId?: string;
  /** No report by then is the alarm. */
  dueBy?: string;
  reportedAt?: string;
  lab?: string;
  sha?: string;
  /** The lab's counts: scenarios that ran, passed, failed (new and still), flaky, could not run. */
  counts?: { ran: number; passed: number; failed: number; flaky: number; env: number };
  /** Why it broke, why it is missing, or why the schedule could not file it. */
  cause?: string;
  /** Requests the night's regressions were filed as or added to. */
  work?: string[];
  /** When its person was told it is missing or broken. */
  alarmAt?: string;
  /** When its worker was first given the night's API key (w864); the key itself is never stored here. */
  keyGivenAt?: string;
}

/** One file of an FFBox diagnosis (w361): a report's zip or manifest (by report id) or the diagnosis summary (by conversation). */
export interface WorkReportFile {
  name: string;
  kind: 'report_zip' | 'report_manifest' | 'diagnosis_summary';
  bytes: number;
  sha256: string;
  reportId?: string;
  file?: string;
  conversation?: string;
}

/** What the nightly e2e lab reported about a regression request (docs/intake.md, "Nightly e2e regressions"). */
export interface WorkNightly {
  /** The scenario ids ("MP-slow-client-catchup"); more than one for a night's batched request. */
  scenarios: string[];
  /** The night that filed it ("2026-09-30"), the lab and the master commit it tested. */
  date: string;
  lab: string;
  sha: string;
  /** "<night> <scenario>" for every night that reported it, oldest first: the filing night, then each night it failed again. */
  nights: string[];
  /** The first release that carries the failing code, and whether it did for sure ("yes") or may have ("maybe"). */
  release?: NightlyRelease;
}

export interface NightlyRelease {
  /** yes: a release contains the first failing commit; maybe: a release lies between the last green and the first red; no: none yet. */
  shipped: 'yes' | 'maybe' | 'no';
  /** That release's version ("0.50.0.53") and its version-bump commit; absent when shipped is "no". */
  version?: string;
  sha?: string;
  /** The newest release on record, for context. */
  latest?: string;
}

/**
 * obvious-bug: a player's report with a clear defect and no design ask (fixed-code rules, conservative); needs-human:
 * anything else from players or FFBox, which nobody works until a reviewer approves or answers; person: a reviewer or
 * operator asked for it themselves; follow-up: the server's own release follow-up; regression: a scripted oracle of
 * the team's own nightly e2e lab failed (no players' text); ffbox-desync: an FFBox desync diagnosis or its ffbox/* PR,
 * reviewed and merged under the desync PR policy (server/intakeRules.ts DESYNC_PR_POLICY; Lothsahn, 2026-10-04);
 * ffbox-crash: an FFBox crash or hang diagnosis or its ffbox/* PR, worked and merged under the crash-fix policy
 * (CRASH_FIX_POLICY; lothsahn, 2026-10-23, w1827).
 */
export type WorkTriageClass = 'obvious-bug' | 'needs-human' | 'person' | 'follow-up' | 'regression' | 'ffbox-desync' | 'ffbox-crash';

export interface WorkTriage {
  class: WorkTriageClass;
  /** Why, in one line: the signals the rules saw ("a crash on 0.50.0.46, no design ask") or what was missing. */
  reason: string;
}

export interface WorkApproval {
  state: 'pending' | 'approved' | 'declined';
  /** 'auto': an auto-approve rule in config intake; else the person who clicked. */
  by?: Requester | 'auto';
  at?: string;
  /** Why it was not auto-approved (auto-approve off, today's auto cap reached, a strong overlap). */
  why?: string;
}

export interface WorkDelivery {
  /** FIX-LANDED <sha>: the commit the worker said carries the fix (checked against the base branch). */
  fixCommit?: string;
  fixAt?: string;
  /**
   * The pull request that merged the fix and its head branch (w480): from the merged PRs by fixCommit, an auto-close's
   * PR, or the PR an "already fixed by #N" close names. FFBox's merge notice names it ("Fixed in PR #N").
   */
  fixPr?: number;
  fixBranch?: string;
  /** Seen on the base branch (git merge-base --is-ancestor). */
  landedAt?: string;
  /** Max replied in, and closed, the thread (from the ffdiscord events file). */
  repliedAt?: string;
  closedAt?: string;
  /** The first release (bundleVersion bump on the base branch) that contains the fix. */
  releasedIn?: string;
  releasedAt?: string;
  /** The release follow-up request that tells the reporter ("live in 0.50.0.X"). */
  announcedBy?: string;
}

export interface WorkFfbox {
  requestId: string;
  state: 'sent' | 'accepted' | 'refused' | 'done';
  class: 'fenced' | 'open';
  sentAt: string;
  conversation?: string;
  billedTo?: string;
  reason?: string;
  branch?: string;
  pr?: number;
  verdict?: string;
}

/** The ledger cleanup as the Requests tab shows it. */
export interface LedgerCleanupState {
  enabled: boolean;
  everyHours: number;
  lastRunAt?: string;
  /** What the last run did, in a line ("closed 2, resumed 1, stalled 3"), or "nothing to do". */
  lastSummary?: string;
  running?: boolean;
}

/** One thing the intake saw and what it did with it (the Intake tab's log). */
export interface IntakeEntry {
  at: string;
  source: WorkSourceKind;
  /** filed: a new request; repeat: added to the request it repeats; skipped: a cap or a rule; ignored: not intake; closed: its work merged. */
  action: 'filed' | 'repeat' | 'skipped' | 'ignored' | 'closed';
  /** Cleaned and cut short; a player's text is shown as plain text only. */
  title: string;
  workId?: string;
  why?: string;
  url?: string;
}

/** The intake's settings as the server runs them, and today's numbers (docs/intake.md). Everything defaults to off. */
export interface IntakeSummary {
  discord: {
    enabled: boolean;
    bugChannels: string[];
    requestChannels: string[];
    /** Channels FFBox owns, which the intake never files from (docs/intake.md). */
    ffboxOwned?: string[];
    /** The FF Factory logins trusted Discord ids map to (never the ids themselves). */
    trustedPeople: string[];
    dailyCap: number;
    perReporterPerDay: number;
    autoApprove: { enabled: boolean; maxPerDay: number; bugs: boolean; requests: boolean };
    polledAt?: string;
    error?: string;
  };
  ffbox: {
    enabled: boolean;
    branches: boolean;
    diagnoses: boolean;
    requests: boolean;
    escalations: boolean;
    boardCheck: boolean;
    sendWork: boolean;
    dailyCap: number;
    autoApprove: { enabled: boolean; maxPerDay: number };
    /** The FFBox desync PR policy (w358): such PRs are approved at once, at most maxPerDay a day. Optional for an older page. */
    desync?: { enabled: boolean; maxPerDay: number };
    /** The FFBox crash-fix policy (w1827): crash and hang diagnoses are approved at once, at most maxPerDay a day. Optional for an older page. */
    crash?: { enabled: boolean; maxPerDay: number };
  };
  release: { enabled: boolean; delayMinutes: number; lastVersion?: string; checkedAt?: string };
  /** The nightly e2e lab's regressions (config intake.nightly); optional for a page from before it existed. */
  nightly?: {
    enabled: boolean;
    autoApprove: { enabled: boolean; maxPerDay: number };
    dailyCap: number;
    flakyNights: number;
    batchOver: number;
    /** The last report the lab posted, and what it came to. */
    last?: { at: string; date: string; lab: string; sha: string; filed: number; attached: number; skipped: number };
    /** The portal's nightly schedule (w864, config intake.nightly.run) and its next fire; optional for an older page. */
    run?: { enabled: boolean; time: string; tz: string; machine: string; person?: string; reportWithinHours: number; next?: string };
    /** The last nights, newest first (w864). */
    nights?: NightlyNight[];
    /** The nightly merge review's schedule (w905, config intake.nightly.review) and its next fire; optional for an older page. */
    review?: { enabled: boolean; time: string; tz: string; machine: string; person?: string; next?: string };
    /** The last reviews, newest first (w905). */
    reviews?: NightlyReview[];
  };
  /** Who approves what needs a human and answers design questions (config intake.reviewers; default the owner). */
  reviewers: string[];
  /** Their user ids: only they see Approve and Decline. */
  reviewerIds: string[];
  today: { filed: number; skipped: number; autoApproved: number; pending: number };
  recent: IntakeEntry[];
}

/** This app's version (root package.json) and the short git SHA of the running checkout. */
export interface AppVersion {
  version: string;
  sha?: string;
  /** The web UI build the server serves now (server/webStatic.ts); a page that loaded another reloads. Absent from older servers. */
  web?: string;
}

/**
 * A worker an urgent release's build paused (w1841, server/buildPlans.ts): the build, its computer, and whether it was asked
 * to pause mid-turn (told: the build's done tells it to carry on) or paused between turns (its own next message resumes it).
 */
export interface BuildHold {
  what: string;
  machine: string;
  told: boolean;
}

export interface AppState {
  /** The running server's version; absent from a server older than 0.1.0. */
  app?: AppVersion;
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
  /** The signed-in person's own orchestrator: the chat the home page shows (docs/orchestrators.md). */
  orchestratorId: string;
  /** The dispatcher; absent from a server older than this field. */
  dispatcherId?: string;
  /** Who this page is signed in as; absent from a server older than this field. */
  me?: UserInfo;
  /** The work ledger: every open item, and the ones closed in the last 3 days (at most 100). */
  work?: WorkItem[];
  /** The computers with room for one more worker now (w643: a Queued request while one has room is flagged). */
  room?: string[];
  /** The computers with an agent slot for work that needs no editor (w1098); the same RoomNow as `room` (server/placement.ts). */
  agentRoom?: string[];
  /** Computers with room that a placement hold keeps work off, with who and why (w1089); a Queued request says so. */
  heldRoom?: { id: string; why: string; for: ('game' | 'agent')[] }[];
  /** Computers with room that placement.minPriority reserves for higher work (w1643), with their lowest priority: a request at that level may use them. */
  reservedRoom?: { id: string; min: 'normal' | 'high' | 'urgent'; for: readonly ('game' | 'agent')[] }[];
  /** Each computer with room, id to its platform and no-timed-runs reason (w1944): work it cannot run is not Queued wrongly beside it. */
  roomFit?: Record<string, { platform?: string; noTimedRuns?: string }>;
  /** Since when each computer has had room, `${kind}:${id}` to epoch ms (w1944): room younger than ROOM_STAND_MS is not yet WRONG. */
  roomSince?: Record<string, number>;
  /** How many more workers each computer with room takes, `${kind}:${id}` (w1944): its room goes to that many queued requests, in queue order. */
  roomSlots?: Record<string, number>;
  /** The workers an urgent release's build paused (w1841, server/buildPlans.ts pausedFor), by session id: their requests show Blocked on it. */
  buildHolds?: Record<string, BuildHold>;
  /** Discord and FFBox intake into the ledger (docs/intake.md); absent from a server older than this field. */
  intake?: IntakeSummary;
  /** The ledger cleanup (docs/orchestrators.md, "Ledger cleanup"): its switches and its last run. */
  ledger?: LedgerCleanupState;
  config: { defaultModel: string; models: string[]; defaultBase: string; attachments: AttachmentSettings; live?: { enabled: boolean } };
  settings: AppSettings;
  /** The people the Settings pool menu offers (w1717); absent from a server older than the field. */
  poolPeople?: PoolPerson[];
  /** The live views this person may watch (w1398, docs/live-view.md); absent from a server older than the field. */
  live?: LiveViewInfo[];
}

/**
 * A live view (w1398, docs/live-view.md): the running game in a sandbox's Unity editor, streamed beside the asset
 * agent's conversation. Frames come over the `/live/<sessionId>` WebSocket (binary JPEG messages); its knobs are the
 * shader properties of `materials`, read and moved through `/api/live/<sessionId>/knobs` and `.../knob`.
 */
export interface LiveViewInfo {
  liveId: string;
  /** The agent's session: the view sits beside its conversation. */
  sessionId: string;
  machineId: string;
  sandbox: string;
  /** starting: asking the game; live: frames arrive; holding: the game is not streaming (detail says why); stopped. */
  state: 'starting' | 'live' | 'holding' | 'stopped';
  detail: string;
  fps: number;
  width: number;
  /** The materials whose shader properties are the knobs, as the game names them (e.g. "VfxComet"). */
  materials: string[];
  startedAt: string;
  updatedAt: string;
  /** Frames the portal has passed on since the view started. */
  frames: number;
  /**
   * Why its computer takes no work now, while it does (w1838): a release build, a timed run's bench lock, a pause. The
   * editor of a view that is not streaming cannot start meanwhile (shared/liveReady.ts says so on the badge and the panel).
   */
  hold?: string;
  /** A person opened it while it was not streaming and its worker was asked to stage it again (w1838): who and when. */
  wake?: { at: string; who: string };
  /** The one-line summary of its stage recipe (w1839: machine/liveStage.ts stageSummary), absent while it has none. */
  stage?: string;
  /** The daemon is setting it up again now from the recipe, because `who` opened it (w1839). */
  restaging?: { at: string; who: string };
  /** The daemon's last replay of the recipe (w1839): when, whether it worked, why not, and how long each leg took (ms). */
  staged?: { at: string; ok: boolean; detail: string; ms: number; legs: Record<string, number> };
}

/**
 * One step of a Live view's stage recipe (w1839, docs/live-view.md "Staged again without a turn"). `load` (a save name) comes
 * first when present; the rest run in order once the game is in that save.
 */
export type LiveStageStep = { load: string } | { ffauto: string } | { csharp: string; until?: string; timeoutS?: number };

/** One knob: a material's shader property (the game's look.material.list). */
export interface LiveKnob {
  name: string;
  label: string;
  type: 'float' | 'range' | 'int' | 'color' | 'vector';
  /** A number, or [r, g, b, a] / [x, y, z, w]. */
  value: number | number[];
  min?: number;
  max?: number;
  /** A colour that may go above 1 (an emission). */
  hdr?: boolean;
  attributes?: string[];
  /** Moved in this play session and not yet put back. */
  moved?: boolean;
  /**
   * Why moving it cannot change the picture (w1509), from the game: something else sets this property (a script every
   * frame, a MaterialPropertyBlock, Entities Graphics per entity). The page shows such a knob apart, with this reason.
   */
  driven?: string;
}

export interface LiveMaterialKnobs {
  material: string;
  shader?: string;
  knobs: LiveKnob[];
  /** Why the knobs could not be read (the game not in play mode, an unknown material). */
  error?: string;
}

/** POST /api/live/<sessionId>/knob */
export interface LiveKnobRequest {
  material: string;
  name: string;
  value: number | number[];
}

/** An orchestrator's timer as its person sees it (server/timers.ts TimerView; docs/orchestrators.md "Timers"). */
export interface TimerInfo {
  id: string;
  owner: string;
  title: string;
  note: string;
  scheduleText: string;
  state: 'active' | 'paused' | 'ended';
  createdAt: string;
  createdBy: string;
  nextFireAt?: string;
  lastFiredAt?: string;
  lastDeliveredAt?: string;
  fires: number;
  /** Fires waiting to be delivered (after the current turn, or for the budget). */
  pending?: number;
  skipped?: number;
  until?: string;
  maxFires?: number;
  endedAt?: string;
  endReason?: 'fired' | 'until' | 'max_fires' | 'cancelled';
}

/** GET /api/timers/<orchestrator id>. */
export interface TimersAnswer {
  timers: TimerInfo[];
  deliveredToday: number;
  limits: { activePerOwner: number; deliveriesPerDay: number; minEveryMinutes: number };
}

/** Pushed over the WebSocket at /ws. */
export type ServerEvent =
  | { type: 'state'; state: AppState }
  | { type: 'live'; views: LiveViewInfo[] }
  | { type: 'session'; session: SessionInfo }
  | { type: 'session_removed'; id: string }
  | { type: 'standing'; agent: StandingAgent }
  | { type: 'standing_removed'; id: string }
  | { type: 'delegation'; request: DelegationRequest }
  | { type: 'machine'; machine: Machine }
  /**
   * Something worth a notification; pages without a push subscription may show it themselves. `users`: the people
   * it is for (user ids); only their pages get it. Absent: everyone.
   */
  | { type: 'notify'; notice: { kind: NotifyKind; title: string; body: string; url: string; tag: string }; users?: string[] }
  | { type: 'work'; item: WorkItem }
  | { type: 'intake'; intake: IntakeSummary }
  | { type: 'ledger'; ledger: LedgerCleanupState }
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
  /** Ids of files uploaded first (POST /api/attachments, docs/attachments.md). */
  attachments?: string[];
  /** A reply (w866): the transcript seq of the message in this orchestrator chat it answers; the server quotes it to the orchestrator. */
  replyTo?: number;
  /** Names this send (w893): the page sends the same id again after an answer that never came, and the server takes the message once. */
  clientId?: string;
}

/** An emoji reaction on a message of a person's orchestrator chat (w866), or taking it back with on: false. */
export interface ReactRequest {
  seq: number;
  emoji: string;
  on?: boolean;
}

/** A click on a button of a question with buttons (ask_person, w1397): the question's transcript seq and the option's index. */
export interface AnswerRequest {
  seq: number;
  choice: number;
  clientId?: string;
  /** Files uploaded first (POST /api/attachments) that go with the answer (w1912). */
  attachments?: string[];
}

export interface PermissionDecisionRequest {
  requestId: string;
  allow: boolean;
  message?: string;
}

// ---------------------------------------------------------------- the token vault (docs/vault.md, w512)

export type VaultKind = 'claude' | 'github' | 'env' | 'github-app';
/** The roles a machine run has (config claudeAccounts' names): sandbox workers, standing agents. */
export type VaultRole = 'workers' | 'standing';
/** owner: only work the entry's owner asked for. anyone: any run it is granted to. */
export type VaultShare = 'owner' | 'anyone';

/** A vault entry as anyone may see it: never its value. */
export interface VaultEntryMeta {
  id: string;
  name: string;
  kind: VaultKind;
  /** kind env: the variable the value is given as. */
  env?: string;
  /** A portal user id: whose account or secret it is. */
  owner?: string;
  /**
   * kind claude: the email of the Claude account the token belongs to, as recorded by whoever added it (w785). Not a secret and
   * not read from the token: a `claude setup-token` token reveals no account, so it is only ever what a person typed. Shown on the
   * accounts list; absent when nobody recorded one.
   */
  email?: string;
  share: VaultShare;
  roles: VaultRole[];
  /** Machine ids, or ["*"] for every machine. */
  machines: string[];
  /** kind github-app (w1519, docs/github-apps.md): the app's App ID or Client ID, the JWT's issuer. Not a secret. */
  appId?: string;
  /**
   * kind github-app: the accounts whose installations are used ("Gherik1"), the allowlist. A public app can be installed by
   * anyone; an installation on any other account is ignored and shown on the health line, never used.
   */
  appOwners?: string[];
  /** kind github-app: only these installation ids (optional; within appOwners). */
  installations?: number[];
  /** kind github-app: uninstall the app from accounts not in appOwners (DELETE /app/installations/{id}); default off. */
  uninstallOthers?: boolean;
  disabled?: boolean;
  /** The first 12 hex characters of the value's SHA-256 (for a Claude token, the usage meters' key without "token:"). */
  fingerprint: string;
  last4: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
}

export interface VaultStatus {
  /** loaded: values can be handed out. missing: no key configured. unreadable: the key file cannot be read. wrong: it did not seal these entries. */
  key: 'loaded' | 'missing' | 'unreadable' | 'wrong';
  why?: string;
  keyFile?: string;
  entries: number;
}

/** What one probe read says a GitHub token may read (w868): read, denied (403), the repository not selected (404), or no answer. */
export type GithubAccess = 'read' | 'denied' | 'not-selected' | 'error';

/**
 * A vault GitHub token's health (w868, server/githubTokens.ts), by fingerprint: whose it is, the GitHub account it acts as,
 * its expiry, which reads it has per repository (write permissions cannot be read without writing), its last use and last
 * error. Never its value.
 */
export interface GithubTokenHealth {
  fingerprint: string;
  name: string;
  last4: string;
  owner?: string;
  disabled?: boolean;
  /** GET /user: the account the token acts as. */
  login?: string;
  userId?: number;
  /** The GitHub-Authentication-Token-Expiration header, as ISO; absent for a token without one. */
  expiresAt?: string;
  checkedAt?: string;
  /** Why no run gets it now (GitHub answered 401); cleared by a probe that passes. */
  bad?: string;
  /** Per required repository (shared/githubRequirements.ts), each permission's read half as probed (w904). */
  repos?: { repo: string; access: Partial<Record<GithubPermissionId, GithubAccess>> }[];
  /** The organization's reads: Self-hosted runners and Artifact metadata. */
  org?: Partial<Record<GithubPermissionId, GithubAccess>>;
  /** What it lacks of the requirements, as a person fixes it; empty when nothing (w904). */
  problems?: string[];
  /** The portal's own gh login (D7), not a vault entry. */
  portal?: boolean;
  /**
   * GitHub is rate limiting this credential's account: not a missing permission, so `repos`, `org` and `problems` keep the
   * last verdict. Cleared by the first good call after it (w1186).
   */
  rateLimit?: GithubRateLimit;
  lastUse?: { at: string; what: string };
  lastError?: { at: string; what: string };
}

/**
 * A vault GitHub App's health (w1519, server/githubApps.ts): whether GitHub takes its key, where it is installed, what each
 * installation grants and covers, and its token's expiry. Never the key or a token.
 */
export interface GithubAppHealth {
  fingerprint: string;
  name: string;
  last4: string;
  owner?: string;
  disabled?: boolean;
  appId?: string;
  /** GET /app: its slug ("ff-factory-mods") and owner account, when the key works. */
  slug?: string;
  appOwner?: string;
  checkedAt?: string;
  /** Why it is not used now (GitHub refused the key: 401); cleared by a read that passes. */
  bad?: string;
  installations?: {
    id: number;
    account: string;
    /** On the allowlist (appOwners, installations): used. Off it: ignored (or uninstalled with uninstallOthers). */
    allowed: boolean;
    selection?: 'all' | 'selected';
    /** "owner/name", as GitHub lists them for the installation (allowed installations only). */
    repos?: string[];
    /** The installation's granted permissions ("contents": "write", …). */
    permissions?: Record<string, string>;
    suspended?: boolean;
    /** The current token's expiry (ISO), allowed installations only. */
    tokenExpiresAt?: string;
    /** Set when it was uninstalled for being off the allowlist. */
    uninstalledAt?: string;
  }[];
  /** What it lacks, as a person fixes it; empty when nothing. */
  problems?: string[];
  lastUse?: { at: string; what: string };
  lastError?: { at: string; what: string };
}

/** One rate-limit refusal GitHub gave a credential (w1186, server/githubTokens.ts rateLimitOf). */
export interface GithubRateLimit {
  at: string;
  /** X-RateLimit-Reset (or Retry-After) as ISO, when GitHub said. */
  resetAt?: string;
  /** Not probed again before this: the reset, else a few minutes on. */
  retryAt: string;
  /** A secondary (abuse) limit, not the hourly budget. */
  secondary?: boolean;
  /** The account GitHub named ("for user ID 10092359"). */
  userId?: number;
  /** GitHub's own words, one line. */
  message: string;
}

/** What the owner's vault dialog shows (GET /api/vault). */
export interface VaultView {
  status: VaultStatus;
  entries: VaultEntryMeta[];
  kinds: VaultKind[];
  roles: VaultRole[];
  people: { userId: string; displayName: string }[];
  machines: { id: string; online: boolean; claudeFromVault: boolean; githubFromVault?: boolean }[];
  /** Machines that hold a credential now. */
  enrolled: string[];
  /** The GitHub tokens' health (w868), and whether the portal's own reads use them (machines.githubFromVault "portal"). */
  github?: GithubTokenHealth[];
  githubPortal?: boolean;
  /** The GitHub Apps' health (w1519). */
  githubApps?: GithubAppHealth[];
}

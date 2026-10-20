// The WebSocket protocol between the portal (server/machines.ts) and a machine daemon
// (machine/daemon.ts). JSON messages, one per frame. Types only, plus the version constant.
import type { OutsideWatchConfig } from '../machine/outsideWatch.ts';
import type { CatalogTool, LaunchSpec } from './launch.ts';
import type { AccountIdentity } from './usage.ts';
import type { StaleContext } from './staleOutput.ts';
import type { SessionOwner } from './resumable.ts';
import type { RemoteVoiceStatus } from '../shared/voice.ts';
import type { GhLogin } from '../shared/ghLogin.ts';
import type { GhAppToken } from '../shared/githubAppRoute.ts';
import type { AttachmentRef, BenchLock, CompactionTrigger, CleanupSummary, HostHealth, HostStats, ImageFile, ImageInput, Machine, MachinePause, MachineSandbox, PermissionMode, PlanUsage, Requester, SandboxPoolSettings, SessionInfo, TranscriptEvent, UnitySlotsReport } from '../shared/types.ts';

/**
 * Bumped when what the portal and a daemon send each other changes (machineProtocol.test.ts fails until someone
 * decides: a bump, or a new fingerprint for a change both sides ignore safely). Only a protocol outside the range
 * both sides serve makes a daemon outdated (OLDEST_DAEMON_PROTOCOL, OLDEST_PORTAL_PROTOCOL; w605), never its commit.
 * 4: the daemon reports its Mac's load (`stats`), its own Claude login's plan usage (`usage`) and its agents' rate
 * limits (a `rateLimit` signal).
 * 5: machine sandboxes (docs/machines.md, "Machine sandboxes"): `sandbox` ops, `sandbox` on `switch` and `unity`, the
 * pool settings in `welcome`, and the daemon's `sandboxes` snapshots. A protocol-4 daemon would ignore the sandbox
 * field of a switch or unity message and act on the main clone, so the portal never sends one to it.
 * 6: the portal's own host as a machine (docs/beast-machine.md): the `adopt` and `release` sandbox ops (a worktree
 * that already exists is taken into the pool, or dropped from it, without touching the folder), and the pool
 * settings' `maxAgents`, `librarySeed`, `librarySeedCopy`, `librarySeedGB`, `belowNormal` and `protectedPaths`.
 * 7: attachments (docs/attachments.md): `attachments` on `send`, which the daemon fetches into the place's Inbox
 * (GET /machine/attachments/<id> with its token) before the message goes to the agent, and the `fetch_attachment` tool.
 * A protocol-6 daemon would drop them, so the portal never sends it any.
 * 8: `relocate` (w466, docs/machines.md "Moving the portal"): a connected daemon is told the portal's new URL, keeps it
 * in its daemon.json and dials it, its agents running on; it falls back to the URL before if the new one never answers. * Also (w466, unreleased with it): `guard` in the hello, a daemon running the host guard (machine/hostGuard.ts: BEAST's
 * sandbox drive, its disks, the browser reaper), and its `host_report` and `host_health` messages.
 * 9: `clear_batch` as a `unity` action (w791): the daemon looks for the sandboxes' orphaned or hung `-batchmode` builds that
 * hold Unity slots and ends them. A protocol-8 daemon would take any unknown action for a start of the sandbox's editor,
 * so the portal never sends it one.
 * Also (w615, no bump): a daemon's GPU Whisper, `voice` in the hello and `voice` status messages, which an older portal
 * ignores, and `transcribe`/`voice_warm`, which the portal sends only to a daemon that offered it.
 * Also (w656, no bump): `saveWork` in the hello and `save_work`, sent only to a daemon that offered it, answered by
 * `save_result`, which an older portal never asks for and drops.
 * Also (w1463, no bump): `gh_login`, the machine's gh account and scope names, which an older portal drops.
 * Also (w1519, no bump): `ghApp` in the hello and `gh_app_tokens`, GitHub App installation tokens, sent only to a daemon that
 * offered it.
 */
export const PROTOCOL_VERSION = 9;

/**
 * The oldest daemon protocol this portal still drives (w605). A daemon is versioned by this protocol, not by the commit
 * it was installed from: one from another commit whose protocol is in range takes, starts and resumes agents like a
 * current one, and the portal only says an update is available. The portal gates each newer feature on the daemon's
 * own protocol (SANDBOX_PROTOCOL and the rest below), so at least the previous protocol keeps working: raise this only
 * when the portal can no longer drive a daemon that old.
 */
export const OLDEST_DAEMON_PROTOCOL = 7;

/**
 * The oldest portal protocol a daemon still serves (w605), sent in its hello as `oldestPortal`: a daemon updated before
 * its portal keeps working with it. Raise it only when the daemon needs something an older portal never sends.
 */
export const OLDEST_PORTAL_PROTOCOL = 7;

/**
 * Why a daemon and a portal speaking `portal` cannot work together, or undefined (w605): the daemon's protocol is older
 * than the oldest the portal drives, or the daemon no longer serves a portal that old. Another commit is no reason.
 */
export function protocolProblem(daemon: { protocol: number; oldestPortal?: number }, portal = PROTOCOL_VERSION, oldestDaemon = OLDEST_DAEMON_PROTOCOL): string | undefined {
  if (!(daemon.protocol >= oldestDaemon)) return `it speaks protocol ${daemon.protocol}, and this portal needs ${oldestDaemon} or later`;
  if (daemon.oldestPortal !== undefined && daemon.oldestPortal > portal) return `it speaks protocol ${daemon.protocol} and serves portals from protocol ${daemon.oldestPortal}, and this portal speaks ${portal}`;
  return undefined;
}

/** The oldest protocol that understands machine sandboxes. */
export const SANDBOX_PROTOCOL = 5;

/** The oldest protocol that can adopt and release existing worktrees (the host migration, server/hostMigration.ts). */
export const ADOPT_PROTOCOL = 6;

/** The oldest protocol that fetches attachments (docs/attachments.md). */
export const ATTACHMENT_PROTOCOL = 7;

/** The oldest protocol that ends orphaned and hung batch builds on request (`unity clear_batch`, w791). */
export const BATCH_CLEAR_PROTOCOL = 9;

/** The oldest protocol that follows the portal to a new URL without a redeploy (`relocate`, w466). */
export const RELOCATE_PROTOCOL = 8;

/** How long a relocated daemon dials only its new URL before it tries the one before too, every other time. */
export const RELOCATE_FALLBACK_MINUTES = 10;

/** Why `url` cannot be a portal URL a daemon dials (a base URL: http(s), a host, no path), or undefined. */
export function relocateProblem(url: string): string | undefined {
  if (!/^https?:\/\/[^/\s?#]+$/.test(url)) return `"${url}" is not a portal base URL (http:// or https://, a host and port, no path), e.g. https://<host>.<tailnet>.ts.net`;
  try {
    new URL(url);
  } catch {
    return `"${url}" is not a URL`;
  }
  return undefined;
}

/** What the daemon reports of a sandbox; the portal adds purpose and sessionIds (MachineSandbox). */
export type DaemonSandbox = Omit<MachineSandbox, 'purpose' | 'sessionIds'>;

/** rateLimit (protocol 4): an agent there hit a rate limit, so the portal fetches the token's usage sooner. */
export type SignalName = 'turnEnd' | 'permission' | 'result' | 'ended' | 'rateLimit';

/** The refusal of unity and switch on a machine's main clone, by the portal and by the daemon (w536). */
export const MAIN_CLONE_NO_AGENTS = "a machine's main clone takes no agents (w536): give a sandbox";

export type ToDaemon =
  /**
   * First message after connecting: the portal's sessions on this machine and where their transcripts end.
   * `maxSessions` (its name kept so an older daemon still reads it, w536): the machine's agent cap, which the daemon
   * applies to agents outside sandboxes (standing agents) with its sandboxes' mid-turn agents counted in.
   */
  | { type: 'welcome'; machineId: string; maxSessions: number; sessions: { id: string; lastSeq: number }[]; sandboxes?: SandboxPoolSettings | null; resumable?: string[]; wakes?: Record<string, string>; owners?: Record<string, SessionOwner> }
  /**
   * The sessions here whose temp folder must survive while they are stopped: a request they are on still waits for them
   * (server/resumable.ts, w1097). Sent in the welcome and again whenever the set changes; the daemon's sweep and clean-up
   * passes leave those folders (machine/daemon.ts cleanupGuard). An older daemon ignores it and sweeps as before.
   * `wakes` (w1196): the pending wake_me check-ins of the machine's sessions (ISO), sent with it and on each change: what
   * a stopped worker left running stays until its check-in is due (machine/leftovers.ts). An older daemon ignores it.
   * `owners` (w1379): each session of the machine with a request not yet closed, with every request it is on and its
   * status (server/resumable.ts ownersOf). The daemon writes it, with its own facts, to the file `ff-leftovers folders`
   * reads, so a clean-up worker's deletes are checked against the ledger. An older daemon ignores it.
   */
  | { type: 'resumable'; sessionIds: string[]; wakes?: Record<string, string>; owners?: Record<string, SessionOwner> }
  /**
   * Start the session's process if needed (from `spec`) and send it a message. `attachments` (protocol 7): files the
   * daemon fetches into `<spec.cwd>/Inbox/` first; the message then names where each is, or why it is not.
   */
  | { type: 'send'; info: SessionInfo; lastSeq: number; spec: LaunchSpec; text: string; from: 'human' | 'orchestrator' | 'system'; uuid: string; images?: ImageInput[]; requestedBy?: Requester; attachments?: AttachmentRef[] }
  /** Read an image file (under the daemon's roots) or list the recent ones: the Screenshots gallery and inline images. */
  /** sessionId: whose image, so its own temp folder counts too (older daemons ignore it). */
  | { type: 'fs'; id: string; op: 'read'; path: string; sessionId?: string }
  | { type: 'fs'; id: string; op: 'list'; dirs?: string[] }
  | { type: 'interrupt' | 'stop' | 'remove'; sessionId: string }
  /**
   * Compact a live, idle agent's conversation (w1469, the workers' automatic compaction, server/autoCompact.ts): Claude
   * Code's /compact with this focus. Sent only to a daemon whose hello offered `compact`; a session that is not live or is
   * mid-turn is left alone (the portal tries again after a later turn).
   */
  | { type: 'compact'; sessionId: string; focus: string; auto: { trigger: Exclude<CompactionTrigger, 'person' | 'claude'>; reason: string } }
  /**
   * Switch the clone's branch (server/switchBranch.ts); answered by switch_result. callerSessionId: the agent that called
   * switch_branch, mid-turn by definition, so not counted as busy (w422; older daemons ignore it and refuse their caller).
   * githubToken (w868, no bump): the GitHub token of the person the work is for, from the vault, for the switch's push and
   * fetch (as on save_work); absent, the machine's own login. An older daemon ignores it and uses its own login.
   */
  | { type: 'switch'; id: string; branch: string; createFrom?: string; sandbox?: string; callerSessionId?: string; githubToken?: string }
  /**
   * A sandbox (protocol 5, machine/sandboxes.ts), answered by sandbox_result: create (returns once recorded; progress
   * comes in `sandboxes` snapshots), delete (returns when it is gone), log (the tail of its editor log).
   */
  | { type: 'sandbox'; id: string; op: 'create'; sandbox: string; branch: string; base: string; seedLibrary: boolean; startUnity: boolean }
  | { type: 'sandbox'; id: string; op: 'delete'; sandbox: string; deleteBranch?: boolean }
  | { type: 'sandbox'; id: string; op: 'log'; sandbox: string; lines: number }
  /**
   * Protocol 6: take a worktree that already exists into the pool as it is (the host migration): nothing on disk is
   * created, copied or deleted, and an editor already running on it is found by the next look.
   */
  | { type: 'sandbox'; id: string; op: 'adopt'; sandbox: string; path: string; branch: string; base: string; createdAt: string; logPath?: string }
  /** Protocol 6: forget a sandbox without touching its folder, branch or editor (the migration back). */
  | { type: 'sandbox'; id: string; op: 'release'; sandbox: string }
  /** Report git status now (after an agent turn), not at the next minute. */
  | { type: 'status_now' }
  | { type: 'mode'; sessionId: string; mode: PermissionMode }
  | { type: 'decide'; sessionId: string; requestId: string; allow: boolean; message?: string }
  | { type: 'rpc_result'; id: string; ok: boolean; text: string }
  /** The Unity editor of the machine's clone (machine/unity.ts); answered by unity_result. */
  | { type: 'unity'; id: string; action: 'status' | 'start' | 'stop' | 'restart' | 'clear_batch'; force?: boolean; sandbox?: string }
  /** Watch this portal's host from outside (machine/outsideWatch.ts); null: this machine does not watch. Kept on the Mac. */
  | { type: 'outside_watch'; config: OutsideWatchConfig | null }
  /** The daemon's clean-up settings (server/cleanup.ts), at connect and when they change. Kept on the machine. */
  | { type: 'cleanup_config'; config: { everyMinutes: number; softFreeGB: number; staleOutput?: unknown } }
  /** This machine's activity pause (w1574, config machines.activityPause): at connect and when it changes. */
  | { type: 'activity_config'; config: { enabled: boolean; idleMinutes: number } }
  /** The ledger's facts for the stale-output rules (w459): which requests are open and closed. At connect and every few minutes. */
  | { type: 'cleanup_context'; context: StaleContext }
  /**
   * A clean-up pass now (the orchestrator asked); answered by a `cleanup` report. With `id`, also by a `cleanup_result`
   * carrying the pass's summary; `dryRun`: plan only, nothing removed (older daemons ignore both and run a real pass).
   */
  | { type: 'cleanup_now'; id?: string; dryRun?: boolean }
  /** Dial the portal at this base URL from now on (protocol 8, w466); answered by relocate_result, then the link closes. */
  | { type: 'relocate'; id: string; url: string }
  /** How often the daemon polls its Mac's own Claude login's plan usage (config usagePollMinutes), at connect and when it changes. */
  | { type: 'usage_config'; config: { everyMinutes: number } }
  /** Poll that usage now (the usage meters' Refresh); answered by a `usage` report. A daemon before these ignores both. */
  | { type: 'usage_now' }
  /**
   * A dictation clip for this machine's GPU Whisper (w615, machine/voice.ts), answered by transcribe_result. Sent only to a
   * daemon whose hello or `voice` status offered it, so an older daemon never gets one. `audio`: a 16-bit PCM WAV, 16 kHz
   * mono, in base64 (300 s at most); `prompt`: Whisper's vocabulary. Neither is logged.
   */
  | { type: 'transcribe'; id: string; audio: string; prompt?: string; language?: string | null }
  /** A recording started on the portal: load the model now if it is not loaded (w615). */
  | { type: 'voice_warm' }
  /**
   * Commit and push a sandbox's uncommitted work on `branch` before the portal releases it (w656, server/saveWork.ts),
   * answered by save_result. Refused while an agent there has a process. Sent only to a daemon whose hello offered
   * `saveWork`, so an older daemon never gets one.
   */
  | { type: 'save_work'; id: string; sandbox: string; branch: string; message: string; githubToken?: string }
  /** GitHub App installation tokens for this machine's runs (w1519, docs/github-apps.md): the whole set, each time it changes. */
  | { type: 'gh_app_tokens'; tokens: GhAppToken[] }
  /**
   * A live view (w1398, docs/live-view.md), answered by `live_result`. start: stream the sandbox's running game to the
   * portal at /machine/live/<liveId>; stop; command: one of the game's live commands (look.material.list|set|reset), with
   * `note` (who moved which knob) written into the session's conversation, held for its next message and counted as
   * activity. Sent only to a daemon whose hello offered `liveView`, so an older daemon never gets one.
   */
  | { type: 'live'; id: string; op: 'start' | 'stop' | 'command'; liveId: string; sessionId: string; sandbox: string; fps?: number; width?: number; materials?: string[]; command?: string; note?: string };

/** A live view a daemon runs (w1509), as its hello reports it. */
export interface DaemonLiveView {
  liveId: string;
  sessionId: string;
  sandbox: string;
  fps: number;
  width: number;
  materials: string[];
  state: 'starting' | 'live' | 'holding' | 'stopped';
  detail: string;
  frames: number;
}

export type FromDaemon =
  /**
   * `catalog`: the MCP tools this daemon can serve (protocol 3+). info.daemon is the commit it was deployed from, which
   * only tells the portal an update is available (w605). `oldestPortal` (w605): the oldest portal protocol it serves;
   * an older daemon sends none.
   */
  | {
      type: 'hello';
      protocol: number;
      oldestPortal?: number;
      /** Its agents run in agent hosts that outlive it (w605, machine/agentHost.ts): a restart of it stops none. */
      agentHosts?: boolean;
      info: NonNullable<Machine['info']>;
      home: string;
      live: string[];
      catalog?: string[];
      guard?: boolean;
      /** Its GPU Whisper for the portal's mic (w615, daemon.json `voice`): absent when it is off. An older portal ignores it. */
      voice?: RemoteVoiceStatus;
      /** It saves a sandbox's uncommitted work on request (w656, `save_work`). An older portal ignores it. */
      saveWork?: boolean;
      /** It streams a sandbox's running game for a live view (w1398, `live`). An older portal ignores it. */
      liveView?: boolean;
      /**
       * The live views it runs now (w1509): a portal that restarted takes them back, and one whose views are missing here
       * (this daemon restarted) starts them again. An older daemon sends none; an older portal ignores it.
       */
      liveViews?: DaemonLiveView[];
      /** It keeps GitHub App installation tokens for its runs (w1519, `gh_app_tokens`). An older portal ignores it. */
      ghApp?: boolean;
      /** It compacts an idle agent's conversation on request (w1469, `compact`) and says a compaction's turn end in `signal` `meta`. An older portal ignores it. */
      compact?: boolean;
      /** Its owner's pause (w1532, machine/pause.ts): from its tray, its schedule or a person's input. An older portal ignores it. */
      pause?: MachinePause;
      /** A worker root install (w513): its folders, so a record made without a deploy learns them. */
      layout?: { root: string; appDir: string; repoPath: string; tempDir?: string; sandboxes?: SandboxPoolSettings | null };
    }
  /** Its host guard has news for people (protocol 8, w466): the drive gone or back, disk space, a reaped browser. Relayed like the portal's own guard's. */
  | { type: 'host_report'; title: string; body: string }
  /** Its pause changed (w1532): paused or running, why, until when. A paused machine is held and its workers hand back. */
  | { type: 'pause'; pause: MachinePause }
  /** The tray turned the activity pause on or off (w1574): the portal keeps it as this machine's machines.activityPause. */
  | { type: 'activity_set'; activity: { enabled: boolean; idleMinutes: number } }
  /** Its host guard's state, when it changes (protocol 8, w466). */
  | { type: 'host_health'; health: Pick<HostHealth, 'checkedAt' | 'sandboxRoot' | 'level' | 'detail' | 'blocked'> }
  /** The session's current record (the daemon's AgentSession changed it). */
  | { type: 'session'; info: SessionInfo; live: boolean }
  | { type: 'event'; sessionId: string; event: TranscriptEvent }
  | { type: 'amend'; sessionId: string; seq: number; patch: Partial<TranscriptEvent> }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'signal'; name: SignalName; sessionId: string; arg?: unknown; meta?: { compaction?: CompactionTrigger } }
  /** A send the daemon could not carry out (limit, bad spec). `host_start` (w691): no agent host could be started for it. */
  | { type: 'failed'; sessionId: string; error: string; reason?: 'host_start' }
  /** An MCP tool call to be answered by the portal. */
  | { type: 'rpc'; id: string; sessionId: string; method: CatalogTool; args: Record<string, unknown> }
  | { type: 'status'; git?: Machine['git'] }
  /** An image a session produced (a tool result), stored by the portal under this id before the event naming it. */
  | { type: 'image'; sessionId: string; id: string; mediaType: string; data: string }
  | { type: 'switch_result'; id: string; ok: boolean; error?: string; from?: string; to?: string; notes?: string[] }
  /** The answer to save_work (w656): the commit made (none when there was nothing to save), or why not. */
  | { type: 'save_result'; id: string; ok: boolean; error?: string; sha?: string; files?: number; pushed?: boolean; notes?: string[] }
  /** The daemon took the new portal URL (kept in its daemon.json) and is about to dial it, or why not (protocol 8). */
  | { type: 'relocate_result'; id: string; ok: boolean; error?: string }
  | { type: 'fs_result'; id: string; ok: boolean; error?: string; mediaType?: string; data?: string; files?: ImageFile[] }
  | { type: 'unity_result'; id: string; ok: boolean; text: string }
  /** The daemon's own Unity watch: a hang or crash noticed, an automatic restart, the budget spent. */
  | { type: 'unity_event'; text: string; restarted: boolean; sandbox?: string }
  /** Every sandbox of the machine, whenever one changes (protocol 5): a full snapshot, at most maxSandboxes entries. */
  | { type: 'sandboxes'; list: DaemonSandbox[]; disk?: { level: 'ok' | 'warn' | 'critical'; freeBytes?: number } }
  | { type: 'sandbox_result'; id: string; ok: boolean; text: string }
  /** The sandbox pool did something the orchestrator should hear of (the disk guard, an idle editor stopped). */
  | { type: 'sandbox_event'; text: string; sandbox?: string; checkpoint?: boolean }
  /**
   * The Mac's CPU, RAM, GPU and disk (server/system.ts), every 15 s (protocol 4+). `unity` (w469): every Unity editor
   * there against max_unity, and the launches waiting for a slot (machine/unitySlots.ts); an older daemon sends none.
   * `benchLock` (w1600): its bench lock while a timed run holds it (machine/benchLock.ts).
   */
  | { type: 'stats'; stats: HostStats; unity?: UnitySlotsReport; benchLock?: BenchLock }
  /** The plan usage of the Mac's own Claude login (not the host token), every config usagePollMinutes and on usage_now (protocol 4+). */
  | { type: 'usage'; account: AccountIdentity; usage: PlanUsage }
  /** A clean-up pass finished; `notice` only when it could not get above the soft threshold (then the orchestrator is told). */
  | { type: 'cleanup'; summary: CleanupSummary; notice?: string }
  /** A clean-up pass in full, as the daemon logged it (w459): kept on the portal too, where people can see it. */
  | { type: 'cleanup_log'; entry: Record<string, unknown> }
  /** The answer to a `cleanup_now` with an id (w459). */
  | { type: 'cleanup_result'; id: string; ok: boolean; summary?: CleanupSummary; error?: string }
  /** A line the ffdiscord CLI appended to the Mac's Max events file (docs/max.md), forwarded as is; the portal validates it. */
  | { type: 'max_event'; line: string }
  /** Its GPU Whisper's state, when it changes (w615): loaded, unloaded for the editors' VRAM, installing. An older portal drops it. */
  | { type: 'voice'; status: RemoteVoiceStatus }
  /** The answer to a `transcribe` (w615): the text and timings, or why not (the portal then uses its own CPU). */
  | { type: 'transcribe_result'; id: string; ok: boolean; error?: string; text?: string; audioSeconds?: number; seconds?: number; model?: string; device?: string; loadSeconds?: number }
  /** The answer to a `live` (w1398): the command's result text (JSON for look.material.list), or why not. */
  | { type: 'live_result'; id: string; ok: boolean; text: string }
  /**
   * The machine's own gh login (w1463, machine/ghLogin.ts): the account and its token's scope names, never the token. After
   * each reading (at start, every 30 minutes, when gh's hosts file changes) and after each hello. An older portal drops it.
   */
  | { type: 'gh_login'; gh: GhLogin }
  /** A live view's state when it changes (w1398): live, holding (detail says why), stopped. An older portal drops it. */
  | { type: 'live_state'; liveId: string; state: 'starting' | 'live' | 'holding' | 'stopped'; detail: string; frames: number };

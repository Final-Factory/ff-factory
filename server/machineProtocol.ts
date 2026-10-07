// The WebSocket protocol between the portal (server/machines.ts) and a machine daemon
// (machine/daemon.ts). JSON messages, one per frame. Types only, plus the version constant.
import type { OutsideWatchConfig } from '../machine/outsideWatch.ts';
import type { CatalogTool, LaunchSpec } from './launch.ts';
import type { AccountIdentity } from './usage.ts';
import type { StaleContext } from './staleOutput.ts';
import type { AttachmentRef, CleanupSummary, HostHealth, HostStats, ImageFile, ImageInput, Machine, MachineSandbox, PermissionMode, PlanUsage, Requester, SandboxPoolSettings, SessionInfo, TranscriptEvent, UnitySlotsReport } from '../shared/types.ts';

/**
 * Bumped when either side must be redeployed to keep talking. 4: the daemon reports its Mac's load
 * (`stats`), its own Claude login's plan usage (`usage`) and its agents' rate limits (a `rateLimit`
 * signal). Nothing breaks either way (a portal ignores messages it does not know), but a protocol-3
 * daemon is outdated, like any daemon after an app update (it runs another commit): new agents wait
 * there until the portal redeploys it once idle, and until then its machine shows no numbers.
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
 */
export const PROTOCOL_VERSION = 8;

/** The oldest protocol that understands machine sandboxes. */
export const SANDBOX_PROTOCOL = 5;

/** The oldest protocol that can adopt and release existing worktrees (the host migration, server/hostMigration.ts). */
export const ADOPT_PROTOCOL = 6;

/** The oldest protocol that fetches attachments (docs/attachments.md). */
export const ATTACHMENT_PROTOCOL = 7;

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
  | { type: 'welcome'; machineId: string; maxSessions: number; sessions: { id: string; lastSeq: number }[]; sandboxes?: SandboxPoolSettings | null }
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
   * Switch the clone's branch (server/switchBranch.ts); answered by switch_result. callerSessionId: the agent that called
   * switch_branch, mid-turn by definition, so not counted as busy (w422; older daemons ignore it and refuse their caller).
   */
  | { type: 'switch'; id: string; branch: string; createFrom?: string; sandbox?: string; callerSessionId?: string }
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
  | { type: 'unity'; id: string; action: 'status' | 'start' | 'stop' | 'restart'; force?: boolean; sandbox?: string }
  /** Watch this portal's host from outside (machine/outsideWatch.ts); null: this machine does not watch. Kept on the Mac. */
  | { type: 'outside_watch'; config: OutsideWatchConfig | null }
  /** The daemon's clean-up settings (server/cleanup.ts), at connect and when they change. Kept on the machine. */
  | { type: 'cleanup_config'; config: { everyMinutes: number; softFreeGB: number; staleOutput?: unknown } }
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
  | { type: 'usage_now' };

export type FromDaemon =
  /** `catalog`: the MCP tools this daemon can serve (protocol 3+); info.daemon is the commit it was deployed from. */
  | {
      type: 'hello';
      protocol: number;
      info: NonNullable<Machine['info']>;
      home: string;
      live: string[];
      catalog?: string[];
      guard?: boolean;
      /** A worker root install (w513): its folders, so a record made without a deploy learns them. */
      layout?: { root: string; appDir: string; repoPath: string; tempDir?: string; sandboxes?: SandboxPoolSettings | null };
    }
  /** Its host guard has news for people (protocol 8, w466): the drive gone or back, disk space, a reaped browser. Relayed like the portal's own guard's. */
  | { type: 'host_report'; title: string; body: string }
  /** Its host guard's state, when it changes (protocol 8, w466). */
  | { type: 'host_health'; health: Pick<HostHealth, 'checkedAt' | 'sandboxRoot' | 'level' | 'detail' | 'blocked'> }
  /** The session's current record (the daemon's AgentSession changed it). */
  | { type: 'session'; info: SessionInfo; live: boolean }
  | { type: 'event'; sessionId: string; event: TranscriptEvent }
  | { type: 'amend'; sessionId: string; seq: number; patch: Partial<TranscriptEvent> }
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'signal'; name: SignalName; sessionId: string; arg?: unknown }
  /** A send the daemon could not carry out (limit, bad spec). */
  | { type: 'failed'; sessionId: string; error: string }
  /** An MCP tool call to be answered by the portal. */
  | { type: 'rpc'; id: string; sessionId: string; method: CatalogTool; args: Record<string, unknown> }
  | { type: 'status'; git?: Machine['git'] }
  /** An image a session produced (a tool result), stored by the portal under this id before the event naming it. */
  | { type: 'image'; sessionId: string; id: string; mediaType: string; data: string }
  | { type: 'switch_result'; id: string; ok: boolean; error?: string; from?: string; to?: string; notes?: string[] }
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
   */
  | { type: 'stats'; stats: HostStats; unity?: UnitySlotsReport }
  /** The plan usage of the Mac's own Claude login (not the host token), every config usagePollMinutes and on usage_now (protocol 4+). */
  | { type: 'usage'; account: AccountIdentity; usage: PlanUsage }
  /** A clean-up pass finished; `notice` only when it could not get above the soft threshold (then the orchestrator is told). */
  | { type: 'cleanup'; summary: CleanupSummary; notice?: string }
  /** A clean-up pass in full, as the daemon logged it (w459): kept on the portal too, where people can see it. */
  | { type: 'cleanup_log'; entry: Record<string, unknown> }
  /** The answer to a `cleanup_now` with an id (w459). */
  | { type: 'cleanup_result'; id: string; ok: boolean; summary?: CleanupSummary; error?: string }
  /** A line the ffdiscord CLI appended to the Mac's Max events file (docs/max.md), forwarded as is; the portal validates it. */
  | { type: 'max_event'; line: string };

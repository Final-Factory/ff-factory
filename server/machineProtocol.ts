// The WebSocket protocol between the portal (server/machines.ts) and a machine daemon
// (machine/daemon.ts). JSON messages, one per frame. Types only, plus the version constant.
import type { CatalogTool, LaunchSpec } from './launch.ts';
import type { ImageFile, ImageInput, Machine, PermissionMode, SessionInfo, TranscriptEvent } from '../shared/types.ts';

/** Bumped when either side must be redeployed to keep talking. */
export const PROTOCOL_VERSION = 3;

export type SignalName = 'turnEnd' | 'permission' | 'result' | 'ended';

export type ToDaemon =
  /** First message after connecting: the portal's sessions on this machine and where their transcripts end. */
  | { type: 'welcome'; machineId: string; maxSessions: number; sessions: { id: string; lastSeq: number }[] }
  /** Start the session's process if needed (from `spec`) and send it a message. */
  | { type: 'send'; info: SessionInfo; lastSeq: number; spec: LaunchSpec; text: string; from: 'human' | 'orchestrator' | 'system'; uuid: string; images?: ImageInput[] }
  /** Read an image file (under the daemon's roots) or list the recent ones: the Screenshots gallery and inline images. */
  | { type: 'fs'; id: string; op: 'read'; path: string }
  | { type: 'fs'; id: string; op: 'list'; dirs?: string[] }
  | { type: 'interrupt' | 'stop' | 'remove'; sessionId: string }
  /** Switch the clone's branch (server/switchBranch.ts); answered by switch_result. */
  | { type: 'switch'; id: string; branch: string; createFrom?: string }
  /** Report git status now (after an agent turn), not at the next minute. */
  | { type: 'status_now' }
  | { type: 'mode'; sessionId: string; mode: PermissionMode }
  | { type: 'decide'; sessionId: string; requestId: string; allow: boolean; message?: string }
  | { type: 'rpc_result'; id: string; ok: boolean; text: string }
  /** The Unity editor of the machine's clone (machine/unity.ts); answered by unity_result. */
  | { type: 'unity'; id: string; action: 'status' | 'start' | 'stop' | 'restart'; force?: boolean };

export type FromDaemon =
  /** `catalog`: the MCP tools this daemon can serve (protocol 3+); info.daemon is the commit it was deployed from. */
  | { type: 'hello'; protocol: number; info: NonNullable<Machine['info']>; home: string; live: string[]; catalog?: string[] }
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
  | { type: 'fs_result'; id: string; ok: boolean; error?: string; mediaType?: string; data?: string; files?: ImageFile[] }
  | { type: 'unity_result'; id: string; ok: boolean; text: string }
  /** The daemon's own Unity watch: a hang or crash noticed, an automatic restart, the budget spent. */
  | { type: 'unity_event'; text: string; restarted: boolean };

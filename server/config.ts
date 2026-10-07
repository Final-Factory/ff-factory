import type { AttachmentConfig } from './attachments.ts';
import type { ReviewConfig } from './review.ts';
import type { DevRequestsConfig } from './devRequests.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode } from '../shared/types.ts';
import { checkObject, dataRecoveries, readJsonDurable } from './durable.ts';
import { staleOutputSettings, type StaleOutputSettings } from './staleOutput.ts';


/** What a portal-run agent runs on (docs/accounts.md): the computer's stored claude.ai login, or config claudeEnv's token. */
/**
 * Which Claude account this host's agents of a role run on: config claudeEnv's token, this host's stored login, or
 * (w464, docs/portal-on-ffbox-host.md change 18) the OAuth token in config claudeTokenFile, read at each session start
 * and given to that process alone. "tokenfile" is for the orchestrator, dispatcher and standing roles, never workers.
 */
export type ClaudeAccount = 'login' | 'token' | 'tokenfile';
export const CLAUDE_ACCOUNTS: readonly ClaudeAccount[] = ['login', 'token', 'tokenfile'];
/** The roles that may run on the token file (TOKEN_FILE): never workers, which run on machines and other people's work. */
export const TOKEN_FILE_ROLES: readonly string[] = ['orchestrator', 'dispatcher'];
/** The roles config claudeAccounts picks an account for, on this host. */
/**
 * The roles config claudeAccounts sets an account for. `dispatcher` (w464, docs/portal-on-ffbox-host.md change 6): when
 * set, the dispatcher runs on it, and not on the system payer's own token; unset, it follows `orchestrator` as before.
 */
export type HostRole = 'orchestrator' | 'dispatcher' | 'workers';
export const HOST_ROLES: readonly HostRole[] = ['orchestrator', 'dispatcher', 'workers'];
const ROLE_NAMES: Record<HostRole, string> = { orchestrator: 'the orchestrator', dispatcher: 'the dispatcher', workers: 'workers' };
/** Roles as people read them: "the orchestrator, workers". */
export const roleNames = (roles: readonly HostRole[]) => roles.map((r) => ROLE_NAMES[r]).join(', ');

/** config.json "intake" (docs/intake.md). Every switch defaults to off, every number to a small cap. */
export interface IntakeConfig {
  discord?: {
    enabled?: boolean;
    /**
     * Forum channels whose new threads are bug reports: aliases from the ffbox config's discord.channels, or ids.
     * Default none; FFBox's channels are never read, whatever this says (docs/intake.md, "FFBox owns #bug-reports").
     */
    bugChannels?: string[];
    /** Channels where trusted people ask Max for work (a message that mentions the bot or replies to it). Default ["dev_chat"]. */
    requestChannels?: string[];
    /** Discord user ids trusted to ask for work, each mapped to an FF Factory login: { "<discord id>": "<user id>" }. Default none. */
    trusted?: Record<string, string>;
    /** Minutes between polls (>= 2, default 5). */
    pollMinutes?: number;
    /** Intake requests filed from Discord per day, all channels (default 10). */
    dailyCap?: number;
    /** Bug reports filed per reporter per day (default 2). */
    perReporterPerDay?: number;
    /** Start without a person's click, at most maxPerDay a day (default off, 3). */
    autoApprove?: { enabled?: boolean; maxPerDay?: number; bugs?: boolean; requests?: boolean };
  };
  ffbox?: {
    enabled?: boolean;
    /** ffbox/* fix branches become "review and merge" requests (default true once ffbox is enabled). */
    branches?: boolean;
    /** Finished diagnoses with a verdict and a branch become review requests (default true once enabled). */
    diagnoses?: boolean;
    /** Requests FFBox files itself (the connector's "request" message; default true once enabled). */
    requests?: boolean;
    /**
     * Take Max's escalations from FFBox (POST /api/intake/ffbox with a key minted --scope ffbox; docs/intake.md,
     * "Escalations from Max"). Default false.
     */
    escalations?: boolean;
    /** Answer the connector's board_check: FFBox asks the ledger before it works a report (default false). */
    boardCheck?: boolean;
    /**
     * How sure a board_check match must be (server/boardMatch.ts): at or above `high` the ledger has it (in_flight or
     * done); at or above `medium` it may (maybe: FFBox goes ahead and the candidates are linked for a person). Defaults
     * 0.7 and 0.45.
     */
    match?: { high?: number; medium?: number };
    /** The game repo as board answers name it to FFBox ("Final-Factory/FinalFactory"); default: from repo.url. */
    repo?: string;
    dailyCap?: number;
    autoApprove?: { enabled?: boolean; maxPerDay?: number };
    /**
     * FFBox desync PRs (Lothsahn, 2026-10-04; docs/intake.md, "FFBox desync PRs"): a desync diagnosis or its ffbox/* PR
     * is approved at once into a review-and-merge request whose worker follows the desync PR policy, at most maxPerDay a
     * day; past that it waits for a reviewer. Default on, 10 a day, inside dailyCap and workLimits.intake.
     */
    desync?: { enabled?: boolean; maxPerDay?: number };
  };
  /** The "live in 0.50.0.X" follow-up: watch the base branch for the release that carries each landed fix. */
  release?: { enabled?: boolean; delayMinutes?: number };
  /**
   * The nightly e2e lab (FinalFactory scripts/nightly) posts each night's results to POST /api/intake/nightly with an
   * API key minted `--scope nightly`: every new regression, and a scenario flaky `flakyNights` nights running, becomes
   * a request, or is added to the open request already on that scenario (docs/intake.md, "Nightly e2e regressions").
   */
  nightly?: {
    enabled?: boolean;
    /** Start without a person's click, at most maxPerDay a day (default off, 10). */
    autoApprove?: { enabled?: boolean; maxPerDay?: number };
    /** Nightly requests filed per day (default 10). */
    dailyCap?: number;
    /** A scenario flaky this many nights running is filed like a regression (default 3). */
    flakyNights?: number;
    /** More new requests than this from one night become one batched request for the night (default 4). */
    batchOver?: number;
  };
  /**
   * The people who decide (user ids, e.g. ["ben", "lothsahn"]): they approve or decline what needs a human and answer
   * design questions; nobody else can. Default: the owner.
   */
  reviewers?: string[];
  /** How far back finished requests count as duplicates (days, default 14). */
  lookbackDays?: number;
}

export interface Config {
  port: number;
  host: string;
  /**
   * Trust X-Forwarded-For/-Proto from a reverse proxy on this machine (Tailscale serve/funnel,
   * Cloudflare tunnel) for rate limiting and Secure cookies. Only loopback peers are believed.
   */
  trustProxy: boolean;
  /**
   * The address machines (docs/machines.md) reach this portal at, e.g. the Tailscale Funnel URL
   * "https://<host>.<tailnet>.ts.net". Optional: add_machine can be given it instead.
   */
  publicUrl?: string;
  /**
   * The name of the person who runs this portal. Agents' prompts call them "the user"; with a name set,
   * each prompt adds one line saying who that is (ownerLine), so agents can address them by name.
   */
  ownerName?: string;
  /**
   * How often the Claude plan usage of every account is polled, in minutes (docs/accounts.md): this host's token,
   * login and people's own tokens, and each machine daemon's login. Default 15. The usage endpoint rate-limits.
   */
  usagePollMinutes: number;
  /**
   * Filing caps of the work ledger's automated sources (docs/orchestrators.md): requests an hour and a day per
   * requester, default 10 and 40 each. People filing through their own orchestrator are never capped.
   */
  workLimits?: Partial<Record<'standing' | 'intake', Partial<{ perHour: number; perDay: number }>>>;
  /**
   * Repos whose history is public, and the identity agents commit to them with. The guard refuses a push
   * to one of `repos` (default: this app's own origin) when a commit in it has an author or committer
   * email that is neither a GitHub noreply address nor `email`. Example:
   * { "name": "Your Name", "email": "12345+you@users.noreply.github.com" }.
   */
  publicGitIdentity?: { name?: string; email?: string; repos?: string[] };
  /**
   * The outside watchdog (docs/self-recovery.md): a machine's daemon checks this host every minute and alerts
   * the user's phone through ntfy. `machine` (default "m5", else the first machine), `healthUrl` (default
   * <publicUrl>/api/health), `host` to ping (default the health URL's host), `ntfyServer` (default ntfy.sh).
   * `enabled: false` turns it off. The ntfy topic is made once, in <dataDir>/outside-watch.json.
   */
  outsideWatch?: { enabled?: boolean; machine?: string; healthUrl?: string; host?: string; ntfyServer?: string };
  /**
   * Machines (docs/machines.md, docs/accounts.md). `useHostClaudeEnv` (default true): portal-run agents on a Mac
   * get this host's `claudeEnv` (so CLAUDE_CODE_OAUTH_TOKEN: the same Claude account as the agents here) instead
   * of the Mac's own login. `false` turns it off everywhere; an object sets it per machine, "*" for the rest:
   * { "m3": false, "m5": false } or { "*": false, "m5": true }.
   */
  machines?: {
    useHostClaudeEnv?: boolean | Record<string, boolean>;
    /**
     * The token vault (docs/vault.md, w512; default false): a machine's runs take their Claude token from the vault,
     * chosen per run by plan headroom, instead of the host token or the machine's own login. Same shape as
     * useHostClaudeEnv: true, false, or per machine with "*" for the rest. A person's own token still wins for their work.
     */
    claudeFromVault?: boolean | Record<string, boolean>;
    /**
     * Each machine daemon's own clean-up (docs/self-recovery.md): a pass every `everyMinutes` (default 60) and
     * sooner below `softFreeGB` (default 80). A number for every machine, or per machine with "*" for the rest.
     */
    cleanup?: {
      everyMinutes?: number | Record<string, number>;
      softFreeGB?: number | Record<string, number>;
      /** The stale build and run output rules on every machine (server/staleOutput.ts, w459); absent: their defaults (on). */
      staleOutput?: Partial<StaleOutputSettings>;
    };
    /**
     * Backlog step 2 (docs/beast-machine.md), off by default: a portal restart or update leaves the agents daemons run
     * running (no drain, no stop), and a daemon from another commit that speaks this portal's protocol still takes new
     * agents (it is redeployed once idle, as before). Turn it on once the host's own daemon has proven itself.
     */
    keepAgentsOnRestart?: boolean;
  };
  /**
   * Which Claude account THIS host's agents run on, per role (docs/accounts.md): "token" (the default) is
   * claudeEnv's CLAUDE_CODE_OAUTH_TOKEN; "login" starts the process with no credential in its environment, so
   * Claude Code uses the claude.ai login stored on this host (the one the usage meters show as "<host> login").
   * `workers`: sandbox workers; `standing`: standing agents on this host. Agents on a Mac follow
   * machines.useHostClaudeEnv instead, and a person's own token (userClaudeEnv) wins for work they asked for.
   */
  claudeAccounts?: Partial<Record<HostRole, ClaudeAccount>>;
  /**
   * Whether each role's agents get the claude.ai connectors of the Claude account they run on (w516): Gmail, Google
   * Drive, Google Calendar, Claude Docs and any other connected on claude.ai, which Claude Code loads by itself on a
   * claude.ai login. Default: off for `orchestrator` (people's own) and `dispatcher`, on for `workers` and `standing`
   * (claudeAiConnectorsFor). Off: Claude Code's `disableClaudeAiConnectors` setting for an orchestrator, its
   * ENABLE_CLAUDEAI_MCP_SERVERS=false for any other process. docs/accounts.md, "claude.ai connectors".
   */
  claudeAiConnectors?: Partial<Record<ConnectorRole, boolean>>;
  /**
   * The file holding the long-lived Claude OAuth token (sk-ant-oat01-…, from `claude setup-token`) the roles set to
   * "tokenfile" run on (w464): read at each session start into that process's CLAUDE_CODE_OAUTH_TOKEN, with every other
   * Claude credential removed. Never in claudeEnv, never sent to a machine, never shown (only its last four characters).
   */
  claudeTokenFile?: string;
  /**
   * The token vault (docs/vault.md, w512): `keyFile`, the file holding its key (32 bytes, base64), outside the data folder.
   * In the VM the systemd credential fff-vault-key wins (deploy/vm/guest/units/fff-portal.service). The vault itself is
   * data/vault.json.
   */
  vault?: {
    keyFile?: string;
    /**
     * Whose vault tokens work nobody asked for by name runs on (w512, lothsahn 2026-10-06), by where it came from: intake
     * (Discord, FFBox reports, releases), ffbox (FFBox-filed work naming no operator), nightly (the nightly lab's reports,
     * the nightly regression sentry and its delegations). Portal user ids; defaults in server/vault.ts UNATTRIBUTED_DEFAULTS.
     */
    unattributed?: Partial<Record<'intake' | 'ffbox' | 'nightly', string>>;
  };
  /**
   * Providers (docs/ffbox-integration.md): FFBox, whose connector dials out to /provider. `enabled` (default
   * false) lets it connect; `tokenSha256` is the SHA-256 of its connector token (ffpv1_…), set with
   * `node server/providerToken.ts` or set_app_config providers.ffbox.token; the token itself is never kept.
   */
  providers?: {
    ffbox?: {
      enabled?: boolean;
      tokenSha256?: string;
      /**
       * Let the dispatcher hand ledger requests to FFBox (send_to_ffbox; docs/intake.md, "Ledger → FFBox"). Default
       * false; a submit also needs a connector that lists "submit" in hello.accepts.
       */
      sendWork?: boolean;
      /** Operators' ffdev turns handed to FF Factory (docs/ffbox.md, "Dev requests"); server/devRequests.ts fills the defaults. */
      devRequests?: DevRequestsConfig;
    };
  };
  /**
   * The intake (docs/intake.md): Discord #bug-reports threads, trusted people's requests to Max in #dev-chat, and
   * FFBox's diagnoses and fix branches become ledger requests. Everything is off unless switched on here. config.json
   * only, except the ffbox block and the reviewers list, which an owner can set with set_app_config intake.ffbox / intake.reviewers. Read by server/intakeRules.ts intakeSettings(), which fills the defaults.
   */
  intake?: IntakeConfig;
  /**
   * The ledger cleanup (docs/orchestrators.md, "Ledger cleanup"): every `everyHours` (default 4) it closes requests whose
   * pull requests merged or whose worker reported them delivered, resumes workers a limit or restart cut off, and stalls
   * what has gone quiet. `enabled` defaults to true. `repos`: the GitHub owner/name repos whose pull requests are linked to
   * requests (default the game repo and this app's own; an empty list links none).
   */
  ledger?: { cleanup?: { enabled?: boolean; everyHours?: number; repos?: string[] } };
  /**
   * Max, the Discord bot agents post as (docs/max.md). Activity needs nothing: agents' ffdiscord calls append to
   * `eventsFile` (default ~/.config/ff-factory/max-events.jsonl). The token check and inbound read the bot token
   * where it already is, the "discord" section of the ffbox config in `ffboxConfigDir` (default ~/.config/ffbox)
   * and its secrets.env. `inbound.channels`: aliases (or ids) to show read-only, default bug_reports and dev_chat;
   * `inbound.enabled: false` turns it off; `inbound.pollMinutes` (>= 2, default 5). `discordApi`: tests only (a
   * local mock; anything but discord.com or this machine is ignored).
   */
  max?: { eventsFile?: string; ffboxConfigDir?: string; inbound?: { enabled?: boolean; channels?: string[]; pollMinutes?: number }; discordApi?: string };
  /** Where state.json and transcripts live. */
  dataDir: string;
  /**
   * The portal holds no sandboxes of its own (w510): this is the folder this host's own machine daemon keeps its
   * sandboxes in (add_machine local takes it as its sandbox_root; BEAST's F:\ffsb), and the default parent of
   * `review.root` and `standingRoot`. Optional (default <dataDir>/sandboxes).
   */
  sandboxRoot: string;
  /**
   * Where the standing agents that ran in the portal itself before w510 kept their folders (<standingRoot>/<id>);
   * today's run on machines (docs/standing-agents.md). Default <sandboxRoot>/_agents. Must not be inside this app's
   * directory or dataDir, which the guard protects.
   */
  standingRoot: string;
  /** Config keys this file still sets that nothing reads any more (w510), named once at startup: retiredConfigKeys. */
  retiredKeys?: string[];
  repo: {
    /** Clone URL for the base repository. */
    url: string;
    /** The base clone every sandbox worktree hangs off. Created by `npm run setup`. */
    basePath: string;
    /** Optional existing local clone whose object store the base borrows (git --reference). */
    referenceRepo?: string;
    /**
     * Every how many minutes the base clone, which the orchestrators read, is fetched and moved to defaultBase
     * (server/baseRefresh.ts, w467). Default 15; 0 turns it off (the portal VM's fff-base-refresh.timer may do it).
     */
    refreshMinutes?: number;
  };
  /** Base ref for new sandbox branches. */
  defaultBase: string;
  /**
   * Extra volumes the host guard watches besides the data volume, e.g. "C:/" (on BEAST, also handed to its own daemon's
   * guard, which watches its sandbox drive's host volume with it).
   */
  hostDiskPaths: string[];
  /** The disk guard and the sandbox drive's self-recovery (server/hostHealth.ts, docs/self-recovery.md). */
  hostGuard: HostGuardConfig;
  /**
   * What this host's own machine daemon takes for its sandbox editors (MachineManager.localExtras; the portal runs no
   * editor itself, w510): `idleStopMinutes`, an editor whose sandbox has had no agent activity for this long (and no
   * agent mid-turn) is stopped, 0 never; `mcpServer`, the MCP-for-Unity server its workers get as "UnityMCP" (Claude
   * Code registers it per project path, so a fresh worktree would otherwise have no Unity tools at all).
   */
  unity: {
    idleStopMinutes: number;
    mcpServer?: { command: string; args: string[]; env?: Record<string, string> };
  };
  /** Folders (relative to a sandbox or a machine's clone; `*` = any one folder) the Screenshots gallery lists. See server/images.ts. */
  screenshotDirs?: string[];
  /**
   * Files people attach to chat messages (docs/attachments.md): the largest one in MB (default 200) and how many days
   * one nobody sent on is kept (default 30). Settable with set_app_config.
   */
  attachments?: Partial<AttachmentConfig>;
  /**
   * Review media workers publish with publish_review (docs/review.md): `root` (default `<sandboxRoot>/_review`), and the
   * caps `maxFileMB` (200), `maxCallMB` (500), `maxFiles` (40).
   */
  review?: Partial<ReviewConfig>;
  /**
   * Where new game-repo work goes first (w428, docs/machines.md "Placing work"): `prefer`, computers in order (machine
   * ids, or "this host"), and `avoid`, computers kept off unless nothing else has room, each with why. Set with
   * set_app_config placement.prefer / placement.avoid; null clears.
   */
  placement?: { prefer?: string[]; avoid?: Record<string, string> };
  /** Paths no sandbox agent may write to or mention in a shell command (e.g. the live co-op checkout). */
  protectedPaths: string[];
  limits: {
    /**
     * A Unity editor is started only with at least this much free RAM (each takes ~8-12 GB). 0: no check. Handed to
     * this host's own daemon's guard (the portal runs no editor itself, w510).
     */
    minFreeRamGB: number;
  };
  models: string[];
  defaultModel: string;
  orchestrator: {
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Tell the orchestrator when a worker finishes a turn or needs a permission, so it can report. */
    notifyOnWorkerEvents: boolean;
    /**
     * Where each orchestrator's own memory folder is made (docs/orchestrators.md, "Memory"): <memoryRoot>/dispatcher
     * and <memoryRoot>/person-<user id>. Default <dataDir>/orchestrator-memory, which workers cannot write. When the
     * root is a git repository of its own, the app commits what changes there and pushes it, to a private remote only
     * (server/memoryGit.ts).
     */
    memoryRoot?: string;
    /**
     * Automatic compaction (w535, server/autoCompact.ts, docs/orchestrators.md "Compacting a conversation"): an
     * orchestrator, the dispatcher included, compacts its conversation between turns once its context reaches this many
     * tokens. Default 200,000; 0 turns this trigger off. Settable live (set_app_config).
     */
    compactAtTokens?: number;
    /**
     * Automatic compaction's cost trigger (w535): a turn that cost at least this many USD, with the context at
     * 100,000 tokens or more, compacts the conversation after it. Default 1; 0 turns this trigger off.
     */
    compactAtTurnUsd?: number;
    /**
     * The loop guards (w571, server/orchestrators.ts loopGuards, docs/orchestrators.md "Loops, limits and safety"), each
     * a whole number from 1 to 100 that a person's own message starts again. Filings (request_work, update_work) a
     * person's orchestrator makes between two of their messages, default 3.
     */
    filingsPerMessage?: number;
    /** Follow-ups (message_agent) to one worker between two of the person's messages, default 3. */
    followUpsPerMessage?: number;
    /** message_person messages to one person until the sender or the recipient writes to their own orchestrator, default 10. Not between the owners (w627, server/orchestrators.ts ownersPair). */
    messagesPerPerson?: number;
  };
  worker: {
    permissionMode: PermissionMode;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  /**
   * Extra environment for every Claude session, e.g. { "CLAUDE_CODE_OAUTH_TOKEN": "<from claude setup-token>" }
   * so an always-on host does not depend on an interactive login that can expire.
   */
  claudeEnv?: Record<string, string>;
  /**
   * Per-person Claude env, by user id (docs/identity.md, "Local billing"): an agent working for that person
   * (SessionInfo.requestedBy) runs with it laid over claudeEnv, e.g.
   * { "lothsahn": { "CLAUDE_CODE_OAUTH_TOKEN": "<Lothsahn's claude setup-token>" } }. A person without an entry
   * runs on claudeEnv, the owner's account. Write-only through set_app_config; redacted from transcripts.
   */
  userClaudeEnv?: Record<string, Record<string, string>>;
  /**
   * The user id automatic work is attributed and billed to: scheduled standing-agent runs and, once FFBox takes
   * work, intake-triggered diagnoses (docs/identity.md). Default: the owner (the first login with role owner).
   */
  systemPayer?: string;
  /** Explicit path to a `claude` executable; default is the SDK's bundled one. */
  claudeExecutable?: string;
  /** Voice input: local speech-to-text behind the composers' mic button (server/voice.ts, docs/voice.md). */
  voice: VoiceConfig;
}

export interface VoiceConfig {
  /** Off: the mic button uses the browser's own speech recognition only. */
  enabled: boolean;
  /** Where `npm run voice-setup` puts uv's Python, the venv and the model. Default <dataDir>/tools/whisper. */
  toolsDir: string;
  /** A faster-whisper model name ("large-v3-turbo", "small.en", "distil-large-v3", …). */
  model: string;
  /** "auto" tries the GPU and falls back to the CPU. */
  device: 'auto' | 'cuda' | 'cpu';
  /** CTranslate2 compute type; default int8_float16 on the GPU, int8 on the CPU. */
  computeType?: string;
  /** Spoken language ("en"); empty = detect per clip. */
  language: string;
  /** Unload the model (end the worker, freeing its VRAM) after this many minutes without dictation. */
  idleMinutes: number;
  cpuThreads: number;
  /** Install the tools in the background at startup when they are missing or out of date. */
  autoInstall: boolean;
  /** Debug: keep each clip and its transcript in <dataDir>/voice-debug. Off: audio is never written to disk. */
  keepAudio: boolean;
  /** Extra words for Whisper's prompt, on top of the built-in list and names from the current state. */
  vocabulary: string[];
  /** A uv executable; default: `uv` on PATH, else one downloaded into toolsDir. */
  uvPath?: string;
  /** Read replies aloud in voice mode with local Kokoro TTS (off: the browser's speech synthesis). */
  tts: boolean;
  /** Kokoro voice when the device asks for none ("af_heart", "am_michael", "bf_emma", "bm_george", …). */
  ttsVoice: string;
  /** "auto": the GPU (CUDA execution provider) if it loads, else the CPU (about real time on this host: slow to start). */
  ttsDevice: 'auto' | 'cuda' | 'cpu';
  /**
   * A worker machine's GPU Whisper first, this portal's own Whisper (the settings above) as the fallback (w615,
   * docs/voice.md "Whisper on a worker's GPU"). Each machine turns its own on (daemon.json `voice`).
   */
  remote: VoiceRemoteConfig;
}

export interface VoiceRemoteConfig {
  /** Send clips to a machine whose daemon offers its GPU Whisper. Off: this portal's own Whisper only. */
  enabled: boolean;
  /** Machine ids to use, first choice first; empty: any machine that offers it. */
  machines: string[];
  /**
   * How long a loaded remote model may take before this portal's own Whisper takes the clip: timeoutSeconds, plus
   * perAudioSecond for each second of audio, plus loadSeconds when the machine had not loaded its model yet.
   */
  timeoutSeconds: number;
  perAudioSecond: number;
  loadSeconds: number;
}

/**
 * The remote engine's defaults (w615). Measured on BEAST's RTX 4080 SUPER, large-v3-turbo: 0.19-0.28 s for a 12.5 s clip
 * and 0.61-0.95 s for 45.5 s (0.02 s per audio second), a load of 2.3 s with its files cached and 12-15 s cold. The
 * timeout allows 10x the measured time on top of the link, so a busy GPU still answers; a dead one costs a few seconds.
 */
export const VOICE_REMOTE_DEFAULTS: VoiceRemoteConfig = { enabled: true, machines: [], timeoutSeconds: 3, perAudioSecond: 0.05, loadSeconds: 20 };

export const VOICE_DEFAULTS: Omit<VoiceConfig, 'toolsDir'> = {
  enabled: true,
  model: 'large-v3-turbo',
  device: 'auto',
  language: 'en',
  idleMinutes: 20,
  cpuThreads: 8,
  autoInstall: true,
  keepAudio: false,
  vocabulary: [],
  tts: true,
  ttsVoice: 'af_heart',
  ttsDevice: 'auto',
  remote: VOICE_REMOTE_DEFAULTS,
};

/** What config may set each of the orchestrators' loop guards to (orchestrator.filingsPerMessage etc., w571). */
export const LOOP_GUARD_RANGE = { min: 1, max: 100 } as const;
/** The default of config usagePollMinutes. */
export const DEFAULT_USAGE_POLL_MINUTES = 15;

const DEFAULTS: Omit<Config, 'sandboxRoot' | 'standingRoot' | 'repo' | 'unity' | 'voice' | 'hostGuard'> = {
  port: 8790,
  usagePollMinutes: DEFAULT_USAGE_POLL_MINUTES,
  trustProxy: true,
  host: '0.0.0.0',
  dataDir: './data',
  defaultBase: 'origin/develop',
  protectedPaths: [],
  limits: { minFreeRamGB: 10 },
  hostDiskPaths: [],
  models: ['opus', 'sonnet', 'haiku', 'fable'],
  defaultModel: 'opus',
  orchestrator: { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true },
  worker: { permissionMode: 'bypassPermissions', effort: 'high' },
};

/**
 * Config keys that fed the portal's own sandbox pool, editors and standing agents, all gone (w510: the portal runs only
 * the orchestrators and the dispatcher; every sandbox, editor and standing agent is a machine daemon's). A config that
 * still sets one loads; the key is named once at startup and in system_status, and ignored.
 */
export const RETIRED_CONFIG_KEYS: readonly string[] = [
  'hostSandboxes',
  'librarySeed',
  'librarySeedGB',
  'librarySeedCopy',
  'limits.maxUnity',
  'limits.maxSessions',
  'limits.maxIdleAgents',
  'limits.maxSandboxes',
  'limits.minFreeGB',
  'unity.editorPath',
  'unity.extraArgs',
  'unity.watchdog',
  'unity.hang',
  'unity.autoRestart',
  // The account of the standing agents the portal ran itself; those on machines run on the machine's (machines.useHostClaudeEnv).
  'claudeAccounts.standing',
];

/** The retired keys (RETIRED_CONFIG_KEYS) a raw config file sets. */
export function retiredConfigKeys(raw: any): string[] {
  return RETIRED_CONFIG_KEYS.filter((k) => {
    const [a, b] = k.split('.');
    return b === undefined ? raw?.[a] !== undefined : raw?.[a] !== null && typeof raw?.[a] === 'object' && raw[a][b] !== undefined;
  });
}

/** A copy of a raw config without the retired keys (what set_app_config and the VM migration write back). */
export function withoutRetiredKeys(raw: any): any {
  const out = { ...raw };
  for (const k of RETIRED_CONFIG_KEYS) {
    const [a, b] = k.split('.');
    if (b === undefined) delete out[a];
    else if (out[a] !== null && typeof out[a] === 'object') {
      out[a] = { ...out[a] };
      delete out[a][b];
    }
  }
  return out;
}

/** The startup line for retired keys, or undefined. */
export function retiredKeysLine(keys: string[] | undefined): string | undefined {
  return keys?.length ? `config.json sets ${keys.join(', ')}, which nothing reads any more: the portal runs no sandboxes, editors or standing agents of its own (w510). Ignored; remove them (config.example.json shows what is left).` : undefined;
}

export interface CleanupPolicy {
  /** A clean-up pass this often (minutes; 0: only when free space is below softFreeGB). */
  everyMinutes: number;
  /** Below this much free space: a pass every 15 minutes, including the rules that empty whole caches. 0: warnFreeGB + 40. */
  softFreeGB: number;
  /** Folder name patterns in the temp folder that are scratch, removed when older than tempOlderThanHours. */
  tempPatterns: string[];
  tempOlderThanHours: number;
  /** A finished agent session's own temp folder (ffa-<session>) goes once untouched this long. */
  sessionTempHours: number;
  /** Anything else in the temp folder goes once untouched this many days (a clone only with nothing unpushed). */
  tempAnyOlderThanDays: number;
  /** Build outputs (a sandbox's Builds folder, build archives in ff-worker) go once untouched this many days. */
  buildsOlderThanDays: number;
  /** The game's PlaytestSessions (playtest screenshots and recordings) go once untouched this many days. */
  playtestDays: number;
  /** Claude Code's task output folders (<temp>/claude/<project>/<session>) go once untouched this many days. */
  claudeTempDays: number;
  /** A GitHub Actions runner's job folders (_work in the actions-runner folders) go once untouched this many days. */
  runnerWorkDays: number;
  /** A Unity project not opened for this many days has its Library reported (system_status, notices)... */
  libraryReportDays: number;
  /** ...and removed past this many (Unity rebuilds it on open). 0: never removed. */
  libraryDeleteDays: number;
  /** Agent temp clones (fff-*, ffsb-*), removed when older than this and without uncommitted or unpushed work. 0: never. */
  cloneOlderThanDays: number;
  clonePatterns: string[];
  /** Explicit rules: entries directly inside `path` older than `olderThanDays` go (e.g. old build outputs). */
  ageRules: { path: string; olderThanDays: number }[];
  /** The stale build and run output rules on this host (server/staleOutput.ts, w459); absent: their defaults (on). */
  staleOutput?: Partial<StaleOutputSettings>;
}

export const DEFAULT_CLEANUP: CleanupPolicy = {
  everyMinutes: 60,
  softFreeGB: 0,
  // Headless-browser profiles from screenshot scripts, and the fast suite's own scratch folders.
  tempPatterns: ['edge-shot-*', 'edge-keys-*', 'edge-icon-*', 'playwright_*dev_profile-*', 'ffsb-voice-*', 'ffsb-auth-*', 'ffsb-integ-*', 'ffsb-smoke-*', 'republish-??????', 'update-steps-??????', 'editor-log-??????', 'appcfg-??????', 'scenes-??????', 'pushed-??????', 'cleanup-test-*', 'ffsb-max-*', 'ffsb-e2e-*', 'ffsb-config-*'],
  tempOlderThanHours: 1,
  sessionTempHours: 2,
  tempAnyOlderThanDays: 7,
  buildsOlderThanDays: 7,
  playtestDays: 14,
  claudeTempDays: 3,
  runnerWorkDays: 14,
  libraryReportDays: 30,
  libraryDeleteDays: 180,
  cloneOlderThanDays: 3,
  clonePatterns: ['fff-*', 'ffsb-*'],
  ageRules: [],
};

/** The soft threshold the host uses: softFreeGB, or warnFreeGB + 40 when unset. */
export const hostSoftFreeGB = (g: Pick<HostGuardConfig, 'warnFreeGB' | 'cleanup'>) => g.cleanup.softFreeGB || g.warnFreeGB + 40;

/** A machine's clean-up when config machines.cleanup says nothing about it. */
export const MACHINE_CLEANUP_DEFAULTS = { everyMinutes: 60, softFreeGB: 80 };

/** A per-machine setting: a number for every machine, or { "<id>": n, "*": n } (the id wins, then "*"). */
const perMachine = (v: number | Record<string, number> | undefined, id: string): number | undefined => (typeof v === 'number' ? v : v ? (v[id] ?? v['*']) : undefined);

/** What machine `id`'s daemon runs its clean-up with (config machines.cleanup, else the defaults). */
export function machineCleanupSettings(cfg: Pick<Config, 'machines'>, id: string): { everyMinutes: number; softFreeGB: number; staleOutput: StaleOutputSettings } {
  const c = cfg.machines?.cleanup;
  return {
    everyMinutes: perMachine(c?.everyMinutes, id) ?? MACHINE_CLEANUP_DEFAULTS.everyMinutes,
    softFreeGB: perMachine(c?.softFreeGB, id) ?? MACHINE_CLEANUP_DEFAULTS.softFreeGB,
    staleOutput: staleOutputSettings(c?.staleOutput),
  };
}

export interface HostGuardConfig {
  /** How often the guard looks (seconds). 0 turns the whole guard off. */
  pollSeconds: number;
  /** Below this much free space on any watched volume: notify, and refuse new editors and agent processes. */
  warnFreeGB: number;
  /** Below this: also ask busy agents to checkpoint and end their turn, stop idle editors, and clean up. */
  criticalFreeGB: number;
  /** A level clears only this far above its threshold, so it does not flap. */
  hysteresisGB: number;
  /** The sandbox drive is reattached only with at least this much free on the volumes that hold it. */
  remountMinFreeGB: number;
  /** The Dev Drive's VHDX file, for growth checks and compaction (empty: no Dev Drive). */
  devDriveVhdx: string;
  /** Ignored since 2026-09-24: compacting (it detaches the drive) is manual only, host_recovery "compact". Kept so old config files load. */
  compactWhenReclaimGB: number;
  /** Kill automation browsers (headless, temp profile, or Playwright's) running longer than this, and orphans. 0: never. */
  reapBrowsersAfterHours: number;
  /** How often the reaper looks (it also runs once at startup). */
  reapEveryMinutes: number;
  cleanup: CleanupPolicy;
}

const HOST_GUARD_DEFAULTS: HostGuardConfig = {
  pollSeconds: 30,
  warnFreeGB: 80,
  criticalFreeGB: 40,
  hysteresisGB: 10,
  remountMinFreeGB: 30,
  devDriveVhdx: '',
  compactWhenReclaimGB: 0,
  reapBrowsersAfterHours: 3,
  reapEveryMinutes: 15,
  cleanup: DEFAULT_CLEANUP,
};

export const ROOT = path.resolve(import.meta.dirname, '..');

/** The config file this server reads: FFSB_CONFIG, else config.json next to the app. */
export function configPath(): string {
  return process.env.FFSB_CONFIG ?? path.join(ROOT, 'config.json');
}

/**
 * A config file's object with the defaults filled in, unchecked and with its paths as written (loadConfig checks and
 * resolves them). Also for reading another computer's config.json (the migration to the VM, server/vmMigration.ts).
 */
export function withDefaults(raw: any): Config {
  const kept = withoutRetiredKeys(raw);
  return {
    ...DEFAULTS,
    ...kept,
    limits: { ...DEFAULTS.limits, ...kept.limits },
    orchestrator: { ...DEFAULTS.orchestrator, ...kept.orchestrator },
    worker: { ...DEFAULTS.worker, ...kept.worker },
    unity: { idleStopMinutes: 120, ...kept.unity },
    hostGuard: { ...HOST_GUARD_DEFAULTS, ...kept.hostGuard, cleanup: { ...DEFAULT_CLEANUP, ...kept.hostGuard?.cleanup } },
    voice: { ...VOICE_DEFAULTS, toolsDir: '', ...kept.voice, remote: { ...VOICE_REMOTE_DEFAULTS, ...kept.voice?.remote } },
  };
}

export function loadConfig(): Config {
  const file = configPath();
  // Damaged by a crash: the newest good version (config.json.1.., or the .prev setAppConfig keeps) takes its place.
  const raw = readJsonDurable<any>(file, { check: checkObject, extra: [`${file}.prev`] });
  if (!raw) {
    throw new Error(fs.existsSync(file) || dataRecoveries.some((r) => r.file === file) ? `${file} is damaged and no good earlier version is left; restore it by hand.` : `No config at ${file}. Copy config.example.json to config.json and edit it.`);
  }
  const cfg = withDefaults(raw);
  cfg.retiredKeys = retiredConfigKeys(raw);
  // The portal keeps no sandboxes (w510): only the base clone the orchestrators read is required.
  if (!cfg.repo) throw new Error('config.json is missing "repo"');
  const windowsOnly = windowsPathsOffWindows(cfg);
  if (windowsOnly.length) throw new Error(`config.json names Windows paths on ${process.platform}: ${windowsOnly.join(', ')}. Use this computer's paths (the portal VM's template is deploy/vm/guest/config.vm.example.json).`);
  checkAccountConfig(cfg);
  checkConnectorConfig(cfg);
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  cfg.sandboxRoot = path.resolve(cfg.sandboxRoot || path.join(cfg.dataDir, 'sandboxes'));
  cfg.standingRoot = path.resolve(raw.standingRoot ?? path.join(cfg.sandboxRoot, '_agents'));
  for (const guarded of [ROOT, cfg.dataDir]) {
    const rel = path.relative(guarded, cfg.standingRoot);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`standingRoot (${cfg.standingRoot}) must not be inside ${guarded}`);
  }
  cfg.repo.basePath = path.resolve(cfg.repo.basePath);
  if (cfg.claudeTokenFile !== undefined) {
    if (typeof cfg.claudeTokenFile !== 'string' || !cfg.claudeTokenFile.trim()) throw new Error('config claudeTokenFile is the path of a file');
    cfg.claudeTokenFile = path.resolve(cfg.claudeTokenFile);
  }
  if (cfg.vault !== undefined) {
    if (typeof cfg.vault !== 'object' || cfg.vault === null || Array.isArray(cfg.vault)) throw new Error('config vault is an object, e.g. { "keyFile": "/etc/fff/vault.key" }');
    const u: unknown = cfg.vault.unattributed;
    if (u !== undefined) {
      if (typeof u !== 'object' || u === null || Array.isArray(u)) throw new Error('config vault.unattributed is an object, e.g. { "intake": "lothsahn", "ffbox": "lothsahn", "nightly": "ben" }');
      for (const [k, v] of Object.entries(u)) {
        if (!['intake', 'ffbox', 'nightly'].includes(k)) throw new Error(`config vault.unattributed.${k}: no such kind of work (intake, ffbox, nightly)`);
        if (typeof v !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(v)) throw new Error(`config vault.unattributed.${k} is a portal user id`);
      }
    }
    if (cfg.vault.keyFile !== undefined) {
      if (typeof cfg.vault.keyFile !== 'string' || !cfg.vault.keyFile.trim()) throw new Error('config vault.keyFile is the path of a file');
      cfg.vault.keyFile = path.resolve(cfg.vault.keyFile);
      const rel = path.relative(cfg.dataDir, cfg.vault.keyFile);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`config vault.keyFile (${cfg.vault.keyFile}) must be outside the data folder (docs/vault.md)`);
    }
  }
  cfg.voice.toolsDir = cfg.voice.toolsDir ? path.resolve(ROOT, cfg.voice.toolsDir) : path.join(cfg.dataDir, 'tools', 'whisper');
  cfg.protectedPaths = cfg.protectedPaths.map((p) => path.resolve(p));
  return cfg;
}

/**
 * The config paths that are Windows paths ("C:/ffsb", "F:\\ffsb") on a computer that is not Windows (w467): there
 * path.resolve('C:/ffsb') is "<cwd>/C:/ffsb", so the portal would quietly make and use folders inside its own. Their
 * key and value each.
 */
export function windowsPathsOffWindows(cfg: Pick<Config, 'sandboxRoot' | 'dataDir' | 'repo' | 'protectedPaths'> & { standingRoot?: string; review?: { root?: string }; hostDiskPaths?: string[] }, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return [];
  const drive = (v: unknown) => typeof v === 'string' && /^[a-zA-Z]:([\\/]|$)/.test(v);
  const out: string[] = [];
  const one = (key: string, v: unknown) => {
    if (drive(v)) out.push(`${key} "${v}"`);
  };
  one('sandboxRoot', cfg.sandboxRoot);
  one('dataDir', cfg.dataDir);
  one('standingRoot', cfg.standingRoot);
  one('repo.basePath', cfg.repo?.basePath);
  one('review.root', cfg.review?.root);
  (cfg.protectedPaths ?? []).forEach((p, i) => one(`protectedPaths[${i}]`, p));
  (cfg.hostDiskPaths ?? []).forEach((p, i) => one(`hostDiskPaths[${i}]`, p));
  return out;
}

/**
 * Throws when config claudeAccounts or machines.useHostClaudeEnv is malformed: a typo there would otherwise
 * quietly run agents on another account than the one meant.
 */
export function checkAccountConfig(cfg: Pick<Config, 'claudeAccounts' | 'machines'> & Partial<Pick<Config, 'claudeTokenFile'>>) {
  const a: unknown = cfg.claudeAccounts;
  if (a !== undefined) {
    if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new Error('config claudeAccounts is an object, e.g. { "orchestrator": "login" }');
    for (const [role, v] of Object.entries(a)) {
      if (!HOST_ROLES.includes(role as HostRole)) throw new Error(`config claudeAccounts.${role}: no such role (${HOST_ROLES.join(', ')})`);
      if (!CLAUDE_ACCOUNTS.includes(v as ClaudeAccount)) throw new Error(`config claudeAccounts.${role} is "login" or "token" (or "tokenfile" for ${TOKEN_FILE_ROLES.join(', ')})`);
      if (v === 'tokenfile' && !TOKEN_FILE_ROLES.includes(role)) throw new Error(`config claudeAccounts.${role} cannot be "tokenfile": only ${TOKEN_FILE_ROLES.join(', ')} run on the token file`);
      if (v === 'tokenfile' && !(cfg as Partial<Pick<Config, 'claudeTokenFile'>>).claudeTokenFile) throw new Error(`config claudeAccounts.${role} is "tokenfile" but config claudeTokenFile names no file`);
    }
  }
  for (const key of ['useHostClaudeEnv', 'claudeFromVault'] as const) {
    const u: unknown = cfg.machines?.[key];
    if (u === undefined || typeof u === 'boolean') continue;
    if (typeof u !== 'object' || u === null || Array.isArray(u)) throw new Error(`config machines.${key} is true, false or { "<machine id>" | "*": true | false }`);
    for (const [id, v] of Object.entries(u)) {
      if (typeof v !== 'boolean') throw new Error(`config machines.${key}.${id} is true or false`);
    }
  }
}

/**
 * Whether a role's agents get the claude.ai connectors (config claudeAiConnectors, w516). Off by default for the
 * orchestrators and the dispatcher: their 58 connector tools (Gmail 30, Google Drive 11, Google Calendar 9, Claude Docs 8)
 * and Claude Docs' instructions were about 41,300 input tokens in every request (measured 2026-10-06), and orchestration
 * never uses them. On for workers and standing agents (Ben's creator outreach, w106 and w121, used Gmail).
 */
/** The roles config claudeAiConnectors names: the account roles, and standing agents (which run on machines, w510). */
export type ConnectorRole = HostRole | 'standing';
export const CONNECTOR_ROLES: readonly ConnectorRole[] = [...HOST_ROLES, 'standing'];
export const CLAUDE_AI_CONNECTORS_DEFAULT: Readonly<Record<ConnectorRole, boolean>> = { orchestrator: false, dispatcher: false, workers: true, standing: true };

export function claudeAiConnectorsFor(cfg: Pick<Config, 'claudeAiConnectors'>, role: ConnectorRole): boolean {
  const v = cfg.claudeAiConnectors?.[role];
  return typeof v === 'boolean' ? v : CLAUDE_AI_CONNECTORS_DEFAULT[role];
}

/** The environment that keeps a process's claude.ai connectors from loading when its role has them off (any machine). */
export function connectorEnv(cfg: Pick<Config, 'claudeAiConnectors'>, role: ConnectorRole): Record<string, string> {
  return claudeAiConnectorsFor(cfg, role) ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
}

/** Throws when config claudeAiConnectors is malformed: an object of role → true or false. */
export function checkConnectorConfig(cfg: Pick<Config, 'claudeAiConnectors'>) {
  const c: unknown = cfg.claudeAiConnectors;
  if (c === undefined) return;
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new Error('config claudeAiConnectors is an object, e.g. { "dispatcher": false, "workers": true }');
  for (const [role, v] of Object.entries(c)) {
    if (!CONNECTOR_ROLES.includes(role as ConnectorRole)) throw new Error(`config claudeAiConnectors.${role}: no such role (${CONNECTOR_ROLES.join(', ')})`);
    if (typeof v !== 'boolean') throw new Error(`config claudeAiConnectors.${role} is true or false`);
  }
}

/** Whose a message is, said in every agent's prompt (w389): the first line of each message, never the portal's owner by default. */
export const SENDER_RULE =
  'Each message names its sender on its first line: "[from <name>]" when a person wrote it, "[from the orchestrator, for <name>]" when an orchestrator sent it on their behalf. Attribute an approval, a hold, an override or a decision only to the person a message names (or the ledger records as asking), in PR descriptions, release notes, ledger notes and reports. When a message names nobody, write "unconfirmed" and ask; never write a name.';

/**
 * The lines agents' prompts add about who runs the portal and whose a message is. Several people use the portal, so
 * the owner is named as the one who runs it, never as the one speaking (w389).
 */
export function ownerLine(cfg: Pick<Config, 'ownerName'>): string {
  const n = cfg.ownerName?.replace(/\s+/g, ' ').trim();
  return n ? `\nThe person who runs this portal is ${n}; others use it too, so that does not make ${n} the sender of a message. ${SENDER_RULE}\n` : `\n${SENDER_RULE}\n`;
}

let appOrigin: string | undefined | null = null;

/** This app's own origin URL (git config), read once; undefined when it is not a git checkout. */
export function appOriginUrl(): string | undefined {
  if (appOrigin === null) {
    try {
      appOrigin = execFileSync('git', ['-C', ROOT, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || undefined;
    } catch {
      appOrigin = undefined;
    }
  }
  return appOrigin;
}

/** The guard's public-repo identity rule for this config: its repos (default this app's origin), name and email. */
export function publicIdentityOf(cfg: Pick<Config, 'publicGitIdentity'>): { repos: string[]; name?: string; email?: string } {
  const own = appOriginUrl();
  const repos = cfg.publicGitIdentity?.repos ?? (own ? [own] : []);
  return { repos, name: cfg.publicGitIdentity?.name, email: cfg.publicGitIdentity?.email };
}

/** One brief line on committing to public repos ("" when there is none to name). */
export function publicIdentityLine(cfg: Pick<Config, 'publicGitIdentity'>): string {
  const pub = publicIdentityOf(cfg);
  if (!pub.repos.length) return '';
  const who = pub.name && pub.email ? `\`${pub.name} <${pub.email}>\`` : 'your GitHub noreply address (\`<id>+<login>@users.noreply.github.com\`)';
  return `Commits you push to ${pub.repos.map((r) => `\`${r}\``).join(', ')}, or to any other public GitHub repo, are public: commit there as ${who} (git config user.name / user.email in that clone; in clones of public repos your git already defaults to it). The harness refuses pushes to public repos whose commits carry any other email.\n`;
}

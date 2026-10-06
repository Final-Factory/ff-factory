import type { AttachmentConfig } from './attachments.ts';
import type { ReviewConfig } from './review.ts';
import type { DevRequestsConfig } from './devRequests.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode } from '../shared/types.ts';
import { DEFAULT_HANG, type HangThresholds } from './unityHang.ts';
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
export const TOKEN_FILE_ROLES: readonly string[] = ['orchestrator', 'dispatcher', 'standing'];
/** The roles config claudeAccounts picks an account for, on this host. */
/**
 * The roles config claudeAccounts sets an account for. `dispatcher` (w464, docs/portal-on-ffbox-host.md change 6): when
 * set, the dispatcher runs on it, and not on the system payer's own token; unset, it follows `orchestrator` as before.
 */
export type HostRole = 'orchestrator' | 'dispatcher' | 'workers' | 'standing';
export const HOST_ROLES: readonly HostRole[] = ['orchestrator', 'dispatcher', 'workers', 'standing'];
const ROLE_NAMES: Record<HostRole, string> = { orchestrator: 'the orchestrator', dispatcher: 'the dispatcher', workers: 'workers', standing: 'standing agents' };
/** Roles as people read them: "the orchestrator, standing agents". */
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
  claudeAiConnectors?: Partial<Record<HostRole, boolean>>;
  /**
   * The file holding the long-lived Claude OAuth token (sk-ant-oat01-…, from `claude setup-token`) the roles set to
   * "tokenfile" run on (w464): read at each session start into that process's CLAUDE_CODE_OAUTH_TOKEN, with every other
   * Claude credential removed. Never in claudeEnv, never sent to a machine, never shown (only its last four characters).
   */
  claudeTokenFile?: string;
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
   * Whether this host holds sandboxes of its own (default true). false is the portal-only mode (w464,
   * docs/portal-on-ffbox-host.md section 6, changes 1 and 2, D16): "this host" is no place for work (capacity,
   * placement, list_sandboxes), create_sandbox here is refused, `sandboxRoot` and `unity` may be left out, the host
   * guard watches the data volume instead of a sandbox drive, host_recovery runs only `cleanup`, and no standing agent
   * runs. Work goes to the machines.
   */
  hostSandboxes?: boolean;
  /** Every sandbox worktree is created as <sandboxRoot>/<id>. Optional in the portal-only mode (default <dataDir>/sandboxes, never used). */
  sandboxRoot: string;
  /**
   * Standing agents' working folders are <standingRoot>/<id> (docs/standing-agents.md). Default
   * <sandboxRoot>/_agents. Must not be inside this app's directory or dataDir, which the guard protects.
   */
  standingRoot: string;
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
  /** A warm Library/ folder copied into each new sandbox so Unity does not import from cold. */
  librarySeed?: string;
  /**
   * Size estimate of librarySeed in GB, used for the free-space check before copying it into a new
   * sandbox (walking ~100k files to measure it would take longer than the copy).
   */
  librarySeedGB: number;
  /**
   * How the Library seed is copied on Windows. "robocopy": a full, multithreaded copy. "clone": the
   * Windows copy engine (PowerShell Copy-Item), which block-clones on a ReFS Dev Drive when the seed and
   * sandboxRoot are on the same volume, so a 64 GB Library costs almost no space. Measured on this host:
   * robocopy 1.96 GB/42k files grew the volume 1.31 GB; Copy-Item grew it 0.06 GB.
   */
  librarySeedCopy: 'robocopy' | 'clone';
  /**
   * Extra volumes whose free space must also stay above limits.minFreeGB, e.g. "C:/" when
   * sandboxRoot is a dynamically expanding Dev Drive VHDX stored on C:.
   */
  hostDiskPaths: string[];
  /** The disk guard and the sandbox drive's self-recovery (server/hostHealth.ts, docs/self-recovery.md). */
  hostGuard: HostGuardConfig;
  unity: {
    /** Editor path; `{version}` is replaced with the sandbox's ProjectSettings/ProjectVersion.txt. */
    editorPath: string;
    extraArgs: string[];
    /** The startup watchdog (docs/unity-dialogs.md). */
    watchdog: {
      /** A starting editor whose log has not grown for this long is marked blocked. 0 turns it off. */
      stallMinutes: number;
      /** Press the safe button on known harmless dialogs (FMOD line endings, Safe Mode "Ignore", licensing "Retry"). */
      autoDismiss: boolean;
      /** How often to look at a starting (or blocked) editor's windows. */
      startingPollSeconds: number;
      /** How often to look at a running editor's windows. 0 turns it off. */
      runningPollSeconds: number;
    };
    /** Stop an editor whose sandbox has had no agent activity for this long (and no agent mid-turn). 0: never. */
    idleStopMinutes: number;
    /**
     * Hang detection for running editors (docs/unity-lifecycle.md, server/unityHang.ts): the thresholds, and
     * how often to look (each look pings the MCP bridge and checks the log; the window probe runs anyway).
     */
    hang: HangThresholds & { checkSeconds: number };
    /** Restart a hung or crashed editor automatically, at most `max` times per `windowMinutes`; then report and stop. */
    autoRestart: { enabled: boolean; max: number; windowMinutes: number };
    /**
     * The MCP-for-Unity server every worker gets as "UnityMCP". Claude Code registers it per project
     * path, so a fresh worktree would otherwise have no Unity tools at all.
     */
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
    maxUnity: number;
    /** Agents mid-turn at once on this host (w384: idle ones do not count; a message past it is queued). */
    maxSessions: number;
    /** Idle agent processes kept besides the running ones before the oldest idle one is stopped (default 6). */
    maxIdleAgents?: number;
    /** Sandboxes that may exist at once (each holds a worktree plus a ~70 GB Library). */
    maxSandboxes: number;
    /** Provisioning refuses to leave less than this many GB free on the sandbox volume. */
    minFreeGB: number;
    /** A Unity editor is started only with at least this much free RAM (each takes ~8-12 GB). 0: no check. */
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
}

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
};

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
  limits: { maxUnity: 3, maxSessions: 6, maxSandboxes: 4, minFreeGB: 100, minFreeRamGB: 10 },
  librarySeedGB: 70,
  librarySeedCopy: 'robocopy',
  hostDiskPaths: [],
  models: ['opus', 'sonnet', 'haiku', 'fable'],
  defaultModel: 'opus',
  orchestrator: { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true },
  worker: { permissionMode: 'bypassPermissions', effort: 'high' },
};

const UNITY_WATCHDOG_DEFAULTS: Config['unity']['watchdog'] = { stallMinutes: 15, autoDismiss: true, startingPollSeconds: 10, runningPollSeconds: 60 };

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
  return {
    ...DEFAULTS,
    ...raw,
    limits: { ...DEFAULTS.limits, ...raw.limits },
    orchestrator: { ...DEFAULTS.orchestrator, ...raw.orchestrator },
    worker: { ...DEFAULTS.worker, ...raw.worker },
    unity: {
      extraArgs: [],
      idleStopMinutes: 120,
      ...raw.unity,
      watchdog: { ...UNITY_WATCHDOG_DEFAULTS, ...raw.unity?.watchdog },
      hang: { ...DEFAULT_HANG, startupStallMinutes: raw.unity?.watchdog?.stallMinutes ?? DEFAULT_HANG.startupStallMinutes, checkSeconds: 30, ...raw.unity?.hang },
      autoRestart: { enabled: true, max: 3, windowMinutes: 30, ...raw.unity?.autoRestart },
    },
    hostGuard: { ...HOST_GUARD_DEFAULTS, ...raw.hostGuard, cleanup: { ...DEFAULT_CLEANUP, ...raw.hostGuard?.cleanup } },
    voice: { ...VOICE_DEFAULTS, toolsDir: '', ...raw.voice },
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
  if (raw.hostSandboxes !== undefined && typeof raw.hostSandboxes !== 'boolean') throw new Error('config hostSandboxes is true or false');
  // The portal-only mode (w464) keeps no sandboxes here: only the base clone the orchestrators read is required.
  for (const key of portalOnly(cfg) ? (['repo'] as const) : (['sandboxRoot', 'repo', 'unity'] as const)) {
    if (!cfg[key]) throw new Error(`config.json is missing "${key}"`);
  }
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
  cfg.voice.toolsDir = cfg.voice.toolsDir ? path.resolve(ROOT, cfg.voice.toolsDir) : path.join(cfg.dataDir, 'tools', 'whisper');
  cfg.protectedPaths = cfg.protectedPaths.map((p) => path.resolve(p));
  return cfg;
}

/** The portal-only mode (config hostSandboxes: false, w464): this host runs the portal and holds no sandboxes. */
export const portalOnly = (cfg: Pick<Config, 'hostSandboxes'>) => cfg.hostSandboxes === false;

/** Why something needs this host's own sandboxes in the portal-only mode, for refusals. */
export const PORTAL_ONLY_WHY = 'this portal holds no sandboxes of its own (config hostSandboxes: false, the portal-only mode)';

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
  const u: unknown = cfg.machines?.useHostClaudeEnv;
  if (u === undefined || typeof u === 'boolean') return;
  if (typeof u !== 'object' || u === null || Array.isArray(u)) throw new Error('config machines.useHostClaudeEnv is true, false or { "<machine id>" | "*": true | false }');
  for (const [id, v] of Object.entries(u)) {
    if (typeof v !== 'boolean') throw new Error(`config machines.useHostClaudeEnv.${id} is true or false`);
  }
}

/**
 * Whether a role's agents get the claude.ai connectors (config claudeAiConnectors, w516). Off by default for the
 * orchestrators and the dispatcher: their 58 connector tools (Gmail 30, Google Drive 11, Google Calendar 9, Claude Docs 8)
 * and Claude Docs' instructions were about 41,300 input tokens in every request (measured 2026-10-06), and orchestration
 * never uses them. On for workers and standing agents (Ben's creator outreach, w106 and w121, used Gmail).
 */
export const CLAUDE_AI_CONNECTORS_DEFAULT: Readonly<Record<HostRole, boolean>> = { orchestrator: false, dispatcher: false, workers: true, standing: true };

export function claudeAiConnectorsFor(cfg: Pick<Config, 'claudeAiConnectors'>, role: HostRole): boolean {
  const v = cfg.claudeAiConnectors?.[role];
  return typeof v === 'boolean' ? v : CLAUDE_AI_CONNECTORS_DEFAULT[role];
}

/** The environment that keeps a process's claude.ai connectors from loading when its role has them off (any machine). */
export function connectorEnv(cfg: Pick<Config, 'claudeAiConnectors'>, role: HostRole): Record<string, string> {
  return claudeAiConnectorsFor(cfg, role) ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
}

/** Throws when config claudeAiConnectors is malformed: an object of role → true or false. */
export function checkConnectorConfig(cfg: Pick<Config, 'claudeAiConnectors'>) {
  const c: unknown = cfg.claudeAiConnectors;
  if (c === undefined) return;
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new Error('config claudeAiConnectors is an object, e.g. { "dispatcher": false, "workers": true }');
  for (const [role, v] of Object.entries(c)) {
    if (!HOST_ROLES.includes(role as HostRole)) throw new Error(`config claudeAiConnectors.${role}: no such role (${HOST_ROLES.join(', ')})`);
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

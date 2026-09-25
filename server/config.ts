import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode } from '../shared/types.ts';
import { DEFAULT_HANG, type HangThresholds } from './unityHang.ts';

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
  /** Where state.json and transcripts live. */
  dataDir: string;
  /** Every sandbox worktree is created as <sandboxRoot>/<id>. */
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
  /** Paths no sandbox agent may write to or mention in a shell command (e.g. the live co-op checkout). */
  protectedPaths: string[];
  limits: {
    maxUnity: number;
    maxSessions: number;
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

const DEFAULTS: Omit<Config, 'sandboxRoot' | 'standingRoot' | 'repo' | 'unity' | 'voice' | 'hostGuard'> = {
  port: 8790,
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
  /** Folder name patterns in the temp folder that are scratch, removed when older than tempOlderThanHours. */
  tempPatterns: string[];
  tempOlderThanHours: number;
  /** Agent temp clones (fff-*, ffsb-*), removed when older than this and without uncommitted or unpushed work. 0: never. */
  cloneOlderThanDays: number;
  clonePatterns: string[];
  /** Explicit rules: entries directly inside `path` older than `olderThanDays` go (e.g. old audit reports). */
  ageRules: { path: string; olderThanDays: number }[];
}

export const DEFAULT_CLEANUP: CleanupPolicy = {
  // Headless-browser profiles from screenshot scripts, and the fast suite's own scratch folders.
  tempPatterns: ['edge-shot-*', 'edge-keys-*', 'edge-icon-*', 'playwright_*dev_profile-*', 'ffsb-voice-*', 'ffsb-auth-*', 'ffsb-integ-*', 'ffsb-smoke-*', 'republish-??????', 'update-steps-??????', 'editor-log-??????', 'appcfg-??????', 'scenes-??????', 'pushed-??????'],
  tempOlderThanHours: 1,
  cloneOlderThanDays: 3,
  clonePatterns: ['fff-*', 'ffsb-*'],
  ageRules: [],
};

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

export function loadConfig(): Config {
  const file = configPath();
  if (!fs.existsSync(file)) {
    throw new Error(`No config at ${file}. Copy config.example.json to config.json and edit it.`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg: Config = {
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
  for (const key of ['sandboxRoot', 'repo', 'unity'] as const) {
    if (!cfg[key]) throw new Error(`config.json is missing "${key}"`);
  }
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  cfg.sandboxRoot = path.resolve(cfg.sandboxRoot);
  cfg.standingRoot = path.resolve(raw.standingRoot ?? path.join(cfg.sandboxRoot, '_agents'));
  for (const guarded of [ROOT, cfg.dataDir]) {
    const rel = path.relative(guarded, cfg.standingRoot);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`standingRoot (${cfg.standingRoot}) must not be inside ${guarded}`);
  }
  cfg.repo.basePath = path.resolve(cfg.repo.basePath);
  cfg.voice.toolsDir = cfg.voice.toolsDir ? path.resolve(ROOT, cfg.voice.toolsDir) : path.join(cfg.dataDir, 'tools', 'whisper');
  cfg.protectedPaths = cfg.protectedPaths.map((p) => path.resolve(p));
  return cfg;
}

/** The line agents' prompts add when config ownerName is set ("" when it is not). */
export function ownerLine(cfg: Pick<Config, 'ownerName'>): string {
  const n = cfg.ownerName?.replace(/\s+/g, ' ').trim();
  return n ? `\nThe user (the person who runs this portal) is ${n}.\n` : '';
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

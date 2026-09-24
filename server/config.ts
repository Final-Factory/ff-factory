import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode } from '../shared/types.ts';

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

const DEFAULTS: Omit<Config, 'sandboxRoot' | 'standingRoot' | 'repo' | 'unity' | 'voice'> = {
  port: 8790,
  trustProxy: true,
  host: '0.0.0.0',
  dataDir: './data',
  defaultBase: 'origin/develop',
  protectedPaths: [],
  limits: { maxUnity: 3, maxSessions: 6, maxSandboxes: 4, minFreeGB: 100 },
  librarySeedGB: 70,
  librarySeedCopy: 'robocopy',
  hostDiskPaths: [],
  models: ['opus', 'sonnet', 'haiku', 'fable'],
  defaultModel: 'opus',
  orchestrator: { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true },
  worker: { permissionMode: 'bypassPermissions', effort: 'high' },
};

const UNITY_WATCHDOG_DEFAULTS: Config['unity']['watchdog'] = { stallMinutes: 15, autoDismiss: true, startingPollSeconds: 10, runningPollSeconds: 60 };

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
    unity: { extraArgs: [], ...raw.unity, watchdog: { ...UNITY_WATCHDOG_DEFAULTS, ...raw.unity?.watchdog } },
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

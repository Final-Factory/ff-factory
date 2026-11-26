import { secretEnvNames } from '../shared/secretShapes.ts';
import { workerToolCacheEnv } from './sharedCaches.ts';

/**
 * w5864: the environment a fenced (Low) Windows sandbox editor needs, and nothing else. `launchFenced` gave it the daemon's
 * whole `process.env` (daemon.json's `env` included, daemon.ts), and a Low worker at the same integrity level can read a Low
 * editor's memory and environment, so any credential in there reached every worker. The editor needs Windows' own
 * variables, the worker root's folders (rootEnv in daemon.ts: Unity's package and Asset Store caches among them), the Unity
 * MCP bridge's and the game's editor scripts' switches, and what the launch adds on top (the temp folder, the fence's
 * APPDATA/LOCALAPPDATA/USERPROFILE/UNITY_MCP_STATUS_DIR, the sandbox's game data and uv folders). Licensing needs no
 * variable: the editor reaches the Low licensing client by `-licensingIpc` (w5427).
 *
 * Traced from: Unity and Windows (the system variables below), the game repo's editor code (every
 * `Environment.GetEnvironmentVariable` under Assets: FF_WORKER_ROOT, FF_TEST_HISTORY, UNITY_JOBS_NATIVE_LEAK_DETECTION_MODE,
 * TEMP, PATH, HOME, USER; the rest are batch, CI or player variables a daemon never sets), and com.coplaydev.unity-mcp's
 * (UNITY_MCP_*, the telemetry switches, PATH, SystemRoot, ProgramFiles).
 */

/** Windows' own variables: the loader, the shell, the profile and the processor, none of them a credential. */
const WINDOWS = [
  'ALLUSERSPROFILE', 'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'COMPUTERNAME', 'COMSPEC',
  'DRIVERDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'LOGONSERVER', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PUBLIC', 'SESSIONNAME', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE', 'USERNAME', 'USERPROFILE', 'WINDIR',
  // Git for Windows' home (the editor runs git for git packages); the user's names, read by the game's editor scripts.
  'HOME', 'USER',
];

/** The worker root's folders (daemon.ts rootEnv): paths only. Unity reads UPM_CACHE_ROOT and ASSETSTORE_CACHE_PATH. */
const ROOT = ['FF_WORKER_ROOT', 'FF_PLAYER_SLOT_ROOT', 'UV_CACHE_DIR', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'FF_DETERMINISM_AUDIT_DIR', 'FF_GAME_DATA_DIR', 'FF_PLAYER_HOME', 'CARGO_HOME', ...Object.keys(workerToolCacheEnv('/', 'win32'))];

/** Switches the bridge and the game's editor scripts read. */
const SWITCHES = ['FF_TEST_HISTORY', 'UNITY_JOBS_NATIVE_LEAK_DETECTION_MODE', 'DISABLE_TELEMETRY', 'MCP_DISABLE_TELEMETRY'];
const PREFIXES = ['UNITY_MCP_'];

/** Every name a fenced editor may get from the daemon's environment, upper-cased (Windows' names are case-insensitive). */
export const FENCED_EDITOR_ENV_ALLOW: ReadonlySet<string> = new Set([...WINDOWS, ...ROOT, ...SWITCHES].map((n) => n.toUpperCase()));

const allowed = (name: string) => {
  const n = name.toUpperCase();
  return FENCED_EDITOR_ENV_ALLOW.has(n) || PREFIXES.some((p) => n.startsWith(p));
};

export interface FencedEditorEnv {
  /** The environment to start the editor with. */
  env: Record<string, string>;
  /** The daemon's variables left out, by name, sorted. */
  stripped: string[];
  /** Of those, or of the allowed ones dropped all the same, the ones that look like a credential (by name or by value). */
  secretLike: string[];
}

/**
 * The fenced editor's environment: the allowed part of `base` (the daemon's process.env), then `extra` (the launch's own
 * temp, fence and sandbox variables, set by the daemon, never a credential) on top. A variable whose name or value looks
 * like a credential (shared/secretShapes.ts secretEnvNames) is left out even where its name is allowed.
 */
export function fencedEditorEnv(base: NodeJS.ProcessEnv, ...extra: (Record<string, string> | undefined)[]): FencedEditorEnv {
  const kept: Record<string, string> = {};
  const stripped: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue;
    if (allowed(k)) kept[k] = v;
    else stripped.push(k);
  }
  const env: Record<string, string> = { ...kept };
  for (const e of extra) for (const [k, v] of Object.entries(e ?? {})) {
    // One spelling per name: a later `Path` replaces an earlier `PATH`, as Windows would see it.
    for (const old of Object.keys(env)) if (old !== k && old.toUpperCase() === k.toUpperCase()) delete env[old];
    env[k] = v;
  }
  const secret = secretEnvNames(env);
  for (const k of secret) delete env[k];
  const secretLike = [...new Set([...secret, ...secretEnvNames(Object.fromEntries(stripped.map((k) => [k, base[k]])))])].sort();
  return { env, stripped: [...new Set([...stripped, ...secret])].sort(), secretLike };
}

/** The daemon log's warn-only line for one fenced start (names only, never a value). */
export function fencedEditorEnvWarning(project: string, r: FencedEditorEnv): string {
  const secret = r.secretLike.length ? `; of them like a credential: ${r.secretLike.join(', ')}` : '';
  return `editor env (warn-only, w5864): ${project} started at Low with the daemon's whole environment; the minimal one would leave out ${r.stripped.length} variable(s): ${r.stripped.join(', ') || 'none'}${secret}`;
}

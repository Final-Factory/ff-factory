// The game's data folder as FF Factory reads it (w5306). The game keeps saves, settings, logs and AgentControl under one
// root, GameDataPaths.Root (the game repo's Assets/Scripts/FFCore/GameData/GameDataPaths.cs): Unity's persistentDataPath on
// Windows and Linux, a fixed folder on a Mac, or, since game PR #4237 (w5297), the folder FF_GAME_DATA_DIR names. The daemon
// sets that variable to <root>/gamedata for everything it starts (rootEnv), so workers' editors and players stop writing in
// the person's own folders (lothsahn, w5297: "under no circumstances should workers write outside of ffw"). A build or a
// branch from before #4237 ignores it and still writes the old folder, so each reader here knows both.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The variable the game reads (GameDataPaths.RootVariable). */
export const GAME_DATA_VARIABLE = 'FF_GAME_DATA_DIR';

/** The game data root a worker install gives its editors and players. */
export const workerGameDataDir = (root: string) => path.join(root, 'gamedata');

/**
 * w5557: each sandbox's own data root inside the machine's, `<root>/gamedata/sandboxes/<id>`. Its agent (slotEnv) and its
 * editor (sandboxes.ts) get it as FF_GAME_DATA_DIR, and so does every player or batch run the agent starts, so one
 * sandbox's saves, settings, logs and AgentControl never mix with another's or the person's (lothsahn: "worker-run games use
 * per-slot save folders; owner's saves protected"). The game turns Steam Cloud off whenever FF_GAME_DATA_DIR is set
 * (game repo SteamCloudGuard), and no folder under the install is in Steam's Auto-Cloud rule (LocalLow/Never Games/...).
 */
export const SANDBOX_GAME_DATA_FOLDER = 'sandboxes';

/** The sandbox's data root under the machine's `base` (its FF_GAME_DATA_DIR); a sandbox id is a plain name, kept to [\w.-]. */
export function sandboxGameDataDir(base: string, sandbox: string): string {
  return path.join(base, SANDBOX_GAME_DATA_FOLDER, sandbox.replace(/[^\w.-]/g, '_'));
}

/** FF_GAME_DATA_DIR for a sandbox's processes: its own folder under the machine's root `env` names; {} when none is set. */
export function sandboxGameDataEnv(env: NodeJS.ProcessEnv, sandbox: string | undefined): Record<string, string> {
  const base = gameDataOverride(env);
  return base && sandbox ? { [GAME_DATA_VARIABLE]: sandboxGameDataDir(base, sandbox) } : {};
}

/** The sandboxes' data roots that exist under the machine's `base` (sandboxGameDataDir). */
export function sandboxGameDataDirs(base: string, list: (dir: string) => string[] = listDirs): string[] {
  const dir = path.join(base, SANDBOX_GAME_DATA_FOLDER);
  return list(dir).map((n) => path.join(dir, n));
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The game's own root with no override: GameDataPaths.ResolveRoot per OS. */
export function legacyGameDataRoot(platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (platform === 'win32') return path.join(home, 'AppData', 'LocalLow', 'Never Games', 'finalfactory');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Never Games', 'finalfactory');
  return path.join(home, '.config', 'unity3d', 'Never Games', 'finalfactory');
}

/** The root FF_GAME_DATA_DIR names, trimmed as the game trims it (GameDataPaths.RootOverride); undefined when unset. */
export function gameDataOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[GAME_DATA_VARIABLE]?.trim();
  return v ? v : undefined;
}

/**
 * The roots a game process here may write, the override first: a build from after #4237 uses it, an older one the old root.
 * w5557: with the override, each sandbox's own root under it too (sandboxGameDataDirs), where its editor and players write.
 */
export function gameDataRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir(), list: (dir: string) => string[] = listDirs): string[] {
  const given = gameDataOverride(env);
  const legacy = legacyGameDataRoot(platform, home);
  return given && path.resolve(given) !== path.resolve(legacy) ? [given, ...sandboxGameDataDirs(given, list), legacy] : [legacy];
}

/** Where a build keeps its managed code or IL2CPP metadata, under its folder (Windows and Linux `<name>_Data`, a Mac app). */
const CODE_FILES = [
  ['finalfactory_Data', 'Managed', 'FFCore.dll'],
  ['FinalFactory_Data', 'Managed', 'FFCore.dll'],
  ['Contents', 'Resources', 'Data', 'Managed', 'FFCore.dll'],
  ['finalfactory_Data', 'il2cpp_data', 'Metadata', 'global-metadata.dat'],
  ['Contents', 'Resources', 'Data', 'il2cpp_data', 'Metadata', 'global-metadata.dat'],
];

/**
 * Whether a player build reads FF_GAME_DATA_DIR, from its own code: GameDataPaths.RootVariable is a string literal, stored
 * UTF-16 in FFCore.dll (Mono, the game's backend: ProjectSettings scriptingBackend Standalone 0) and UTF-8 in IL2CPP's
 * metadata. undefined when the build has neither file (not a Final Factory build laid out as expected).
 */
export function buildReadsGameDataDir(buildDir: string, read: (p: string) => Buffer | undefined = readIfThere): boolean | undefined {
  for (const parts of CODE_FILES) {
    const bytes = read(path.join(buildDir, ...parts));
    if (!bytes) continue;
    return bytes.includes(Buffer.from(GAME_DATA_VARIABLE, 'utf16le')) || bytes.includes(Buffer.from(GAME_DATA_VARIABLE, 'utf8'));
  }
  return undefined;
}

function readIfThere(p: string): Buffer | undefined {
  try {
    return fs.readFileSync(p);
  } catch {
    return undefined;
  }
}

/**
 * The saves folders a timed run's save must be in for these builds to load it by name (GameDataPaths.Saves: <root>/UserData/saves):
 * the override's for a build that reads it, the old root's for one that does not, both when a build's code cannot be read.
 */
export function savesDirsFor(buildDirs: string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir(), reads: (dir: string) => boolean | undefined = (d) => buildReadsGameDataDir(d)): string[] {
  const saves = (root: string) => path.join(root, 'UserData', 'saves');
  const given = gameDataOverride(env);
  const legacy = saves(legacyGameDataRoot(platform, home));
  if (!given) return [legacy];
  const out = new Set<string>();
  for (const d of buildDirs) {
    const r = reads(d);
    if (r !== false) out.add(saves(given));
    if (r !== true) out.add(legacy);
  }
  return [...out];
}

/**
 * w5344: Unity's own PlayerPrefs (the native "Screenmanager *" keys at every quit, Unity Services' ids on a Relay start,
 * Backtrace's machine id: game repo Documentation/User-Data-Folder.md, "What still writes PlayerPrefs (w5343)") follow the
 * player's home, not FF_GAME_DATA_DIR (lothsahn: "under no circumstances should workers write outside of ffw"). The daemon
 * sets FF_PLAYER_HOME=<root>/gamedata-home (rootEnv), and every player a worker or the daemon starts gets a home of its own
 * under it: the game repo's player_slots.player_home_env (slot launches, lab.py, pair legs), playerHomeEnv here (timed runs).
 * Not HOME or XDG_CONFIG_HOME for the whole worker: gh, git and Unity's Linux licence read those (server/outsideWrites.test.ts).
 */
export const PLAYER_HOME_VARIABLE = 'FF_PLAYER_HOME';

/** The players' own home under a worker install. */
export const workerPlayerHomeDir = (root: string) => path.join(root, 'gamedata-home');

/**
 * The variables that move a player's PlayerPrefs into FF_PLAYER_HOME, the same rule as the game's player_home_env: Linux
 * XDG_CONFIG_HOME=<it>/config (Unity's Linux prefs: $XDG_CONFIG_HOME/unity3d/<company>/<product>/prefs; HOME stays, Steam's
 * client lib is found under ~/.steam), macOS CFFIXED_USER_HOME=<it> (CFPreferences follows it; HOME stays). None on Windows
 * (nothing moves HKCU), without FF_PLAYER_HOME or FF_GAME_DATA_DIR, when the environment already sets that variable, or for a
 * build that does not read FF_GAME_DATA_DIR (`reads` false or unknown): an older build keeps its data root under the home,
 * where savesDirsFor and the live view look for it.
 */
export function playerHomeEnv(env: NodeJS.ProcessEnv, reads: boolean | undefined, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const home = env[PLAYER_HOME_VARIABLE]?.trim();
  if (!home || !gameDataOverride(env) || reads !== true || platform === 'win32') return {};
  const v = platform === 'darwin' ? 'CFFIXED_USER_HOME' : 'XDG_CONFIG_HOME';
  if (env[v]?.trim()) return {};
  return platform === 'darwin' ? { [v]: home } : { [v]: path.posix.join(home, 'config') };
}

/**
 * Makes the folders playerHomeEnv names; on a Mac links the real `Library/Application Support/Steam` in, so a Steam lookup
 * through NSHomeDirectory still finds the client (unchecked on a Mac player, w5344: game players are held on the Macs).
 */
export function preparePlayerHome(moved: Record<string, string>, realHome = os.homedir()): void {
  if (moved.XDG_CONFIG_HOME) fs.mkdirSync(moved.XDG_CONFIG_HOME, { recursive: true });
  const home = moved.CFFIXED_USER_HOME;
  if (!home) return;
  const support = path.join(home, 'Library', 'Application Support');
  fs.mkdirSync(path.join(home, 'Library', 'Preferences'), { recursive: true });
  fs.mkdirSync(support, { recursive: true });
  const real = path.join(realHome, 'Library', 'Application Support', 'Steam');
  const link = path.join(support, 'Steam');
  try {
    if (fs.statSync(real).isDirectory() && !fs.existsSync(link)) fs.symlinkSync(real, link);
  } catch {
    // no Steam here, or the link is there already
  }
}

/** Whether the build `exe` is in reads FF_GAME_DATA_DIR: buildReadsGameDataDir of the first of its folders that holds the code. */
export function exeReadsGameDataDir(exe: string, read: (p: string) => Buffer | undefined = readIfThere): boolean | undefined {
  let d = path.dirname(exe);
  for (let i = 0; i < 4; i++) {
    const r = buildReadsGameDataDir(d, read);
    if (r !== undefined) return r;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return undefined;
}

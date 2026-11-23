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

/** The roots a game process here may write, the override first: a build from after #4237 uses it, an older one the old root. */
export function gameDataRoots(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string[] {
  const given = gameDataOverride(env);
  const legacy = legacyGameDataRoot(platform, home);
  return given && path.resolve(given) !== path.resolve(legacy) ? [given, legacy] : [legacy];
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

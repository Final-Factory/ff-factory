/**
 * w5615: how the daemon starts a player for the players broker (machine/playersBroker.ts). The build is a worker's code, so
 * it never runs with the daemon's rights or environment:
 * - on Linux and macOS inside the player write fence its timed runs use (machine/playerFence.ts), writing only its slot
 *   folder, the sandbox's game data root and its player home;
 * - on Windows through the Low node copy (machine/lowIntegrity.ts LowCopies, unity.ts FENCED_LAUNCH_SCRIPT), so the player
 *   runs at Low integrity as the worker would have started it; with no Low copy it is refused, never started Medium;
 * - with no credential in its environment (editorEnv.ts fencedEditorEnv), the display variables, the sandbox's own game data
 *   root (gameData.ts) and the caller's session and sandbox.
 */
import { spawn } from 'node:child_process';
import { systemTempEnv } from './daemonTemp.ts';
import { fencedEditorEnv } from './editorEnv.ts';
import { exeReadsGameDataDir, playerHomeEnv, preparePlayerHome, sandboxGameDataEnv } from './gameData.ts';
import { fencedPlayer, playerWritable, type PlayerFence } from './playerFence.ts';
import { PLAYER_DISPLAY_ENV, type BrokerLaunch } from './playersBroker.ts';
import { FENCED_LAUNCH_SCRIPT } from './unity.ts';
import { run } from '../server/proc.ts';

/** The variables every player needs to start at all, kept from the daemon's own environment. */
const BASICS = ['HOME', 'PATH', 'USER', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];

/** The broker player's environment (no credential: fencedEditorEnv drops anything that looks like one). */
export function brokerPlayerEnv(base: NodeJS.ProcessEnv, l: BrokerLaunch, reads: boolean | undefined, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const pick = (names: string[]) => Object.fromEntries(names.filter((n) => typeof base[n] === 'string').map((n) => [n, base[n] as string]));
  const home = playerHomeEnv(base, reads, platform);
  return fencedEditorEnv(base, pick(BASICS), pick(PLAYER_DISPLAY_ENV), systemTempEnv(base), sandboxGameDataEnv(base, l.sandbox), home, { FF_SESSION_ID: l.session, FF_SANDBOX_ID: l.sandbox, FF_PLAYER_BROKER: '1' }).env;
}

export interface BrokerLauncherDeps {
  root: string;
  platform?: NodeJS.Platform;
  /** The player fence (Linux, macOS), probed once by the caller. */
  playerFence: () => PlayerFence;
  /** Windows: the Low-labelled node copy, or undefined when none can be made. */
  lowNode?: () => string | undefined;
  base?: NodeJS.ProcessEnv;
  /** Tests: start the (fenced) command, answer its pid. */
  start?: (cmd: string, args: string[], cwd: string, env: Record<string, string>) => Promise<number>;
}

const startDetached = (cmd: string, args: string[], cwd: string, env: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, env, detached: true, stdio: 'ignore', windowsHide: false });
    c.once('error', reject);
    c.once('spawn', () => {
      c.unref();
      if (c.pid) resolve(c.pid);
      else reject(new Error('no pid'));
    });
  });

/** The broker's `launch` (PlayersBrokerDeps.launch). */
export function brokerLauncher(d: BrokerLauncherDeps): (l: BrokerLaunch) => Promise<{ pid: number } | { refused: string }> {
  const platform = d.platform ?? process.platform;
  const base = d.base ?? process.env;
  return async (l) => {
    const env = brokerPlayerEnv(base, l, exeReadsGameDataDir(l.exe), platform);
    preparePlayerHome(playerHomeEnv(base, exeReadsGameDataDir(l.exe), platform));
    if (platform === 'win32') {
      const node = d.lowNode?.();
      if (!node) return { refused: "no Low node copy to start it with; a worker's build is never started at the daemon's Medium integrity" };
      if (d.start) return { pid: await d.start(node, ['-e', FENCED_LAUNCH_SCRIPT, l.exe, l.cwd, JSON.stringify(l.args)], l.cwd, env) };
      const r = await run(node, ['-e', FENCED_LAUNCH_SCRIPT, l.exe, l.cwd, JSON.stringify(l.args)], { timeoutMs: 60_000, env });
      const pid = Number(r.stdout.trim().split(/\s+/).pop());
      if (r.code !== 0 || !Number.isFinite(pid) || pid <= 0) return { refused: `could not start it at Low integrity: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
      return { pid };
    }
    const fenced = fencedPlayer(d.playerFence(), { cmd: l.exe, args: l.args }, [...playerWritable({ root: d.root, runDir: l.slotDir, buildDir: l.cwd, env }), ...(l.logDir ? [l.logDir] : [])]);
    if ('refused' in fenced) return { refused: fenced.refused };
    try {
      return { pid: await (d.start ?? startDetached)(fenced.cmd, fenced.args, l.cwd, env) };
    } catch (e) {
      return { refused: `could not start it: ${(e as Error).message}` };
    }
  };
}

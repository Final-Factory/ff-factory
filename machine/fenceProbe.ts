/**
 * The fence's probe (w5377, lothsahn: "is there some emergency way we could reinstall the system if things go
 * wrong?"): before the daemon puts its first sandbox agent inside a write fence, it runs a harmless command inside the
 * same fence once. If that command does not exit 0 in time (Landlock missing from the kernel, a profile the kernel
 * refuses, python3 gone, the launcher missing), the daemon logs why and, since w5555, fails closed: it holds its sandbox
 * workers and the portal alerts (machine/fenceGate.ts). A fence that cannot apply never stops the daemon; nothing here
 * throws.
 *
 * The daemon, the agent host, the machine agent's link and the installer are never fenced, so a machine update or an
 * installer re-run that turns the fence off always works (docs/worker-root.md, "Turning a fence off").
 */
import { spawnSync } from 'node:child_process';

export interface ProbeResult {
  ok: boolean;
  /** Why it failed, for the daemon log: the exit code or signal and stderr's last lines. */
  why?: string;
}

export type ProbeRun = (cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => { status: number | null; signal?: string | null; error?: Error; stderr?: string };

const realRun: ProbeRun = (cmd, args, timeoutMs, env) => {
  const r = spawnSync(cmd, args, { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, ...(env ? { env } : {}) });
  return { status: r.status, signal: r.signal, error: r.error, stderr: r.stderr };
};

/**
 * Runs `argv` (the fence's own launcher around a no-op) and says whether the fence applies on this machine. `env`, when
 * given, is all the run gets (w5838: a program in a folder workers write gets machine/maxEventsFence.ts bareEnv, none of
 * the daemon's tokens); else the daemon's own.
 */
export function probeFence(argv: string[], o: { run?: ProbeRun; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): ProbeResult {
  try {
    const [cmd, ...args] = argv;
    if (!cmd) return { ok: false, why: 'no command' };
    const r = (o.run ?? realRun)(cmd, args, o.timeoutMs ?? 15_000, o.env);
    if (r.error) return { ok: false, why: `${cmd} could not run: ${r.error.message}` };
    if (r.status === 0) return { ok: true };
    const tail = (r.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    return { ok: false, why: `${r.status === null ? `ended by ${r.signal ?? 'a timeout'}` : `exited ${r.status}`}${tail ? `; stderr: ${tail}` : ''}` };
  } catch (e) {
    return { ok: false, why: `probe failed: ${(e as Error).message}` };
  }
}

/**
 * w5552 (lothsahn: "Max events go in a folder workers can't write"): the daemon's check, once per fence, that a fenced
 * worker cannot write the Max events file. The portal marks intake threads replied or closed from that file's lines
 * (server/intake.ts onMaxEvent), so a line a hijacked worker could append would quietly drop a player's report. The
 * file sits in the daemon's own folder (machine/daemon.ts daemonMaxEventsFile), which every fence keeps read-only:
 * Landlock's `--except daemon` (machine/writeLock.ts), Seatbelt's READ_ONLY_IN_ROOT (server/workerFence.ts) and the
 * Medium label Windows keeps on the daemon's folder (machine/lowIntegrity.ts MEDIUM_CHILDREN).
 *
 * The check runs a shell inside the same fence the agents get and opens the file for append, writing nothing. The
 * daemon says the answer in its log: refused is the fence working; written is a hole, said loudly. It never throws and
 * never changes whether agents are fenced.
 */
import { spawnSync } from 'node:child_process';

/** Opens `$1` for append and writes nothing; prints WROTE or REFUSED. */
export const MAX_EVENTS_PROBE = 'if printf "" >> "$1" 2>/dev/null; then echo WROTE; else echo REFUSED; fi';

export type ProbeOut = (cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => { status: number | null; stdout?: string; stderr?: string; error?: Error };

const realRun: ProbeOut = (cmd, args, timeoutMs, env) => {
  const r = spawnSync(cmd, args, { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env } : {}) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
};

export interface MaxProbeResult {
  /** true: the fence refused the write; false: the worker could write it; undefined: the check could not run. */
  refused?: boolean;
  /** The daemon log line. */
  line: string;
}

/**
 * Runs `argv` (a fence's launcher around a shell, with MAX_EVENTS_PROBE and the file as its arguments; maxProbeArgv)
 * and says whether that fence refuses a worker's write to `file`.
 */
export function probeMaxEvents(fence: string, argv: string[], file: string, o: { run?: ProbeOut; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): MaxProbeResult {
  try {
    const [cmd, ...args] = argv;
    const r = (o.run ?? realRun)(cmd, args, o.timeoutMs ?? 30_000, o.env);
    const out = (r.stdout ?? '').trim().split(/\r?\n/).pop()?.trim();
    if (out === 'REFUSED') return { refused: true, line: `max events: ${fence} refuses a fenced worker's write to ${file} (checked)` };
    if (out === 'WROTE') return { refused: false, line: `max events: WARNING: a worker inside ${fence} could write ${file}; a hijacked worker could forge Max events and drop an intake thread (docs/max.md, w5552)` };
    const why = r.error ? r.error.message : `exited ${r.status}${r.stderr ? `; stderr: ${r.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')}` : ''}`;
    return { line: `max events: could not check whether ${fence} refuses a worker's write to ${file}: ${why.slice(0, 300)}` };
  } catch (e) {
    return { line: `max events: could not check whether ${fence} refuses a worker's write to ${file}: ${(e as Error).message}` };
  }
}

/** The shell and its arguments for the check, to go after a fence's launcher (or alone, for a Low-labelled shell). */
export const maxProbeArgv = (shell: string, file: string) => [shell, '-c', MAX_EVENTS_PROBE, 'max-events-probe', file];

/**
 * The environment for a shell the daemon runs from a folder workers write (w5717: the agent Git's bash, which a Low
 * worker could replace): only what Windows needs to start a process, none of the daemon's tokens or keys.
 */
export function bareEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'SystemDrive', 'SYSTEMDRIVE'];
  const out: NodeJS.ProcessEnv = {};
  for (const k of Object.keys(from)) if (keep.includes(k)) out[k] = from[k];
  return out;
}

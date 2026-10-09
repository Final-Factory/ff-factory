// Agent hosts' ends (w799, found on BEAST 2026-10-09). An agent host (machine/agentHost.ts) is a process of its own whose
// folder <appDir>/hosts/<session id> the daemon removes when the session is done. That day the daemon dropped two hosts
// whose processes still ran (their heartbeats were 30 s late while a release build loaded the machine), never ended
// their process trees, and could not remove their folders: Windows refuses to delete a folder a live process has open
// or works in (EPERM). One host (w790's worker 38a203f0) carried on for half an hour with its claude.exe and Unity MCP
// chain, its tool calls unanswered, while the portal gave its sandbox to a new worker; its next message failed on the
// same EPERM and errored the session. Folders of hosts that had closed normally were left behind the same way.
//
// So, here:
//   - a host's identity is its pid AND its start time (host.json), so a reused pid is never taken for it or killed;
//   - ending a host ends its whole process tree, waits until it is gone, and only then removes its folder, retrying
//     while Windows still holds it;
//   - the watch looks every minute at every host folder: a host whose process runs but whose session nobody follows (an
//     orphan) is flagged and stopped, and the folder of a host long gone is removed (a delay keeps it for a post-mortem;
//     the portal has the transcript);
//   - while a host's tree is being stopped its sandbox counts as taken (the daemon refuses a new agent there and tells
//     the portal, which does not count it free), so no slot is handed out twice.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../server/proc.ts';
import { inspectProcs } from './unityReaper.ts';
import { realDeps as realUnityDeps, treeOf, type UnityPlatform } from './unity.ts';

const MIN = 60_000;

/**
 * The limits. Where each comes from:
 * - HUNG_MS: a guess. A host's heartbeat is a 3 s timer in its own small process; on BEAST two hosts missed 30 s of it
 *   together under load (daemon.log 2026-10-09T20:01:56Z) and then beat on for hours. A host silent 5 min while its
 *   process runs is stuck, not slow, and is stopped.
 * - EXIT_WAIT_MS: a host that closed exits 200 ms after its last line (agentHost.ts close()); 10 s is a wide margin.
 * - KILL_WAIT_MS: a guess; taskkill /T /F ends a tree within a second or two, a busy machine's within seconds.
 * - SWEEP_AFTER_MS: a guess. The portal keeps the transcript; a gone host's folder is only a post-mortem's evidence
 *   (w799's was read half an hour after), so it stays 6 h after its last write and then goes.
 * - ORPHAN_LOOKS: an orphan must be seen as one by two looks in a row (a minute apart), so a session being taken back
 *   or started at the moment of one look is never stopped.
 */
export const HOST_WATCH = {
  HUNG_MS: 5 * MIN,
  EXIT_WAIT_MS: 10_000,
  KILL_WAIT_MS: 30_000,
  SWEEP_AFTER_MS: 6 * 60 * MIN,
  ORPHAN_LOOKS: 2,
  LOOK_EVERY_MS: MIN,
} as const;

/** How far a host's own start record (host.json startedAt) may lie from its process's start time and still be it. */
const START_SLACK_MS = 90_000;

/** What a host's process is now, judged by its pid and start time. `unknown`: the machine could not be asked. */
export type HostIdentity = 'same' | 'other' | 'gone' | 'unknown';

/**
 * Whether a process that started at `processStart` is the host that wrote `recordStart` (host.json): a host writes its
 * record within seconds of starting (a minute at most on a loaded machine), never before.
 */
export function sameHost(recordStart: string | number, processStart: number): boolean {
  const wrote = typeof recordStart === 'number' ? recordStart : Date.parse(recordStart);
  if (!Number.isFinite(wrote)) return false;
  return processStart <= wrote + 5_000 && processStart >= wrote - START_SLACK_MS;
}

/** The machine's hands on host processes; tests replace them. */
export interface HostProcs {
  alive(pid: number): boolean;
  /** When the process with this pid started (ms since the epoch); undefined when none runs; throws when it cannot tell. */
  startedAt(pid: number): Promise<number | undefined>;
  /** End the process and everything it started. */
  killTree(pid: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** Whether a process with this pid exists (a signal-0 probe; EPERM means it exists but is not ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function realHostProcs(platform: UnityPlatform = (process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin')): HostProcs {
  return {
    alive: pidAlive,
    startedAt: async (pid) => {
      if (!pidAlive(pid)) return undefined;
      const [f] = await inspectProcs(platform, [pid]);
      return f?.startedAt;
    },
    killTree: async (pid) => {
      if (platform === 'win32') {
        // /T: the host's claude.exe and the MCP servers it started (uvx, uv, python) go with it.
        await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 30_000 });
        return;
      }
      // A Mac or Linux: the host was started detached, so it leads a process group; its children may have left it.
      let tree = [pid];
      try {
        tree = treeOf(await realUnityDeps(platform).procs(), pid);
      } catch {
        // the group below still goes
      }
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // not a group leader, or gone
      }
      for (const p of tree.reverse()) {
        try {
          process.kill(p, 'SIGKILL');
        } catch {
          // gone
        }
      }
    },
    sleep,
  };
}

/** Wait until the process is gone; true when it is. */
export async function waitGone(procs: Pick<HostProcs, 'alive' | 'sleep'>, pid: number, ms: number): Promise<boolean> {
  const step = 200;
  for (let waited = 0; procs.alive(pid); waited += step) {
    if (waited >= ms) return false;
    await procs.sleep(step);
  }
  return true;
}

/** What `identity` needs: the pid, and when its host said it started (host.json) or was launched. */
export async function hostIdentity(procs: Pick<HostProcs, 'alive' | 'startedAt'>, pid: number, recordStart: string | number): Promise<HostIdentity> {
  if (!procs.alive(pid)) return 'gone';
  let started: number | undefined;
  try {
    started = await procs.startedAt(pid);
  } catch {
    return 'unknown';
  }
  if (started === undefined) return procs.alive(pid) ? 'unknown' : 'gone';
  return sameHost(recordStart, started) ? 'same' : 'other';
}

/**
 * End a host's process tree, once it is known to be that host (pid and start time), and wait until it is gone. Returns
 * what happened in a few words; `stopped` false when the process still runs (the machine could not tell who it is, or it
 * would not die): the folder must then stay, and the watch tries again.
 */
export async function endHostTree(procs: HostProcs, pid: number, recordStart: string | number, waitExitMs = 0): Promise<{ stopped: boolean; what: string }> {
  if (waitExitMs > 0 && (await waitGone(procs, pid, waitExitMs))) return { stopped: true, what: 'it exited' };
  let who: HostIdentity = 'unknown';
  for (let i = 0; i < 3 && who === 'unknown'; i++) {
    who = await hostIdentity(procs, pid, recordStart);
    if (who === 'unknown') await procs.sleep(2_000);
  }
  if (who === 'gone') return { stopped: true, what: 'it was gone' };
  if (who === 'other') return { stopped: true, what: `pid ${pid} is another program now (the host was gone)` };
  if (who === 'unknown') return { stopped: false, what: `could not tell whether pid ${pid} is still the host` };
  await procs.killTree(pid);
  return (await waitGone(procs, pid, HOST_WATCH.KILL_WAIT_MS)) ? { stopped: true, what: `ended its process tree (pid ${pid})` } : { stopped: false, what: `pid ${pid} did not end` };
}

/** Errors a folder removal is retried on: Windows holds a folder a little while after the last handle in it closed. */
const RETRY = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

/**
 * Remove a host folder, retrying while Windows still holds it (EPERM, EBUSY): node's own rmSync retries do not cover
 * Windows' access-denied before Node 24.21 and wait 0 ms between tries (CONTRIBUTING.md, nodejs/node#64698). Returns
 * undefined when it is gone, else the last error's message.
 */
export async function removeHostDir(dir: string, o: { rm?: (dir: string) => void; sleep?: (ms: number) => Promise<void>; tries?: number } = {}): Promise<string | undefined> {
  const rm = o.rm ?? ((d: string) => fs.rmSync(d, { recursive: true, force: true }));
  const wait = o.sleep ?? sleep;
  const tries = o.tries ?? 8;
  let last = '';
  for (let i = 0; i < tries; i++) {
    try {
      rm(dir);
      return undefined;
    } catch (e) {
      last = (e as Error).message;
      if (!RETRY.has((e as NodeJS.ErrnoException).code ?? '')) return last;
      if (i < tries - 1) await wait(Math.min(250 * 2 ** i, 4_000));
    }
  }
  return last;
}

/** A host whose tree is being stopped: its sandbox is not free until it is gone (w799). */
export interface LingeringHost {
  sessionId: string;
  pid: number;
  sandbox?: string;
  /** ISO time it started being stopped. */
  since: string;
}

/** Why a new agent of `sessionId` may not start in `sandbox` while an old host's tree there is being stopped, or undefined. */
export function lingeringRefusal(sandbox: string | undefined, sessionId: string, lingering: LingeringHost[]): string | undefined {
  if (!sandbox) return undefined;
  const other = lingering.find((l) => l.sandbox === sandbox && l.sessionId !== sessionId);
  return other ? `the agent host of session ${other.sessionId} (pid ${other.pid}) that worked in sandbox ${sandbox} is still being stopped; the sandbox is free once it is gone` : undefined;
}

// ------------------------------------------------------------------------------------------------ the watch

/** One host folder as the watch sees it. */
export interface HostFolder {
  sessionId: string;
  dir: string;
  record?: { hostProtocol: number; pid: number; startedAt: string };
}

export interface HostWatchDeps {
  procs: HostProcs;
  /** The host folders now (agentHost.ts hostFolders). */
  folders(): HostFolder[];
  /** The host protocol this daemon speaks: a host of another one is left alone, as adoptHosts leaves it. */
  protocol: number;
  /** A session this daemon follows (its host runs, starts or is being stopped): never the watch's. */
  followed(sessionId: string): boolean;
  /** The sandbox a host worked in (place.json). */
  sandboxOf(dir: string): string | undefined;
  /** Last write in the folder (ms), for the sweep. */
  lastWrite(dir: string): number | undefined;
  removeDir(dir: string): Promise<string | undefined>;
  /** A host's tree is being stopped (true) or is gone (false): the daemon tells the portal its sandbox is taken. */
  lingering(h: LingeringHost, on: boolean): void;
  log(line: string): void;
  /** Told to the portal (a sandbox event). */
  event(text: string, sandbox?: string): void;
  now(): number;
}

/**
 * The watch over host folders the daemon does not follow (w799): every minute it stops an orphaned host (its process
 * runs, nobody reads it: its tool calls hang, it holds its sandbox) and removes the folders of hosts long gone.
 */
export class HostWatch {
  private readonly d: HostWatchDeps;
  private busy = false;
  /** Looks in a row that saw each orphan. */
  private readonly seen = new Map<string, number>();

  constructor(d: HostWatchDeps) {
    this.d = d;
  }

  /** One look. Returns what it did, for the log and tests. */
  async tick(): Promise<string[]> {
    if (this.busy) return [];
    this.busy = true;
    const did: string[] = [];
    try {
      const orphansNow = new Set<string>();
      for (const h of this.d.folders()) {
        if (this.d.followed(h.sessionId)) continue;
        if (h.record && h.record.hostProtocol !== this.d.protocol) continue;
        const pid = h.record?.pid;
        if (pid && this.d.procs.alive(pid)) {
          const who = await hostIdentity(this.d.procs, pid, h.record!.startedAt);
          if (who === 'unknown') continue;
          if (who === 'same') {
            orphansNow.add(h.sessionId);
            const looks = (this.seen.get(h.sessionId) ?? 0) + 1;
            this.seen.set(h.sessionId, looks);
            if (looks < HOST_WATCH.ORPHAN_LOOKS || this.d.followed(h.sessionId)) continue;
            did.push(await this.stopOrphan(h, pid));
            continue;
          }
        }
        // Its host is gone: the folder goes once it is old enough.
        const at = this.d.lastWrite(h.dir);
        if (at !== undefined && this.d.now() - at < HOST_WATCH.SWEEP_AFTER_MS) continue;
        const err = await this.d.removeDir(h.dir);
        const line = err ? `agent host ${h.sessionId}: could not remove its folder ${h.dir} (its host is gone): ${err}` : `agent host ${h.sessionId}: removed its folder (its host is gone)`;
        this.d.log(line);
        did.push(line);
      }
      for (const id of [...this.seen.keys()]) if (!orphansNow.has(id)) this.seen.delete(id);
    } finally {
      this.busy = false;
    }
    return did;
  }

  private async stopOrphan(h: HostFolder, pid: number): Promise<string> {
    const sandbox = this.d.sandboxOf(h.dir);
    const l: LingeringHost = { sessionId: h.sessionId, pid, ...(sandbox ? { sandbox } : {}), since: new Date(this.d.now()).toISOString() };
    const where = sandbox ? ` in sandbox ${sandbox}` : '';
    this.d.log(`agent host ${h.sessionId} (pid ${pid})${where} still runs, but this daemon dropped its session: stopping it`);
    this.d.lingering(l, true);
    try {
      const r = await endHostTree(this.d.procs, pid, h.record!.startedAt);
      if (!r.stopped) {
        const line = `agent host ${h.sessionId} (pid ${pid})${where} still runs after its session was dropped, and could not be stopped: ${r.what}; the next look tries again`;
        this.d.log(line);
        this.d.event(line, sandbox);
        return line;
      }
      this.seen.delete(h.sessionId);
      const err = await this.d.removeDir(h.dir);
      const line = `Agent host ${h.sessionId} (pid ${pid})${where} still ran after this machine's daemon had dropped its session (nobody read it; its tool calls went unanswered): ${r.what}${err ? `; its folder stays: ${err}` : ', and removed its folder'}.`;
      this.d.log(line);
      this.d.event(line, sandbox);
      return line;
    } finally {
      this.d.lingering(l, false);
    }
  }
}

/** The newest write in a host folder (its files are flat), or undefined when it is gone. */
export function folderLastWrite(dir: string): number | undefined {
  try {
    let at = fs.statSync(dir).mtimeMs;
    for (const n of fs.readdirSync(dir)) {
      try {
        at = Math.max(at, fs.statSync(path.join(dir, n)).mtimeMs);
      } catch {
        // gone meanwhile
      }
    }
    return at;
  } catch {
    return undefined;
  }
}

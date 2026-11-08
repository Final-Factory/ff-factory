// w3715: an idle worker's background work can never keep holding a bench lock. A worker whose agent has stopped (it called
// wake_me and went to sleep) can leave a detached bench script behind, and its ticket then holds the machine's one bench
// lock for as long as the script runs, while every other worker waits. The portal asks this daemon to take such a ticket
// back (`bench_revoke`): the daemon writes the `revoked` file the game repo's scripts/bench/bench_queue.py reads as "give
// it back" (the helper then stops the hold's script, whose EXIT trap releases, or lets a timed ticket go), and if the
// ticket is still there REVOKE_KILL_GRACE_MS later, ends that helper's process tree, which frees the ticket (its OS lock
// dies with it and the next scan prunes the folder).
//
// Only a worker's own granted ticket is ever revoked: never a harness ticket (an editor boot's has no session, a timed run's
// `what` starts "timed run ", machine/timedRunner.ts), and nothing is ever killed but that ticket's helper pid tree.
import fs from 'node:fs';
import path from 'node:path';
import { benchLockDir } from './benchLock.ts';
import { benchQueueDir, type QueueTicket } from './benchQueue.ts';
import { pidAlive, realHostProcs } from './hostWatch.ts';

/**
 * REVOKE_KILL_GRACE_MS: a guess. bench_queue.py's helper polls its folder every few seconds, stops the hold's script with
 * SIGTERM and lets its EXIT trap release; 90 s is a wide margin for that, and still ends a stuck hold within two minutes.
 * KILL_TERM_WAIT_MS: a guess, the time a Mac or Linux helper gets to leave after SIGTERM before SIGKILL.
 */
export const REVOKE_KILL_GRACE_MS = 90_000;
export const KILL_TERM_WAIT_MS = 5_000;

export interface RevokeMessage {
  ticket: string;
  session: string;
  why: string;
}

export interface RevokeDeps {
  now(): number;
  alive(pid: number): boolean;
  /** End the helper's process tree, resolving once the attempt is over. */
  kill(pid: number): Promise<void>;
  setTimeout(fn: () => void, ms: number): unknown;
  log(line: string): void;
}

/** The ticket's session names this worker: equal, or the worker's id starts with it (a shortened id, as the leftovers' rule). */
export const sessionMatches = (ticketSession: string | undefined, id: string): boolean => !!ticketSession && !!id && (ticketSession === id || id.startsWith(ticketSession));

/** A ticket the harness itself took: an editor boot's (no session) or a timed run's leg (machine/timedRunner.ts), not a worker's own. */
export const isHarnessTicket = (t: { session?: string; what?: string }): boolean => !t.session || (t.what ?? '').startsWith('timed run ');

/** Whether the session holds a granted, not-revoked ticket of its own in these tickets (queueTickets already left out dead helpers). */
export function holdsOwnTicket(tickets: QueueTicket[], id: string): boolean {
  return tickets.some((t) => !!t.granted && !t.revoked && !isHarnessTicket(t) && sessionMatches(t.session, id));
}

/** The real machine's end of a helper tree: taskkill /T /F on Windows; elsewhere SIGTERM, then SIGKILL (its tree) after a wait. */
export async function killHelperTree(pid: number, platform: string = process.platform): Promise<void> {
  const procs = realHostProcs();
  if (platform === 'win32') {
    await procs.killTree(pid);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // gone
  }
  await new Promise<void>((r) => setTimeout(r, KILL_TERM_WAIT_MS));
  if (pidAlive(pid)) await procs.killTree(pid);
}

const realDeps = (log: (line: string) => void): RevokeDeps => ({
  now: () => Date.now(),
  alive: pidAlive,
  kill: (pid) => killHelperTree(pid),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref(); // a pending end of a helper never keeps the daemon from exiting
    return h;
  },
  log,
});

const readJson = (f: string): Record<string, unknown> | undefined => {
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * End a revoked ticket's helper tree if the ticket still names that pid and it still runs: the grace timer's step, and the
 * daemon start's (resumeRevokes). The ticket is gone when its helper let go; the pid may be another process's by now, so
 * nothing is killed then.
 */
function endIfStillHeld(infoFile: string, ticket: string, pid: number, d: RevokeDeps, when: string): void {
  const cur = readJson(infoFile);
  if (!cur || cur.pid !== pid) {
    d.log(`bench revoke ${ticket}: gone ${when}, nothing to end`);
    return;
  }
  if (!d.alive(pid)) {
    d.log(`bench revoke ${ticket}: helper pid ${pid} already ended`);
    return;
  }
  d.log(`bench revoke ${ticket}: still held ${when}; ending helper pid ${pid} and its tree`);
  d.kill(pid).then(
    () => d.log(`bench revoke ${ticket}: ended helper pid ${pid}`),
    (e: Error) => d.log(`bench revoke ${ticket}: ending helper pid ${pid} failed: ${e.message}`),
  );
}

/**
 * Take a worker's granted ticket back: write its `revoked` file, and end its helper's tree if the ticket is still there
 * after REVOKE_KILL_GRACE_MS. Returns what happened, in one short line (also logged).
 */
export function revokeTicket(root: string, msg: RevokeMessage, deps: Partial<RevokeDeps> = {}): string {
  const d: RevokeDeps = { ...realDeps(deps.log ?? ((l) => console.log(l))), ...deps };
  const done = (line: string) => {
    d.log(`bench revoke ${msg.ticket}: ${line}`);
    return line;
  };
  if (typeof msg.ticket !== 'string' || !/^t\d{8}$/.test(msg.ticket)) return done('refused: not a ticket name');
  const dir = path.join(benchQueueDir(benchLockDir(root)), msg.ticket);
  const infoFile = path.join(dir, 'info.json');
  const info = readJson(infoFile);
  if (!info) return done('refused: no such ticket here');
  const session = typeof info.session === 'string' ? info.session : '';
  const what = typeof info.what === 'string' ? info.what : '';
  if (isHarnessTicket({ session, what })) return done(`refused: a harness ticket (${what || 'no session'}), not a worker's own`);
  if (!sessionMatches(session, msg.session)) return done(`refused: it is session ${session.slice(0, 8)}'s, not ${String(msg.session).slice(0, 8)}'s`);
  const pid = info.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return done('refused: it names no helper process to end');
  if (!fs.existsSync(path.join(dir, 'granted'))) return done('refused: it is not granted (it holds nothing)');
  const revokedFile = path.join(dir, 'revoked');
  if (fs.existsSync(revokedFile)) return done('refused: already revoked');

  const now = d.now();
  const tmp = path.join(dir, `revoked.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date(now).toISOString(), ts: now / 1000, by: 'ff-factory', limit: true, why: msg.why }));
    fs.renameSync(tmp, revokedFile);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing to clean
    }
    return done(`refused: could not write revoked: ${(e as Error).message}`);
  }
  done(`revoked (${what.slice(0, 60)}; helper pid ${pid}; ${msg.why}); its helper ends after ${REVOKE_KILL_GRACE_MS / 1000} s if it is still there`);

  d.setTimeout(() => endIfStillHeld(infoFile, msg.ticket, pid, d, `after its grace (${REVOKE_KILL_GRACE_MS / 1000} s)`), REVOKE_KILL_GRACE_MS);
  return `revoked ${msg.ticket}`;
}

/**
 * w3731: the grace timer above lives in this daemon's memory, so a restart between a revoke and its timer would leave a
 * helper that ignored its `revoked` file holding the ticket for good. At start the daemon rescans the queue: every worker
 * ticket with a `revoked` file (this daemon's, or bench_queue.py's own turn limit) whose helper still runs has its helper
 * tree ended now if the revoke is at least REVOKE_KILL_GRACE_MS old, else when that grace ends. Harness tickets (an editor
 * boot's, a timed run's leg) are never touched, as in revokeTicket. Returns one line per ticket it acted on (also logged).
 */
export function resumeRevokes(root: string, deps: Partial<RevokeDeps> = {}): string[] {
  const d: RevokeDeps = { ...realDeps(deps.log ?? ((l) => console.log(l))), ...deps };
  const dir = benchQueueDir(benchLockDir(root));
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^t\d{8}$/.test(n)).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const tdir = path.join(dir, name);
    const revokedFile = path.join(tdir, 'revoked');
    if (!fs.existsSync(revokedFile)) continue;
    const infoFile = path.join(tdir, 'info.json');
    const info = readJson(infoFile);
    if (!info) continue;
    const session = typeof info.session === 'string' ? info.session : '';
    const what = typeof info.what === 'string' ? info.what : '';
    if (isHarnessTicket({ session, what })) continue;
    const pid = info.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || pid === process.pid || !d.alive(pid)) continue;
    // When it was revoked: the file's ts (epoch s), else its mtime; unreadable counts as now (a full grace from here).
    const r = readJson(revokedFile);
    let at = typeof r?.ts === 'number' && Number.isFinite(r.ts) ? r.ts * 1000 : NaN;
    if (!Number.isFinite(at)) {
      try {
        at = fs.statSync(revokedFile).mtimeMs;
      } catch {
        at = d.now();
      }
    }
    const left = Math.max(0, at + REVOKE_KILL_GRACE_MS - d.now());
    const line = `bench revoke ${name}: revoked ${Math.round((d.now() - at) / 1000)} s ago before this daemon started, helper pid ${pid} still runs; ${left === 0 ? 'ending it now' : `ending it in ${Math.ceil(left / 1000)} s if it is still there`}`;
    d.log(line);
    out.push(line);
    if (left === 0) endIfStillHeld(infoFile, name, pid, d, 'past its grace at daemon start');
    else d.setTimeout(() => endIfStillHeld(infoFile, name, pid, d, `after its grace (re-armed at daemon start)`), left);
  }
  return out;
}

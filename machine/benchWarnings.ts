// The bench queue's turn warnings (w1832): the game repo's scripts/bench/bench_queue.py sets a deadline on a holder's
// ticket once another worker waits behind it, and warns it five minutes before (`limit.json`, `warned`). Its helper prints
// the warning in the holder's command output; the daemon reports it with its stats, and the portal messages the worker
// (server/benchWarnings.ts), so a worker mid-turn sees it even while its command runs in the background. lothsahn,
// 2026-10-23: "At 25 minutes, the holder gets a warning it will actually see"; "Workers should be encouraged to push
// their uncommitted work at the warning threshold so they can be scheduled on other machines".
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BenchWarning } from '../shared/types.ts';
import { benchLockDir, pidAlive } from './benchLock.ts';
import { benchQueueDir, queueTickets } from './benchQueue.ts';

type CheckoutState = Pick<BenchWarning, 'dirty' | 'unpushed' | 'branch'> | undefined;

/** git in a worker's checkout, off the daemon's event loop, with the checkout's own fsmonitor hook off. */
const gitIn = (cwd: string) => (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 5_000 }, (e, out) => (e ? reject(e) : resolve(out))),
  );

/** A checkout's uncommitted files and unpushed commits, read with git (a few seconds at most), or undefined. */
export async function checkoutState(cwd: string | undefined, git?: (args: string[]) => Promise<string>): Promise<CheckoutState> {
  if (!cwd) return undefined;
  const run = git ?? gitIn(cwd);
  try {
    const dirty = (await run(['status', '--porcelain'])).split(/\r?\n/).filter((l) => l.trim()).length;
    const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    let unpushed: number | undefined;
    try {
      unpushed = Number((await run(['rev-list', '--count', '@{u}..HEAD'])).trim());
    } catch {
      // no upstream: never pushed
    }
    return { dirty, branch, ...(unpushed !== undefined && Number.isFinite(unpushed) ? { unpushed } : {}) };
  } catch {
    return undefined;
  }
}

/** Each warning's checkout state, read once, in the background (the stats tick reports a warning until its turn ends). */
const seen = new Map<string, { done: boolean; state?: CheckoutState }>();

/** The warned holders in this machine's bench queue: granted, unrevoked, with a worker session and a `warned` deadline. */
export function readBenchWarnings(root: string | undefined, alive: (pid: number) => boolean = pidAlive, state: (cwd: string | undefined) => Promise<CheckoutState> = checkoutState): BenchWarning[] {
  if (!root) return [];
  const lock = benchLockDir(root);
  const out: BenchWarning[] = [];
  for (const t of queueTickets(lock, alive)) {
    if (!t.granted || t.revoked || !t.session) continue;
    let lim: { deadline?: number; warned?: number; why?: string; release?: string } | undefined;
    try {
      lim = JSON.parse(fs.readFileSync(path.join(benchQueueDir(lock), t.ticket, 'limit.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!lim?.warned || typeof lim.deadline !== 'number') continue;
    const key = `${t.ticket}:${lim.deadline}`;
    let entry = seen.get(key);
    if (!entry) {
      const e: { done: boolean; state?: CheckoutState } = { done: false };
      seen.set(key, (entry = e));
      state(t.cwd).then(
        (v) => Object.assign(e, { done: true, state: v }),
        () => (e.done = true),
      );
    }
    if (!entry.done) continue; // reported on the next tick, with its checkout state
    out.push({ ticket: t.ticket, session: t.session, mode: t.mode, what: t.what, deadline: Math.round(lim.deadline * 1000), why: String(lim.why ?? ''), ...(lim.release ? { release: true } : {}), ...(entry.state ?? {}) });
  }
  if (seen.size > 200) for (const k of [...seen.keys()].slice(0, seen.size - 100)) seen.delete(k);
  return out;
}

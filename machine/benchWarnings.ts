// The bench queue's turn warnings (w1832): the game repo's scripts/bench/bench_queue.py sets a deadline on a holder's
// ticket once another worker waits behind it, and warns it five minutes before (`limit.json`, `warned`). Its helper prints
// the warning in the holder's command output; the daemon reports it with its stats, and the portal messages the worker
// (server/benchWarnings.ts), so a worker mid-turn sees it even while its command runs in the background. lothsahn,
// 2026-10-23: "At 25 minutes, the holder gets a warning it will actually see"; "Workers should be encouraged to push
// their uncommitted work at the warning threshold so they can be scheduled on other machines".
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BenchWarning } from '../shared/types.ts';
import { benchLockDir, pidAlive } from './benchLock.ts';
import { benchQueueDir, queueTickets } from './benchQueue.ts';

/** A checkout's uncommitted files and unpushed commits, read with git (a few seconds at most), or undefined. */
export function checkoutState(cwd: string | undefined, git = (args: string[]) => execFileSync('git', ['-C', cwd!, ...args], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })): Pick<BenchWarning, 'dirty' | 'unpushed' | 'branch'> | undefined {
  if (!cwd) return undefined;
  try {
    const dirty = git(['status', '--porcelain']).split(/\r?\n/).filter((l) => l.trim()).length;
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    let unpushed: number | undefined;
    try {
      unpushed = Number(git(['rev-list', '--count', '@{u}..HEAD']).trim());
    } catch {
      // no upstream: never pushed
    }
    return { dirty, branch, ...(unpushed !== undefined && Number.isFinite(unpushed) ? { unpushed } : {}) };
  } catch {
    return undefined;
  }
}

/** Each warning's checkout state, read once (the stats tick reports a warning until its turn ends). */
const seen = new Map<string, ReturnType<typeof checkoutState>>();

/** The warned holders in this machine's bench queue: granted, unrevoked, with a worker session and a `warned` deadline. */
export function readBenchWarnings(root: string | undefined, alive: (pid: number) => boolean = pidAlive, state: typeof checkoutState = checkoutState): BenchWarning[] {
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
    if (!seen.has(key)) seen.set(key, state(t.cwd));
    out.push({ ticket: t.ticket, session: t.session, mode: t.mode, what: t.what, deadline: Math.round(lim.deadline * 1000), why: String(lim.why ?? ''), ...(lim.release ? { release: true } : {}), ...(seen.get(key) ?? {}) });
  }
  if (seen.size > 200) for (const k of [...seen.keys()].slice(0, seen.size - 100)) seen.delete(k);
  return out;
}

// The daemon reads processes for a fenced worker (w5397). Under the Seatbelt worker fence (server/workerFence.ts, w5333)
// macOS refuses to exec a setuid program from inside the sandbox, and /bin/ps is setuid root: on m5, 2026-11-24 (w5393),
// a fenced agent's `ps -x -o pid=` gave "operation not permitted: ps", and `ff-leftovers list` and `end` both died on
// "spawn EPERM" (Node throws EPERM from execFile at once, where ENOENT comes back as an exit code). Nothing a fenced
// worker can run without setuid reads what ff-leftovers needs: KERN_PROCARGS2 shows the environment of a worker's
// python or node, but not of Apple's own binaries (/bin/zsh, /bin/sleep, measured on m5, w5397), and those background
// shells and tails are what ff-leftovers is for. The profile cannot allow a setuid exec either. The daemon runs outside
// the fence as the same user, so it reads them, and the worker asks it through a file mailbox beside the Unity slots one
// (FF_UNITY_SLOTS/procs, which the fence lets a worker write):
//   the worker writes ask-<id>.json  {op: "procs" | "env" | "inspect" | "census", pids?: number[], who: {session, pid}}
//   the daemon answers ans-<id>.json {ok: true, result} or {ok: false, error}, and removes the ask
//   the worker reads the answer and removes it.
// Only these fixed reads are answered: the process list (pid, ppid, command), the FF_* variables ff-leftovers reads
// (ProcEnv), start time and CPU, and the clean-up's census. Nothing is run or ended for a worker here: ff-leftovers still
// ends its own processes with kill(2), which the fence allows. An unfenced worker never asks: its own `ps` runs and the
// result is the same as before.
// w5558 (the rogue-worker audit w5451, item 32): each answer covers only the asking worker's own processes. `who` names
// the session and the asking pid; the daemon refuses the ask unless that pid is alive and the nearest process on its
// parent chain that carries a session carries that one. procs, env and inspect then cover the session's processes (by
// FF_SESSION_ID or its shells' process groups), everything under them that carries no other session, and their parents
// (no environment); no other process's environment is ever answered. census, for the clean-up's KEEP checks
// (ff-leftovers folders, check, remove, remove-slot: is a slot, sandbox or runner folder in use by anyone?), gives the
// command lines that name the install folder or an agent host, with no environment. The check is not proof against a
// worker that sets out to lie: it can name another live worker's pid and session (same user, it can read a node
// process's environment itself). It keeps the broker from handing every worker the whole machine.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ProcsOp = "procs" | "env" | "inspect" | "census";
/** Who asks (w5558): the worker's session (FF_SESSION_ID) and the asking process. */
export interface ProcsWho {
  session: string;
  pid: number;
}
export interface ProcsAsk {
  op: ProcsOp;
  pids?: number[];
  who?: ProcsWho;
}
export type ProcsAnswer =
  { ok: true; result: unknown } | { ok: false; error: string };

/**
 * The mailbox folder inside the Unity slots one. w5615: a sandbox worker's own subfolder `procs/<sandbox>` (FF_SANDBOX_ID),
 * so no worker reads, answers or removes another slot's asks; the daemon answers in every subfolder and in `procs` itself
 * (a worker of a daemon before w5615, or one outside a sandbox).
 */
export const procsMailbox = (slotsDir: string, sandbox?: string) =>
  sandbox &&
  /^[A-Za-z0-9][\w.-]{0,63}$/.test(sandbox) &&
  !sandbox.includes("..")
    ? path.join(slotsDir, "procs", sandbox)
    : path.join(slotsDir, "procs");

/** An ask or answer older than this is a dead worker's or a dead daemon's: removed. */
export const STALE_MS = 2 * 60_000;
/** How long a worker waits for the daemon. The daemon looks every POLL_MS; a reading takes about a second (three ps runs). */
export const ASK_TIMEOUT_MS = 30_000;
export const POLL_MS = 250;
/** More pids than any machine runs: an ask with more is refused. */
const MAX_PIDS = 100_000;

/** True when an error says a program could not be started because the sandbox refused it (EPERM, EACCES). */
export function execRefused(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === "EPERM" || code === "EACCES") return true;
  return /\bspawn(Sync)? \S*\s*E(PERM|ACCES)\b/.test(
    String((e as Error | null)?.message ?? ""),
  );
}

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const rm = (f: string) => {
  try {
    fs.unlinkSync(f);
  } catch {
    // gone already
  }
};

/** A session id as the daemon names them (FF_SESSION_ID). */
const SESSION = /^[\w.-]{1,80}$/;

/** A worker's ask, sanitized: a known op, who asks (w5558), and whole positive pids only. */
export function parseAsk(text: string): ProcsAsk | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  const o = j as {
    op?: unknown;
    pids?: unknown;
    who?: { session?: unknown; pid?: unknown } | null;
  };
  if (
    o.op !== "procs" &&
    o.op !== "env" &&
    o.op !== "inspect" &&
    o.op !== "census"
  )
    return undefined;
  const w = o.who;
  if (
    !w ||
    typeof w.session !== "string" ||
    !SESSION.test(w.session) ||
    !Number.isInteger(w.pid) ||
    (w.pid as number) <= 0
  )
    return undefined;
  const who = { session: w.session, pid: w.pid as number };
  if (o.op === "procs" || o.op === "census") return { op: o.op, who };
  if (!Array.isArray(o.pids) || o.pids.length > MAX_PIDS) return undefined;
  const pids = [
    ...new Set(o.pids.filter((p): p is number => Number.isInteger(p) && p > 0)),
  ];
  return { op: o.op, pids, who };
}

export interface BrokerDeps {
  dir: string;
  answer: (ask: ProcsAsk) => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
}

/** The daemon's side: answers each ask in the mailbox once. */
export class ProcsBroker {
  private busy = false;
  private made = false;
  private d: BrokerDeps;
  constructor(d: BrokerDeps) {
    this.d = d;
  }

  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      if (!this.made) {
        fs.mkdirSync(this.d.dir, { recursive: true });
        this.made = true;
      }
      const now = (this.d.now ?? Date.now)();
      let n = 0;
      // w5615: the mailbox itself and each sandbox's subfolder (procsMailbox).
      const dirs = [this.d.dir];
      for (const e of fs.readdirSync(this.d.dir, { withFileTypes: true }))
        if (e.isDirectory()) dirs.push(path.join(this.d.dir, e.name));
      for (const dir of dirs) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          const f = path.join(dir, name);
          if (/^ans-[\w-]+\.json$/.test(name) || name.endsWith(".tmp")) {
            // A worker that never read its answer (it timed out and went): removed after a while.
            try {
              if (now - fs.statSync(f).mtimeMs > STALE_MS) rm(f);
            } catch {
              // taken meanwhile
            }
            continue;
          }
          const m = /^ask-([\w-]+)\.json$/.exec(name);
          if (!m) continue;
          let text: string;
          let age = 0;
          try {
            text = fs.readFileSync(f, "utf8");
            age = now - fs.statSync(f).mtimeMs;
          } catch {
            continue;
          }
          rm(f);
          if (age > STALE_MS) continue;
          const ask = parseAsk(text);
          let out: ProcsAnswer;
          if (!ask)
            out = {
              ok: false,
              error:
                "not an ask this mailbox answers (op procs, env, inspect or census, with who: {session, pid}, and pids for env and inspect)",
            };
          else {
            try {
              out = { ok: true, result: await this.d.answer(ask) };
            } catch (e) {
              out = {
                ok: false,
                error: String((e as Error)?.message ?? e).slice(0, 300),
              };
            }
          }
          writeAtomic(path.join(dir, `ans-${m[1]}.json`), JSON.stringify(out));
          n++;
        }
      }
      return n;
    } catch (e) {
      this.d.log?.(`procs broker: ${(e as Error)?.message ?? e}`);
      return 0;
    } finally {
      this.busy = false;
    }
  }
}

/** The worker's side: one ask, waited for. Throws when the daemon does not answer in time or answers an error. */
export async function askDaemon<T>(
  dir: string,
  ask: ProcsAsk,
  o: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const askFile = path.join(dir, `ask-${id}.json`);
  const ansFile = path.join(dir, `ans-${id}.json`);
  fs.mkdirSync(dir, { recursive: true }); // w5615: a sandbox's own subfolder (procsMailbox)
  writeAtomic(askFile, JSON.stringify(ask));
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = Date.now() + (o.timeoutMs ?? ASK_TIMEOUT_MS);
  try {
    for (;;) {
      let text: string | undefined;
      try {
        text = fs.readFileSync(ansFile, "utf8");
      } catch {
        // not yet
      }
      if (text !== undefined) {
        rm(ansFile);
        const a = JSON.parse(text) as ProcsAnswer;
        if (!a.ok)
          throw new Error(
            `the daemon could not read the processes: ${a.error}`,
          );
        return a.result as T;
      }
      if (Date.now() > until)
        throw new Error(
          `ps is refused here (the worker fence) and the daemon did not answer in ${Math.round((o.timeoutMs ?? ASK_TIMEOUT_MS) / 1000)} s through ${dir}`,
        );
      await sleep(o.pollMs ?? 100);
    }
  } finally {
    rm(askFile);
  }
}

/** Run `local`; when the sandbox refuses the program it starts, ask the daemon instead. */
export async function orDaemon<T>(
  local: () => Promise<T>,
  remote: () => Promise<T>,
): Promise<T> {
  try {
    return await local();
  } catch (e) {
    if (!execRefused(e)) throw e;
    return remote();
  }
}

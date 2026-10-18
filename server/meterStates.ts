// The context meter's tally per conversation, kept on disk (w1484, asked by Lothsahn: "Can we eliminate carried by
// accounting for it properly as each worker goes?"). A conversation outlives its process: a worker's host closes when its
// agent process ends and the next message starts a new one, and the portal's own sessions start again after a restart. The
// meter (shared/spend.ts ContextMeter) lives in the process, so a new one read the whole earlier conversation as one lump of
// `carried`. AgentSession saves the meter's snapshot here after every model call and at the process's end, and a process
// that resumes the conversation (its Claude Code session id) picks it up. One small JSON file per conversation, beside the
// agent hosts on a machine (<appDir>/meters) and in the portal's data folder for its own sessions; files untouched for
// METER_STATE_DAYS go.
import fs from 'node:fs';
import path from 'node:path';
import type { MeterState } from '../shared/spend.ts';

/** How long a conversation's tally is kept after its last call: a request resumed later than that is carried again. */
export const METER_STATE_DAYS = 14;

export interface MeterStates {
  load(conversation: string): MeterState | undefined;
  save(conversation: string, state: MeterState): void;
}

/** A Claude Code session id is a uuid: anything else is no file name of ours. */
const SAFE = /^[A-Za-z0-9_-]{1,80}$/;

export function meterStates(dir: string, now: () => number = Date.now): MeterStates {
  let pruned = false;
  const file = (c: string) => path.join(dir, `${c}.json`);
  const prune = () => {
    pruned = true;
    const old = now() - METER_STATE_DAYS * 86_400_000;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.endsWith('.json') && !n.endsWith('.tmp')) continue;
      try {
        const p = path.join(dir, n);
        if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true });
      } catch {
        // another process removed or is writing it
      }
    }
  };
  return {
    load(c) {
      if (!SAFE.test(c)) return undefined;
      try {
        const s = JSON.parse(fs.readFileSync(file(c), 'utf8')) as MeterState;
        return s && s.v === 1 && typeof s.lastCtx === 'number' ? s : undefined;
      } catch {
        return undefined;
      }
    },
    save(c, state) {
      if (!SAFE.test(c)) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        // written beside and renamed: a process that dies mid-write leaves the last whole one
        const tmp = `${file(c)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, file(c));
      } catch {
        // the meter is an estimate: a failed save only means the next process carries the history
      }
      if (!pruned) prune();
    },
  };
}

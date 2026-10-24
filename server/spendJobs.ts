/**
 * The spend record's background jobs after a start (w859 backfill, w1209/w1160/w2007 repairs; docs/spend.md), out of index.ts so a
 * test can time them against a grown data folder (w2026). On 2026-10-24 the backfill took 206-538 s per start for 35-57 sessions with
 * no turn: each was read whole with readFileSync and parsed in one piece, none was ever marked read, and every start (fff-health
 * restarted the portal every 9-21 minutes) read them all again while the daemons' heartbeats waited. Now a transcript is read off the
 * main thread and parsed in slices (Store.readTranscriptAsync), one larger than SPEND_JOB_MAX_BYTES is left alone, a session with no
 * turn is remembered (SpendStore.backfillNone), and every session is followed by a pause, so the loop answers within about a second.
 */
import type { Store } from './store.ts';
import type { SpendStore } from './spend.ts';
import { isCoordinatorRole } from '../shared/spend.ts';

/** The largest transcript a start-up job reads (on disk; a compressed one by a quarter of it). Bigger ones are a coordinator's, streamed by correctCarried or left as recorded. */
export const SPEND_JOB_MAX_BYTES = 128 * 1024 * 1024;
/** The pause after each session: the loop's sockets, timers and /api/health run between two sessions. */
const PAUSE_MS = 20;
const pause = () => new Promise<void>((r) => setTimeout(r, PAUSE_MS));

type Log = { log: (l: string) => void; warn: (l: string) => void };
const consoleLog: Log = { log: (l) => console.log(l), warn: (l) => console.warn(l) };

/**
 * Sessions that ran before the spend record existed are read from their transcripts once (w859, docs/spend.md "Backfill"): dollars as
 * recorded, tokens estimated and labelled so. The newest first.
 */
export async function backfillSpend(store: Store, spend: SpendStore, out: Log = consoleLog, maxBytes = SPEND_JOB_MAX_BYTES): Promise<{ sessions: number; turns: number; usd: number; tooBig: number }> {
  const started = Date.now();
  let sessionsDone = 0;
  let turns = 0;
  let usd = 0;
  let tooBig = 0;
  const todo = [...store.sessions.values()].filter((s) => !spend.session(s.id)?.backfilled && !spend.backfillNone.has(s.id) && store.hasTranscript(s.id)).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  for (const s of todo) {
    try {
      const events = await store.readTranscriptAsync(s.id, maxBytes);
      if (!events) tooBig++;
      else {
        const r = spend.backfillSession(s.id, events, s);
        sessionsDone++;
        turns += r.turns;
        usd += r.usd;
      }
    } catch (e) {
      out.warn(`spend backfill: ${s.id}: ${(e as Error).message}`);
    }
    await pause();
  }
  if (sessionsDone) {
    spend.backfill = { at: new Date().toISOString(), sessions: (spend.backfill?.sessions ?? 0) + sessionsDone, turns: (spend.backfill?.turns ?? 0) + turns, usd: (spend.backfill?.usd ?? 0) + usd };
    spend.syncWork();
    spend.changed();
  }
  if (sessionsDone || tooBig) out.log(`spend backfill: ${sessionsDone} session(s), ${turns} turn(s), $${usd.toFixed(2)} in ${((Date.now() - started) / 1000).toFixed(0)} s${tooBig ? `; ${tooBig} transcript(s) over ${maxBytes / 1048576} MB left alone` : ''}`);
  return { sessions: sessionsDone, turns, usd, tooBig };
}

/**
 * Two repairs of the record, once per session, in the background (docs/spend.md "Coordination", "Corrections to history"): the turns the
 * old rules got wrong are recorded again by the current ones (w1209), then a coordinator's coordination gets its days from its own
 * transcript (w1160), then the carried running totals come out (w2007, streamed). A copy of the record is kept first.
 */
export async function repairSpend(store: Store, spend: SpendStore, out: Log = consoleLog, maxBytes = SPEND_JOB_MAX_BYTES): Promise<void> {
  spend.backupOnce('pre-w1209');
  const acct = spend.repairAccounts();
  if (acct.sessions) out.log(`spend repair: the accounts of ${acct.sessions} corrected session(s) and ${acct.requests} request(s) put right`);
  let looked = 0;
  let fixed = 0;
  let removed = 0;
  let moved = 0;
  let given = 0;
  let tooBig = 0;
  const skipped: string[] = [];
  for (const s of [...spend.sessions.values()].filter((x) => x.fixV !== 2 || (isCoordinatorRole(x.role) && x.coordV !== 2))) {
    try {
      const has = store.hasTranscript(s.id);
      const events = has ? await store.readTranscriptAsync(s.id, maxBytes) : undefined;
      const info = store.sessions.get(s.id);
      if (has && !events) {
        // Too big to read here: left as recorded, and marked so it is not looked at on every start (its coordination days stay as they are).
        tooBig++;
        if (s.fixV !== 2) {
          s.fixV = 2;
          spend.changed();
        }
        if (isCoordinatorRole(s.role) && s.coordV !== 2) {
          s.coordV = 2;
          spend.changed();
        }
        skipped.push(`${s.id.slice(0, 8)}: transcript over ${maxBytes / 1048576} MB`);
      } else {
        const r = spend.correctHistory(s.id, events, info);
        looked++;
        if (r.turns) fixed++;
        removed += r.removedUsd;
        moved += r.movedUsd;
        if (r.skipped && r.skipped !== 'no transcript') skipped.push(`${s.id.slice(0, 8)}: ${r.skipped}`);
        if (isCoordinatorRole(s.role) && s.coordV !== 2) given += spend.rebuildCoordination(s.id, events, info);
      }
    } catch (e) {
      out.warn(`spend repair: ${s.id}: ${(e as Error).message}`);
    }
    await pause();
  }
  // w2007: the turns billed a carried running total (a resumed CLI's older saved totals), from the transcript read in pieces
  let carriedLooked = 0;
  let carriedTurns = 0;
  let carriedUsd = 0;
  for (const s of [...spend.sessions.values()].filter((x) => x.carriedV !== 1)) {
    try {
      const keep = (line: string) => line.includes('"kind":"result"') || line.includes('"kind":"user"');
      const r = await spend.correctCarried(s.id, store.hasTranscript(s.id) ? store.scanTranscript(s.id, keep) : undefined, store.sessions.get(s.id));
      carriedLooked++;
      carriedTurns += r.turns;
      carriedUsd += r.removedUsd;
      if (r.skipped && r.skipped !== 'no transcript') skipped.push(`${s.id.slice(0, 8)}: ${r.skipped}`);
    } catch (e) {
      out.warn(`spend repair (carried totals): ${s.id}: ${(e as Error).message}`);
    }
    await pause();
  }
  if (carriedLooked) out.log(`spend repair (w2007): ${carriedLooked} session(s) looked at, $${carriedUsd.toFixed(2)} of carried running totals taken out of ${carriedTurns} turn(s)`);
  if (looked || tooBig) out.log(`spend repair: ${looked} session(s) looked at, ${fixed} corrected ($${removed.toFixed(2)} taken out of restart turns, $${moved.toFixed(2)} moved off requests a notice only cited), $${given.toFixed(2)} of coordination given its days${skipped.length ? `; left as recorded: ${skipped.slice(0, 8).join('; ')}${skipped.length > 8 ? `; and ${skipped.length - 8} more` : ''}` : ''}`);
  spend.syncWork();
}

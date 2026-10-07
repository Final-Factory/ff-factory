/**
 * What every open or stalled request is doing now (w418; docs/orchestrators.md, "What a request is doing now"), read
 * from a COPY of a portal's data folder: never point it at a live one while the server writes it.
 *
 *   node scripts/ledger-states.ts <data dir> [w342,w10]
 *   node scripts/ledger-states.ts <data dir> --w643     the w643 migration's before and after, nothing written
 *
 * Reads <dir>/work.json, <dir>/state.json (its sessions) and <dir>/send-queue.json when present, runs the same
 * derivation list_work and the Dispatcher page use (shared/workState.ts), and prints the counts per state and one line
 * per request; the ids after the folder are printed again at the end. Read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WORK_LIVE_LABEL, WORK_LIVE_STATES, liveCounts, workLiveAll } from '../shared/workState.ts';
import { runWaitsMigration } from '../server/waitsMigration.ts';
import type { SessionInfo, WorkItem } from '../shared/types.ts';

const read = <T>(file: string, fallback: T): T => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : fallback);

export function ledgerStates(dir: string, now = Date.now()) {
  const work = read<{ items?: WorkItem[] }>(path.join(dir, 'work.json'), {}).items ?? [];
  const sessions = read<{ sessions?: SessionInfo[] }>(path.join(dir, 'state.json'), {}).sessions ?? [];
  const queue = read<{ id: string; why: string }[] | { queue?: { id: string; why: string }[] }>(path.join(dir, 'send-queue.json'), []);
  const held = Array.isArray(queue) ? queue : (queue.queue ?? []);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const live = workLiveAll(work, { session: (id) => byId.get(id), queuedSend: (id) => held.find((q) => q.id === id)?.why, now });
  return { work, sessions, live };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}`) {
  const [dir, check] = process.argv.slice(2);
  if (dir && check === '--w643') {
    // On copies, in a scratch folder: the request files and the data folder stay as they are.
    const { work, sessions } = ledgerStates(dir);
    const byId = new Map(sessions.map((x) => [x.id, x]));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'w643-'));
    const machines = (read<{ machines?: { id: string }[] }>(path.join(dir, 'state.json'), {}).machines ?? []).map((m) => m.id);
    runWaitsMigration({
      dataDir: scratch,
      items: () => work,
      block: (id, b) => Object.assign(work.find((w) => w.id === id)!, { status: 'blocked', blocked: b }),
      live: () => workLiveAll(work, { session: (id) => byId.get(id), now: Date.now() }),
      machines,
      tell: () => undefined,
    });
    console.log(fs.readFileSync(path.join(scratch, 'w643-migration.md'), 'utf8'));
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
  }
  if (!dir) {
    console.error('usage: node scripts/ledger-states.ts <copy of a data dir> [w342,w10]');
    process.exit(2);
  }
  const { work, live } = ledgerStates(dir);
  const n = liveCounts(live.values());
  console.log(`${live.size} open or stalled request(s): ${WORK_LIVE_STATES.map((s) => `${n[s]} ${WORK_LIVE_LABEL[s].toLowerCase()}`).join(', ')}.`);
  const byStatus = new Map<string, Map<string, number>>();
  for (const w of work) {
    const l = live.get(w.id);
    if (!l) continue;
    const m = byStatus.get(w.status) ?? new Map<string, number>();
    m.set(l.state, (m.get(l.state) ?? 0) + 1);
    byStatus.set(w.status, m);
  }
  for (const [status, m] of byStatus) console.log(`  stored ${status}: ${[...m].map(([s, k]) => `${k} ${s}`).join(', ')}`);
  for (const s of WORK_LIVE_STATES) {
    const rows = work.filter((w) => live.get(w.id)?.state === s);
    if (!rows.length) continue;
    console.log(`\n${WORK_LIVE_LABEL[s]} (${rows.length}):`);
    for (const w of rows) {
      const l = live.get(w.id)!;
      console.log(`  ${w.id} [${w.status}] ${l.waitsOn?.length ? `on ${l.waitsOn.join(', ')}: ` : ''}${l.why} | ${w.title.slice(0, 70)}`);
    }
  }
  if (check) {
    console.log('\nChecked:');
    for (const id of check.split(',')) {
      const w = work.find((x) => x.id === id.trim());
      const l = w && live.get(w.id);
      console.log(`  ${id}: ${!w ? 'not in the ledger' : !l ? `closed (${w.status})` : `${WORK_LIVE_LABEL[l.state]} (${l.why}); stored ${w.status}`}`);
    }
  }
}

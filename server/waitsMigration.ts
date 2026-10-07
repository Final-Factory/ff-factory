// The w643 migration (docs/orchestrators.md, "Waiting, Queued, Blocked"): requests the dispatcher queued before Blocked
// existed, with a note that names what they really wait on ("Queued until w633 reports its timing table and its lab.lock
// is free", "held for the next portal deploy"), become Blocked on that; the rest stay Queued for capacity, where the
// blocker watch flags any a computer with room could take. It runs once, on the first start of a portal with w643, and
// writes the before and after of every open and stalled request to data/w643-migration.md and to the dispatcher.
import fs from 'node:fs';
import path from 'node:path';
import type { WorkBlocker, WorkItem } from '../shared/types.ts';
import { WORK_LIVE_LABEL, type WorkLive } from '../shared/workState.ts';
import { blockerName } from '../shared/blockers.ts';

/** What a queued request's own words say it waits on, or undefined: capacity, or nothing clear (it stays Queued). */
export function blockerFromNote(w: Pick<WorkItem, 'id'>, note: string, ctx: { portalSha?: string; machines: readonly string[]; work: (id: string) => WorkItem | undefined }): Omit<WorkBlocker, 'at' | 'by'> | undefined {
  const text = note.replace(/\s+/g, ' ').trim();
  const what = text.length > 200 ? `${text.slice(0, 199)}…` : text;
  const others = [...new Set([...text.matchAll(/\bw(\d{1,6})\b/gi)].map((m) => `w${m[1]}`))].filter((id) => id !== w.id.toLowerCase() && ctx.work(id));
  const lock = /\blab\.?lock\b|\block\b.*\bfree\b/i.test(text);
  const deploy = /\b(portal )?(re)?deploy(s|ed|ment)?\b|\bfffctl update\b|\bportal update\b/i.test(text);
  const machine = ctx.machines.find((m) => new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^.]*\\b(offline|asleep|sleeps|is down|comes back|back online|wakes)\\b`, 'i').test(text));
  const reports = /\b(report|reports|reported|table|results?|produces?|exists?|lands?|finish(es|ed)?|done)\b/i.test(text);
  // Another request named: blocked on it (a lock it holds frees when it reports or closes, so that covers the lock too).
  if (others.length) return { kind: 'request', ref: others[0], ...(reports || lock ? { on: 'report' as const } : {}), what };
  if (deploy) return { kind: 'deploy', what, ...(ctx.portalSha ? { sha: ctx.portalSha } : {}) };
  if (machine) return { kind: 'machine', ref: machine, what };
  if (lock) return { kind: 'lock', ref: 'lab.lock', what };
  return undefined;
}

/** The dispatcher's own words when it queued a request: its last "dispatcher: queued: <note>" log line, else its outcome. */
export function queueNote(w: Pick<WorkItem, 'log' | 'outcome'>): string {
  for (let i = w.log.length - 1; i >= 0; i--) {
    const m = /^\d\d:\d\d dispatcher: queued: (.+)$/.exec(w.log[i]);
    if (m) return m[1];
  }
  return w.outcome ?? '';
}

/**
 * What the live state read before w643, from what it reads now: the branches w643 changed are the only differences
 * (not dispatched yet and a held message for its machine read Queued, a worker between turns read Waiting, every
 * queued request read "queued it for capacity").
 */
export function liveBefore(w: Pick<WorkItem, 'status'>, wasStatus: WorkItem['status'], now: WorkLive): string {
  if (wasStatus === 'new' && now.state === 'working' && /^the dispatcher has it to decide/.test(now.why)) return 'Queued (waiting for the dispatcher to decide it)';
  if (now.state === 'working' && / between turns: | stopped until its check-in/.test(now.why)) return `Waiting (${now.why})`;
  if (now.state === 'blocked' && /^a message to \S+ waits for its machine/.test(now.why)) return `Queued (${now.why.replace('waits for its machine', 'waits for a free agent slot')})`;
  if (wasStatus === 'queued') return 'Queued (the dispatcher queued it for capacity)';
  return liveText(now);
}

export const liveText = (l: WorkLive) => `${WORK_LIVE_LABEL[l.state]}${l.waitsOn?.length ? ` on ${l.waitsOn.join(', ')}` : ''}${l.roomOn?.length ? ` [WRONG: ${l.roomOn.join(', ')} has room]` : ''} (${l.why.length > 160 ? `${l.why.slice(0, 159)}…` : l.why})`;

export interface WaitsMigrationDeps {
  dataDir: string;
  items: () => WorkItem[];
  /** Block a request (Orchestrators.ledgerEdit), with a log line. */
  block: (id: string, b: WorkBlocker, line: string) => void;
  live: () => Map<string, WorkLive>;
  portalSha?: string;
  machines: readonly string[];
  /** The dispatcher hears the table. */
  tell: (text: string) => void;
  now?: () => Date;
}

/** Run it once (a marker file in the data folder); returns the table it wrote, or undefined when it had run before. */
export function runWaitsMigration(d: WaitsMigrationDeps): string | undefined {
  const marker = path.join(d.dataDir, 'w643-migration.md');
  if (fs.existsSync(marker)) return undefined;
  const now = (d.now ?? (() => new Date()))().toISOString();
  const items = d.items();
  // A new portal (no request open or stalled) has nothing to re-classify: the marker alone, nobody told.
  if (!items.some((w) => ['new', 'question', 'queued', 'blocked', 'active', 'stalled'].includes(w.status))) {
    fs.writeFileSync(marker, `# w643 migration, ${now}\n\nNo open or stalled request.\n`);
    return undefined;
  }
  const was = new Map(items.map((w) => [w.id, w.status]));
  const byId = new Map(items.map((w) => [w.id.toLowerCase(), w]));
  const blocked: string[] = [];
  for (const w of items) {
    if (w.status !== 'queued') continue;
    const note = queueNote(w);
    const b = blockerFromNote(w, note, { portalSha: d.portalSha, machines: d.machines, work: (id) => byId.get(id.toLowerCase()) });
    if (!b) continue;
    const full: WorkBlocker = { ...b, at: now, by: 'dispatcher' };
    d.block(w.id, full, `w643 migration: Blocked on ${blockerName(full)}, from the dispatcher's queue note ("${note.slice(0, 160)}"); Queued is for capacity only now`);
    blocked.push(w.id);
  }
  const live = d.live();
  const rows = d
    .items()
    .filter((w) => live.has(w.id))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
    .map((w) => {
      const l = live.get(w.id)!;
      const before = liveBefore(w, was.get(w.id) ?? w.status, l);
      const after = liveText(l);
      return `| ${w.id} | ${w.title.replace(/\|/g, '/').slice(0, 70)} | ${was.get(w.id)} | ${before.replace(/\|/g, '/')} | ${w.status} | ${after.replace(/\|/g, '/')} |`;
    });
  const table = [
    `# w643 migration, ${now}`,
    '',
    `Every open and stalled request's live state before and after w643 (Waiting on input is a person, Queued is capacity only, Blocked is a thing). ${blocked.length ? `Blocked from their queue notes: ${blocked.join(', ')}.` : 'No queued request named what it waits on.'}`,
    '',
    '| request | title | status before | before | status after | after |',
    '|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
  fs.writeFileSync(marker, `${table}\n`);
  console.log(`w643 migration: ${blocked.length} request(s) blocked from their queue notes; the table is in ${marker}`);
  d.tell(`[ledger] The ledger's states changed (w643): Waiting on input is a person, Queued is capacity only, Blocked is a thing it waits on, and it starts by itself when that clears (decide_work block; docs/orchestrators.md "Waiting, Queued, Blocked"). ${blocked.length ? `Blocked from your own queue notes: ${blocked.join(', ')}; check each blocker with list_work and block again with the right one if it is wrong.` : ''} A request still queued while a computer that could take it has room is flagged to you. Before and after, every open and stalled request:\n\n${table}`);
  return table;
}

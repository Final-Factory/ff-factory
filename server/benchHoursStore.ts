// A machine's exclusive-bench cost per UTC hour, as its daemon reports it (w1996, shared/benchHours.ts): data/bench-hours.json,
// { v: 1, machines: { <machine id>: { <hour ISO>: row } } }. A daemon sends the last 72 h at connect and every hour; an hour
// it sends again replaces the one kept (the newest report wins: the current hour grows), and an hour older than 14 days goes.
// portal_logs reads the file (source bench_hours, server/portalLogs.ts).
import path from 'node:path';
import { BENCH_HOURS_KEEP_DAYS, sanitizeBenchRows, type BenchHourRow } from '../shared/benchHours.ts';
import { readJsonDurable, writeJsonDurable } from './durable.ts';

export interface BenchHoursSaved {
  v: 1;
  machines: Record<string, Record<string, BenchHourRow>>;
}

export const BENCH_HOURS_FILE = 'bench-hours.json';

export class BenchHoursStore {
  private readonly file: string;
  private readonly now: () => number;
  private data: BenchHoursSaved;

  constructor(o: { dataDir: string; now?: () => number }) {
    this.file = path.join(o.dataDir, BENCH_HOURS_FILE);
    this.now = o.now ?? Date.now;
    const saved = readJsonDurable<BenchHoursSaved>(this.file);
    this.data = { v: 1, machines: saved && typeof saved.machines === 'object' && saved.machines ? saved.machines : {} };
  }

  /** Merge a machine's report; returns how many hours it brought (bad rows are dropped). */
  merge(machineId: string, rows: unknown): number {
    const good = sanitizeBenchRows(rows);
    if (!good.length) return 0;
    const mine = (this.data.machines[machineId] ??= {});
    for (const r of good) mine[r.hour] = r;
    const cutoff = this.now() - BENCH_HOURS_KEEP_DAYS * 86_400_000;
    for (const [id, hours] of Object.entries(this.data.machines)) {
      for (const h of Object.keys(hours)) if (Date.parse(h) < cutoff) delete hours[h];
      if (!Object.keys(hours).length) delete this.data.machines[id];
    }
    writeJsonDurable(this.file, this.data);
    return good.length;
  }

  /** A machine's kept hours, oldest first. */
  hours(machineId: string): BenchHourRow[] {
    return Object.values(this.data.machines[machineId] ?? {}).sort((a, b) => (a.hour < b.hour ? -1 : 1));
  }
}

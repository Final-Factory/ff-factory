// One update job's part of update-job.log, and the settings it changed (w5394).
//
// update-job.log is appended to by every update job a machine runs (scripts/worker/linkJob.ts), and a report's `log` holds
// its last ~12 KB, about six jobs. A reader that took the first "Settings" line found an earlier job's
// "Settings: none changed (every setting carried)." (biscuit, m3, m5, 2026-11-24: update jobs 2950d26e, fc2f41b4 and
// 6ddf0065 had each written `+ writeLock: true` or `+ workerFence: "seatbelt"`). Each job starts its section with the line
// linkJob.ts main prints: `<ISO time> FF Factory update job <id>: ...`; this file cuts the log there.
//
// Pure, no imports: the daemon's job (scripts/worker/linkJob.ts) and the portal (server/machineRollout.ts, opsWorker.ts) share it.

/** The header a job's section starts with (linkJob.ts main), for any job id. */
const HEADER = /^(?:\S+ )?FF Factory update job (\S+?):/;

/**
 * This job's section of an update-job.log tail: from the first header naming `id` (a job cut off by a reboot and resumed
 * prints its header again, and both parts are its own) to the next header of another job, if any. With no `id`, the last
 * job's section. A log with no header at all (an ssh installer run's output) is returned whole.
 */
export function jobSection(log: string, id?: string): string {
  const lines = log.replace(/\r/g, '').split('\n');
  const heads = lines.map((l, i) => ({ i, id: HEADER.exec(l)?.[1] })).filter((h) => h.id);
  if (!heads.length) return lines.join('\n');
  const want = id ? heads.filter((h) => sameJob(h.id!, id)) : [heads[heads.length - 1]];
  if (!want.length) return ''; // its header fell out of the tail: nothing in it is known to be this job's
  const start = want[0].i;
  const next = heads.find((h) => h.i > start && !sameJob(h.id!, want[0].id!));
  return lines.slice(start, next ? next.i : undefined).join('\n');
}

const sameJob = (a: string, b: string) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * The settings an installer update changed, from its own output (scripts/worker/worker.ts: `Settings changed (...):` and
 * one indented `+ key: value`, `- key: value` or `~ key: before -> after` line each): [] for "Settings: none changed",
 * undefined when the section says neither (the update stopped before it). Values come through whole, quotes included.
 * The last such block counts (a rollback's installer run comes after).
 */
export function settingsOfLog(section: string): string[] | undefined {
  const lines = section.replace(/\r/g, '').split('\n');
  let out: string[] | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^Settings: none changed/.test(l)) out = [];
    else if (/^Settings changed\b.*:$/.test(l)) {
      out = [];
      for (let j = i + 1; j < lines.length && /^\s+[+~-] \S+: /.test(lines[j]); j++) out.push(lines[j].trim());
    }
  }
  return out;
}

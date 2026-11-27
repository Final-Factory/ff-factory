// The per-test history's writer thread (w6415, server/testHistory.ts addRunApart): a run's parse and inserts and the prune, on a
// connection of its own, so a full suite's 22,000 rows never hold the portal's event loop (13.2 s on 2026-11-27). It runs
// TestHistory's own addRun and prune, one ask at a time in the order they came, each in its one transaction.
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { TestHistory, parseNunit, type WriterAnswer, type WriterAsk } from './testHistory.ts';

let now = Date.now();
// The loop's own writes are short (a label, a mark); waiting longer for them than the loop would never costs the portal.
const h = new TestHistory({ dataDir: '', file: (workerData as { file: string }).file, now: () => now, busyMs: 60_000 });

function work(m: WriterAsk): unknown {
  if (m.op === 'addRun') return h.addRun(m.run, m.tests);
  if (m.op === 'prune') return h.prune(m.keepDays);
  // A missing or empty file records nothing, as on the loop before (ingestArtifact's `if (!xml)`).
  const xml = fs.existsSync(m.xmlFile) ? fs.readFileSync(m.xmlFile, 'utf8') : '';
  if (!xml) return { added: false, tests: 0 };
  const tests = parseNunit(xml);
  return { ...h.addRun(m.run, tests), tests: tests.length };
}

parentPort!.on('message', (m: WriterAsk) => {
  now = m.now;
  let answer: WriterAnswer;
  try {
    answer = { id: m.id, result: work(m) };
  } catch (e) {
    answer = { id: m.id, error: String((e as Error)?.message ?? e) };
  }
  parentPort!.postMessage(answer);
});

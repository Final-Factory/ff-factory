/**
 * The event loop's worst lag while the spend jobs run against a grown data folder (w2026), the way the portal ran them before the
 * fix (each transcript read whole with readFileSync and parsed in one piece) and after it (server/spendJobs.ts). Local only: CI runs
 * no timing tests (CONTRIBUTING.md "Performance"). Run it on a quiet machine:
 *
 *   node scripts/loop-lag-bench.ts [--sessions 40] [--mb 40]
 *
 * The portal VM's two shared vCPUs are slower than a workstation: read the numbers as a ratio.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.ts';
import { SpendStore, type SpendContext } from '../server/spend.ts';
import { backfillSpend } from '../server/spendJobs.ts';
import type { SessionInfo } from '../shared/types.ts';

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const N = arg('sessions', 40);
const MB = arg('mb', 40);
const T0 = Date.now() - 3_600_000;

function grown() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'loop-lag-'));
  const store = new Store(dir);
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  const kinds = ['tool_result', 'assistant', 'tool_use', 'user'];
  const lines: string[] = [];
  let bytes = 0;
  for (let k = 0; bytes < MB * 1048576; k++) {
    const kind = kinds[k % kinds.length];
    const l = JSON.stringify({ seq: k + 1, t: new Date(T0).toISOString(), kind, ...(kind === 'tool_use' ? { name: 'Bash', input: { command: 'x'.repeat(200) } } : { text: 'y'.repeat(kind === 'tool_result' ? 12_000 : 600) }) });
    lines.push(l);
    bytes += l.length + 1;
  }
  const body = lines.join('\n') + '\n';
  for (let i = 0; i < N; i++) {
    const id = `s${i}`;
    store.sessions.set(id, { id, kind: 'worker', title: `w1: ${id}`, status: 'idle', permissionMode: 'default', createdAt: new Date(T0).toISOString(), lastActivityAt: new Date(T0).toISOString(), turns: 0, costUsd: 0, pendingPermissions: [], model: 'claude-opus-5-5' } as SessionInfo);
    fs.writeFileSync(path.join(dir, 'transcripts', `${id}.jsonl`), body);
  }
  const ctx: SpendContext = { work: () => [], session: (id) => store.sessions.get(id), priorResults: () => 1 };
  return { store, spend: new SpendStore(dir, ctx) };
}

async function lagWhile(run: () => Promise<unknown>) {
  let last = performance.now();
  let worst = 0;
  const t = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  const started = performance.now();
  await run();
  clearInterval(t);
  return { worstMs: Math.round(worst), totalS: ((performance.now() - started) / 1000).toFixed(1) };
}

// before w2026: index.ts read each transcript whole and synchronously, one session per turn of the loop
const before = grown();
const old = await lagWhile(async () => {
  let done = 0;
  for (const s of before.store.sessions.values()) {
    before.spend.backfillSession(s.id, before.store.readTranscript(s.id), s);
    done++;
    await new Promise((r) => (done % 5 === 0 ? setTimeout(r, 25) : setImmediate(r)));
  }
});
const after = grown();
const neu = await lagWhile(() => backfillSpend(after.store, after.spend, { log: () => {}, warn: () => {} }));
console.log(`${N} transcripts of ${MB} MB with no turn:`);
console.log(`  before (readFileSync, one piece): worst loop lag ${old.worstMs} ms, ${old.totalS} s in all`);
console.log(`  after  (spendJobs.ts):            worst loop lag ${neu.worstMs} ms, ${neu.totalS} s in all`);
console.log(`  a second start, before: reads all ${N} again; after: ${(await lagWhile(() => backfillSpend(after.store, after.spend, { log: () => {}, warn: () => {} }))).totalS} s (nothing to read)`);

// the ledger sweep's "opened by its own worker" read, every 5 minutes: before, the last 100,000 lines of each worker read whole
const sweepBefore = await lagWhile(async () => {
  for (const s of after.store.sessions.values()) {
    after.store.readTranscript(s.id, 100_000);
    await new Promise((r) => setImmediate(r));
  }
});
const sweepFirst = await lagWhile(async () => {
  for (const s of after.store.sessions.values()) await after.store.prCreateResults(s.id);
});
const sweepNext = await lagWhile(async () => {
  for (const s of after.store.sessions.values()) await after.store.prCreateResults(s.id);
});
console.log(`the ledger sweep's read of ${N} workers' transcripts:`);
console.log(`  before (last 100,000 lines, synchronously): worst loop lag ${sweepBefore.worstMs} ms, ${sweepBefore.totalS} s`);
console.log(`  after  (prCreateResults): first pass worst ${sweepFirst.worstMs} ms, ${sweepFirst.totalS} s; the next pass ${sweepNext.totalS} s`);

// What saving state.json costs at a real portal's size, and how much of it the main thread pays (server/durable.ts).
//
//   node scripts/bench-state-save.ts                      7,265 synthetic sessions (BEAST's count on 2026-09-30)
//   node scripts/bench-state-save.ts --sessions 12000
//   node scripts/bench-state-save.ts --state path/to/state.json    a real one (read only; writes go to a temp folder)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { writeFileDurable, writeFileDurableAsync } from '../server/durable.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ROUNDS = Number(arg('rounds') ?? 20);

function synthetic(n: number) {
  const at = new Date('2026-09-30T13:00:00Z').toISOString();
  return {
    sandboxes: Array.from({ length: 5 }, (_, i) => ({ id: `sb${i}`, name: `sb${i}`, branch: `sandbox/sb${i}`, status: 'ready', unity: { state: 'stopped' }, sessionIds: [] })),
    sessions: Array.from({ length: n }, (_, i) => ({
      id: `z${i.toString(36).padStart(5, '0')}`,
      kind: 'worker',
      sandboxId: `sb${i % 5}`,
      title: `Worker ${i}: fix the belt splitter desync on join catch-up`,
      status: 'idle',
      model: 'opus',
      permissionMode: 'bypassPermissions',
      sdkSessionId: `0f8c${i}-aaaa-bbbb-cccc-1234567890ab`,
      createdAt: at,
      lastActivityAt: at,
      turns: 12,
      costUsd: 3.21,
      pendingPermissions: [],
      lastResult: 'Committed and pushed; the paired audit is green on both peers. '.repeat(3),
      requestedBy: { userId: 'ben', displayName: 'Ben' },
    })),
    settings: { heartbeatMinutes: null },
  };
}

const file = arg('state');
const state = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : synthetic(Number(arg('sessions') ?? 7265));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-bench-'));
const target = path.join(dir, 'state.json');

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return `median ${s[Math.floor(s.length / 2)].toFixed(1)} ms, max ${s[s.length - 1].toFixed(1)} ms`;
};
function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

let text = '';
const serialize = Array.from({ length: ROUNDS }, () => time(() => (text = JSON.stringify(state, null, 2))));
const oldWay = Array.from({ length: ROUNDS }, () =>
  time(() => {
    fs.writeFileSync(`${target}.tmp`, text);
    fs.renameSync(`${target}.tmp`, target);
  }),
);
const syncDurable = Array.from({ length: ROUNDS }, () => time(() => writeFileDurable(target, text)));

// The background save as the server does it: serialize on the main thread, write + fsync off it. The main thread's
// cost is the serialization plus the synchronous commit (keep the old version, rename).
const background: number[] = [];
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
for (let i = 0; i < ROUNDS; i++) {
  const t = performance.now();
  await writeFileDurableAsync(target, JSON.stringify(state, null, 2));
  background.push(performance.now() - t);
}
loop.disable();

console.log(`${state.sessions.length} sessions, state.json ${(text.length / 1e6).toFixed(2)} MB, ${os.platform()} ${os.cpus()[0]?.model ?? ''}`);
console.log(`  serialize (main thread)             ${stats(serialize)}`);
console.log(`  old save: write + rename, no fsync  ${stats(oldWay)}   (not crash-safe)`);
console.log(`  durable save, all on the main thread (shutdown only)  ${stats(syncDurable)}`);
console.log(`  durable background save, wall time  ${stats(background)}`);
console.log(`  main thread stalls meanwhile        p99 ${(loop.percentile(99) / 1e6).toFixed(1)} ms, max ${(loop.max / 1e6).toFixed(1)} ms (event-loop delay, includes the serialization)`);
fs.rmSync(dir, { recursive: true, force: true });

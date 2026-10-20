import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchTicket, findBenchQueueScript, sandboxBenchQueueScript, type TicketState } from '../machine/benchQueue.ts';
import { editorBenchGate, GATE_GRANTED_UNUSED_MS, GATE_IDLE_MS, GATE_KEEP_PLACE_MS } from '../machine/editorBenchGate.ts';
import { checkRawUnityBatch } from './guard.ts';

/**
 * w1628, lothsahn: "Won't builds use a ton of cpu and invalidate runs?" A sandbox editor's compiles, imports and test
 * runs over the Unity MCP bridge wait their turn in the bench queue (machine/editorBenchGate.ts); a batch Unity started
 * straight from the shell is refused (guard.ts checkRawUnityBatch); a checkout from before w1615 still queues.
 */

type Hook = ReturnType<typeof editorBenchGate>['hook'];
const call = (hook: Hook, tool: string) =>
  hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, session_id: 's', transcript_path: '', cwd: '/', tool_use_id: 'x' } as never, undefined, { signal: new AbortController().signal }) as Promise<Record<string, unknown>>;
const denied = (r: Record<string, unknown>) => (r.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined);

class FakeTicket {
  st: TicketState = { kind: 'waiting', line: 't00000002: shared ticket, place 2, waiting for t00000001 exclusive probe A round 3' };
  released = 0;
  wait = async () => this.st;
  state = () => this.st;
  release = () => void this.released++;
}

function world(opts: { why?: string; first?: TicketState } = {}) {
  let t = 1_000_000;
  const made: FakeTicket[] = [];
  const g = editorBenchGate({
    sandboxId: 'slot4', sandboxPath: '/w/sandboxes/slot4', root: '/w', now: () => t, log: () => {},
    ticketFor: () => {
      if (opts.why) return { why: opts.why };
      const k = new FakeTicket();
      if (opts.first) k.st = opts.first;
      made.push(k);
      return { ticket: k };
    },
  });
  return { g, made, at: (ms: number) => (t += ms) };
}

test('w1628: a compile waits its turn: refused with its place while a timed leg is ahead, then goes on the call made again; other calls never wait', async (t) => {
  const w = world();
  t.after(() => w.g.close());
  assert.deepEqual(await call(w.g.hook, 'mcp__UnityMCP__read_console'), {}, 'a read does not queue');
  const r = denied(await call(w.g.hook, 'mcp__UnityMCP__refresh_unity'));
  assert.equal(r?.permissionDecision, 'deny');
  assert.match(r!.permissionDecisionReason!, /^Queued \(w1628\): refresh_unity compiles.*waiting for t00000001 exclusive probe A round 3.*place in line is kept for 30 minutes/);
  assert.equal(w.made.length, 1);
  // Its turn comes; the call made again goes with the same ticket (its place was kept).
  w.made[0].st = { kind: 'granted', ticket: 't00000002', line: 'granted t00000002 shared pid 9' };
  assert.deepEqual(await call(w.g.hook, 'mcp__UnityMCP__refresh_unity'), {});
  assert.deepEqual(await call(w.g.hook, 'mcp__UnityMCP__run_tests'), {});
  assert.equal(w.made.length, 1, 'one ticket for the whole stretch of editor work');
  // Polling the test job keeps it; GATE_IDLE_MS after the last Unity call it is let go.
  w.at(GATE_IDLE_MS - 1000);
  await call(w.g.hook, 'mcp__UnityMCP__get_test_job');
  w.at(GATE_IDLE_MS - 1000);
  w.g.tick();
  assert.equal(w.made[0].released, 0);
  w.at(2000);
  w.g.tick();
  assert.equal(w.made[0].released, 1, 'let go when the editor work stops');
  // The next compile takes a new ticket.
  await call(w.g.hook, 'mcp__UnityMCP__refresh_unity');
  assert.equal(w.made.length, 2);
});

test('w1628: a refused compile not made again lets its place go; a turn that comes with no call waiting is kept two minutes only', async (t) => {
  const w = world();
  t.after(() => w.g.close());
  await call(w.g.hook, 'mcp__UnityMCP__run_tests');
  w.at(GATE_KEEP_PLACE_MS + 1000);
  w.g.tick();
  assert.equal(w.made[0].released, 1, 'the place is not held forever');
  await call(w.g.hook, 'mcp__UnityMCP__run_tests');
  w.made[1].st = { kind: 'granted', ticket: 't00000003', line: 'granted t00000003 shared pid 9' };
  w.g.tick();
  w.at(GATE_GRANTED_UNUSED_MS + 1000);
  w.g.tick();
  assert.equal(w.made[1].released, 1, 'a turn nobody uses does not hold the timed legs behind it');
});

test('w1628: no queue script or a failed helper: the call goes (fail open), as unity-slot run does', async (t) => {
  const none = world({ why: 'no scripts/bench/bench_queue.py' });
  t.after(() => none.g.close());
  assert.deepEqual(await call(none.g.hook, 'mcp__UnityMCP__refresh_unity'), {});
  const w = world({ first: { kind: 'failed', line: 'the bench queue helper exited 2' } });
  t.after(() => w.g.close());
  assert.deepEqual(await call(w.g.hook, 'mcp__UnityMCP__refresh_unity'), {});
});

test('w1628: a batch Unity started straight from the shell is refused; under unity-slot, ff_unity_slot or build_player.sh it goes', () => {
  for (const cmd of [
    '"C:/Program Files/Unity/Hub/Editor/6000.3.1f1/Editor/Unity.exe" -batchmode -quit -projectPath . -executeMethod Editor.ShaderBenchBuild.BuildWindows',
    '/Applications/Unity/Hub/Editor/6000.3.1f1/Unity.app/Contents/MacOS/Unity -batchmode -projectPath "$PWD" -runTests',
    'cd /f/ffw/sandboxes/slot2 && "$UNITY" -batchmode -quit -projectPath . -buildTarget Win64',
    'nohup ${UNITY_EXE} -batchmode -projectPath . > build.log 2>&1 &',
  ]) assert.match(checkRawUnityBatch(cmd) ?? '', /^Refused \(w1628\)/, cmd);
  for (const cmd of [
    'unity-slot run --label "w1628 build" -- "$UNITY" -batchmode -quit -projectPath .',
    'source scripts/unity_slot.sh && ff_unity_slot --label x -- "$UNITY" -batchmode -projectPath .',
    'python scripts/unity_slot.py run --label x -- "$UNITY" -batchmode -projectPath .',
    'bash scripts/nightly/build_player.sh "$PWD" $SHA win Builds/cache',
    '"$UNITY" -version',
    'grep -n -- -batchmode scripts/nightly/build_player.sh',
  ]) assert.equal(checkRawUnityBatch(cmd), undefined, cmd);
});

test('w1628: a checkout from before w1615 still queues, with any sandbox\'s copy of the queue script', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1628-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(sandboxBenchQueueScript(root), undefined);
  fs.mkdirSync(path.join(root, 'sandboxes', 'slot1'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sandboxes', 'slot3', 'scripts', 'bench'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sandboxes', 'slot3', 'scripts', 'bench', 'bench_queue.py'), '');
  assert.equal(sandboxBenchQueueScript(root), path.join(root, 'sandboxes', 'slot3', 'scripts', 'bench', 'bench_queue.py'));
});

const GAME = process.env.FF_GAME_REPO;
test('w1628: against the real bench_queue.py, an editor compile waits for the timed leg that holds the lock and goes when it ends', { skip: !GAME || !findBenchQueueScript([GAME]) ? 'FF_GAME_REPO not set to a checkout with scripts/bench/bench_queue.py' : false }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1628-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, BENCH_POLL_S: '0.1', BENCH_LEGACY_GRACE_S: '0', BENCH_LOCK: path.join(dir, 'bench.lock') };
  delete env.FF_BENCH_TICKET;
  const script = findBenchQueueScript([GAME])!;
  const leg = new BenchTicket({ script, lock: env.BENCH_LOCK!, mode: 'exclusive', what: 'probe A round 1', tempDir: dir, env }).take();
  assert.equal((await leg.wait(15_000)).kind, 'granted');
  const g = editorBenchGate({ sandboxId: 'slot9', sandboxPath: GAME!, root: dir, env, waitMs: 1500, log: () => {} });
  t.after(() => g.close());
  const r = denied(await call(g.hook, 'mcp__UnityMCP__refresh_unity'));
  assert.match(r?.permissionDecisionReason ?? '', /Queued \(w1628\).*waiting for t00000001 exclusive probe A round 1/);
  leg.release();
  const until = Date.now() + 15_000;
  let out: Record<string, unknown> | undefined;
  while (Date.now() < until) {
    out = await call(g.hook, 'mcp__UnityMCP__refresh_unity');
    if (!denied(out)) break;
  }
  assert.deepEqual(out, {}, 'its turn came when the leg let go');
});

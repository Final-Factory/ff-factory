import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownTimedHold } from '../machine/benchLock.ts';
import { readBenchState, readUntimed } from '../machine/benchState.ts';
import { benchGlance, untimedText } from '../shared/benchGlance.ts';
import { sandboxGuard } from './guard.ts';
import { checkTiming, logTiming, performanceTestsIn, timingMarkers, timingWork } from './timingGuard.ts';

/**
 * w1923 (lothsahn, 2026-10-23: "How do we make sure workers aren't timing things without exclusive locks?"): w1892's worker
 * timed an interleaved Burst-job micro-benchmark through `unity-bridge.py eval_file ... bench.cs` for an hour on a busy
 * LothDesktop with no bench ticket. A timing call (an editor snippet reading a clock, a Performance test, a profiler
 * capture) is refused unless the worker's session holds an exclusive ticket; ordinary snippets and test runs pass
 * untouched. The game repo's half (unity-bridge.py, unity_slot.py, bench_queue.py timed) is its
 * scripts/tests/test_timing_gate.py.
 */

// The shape of w1892's bench.cs.
const W1892_BENCH = `using System.Diagnostics;
var sw = new Stopwatch();
double a = 0, b = 0;
for (int round = 0; round < 6; round++) {
    sw.Restart(); for (int i = 0; i < 200; i++) RunArmA(); a += sw.Elapsed.TotalMilliseconds;
    sw.Restart(); for (int i = 0; i < 200; i++) RunArmB(); b += sw.Elapsed.TotalMilliseconds;
}
return $"A {a / 1200:F3} ms, B {b / 1200:F3} ms";`;

const ORDINARY = [
  'return UnityEditor.EditorApplication.isPlaying ? "playing" : "stopped";',
  '// Stopwatch would time this, but nothing here does\nreturn World.DefaultGameObjectInjectionWorld.EntityManager.Debug.EntityCount;',
  'UnityEngine.Debug.Log("Stopwatch and realtimeSinceStartup are only words here"); return 1;',
  'ProfilerDriver.LoadProfile(path, false); return ProfilerDriver.lastFrameIndex;',
];

const PERF_CLASS = `namespace FFTests {
  [TestFixture]
  [Category("Performance")]
  public class HeldConnectionPointsCostTest : EcsTestBase { [Test] public void Cost() {} }
}`;
const MIXED_CLASS = `namespace FFTests {
  public class MapMarkerDoubleClickTest {
    [Test] public void DoubleClick_Opens() {}
    [Test]
    [Category("Performance")] // local-only: a wall-clock ceiling
    [Explicit("a performance measurement: no CI run executes it (w1687); run it by name")]
    public void TheHitTest_OverAFullWorldOfMarkers_CostsMicroseconds() {}
  }
}`;

function world(t: { after: (f: () => void) => void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w1923-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const sandbox = path.join(root, 'sandboxes', 'slot4');
  const tests = path.join(sandbox, 'Assets', 'Tests', 'Perf');
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(tests, 'HeldConnectionPointsCostTest.cs'), PERF_CLASS);
  fs.writeFileSync(path.join(tests, 'MapMarkerDoubleClickTest.cs'), MIXED_CLASS);
  const tmp = path.join(root, 'tmp', 'ffa-ffb56863');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'bench.cs'), W1892_BENCH);
  fs.writeFileSync(path.join(tmp, 'open_scene.cs'), ORDINARY[0]);
  const qdir = path.join(root, 'tmp', 'bench.queue');
  const grant = (name: string, info: Record<string, unknown>) => {
    fs.mkdirSync(path.join(qdir, name), { recursive: true });
    fs.writeFileSync(path.join(qdir, name, 'info.json'), JSON.stringify({ ticket: name, mode: 'exclusive', pid: 4242, turn_min: 30, ...info }));
    fs.writeFileSync(path.join(qdir, name, 'granted'), JSON.stringify({ at: 'x', ts: Date.now() / 1000 }));
  };
  const log = () => {
    try {
      return fs.readFileSync(path.join(qdir, 'timing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { root, sandbox, tmp, qdir, grant, log };
}

test('w1923: the markers find the clocks w1892 and w1893 used and nothing in ordinary snippets', () => {
  assert.deepEqual(timingMarkers(W1892_BENCH), ['Stopwatch']);
  assert.deepEqual(timingMarkers('long t0 = ProfilerUnsafeUtility.Timestamp;'), ['ProfilerUnsafeUtility.Timestamp']);
  assert.deepEqual(timingMarkers('var r = ProfilerRecorder.StartNew(ProfilerCategory.Scripts, m);'), ['ProfilerRecorder']);
  assert.deepEqual(timingMarkers('ProfilerDriver.enabled = true;'), ['a profiler capture']);
  for (const code of ORDINARY) assert.deepEqual(timingMarkers(code), [], code);
});

test('w1923: a class tag covers its class, a method tag only its method', () => {
  assert.deepEqual([...performanceTestsIn(PERF_CLASS).classes], ['HeldConnectionPointsCostTest']);
  const mixed = performanceTestsIn(MIXED_CLASS);
  assert.deepEqual([...mixed.classes], []);
  assert.deepEqual([...mixed.methods], ['MapMarkerDoubleClickTest.TheHitTest_OverAFullWorldOfMarkers_CostsMicroseconds']);
});

test("w1923: w1892's eval_file bench is refused without a ticket and passes inside its session's exclusive ticket", (t) => {
  const w = world(t);
  const env = { TMPDIR: w.tmp };
  let held: string | undefined;
  const o = { project: w.sandbox, cwd: w.sandbox, env, root: w.root, session: 'ffb56863', sandbox: 'slot4', ownHold: () => held };
  const cmd = { command: 'python scripts/unity-bridge.py eval_file --project-path "$PWD" "$TMPDIR/bench.cs" --no-safety-checks --timeout 120' };
  const refused = checkTiming('Bash', cmd, o);
  assert.match(refused ?? '', /^Refused \(w1923\): unity-bridge\.py eval_file bench\.cs is a timing measurement \(Stopwatch\)/);
  assert.match(refused ?? '', /bench_queue\.py timed --what/);
  held = 't00000007';
  assert.equal(checkTiming('Bash', cmd, o), undefined, 'inside its exclusive ticket');
  assert.deepEqual(w.log().map((l) => [l.outcome, l.ticket, l.session]), [['refused', '', 'ffb56863'], ['ticket', 't00000007', 'ffb56863']]);
  held = undefined;
  for (const takes of [
    'python scripts/unity-bridge.py eval_file --project-path . "$TMPDIR/bench.cs" --timed "w1892 arms"',
    'python scripts/bench/bench_queue.py run --mode exclusive --reason timing --what x -- python scripts/unity-bridge.py eval_file --project-path . "$TMPDIR/bench.cs"',
  ])
    assert.equal(checkTiming('Bash', { command: takes }, o), undefined, takes);
  for (const plain of [
    'python scripts/unity-bridge.py eval_file --project-path . "$TMPDIR/open_scene.cs"',
    'python scripts/unity-bridge.py status --project-path .',
    "python scripts/unity-bridge.py eval --project-path . 'return UnityEditor.EditorApplication.isPlaying;'",
  ])
    assert.equal(timingWork('Bash', { command: plain }, o), undefined, plain);
  assert.ok(timingWork('Bash', { command: "python scripts/unity-bridge.py eval --project-path . 'var s = Stopwatch.StartNew(); return s.ElapsedTicks;'" }, o));
});

test('w1923: MCP execute_code that reads a clock is refused; a not-timing comment passes and is logged; ordinary code is untouched', (t) => {
  const w = world(t);
  const o = { project: w.sandbox, cwd: w.sandbox, root: w.root, session: 's1', ownHold: () => undefined };
  assert.match(checkTiming('mcp__UnityMCP__execute_code', { action: 'execute', code: W1892_BENCH }, o) ?? '', /^Refused \(w1923\): mcp execute_code/);
  assert.equal(checkTiming('mcp__UnityMCP__execute_code', { action: 'execute', code: '// ff-not-timing: a 10 s import timeout\nvar sw = Stopwatch.StartNew();' }, o), undefined);
  for (const code of ORDINARY) assert.equal(checkTiming('mcp__UnityMCP__execute_code', { action: 'execute', code }, o), undefined, code);
  assert.deepEqual(w.log().map((l) => [l.outcome, l.why]), [['refused', ''], ['not-timing', 'a 10 s import timeout']]);
});

test('w1923: run_tests naming a Performance test is refused; an ordinary editmode run is untouched and logs nothing', (t) => {
  const w = world(t);
  const o = { project: w.sandbox, cwd: w.sandbox, root: w.root, session: 's1', ownHold: () => undefined };
  for (const args of [
    { mode: 'EditMode', test_names: ['FFTests.HeldConnectionPointsCostTest'] },
    { mode: 'EditMode', test_names: ['FFTests.MapMarkerDoubleClickTest.TheHitTest_OverAFullWorldOfMarkers_CostsMicroseconds'] },
    { mode: 'EditMode', category_names: ['Performance'] },
    { mode: 'EditMode', group_names: ['HeldConnection.*'] },
  ])
    assert.match(checkTiming('mcp__UnityMCP__run_tests', args, o) ?? '', /^Refused \(w1923\): mcp run_tests is a timing measurement \(Performance test /, JSON.stringify(args));
  const before = w.log().length;
  // What test_select.py prints for an ordinary change: exact class names (the explicit Performance method does not run).
  assert.equal(checkTiming('mcp__UnityMCP__run_tests', { mode: 'EditMode', assembly_names: ['FFEditorTests'], test_names: ['FFTests.MapMarkerDoubleClickTest', 'FFTests.InventoryClaimsPassParityTest'], init_timeout: 120000 }, o), undefined);
  assert.equal(checkTiming('mcp__UnityMCP__run_tests', { mode: 'EditMode', assembly_names: ['FFEditorTests'] }, o), undefined, 'the full fast suite');
  assert.equal(checkTiming('mcp__UnityMCP__get_test_job', { job_id: 'j1' }, o), undefined);
  assert.equal(w.log().length, before, 'ordinary runs log nothing');
});

test('w1923: a batch -runTests selecting Performance tests needs --bench exclusive; a profiler capture needs a ticket', (t) => {
  const w = world(t);
  const o = { project: w.sandbox, cwd: w.sandbox, root: w.root, ownHold: () => undefined };
  const perf = `unity-slot run --label perf -- Unity -batchmode -projectPath ${w.sandbox} -runTests -testPlatform EditMode -testCategory Performance`;
  assert.match(checkTiming('Bash', { command: perf }, o) ?? '', /a -runTests batch run is a timing measurement/);
  assert.equal(checkTiming('Bash', { command: perf.replace('unity-slot run', 'unity-slot run --bench exclusive --bench-reason timing') }, o), undefined);
  assert.equal(checkTiming('Bash', { command: `unity-slot run -- Unity -batchmode -projectPath ${w.sandbox} -runTests -testFilter InventoryClaimsPassParityTest` }, o), undefined);
  assert.match(checkTiming('mcp__UnityMCP__manage_profiler', { action: 'profiler_start', log_file: 'x.raw' }, o) ?? '', /a profiler capture/);
  assert.match(checkTiming('mcp__UnityMCP__manage_profiler', { action: 'get_frame_timing' }, o) ?? '', /frame timings/);
  assert.equal(checkTiming('mcp__UnityMCP__manage_profiler', { action: 'get_counters', category: 'Memory' }, o), undefined);
  assert.equal(checkTiming('mcp__UnityMCP__manage_profiler', { action: 'profiler_status' }, o), undefined);
});

test("w1923: the sandbox guard refuses a pinned session's timed execute_code until its own exclusive ticket is granted", async (t) => {
  const w = world(t);
  const hook = sandboxGuard({ sandboxId: 'slot4', sandboxPath: w.sandbox, protectedPaths: [], workerRoot: w.root, session: 'ffb56863', timingHold: () => ownTimedHold(w.root, 'ffb56863', Date.now(), () => true) });
  const call = (tool_name: string, tool_input: Record<string, unknown>) =>
    hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's', transcript_path: '', cwd: w.sandbox, tool_use_id: 'u' } as never, undefined, { signal: new AbortController().signal });
  const decision = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
  assert.equal(decision(await call('mcp__UnityMCP__set_active_instance', { instance: 'slot4@abc' })), undefined);
  assert.equal(decision(await call('mcp__UnityMCP__execute_code', { action: 'execute', code: W1892_BENCH })), 'deny');
  assert.equal(decision(await call('mcp__UnityMCP__execute_code', { action: 'execute', code: ORDINARY[0] })), undefined, 'ordinary code');
  assert.equal(decision(await call('mcp__UnityMCP__run_tests', { mode: 'EditMode', test_names: ['FFTests.MapMarkerDoubleClickTest'] })), undefined, 'an ordinary test run');
  w.grant('t00000001', { session: 'someoneelse' });
  assert.equal(decision(await call('mcp__UnityMCP__execute_code', { action: 'execute', code: W1892_BENCH })), 'deny', "another worker's ticket is not this session's");
  fs.rmSync(path.join(w.qdir, 't00000001'), { recursive: true });
  w.grant('t00000002', { session: 'ffb56863', mode: 'shared' });
  assert.equal(decision(await call('mcp__UnityMCP__execute_code', { action: 'execute', code: W1892_BENCH })), 'deny', 'a shared ticket is not one');
  fs.rmSync(path.join(w.qdir, 't00000002'), { recursive: true });
  w.grant('t00000003', { session: 'ffb56863' });
  assert.equal(decision(await call('mcp__UnityMCP__execute_code', { action: 'execute', code: W1892_BENCH })), undefined, 'inside its own exclusive ticket');
});

test("w1923: the machine's bench state, the machine view and system_status show the last hour's timing outside a ticket", (t) => {
  const w = world(t);
  const now = Date.now();
  logTiming(w.root, { via: 'unity-bridge.py eval_file bench.cs', outcome: 'refused', found: ['Stopwatch'], session: 'ffb56863aa', sandbox: 'slot4' }, now - 2 * 60_000);
  logTiming(w.root, { via: 'mcp execute_code', outcome: 'ticket', found: ['Stopwatch'], ticket: 't00000003', session: 'x' }, now - 60_000);
  logTiming(w.root, { via: 'mcp execute_code', outcome: 'refused', found: ['Stopwatch'], session: 'old' }, now - 2 * 3_600_000);
  const u = readUntimed(w.qdir, now);
  assert.deepEqual(u.map((x) => [x.outcome, x.session]), [['refused', 'ffb56863aa']], 'a timed call under a ticket and an old one are left out');
  const b = readBenchState(w.root, now, () => true);
  assert.equal(b?.untimedCount, 1);
  assert.match(untimedText(b), /^1 timing call outside an exclusive ticket in the last hour \(latest: \d\d:\d\dZ refused unity-bridge\.py eval_file bench\.cs \(Stopwatch\), worker ffb56863 in slot4\)$/);
  const g = benchGlance(b, now);
  assert.equal(g?.untimed, untimedText(b));
  assert.match(g?.hint ?? '', /timing outside an exclusive ticket: .*refused unity-bridge\.py eval_file bench\.cs/);
  assert.equal(untimedText(readBenchState(path.join(w.root, 'none'), now, () => true)), '', 'an empty queue says nothing');
});

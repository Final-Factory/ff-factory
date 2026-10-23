/**
 * w1923: every timing measurement holds an exclusive bench ticket on its machine.
 *
 * lothsahn, 2026-10-23, after w1892's worker timed an interleaved Burst-job micro-benchmark through the game repo's
 * `scripts/unity-bridge.py eval_file ... bench.cs` for about an hour on a LothDesktop at 100% CPU with no ticket: "How is
 * w1892 working on Lothdesktop if the lock is shared?", then "Why did it decide to do that? How do we make sure workers
 * aren't timing things without exclusive locks?" The bench scripts take their tickets themselves and players and clips
 * check the lock (w1750), but a snippet sent to a running editor took none.
 *
 * This PreToolUse check refuses a timing call unless the worker's session holds a granted exclusive ticket in its
 * machine's bench queue (`ownHold`, machine/benchLock.ts ownTimedHold):
 *   - Unity MCP `execute_code` whose code reads a clock (TIMING_MARKERS);
 *   - Unity MCP `run_tests` that selects a Performance test (by class, Class.Method, a group regex or the category);
 *   - Unity MCP `manage_profiler` recording or reading timing counters (profiler_start, get_frame_timing, get_counters
 *     outside the Memory category);
 *   - a shell `unity-bridge.py eval` / `eval_file` whose snippet reads a clock, or `call run_tests` naming a Performance
 *     test, without `--timed` / `--not-timing` (a branch whose unity-bridge.py predates w1923 checks nothing itself);
 *   - a shell `-runTests` selecting Performance tests without `--bench exclusive`.
 * A snippet that reads a clock for something else (a timeout) carries `// ff-not-timing: <why>` and passes, logged.
 * Every check is a line in `<root>/tmp/bench.queue/timing.jsonl`, which the game repo's `bench_queue.py report` and this
 * machine's bench state (machine/benchState.ts `untimed`, the machine view and system_status) read.
 *
 * The marker list is the game repo's scripts/bench/timing_gate.py MARKERS: keep the two the same.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expandVars } from './guard.ts';

/** The clocks that make a snippet a measurement (the game repo's timing_gate.py MARKERS, PerformanceTestCensusTest.Clock). */
export const TIMING_MARKERS: [RegExp, string][] = [
  [/\bStopwatch\b/, 'Stopwatch'],
  [/\bProfilerRecorder\b/, 'ProfilerRecorder'],
  [/\bProfiling\s*\.\s*Recorder\b|\bRecorder\s*\.\s*Get\s*\(/, 'Profiling.Recorder'],
  [/\brealtimeSinceStartup(?:AsDouble)?\b/, 'realtimeSinceStartup'],
  [/\btimeSinceStartup\b/, 'timeSinceStartup'],
  [/\bProfilerUnsafeUtility\s*\.\s*Timestamp\b/, 'ProfilerUnsafeUtility.Timestamp'],
  [/\bMeasure\s*\.\s*(?:Method|Frames|Scope)\b/, 'Measure.*'],
  [/\bEnvironment\s*\.\s*TickCount/, 'Environment.TickCount'],
  [/\bDateTime\s*\.\s*(?:Utc)?Now\b/, 'DateTime.Now'],
  [/\b(?:ProfilerDriver|Profiler)\s*\.\s*enabled\s*=\s*true\b|\bProfiler\s*\.\s*enableBinaryLog\b/, 'a profiler capture'],
];
const NOT_TIMING = /\/\/\s*ff-not-timing:\s*(\S[^\r\n]*)/;
const COMMENTS = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const STRINGS = /@"(?:[^"]|"")*"|"(?:\\.|[^"\\\n])*"/g;

/** The clocks C# `code` reads, its comments and string literals left out. */
export function timingMarkers(code: string, strip = true): string[] {
  const body = strip ? code.replace(COMMENTS, ' ').replace(STRINGS, '""') : code;
  return TIMING_MARKERS.filter(([rx]) => rx.test(body)).map(([, label]) => label);
}

export const notTimingReason = (code: string) => NOT_TIMING.exec(code)?.[1].trim().slice(0, 200);

const TEST_ROOTS = ['Tests', 'TestsSlow', 'Scripts/PlayModeTests', 'Scripts/FFTests'];
const PERF_TAG = /\bCategory\s*\(\s*"Performance"\s*\)/g;

/** The classes and "Class.Method"s a C# file tags [Category("Performance")] (timing_gate.py performance_tests_in). */
export function performanceTestsIn(source: string): { classes: Set<string>; methods: Set<string> } {
  const code = source.replace(COMMENTS, (m) => ' '.repeat(m.length));
  const classes = new Set<string>();
  const methods = new Set<string>();
  for (const m of code.matchAll(PERF_TAG)) {
    let decl = code.slice(m.index! + m[0].length).replace(/^\s*\)?\s*\]?/, '');
    for (;;) {
      const s = decl.trimStart();
      if (!s.startsWith('[')) break;
      let depth = 0;
      let i = 0;
      for (; i < s.length; i++) {
        if (s[i] === '[') depth++;
        else if (s[i] === ']' && --depth === 0) break;
      }
      decl = s.slice(i + 1);
    }
    const head = decl.trimStart().slice(0, 400).split(/[{;]/, 1)[0];
    const c = /\bclass\s+(\w+)/.exec(head);
    if (c) {
      classes.add(c[1]);
      continue;
    }
    const mm = /(\w+)\s*(?:<[^>]*>)?\s*\(/.exec(head);
    const owners = [...code.slice(0, m.index).matchAll(/\bclass\s+(\w+)/g)];
    if (mm && owners.length) methods.add(`${owners[owners.length - 1][1]}.${mm[1]}`);
  }
  return { classes, methods };
}

const perfCache = new Map<string, { at: number; v: { classes: Set<string>; methods: Set<string> } }>();

/** Every Performance-tagged class and method under a project's test roots, cached for 60 s. */
export function performanceTests(project: string, now = Date.now()): { classes: Set<string>; methods: Set<string> } {
  const hit = perfCache.get(project);
  if (hit && now - hit.at < 60_000) return hit.v;
  const v = { classes: new Set<string>(), methods: new Set<string>() };
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.cs') && e.name !== 'PerformanceTestCensusTest.cs') {
        let text: string;
        try {
          text = fs.readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        if (!text.includes('Performance')) continue;
        const r = performanceTestsIn(text);
        r.classes.forEach((x) => v.classes.add(x));
        r.methods.forEach((x) => v.methods.add(x));
      }
    }
  };
  for (const root of TEST_ROOTS) walk(path.join(project, 'Assets', ...root.split('/')));
  perfCache.set(project, { at: now, v });
  return v;
}

const names = (v: unknown): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : String(v).split(/[;,]/)).map((s) => s.trim()).filter(Boolean);

/** Whether one test name ("Class", "Ns.Class", "Ns.Class.Method", "Class.Method(1)") selects a Performance test. */
export function isPerformanceName(name: string, t: { classes: Set<string>; methods: Set<string> }): boolean {
  const parts = name.trim().replace(/\(.*\)$/, '').split('.');
  const last = parts[parts.length - 1];
  const prev = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return t.classes.has(last) || (prev !== undefined && (t.classes.has(prev) || t.methods.has(`${prev}.${last}`)));
}

/** The Performance tests a run_tests call selects (timing_gate.py selected_performance_tests). */
export function selectedPerformanceTests(params: Record<string, unknown>, project: string): string[] {
  const out: string[] = [];
  if (['category_names', 'categoryNames', 'testCategory'].some((k) => names(params[k]).some((c) => c.toLowerCase() === 'performance'))) out.push('category "Performance"');
  const tests = ['test_names', 'testNames', 'testFilter'].flatMap((k) => names(params[k]));
  const groups = ['group_names', 'groupNames'].flatMap((k) => names(params[k]));
  if (!tests.length && !groups.length) return out;
  const t = performanceTests(project);
  out.push(...tests.filter((n) => isPerformanceName(n, t)));
  for (const g of groups) {
    let rx: RegExp;
    try {
      rx = new RegExp(g);
    } catch {
      continue;
    }
    const hit = [...t.classes, ...t.methods].sort().find((x) => rx.test(x));
    if (hit) out.push(`${g} (matches ${hit})`);
  }
  return out;
}

/** Profiler actions that record or read timings (manage_profiler); the Memory category's counters are not times. */
function profilerTiming(args: Record<string, unknown>): string | undefined {
  const a = String(args.action ?? '').toLowerCase();
  if (a === 'profiler_start') return 'a profiler capture (profiler_start)';
  if (a === 'get_frame_timing') return 'frame timings (get_frame_timing)';
  if (a === 'get_counters' && String(args.category ?? '').toLowerCase() !== 'memory') return `timing counters (get_counters ${String(args.category ?? '')})`.trim();
  return undefined;
}

export interface TimingCheck {
  via: string;
  found: string[];
  why?: string;
}

/** A command's segments split at ;, &&, || and | outside quotes (a snippet's own `;` stays inside its eval). */
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < cmd.length) {
        cur += c + cmd[++i];
        continue;
      }
      if (c === q) q = undefined;
      cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ';' || c === '\n' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      out.push(cur);
      cur = '';
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** The words of a shell segment, quotes kept off. */
const words = (seg: string) => (seg.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^"([\s\S]*)"$|^'([\s\S]*)'$/, (_m, a, b) => a ?? b));

function resolveFile(p: string, cwd: string, env?: Record<string, string | undefined>): string | undefined {
  const e = expandVars(p, env);
  if (e === undefined) return undefined;
  const q = /^\/[a-zA-Z]\//.test(e) ? `${e[1]}:${e.slice(2)}` : e; // Git Bash /f/x -> f:/x
  return /^[a-zA-Z]:[\\/]/.test(q) || q.startsWith('/') ? q : path.join(cwd, q);
}

/**
 * The timing work a tool call does, or undefined when it does none. `project` is the sandbox (its Performance tests);
 * `cwd` and `env` resolve an eval_file path in a shell command.
 */
export function timingWork(tool: string, args: Record<string, unknown>, o: { project: string; cwd: string; env?: Record<string, string | undefined>; readFile?: (p: string) => string | undefined }): TimingCheck | undefined {
  const t = tool.toLowerCase();
  const read = o.readFile ?? ((p: string) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  });
  if (t === 'mcp__unitymcp__execute_code') {
    if (String(args.action ?? 'execute') !== 'execute') return undefined;
    const code = String(args.code ?? '');
    const found = timingMarkers(code);
    return found.length ? { via: 'mcp execute_code', found, why: notTimingReason(code) } : undefined;
  }
  if (t === 'mcp__unitymcp__run_tests') {
    const found = selectedPerformanceTests(args, o.project);
    return found.length ? { via: 'mcp run_tests', found: found.slice(0, 4).map((n) => `Performance test ${n}`) } : undefined;
  }
  if (t === 'mcp__unitymcp__manage_profiler') {
    const f = profilerTiming(args);
    return f ? { via: 'mcp manage_profiler', found: [f] } : undefined;
  }
  if (t !== 'bash' && t !== 'powershell') return undefined;
  const cmd = String(args.command ?? '');
  // A command that takes the ticket itself waits its turn there: unity-bridge.py --timed, bench_queue.py run --mode
  // exclusive or timed, a bench script's bench_lock --timing, unity-slot --bench exclusive.
  if (/--mode[ =]exclusive|bench_queue\.py["']?\s+(?:\S+\s+)*?timed\b|\bbench_lock\s+--timing|--bench[ =]exclusive|FF_UNITY_SLOT_BENCH=exclusive/i.test(cmd)) return undefined;
  for (const seg of segments(cmd)) {
    const w = words(seg);
    const at = w.findIndex((x) => /(?:^|[\\/])unity-bridge\.py$/i.test(x));
    if (at >= 0) {
      if (w.includes('--timed')) continue;
      const sub = w.slice(at + 1).find((x) => !x.startsWith('-') && !/^[a-zA-Z]:[\\/]|^\//.test(x) && ['eval', 'eval_file', 'call'].includes(x));
      const rest = w.slice(at + 1);
      const operands: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--project-path' || rest[i] === '--timeout' || rest[i] === '--not-timing') {
          i++;
          continue;
        }
        if (rest[i].startsWith('--')) continue;
        operands.push(rest[i]);
      }
      const notTiming = rest.includes('--not-timing') ? rest[rest.indexOf('--not-timing') + 1] || 'given' : undefined;
      if (sub === 'eval' && operands[1] !== undefined) {
        const found = timingMarkers(operands[1]);
        if (found.length) return { via: 'unity-bridge.py eval', found, why: notTiming ?? notTimingReason(operands[1]) };
      } else if (sub === 'eval_file' && operands[1] !== undefined) {
        const f = resolveFile(operands[1].replace(/^file=/, ''), o.cwd, o.env);
        const code = f ? read(f) : undefined;
        const found = code ? timingMarkers(code) : [];
        if (found.length) return { via: `unity-bridge.py eval_file ${path.basename(f!)}`, found, why: notTiming ?? notTimingReason(code!) };
      } else if (sub === 'call' && operands[1] === 'run_tests') {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(operands[2] ?? '{}');
        } catch {
          // a JSON the shell builds from variables: unity-bridge.py itself checks it
        }
        const found = selectedPerformanceTests(params, o.project);
        if (found.length) return { via: 'unity-bridge.py call run_tests', found: found.slice(0, 4).map((n) => `Performance test ${n}`) };
      }
      continue;
    }
    if (w.some((x) => x.toLowerCase() === '-runtests')) {
      const params: Record<string, unknown> = {};
      for (let i = 0; i < w.length - 1; i++) {
        if (w[i].toLowerCase() === '-testcategory') params.testCategory = w[i + 1];
        if (w[i].toLowerCase() === '-testfilter') params.testFilter = w[i + 1];
      }
      const found = selectedPerformanceTests(params, o.project);
      if (found.length) return { via: 'a -runTests batch run', found: found.slice(0, 4).map((n) => `Performance test ${n}`) };
    }
  }
  return undefined;
}

export const TIMING_HOW =
  'Take an exclusive bench ticket for it first (w1923, lothsahn: "How do we make sure workers aren\'t timing things without ' +
  'exclusive locks?"). Across tool calls (MCP execute_code reads, interleaved arms, a Performance test through run_tests): ' +
  'run `python scripts/bench/bench_queue.py timed --what "<what you time>" --minutes 20` with run_in_background, wait for ' +
  'its `granted` line, do the timed calls, then `python scripts/bench/bench_queue.py timed --release`. One shell call: ' +
  '`python scripts/unity-bridge.py eval_file --project-path <sandbox> <file.cs> --timed "<what>"`, or a script of calls under ' +
  '`python scripts/bench/bench_queue.py run --mode exclusive --reason timing --what "<what>" -- bash <script>`. A batch ' +
  'Performance run: `unity-slot run --bench exclusive --bench-reason timing -- ...`. A snippet that reads a clock only for a ' +
  'timeout carries a `// ff-not-timing: <why>` comment. Merge origin/master first if your branch\'s bench_queue.py has no ' +
  '`timed` (the game repo\'s Documentation/Bench-Lock.md, "Every timing measurement holds an exclusive ticket").';

/** One line of `<root>/tmp/bench.queue/timing.jsonl` (the game repo's timing_gate.py log). Never throws. */
export function logTiming(root: string | undefined, rec: { via: string; outcome: 'ticket' | 'refused' | 'not-timing'; found: string[]; ticket?: string; why?: string; session?: string; sandbox?: string; host?: string }, now = Date.now()): void {
  if (!root) return;
  try {
    const dir = path.join(root, 'tmp', 'bench.queue');
    fs.mkdirSync(dir, { recursive: true });
    const line = { at: new Date(now).toISOString().slice(0, 19) + 'Z', ts: Math.round(now / 100) / 10, via: rec.via, outcome: rec.outcome, what: '', markers: rec.found.slice(0, 6), ticket: rec.ticket ?? '', why: (rec.why ?? '').slice(0, 200), session: rec.session ?? '', host: rec.host ?? '', sandbox: rec.sandbox ?? '', by: 'ff-factory guard' };
    fs.appendFileSync(path.join(dir, 'timing.jsonl'), JSON.stringify(line) + '\n');
  } catch {
    // the log is for the audit; the check itself stands
  }
}

/**
 * The guard's answer for a tool call: a refusal, or undefined (no timing, a not-timing snippet, or the session holds an
 * exclusive ticket). Each timing call is logged.
 */
export function checkTiming(
  tool: string,
  args: Record<string, unknown>,
  o: { project: string; cwd: string; env?: Record<string, string | undefined>; root?: string; session?: string; sandbox?: string; host?: string; ownHold: () => string | undefined; readFile?: (p: string) => string | undefined },
): string | undefined {
  const work = timingWork(tool, args, o);
  if (!work) return undefined;
  const base = { via: work.via, found: work.found, session: o.session, sandbox: o.sandbox, host: o.host };
  if (work.why) {
    logTiming(o.root, { ...base, outcome: 'not-timing', why: work.why });
    return undefined;
  }
  const held = o.ownHold();
  if (held) {
    logTiming(o.root, { ...base, outcome: 'ticket', ticket: held });
    return undefined;
  }
  logTiming(o.root, { ...base, outcome: 'refused' });
  return `Refused (w1923): ${work.via} is a timing measurement (${work.found.join(', ')}) and your session holds no exclusive bench ticket on this machine, so its numbers would come from a machine other workers' editors, builds and players share. ${TIMING_HOW}`;
}

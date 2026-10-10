/**
 * Run a test command with a deadline. Past it, print the tests still running (scripts/test-inflight-reporter.ts) and
 * every process under the command with its command line, then end them all and exit 124. So a hung CI job fails inside
 * its step, names what hung and keeps its log, where before GitHub cancelled the job at its timeout and the log was lost
 * (w906: runs 38042238048 and 38074120280, "Typecheck, unit tests, build (windows-latest, 1/2)").
 *
 *   node scripts/test-watchdog.ts --minutes 9 -- node --test ... <files>
 *
 * It sets FF_TEST_INFLIGHT for the reporter when the caller has not.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InflightTest } from './test-inflight-reporter.ts';

export interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}

/** `root` and every process below it, parents before children. */
export function descendants(procs: Proc[], root: number): Proc[] {
  const out: Proc[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const id = queue.shift()!;
    for (const p of procs) {
      if (p.ppid === id && !seen.has(p.pid)) {
        seen.add(p.pid);
        out.push(p);
        queue.push(p.pid);
      }
    }
  }
  return out;
}

/** Each test file still running, and under it its tests still running; a file with none has a process that does not exit. */
export function inflightLines(tests: InflightTest[], now: number): string[] {
  if (!tests.length) return ['no test is running (the runner itself, or a test file that never started, holds the run)'];
  const age = (t: InflightTest) => `running for ${Math.round((now - t.since) / 1000)} s`;
  const files = tests.filter((t) => t.file === undefined || t.name === t.file).sort((a, b) => a.since - b.since);
  const inside = tests.filter((t) => !files.includes(t)).sort((a, b) => a.since - b.since);
  const out: string[] = [];
  for (const f of files) {
    const mine = inside.filter((t) => t.file === f.name);
    out.push(`${f.name}: ${age(f)}${mine.length ? '' : '; its tests are done and its process has not exited (an open handle: a socket, a timer, a child process)'}`);
    for (const t of mine) out.push(`  ${'  '.repeat(t.nesting)}${t.name}: ${age(t)}`);
  }
  for (const t of inside.filter((t) => !files.some((f) => f.name === t.file))) out.push(`${t.name}${t.file ? ` (${t.file})` : ''}: ${age(t)}`);
  return out;
}

function listProcs(): Proc[] {
  if (process.platform === 'win32') {
    const json = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object @{n="pid";e={$_.ProcessId}},@{n="ppid";e={$_.ParentProcessId}},@{n="cmd";e={if ($_.CommandLine) { $_.CommandLine } else { $_.Name }}} | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true });
    return ([] as Proc[]).concat(JSON.parse(json));
  }
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
}

function readInflight(file: string): InflightTest[] {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as InflightTest[];
  } catch {
    return [];
  }
}

function endTree(pid: number) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 60_000, windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // gone already
  }
}

async function main(argv: string[]) {
  const sep = argv.indexOf('--');
  const mi = argv.indexOf('--minutes');
  const minutes = mi >= 0 && mi < sep ? Number(argv[mi + 1]) : NaN;
  const cmd = sep >= 0 ? argv.slice(sep + 1) : [];
  if (!cmd.length || !(minutes > 0)) {
    console.error('usage: node scripts/test-watchdog.ts --minutes <n> -- <command> [args...]');
    return 2;
  }
  const inflight = process.env.FF_TEST_INFLIGHT || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-inflight-')), 'inflight.json');
  const started = Date.now();
  // Its own process group on a Mac or Linux, so the whole tree can be ended; Windows ends a tree by its parent links.
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, FF_TEST_INFLIGHT: inflight }, detached: process.platform !== 'win32' });
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    const now = Date.now();
    const lines = [`WATCHDOG: the run is still going after ${Math.round((now - started) / 60_000)} min (deadline ${minutes} min). Tests still running:`, ...inflightLines(readInflight(inflight), now).map((l) => `  ${l}`)];
    try {
      lines.push('Processes under it:', ...descendants(listProcs(), child.pid!).map((p) => `  ${p.pid} (parent ${p.ppid}) ${p.cmd.slice(0, 400)}`));
    } catch (e) {
      lines.push(`(no process list: ${(e as Error).message})`);
    }
    console.error(lines.join('\n'));
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Test run hung::${lines.slice(0, 12).join('%0A')}`);
    endTree(child.pid!);
  }, minutes * 60_000);
  const code = await new Promise<number>((resolve) => {
    child.on('error', (e) => {
      console.error(`could not start ${cmd[0]}: ${e.message}`);
      resolve(127);
    });
    child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1)));
  });
  clearTimeout(timer);
  return hung ? 124 : code;
}

if (import.meta.filename === process.argv[1] || path.resolve(process.argv[1] ?? '') === import.meta.filename) {
  process.exitCode = await main(process.argv.slice(2));
}

/**
 * w5619: each test file's time, and how long its process lived past its own tests. A `node --test` reporter writes them
 * to the file named by $FF_TEST_FILE_TIMES (JSON); the check reads that file, prints the slowest files and fails on a file
 * whose process outlived its tests by more than `--max-linger` seconds: an open handle (a timer, a socket, a child
 * process, a download's retries) that the test left behind.
 *
 * On 2026-11-25 two such files took CI's Linux unit run past its 10-minute watchdog: server/attachmentFlow.test.ts lived
 * 282 s past its 3 s of tests (a worker's download still retrying when the test machine stopped), and
 * server/procsBroker.test.ts 61 s (stopTree's 60 s SIGKILL timer).
 *
 *   node --test ... --test-reporter=./scripts/test-file-times.ts --test-reporter-destination=stdout <files>
 *   node scripts/test-file-times.ts --check <file-times.json> [--max-linger 45] [--top 15]
 */
import fs from 'node:fs';
import path from 'node:path';

export interface FileTime {
  file: string;
  /** The file's process, start to end. */
  wallMs: number;
  /** Its top-level tests, added up (they run one after another in a file). */
  testsMs: number;
}

interface CompleteEvent {
  name: string;
  nesting: number;
  file?: string;
  details?: { duration_ms?: number };
}

/** Fold one `test:complete` event in. A file is a test of its own here, named by its path. */
export function addEvent(files: Map<string, FileTime>, d: CompleteEvent, cwd = process.cwd()): void {
  if (d.nesting !== 0 || !d.file) return;
  const key = path.resolve(cwd, d.file);
  const row = files.get(key) ?? { file: path.relative(cwd, key).split(path.sep).join('/'), wallMs: 0, testsMs: 0 };
  files.set(key, row);
  const ms = d.details?.duration_ms ?? 0;
  if (path.resolve(cwd, d.name) === key) row.wallMs = ms;
  else row.testsMs += ms;
}

/** Seconds a file's process lived past its tests: imports, hooks and teardown, or a handle left open. */
export const lingerS = (f: FileTime) => Math.max(0, f.wallMs - f.testsMs) / 1000;

/** The report and the files over the limit. */
export function check(rows: FileTime[], maxLingerS: number, top: number): { text: string; over: FileTime[] } {
  const s = (ms: number) => (ms / 1000).toFixed(1).padStart(6);
  const lines = [`Slowest test files (wall, its tests, after its tests), of ${rows.length}:`];
  for (const f of [...rows].sort((a, b) => b.wallMs - a.wallMs).slice(0, top)) {
    lines.push(`${s(f.wallMs)} s ${s(f.testsMs)} s ${lingerS(f).toFixed(1).padStart(6)} s  ${f.file}`);
  }
  const over = rows.filter((f) => lingerS(f) > maxLingerS).sort((a, b) => lingerS(b) - lingerS(a));
  for (const f of over) {
    lines.push(
      `${f.file}: its process lived ${lingerS(f).toFixed(0)} s past its tests (${(f.testsMs / 1000).toFixed(1)} s of tests, ${(f.wallMs / 1000).toFixed(0)} s in all; limit ${maxLingerS} s). ` +
        'A test left a handle open (a timer, a socket, a server, a child process, a download retrying): close it in the test, or wait for what it started.',
    );
  }
  return { text: lines.join('\n'), over };
}

export default async function* fileTimesReporter(source: AsyncIterable<{ type: string; data?: unknown }>): AsyncGenerator<string> {
  const out = process.env.FF_TEST_FILE_TIMES;
  const files = new Map<string, FileTime>();
  for await (const e of source) if (out && e.type === 'test:complete' && e.data) addEvent(files, e.data as CompleteEvent);
  if (out) fs.writeFileSync(out, JSON.stringify([...files.values()]));
  yield '';
}

function main(argv: string[]): number {
  const at = argv.indexOf('--check');
  if (at < 0 || !argv[at + 1]) {
    console.error('usage: node scripts/test-file-times.ts --check <file-times.json> [--max-linger 45] [--top 15]');
    return 2;
  }
  const opt = (name: string, d: number) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : d);
  if (!fs.existsSync(argv[at + 1])) {
    // The run was ended before its reporter wrote (the watchdog, a crash): the unit-test step already failed and says why.
    console.log(`No test file times: ${argv[at + 1]} was not written (the test run did not finish).`);
    return 0;
  }
  const rows = JSON.parse(fs.readFileSync(argv[at + 1], 'utf8')) as FileTime[];
  const { text, over } = check(rows, opt('--max-linger', 45), opt('--top', 15));
  console.log(text);
  for (const f of over) console.log(`::error file=${f.file}::its process lived ${lingerS(f).toFixed(0)} s past its tests: a handle left open (w5619)`);
  return over.length ? 1 : 0;
}

if (path.resolve(process.argv[1] ?? '') === import.meta.filename) process.exitCode = main(process.argv.slice(2));

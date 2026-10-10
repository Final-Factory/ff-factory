/**
 * A `node --test` reporter that prints nothing and keeps one file up to date: the tests that have started and not yet
 * finished, with when each started. scripts/test-watchdog.ts reads it when a run outlives its deadline, so a hung run
 * names its test instead of being cancelled at the job's timeout with no log (w906: two Windows CI jobs hung that way).
 *
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=./scripts/test-inflight-reporter.ts --test-reporter-destination=stdout <files>
 *
 * The file is $FF_TEST_INFLIGHT; without it the reporter does nothing. Each test file is also a test of its own here
 * (named by its path): one still listed with nothing under it means its tests are done and its process does not exit
 * (an open handle: a socket, a timer, a child process).
 */
import fs from 'node:fs';

export interface InflightTest {
  file?: string;
  name: string;
  nesting: number;
  since: number;
}

interface TestEventData {
  file?: string;
  line?: number;
  column?: number;
  name: string;
  nesting: number;
}

const keyOf = (d: TestEventData) => `${d.file ?? ''}:${d.line ?? ''}:${d.column ?? ''}:${d.nesting}:${d.name}`;

export function track(running: Map<string, InflightTest>, type: string, d: TestEventData, now: number): boolean {
  if (type === 'test:dequeue') running.set(keyOf(d), { file: d.file, name: d.name, nesting: d.nesting, since: now });
  else if (type === 'test:pass' || type === 'test:fail') running.delete(keyOf(d));
  else return false;
  return true;
}

export default async function* inflightReporter(source: AsyncIterable<{ type: string; data?: unknown }>): AsyncGenerator<string> {
  const out = process.env.FF_TEST_INFLIGHT;
  const running = new Map<string, InflightTest>();
  for await (const e of source) {
    if (!out || !e.data || !track(running, e.type, e.data as TestEventData, Date.now())) continue;
    try {
      fs.writeFileSync(out, JSON.stringify([...running.values()]));
    } catch {
      // the watchdog only reads it; a failed write leaves the last one
    }
  }
  yield '';
}

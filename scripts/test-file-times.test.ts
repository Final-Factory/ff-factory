import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { addEvent, check, lingerS, type FileTime } from './test-file-times.ts';

const cwd = path.resolve('/repo');
const abs = (f: string) => path.join(cwd, f);

test('w5619: a file is its own test: its wall time, its top-level tests added up, nested tests left out', () => {
  const files = new Map<string, FileTime>();
  const f = abs('server/a.test.ts');
  addEvent(files, { name: 'one', nesting: 0, file: f, details: { duration_ms: 1000 } }, cwd);
  addEvent(files, { name: 'inner', nesting: 1, file: f, details: { duration_ms: 900 } }, cwd);
  addEvent(files, { name: 'two', nesting: 0, file: f, details: { duration_ms: 2000 } }, cwd);
  addEvent(files, { name: path.join('server', 'a.test.ts'), nesting: 0, file: f, details: { duration_ms: 284_600 } }, cwd);
  addEvent(files, { name: 'no file', nesting: 0, details: { duration_ms: 5 } }, cwd);
  assert.deepEqual([...files.values()], [{ file: 'server/a.test.ts', wallMs: 284_600, testsMs: 3000 }]);
  assert.equal(lingerS([...files.values()][0]), 281.6);
});

test('w5619: the check fails on a file whose process outlived its tests past the limit, and names it', () => {
  // As measured on CI run 45583623165 (exp base leg): attachmentFlow 284.6 s for 2.9 s of tests; orchestrators slow but busy.
  const rows: FileTime[] = [
    { file: 'server/attachmentFlow.test.ts', wallMs: 284_600, testsMs: 2_900 },
    { file: 'server/orchestrators.test.ts', wallMs: 132_900, testsMs: 125_600 },
    { file: 'server/benchBuilds.test.ts', wallMs: 22_900, testsMs: 4_700 },
  ];
  const { text, over } = check(rows, 45, 2);
  assert.deepEqual(over.map((f) => f.file), ['server/attachmentFlow.test.ts']);
  assert.match(text, /server\/attachmentFlow\.test\.ts: its process lived 282 s past its tests/);
  assert.match(text, /of 3:\n\s+284\.6 s\s+2\.9 s\s+281\.7 s  server\/attachmentFlow\.test\.ts\n\s+132\.9 s/);
  assert.doesNotMatch(text, /benchBuilds.*lived/);
  assert.deepEqual(check(rows, 300, 15).over, []);
});

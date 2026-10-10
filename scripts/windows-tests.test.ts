import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.ts';

/**
 * .github/windows-tests.txt is what the Windows job runs, and windows.yml's paths say when it runs (w910). These keep the
 * three in step: a Windows-only test that is not listed would run nowhere, and a covered file missing from the paths
 * would change without the Windows job seeing it.
 */

const LIST = path.join(ROOT, '.github', 'windows-tests.txt');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'windows.yml');

interface Entry {
  file: string;
  covers: string[];
  why: string;
}

export function parseList(text: string): Entry[] {
  return text
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const [file, covers, why] = l.split('|').map((x) => x.trim());
      return { file, covers: (covers ?? '').split(',').map((x) => x.trim()).filter(Boolean), why: why ?? '' };
    });
}

/** The `paths:` entries under one trigger of a workflow (plain lists only, as windows.yml writes them). */
export function triggerPaths(yml: string, trigger: string): string[] {
  const block = new RegExp(`^  ${trigger}:\\n((?:    .*\\n)+)`, 'm').exec(yml)?.[1] ?? '';
  const list = /^    paths:\n((?:      - .*\n)+)/m.exec(block)?.[1] ?? '';
  return [...list.matchAll(/- '([^']+)'/g)].map((m) => m[1]);
}

/** GitHub's path filter for the forms used here: `**` any depth, `*` within one folder. */
export function globMatches(glob: string, file: string): boolean {
  const rx = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${rx}$`).test(file);
}

/** A test that is skipped unless on Windows (the forms this repo uses). */
export const WINDOWS_ONLY = /skip:\s*(?:process\.platform\s*!==\s*'win32'|!onWindows(?:Ci)?\b)|'Windows (?:CI )?only'/;

const entries = parseList(fs.readFileSync(LIST, 'utf8'));
const yml = fs.readFileSync(WORKFLOW, 'utf8');

test('windows tests: every listed file exists and says what it covers and why it needs Windows', () => {
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.ok(fs.existsSync(path.join(ROOT, e.file)), `${e.file} is listed but does not exist`);
    assert.match(e.file, /\.test\.ts$/, e.file);
    assert.ok(e.covers.length, `${e.file}: no covered files`);
    assert.ok(e.why.length > 10, `${e.file}: no reason`);
    for (const c of e.covers) assert.ok(fs.existsSync(path.join(ROOT, c.replace(/\/\*\*$/, ''))), `${e.file} covers ${c}, which does not exist`);
  }
});

test('windows tests: a test skipped everywhere but Windows is listed, or it would never run', () => {
  const listed = new Set(entries.map((e) => e.file));
  const files = ['server', 'scripts'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.test.ts')).map((f) => `${d}/${f}`));
  const missing = files.filter((f) => f !== 'scripts/windows-tests.test.ts' && WINDOWS_ONLY.test(fs.readFileSync(path.join(ROOT, f), 'utf8')) && !listed.has(f));
  assert.deepEqual(missing, [], 'add them to .github/windows-tests.txt with what they cover and why');
});

test('windows tests: windows.yml runs when a listed test, a covered file or the list itself changes, on pull requests and on main alike', () => {
  const pr = triggerPaths(yml, 'pull_request');
  assert.deepEqual(triggerPaths(yml, 'push'), pr, 'the same paths for both');
  const must = [...entries.flatMap((e) => [e.file, ...e.covers.map((c) => c.replace(/\*\*$/, 'any/file.ts'))]), '.github/windows-tests.txt', '.github/workflows/windows.yml', 'server/testPowershell.ts', 'scripts/a.ps1'];
  const uncovered = must.filter((f) => !pr.some((g) => globMatches(g, f)));
  assert.deepEqual(uncovered, [], 'add them to both paths lists in .github/workflows/windows.yml');
  assert.match(yml, /grep -vE '\^\\s\*\(#\|\$\)' \.github\/windows-tests\.txt/, 'the job runs the listed files');
});

test('windows tests: the path filter reads globs as GitHub does', () => {
  assert.ok(globMatches('machine/**', 'machine/a/b.ts'));
  assert.ok(globMatches('**/*.ps1', 'scripts/worker/x.ps1'));
  assert.ok(globMatches('**/*.ps1', 'x.ps1'));
  assert.ok(!globMatches('server/proc.ts', 'server/proc.test.ts'));
  assert.ok(!globMatches('scripts/*.ts', 'scripts/worker/x.ts'));
  assert.ok(WINDOWS_ONLY.test("{ skip: process.platform !== 'win32' && 'Windows only' }"));
  assert.ok(WINDOWS_ONLY.test("{ skip: !onWindowsCi && 'Windows CI only' }"));
  assert.ok(!WINDOWS_ONLY.test("{ skip: process.platform === 'win32' && 'POSIX only' }"));
});

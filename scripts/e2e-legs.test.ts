import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.ts';
import { PROJECT_NAMES } from '../playwright.config.ts';

/**
 * ci.yml runs the end-to-end tests in one job per browser engine, each with its own projects (E2E_PROJECTS, w1191). A
 * project in no leg would never run in CI, and one in two would run twice: this keeps the legs and playwright.config.ts
 * in step.
 */

const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');

/** The `projects:` lists of the e2e job's matrix legs, in order. */
export function legProjects(yml: string): string[][] {
  const e2e = /^  e2e:\n((?:(?: {4}.*)?\n)+)/m.exec(yml)?.[1] ?? '';
  return [...e2e.matchAll(/^ {12}projects: (.+)$/gm)].map((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
}

test('e2e legs: the parser reads a matrix of two legs', () => {
  const yml = ['jobs:', '  e2e:', '    strategy:', '      matrix:', '        include:', '          - engine: A', '            projects: a,b', '          - engine: B', '            projects: c', '  other:', '    x: 1', ''].join('\n');
  assert.deepEqual(legProjects(yml), [['a', 'b'], ['c']]);
});

test('e2e legs: every Playwright project runs in exactly one of ci.yml\'s e2e legs', () => {
  const legs = legProjects(fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n'));
  assert.ok(legs.length >= 2, `ci.yml's e2e job has ${legs.length} legs with a projects list`);
  const named = legs.flat();
  for (const p of PROJECT_NAMES) {
    const n = named.filter((x) => x === p).length;
    assert.equal(n, 1, `project ${p} is in ${n} e2e legs (it must be in one)`);
  }
  for (const x of named) assert.ok(PROJECT_NAMES.includes(x), `ci.yml names ${x}, which is no project in playwright.config.ts`);
});

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

/** The steps of ci.yml's e2e job that install the browsers: their names, `timeout-minutes` and run scripts. */
export function installSteps(yml: string): { name: string; timeout?: number; run: string }[] {
  const e2e = /^  e2e:\n((?:(?: {4}.*)?\n)+)/m.exec(yml)?.[1] ?? '';
  return e2e
    .split(/^ {6}- /m)
    .slice(1)
    .map((s) => ({
      name: /^name: (.+)$/m.exec(s)?.[1] ?? '',
      timeout: Number(/^ {8}timeout-minutes: (\d+)$/m.exec(s)?.[1]) || undefined,
      run: /^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(s)?.[1] ?? /^ {8}run: (.+)$/m.exec(s)?.[1] ?? '',
    }))
    .filter((s) => /playwright install|scripts\/playwright-browsers\.sh$/.test(s.run));
}

// The Ubuntu mirror sometimes hangs or trickles inside `playwright install --with-deps` for the job's whole 20 minutes (3
// WebKit jobs on 2026-10-22). w922 gave the step a time limit and a second try; w1194's move back to GitHub's runners dropped
// both, unseen (w1758). On 2026-11-11 both mirrors hung (w3942), so the install comes from a cache with no apt call, and only
// a miss goes to the network: each try there has its own limit, a try cut off has its apt-get ended (it holds dpkg's lock,
// which failed the next try at once) and the next goes to another mirror. scripts/playwright-browsers.test.ts runs the
// script itself against a hung apt-get.
test('e2e legs: the browser install comes from the cache and gives up on a hung mirror', () => {
  const steps = installSteps(fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n'));
  assert.equal(steps.length, 1, `ci.yml installs the browsers in ${steps.length} steps`);
  const [s] = steps;
  assert.ok(s.timeout && s.timeout <= 10, `"${s.name}" has timeout-minutes ${s.timeout ?? 'unset'} (at most 10)`);
  assert.equal(s.run, 'bash scripts/playwright-browsers.sh', 'it runs the shared install script');
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'playwright-browsers.sh'), 'utf8');
  assert.match(sh, /for try in 1 2/, 'a miss tries twice');
  assert.match(sh, /timeout "\$TRY_SECONDS" npx playwright install/, 'each try has its own time limit');
  assert.match(sh, /pkill -x apt-get/, 'a try cut off has its apt-get ended');
  assert.match(sh, /apt-mirrors\.txt/, 'the second try uses another mirror');
  assert.match(sh, /TRY_SECONDS:-240/, 'a try gets 4 minutes');
});

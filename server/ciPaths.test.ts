import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globRegex, noPrCi, workflowTrigger } from '../machine/ciPaths.ts';

/**
 * w5017 (machine/ciPaths.ts): ff-pr merges a PR with no workflow run only when every workflow's pull_request path
 * filter, read at the base, leaves out every changed file. The fixtures are ffu's ci.yml trigger as it stood on
 * 2026-11-21 and the shapes that must keep the gate shut.
 */

const FFU_CI = `name: ci
on:
  # A change only to docs/ runs nothing (w2895, ffu #297).
  pull_request:
    paths-ignore: ['docs/**']
  push:
    branches: [main]
    tags: ['v*']
    paths-ignore: ['docs/**']
  workflow_dispatch:
    inputs:
      inject_float:
        type: boolean
jobs:
  test:
    runs-on: [self-hosted, ffu-linux]
`;
const DISPATCH_ONLY = 'on:\n  workflow_dispatch:\n    inputs:\n      count: {type: string, default: "50"}\njobs: {}\n';
const SCHEDULED = "on:\n  schedule:\n    - cron: '17 10 * * *'\n  workflow_dispatch:\njobs: {}\n";
const PUSH_PATHS = 'on:\n  push:\n    branches: [main]\n    paths: [crates/ffu-sim/**]\njobs: {}\n';
const NO_FILTER = 'on:\n  pull_request:\n  push:\n    branches: [main]\njobs: {}\n';
const PR_WITH_BRANCHES = "on:\n  pull_request:\n    branches: [main]\n    paths-ignore: ['docs/**']\njobs: {}\n";
const one = (yaml: string) => (n: string) => (n === 'ci.yml' ? yaml : undefined);
const ffu = (n: string) => ({ 'ci.yml': FFU_CI, 'fuzz.yml': SCHEDULED, 'repeat.yml': DISPATCH_ONLY, 'world.yml': PUSH_PATHS })[n];
const FFU_NAMES = ['ci.yml', 'fuzz.yml', 'repeat.yml', 'world.yml'];

test('ffu: a docs-only PR skips CI; a docs-and-code PR does not', () => {
  const docs = noPrCi(FFU_NAMES, ffu, ['docs/PLAN.md', 'docs/w/notes.md']);
  assert.equal(docs.skips, true, docs.why);
  assert.match(docs.why, /every changed file \(2\) is filtered out: ci\.yml pull_request paths-ignore \[docs\/\*\*\]/);
  const mixed = noPrCi(FFU_NAMES, ffu, ['docs/PLAN.md', 'crates/ffu-sim/src/lib.rs']);
  assert.equal(mixed.skips, false);
  assert.match(mixed.why, /ci\.yml runs: crates\/ffu-sim\/src\/lib\.rs is outside pull_request paths-ignore/);
  // A rename out of docs/ lists both paths (ff-pr reads previous_filename too), so it runs.
  assert.equal(noPrCi(FFU_NAMES, ffu, ['src/a.md', 'docs/a.md']).skips, false);
  // A file named like the folder, or under a nested docs/, is not under docs/**.
  assert.equal(noPrCi(FFU_NAMES, ffu, ['docs']).skips, false);
  assert.equal(noPrCi(FFU_NAMES, ffu, ['crates/x/docs/a.md']).skips, false);
});

test('the gate stays shut: no filter, a branches filter, an unreadable or missing workflow, no or too many files', () => {
  assert.match(noPrCi(['ci.yml'], one(NO_FILTER), ['docs/a.md']).why, /runs: pull_request has no path filter/);
  assert.match(noPrCi(['ci.yml'], one('on: [push, pull_request]\n'), ['docs/a.md']).why, /runs: on: \[push, pull_request\] has no path filter/);
  assert.match(noPrCi(['ci.yml'], one('on:\n  - pull_request\n'), ['docs/a.md']).why, /runs/);
  assert.match(noPrCi(['ci.yml'], one(PR_WITH_BRANCHES), ['docs/a.md']).why, /pull_request has branches \(not read here\)/);
  assert.match(noPrCi(['ci.yml', 'x.yml'], ffu, ['docs/a.md']).why, /x\.yml could not be read/);
  assert.match(noPrCi([], ffu, ['docs/a.md']).why, /no workflows/);
  assert.match(noPrCi(['repeat.yml'], ffu, ['docs/a.md']).why, /no workflow has a pull_request trigger with a path filter/);
  assert.match(noPrCi(FFU_NAMES, ffu, []).why, /no changed files/);
  assert.match(noPrCi(FFU_NAMES, ffu, Array.from({ length: 301 }, (_, i) => `docs/${i}.md`)).why, /301 changed files/);
  assert.match(noPrCi(['ci.yml'], one('jobs: {}\n'), ['docs/a.md']).why, /no on: found/);
  assert.match(noPrCi(['ci.yml'], one("on:\n  pull_request:\n    paths-ignore: ['docs/**', '!docs/golden/**']\n"), ['docs/a.md']).why, /pattern not read here/);
  assert.match(noPrCi(['ci.yml'], one("on:\n  pull_request_target:\n    paths-ignore:\n    - 'docs/**'\n"), ['docs/a.md']).why, /runs/);
});

test('block lists, paths (positive) and pull_request_target are read', () => {
  const block = "on:\n  pull_request:\n    paths-ignore:\n      - 'docs/**'   # prose\n      - \"**/*.md\"\n";
  assert.equal(workflowTrigger(block, ['README.md', 'docs/x.txt', 'a/b/c.md']).kind, 'skips');
  assert.equal(workflowTrigger(block, ['README.md', 'src/main.rs']).kind, 'runs');
  const paths = 'on:\n  pull_request_target:\n    paths: [crates/**, Cargo.toml]\n';
  assert.equal(workflowTrigger(paths, ['docs/a.md']).kind, 'skips');
  assert.equal(workflowTrigger(paths, ['docs/a.md', 'Cargo.toml']).kind, 'runs');
  assert.equal(workflowTrigger(PUSH_PATHS, ['crates/ffu-sim/a.rs']).kind, 'none');
});

test('globRegex follows GitHub filter patterns: * stops at /, ** crosses it, **/ may match nothing', () => {
  assert.ok(globRegex('docs/**')!.test('docs/a/b.md'));
  assert.ok(!globRegex('docs/*')!.test('docs/a/b.md'));
  assert.ok(globRegex('**/*.md')!.test('README.md'));
  assert.ok(globRegex('*.m?')!.test('x.md'));
  assert.ok(!globRegex('a.b')!.test('axb'));
  for (const p of ['!docs/**', 'docs/[ab]', 'docs/+', '{a,b}', '']) assert.equal(globRegex(p), undefined, p);
});

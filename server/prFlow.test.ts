import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atlasWarning, ciVerdict, ghAuthProblem, ghAvailableFields, installPrShim, parseArgs, prMain, type PrDeps, type Ran } from '../machine/prFlow.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpFont } from './tmpFontFixture.ts';

/**
 * ff-pr (w1478, machine/prFlow.ts): a worker's push, PR, landed check (w907) and merge on green, one command each. The
 * fake runner answers git and gh by the first words of the command; every case checks what was run and what it said.
 */

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const pr = (o: Partial<{ headRefOid: string; mergeable: string; state: string }> = {}) =>
  JSON.stringify({ number: 7, url: 'https://github.com/Final-Factory/ff-factory/pull/7', headRefOid: SHA, mergeable: 'MERGEABLE', state: 'OPEN', baseRefName: 'main', ...o });

function fake(answers: Record<string, Ran | Ran[]>): PrDeps & { ran: string[]; said: string } {
  const ran: string[] = [];
  const d = {
    ran,
    said: '',
    run: (cmd: string, args: string[]): Ran => {
      const line = [cmd, ...args].join(' ');
      ran.push(line);
      const key = Object.keys(answers)
        .filter((k) => line.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const a = key === undefined ? undefined : answers[key];
      if (Array.isArray(a)) return a.length > 1 ? a.shift()! : a[0];
      return a ?? { code: 0, out: '', err: '' };
    },
    write: (s: string) => void (d.said += s),
    sleep: () => {},
  };
  return d;
}
const ok = (out = ''): Ran => ({ code: 0, out, err: '' });
const fail = (err: string): Ran => ({ code: 1, out: '', err });
const base = { 'git branch --show-current': ok('w1478-x\n'), 'git rev-parse HEAD': ok(`${SHA}\n`), 'git merge': ok('Already up to date.\n') };

test('ciVerdict: the newest run of each workflow counts, so a rerun that went green clears an old red', () => {
  assert.equal(ciVerdict([]).state, 'none');
  assert.deepEqual(
    ciVerdict([
      { databaseId: 1, workflowName: 'ci', status: 'completed', conclusion: 'failure' },
      { databaseId: 2, workflowName: 'ci', status: 'completed', conclusion: 'success' },
      { databaseId: 3, workflowName: 'windows', status: 'completed', conclusion: 'skipped' },
    ]),
    { state: 'green', red: [], pending: [] },
  );
  const v = ciVerdict([
    { databaseId: 4, workflowName: 'ci', status: 'in_progress' },
    { databaseId: 5, workflowName: 'windows', status: 'completed', conclusion: 'failure' },
  ]);
  assert.equal(v.state, 'red');
  assert.deepEqual(v.pending, ['ci']);
  assert.deepEqual(v.red, ['windows (failure, run 5)']);
  assert.equal(ciVerdict([{ databaseId: 6, workflowName: 'ci', status: 'queued' }]).state, 'pending');
});

test('parseArgs: commands, options and the pairs that go together', () => {
  assert.deepEqual(parseArgs(['push', '--base', 'master']), { cmd: 'push', o: { draft: false, mergeBase: true, base: 'master' } });
  assert.equal(parseArgs(['push', '--title', 'x']), '--title and --body-file go together');
  assert.equal(parseArgs(['push', '--base']), '--base needs a value');
  // w5166: the PR number as the ci-release skill writes it, bare or with --pr, in either order
  const pr4198 = { cmd: 'merge', o: { draft: false, mergeBase: true, pr: '4198' } };
  assert.deepEqual(parseArgs(['merge', '4198']), pr4198);
  assert.deepEqual(parseArgs(['merge', '--pr', '4198']), pr4198);
  assert.deepEqual(parseArgs(['merge', '4198', '--pr', '4198']), pr4198);
  assert.deepEqual(parseArgs(['merge', '--pr', '4198', '4198']), pr4198);
  assert.deepEqual(parseArgs(['status', '4198']), { cmd: 'status', o: { draft: false, mergeBase: true, pr: '4198' } });
  assert.match(String(parseArgs(['merge', '4198', '--pr', '4199'])), /name different pull requests/);
  assert.match(String(parseArgs(['merge', '--pr', '4199', '4198'])), /name different pull requests/);
  assert.match(String(parseArgs(['merge', '4198', '4199'])), /name different pull requests/);
  assert.equal(parseArgs(['push', '4198']), 'unknown option 4198');
  assert.equal(parseArgs(['land']), 'unknown command land');
  assert.equal(prMain([], fake({})), 2);
});

test('push: merges the base, pushes, finds the open PR at HEAD and prints the blocked_on to wait with', () => {
  const d = fake({ ...base, 'gh pr view': ok(pr()) });
  assert.equal(prMain(['push'], d), 0);
  assert.ok(d.ran.includes('git fetch -q origin main'), d.ran.join('\n'));
  assert.ok(d.ran.includes('git merge --no-edit origin/main'));
  assert.ok(d.ran.includes('git push -u origin HEAD:refs/heads/w1478-x'));
  assert.match(d.said, /next: mcp__machine__blocked_on with head "a{40}" and prs \["ci:Final-Factory\/ff-factory#7"\]/);
});

test('push: refuses master, main and develop, which the shell guard cannot see it push to', () => {
  for (const b of ['master', 'main', 'develop']) {
    const d = fake({ ...base, 'git branch --show-current': ok(`${b}\n`), 'gh pr view': ok(pr()) });
    assert.equal(prMain(['push'], d), 1);
    assert.ok(!d.ran.some((l) => l.startsWith('git push')), b);
    assert.match(d.said, /takes changes only through a pull request/);
  }
});

test('push: a merge conflict stops before the push and names the files', () => {
  const d = fake({ ...base, 'gh pr view': ok(pr()), 'git merge': fail('CONFLICT (content)'), 'git diff --name-only': ok('server/a.ts\n') });
  assert.equal(prMain(['push'], d), 1);
  assert.ok(!d.ran.some((l) => l.startsWith('git push')));
  assert.match(d.said, /conflicts in:\nserver\/a\.ts/);
});

test('push: no PR and no title asks for one; with a title it opens it on the base and checks it landed', () => {
  const none = fake({ ...base, 'gh pr view': fail('no pull requests found') });
  assert.equal(prMain(['push', '--base', 'master'], none), 1);
  assert.match(none.said, /has no open PR/);
  const body = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ffpr-')), 'body.md');
  fs.writeFileSync(body, 'Request: w1478\n');
  const d = fake({ ...base, 'gh pr view': [fail('no pull requests found'), ok(pr())], 'gh pr create': ok('https://github.com/Final-Factory/ff-factory/pull/7\n') });
  assert.equal(prMain(['push', '--base', 'master', '--title', 'w1478: x', '--body-file', body], d), 0);
  assert.ok(d.ran.some((l) => l.startsWith('gh pr create --base master --head w1478-x --title w1478: x --body-file')), d.ran.join('\n'));
});

test('push: a PR left on an older head, or CONFLICTING, is a push that did not land (w907)', () => {
  const stale = fake({ ...base, 'gh pr view': ok(pr({ headRefOid: OLD })) });
  assert.equal(prMain(['push'], stale), 1);
  assert.match(stale.said, /the push did not land/);
  const conflicting = fake({ ...base, 'gh pr view': ok(pr({ mergeable: 'CONFLICTING' })) });
  assert.equal(prMain(['push'], conflicting), 1);
  assert.match(conflicting.said, /conflicts with main/);
});

test('merge: merges on green with --match-head-commit; running waits (exit 3); red names the run (exit 1)', () => {
  const runs = (r: object[]) => ok(JSON.stringify(r));
  const green = fake({ 'gh pr view': [ok(pr()), ok(pr({ state: 'MERGED' }))], 'gh run list': runs([{ databaseId: 9, workflowName: 'ci', status: 'completed', conclusion: 'success' }]) });
  assert.equal(prMain(['merge'], green), 0);
  assert.ok(green.ran.includes(`gh pr merge 7 --merge --match-head-commit ${SHA}`));
  assert.match(green.said, /merged at head/);
  // w5166: both written forms merge through the same gate
  for (const argv of [['merge', '7'], ['merge', '--pr', '7']]) {
    const g = fake({ 'gh pr view': [ok(pr()), ok(pr({ state: 'MERGED' }))], 'gh run list': runs([{ databaseId: 9, workflowName: 'ci', status: 'completed', conclusion: 'success' }]) });
    assert.equal(prMain(argv, g), 0, argv.join(' '));
    assert.ok(g.ran.includes(`gh pr merge 7 --merge --match-head-commit ${SHA}`));
  }
  const clash = fake({ 'gh pr view': ok(pr()) });
  assert.equal(prMain(['merge', '7', '--pr', '8'], clash), 2);
  assert.ok(!clash.ran.some((l) => l.startsWith('gh pr merge')));
  const running = fake({ 'gh pr view': ok(pr()), 'gh run list': runs([{ databaseId: 9, workflowName: 'ci', status: 'in_progress' }]) });
  assert.equal(prMain(['merge'], running), 3);
  assert.ok(!running.ran.some((l) => l.startsWith('gh pr merge')));
  const red = fake({ 'gh pr view': ok(pr()), 'gh run list': runs([{ databaseId: 9, workflowName: 'ci', status: 'completed', conclusion: 'failure' }]) });
  assert.equal(prMain(['merge'], red), 1);
  assert.match(red.said, /red: ci \(failure, run 9\)/);
  const none = fake({ 'gh pr view': ok(pr()), 'gh run list': runs([]) });
  assert.equal(prMain(['merge'], none), 3);
});

test("w5549: ff-pr merge merges only this checkout's own pull request: a --pr whose head is another branch, or any fork head, is refused", () => {
  const green = () => ok(JSON.stringify([{ databaseId: 9, workflowName: 'ci', status: 'completed', conclusion: 'success' }]));
  const own = JSON.stringify({ ...JSON.parse(pr()), headRefName: 'w1478-x', isCrossRepository: false });
  const mine = fake({ ...base, 'gh pr view': [ok(own), ok(pr({ state: 'MERGED' }))], 'gh run list': green() });
  assert.equal(prMain(['merge', '--pr', '7'], mine), 0, mine.said);
  assert.ok(mine.ran.includes(`gh pr merge 7 --merge --match-head-commit ${SHA}`));
  const other = fake({ ...base, 'gh pr view': ok(JSON.stringify({ ...JSON.parse(pr()), headRefName: 'w5480-other', isCrossRepository: false })), 'gh run list': green() });
  assert.equal(prMain(['merge', '--pr', '7'], other), 1);
  assert.ok(!other.ran.some((l) => l.startsWith('gh pr merge')));
  assert.match(other.said, /not merged: .*pull\/7 is not this branch's pull request: its head branch is w5480-other, and this checkout is on w1478-x\. ff-pr merge merges only your own \(w5549\)/);
  const fork = fake({ ...base, 'gh pr view': ok(JSON.stringify({ ...JSON.parse(pr()), headRefName: 'w1478-x', isCrossRepository: true })), 'gh run list': green() });
  assert.equal(prMain(['merge'], fork), 1);
  assert.ok(!fork.ran.some((l) => l.startsWith('gh pr merge')));
  assert.match(fork.said, /its head w1478-x is a branch of another repository \(a fork\)/);
});

test('merge: an error from gh pr merge on a merge GitHub made anyway (a 502, w1867) is a merge when the base holds the head; else refused', () => {
  const green = { 'gh pr view': ok(pr()), 'gh run list': ok(JSON.stringify([{ databaseId: 9, workflowName: 'ci', status: 'completed', conclusion: 'success' }])), 'gh pr merge': fail('non-200 OK status code: 502 Bad Gateway') };
  const landed = fake({ ...green, 'git merge-base --is-ancestor': ok() });
  assert.equal(prMain(['merge'], landed), 0);
  assert.ok(landed.ran.includes('git fetch -q origin main'));
  assert.ok(landed.ran.includes(`git merge-base --is-ancestor ${SHA} origin/main`));
  assert.match(landed.said, /merged at head a{10}: origin\/main holds it, though gh pr merge answered:\nnon-200 OK status code: 502/);
  const refused = fake({ ...green, 'git merge-base --is-ancestor': fail('') });
  assert.equal(prMain(['merge'], refused), 1);
  assert.match(refused.said, /^ff-pr: gh pr merge refused:\nnon-200 OK status code: 502/);
});

test('merge: a PR with no run whose files are all under the base workflows\' paths-ignore merges on the head check (w5017); a mixed one, a red one, a repo with no filter do not', () => {
  const FFU = 'repos/Final-Factory/ffu';
  const ffuPr = (o: object = {}) => JSON.stringify({ number: 938, url: 'https://github.com/Final-Factory/ffu/pull/938', headRefOid: SHA, mergeable: 'MERGEABLE', state: 'OPEN', baseRefName: 'main', baseRefOid: OLD, ...o });
  const ci = "name: ci\non:\n  pull_request:\n    paths-ignore: ['docs/**']\n  push:\n    branches: [main]\njobs: {}\n";
  const world = 'on:\n  push:\n    paths: [crates/ffu-sim/**]\n';
  const repo = (files: string[], ciYaml = ci) => ({
    [`gh api ${FFU}/pulls/938/files`]: ok(files.join('\n') + '\n'),
    [`gh api ${FFU}/contents/.github/workflows?ref=${OLD}`]: ok('ci.yml\nworld.yml\n'),
    [`gh api -H Accept: application/vnd.github.raw ${FFU}/contents/.github/workflows/ci.yml?ref=${OLD}`]: ok(ciYaml),
    [`gh api -H Accept: application/vnd.github.raw ${FFU}/contents/.github/workflows/world.yml?ref=${OLD}`]: ok(world),
  });
  const noRuns = { 'gh run list': ok('[]') };

  // ffu is Evidence-gated (machine/evidenceGate.ts): a script that passes, as pr_evidence.py does a docs-only PR.
  const gated = <T extends PrDeps>(d: T): T => Object.assign(d, { evidenceScript: () => 'pr_evidence.py', python: 'py' });
  const docs = gated(fake({ 'gh pr view': [ok(ffuPr()), ok(ffuPr({ state: 'MERGED' }))], ...noRuns, ...repo(['docs/PLAN.md']) }));
  assert.equal(prMain(['merge'], docs), 0, docs.said);
  assert.ok(docs.ran.includes(`gh pr merge 938 --merge --match-head-commit ${SHA}`), docs.ran.join('\n'));
  assert.match(docs.said, /CI: none will run: every changed file \(1\) is filtered out: ci\.yml pull_request paths-ignore \[docs\/\*\*\] \(workflows at main b{10}\); merging on the head check/);

  const status = fake({ 'gh pr view': ok(ffuPr()), ...noRuns, ...repo(['docs/PLAN.md']) });
  assert.equal(prMain(['status'], status), 0);

  const mixed = fake({ 'gh pr view': ok(ffuPr()), ...noRuns, ...repo(['docs/PLAN.md', 'crates/ffu-sim/src/lib.rs']) });
  assert.equal(prMain(['merge'], mixed), 3);
  assert.ok(!mixed.ran.some((l) => l.startsWith('gh pr merge')));
  assert.match(mixed.said, /CI is expected: ci\.yml runs: crates\/ffu-sim\/src\/lib\.rs is outside pull_request paths-ignore/);

  const unfiltered = fake({ 'gh pr view': ok(ffuPr()), ...noRuns, ...repo(['docs/PLAN.md'], 'on:\n  pull_request:\njobs: {}\n') });
  assert.equal(prMain(['merge'], unfiltered), 3);
  assert.ok(!unfiltered.ran.some((l) => l.startsWith('gh pr merge')));

  // Checks that ran and failed are red, whatever the files: the filter is never read.
  const red = fake({ 'gh pr view': ok(ffuPr()), 'gh run list': ok(JSON.stringify([{ databaseId: 9, workflowName: 'ci', status: 'completed', conclusion: 'failure' }])), ...repo(['docs/PLAN.md']) });
  assert.equal(prMain(['merge'], red), 1);
  assert.ok(!red.ran.some((l) => l.startsWith('gh pr merge') || l.includes('/files')));

  // ff-pr push says there is nothing to wait for, instead of the blocked_on line.
  const pushed = gated(fake({ ...base, 'gh pr view': ok(ffuPr()), ...repo(['docs/PLAN.md']) }));
  assert.equal(prMain(['push'], pushed), 0);
  assert.match(pushed.said, /CI: none will run: .*\nnext: ff-pr merge \(no CI to wait for\)/);
  assert.doesNotMatch(pushed.said, /blocked_on/);
});

test('installPrShim writes ff-pr for sh and cmd, pointing at the script', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ffpr-bin-'));
  installPrShim(bin, '/usr/bin/node', ['--experimental-strip-types'], '/app/machine/prFlow.ts');
  assert.match(fs.readFileSync(path.join(bin, 'ff-pr'), 'utf8'), /exec "\/usr\/bin\/node" "--experimental-strip-types" "\/app\/machine\/prFlow\.ts" "\$@"/);
  assert.match(fs.readFileSync(path.join(bin, 'ff-pr.cmd'), 'utf8'), /"\/app\/machine\/prFlow\.ts" %\*/);
});

test('w5069 push: warns, never refuses, for a dynamic TMP font atlas the editor only grew, and names the command that drops it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffpr-atlas-'));
  try {
    const g = (...a: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' }).toString();
    const put = (f: string, s: string) => (fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), s));
    const FONT = 'Assets/TextMesh Pro/Resources/Fonts & Materials/LiberationSans SDF - Fallback.asset';
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    put(FONT, tmpFont({ pairs: 2 }));
    put('Assets/Fonts/Real SDF.asset', tmpFont());
    put('a.cs', 'a');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    g('switch', '-q', '-c', 'w1-x');
    // As 6d6488f046: only kerning records added to the Fallback atlas; a face change to another font is a person's edit.
    put(FONT, tmpFont({ pairs: 60 }));
    put('Assets/Fonts/Real SDF.asset', tmpFont({ face: 72, glyphs: 3 }));
    put('a.cs', 'changed');
    g('commit', '-q', '-am', 'work');
    const said: string[] = [];
    const d = {
      run: (cmd: string, args: string[]): Ran => {
        const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
        return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
      },
      write: (s: string) => void said.push(s),
      sleep: () => {},
    };
    assert.deepEqual(atlasWarning(d, 'main'), [FONT]);
    assert.match(said.join(''), /warning: 1 dynamic TMP font atlas\(es\) changed only by the Unity editor/);
    assert.ok(said.join('').includes(`git checkout origin/main -- "${FONT}"`), said.join(''));
    // The command it names drops it.
    g('checkout', 'origin/main', '--', FONT);
    g('commit', '-q', '-m', 'drop');
    said.length = 0;
    assert.deepEqual(atlasWarning(d, 'main'), []);
    assert.equal(said.join(''), '', 'nothing to warn of');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('w5069 push: the atlas warning does not stop the push', () => {
  const d = fake({ ...base, 'gh pr view': ok(pr()), 'git merge-base': ok('c'.repeat(40) + '\n'), 'git diff --name-only -z': ok('F SDF.asset\0'), 'git show HEAD:': ok(tmpFont({ pairs: 9 })), 'git show c': ok(tmpFont({ pairs: 1 })) });
  assert.equal(prMain(['push'], d), 0);
  assert.match(d.said, /warning: 1 dynamic TMP font atlas/);
  assert.ok(d.ran.includes('git push -u origin HEAD:refs/heads/w1478-x'));
});

test('w5430: ff-pr refuses loudly before any push when gh cannot authenticate, and names where gh looked', () => {
  const d = fake({ 'gh auth status': { code: 1, out: '', err: 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n  - Token: gho_************' } });
  d.env = { APPDATA: 'F:\\ffw\\home\\AppData\\Roaming' };
  for (const cmd of [['push'], ['push', '--base', 'main'], ['status'], ['merge']]) {
    d.said = '';
    d.ran.length = 0;
    assert.equal(prMain(cmd, d), 1, cmd[0]);
    assert.deepEqual(d.ran, ['gh auth status --hostname github.com'], `${cmd[0]}: nothing past the check runs`);
    assert.match(d.said, /gh cannot authenticate to github\.com.*not logged into any GitHub hosts/);
    assert.match(d.said, /GH_CONFIG_DIR \(unset\).*APPDATA F:\\ffw/);
    assert.doesNotMatch(d.said, /gho_/, "gh's token lines are never repeated");
  }
  assert.equal(ghAuthProblem(fake({}), {}), undefined, 'logged in: no refusal');
  const app = fake({ 'gh auth status': { code: 1, out: '', err: 'x' } });
  assert.equal(ghAuthProblem(app, { FF_GH_APP_NAMES: 'a' }), undefined, 'a GitHub App run is left out');
  assert.deepEqual(app.ran, []);
});

test('w5836: a gh without baseRefOid (2.46.0 on biscuit) still finds the PR; any other gh failure is said in gh\'s words', () => {
  // gh 2.46.0's own answer to a field it lacks (w5140 saw it on biscuit), which ff-pr used to hide as "no PR".
  const old = fail('Unknown JSON field: "baseRefOid"\nAvailable fields:\n  additions\n  baseRefName\n  headRefName\n  headRefOid\n  isCrossRepository\n  mergeable\n  number\n  state\n  statusCheckRollup\n  url\n');
  const green = ok(JSON.stringify([{ databaseId: 1, workflowName: 'ci', status: 'completed', conclusion: 'success' }]));
  const d = fake({ 'gh pr view 7 --json number,url,headRefOid,mergeable,state,baseRefName,baseRefOid,': old, 'gh pr view 7 --json': ok(pr()), 'gh api repos/Final-Factory/ff-factory/pulls/7 --jq .base.sha': ok(`${OLD}\n`), 'gh run list': green });
  assert.equal(prMain(['status', '7'], d), 0, d.said);
  assert.ok(d.ran.includes('gh pr view 7 --json number,url,headRefOid,mergeable,state,baseRefName,headRefName,isCrossRepository'), d.ran.join('\n'));
  assert.ok(!d.said.includes('no PR'), d.said);
  // Never the checks rollup, which a fine-grained token is refused (w2015).
  assert.ok(!d.ran.some((l) => l.includes('statusCheckRollup')), d.ran.join('\n'));

  const auth = fake({ 'gh pr view': fail('HTTP 401: Requires authentication (https://api.github.com/graphql)\nTry authenticating with:  gh auth login') });
  assert.equal(prMain(['status', '7'], auth), 1);
  assert.match(auth.said, /^ff-pr: no PR 7: gh pr view failed: HTTP 401: Requires authentication/);
  assert.equal(auth.ran.filter((l) => l.startsWith('gh pr view')).length, 1);

  // push: a gh failure is not "no PR", so nothing is pushed and gh's words are shown.
  const push = fake({ ...base, 'gh pr view': fail('HTTP 401: Requires authentication') });
  assert.equal(prMain(['push', '--title', 't', '--body-file', 'b.md'], push), 1);
  assert.match(push.said, /gh pr view failed, so nothing is pushed: HTTP 401/);
  assert.ok(!push.ran.some((l) => l.startsWith('git push') || l.startsWith('gh pr create')), push.ran.join('\n'));
});

test('w5836: ghAvailableFields reads gh\'s field list only from an Unknown JSON field answer', () => {
  assert.deepEqual([...(ghAvailableFields('Unknown JSON field: "x"\nAvailable fields:\n  number\n  url\n') ?? [])], ['number', 'url']);
  assert.equal(ghAvailableFields('no pull requests found for branch "w1"'), undefined);
});

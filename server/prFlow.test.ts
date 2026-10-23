import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ciVerdict, installPrShim, parseArgs, prMain, type PrDeps, type Ran } from '../machine/prFlow.ts';

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
  const running = fake({ 'gh pr view': ok(pr()), 'gh run list': runs([{ databaseId: 9, workflowName: 'ci', status: 'in_progress' }]) });
  assert.equal(prMain(['merge'], running), 3);
  assert.ok(!running.ran.some((l) => l.startsWith('gh pr merge')));
  const red = fake({ 'gh pr view': ok(pr()), 'gh run list': runs([{ databaseId: 9, workflowName: 'ci', status: 'completed', conclusion: 'failure' }]) });
  assert.equal(prMain(['merge'], red), 1);
  assert.match(red.said, /red: ci \(failure, run 9\)/);
  const none = fake({ 'gh pr view': ok(pr()), 'gh run list': runs([]) });
  assert.equal(prMain(['merge'], none), 3);
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

test('installPrShim writes ff-pr for sh and cmd, pointing at the script', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ffpr-bin-'));
  installPrShim(bin, '/usr/bin/node', ['--experimental-strip-types'], '/app/machine/prFlow.ts');
  assert.match(fs.readFileSync(path.join(bin, 'ff-pr'), 'utf8'), /exec "\/usr\/bin\/node" "--experimental-strip-types" "\/app\/machine\/prFlow\.ts" "\$@"/);
  assert.match(fs.readFileSync(path.join(bin, 'ff-pr.cmd'), 'utf8'), /"\/app\/machine\/prFlow\.ts" %\*/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStandingShell, scanShell, standingGuard } from './standingGuard.ts';
import type { StandingToolGroup } from '../shared/types.ts';

const ctx = (groups: StandingToolGroup[]) => ({ groups, folder: 'F:/ffsb/_agents/reviewer', offLimits: ['F:/ffsb', 'F:/ffsb/_base'] });
const read = ctx(['shell_read']);
const comment = ctx(['shell_read', 'github_comment']);

test('shell scan: quotes keep operators and prose inside one word', () => {
  const s = scanShell(`gh pr comment 12 --body "LGTM; but | check && this" && git log -1`);
  assert.deepEqual(s.commands, [['gh', 'pr', 'comment', '12', '--body', 'LGTM; but | check && this'], ['git', 'log', '-1']]);
  assert.deepEqual(s.problems, []);
  assert.deepEqual(scanShell(`echo 'a $(b) \`c\`'`).problems, [], 'single quotes are literal');
  assert.ok(scanShell('echo "$(whoami)"').problems.length, 'double quotes still substitute');
  assert.ok(scanShell('cat x > out.txt').problems.length);
  assert.ok(scanShell('gh pr comment 1 --body-file - <<EOF').problems.length, 'heredoc');
  assert.deepEqual(scanShell('git fetch origin 2>&1 | tail -5').problems, []);
  assert.deepEqual(scanShell('ls missing 2>/dev/null').problems, []);
});

test('no shell group: no shell at all', () => {
  assert.ok(checkStandingShell('ls', ctx([])));
  assert.ok(checkStandingShell('ls', ctx(['delegate'])));
});

test('shell_read: read-only git, gh and utilities pass', () => {
  for (const cmd of [
    'gh pr list -R example-org/example-game --state open --json number,headRefOid,isDraft',
    'gh pr diff 42 -R example-org/example-game | head -200',
    'gh pr view 42 --json body,files --jq .files[].path',
    'gh api repos/example-org/example-game/pulls/42/comments',
    'gh api -X GET repos/o/r/issues -f state=open',
    'git -C F:/ffsb/_agents/reviewer/repo fetch origin pull/42/head',
    'cd F:/ffsb/_agents/reviewer/repo && git log --oneline -5 && git show FETCH_HEAD:README.md',
    'git branch -a',
    'git remote -v',
    'cat NOTES.md | grep -n sha',
    'ls -la && wc -l NOTES.md',
    'GH_PAGER= gh issue list --limit 5',
  ]) {
    assert.equal(checkStandingShell(cmd, read), undefined, cmd);
  }
});

test('shell_read: anything that writes or runs arbitrary code is refused', () => {
  for (const cmd of [
    'git push origin HEAD:develop',
    'git commit -am x',
    'git checkout -b x',
    'git reset --hard',
    'git branch -D old',
    'git branch newbranch',
    'git config user.name x',
    'git stash',
    'gh pr comment 1 --body hi',
    'gh pr merge 1',
    'gh api -X POST repos/o/r/issues/1/comments -f body=hi',
    'gh api repos/o/r/issues/1/comments -f body=hi',
    'gh pr checkout 12',
    'rm -rf x',
    'node -e "1"',
    'python x.py',
    'powershell -c ls',
    'curl https://example.com',
    'sed -i s/a/b/ NOTES.md',
    'find . -delete',
    'find . -exec rm {} ;',
    'echo $(rm -rf /)',
    'cat x > y',
    'xargs rm',
    'bash -c ls',
  ]) {
    assert.ok(checkStandingShell(cmd, read), cmd);
  }
});

test('shell: other sandboxes and the base clone are off-limits, the own folder is not', () => {
  assert.ok(checkStandingShell('git -C F:/ffsb/sb1 fetch', read));
  assert.ok(checkStandingShell('cat F:\\ffsb\\_base\\README.md', read));
  assert.ok(checkStandingShell('ls /f/ffsb/sb2', read), 'Git Bash spelling');
  assert.equal(checkStandingShell('ls F:/ffsb/_agents/reviewer', read), undefined);
});

test('github_comment: comments and comment-only reviews, never approve/merge/close', () => {
  for (const cmd of [
    'gh pr comment 42 -R example-org/example-game --body-file review-42.md',
    'gh issue comment 7 --body "Thanks; looking."',
    'gh pr review 42 --comment --body-file r.md',
    'gh api -X POST repos/o/r/issues/42/comments -F body=@r.md',
    'gh api repos/o/r/pulls/42/reviews -f event=COMMENT -F body=@r.md',
  ]) {
    assert.equal(checkStandingShell(cmd, comment), undefined, cmd);
  }
  for (const cmd of [
    'gh pr review 42 --approve',
    'gh pr review 42 --comment --approve',
    'gh pr review 42 -r --body x',
    'gh pr review 42 --body x',
    'gh pr merge 42',
    'gh pr close 42',
    'gh pr edit 42 --base master',
    'gh issue close 7',
    'gh api repos/o/r/pulls/42/reviews -f event=APPROVE',
    'gh api -X PUT repos/o/r/pulls/42/merge',
    'gh api -X DELETE repos/o/r/issues/comments/9',
    'gh api -X PATCH repos/o/r/issues/42 -f state=closed',
  ]) {
    assert.ok(checkStandingShell(cmd, comment), cmd);
  }
});

test('writes only inside the own folder', async () => {
  const hook = standingGuard({ folder: 'F:/ffsb/_agents/reviewer', groups: [], offLimits: [] });
  const call = (tool_name: string, tool_input: unknown) =>
    hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's', transcript_path: '', cwd: 'F:/ffsb/_agents/reviewer', tool_use_id: 't' } as never, undefined, { signal: new AbortController().signal });
  const denied = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny';
  assert.ok(!denied(await call('Write', { file_path: 'F:\\ffsb\\_agents\\reviewer\\NOTES.md' })));
  assert.ok(!denied(await call('Edit', { file_path: 'NOTES.md' })), 'relative to the folder');
  assert.ok(denied(await call('Write', { file_path: 'F:/ffsb/sb1/Assets/x.cs' })));
  assert.ok(denied(await call('Write', { file_path: 'F:/ffsb/_agents/reviewer-evil/x' })), 'a sibling with the same prefix');
  assert.ok(denied(await call('Edit', { file_path: 'F:/ffsb/_agents/reviewer/../other/x' })));
  assert.ok(denied(await call('Bash', { command: 'ls' })), 'no shell group');
  assert.ok(!denied(await call('Read', { file_path: 'C:/anything' })), 'reading is not this hook\'s business');
});

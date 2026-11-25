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

// w5504 (the w5452 audit, finding 2): forms the guard once allowed that run a program, write a file or print a secret.
test('w5504: each audited bypass form and its variants is refused', () => {
  const forms: Record<string, string[]> = {
    'git -c core.pager': ['git -c core.pager=sh log', 'git -c core.pager="sh -c id" log', "git -c 'core.pager=touch x' log -1", 'git -c Core.Pager=sh log'],
    'git -c exec keys and --config-env': [
      'git -c core.fsmonitor=./x status',
      'git -c core.sshCommand=./x fetch origin',
      'git -c diff.external=./x diff',
      'git -c alias.log=!sh log',
      'git -c alias.x=!id x',
      'git -c credential.helper=!id fetch',
      'git -c diff.x.textconv=./x log -p',
      'git -c include.path=evil.cfg log',
      'git --config-env=core.pager=X log',
      'git --config-env core.pager=X log',
      'git --exec-path=./bin log',
      'git --git-dir=evil log',
      'git --work-tree=x status',
      'git --bare log',
    ],
    'git fetch --upload-pack': [
      'git fetch --upload-pack=./x origin',
      'git fetch --upload-pack ./x origin',
      'git fetch --upload-pa=./x origin',
      'git fetch --upl=./x origin',
      'git clone --upload-pack=./x https://example.com/r',
      'git clone -u ./x https://example.com/r',
      'git clone -qu./x https://example.com/r',
      'git clone -c core.fsmonitor=./x https://example.com/r',
      'git clone --config core.fsmonitor=./x https://example.com/r',
      'git clone --template=tpl https://example.com/r',
      'git ls-remote --upload-pack=./x origin',
      'git ls-remote --exec=./x origin',
      'git fetch --receive-pack=./x origin',
      "git clone 'ext::sh -c id' x",
      'git fetch fd::3 x',
    ],
    'git log --output': ['git log --output=x', 'git log --output x', 'git log --outp=x', 'git show --output=x HEAD', 'git diff --output=x', 'git log -p --ext-diff', 'git stash list --output=x'],
    'git grep and help that run a pager or browser': ['git grep -Ovi foo', 'git grep -O foo', 'git grep -nO foo', 'git grep --open-files-in-pager=vi foo', 'git help -w log', 'git help --web log'],
    'rg --pre': ['rg --pre ./x foo', 'rg --pre=./x foo', 'rg --pre=sh foo', 'rg --hostname-bin=./x foo'],
    'sed -Ei': ['sed -Ei s/a/b/ f', 'sed -i s/a/b/ f', 'sed -ni p f', 'sed -I s/a/b/ f', "sed -i'' s/a/b/ f", 'sed --in-place s/a/b/ f', 'sed --in-pl s/a/b/ f', 'sed --in s/a/b/ f', 'sed -f script.sed f', 'sed --file=script.sed f', 'sed -s -i s/a/b/ f'],
    "sed's e command": ['sed e f', "sed '1e id' f", "sed -n '$e id' f", "sed 's/.*/id/e' f", "sed 's/x/y/ge' f", "sed -e p -e 'e id' f", "sed -ne'e id' f", "sed --expression='1e id' f", "sed '/x/!e id' f", "sed '1{e id\n}' f"],
    "sed's w and W commands": ["sed 'w out' f", "sed -n 'W out' f", "sed 's/a/b/w out' f", "sed 's/a/b/gw out' f", "sed '1,5w out' f", "sed 's|a|b|w out' f", "sed 'r /etc/passwd' f", "sed 'R x' f", "sed 'L' f"],
    'sort --compress-program': ['sort --compress-program=./x f', 'sort --compress-program ./x f', 'sort --compress=./x f', 'sort --comp=./x f'],
    'sort -o': ['sort -o out f', 'sort -oout f', 'sort -ro out f', 'sort -nro out f', 'sort --output=out f', 'sort --output out f', 'sort --out=out f', 'sort f -o out'],
    'find writes and execs': [
      'find . -fprint0 out',
      'find . -fprint out',
      'find . -fprintf out %p',
      'find . -fls out',
      'find . -exec id ;',
      'find . -execdir id ;',
      'find . -ok id ;',
      'find . -okdir id ;',
      'find . -delete',
      "find . '-exec' id ';'",
      'find . -e\\xec id \;',
    ],
    'gh api -XDELETE and other writes': [
      'gh api -XDELETE repos/o/r/issues/comments/1',
      'gh api -X DELETE repos/o/r/issues/comments/1',
      'gh api -Xdelete repos/o/r/issues/comments/1',
      'gh api -X=DELETE repos/o/r/issues/comments/1',
      'gh api --method=DELETE repos/o/r/git/refs/heads/x',
      'gh api --method DELETE repos/o/r/git/refs/heads/x',
      'gh api -iXDELETE repos/o/r/issues/comments/1',
      'gh api -X GET -X DELETE repos/o/r/issues/comments/1',
      'gh api -X PUT repos/o/r/pulls/1/merge',
      'gh api -X PATCH repos/o/r/issues/1 -f state=closed',
      'gh api repos/o/r/issues -f title=x',
      'gh api repos/o/r/issues -Ftitle=x',
      'gh api repos/o/r/issues --raw-field=title=x',
      'gh api graphql -f query=mutation{x}',
      'gh api --input body.json repos/o/r/issues',
      'gh api -X GET --input body.json repos/o/r/issues',
      'gh api --input=body.json repos/o/r/issues',
    ],
    'gh auth status --show-token': ['gh auth status --show-token', 'gh auth status -t', 'gh auth status -at', 'gh auth status -h github.com -t'],
    'gh --web': ['gh pr view 1 --web', 'gh pr view 1 -w', 'gh run view 1 -w'],
    'environment that changes what runs': [
      'GIT_PAGER=sh git log',
      'PAGER=./x git log',
      'GH_PAGER=sh gh pr list',
      'GIT_EXTERNAL_DIFF=./x git diff',
      'GIT_SSH_COMMAND=./x git fetch',
      'GIT_CONFIG_PARAMETERS=x git log',
      'GIT_CONFIG_COUNT=1 git log',
      'PATH=. cat x',
      'PATH=/srv/fff/agents/x:/usr/bin; cat x',
      'LD_PRELOAD=./x.so cat x',
      'RIPGREP_CONFIG_PATH=rc rg foo',
      'BROWSER=./x gh pr view 1',
      'X=1; git log',
    ],
    'expansion and quoting tricks': [
      'X=--output=f; git log $X',
      'git log $X',
      'git log ${X}',
      'sort -n${IFS}-o${IFS}x f',
      "git log $'--output=x'",
      'sort {-o,out} f',
      'sort -n -{o,}out f',
      'git log * ',
      'sort *',
      'sed -n p -*',
      'git log "$X"',
    ],
    'programs run from a path': ['./repo/cat x', 'repo/bin/git log', 'C:/ffsb/_agents/reviewer/repo/git.exe log'],
    'utilities that write': ['tree -o out', 'tree -R', 'tree -ao out', 'uniq in out', 'uniq -c in out', 'file -C -m magic'],
  };
  for (const [form, cmds] of Object.entries(forms)) {
    for (const cmd of cmds) assert.ok(checkStandingShell(cmd, comment), `${form}: ${cmd}`);
  }
});

test('w5504: the read-only forms around the refused ones still pass', () => {
  for (const cmd of [
    'git -c color.ui=never log --oneline -5',
    'git --no-pager log -1',
    'git -C F:/ffsb/_agents/reviewer/repo log --format=%H -1',
    'git log --output-indicator-new=+ -p -1',
    'git log --no-ext-diff -p -1',
    'git log --stat --cc -1',
    'git diff --stat origin/master...HEAD',
    'git fetch --update-shallow origin',
    'git clone --depth 1 https://github.com/o/r',
    'git grep -n foo',
    'git config --get remote.origin.url',
    'rg -n --pretty foo',
    'rg --pcre2 foo',
    "sed -n '1,40p' NOTES.md",
    "sed -E 's/(a|b)+/x/g' NOTES.md",
    "sed -ne 's/x/y/p' NOTES.md",
    "sed -n '/start/,/end/{p}' NOTES.md",
    "sed '$!N;s/\\n/ /' NOTES.md",
    "sed 's|w|e|g' NOTES.md",
    "sed -n 's/we/ew/gp' NOTES.md",
    "sed '1i header' NOTES.md",
    "sed '/^#/d;s/a/b/2' NOTES.md",
    'sort -k2,2 -t, -u NOTES.md',
    'sort -rn NOTES.md',
    'sort --check NOTES.md',
    'find . -name "*.md" -type f -print',
    "find . -newer NOTES.md -ls",
    'gh api -X GET repos/o/r/issues -f state=open',
    'gh api repos/o/r/pulls/1 --jq .head.sha',
    'gh api -i repos/o/r',
    'gh auth status',
    'gh auth status -h github.com',
    'gh run list -w ci.yml -L 5',
    'gh pr view 42 --json body,files --jq .files[].path',
    'GH_REPO=o/r gh pr list',
    'LC_ALL=C sort NOTES.md',
    'GIT_PAGER=cat git log -1',
    'GH_PAGER= gh issue list --limit 5',
    'tree -L 2',
    'uniq -c NOTES.md',
    'grep -rn foo ./*',
    'ls *.md',
    'cat * | grep -c x',
    '[ -f NOTES.md ] && echo yes',
    '/usr/bin/git log -1',
    'echo "cost $"',
  ]) {
    assert.equal(checkStandingShell(cmd, comment), undefined, cmd);
  }
});

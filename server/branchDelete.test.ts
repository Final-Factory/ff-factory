import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShell, ghApiBranchDelete, sandboxGuard } from './guard.ts';
import { PROTECTED_BRANCHES, judgeBranchDelete, protectedBranch } from './protectedBranches.ts';

// w6815 (lothsahn: "It should block deleting master or a release branch, but not feature branches").

const decide = async (g: ReturnType<typeof sandboxGuard>, command: string, id = 'x') => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, session_id: 's', transcript_path: '', cwd: 'C:/ffsb/sb1' };
  const r = (await g(input as never, id, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return { decision: r.hookSpecificOutput?.permissionDecision ?? 'allow', reason: r.hookSpecificOutput?.permissionDecisionReason ?? '' };
};

const remotes = (dir: string) => (dir.replace(/\\/g, '/').toLowerCase() === 'c:/ffsb/sb1' ? new Map([['origin', 'https://github.com/Final-Factory/FinalFactory.git']]) : undefined);

// The remote's refs as git ls-remote shows them: every plain name is a branch, except these tags (the game repo's
// mode2-manual-* and ffu's play are real tags today), a name the remote lacks, an unreadable remote and a name that is
// also another ref.
const TAGS = ['mode2-manual-20260727T033612Z', 'play', 'latest'];
const refsOf = async (_url: string, refs: string[]) => {
  const name = refs[0].replace(/^refs\/heads\//, '');
  if (name === 'gone') return new Map<string, string>();
  if (name === 'unreadable') return undefined;
  if (name === 'notes-x') return new Map([['refs/notes-x', 'c'.repeat(40)], [refs[0], 'a'.repeat(40)]]);
  return new Map([[TAGS.includes(name) ? `refs/tags/${name}` : refs[0], 'a'.repeat(40)]]);
};

const make = (lines: string[] = [], shas: string[] = []) =>
  sandboxGuard({
    remoteRefs: refsOf,
    sandboxId: 'sb1',
    sandboxPath: 'C:/ffsb/sb1',
    protectedPaths: [],
    gameRepos: ['https://github.com/Final-Factory/FinalFactory.git'],
    remotes,
    prBase: () => undefined,
    evidence: () => undefined,
    session: 'sess-1',
    log: (l) => lines.push(l),
    branchSha: async (url, branch) => {
      shas.push(`${url} ${branch}`);
      return 'a'.repeat(40);
    },
    junctionRmWarn: false,
  });

// The route each name is deleted by: git push --delete, -d, the :<branch> refspec, and the GitHub API ref DELETE.
const routes = (b: string) => [
  `git push origin --delete ${b}`,
  `git push -d origin ${b}`,
  `git push origin :${b}`,
  `git push origin :refs/heads/${b}`,
  `gh api -X DELETE repos/Final-Factory/FinalFactory/git/refs/heads/${b}`,
  `gh api --method DELETE /repos/Final-Factory/ffu/git/refs/heads/${b}`,
  `gh api --method=DELETE repos/{owner}/{repo}/git/refs/heads/${b}`,
];

const FEATURE = ['ffbox-f/slot4-w6725-diag', 'w6815-throwaway', 'sandbox/sb1', 'feat/x', 'fix/y', 'ffbox/w6000-fix', 'regress/r1', 'w895-before-base', 'desync-hunt-2', 'perf-pass-d'];

const PROTECTED = [
  'master',
  'main',
  'MASTER',
  'develop',
  'pre-1.0',
  'release/0.50.0.102',
  'release/1.0.0.12',
  'release-0.50.0.42',
  'release-next',
  'urgent/1.0.0.12',
  'hotfix/w5020-pre10-dyson-star',
  'ffbox/release-0.50.0.70-regenerated',
  '0.15',
  '0.16.1',
  'v1.0.0',
  'development',
  'pre-release',
  'demo',
  'steamdeck-beta',
  'mp',
  'ci/mp-beta-lane',
  'ci/release-beside-tests',
  'gh-pages',
  'demoRelease/16',
  'backup/x',
  'ff-backup/x',
  'ff-saved/x',
  'rescue/x',
];

test('w6815: a feature branch delete passes on both routes, and is logged with who, repo, branch and sha', async () => {
  for (const b of FEATURE) {
    for (const command of routes(b)) {
      const lines: string[] = [];
      const r = await decide(make(lines), command);
      assert.equal(r.decision, 'allow', `${command}: ${r.reason}`);
      assert.equal(lines.length, 1, command);
      assert.match(lines[0], new RegExp(`^w6815 remote branch delete allowed: session=sess-1 sandbox=sb1 route=(git push|gh api) repo=github\\.com/final-factory/(finalfactory|ffu) branch=${b.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} sha=a{40}$`), command);
    }
  }
  // Several branches in one push, and a percent-encoded API name.
  const lines: string[] = [];
  assert.equal((await decide(make(lines), 'git push origin --delete w1-a w1-b')).decision, 'allow');
  assert.deepEqual(lines.map((l) => /branch=(\S+)/.exec(l)?.[1]), ['w1-a', 'w1-b']);
  const shas: string[] = [];
  assert.equal((await decide(make([], shas), 'gh api -X DELETE repos/Final-Factory/FinalFactory/git/refs/heads/ffbox-f%2Fslot4-w6725-diag')).decision, 'allow');
  assert.deepEqual(shas, ['https://github.com/Final-Factory/FinalFactory.git ffbox-f/slot4-w6725-diag']);
});

test('w6815: master, main and every release branch are refused on both routes, and nothing is logged', async () => {
  for (const b of PROTECTED) {
    for (const command of routes(b)) {
      const lines: string[] = [];
      const r = await decide(make(lines), command);
      assert.equal(r.decision, 'deny', command);
      assert.match(r.reason, /is refused/, command);
      assert.deepEqual(lines, [], command);
    }
  }
  // One protected name among feature names refuses the whole push.
  assert.equal((await decide(make(), 'git push origin --delete w1-a master')).decision, 'deny');
  assert.equal((await decide(make(), 'git push origin w1-a :pre-1.0')).decision, 'deny');
});

test('w6815: names that are not clearly a branch are refused', async () => {
  for (const b of ['$B', '"$BRANCH"', 'HEAD', '@', 'refs/tags/v1', 'refs/pull/12/head', 'feat*', 'a..b', 'x~1']) {
    assert.equal((await decide(make(), `git push origin --delete ${b}`)).decision, 'deny', b);
    assert.equal((await decide(make(), `git push origin :${b}`)).decision, 'deny', b);
  }
  assert.equal((await decide(make(), 'gh api -X DELETE repos/o/r/git/refs/heads/$B')).decision, 'deny');
  assert.equal((await decide(make(), 'gh api -X DELETE repos/o/r/git/refs/tags/v1.0')).decision, 'deny');
});

test('w6815: force pushes, other ref rewrites and pushes to master stay refused', async () => {
  const deny = [
    'git push -f origin w1-a',
    'git push --force origin w1-a',
    'git push origin +w1-a',
    'git push -fd origin w1-a',
    'git push --delete --force origin w1-a',
    'git push origin --delete w1-a +w1-b',
    'git push --mirror origin',
    'git push origin HEAD:master',
    'git push origin w1-a:master',
    'gh api -X PATCH repos/o/r/git/refs/heads/w1-a -F sha=abc -F force=true',
    'gh api -X POST repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc',
    'gh api repos/o/r/git/refs -f ref=refs/heads/x -f sha=abc',
    'gh api -X DELETE repos/o/r/git/refs/heads/w1-a -f x=1',
    'gh api -X DELETE repos/o/r/branches/w1-a/protection',
    'gh api -XDELETE repos/o/r/branches/w1-a/protection',
    'gh api --method=PUT repos/o/r/branches/w1-a/protection --input p.json',
    'gh api -X POST repos/o/r/merges -f base=w1-a -f head=x',
  ];
  for (const command of deny) assert.equal((await decide(make(), command)).decision, 'deny', command);
  assert.equal((await decide(make(), 'git push --force-with-lease origin w1-a')).decision, 'allow');
  assert.equal((await decide(make(), 'git push -u origin w1-a')).decision, 'allow');
});

test('w6815: the audit never refuses: an unreadable sha is logged as unknown', async () => {
  const lines: string[] = [];
  const g = sandboxGuard({ sandboxId: 'sb1', sandboxPath: 'C:/ffsb/sb1', protectedPaths: [], remotes: () => undefined, prBase: () => undefined, evidence: () => undefined, session: 's2', log: (l) => lines.push(l), branchSha: async () => undefined, junctionRmWarn: false });
  assert.equal((await decide(g, 'git push origin --delete refs/heads/w1-a')).decision, 'allow');
  assert.match(lines[0], /session=s2 sandbox=sb1 route=git push repo=unknown branch=w1-a sha=unknown$/);
  const thrown: string[] = [];
  const h = sandboxGuard({ sandboxId: 'sb1', sandboxPath: 'C:/ffsb/sb1', protectedPaths: [], remotes, prBase: () => undefined, evidence: () => undefined, log: (l) => thrown.push(l), branchSha: async () => { throw new Error('boom'); }, junctionRmWarn: false });
  assert.equal((await decide(h, 'gh api -X DELETE repos/o/r/git/refs/heads/w1-a')).decision, 'allow');
  assert.match(thrown[0], /branch=w1-a sha=unknown \(audit read failed: boom\)/);
});

test('w6815: checkShell and the API parser agree with the list', () => {
  assert.equal(checkShell('git push origin --delete refs/heads/w1-a'), undefined);
  // With no way to read the remote, a plain name is refused: it could be a tag.
  assert.match(checkShell('git push origin --delete w1-a') ?? '', /refs\/heads\/w1-a/);
  assert.match(checkShell('git push origin --delete master') ?? '', /refused/);
  assert.deepEqual(ghApiBranchDelete(['gh', 'api', '-X', 'DELETE', 'repos/o/r/git/refs/heads/a/b'], ['gh', 'api', '-x', 'delete', 'repos/o/r/git/refs/heads/a/b']), { repo: 'o/r', branch: 'a/b' });
  assert.equal(ghApiBranchDelete(['gh', 'api', '-X', 'DELETE', 'repos/o/r/git/refs/tags/a'], ['gh', 'api', '-x', 'delete', 'repos/o/r/git/refs/tags/a']), undefined);
  // Every entry of the list is exercised by a name in PROTECTED above.
  for (const p of PROTECTED_BRANCHES) assert.ok(PROTECTED.some((b) => p.pattern.test(b)), String(p.pattern));
  for (const b of FEATURE) assert.equal(protectedBranch(b), undefined, b);
  assert.equal(judgeBranchDelete('refs/heads/w1-a'), undefined);
  assert.match(judgeBranchDelete('refs/heads/main') ?? '', /default/);
});

// w6817's review of PR #1582: each command below got past the first version.
test('w6815 review B1: git short ref names (heads/<x>, tags/<x>) are refused', async () => {
  for (const command of ['git push origin :heads/main', 'git push origin --delete heads/master', 'git push origin :heads/release/1.0', 'git push origin --delete tags/v1.0', 'git push origin :tags/latest', 'git push origin --delete remotes/origin/w1-a', 'git push origin --delete heads/w1-a']) {
    const lines: string[] = [];
    const r = await decide(make(lines), command);
    assert.equal(r.decision, 'deny', command);
    assert.deepEqual(lines, [], command);
  }
  // refs/heads/heads/main is the literal branch heads/main, not main.
  assert.equal((await decide(make(), 'git push origin :refs/heads/heads/main')).decision, 'allow');
});

test('w6815 review B2: a plain name that is a tag on the remote is refused; the name must be a branch there', async () => {
  for (const b of TAGS) {
    assert.match((await decide(make(), `git push origin --delete ${b}`)).reason, /tag of that name/, b);
    assert.match((await decide(make(), `git push origin :${b}`)).reason, /tag of that name/, b);
  }
  assert.match((await decide(make(), 'git push origin --delete gone')).reason, /no branch of that name/);
  assert.match((await decide(make(), 'git push origin --delete unreadable')).reason, /could not be read/);
  assert.match((await decide(make(), 'git push origin --delete notes-x')).reason, /another ref/);
  // The full refs/heads/ name never reaches a tag, so it needs no lookup.
  assert.equal((await decide(make(), 'git push origin --delete refs/heads/unreadable')).decision, 'allow');
  // An unknown remote: refused for a plain name, with the full-name fix.
  const g = sandboxGuard({ sandboxId: 'sb1', sandboxPath: 'C:/ffsb/sb1', protectedPaths: [], remotes: () => undefined, prBase: () => undefined, evidence: () => undefined, remoteRefs: refsOf, log: () => {}, branchSha: async () => undefined, junctionRmWarn: false });
  assert.match((await decide(g, 'git push origin --delete w1-a')).reason, /git push origin --delete refs\/heads\/w1-a/);
  // The sha the check read is the one logged (no second read).
  const lines: string[] = [];
  const shas: string[] = [];
  assert.equal((await decide(make(lines, shas), 'git push origin --delete w1-a')).decision, 'allow');
  assert.deepEqual(shas, []);
  assert.match(lines[0], /branch=w1-a sha=a{40}$/);
});

test('w6815 review B3: abbreviated long options are read as git reads them', async () => {
  for (const command of ['git push origin --dele release/1.0', 'git push origin --de pre-1.0', 'git push origin --del master', 'git push --mirr origin', 'git push --pru origin', 'git push --branches origin', 'git push origin --forc w1-a', 'git push origin --fo w1-a']) {
    assert.equal((await decide(make(), command)).decision, 'deny', command);
  }
  const lines: string[] = [];
  assert.equal((await decide(make(lines), 'git push origin --dele w1-a')).decision, 'allow');
  assert.match(lines[0], /branch=w1-a /);
});

test('w6815 review N1, N4: -o takes its value; config refspecs, GraphQL ref mutations and tag cleanup are refused', async () => {
  // -od is -o d (a push option), so feat:master is a push to master, judged as one.
  assert.equal((await decide(make(), 'git push -od origin feat:master')).decision, 'deny');
  const lines: string[] = [];
  assert.equal((await decide(make(lines), 'git push -o ci.skip origin w1-a')).decision, 'allow');
  assert.deepEqual(lines, []);
  for (const command of [
    'git -c remote.origin.push=:refs/heads/main push origin',
    'git -c remote.origin.mirror=true push origin',
    'git push origin $(echo :main)',
    "gh api graphql -f query='mutation{deleteRef(input:{refId:\"x\"}){clientMutationId}}'",
    'gh release delete v1.0 --cleanup-tag -y',
  ]) {
    assert.equal((await decide(make(), command)).decision, 'deny', command);
  }
  assert.equal((await decide(make(), 'gh release delete v1.0 -y')).decision, 'allow');
});

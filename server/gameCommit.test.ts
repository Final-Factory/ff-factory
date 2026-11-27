import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetCommitChecks, gameCommitAt } from './gameDataDir.ts';
import type { Runner } from './githubTokens.ts';

const REPO = 'Final-Factory/FinalFactory';
// w6187's pair run: the real head of game PR #4382, and the mistyped sha it was filed with (same first 10 characters).
const HEAD = '20786882d8c3f54012a49c63c5073eb7c2b1f0dc';
const TYPO = '20786882d8bd6c1a00000000000000000000beef';

/** A gh that knows the commits `shas` (and which branches each heads), or fails every read with `down`. */
function fakeGh(shas: Record<string, string[]>, down?: string): { gh: Runner; calls: string[] } {
  const calls: string[] = [];
  const gh: Runner = async (_cmd, args) => {
    const url = args.find((x) => x.startsWith('repos/'))!;
    calls.push(url);
    if (down) return { code: 1, stdout: '', stderr: down };
    const b = /\/commits\/([0-9a-f]{40})\/branches-where-head$/.exec(url);
    if (b) return { code: 0, stdout: (shas[b[1]] ?? []).map((n) => `${n}\n`).join(''), stderr: '' };
    const c = /\/commits\/([0-9a-f]+)$/.exec(url)!;
    const hits = Object.keys(shas).filter((k) => k.startsWith(c[1]));
    return hits.length === 1 ? { code: 0, stdout: `${hits[0]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: `gh: No commit found for SHA: ${c[1]} (HTTP 422)` };
  };
  return { gh, calls };
}

test('w6206: a real full sha and a real short sha pass, resolved to the full sha, and a known one is not asked again', async () => {
  forgetCommitChecks();
  const { gh, calls } = fakeGh({ [HEAD]: ['w6129-strut-reduction-050'] });
  assert.deepEqual(await gameCommitAt(gh, REPO, HEAD), { known: true, full: HEAD });
  assert.deepEqual(await gameCommitAt(gh, REPO, '20786882D8'), { known: true, full: HEAD }, 'a short sha, in any case');
  const n = calls.length;
  await gameCommitAt(gh, REPO, '20786882d8');
  assert.equal(calls.length, n);
});

test('w6206: a mistyped sha is unknown, and the refusal names it and the branch head it looks like', async () => {
  forgetCommitChecks();
  const v = await gameCommitAt(fakeGh({ [HEAD]: ['w6129-strut-reduction-050'] }).gh, REPO, TYPO);
  assert.equal(v.known, false);
  assert.equal(v.why, `commit ${TYPO} is not in ${REPO}: GitHub has no such commit; it looks like ${HEAD}, the head of w6129-strut-reduction-050, which shares its first 10 characters. Pass the sha the legs must run (git rev-parse HEAD on the pushed branch; w6206)`);
  // Nothing near it: the refusal names only the commit.
  const far = await gameCommitAt(fakeGh({ [HEAD]: [] }).gh, REPO, 'deadbeef12');
  assert.deepEqual(far, { known: false, why: `commit deadbeef12 is not in ${REPO}: GitHub has no such commit. Pass the sha the legs must run (git rev-parse HEAD on the pushed branch; w6206)` });
  // A commit that heads no branch is named without one.
  const lone = await gameCommitAt(fakeGh({ [HEAD]: [] }).gh, REPO, TYPO);
  assert.match(lone.known === false ? lone.why : '', new RegExp(`it looks like ${HEAD}, which shares its first 10 characters`));
  assert.equal((await gameCommitAt(fakeGh({}).gh, REPO, 'pre-1.0')).known, false, 'a branch name is not a sha');
});

test('w6206: a GitHub read that fails is never a pass: it says it could not check, and why', async () => {
  forgetCommitChecks();
  const v = await gameCommitAt(fakeGh({ [HEAD]: [] }, 'error connecting to api.github.com').gh, REPO, HEAD);
  assert.deepEqual(v, { known: undefined, why: `FF Factory could not read commit ${HEAD} from GitHub to check that it exists in ${REPO} (error connecting to api.github.com; w6206)` });
  // A failed read is not kept: GitHub answers next time.
  assert.equal((await gameCommitAt(fakeGh({ [HEAD]: [] }).gh, REPO, HEAD)).known, true);
  // An answer for another commit than asked is no pass either.
  const odd: Runner = async () => ({ code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' });
  forgetCommitChecks();
  const w = await gameCommitAt(odd, REPO, '20786882d8');
  assert.equal(w.known, undefined);
  assert.match(w.known === undefined ? w.why : '', /GitHub answered "a{40}" for it/);
});

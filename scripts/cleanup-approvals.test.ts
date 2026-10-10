import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupKinds, countApprovals } from './cleanup-approvals.ts';

test('w913: the clean-up commands of the transcripts are told apart by what they delete', () => {
  assert.deepEqual(cleanupKinds('du -sh $TMPDIR; rm -rf $TMPDIR/ff-factory $TMPDIR/*.log /tmp/ffb-w901'), ['session temp ($TMPDIR, /tmp)']);
  assert.deepEqual(cleanupKinds('rm -rf $TMPDIR/ff $TMPDIR/*.txt $TMPDIR/t.ts $TMPDIR/body.md'), ['session temp ($TMPDIR, /tmp)']);
  assert.deepEqual(cleanupKinds('rm -f "$USERPROFILE/AppData/LocalLow/Never Games/finalfactory/saves/w92-LifeAsTwo.zip"'), ['save copy']);
  assert.deepEqual(cleanupKinds('python scripts/nightly/player_slots.py prune'), ['player slots / builds / captures']);
  assert.deepEqual(cleanupKinds('git worktree remove --force ../x'), ['git worktree']);
  assert.deepEqual(cleanupKinds('rm -rf Builds/hitch && ls'), ['player slots / builds / captures']);
  assert.deepEqual(cleanupKinds('git status; ls'), []);
  assert.deepEqual(cleanupKinds("cat > a.py <<'E'\nrm -rf $TMPDIR/x\nE\npython a.py"), [], 'a heredoc body is text, not a command');
});

test('w913: only the prompts a person answered count, per day', () => {
  const ev = (t: string, command: string, extra: object = { decision: 'allow', decidedBy: { userId: 'ben', displayName: 'Ben' } }) =>
    JSON.stringify({ seq: 1, t, kind: 'permission', requestId: 'r', toolName: 'Bash', input: { command }, ...extra });
  const days = countApprovals(
    [
      ev('2026-10-10T10:00:00Z', 'rm -rf $TMPDIR/ff'),
      ev('2026-10-10T11:00:00Z', 'rm -rf $TMPDIR/ff'),
      ev('2026-10-10T11:30:00Z', 'git push origin HEAD:develop'),
      ev('2026-10-10T12:00:00Z', 'rm -rf $TMPDIR/ff', {}), // asked, not answered
      ev('2026-10-09T12:00:00Z', 'python scripts/nightly/player_slots.py prune'),
      JSON.stringify({ kind: 'assistant', t: '2026-10-10T12:00:00Z', text: 'permission' }),
      'not json "permission"',
    ],
    '2026-10-10',
  );
  assert.deepEqual([...days.keys()], ['2026-10-10']);
  assert.deepEqual(days.get('2026-10-10'), { day: '2026-10-10', prompts: 3, cleanup: { 'session temp ($TMPDIR, /tmp)': 2 }, cleanupTotal: 2 });
});

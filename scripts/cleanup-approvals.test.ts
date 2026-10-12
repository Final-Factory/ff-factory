import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { byKind, cleanupKinds, countApprovals, promptKind, reasonWords } from './cleanup-approvals.ts';

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
  assert.deepEqual(days.get('2026-10-10'), { day: '2026-10-10', prompts: 3, cleanup: { 'session temp ($TMPDIR, /tmp)': 2 }, cleanupTotal: 2, kinds: { 'Bash delete: session temp ($TMPDIR, /tmp)': 2, 'Bash: git': 1 } });
});

test("w1097: every prompt is grouped by kind, by Claude Code's own reason when the transcript has it", () => {
  const rmWhy = 'Dangerous rm operation on possibly-empty variable path: $TMPDIR/{f1920,f1280} in `rm -rf $TMPDIR/{f1920,f1280}` (use a literal path)';
  assert.equal(promptKind('Bash', { command: 'rm -rf $TMPDIR/{f1920,f1280}' }, rmWhy), 'Claude Code: dangerous rm of a $VAR path (glob, brace list)');
  assert.equal(promptKind('Bash', { command: 'rm -rf /x' }, 'Dangerous rm operation on critical path: /x'), 'Claude Code: dangerous rm of a critical path');
  assert.equal(promptKind('Bash', { command: 'x' }, 'touches C:/Users/rydin/.ssh'), 'Claude Code: a path outside the allowed folders');
  assert.equal(promptKind('Bash', { command: 'x' }, 'This command uses shell operators that require approval for safety'), 'Claude Code: This command uses shell operators that require approval for safety');
  // Before w1097 the transcript has no reason: the command's shape.
  const w1079 = 'D="/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory"; rm -rf $TMPDIR/f1920 $TMPDIR/f1280\nrun() { # size to\n S=$1\n}';
  assert.equal(promptKind('Bash', { command: w1079 }), 'Bash delete: session temp ($TMPDIR, /tmp), in a multi-step command');
  assert.equal(promptKind('Bash', { command: 'rm -rf $TMPDIR/ff' }), 'Bash delete: session temp ($TMPDIR, /tmp)');
  assert.equal(promptKind('Bash', { command: 'cp a "/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory/UserData/settings/settings.json"' }), "Bash: the game's data folder");
  assert.equal(promptKind('Write', {}), 'tool: Write');
  assert.equal(promptKind('mcp__machine__unity', {}), 'tool: mcp__machine');
  const ev = (t: string, reason?: string) =>
    JSON.stringify({ seq: 1, t, kind: 'permission', requestId: 'r', toolName: 'Bash', input: { command: 'rm -rf $TMPDIR/{a,b}' }, ...(reason ? { reason } : {}), decision: 'allow', decidedBy: { userId: 'l', displayName: 'L' } });
  const days = countApprovals([ev('2026-10-11T01:00:00Z'), ev('2026-10-13T01:00:00Z', rmWhy), ev('2026-10-13T02:00:00Z', rmWhy)]);
  assert.deepEqual(byKind([...days.values()], '2026-10-12'), [
    ['Claude Code: dangerous rm of a $VAR path (glob, brace list)', { total: 2, before: 0, after: 2 }],
    ['Bash delete: session temp ($TMPDIR, /tmp)', { total: 1, before: 1, after: 0 }],
  ]);
});

test("w1097: an unknown reason becomes plain words only: no path, command or variable from the transcript", () => {
  assert.equal(reasonWords("Claude requested permissions to write to /srv/fff/data/x.json, but you haven't granted it yet."), 'Claude requested permissions to write to');
  assert.equal(reasonWords('Shell expansion syntax in paths requires manual approval'), 'Shell expansion syntax in paths requires manual approval');
  assert.equal(reasonWords('$(cat ~/.ssh/id_ed25519) sk-ant-oat01-xxxx'), 'another reason');
});

test('w1097: run as fffctl approvals does, it prints counts and kinds only, and refuses a date that is not one', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-approvals-'));
  try {
    fs.mkdirSync(path.join(data, 'transcripts'));
    const secretish = 'rm -rf $TMPDIR/{f1920,f1280}; cp "/c/Users/rydin/AppData/LocalLow/Never Games/finalfactory/x" ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const ev = (t: string, reason?: string) =>
      JSON.stringify({ seq: 1, t, kind: 'permission', requestId: 'r', toolName: 'Bash', input: { command: secretish }, ...(reason ? { reason } : {}), decision: 'allow', decidedBy: { userId: 'l', displayName: 'L' } });
    fs.writeFileSync(path.join(data, 'transcripts', 'a1b2c3d4.jsonl'), [ev('2026-10-11T01:00:00Z'), ev('2026-10-13T01:00:00Z', 'Dangerous rm operation on possibly-empty variable path: $TMPDIR/{f1920,f1280} in `rm -rf ...`'), ev('2026-10-13T02:00:00Z', 'touches /srv/fff/secrets/x')].join('\n') + '\n');
    const script = path.join(import.meta.dirname, 'cleanup-approvals.ts');
    const out = execFileSync(process.execPath, [...process.execArgv, script, data, '--since', '2026-10-05', '--split', '2026-10-12'], { encoding: 'utf8' });
    assert.match(out, /2026-10-11 \(before\)\s+prompts\s+1/);
    assert.match(out, /2026-10-13 \(after\)\s+prompts\s+2/);
    assert.match(out, /every prompt a person answered, by kind \(before 2026-10-12 \/ from 2026-10-12\)/);
    assert.match(out, /1\s+\(0 \/ 1\)\s+Claude Code: dangerous rm of a \$VAR path/);
    for (const leak of ['rydin', 'LocalLow', 'ghp_', 'f1920', '/srv/fff', 'rm -rf']) assert.ok(!out.includes(leak), `printed ${leak}: ${out}`);
    const bad = spawnSync(process.execPath, [...process.execArgv, script, data, '--split', '2026-10-12;id'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--split takes a date/);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

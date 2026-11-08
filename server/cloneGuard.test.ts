import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkGameRepoClone } from './cloneGuard.ts';
import { sandboxGuard } from './guard.ts';

// w3703: w3683's pair-run leg cloned the game repo into its temp folder (43 GB on LothDesktop's V:, 8 GB of LFS on BEAST's F:),
// w3682's --library scratch clone took 48 GB. A player of another commit is built in the sandbox, one commit at a time.
const env = { TMPDIR: 'F:/ffw/tmp/ffa-1', HOME: 'C:/Users/dev' };
const ctx = { cwd: 'F:/ffw/sandboxes/slot4', env, gameRepos: ['https://github.com/Final-Factory/FinalFactory.git', 'F:/ffw/repo'], sandboxPath: 'F:/ffw/sandboxes/slot4', isUnityProject: (d: string) => /sandboxes[\\/]slot\d$/i.test(d.replace(/[\\/]+$/, '')) };

test('a full clone of the game repo is refused, in every spelling of its source', () => {
  for (const cmd of [
    'git clone https://github.com/Final-Factory/FinalFactory.git $TMPDIR/clone-w3683',
    'GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 git@github.com:Final-Factory/FinalFactory "$TMPDIR/before"',
    'git clone --shared --no-checkout F:/ffw/sandboxes/slot4 $TMPDIR/clone-x',
    'git clone /f/ffw/repo $TMPDIR/x',
    'cd $TMPDIR && git clone -q --filter=blob:none https://github.com/final-factory/finalfactory w3683/clone',
    'git clone --shared ../slot2 $TMPDIR/c',
    'git -c core.longpaths=true clone -b master https://github.com/Final-Factory/FinalFactory x',
  ]) {
    const r = checkGameRepoClone(cmd, ctx);
    assert.ok(r, cmd);
    assert.match(r!, /w3703/);
    assert.match(r!, /one commit at a time/);
  }
});

test('scratch_clone.sh is refused, with or without --library', () => {
  for (const cmd of [
    'bash scripts/nightly/scratch_clone.sh F:/ffw/sandboxes/slot2 0123456789012345678901234567890123456789 $TMPDIR/clone-X --library',
    'scripts/nightly/scratch_clone.sh F:/ffw/sandboxes/slot2 0123456789012345678901234567890123456789 $TMPDIR/clone-X',
  ]) {
    assert.match(checkGameRepoClone(cmd, ctx) ?? '', /scratch_clone\.sh is retired.*build_player\.sh/s, cmd);
  }
});

test('a sparse clone of the game repo, and clones of other repos, still pass', () => {
  for (const cmd of [
    'GIT_LFS_SKIP_SMUDGE=1 git clone --depth 50 --filter=blob:none --sparse https://github.com/Final-Factory/FinalFactory.git $TMPDIR/game',
    'git clone --depth 50 https://github.com/Final-Factory/ff-factory.git $TMPDIR/ff-factory',
    'git clone https://github.com/Final-Factory/final-factory-agents $TMPDIR/agents',
    'git clone https://github.com/Final-Factory/FinalFactoryModTemplate $TMPDIR/tpl',
    'git -C $TMPDIR/game sparse-checkout set scripts',
    'git status',
    'echo "git clone https://github.com/Final-Factory/FinalFactory"',
  ]) {
    assert.equal(checkGameRepoClone(cmd, ctx), undefined, cmd);
  }
});

test('a folder that is a Unity project counts as the game repo by default', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-guard-'));
  fs.mkdirSync(path.join(d, 'ProjectSettings'));
  fs.writeFileSync(path.join(d, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.0f1\n');
  assert.ok(checkGameRepoClone(`git clone --shared ${d} ${d}-copy`, { gameRepos: [] }));
  assert.equal(checkGameRepoClone(`git clone ${path.join(d, 'ProjectSettings')} x`, { gameRepos: [] }), undefined);
});

test('the sandbox guard refuses the clone a pair-run leg made (w3683)', async () => {
  const g = sandboxGuard({ sandboxId: 'slot4', sandboxPath: 'F:/ffw/sandboxes/slot4', protectedPaths: [], gameRepos: ['https://github.com/Final-Factory/FinalFactory.git'], env, prBase: () => undefined, evidence: () => undefined });
  const decide = async (command: string) => {
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: 'F:/ffw/sandboxes/slot4' };
    const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    return r.hookSpecificOutput?.permissionDecision ?? 'allow';
  };
  assert.equal(await decide('git clone https://github.com/Final-Factory/FinalFactory.git $TMPDIR/w3683/clone'), 'deny');
  assert.equal(await decide('git clone --sparse https://github.com/Final-Factory/FinalFactory.git $TMPDIR/game'), 'allow');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { sandboxGuard } from './guard.ts';

// w936: a worker whose request asked for work in the machine's main clone may quit its editor, back up, fetch, check a
// branch out and reopen Unity there, and nothing else.
const CLONE = 'C:/Users/ben/nevergames/FinalFactory';
const LIVE = 'C:/ffw/live';
const LOOKALIKE = 'C:/Users/ben/nevergames/FinalFactory-live';
const SANDBOX = 'C:/ffw/sandboxes/slot1';

const decide = async (g: ReturnType<typeof sandboxGuard>, tool_name: string, tool_input: unknown) => {
  const input = { hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: SANDBOX };
  const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return { verdict: r.hookSpecificOutput?.permissionDecision ?? 'allow', reason: r.hookSpecificOutput?.permissionDecisionReason ?? '' };
};

const granted = () =>
  sandboxGuard({
    sandboxId: 'slot1',
    sandboxPath: SANDBOX,
    protectedPaths: [CLONE, LIVE, LOOKALIKE],
    mainClone: { path: CLONE, requests: ['w934'], exists: (p) => p.replace(/\\/g, '/').endsWith('/Assets') },
  });
const plain = () => sandboxGuard({ sandboxId: 'slot1', sandboxPath: SANDBOX, protectedPaths: [CLONE, LIVE, LOOKALIKE] });

const BRIDGE = `python scripts/unity-bridge.py eval --project-path ${CLONE}`;
const SAVE_AND_QUIT = `'UnityEditor.SceneManagement.EditorSceneManager.SaveOpenScenes(); UnityEditor.EditorApplication.Exit(0); return "quit";'`;

const ALLOWED = [
  `git -C ${CLONE} status --short`,
  `git -C ${CLONE} log --oneline -5`,
  `git -C ${CLONE} stash list`,
  `git -C ${CLONE} stash push -u -m "w934 backup before checkout"`,
  `git -C ${CLONE} stash list`,
  `git -C ${CLONE} branch backup/w934-main`,
  `git -C ${CLONE} branch --show-current`,
  `git -C ${CLONE} diff --binary > C:/tmp/w934-backup.patch`,
  `git -C ${CLONE} fetch origin`,
  `git -C ${CLONE} fetch origin sandbox/w27-connector-models`,
  `git -C ${CLONE} checkout sandbox/w27-connector-models`,
  `git -C ${CLONE} checkout -b w27-connector-models origin/w27-connector-models`,
  `git -C ${CLONE} checkout --track origin/w27-connector-models`,
  `git -C ${CLONE} switch w27-connector-models`,
  `git -C ${CLONE} switch -c w27-review origin/w27-connector-models`,
  `git -C ${CLONE} merge --ff-only origin/w27-connector-models`,
  `git -C ${CLONE} pull --ff-only origin w27-connector-models`,
  `git -C /c/Users/ben/nevergames/FinalFactory status`,
  `git -C "${CLONE}/" status`,
  `${BRIDGE} ${SAVE_AND_QUIT}`,
  `${BRIDGE} 'UnityEditor.EditorApplication.delayCall += () => UnityEditor.EditorApplication.Exit(0); return 1;'`,
  `python scripts/unity-bridge.py status --project-path ${CLONE}`,
  `ps -axo pid,command | grep "[M]acOS/Unity -projectPath ${CLONE}$"`,
  `pgrep -f "MacOS/Unity -projectPath ${CLONE}"`,
  `open -n -a Unity --args -projectPath ${CLONE}`,
  `"/Applications/Unity/Hub/Editor/6000.3.0f1/Unity.app/Contents/MacOS/Unity" -projectPath ${CLONE} -logFile C:/tmp/unity-main.log &`,
  `git -C ${CLONE} status && python scripts/unity-bridge.py ping --project-path ${CLONE}`,
  `git -C ${CLONE} log --oneline | head -5`,
  `python ${SANDBOX}/scripts/unity-bridge.py ping --project-path ${CLONE}`,
];

const REFUSED = [
  // deletes and force operations
  `git -C ${CLONE} reset --hard origin/develop`,
  `git -C ${CLONE} clean -fd`,
  `git -C ${CLONE} checkout -f sandbox/w27`,
  `git -C ${CLONE} checkout --force sandbox/w27`,
  `git -C ${CLONE} checkout -B sandbox/w27 origin/sandbox/w27`,
  `git -C ${CLONE} checkout -- Assets/Scenes/main.unity`,
  `git -C ${CLONE} checkout .`,
  `git -C ${CLONE} checkout Assets`,
  `git -C ${CLONE} checkout --merge sandbox/w27`,
  `git -C ${CLONE} switch -C sandbox/w27`,
  `git -C ${CLONE} switch --discard-changes sandbox/w27`,
  `git -C ${CLONE} restore .`,
  `git -C ${CLONE} stash pop`,
  `git -C ${CLONE} stash drop`,
  `git -C ${CLONE} stash clear`,
  `git -C ${CLONE} branch -D old`,
  `git -C ${CLONE} branch -m old new`,
  `git -C ${CLONE} fetch --prune`,
  `git -C ${CLONE} fetch -f origin x:y`,
  `git -C ${CLONE} pull --rebase`,
  `git -C ${CLONE} pull origin x`,
  `git -C ${CLONE} merge origin/x`,
  `git -C ${CLONE} push origin HEAD`,
  `git -C ${CLONE} push --force origin x`,
  `git -C ${CLONE} commit -am x`,
  `git -C ${CLONE} rebase origin/develop`,
  `git -C ${CLONE} gc --prune=now`,
  `git -C ${CLONE} reflog expire --expire=now --all`,
  `git -C ${CLONE} diff --output=${CLONE}/x.patch`,
  `git -C ${CLONE} config user.email x@y`,
  `git -c core.hooksPath=/tmp/h -C ${CLONE} status`,
  `rm -rf ${CLONE}/Library`,
  `rm -rf ${CLONE}`,
  `Remove-Item -Recurse -Force ${CLONE}/Temp`,
  `git -C ${CLONE} status > ${CLONE}/out.txt`,
  `echo x > ${CLONE}/a.txt`,
  `cp C:/tmp/a ${CLONE}/Assets/a`,
  `cat ${CLONE}/.git/config`,
  `grep -r secret ${CLONE}`,
  // a cd would carry the directory into later commands
  `cd ${CLONE} && git clean -fd`,
  `cd ${CLONE}`,
  `git -C ${CLONE} status $(rm -rf /tmp/x)`,
  `GIT_DIR=${CLONE}/.git git status`,
  // chained with something that acts on what it is given, or runs a program, or forces refs
  `git -C ${CLONE} ls-files | xargs rm`,
  `git -C ${CLONE} status && rm -rf /tmp/x`,
  `git -C ${CLONE} fetch --upload-pack=evil origin`,
  `git -C ${CLONE} fetch origin +refs/heads/*:refs/heads/*`,
  `git -C ${CLONE} fetch ext::sh`,
  `python /tmp/unity-bridge.py status --project-path ${CLONE}`,
  // the editor: only save-and-quit through the bridge, only the clone, only the checked snippet
  `${BRIDGE} 'System.IO.Directory.Delete("Assets", true); return 1;'`,
  `${BRIDGE} 'UnityEditor.AssetDatabase.DeleteAsset("Assets/x"); return 1;'`,
  `${BRIDGE} 'UnityEditor.EditorApplication.Exit(0); System.Diagnostics.Process.Start("rm");'`,
  `python scripts/unity-bridge.py eval_file --project-path ${CLONE} x.cs`,
  `python ${CLONE}/scripts/unity-bridge.py status --project-path ${CLONE}`,
  `python evil.py --project-path ${CLONE}`,
  `open -n -a Unity --args -batchmode -projectPath ${CLONE} -executeMethod Build.All`,
  `"/Applications/Unity/Hub/Editor/6000.3.0f1/Unity.app/Contents/MacOS/Unity" -batchmode -quit -projectPath ${CLONE} -executeMethod X`,
  `"/Applications/Unity/Hub/Editor/6000.3.0f1/Unity.app/Contents/MacOS/Unity" -projectPath ${CLONE} -logFile ${CLONE}/Logs/u.log`,
  `open ${CLONE}`,
  `kill -9 12345 ${CLONE}`,
  // nothing outside the clone
  `git -C ${CLONE}/../other status`,
  `git -C ${LOOKALIKE} status`,
  `git -C ${LIVE} status`,
  `git -C ${CLONE} status && ls ${LIVE}`,
  `ls ${LOOKALIKE}/Assets`,
  `open -n -a Unity --args -projectPath ${LOOKALIKE}`,
  `python scripts/unity-bridge.py status --project-path ${LIVE}`,
];

test('w936: with the grant, backing up, fetching, checking out, quitting and reopening the editor in the main clone pass', async () => {
  const g = granted();
  for (const command of ALLOWED) {
    const r = await decide(g, 'Bash', { command });
    assert.equal(r.verdict, 'allow', `${command}\n  -> ${r.reason}`);
  }
});

test('w936: deletes, force operations, edits, pushes and every path outside the clone stay refused with the grant', async () => {
  const g = granted();
  for (const command of REFUSED) {
    const r = await decide(g, 'Bash', { command });
    assert.equal(r.verdict, 'deny', command);
  }
  // Write and Edit are not part of the grant.
  assert.equal((await decide(g, 'Write', { file_path: `${CLONE}/Assets/a.cs` })).verdict, 'deny');
  assert.equal((await decide(g, 'Edit', { file_path: `${CLONE}/Assets/a.cs` })).verdict, 'deny');
  assert.equal((await decide(g, 'Write', { file_path: `${LIVE}/a` })).verdict, 'deny');
});

test('w936: without the grant, every command naming the clone is refused, allowed forms included', async () => {
  const g = plain();
  for (const command of ALLOWED.filter((c) => c.includes('FinalFactory'))) {
    assert.equal((await decide(g, 'Bash', { command })).verdict, 'deny', command);
  }
});

test('w936: a refusal says what the grant allows and where the rest goes', async () => {
  const r = await decide(granted(), 'Bash', { command: `git -C ${CLONE} reset --hard` });
  assert.equal(r.verdict, 'deny');
  assert.match(r.reason, /Refused in the main clone/);
  assert.match(r.reason, /w934/);
  assert.match(r.reason, /hand any other step to your orchestrator/);
});

test('w936: ~ and $HOME spell the clone, and are judged the same way', async () => {
  const clone = path.join(os.homedir(), 'nevergames', 'FinalFactory');
  const g = sandboxGuard({ sandboxId: 'slot1', sandboxPath: SANDBOX, protectedPaths: [clone], mainClone: { path: clone, requests: ['w934'] } });
  assert.equal((await decide(g, 'Bash', { command: 'git -C ~/nevergames/FinalFactory fetch origin' })).verdict, 'allow');
  assert.equal((await decide(g, 'Bash', { command: 'git -C $HOME/nevergames/FinalFactory stash list' })).verdict, 'allow');
  assert.equal((await decide(g, 'Bash', { command: 'git -C ~/nevergames/FinalFactory clean -fd' })).verdict, 'deny');
  assert.equal((await decide(g, 'Bash', { command: 'rm -rf $HOME/nevergames/FinalFactory/Library' })).verdict, 'deny');
});

test('w936: a granted clone that holds the worker\'s own sandbox is not a clone to open up', async () => {
  const g = sandboxGuard({ sandboxId: 'slot1', sandboxPath: SANDBOX, protectedPaths: ['C:/ffw'], mainClone: { path: 'C:/ffw', requests: ['w1'] } });
  assert.equal((await decide(g, 'Bash', { command: 'git -C C:/ffw status' })).verdict, 'allow'); // the sandbox is inside it, so it was never protected
});

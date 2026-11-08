import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxGuard } from './guard.ts';
import { daemonShell } from './daemonReads.ts';

/**
 * w3670 (lothsahn: "Please give workers read only access to the logs and other reasonable daemon files it might ever need"):
 * a machine worker reads its daemon's logs and non-secret files, never its secrets, and writes nothing there. w3650's worker on
 * LothDesktop could not `tail` D:\work\ffw\daemon\logs\daemon.log.
 */

const decide = async (g: ReturnType<typeof sandboxGuard>, tool_name: string, tool_input: unknown) => {
  const input = { hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: '' };
  const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return r.hookSpecificOutput?.permissionDecision ?? 'allow';
};
const why = async (g: ReturnType<typeof sandboxGuard>, tool_name: string, tool_input: unknown) => {
  const input = { hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: '' };
  const r = (await g(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
  return r.hookSpecificOutput?.permissionDecisionReason ?? '';
};

/** LothDesktop's layout: the host folder D:\work\ffw keeps the daemon and secrets, the root is on its Dev Drive V:. */
const lothdesktop = () =>
  sandboxGuard({
    sandboxId: 'slot3',
    sandboxPath: 'V:/ffw/sandboxes/slot3',
    protectedPaths: ['D:\\work\\ffw\\daemon', 'V:\\ffw\\repo'],
    workerRoot: 'V:\\ffw',
    daemonReads: { dir: 'D:\\work\\ffw\\daemon', root: 'V:\\ffw' },
    platform: 'win32',
    home: 'C:/Users/loth',
    env: { TMPDIR: 'V:/ffw/tmp/ffa-1' },
    prBase: () => undefined,
    evidence: () => undefined,
  });

/** A Mac whose daemon runs from ~/.ff-factory. */
const mac = () =>
  sandboxGuard({
    sandboxId: 'slot1',
    sandboxPath: '/Users/m5/ffw/sandboxes/slot1',
    protectedPaths: ['/Users/m5/.ff-factory'],
    workerRoot: '/Users/m5/ffw',
    daemonReads: { dir: '/Users/m5/.ff-factory', root: '/Users/m5/ffw' },
    platform: 'darwin',
    home: '/Users/m5',
    prBase: () => undefined,
    evidence: () => undefined,
  });

test('w3670 Windows: the daemon logs, rolled logs, update and clean-up logs, state, devdrive.json and its code are read', async () => {
  const g = lothdesktop();
  for (const command of [
    'tail -n 50 D:\\work\\ffw\\daemon\\logs\\daemon.log',
    'tail -n 200 /d/work/ffw/daemon/logs/daemon.log | grep -i link',
    'zcat D:/work/ffw/daemon/logs/daemon.log.20261025T151558985Z.gz | tail -5',
    'cat D:/work/ffw/daemon/logs/update-job.log D:/work/ffw/daemon/logs/supervisor.log',
    'cat D:/work/ffw/daemon/cleanup-log.jsonl | tail -3',
    'cat D:/work/ffw/daemon/sandboxes.json D:/work/ffw/daemon/pause.json',
    'cat D:/work/ffw/devdrive.json',
    'ls -la D:/work/ffw/daemon',
    'find D:/work/ffw/daemon/logs -name "*.gz"',
    'grep -rn "link down" D:/work/ffw/daemon/src/machine',
    'git -C D:/work/ffw/daemon/src log -1 --oneline',
    "sed -n '1,40p' D:/work/ffw/daemon/update/result.json",
    'tail -n 2000 D:/work/ffw/daemon/logs/daemon.log > "$TMPDIR/daemon.log" 2>&1',
  ]) {
    assert.equal(await decide(g, 'Bash', { command }), 'allow', `${command}: ${await why(g, 'Bash', { command })}`);
  }
  for (const command of ['Get-Content D:\\work\\ffw\\daemon\\logs\\daemon.log -Tail 50', 'Get-Content -Path "D:\\work\\ffw\\daemon\\logs\\daemon.err.log" -Tail 20 | Select-Object -Last 5']) {
    assert.equal(await decide(g, 'PowerShell', { command }), 'allow', `${command}: ${await why(g, 'PowerShell', { command })}`);
  }
  assert.equal(await decide(g, 'Read', { file_path: 'D:\\work\\ffw\\daemon\\logs\\daemon.log' }), 'allow');
  assert.equal(await decide(g, 'Read', { file_path: 'D:/work/ffw/daemon/src/machine/daemon.ts' }), 'allow');
  assert.equal(await decide(g, 'Grep', { pattern: 'offline', path: 'D:\\work\\ffw\\daemon\\logs' }), 'allow');
  assert.equal(await decide(g, 'Glob', { pattern: '*', path: 'D:\\work\\ffw\\daemon' }), 'allow', 'names only');
});

test('w3670 Windows: secrets stay closed, to the shell and to Read and Grep', async () => {
  const g = lothdesktop();
  for (const command of [
    'cat D:/work/ffw/daemon/daemon.json',
    'cat D:\\work\\ffw\\daemon\\daemon.json.prev',
    'cat D:/work/ffw/daemon/gh-app/tokens.json',
    'tail D:/work/ffw/daemon/hosts/abc/in.jsonl',
    'cat D:/work/ffw/secrets/machine-token',
    'cat V:/ffw/secrets/machine-token',
    'grep -r token D:/work/ffw/daemon',
    'cat D:/work/ffw/daemon/*.json',
    'cd D:/work/ffw/daemon && cat daemon.json',
  ]) {
    assert.equal(await decide(g, 'Bash', { command }), 'deny', command);
  }
  assert.equal(await decide(g, 'PowerShell', { command: 'Get-Content D:\\work\\ffw\\daemon\\daemon.json' }), 'deny');
  assert.equal(await decide(g, 'Read', { file_path: 'D:\\work\\ffw\\daemon\\daemon.json' }), 'deny');
  assert.equal(await decide(g, 'Read', { file_path: 'D:/work/ffw/daemon/gh-app/tokens.json' }), 'deny');
  assert.equal(await decide(g, 'Read', { file_path: 'D:/work/ffw/secrets/machine-token' }), 'deny');
  assert.equal(await decide(g, 'Grep', { pattern: 'token', path: 'D:\\work\\ffw\\daemon' }), 'deny');
  assert.match(await why(g, 'Read', { file_path: 'D:\\work\\ffw\\daemon\\daemon.json' }), /closed to workers.*logs, src/);
});

test('w3670 Windows: writes, deletes and runs in the daemon folder stay refused', async () => {
  const g = lothdesktop();
  assert.equal(await decide(g, 'Write', { file_path: 'D:\\work\\ffw\\daemon\\logs\\daemon.log', content: 'x' }), 'deny');
  assert.equal(await decide(g, 'Edit', { file_path: 'D:/work/ffw/daemon/pause.json', old_string: 'a', new_string: 'b' }), 'deny');
  for (const command of [
    'echo x > D:/work/ffw/daemon/logs/daemon.log',
    'echo x >> D:\\work\\ffw\\daemon\\pause.json',
    'rm D:/work/ffw/daemon/logs/daemon.log',
    'mv D:/work/ffw/daemon/logs/daemon.log V:/ffw/tmp/ffa-1/x',
    'cp D:/work/ffw/daemon/logs/daemon.log V:/ffw/tmp/ffa-1/x',
    'sed -i s/a/b/ D:/work/ffw/daemon/pause.json',
    'gzip D:/work/ffw/daemon/logs/daemon.log',
    'find D:/work/ffw/daemon/logs -delete',
    'find D:/work/ffw/daemon/logs -exec cat {} ;',
    'ls D:/work/ffw/daemon/logs | xargs rm',
    'node D:/work/ffw/daemon/src/machine/daemon.ts',
    'D:/work/ffw/daemon/run-daemon.ps1',
    'git -C D:/work/ffw/daemon/src checkout master',
    'tail D:/work/ffw/daemon/logs/daemon.log $(rm -rf V:/ffw/repo)',
  ]) {
    assert.equal(await decide(g, 'Bash', { command }), 'deny', command);
  }
  assert.equal(await decide(g, 'PowerShell', { command: 'Remove-Item D:\\work\\ffw\\daemon\\logs\\daemon.log' }), 'deny');
  assert.equal(await decide(g, 'PowerShell', { command: 'Set-Content D:\\work\\ffw\\daemon\\pause.json x' }), 'deny');
  // Other protected paths are still refused beside an allowed read.
  assert.equal(await decide(g, 'Bash', { command: 'tail D:/work/ffw/daemon/logs/daemon.log; cat V:/ffw/repo/x' }), 'deny');
});

test('w3670 Mac: ~/.ff-factory/logs is read; daemon.json and writes are refused', async () => {
  const g = mac();
  assert.equal(await decide(g, 'Bash', { command: 'tail -50 ~/.ff-factory/logs/daemon.log' }), 'allow', await why(g, 'Bash', { command: 'tail -50 ~/.ff-factory/logs/daemon.log' }));
  assert.equal(await decide(g, 'Bash', { command: 'tail -50 /Users/m5/.ff-factory/logs/daemon.err.log' }), 'allow');
  assert.equal(await decide(g, 'Read', { file_path: '/Users/m5/.ff-factory/logs/daemon.log' }), 'allow');
  assert.equal(await decide(g, 'Read', { file_path: '/Users/m5/.ff-factory/app/machine/daemon.ts' }), 'allow');
  assert.equal(await decide(g, 'Bash', { command: 'cat ~/.ff-factory/daemon.json' }), 'deny');
  assert.equal(await decide(g, 'Read', { file_path: '/Users/m5/.ff-factory/daemon.json' }), 'deny');
  assert.equal(await decide(g, 'Read', { file_path: '/Users/m5/ffw/secrets/machine-token' }), 'deny');
  assert.equal(await decide(g, 'Bash', { command: 'rm ~/.ff-factory/logs/daemon.log' }), 'deny');
  assert.equal(await decide(g, 'Write', { file_path: '/Users/m5/.ff-factory/logs/x', content: 'x' }), 'deny');
});

test('w3670: a command that does not name the daemon folder is not judged by it', () => {
  assert.equal(daemonShell('rm -rf V:/ffw/tmp/ffa-1/x', { dir: 'D:\\work\\ffw\\daemon', platform: 'win32', home: 'C:/Users/loth' }).named, false);
  // A sibling with the same prefix is not the daemon's folder.
  assert.equal(daemonShell('rm D:/work/ffw/daemon-old/x', { dir: 'D:\\work\\ffw\\daemon', platform: 'win32', home: 'C:/Users/loth' }).named, false);
});

test('w3670: without daemonReads the daemon folder is only a protected path, as before', async () => {
  const g = sandboxGuard({ sandboxId: 'slot3', sandboxPath: 'V:/ffw/sandboxes/slot3', protectedPaths: ['D:\\work\\ffw\\daemon'], prBase: () => undefined, evidence: () => undefined });
  assert.equal(await decide(g, 'Bash', { command: 'tail D:/work/ffw/daemon/logs/daemon.log' }), 'deny');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandOf, insistedReason, noRouteReason, nudgeKey, nudgeMessage, nudges, NUDGE_MARK, outsideFfw, routeBrief, routeKey, routeLine, routeOptions, triageRoute } from './bashNudge.ts';

/** w5914's pure rules (docs/bash-nudge.md): who is nudged, the loop guard's key, the reason, the dedup key and the triage. */

test('w5914 nudges: shells of every session but orchestrators; every other tool is asked as before', () => {
  for (const kind of ['worker', 'standing', 'ops', undefined]) {
    assert.equal(nudges(kind, 'Bash'), true, `${kind} Bash`);
    assert.equal(nudges(kind, 'PowerShell'), true, `${kind} PowerShell`);
  }
  assert.equal(nudges('orchestrator', 'Bash'), false);
  for (const tool of ['Read', 'Edit', 'Write', 'WebFetch', 'mcp__machine__unity']) assert.equal(nudges('worker', tool), false, tool);
  assert.ok(nudgeMessage('Bash').startsWith(NUDGE_MARK));
  assert.match(nudgeMessage('Bash'), /No other route: /);
});

test('w5914 loop guard key: same command with other spacing is the same; agents and commands differ', () => {
  assert.equal(commandOf({ command: '  ls   /x\n' }), 'ls /x');
  assert.equal(nudgeKey('Bash', { command: 'ls  /x' }), nudgeKey('Bash', { command: 'ls /x' }));
  assert.notEqual(nudgeKey('Bash', { command: 'ls /x' }), nudgeKey('Bash', { command: 'ls /y' }));
  assert.notEqual(nudgeKey('Bash', { command: 'ls /x' }), nudgeKey('Bash', { command: 'ls /x' }, 'sub-1'));
  assert.notEqual(nudgeKey('Bash', { command: 'ls /x' }), nudgeKey('PowerShell', { command: 'ls /x' }));
});

test('w5914 reason: from the description, else the words since the nudge; none without the phrase', () => {
  assert.equal(noRouteReason({ description: 'No other route: the build needs a second editor' }), 'the build needs a second editor');
  assert.equal(noRouteReason({ description: 'no other route - x' }), 'x');
  assert.equal(noRouteReason({ description: 'Delete it' }, 'There is no other route: only taskkill ends it'), 'only taskkill ends it');
  assert.equal(noRouteReason({ description: 'Delete it' }), undefined);
  assert.equal(noRouteReason({ description: 'No other route:' }), undefined);
  assert.match(insistedReason('rm of a variable path', 'why'), /^No other route, the worker says: why \(Claude Code asked because: rm of a variable path\)$/);
  assert.match(insistedReason(undefined, undefined), /gave no reason/);
});

test('w5914 dedup key: program and, for tools with sub-commands, the first sub-command', () => {
  assert.equal(routeKey('Bash', 'unity-slot run --label x -- make'), 'bash:unity-slot run');
  assert.equal(routeKey('Bash', 'cd /x && git push origin main'), 'bash:git push');
  assert.equal(routeKey('Bash', 'FOO=1 rm -rf "$TMPDIR/a"'), 'bash:rm');
  assert.equal(routeKey('Bash', 'rm -f /x/y'), routeKey('Bash', 'rm -rf "$TMPDIR/$S"'));
  assert.equal(routeKey('PowerShell', 'C:\\Windows\\System32\\taskkill.exe /im foo.exe'), 'powershell:taskkill');
  assert.notEqual(routeKey('Bash', 'curl x'), routeKey('Bash', 'wget x'));
  assert.equal(routeKey('Bash', 'ls -la /x'), 'bash:ls');
});

test('w5914 outsideFfw: paths in an ffw install folder pass; elsewhere, the main clone and the daemon folder do not', () => {
  assert.equal(outsideFfw('rm -rf V:/ffw/tmp/ffa-1/x'), undefined);
  assert.equal(outsideFfw('cat "D:\\work\\ffw\\sandboxes\\slot1\\a.txt"'), undefined);
  assert.equal(outsideFfw('ls ~/ffw/sandboxes'), undefined);
  assert.equal(outsideFfw('ls relative/path'), undefined);
  assert.equal(outsideFfw('rm C:/Users/ben/x'), 'C:/Users/ben/x');
  assert.equal(outsideFfw('cp a /etc/hosts'), '/etc/hosts');
  assert.equal(outsideFfw('git -C V:/ffw/repo status'), 'V:/ffw/repo');
  assert.equal(outsideFfw('cat D:/work/ffw/daemon/daemon.json'), 'D:/work/ffw/daemon/daemon.json');
});

test('w5914 triage, low risk goes ahead: a scoped command inside ffw', () => {
  const t = triageRoute('unity-slot run --label build -- make V:/ffw/sandboxes/slot1', 'a batch build needs a slot');
  assert.equal(t.path, 'go');
  assert.equal(triageRoute('rm -rf "$TMPDIR/$S"', 'a loop over leg folders').path, 'go');
});

test('w5914 triage, waits for approval: each criterion', () => {
  const cases: [string, string, string][] = [
    ['curl -s https://example.com', 'download', 'network or firewall'],
    ['netsh advfirewall firewall add rule', 'open a port', 'network or firewall'],
    ['cat ~/.ssh/id_ed25519', 'need the key', 'credentials or secrets'],
    ['gh auth token', 'need a token', 'credentials or secrets'],
    ['winget install foo', 'a tool', 'a machine-wide change'],
    ['taskkill /im Unity.exe /f', 'stuck', 'a machine-wide change'],
    ['sudo ls', 'x', 'a machine-wide change'],
    ['git commit --no-verify', 'the hook fails', 'the fences or permission rules'],
    ['echo x > .claude/settings.json', 'allow it', 'the fences or permission rules'],
  ];
  for (const [cmd, why, what] of cases) {
    const t = triageRoute(cmd, why);
    assert.equal(t.path, 'approval', cmd);
    assert.ok(t.path === 'approval' && t.why.includes(what), `${cmd}: ${JSON.stringify(t)}`);
  }
  const out = triageRoute('cp a C:/Users/ben/Desktop/b', 'copy out');
  assert.ok(out.path === 'approval' && out.why.some((w) => w.startsWith('a path outside the worker install folder')));
});

test('w5914 options: a narrow tool is recommended, except for credentials or fences, where no new route is', () => {
  const net = routeOptions({ path: 'approval', why: ['network or firewall'] });
  assert.match(net[0], /^A narrow MCP tool.*\(recommended\)$/);
  assert.equal(net.length, 3);
  const cred = routeOptions({ path: 'approval', why: ['credentials or secrets'] });
  assert.match(cred[0], /^No new route.*\(recommended: it touches credentials or secrets\)$/);
  const need = { key: 'bash:curl', toolName: 'Bash', command: 'curl x', reason: 'r', worker: 'abc "w"', requests: ['w1'] };
  assert.match(routeBrief(need, triageRoute('curl x', 'r')), /Options:\n1\. A narrow MCP tool/);
  assert.doesNotMatch(routeBrief(need, { path: 'go', why: 'ok' }), /Options:/);
  assert.match(routeBrief(need, { path: 'go', why: 'ok' }), /Route: <what workers use now/);
});

test('w5914 routeLine: the Route line of the report, else the title', () => {
  assert.equal(routeLine('DONE: w9\nRoute: mcp__machine__x with y\nLearned: no', 't'), 'mcp__machine__x with y');
  assert.equal(routeLine('DONE: w9', 'the title'), 'the title');
  assert.equal(routeLine(undefined, 'the title'), 'the title');
});

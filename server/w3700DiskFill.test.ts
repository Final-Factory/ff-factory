import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CleanupRunner, cleanupHoldFloorGB, type CleanupRun } from './cleanup.ts';
import { checkGitBashPathInPowerShell, gitBashSpelling } from './gitBashPath.ts';
import { sandboxGuard } from './guard.ts';

const GB = 1024 ** 3;

// LothDesktop, 2026-11-08: a timed run sat queued and fetching from 16:42 to 18:18 UTC; the daemon skipped every clean-up tick
// meanwhile, and V: fell from 58.6 to 14 GB free. A hold defers a pass only while the disk keeps its floor (w3700).
test('w3700: a timed run defers a clean-up pass only above disk_warn_gb + 5 GB', async () => {
  let now = Date.parse('2026-11-08T16:24:00Z');
  let free = 58 * GB;
  let timed: string | undefined = 'a timed run is in flight here';
  const passes: string[] = [];
  const said: string[] = [];
  const run: CleanupRun = { removed: [], failed: [], bytes: 0 };
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 80 }),
    fitSoftToVolume: true,
    diskPaths: () => ['V:\\ffw\\sandboxes'],
    statfs: async () => ({ free, total: 300 * GB }),
    pass: async (low) => (passes.push(low ? 'low' : 'hourly'), run),
    consumers: async () => [],
    log: () => undefined,
    done: () => undefined,
    hold: () => timed,
    holdFloorGB: () => cleanupHoldFloorGB(15),
    deferred: (why) => said.push(why),
    now: () => now,
  });
  assert.equal(cleanupHoldFloorGB(15), 20);
  assert.equal(cleanupHoldFloorGB(undefined), 20);
  assert.equal(await r.tick(), undefined, 'above the floor: the timed run defers the pass');
  assert.equal(said.length, 1);
  assert.match(said[0], /a low-space pass waits: a timed run is in flight here; it runs anyway once free space falls below 20 GB/);
  now += 30 * 60_000;
  free = 30 * GB;
  assert.equal(await r.tick(), undefined);
  assert.equal(said.length, 1, 'said once per held stretch');
  now += 30 * 60_000;
  free = 19 * GB;
  assert.equal((await r.tick())?.trigger, 'low-space', 'below the floor the pass runs, timed run or not');
  assert.deepEqual(passes, ['low']);
  free = 60 * GB;
  timed = undefined;
  now += 15 * 60_000;
  assert.equal((await r.tick())?.trigger, 'low-space', 'no hold: due as before');
  assert.deepEqual(passes, ['low', 'low']);
});

test('w3700: no hold dep keeps the old timers', async () => {
  let now = Date.parse("2026-11-08T12:00:00Z");
  const r = new CleanupRunner({
    settings: () => ({ everyMinutes: 60, softFreeGB: 20 }),
    diskPaths: () => ['/'],
    statfs: async () => ({ free: 100 * GB, total: 300 * GB }),
    pass: async () => ({ removed: [], failed: [], bytes: 0 }),
    consumers: async () => [],
    log: () => undefined,
    done: () => undefined,
    now: () => now,
  });
  assert.equal((await r.tick())?.trigger, 'hourly');
  now += 60 * 60_000;
  assert.equal((await r.tick())?.trigger, 'hourly');
});

// V:\v\ffw\tmp\ffa-48e6e232, ffa-01c194fe and ffa-4e9bffcb on LothDesktop: Git Bash's /v/ffw/... handed to PowerShell.
test('w3700: a PowerShell command naming the install folder in Git Bash spelling is refused', async () => {
  assert.equal(gitBashSpelling('V:\\ffw'), '/v/ffw');
  assert.equal(gitBashSpelling('F:/ffw/'), '/f/ffw');
  assert.equal(gitBashSpelling('/Users/m5/ffw'), undefined);
  const root = 'V:\\ffw';
  const refused = [
    'Compress-Archive -Path clips -DestinationPath /v/ffw/tmp/ffa-48e6e232/w2402-launch-clips.zip',
    'git worktree add /v/ffw/tmp/ffa-01c194fe/ffu-280 origin/main',
    "New-Item -ItemType Directory -Force '/v/ffw/tmp/ffa-4e9bffcb'",
    'python tool.py --out=/V/FFW/tmp/x',
    'cd /v/ffw',
  ];
  for (const c of refused) assert.match(checkGitBashPathInPowerShell(c, root) ?? '', /Git Bash's spelling of V:\\ffw/, c);
  const allowed = [
    'Get-ChildItem V:\\ffw\\tmp',
    'Get-ChildItem V:/ffw/tmp',
    'Invoke-WebRequest https://example.com/v/ffw/x',
    'ls /v/ffwx',
    'git log -- src/v/ffw',
  ];
  for (const c of allowed) assert.equal(checkGitBashPathInPowerShell(c, root), undefined, c);

  const guard = sandboxGuard({ sandboxId: 'lothdesktop/slot1', sandboxPath: 'V:\\ffw\\sandboxes\\slot1', protectedPaths: [], workerRoot: 'V:\\ffw', prBase: () => undefined, evidence: () => undefined });
  const decide = async (tool_name: string, command: string) => {
    const input = { hook_event_name: 'PreToolUse', tool_name, tool_input: { command }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: 'V:\\ffw\\sandboxes\\slot1' };
    const r = (await guard(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    return r.hookSpecificOutput?.permissionDecision ?? 'allow';
  };
  assert.equal(await decide('PowerShell', 'Compress-Archive -Path a -DestinationPath /v/ffw/tmp/ffa-1/a.zip'), 'deny');
  assert.equal(await decide('Bash', 'ls /v/ffw/tmp/ffa-1'), 'allow', 'Git Bash maps its own spelling');
});

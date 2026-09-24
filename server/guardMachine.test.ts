import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShell } from './guard.ts';

// Commands are assembled from parts so this file's own text is not a command.
const K = ['kill', 'pkill', 'killall'];

test('machines: agents end and relaunch Unity freely, never the daemon or claude', () => {
  const ctx = { cwd: '/Users/u/game', gameRepos: ['https://github.com/example-org/example-game.git'], remotes: () => new Map(), ownMachine: true };
  const allowed = [
    `${K[0]} -9 37897`,
    `${K[1]} -9 Unity`,
    `${K[2]} "Unity Hub"`,
    `${K[1]} -f UnityBugReporter`,
    `${K[0]} $(pgrep -f "Unity.app")`,
    `${K[2]} -9 Unity; open -a Unity`,
  ];
  for (const c of allowed) assert.equal(checkShell(c, ctx), undefined, c);
  const denied = [`${K[1]} node`, `${K[2]} claude`, `${K[1]} -f daemon.ts`, `${K[0]} $(pgrep -f ff-factory)`, 'launchctl bootout gui/501/com.fffactory.daemon'];
  for (const c of denied) assert.match(checkShell(c, ctx) ?? '', /blocked/, c);
  // On the shared host (sandboxes) the ban stays: the unity tool restarts an editor.
  assert.match(checkShell(`${K[1]} -9 Unity`, { ...ctx, ownMachine: false }) ?? '', /mcp__sandbox__unity/);
});

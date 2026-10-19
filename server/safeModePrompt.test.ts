import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEditorWindows, type MacWindow } from '../machine/macDialogs.ts';
import { MacUnity, MacUnityWatch, SAFE_MODE_STALL_MS, editorsFor, safeModePromptErrors, type Proc, type UnityDeps } from '../machine/unity.ts';
import { findDialogs } from './watchdog.ts';

const REPO = '/Users/u/games/MyGame';
const BIN = '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity';
const ERROR = "Assets\\Tests\\PlaceableUtils.cs(89,64): error CS0103: The name 'W1495MissingType' does not exist in the current context";

/**
 * The editor log of a sandbox editor waiting at "Enter Safe Mode?", cut from a real one (6000.3.19f1, lothdesktop/slot1,
 * 2026-10-18, w1495): the log stood at exactly this end (268147 bytes) for as long as the dialog was open.
 */
const AT_PROMPT = [
  'Mono: successfully reloaded assembly',
  '- Finished resetting the current domain, in  4.471 seconds',
  'Application.AssetDatabase Initial Refresh Start',
  '[Package Manager] Restoring resolved packages state from cache',
  '## Script Compilation Error for: Csc Library/Bee/artifacts/1900b0aEDbg.dag/FFEditorTests.dll (+2 others)',
  '## CmdLine: "C:\\Program Files\\Unity\\Editor\\6000.3.19f1\\Editor\\Data\\NetCoreRuntime\\dotnet.exe" exec "C:/Program Files/Unity/Editor/6000.3.19f1/Editor/Data/DotNetSdkRoslyn/csc.dll"',
  '## Output:',
  "Assets\\Tests\\Combat\\RailgunCycleTest.cs(529,22): warning CS0618: 'fp3.fp3(float3)' is obsolete: 'This method could cause precision loss and should be avoided.'",
  ERROR,
  ERROR,
  'AssetDatabase: script compilation time: 11.620425s',
  'Total cache size 268183088',
  'Total cache size after purge 268183088, took 00:00:00.7418881',
  '',
].join('\r\n');

test('safe mode prompt: the log of an editor waiting at it gives its compile errors; any other state gives nothing', () => {
  assert.deepEqual(safeModePromptErrors(AT_PROMPT), [ERROR]);
  // "Ignore" pressed: the domain loads.
  assert.equal(safeModePromptErrors(`${AT_PROMPT}Begin MonoManager ReloadAssembly\r\n`), undefined);
  // "Enter Safe Mode" pressed.
  assert.equal(safeModePromptErrors(`${AT_PROMPT}Loading Safe Mode Domain\r\n`), undefined);
  // Still compiling: no compilation time yet.
  assert.equal(safeModePromptErrors(AT_PROMPT.slice(0, AT_PROMPT.indexOf('AssetDatabase: script compilation time'))), undefined);
  // A clean compile: no prompt.
  assert.equal(safeModePromptErrors(AT_PROMPT.replace(/## Script Compilation Error for:.*\r\n/, '')), undefined);
  // It went on importing after the compile: not waiting.
  assert.equal(safeModePromptErrors(AT_PROMPT + 'Start importing Assets/a.png\r\n'.repeat(10)), undefined);
  // An editor of a session that booted long ago (its boot refresh already loaded the domain).
  assert.equal(safeModePromptErrors(`Application.AssetDatabase Initial Refresh Start\r\nBegin MonoManager ReloadAssembly\r\n${AT_PROMPT.slice(AT_PROMPT.indexOf('## Script'))}`), undefined);
  assert.equal(safeModePromptErrors(''), undefined);
});

/** A Mac with one sandbox editor whose log stands at the prompt, and a dialog watch that sees what the test says. */
function stuckEditor(opts: { locked?: boolean; seesDialog?: boolean }) {
  const world = { now: Date.parse('2026-10-18T20:00:00Z'), procs: [{ pid: 100, ppid: 1, cmd: `${BIN} -projectpath ${REPO}` }] as Proc[], log: AT_PROMPT, logAt: 0, pressed: [] as string[], wins: [] as MacWindow[] };
  world.logAt = world.now;
  if (opts.seesDialog) world.wins.push({ index: 2, title: '', subrole: 'AXDialog', text: ['Enter Safe Mode?', 'The project you are opening contains compilation errors.'], buttons: ['Enter Safe Mode', 'Ignore', 'Quit'] });
  const deps: UnityDeps = {
    procs: async () => [...world.procs],
    kill: (pid) => void (world.procs = world.procs.filter((p) => p.pid !== pid && p.ppid !== pid)),
    launch: () => 1,
    exists: () => false,
    remove: () => undefined,
    sleep: async (ms) => void (world.now += ms),
    now: () => world.now,
  };
  const reports: string[] = [];
  const u = new MacUnity(REPO, deps, () => BIN);
  const w = new MacUnityWatch(u, (t) => reports.push(t), {
    logStat: () => ({ size: world.log.length, mtimeMs: world.logAt }),
    logTail: () => world.log.slice(-16 * 1024),
    logRead: (n) => world.log.slice(-n),
    bridge: () => ({}),
    ping: async () => false,
    now: () => world.now,
    displayAsleep: async () => false,
    listDialogs: async (pid) => {
      if (opts.locked) throw new Error('execution error: Error: Error: System Events got an error: Can’t get application process. (-1728)');
      const { windows, mainTitle } = toEditorWindows(pid, world.wins);
      return { dialogs: findDialogs(windows), mainTitle };
    },
    pressButton: async (_pid, d, button) => {
      world.pressed.push(`${d.title} -> ${button}`);
      world.wins = [];
      // Ignore: Unity compiles again and loads the domain, so the log moves on.
      world.log += 'Begin MonoManager ReloadAssembly\r\n';
      world.logAt = world.now;
      return true;
    },
    sceneFilesClean: async () => true,
    nodePath: () => '/usr/local/bin/node',
    sessionState: async () => ({ locked: !!opts.locked }),
    axTrusted: async () => true,
    tccEntry: async () => undefined,
    axPrompt: async () => undefined,
  });
  return { world, w, reports };
}

test('safe mode prompt: an editor nobody can answer is closed after the stall and its errors reported, not restarted', async () => {
  const { world, w, reports } = stuckEditor({ locked: true });
  assert.equal(await w.tick(), 'ok');
  world.now += SAFE_MODE_STALL_MS - 1000;
  assert.equal(await w.tick(), 'ok', 'within the stall: the dialog watch may still answer it');
  world.now += 2000;
  assert.equal(await w.tick(), 'closed');
  assert.equal(editorsFor(world.procs, REPO).length, 0, 'the editor was closed');
  const r = reports.at(-1)!;
  assert.match(r, /stopped at its "Enter Safe Mode\?" prompt/);
  assert.match(r, /the dialog watch is paused \(the screen is locked\)/);
  assert.ok(r.includes(`these compile errors (1): ${ERROR}`), r);
  assert.match(w.describe(), /closed at Unity's "Enter Safe Mode\?" prompt 0 min ago \(the dialog watch is paused/);
  // Gone by the watch's own hand: left closed, never restarted into the same prompt.
  world.now += 10 * 60_000;
  assert.equal(await w.tick(), 'ok');
  assert.equal(editorsFor(world.procs, REPO).length, 0);
  // A new editor clears the note.
  world.procs.push({ pid: 200, ppid: 1, cmd: `${BIN} -projectpath ${REPO}` });
  world.log = 'Application.AssetDatabase Initial Refresh Start\r\n';
  world.logAt = world.now;
  await w.tick();
  assert.doesNotMatch(w.describe(), /Enter Safe Mode/);
});

test('safe mode prompt: a dialog watch that sees it presses Ignore and the editor is never closed', async () => {
  const { world, w, reports } = stuckEditor({ seesDialog: true });
  assert.equal(await w.tick(), 'ok');
  assert.deepEqual(world.pressed, ['Enter Safe Mode? -> Ignore']);
  for (let i = 0; i < 10; i++) {
    world.now += 30_000;
    assert.equal(await w.tick(), 'ok');
  }
  assert.equal(editorsFor(world.procs, REPO).length, 1);
  assert.ok(!reports.some((r) => /Enter Safe Mode/.test(r)), reports.join('\n'));
});

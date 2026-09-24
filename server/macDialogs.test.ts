import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_SCRIPT, macPermissionProblem, macWindowId, toEditorWindows, type MacWindow } from '../machine/macDialogs.ts';
import { MacUnity, MacUnityWatch, type Proc, type UnityDeps } from '../machine/unity.ts';
import { findDialogs, type Dialog } from './watchdog.ts';

const REPO = '/Users/u/games/MyGame';
const BIN = '/Applications/Unity/Hub/Editor/6000.3.19f1/Unity.app/Contents/MacOS/Unity';
const MAIN: MacWindow = { index: 1, title: 'MyGame - Main - macOS - Unity 6000.3.19f1 <Metal>', subrole: 'AXStandardWindow', text: [], buttons: [] };

/** An NSAlert as System Events shows it: no window title, the message then the informative text. */
const alert = (index: number, text: string[], buttons: string[]): MacWindow => ({ index, title: '', subrole: 'AXDialog', text, buttons });

test('mac dialogs: alerts and sheets become dialogs matched by the shared rule table', () => {
  const wins: MacWindow[] = [
    MAIN,
    { index: 2, title: 'Inspector', subrole: 'AXFloatingWindow', text: [], buttons: [] },
    alert(3, ['Repair FMOD Libraries', 'The following FMOD libraries contain incorrect line endings, and need to be repaired:'], ['Repair', 'Ignore']),
    { index: 1, sheet: 1, title: '', subrole: 'AXSheet', text: ['Addressables Build Report', "There's a new Addressables Build Report you can check out after your content build.  However, this requires that 'Debug Build Layout' is turned on."], buttons: ['Yes', 'No'] },
    alert(4, ['Hold on'], ['Cancel']), // a progress window: not a question
  ];
  const { windows, mainTitle } = toEditorWindows(42, wins);
  assert.equal(mainTitle, MAIN.title);
  const ds = findDialogs(windows);
  assert.deepEqual(
    ds.map((d) => [d.hwnd, d.title, d.known?.id]),
    [
      [300, 'Repair FMOD Libraries', 'fmod-line-endings'],
      [101, 'Addressables Build Report', 'addressables-build-report'],
    ],
  );
  assert.equal(macWindowId({ index: 7, sheet: 2 }), 702);
  assert.match(LIST_SCRIPT, /unixId: pid/);
});

test('mac dialogs: a missing privacy permission becomes the one-time step to take', () => {
  const node = '/opt/homebrew/Cellar/node/24.1.0/bin/node';
  const ax = macPermissionProblem("execution error: Error: Error: System Events got an error: osascript is not allowed assistive access. (-25211)", node);
  assert.match(ax ?? '', /Privacy & Security > Accessibility.*\/opt\/homebrew\/Cellar\/node\/24\.1\.0\/bin\/node/);
  const ae = macPermissionProblem('execution error: Error: Error: Not authorized to send Apple events to System Events. (-1743)', node);
  assert.match(ae ?? '', /Privacy & Security > Automation.*"System Events"/);
  assert.equal(macPermissionProblem('execution error: Error: Can\'t get object. (-1728)', node), undefined);
});

/** A Mac with one editor of the clone and scripted dialogs. */
function macWithDialogs() {
  const world = { now: Date.parse('2026-09-24T16:00:00Z'), procs: [{ pid: 100, ppid: 1, cmd: `${BIN} -projectpath ${REPO}` }] as Proc[], wins: [MAIN] as MacWindow[], pressed: [] as string[], clean: true, listError: '' };
  const deps: UnityDeps = {
    procs: async () => [...world.procs],
    kill: () => undefined,
    launch: () => 1,
    exists: () => false,
    remove: () => undefined,
    sleep: async (ms) => void (world.now += ms),
    now: () => world.now,
  };
  const reports: string[] = [];
  const u = new MacUnity(REPO, deps, () => BIN);
  const w = new MacUnityWatch(u, (t) => reports.push(t), {
    logStat: () => ({ size: 1, mtimeMs: world.now }),
    logTail: () => '',
    bridge: () => ({}),
    ping: async () => false,
    now: () => world.now,
    listDialogs: async (pid) => {
      if (world.listError) throw new Error(world.listError);
      const { windows, mainTitle } = toEditorWindows(pid, world.wins);
      return { dialogs: findDialogs(windows), mainTitle };
    },
    pressButton: async (_pid, d: Dialog, button) => {
      world.pressed.push(`${d.title} -> ${button}`);
      world.wins = world.wins.filter((x) => macWindowId(x) !== d.hwnd);
      return true;
    },
    sceneFilesClean: async () => world.clean,
    nodePath: () => '/usr/local/bin/node',
  });
  return { world, w, reports };
}

test('mac dialog watch: safe answers pressed, the rest reported once and shown in the status', async () => {
  const { world, w, reports } = macWithDialogs();
  world.wins.push(alert(2, ['Enter Safe Mode?', 'The project you are opening contains compilation errors.'], ['Enter Safe Mode', 'Ignore', 'Quit']));
  world.wins.push(alert(3, ['Addressables Build Report', "However, this requires that 'Debug Build Layout' is turned on."], ['Yes', 'No']));
  await w.tick();
  assert.deepEqual(world.pressed, ['Enter Safe Mode? -> Ignore', 'Addressables Build Report -> No']);
  assert.match(w.describe(), /auto-answered in the last hour: "Enter Safe Mode\?" -> Ignore/);
  // Scene backups: No only while no scene file has uncommitted changes; otherwise a person decides.
  world.clean = false;
  world.wins.push(alert(2, ['Recovering Scene Backups', 'Scene backups from a previous Editor session have been detected.'], ['Yes', 'No']));
  await w.tick();
  await w.tick();
  assert.equal(world.pressed.length, 2);
  assert.equal(reports.filter((r) => /Recovering Scene Backups/.test(r)).length, 1, 'reported once');
  assert.match(w.describe(), /blocked on a dialog: Recovering Scene Backups/);
  world.clean = true;
  await w.tick();
  assert.equal(world.pressed.at(-1), 'Recovering Scene Backups -> No');
  // Scenes changed on disk: Reload when the scene files are clean.
  world.wins.push(alert(2, ['The open scene(s) have been modified externally', 'The following open scene(s) have been changed on disk: Assets/Scenes/Main.unity Do you want to reload the scene(s)?'], ['Reload', 'Ignore']));
  await w.tick();
  assert.equal(world.pressed.at(-1), 'The open scene(s) have been modified externally -> Reload');
  // An unknown dialog: reported when it is still there on the next look, once.
  world.wins.push(alert(2, ['Something odd', 'Continue?'], ['OK', 'Cancel']));
  await w.tick();
  assert.equal(reports.filter((r) => /Something odd/.test(r)).length, 0);
  assert.match(w.describe(), /dialog \(checking\): Something odd/);
  await w.tick();
  await w.tick();
  assert.equal(reports.filter((r) => /Something odd/.test(r)).length, 1);
  // An editor waiting on a dialog is never restarted as hung, however long it waits.
  world.now += 60 * 60_000;
  assert.equal(await w.tick(), 'ok');
});

test('mac dialog watch: without Accessibility it says what to grant, once, and notices when it is fixed', async () => {
  const { world, w, reports } = macWithDialogs();
  world.listError = 'osascript is not allowed assistive access. (-25211)';
  await w.tick();
  await w.tick();
  assert.equal(reports.length, 1);
  assert.match(reports[0], /Accessibility.*\/usr\/local\/bin\/node/);
  assert.match(w.describe(), /dialog watch off: .*Accessibility/);
  world.listError = '';
  await w.tick();
  assert.match(reports.at(-1)!, /can see the editor's windows again/);
  assert.doesNotMatch(w.describe(), /dialog watch off/);
});

test('mac dialog watch: the licensing "Connection Lost" is retried, and the 4th time within 10 min gets a fresh editor', async () => {
  const { world, w, reports } = macWithDialogs();
  const lost = () => world.wins.push(alert(2, ['Connection Lost', 'The connection with the Unity Licensing Client has been lost.'], ['Retry']));
  for (let i = 0; i < 3; i++) {
    lost();
    assert.equal(await w.tick(), 'ok');
    world.now += 2 * 60_000;
  }
  assert.equal(world.pressed.filter((p) => p.endsWith('-> Retry')).length, 3);
  lost();
  assert.equal(await w.tick(), 'restarted');
  assert.match(reports.at(-1)!, /keeps showing a dialog: "Connection Lost" came back 4 times within 10 minutes/);
});

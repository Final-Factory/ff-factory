import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISMISS_LIMIT, KNOWN_DIALOGS, decide, describeDialog, findDialogs, isStalled, type EditorWindow } from './watchdog.ts';
import { editorTitleNames } from './sandboxes.ts';

const win = (w: Partial<EditorWindow>): EditorWindow => ({ hwnd: 1, pid: 100, class: '#32770', title: '', enabled: true, owned: true, text: [], buttons: [], ...w });

// What scripts/unity-windows.ps1 reported for a real editor on this host (2026-09-23): the main window,
// disabled behind a licensing dialog.
const LIVE = [
  win({ hwnd: 1054540, pid: 37072, title: 'Connection Lost', text: ['The connection with the Unity Licensing Client has been lost.'], buttons: ['Retry'] }),
  win({ hwnd: 2951788, pid: 37072, class: 'UnityContainerWndClass', title: 'agent-mcp - main - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.19f1) <DX11>', enabled: false, owned: false }),
];

test('findDialogs: picks the modal dialog, not the main window, and knows it', () => {
  const d = findDialogs(LIVE);
  assert.equal(d.length, 1);
  assert.equal(d[0].title, 'Connection Lost');
  assert.equal(d[0].known?.id, 'licensing-connection-lost');
  assert.deepEqual(decide(d[0], { autoDismiss: true }), { click: 'Retry' });
});

test('findDialogs: splash and progress windows are not dialogs', () => {
  assert.deepEqual(findDialogs([win({ title: 'Hold on...', text: ['Importing'] })]), []); // no buttons
  assert.deepEqual(findDialogs([win({ title: 'Importing', buttons: ['Cancel'] })]), []); // a cancellable progress bar
  assert.deepEqual(findDialogs([win({ class: 'UnitySplashWindow', title: 'Unity', buttons: ['OK'] })]), []);
  assert.equal(findDialogs([win({ title: 'Something', buttons: ['OK', 'Cancel'] })]).length, 1);
});

/** The dialog texts found in Unity 6000.3's Unity.dll and the game's editor code (docs/unity-dialogs.md). */
const SAMPLES: [string, string, string, string[]][] = [
  ['admin', 'Unity is running as administrator.', '', ['I wish to continue at my own risk', 'Restart Unity as a standard user']],
  [
    'fmod-line-endings',
    'Repair FMOD Libraries',
    'The following FMOD libraries contain incorrect line endings, and need to be repaired:\n\nAssets/Plugins/FMOD/platforms/mac/lib/fmodstudio.bundle\n\nDo you want to repair them now?',
    ['Repair', 'Ignore'],
  ],
  ['safe-mode', 'Enter Safe Mode?', 'The project you are opening contains compilation errors.', ['Enter Safe Mode', 'Ignore', 'Quit']],
  [
    'addressables-build-report',
    'Addressables Build Report',
    "There's a new Addressables Build Report you can check out after your content build.  However, this requires that 'Debug Build Layout' is turned on.  The setting can be found in Edit > Preferences > Addressables.  Would you like to turn it on?",
    ['Yes', 'No'],
  ],
  ['project-version', 'Project Upgrade Required', 'Your project was saved with an older Unity version (6000.0.1f1) than the one you are currently using (6000.3.19f1).', ['Continue', 'Quit']],
  ['api-updater', 'Precompiled Assemblies Update Consent Request', 'Unity found assemblies using deprecated Unity APIs in this project.', ['Yes', 'No']],
  ['corrupted-library', 'Corrupted Library Detected', 'Corrupted files in the Library prevented Unity to load your project.', ['Rebuild Library', "Don't rebuild Library"]],
  ['scene-backups', 'Recovering Scene Backups', 'Scene backups from a previous Editor session have been detected.', ['Yes', 'No']],
  ['package-manager', 'Unity Package Manager Error', 'Click on Retry to relaunch Unity and reopen your project.', ['Retry', 'Continue', 'Quit']],
  ['license', 'License error', 'No valid Unity Editor license found. Please activate your license.', ['Open Hub']],
  ['unsupported-platform', 'Unsupported Platform', 'Support for the selected build platform has been deprecated.', ['Switch Platform', 'Exit Unity']],
];

test('known dialogs: every sample matches its entry, and only the listed ones are pressed', () => {
  for (const [id, title, text, buttons] of SAMPLES) {
    const [d] = findDialogs([win({ title, text: text ? [text] : [], buttons })]);
    assert.equal(d?.known?.id, id, title);
    const v = decide(d, { autoDismiss: true });
    const expected: Record<string, string> = { 'fmod-line-endings': 'Ignore', 'safe-mode': 'Ignore', 'addressables-build-report': 'No' };
    assert.deepEqual(v, expected[id] ? { click: expected[id] } : { report: true }, title);
  }
  assert.ok(new Set(KNOWN_DIALOGS.map((k) => k.id)).size === KNOWN_DIALOGS.length, 'ids are unique');
});

test('line endings: anything mentioning them gets Ignore, never a convert or repair button', () => {
  const [d] = findDialogs([win({ title: 'Line endings', text: ['Mixed line endings in foo.ffmod. Convert them?'], buttons: ['Convert', 'Ignore'] })]);
  assert.deepEqual(decide(d, { autoDismiss: true }), { click: 'Ignore' });
  // No Ignore button: report, do not press anything else.
  const [d2] = findDialogs([win({ title: 'Line endings', text: ['Mixed line endings.'], buttons: ['Convert', 'Fix all'] })]);
  assert.deepEqual(decide(d2, { autoDismiss: true }), { report: true });
});

test('decide: accelerator ampersands match, auto-dismiss off reports, unknown dialogs report', () => {
  const [d] = findDialogs([win({ title: 'Repair FMOD Libraries', buttons: ['&Repair', '&Ignore'] })]);
  assert.deepEqual(decide(d, { autoDismiss: true }), { click: '&Ignore' });
  assert.deepEqual(decide(d, { autoDismiss: false }), { report: true });
  const [u] = findDialogs([win({ title: 'Mystery', buttons: ['OK'] })]);
  assert.equal(u.known, undefined);
  assert.deepEqual(decide(u, { autoDismiss: true }), { report: true });
});

test('decide: a dialog that keeps coming back is reported instead of pressed forever', () => {
  const [d] = findDialogs(LIVE);
  const now = Date.parse('2026-09-23T12:00:00Z');
  const at = (minAgo: number) => ({ at: new Date(now - minAgo * 60_000).toISOString(), title: 'Connection Lost' });
  const recent = Array.from({ length: DISMISS_LIMIT.count }, (_, i) => at(i + 1));
  assert.deepEqual(decide(d, { autoDismiss: true, recent, nowMs: now }), { report: true, repeated: true });
  // Old dismissals, or other dialogs, do not count.
  const old = recent.map((r) => ({ ...r, at: new Date(now - DISMISS_LIMIT.windowMs - 1000).toISOString() }));
  assert.deepEqual(decide(d, { autoDismiss: true, recent: old, nowMs: now }), { click: 'Retry' });
  assert.deepEqual(decide(d, { autoDismiss: true, recent: recent.map((r) => ({ ...r, title: 'Other' })), nowMs: now }), { click: 'Retry' });
});

test('describeDialog and isStalled', () => {
  const [d] = findDialogs(LIVE);
  assert.equal(describeDialog(d), 'Connection Lost: The connection with the Unity Licensing Client has been lost.');
  assert.equal(describeDialog({ ...d, text: 'x'.repeat(1000) }, 50).length, 50);
  assert.equal(isStalled(0, 14 * 60_000, 15), false);
  assert.equal(isStalled(0, 15 * 60_000, 15), true);
  assert.equal(isStalled(0, 999 * 60_000, 0), false, '0 turns the stall check off');
});

test('editorTitleNames: the main window title names the project, elevated or not', () => {
  const t = 'blackhole-master - main - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.19f1) <DX11>';
  assert.equal(editorTitleNames(t, 'blackhole-master'), true);
  assert.equal(editorTitleNames(`Administrator: ${t}`, 'blackhole-master'), true);
  assert.equal(editorTitleNames(t, 'blackhole'), false);
  assert.equal(editorTitleNames('blackhole-master - notes.txt - Notepad', 'blackhole-master'), false);
});

// Unity.dll 6000.3 (EditorSceneManager.cpp): the dialog a branch switch raises with a scene open.
const SCENES = win({
  title: 'The open scene(s) have been modified externally',
  text: ['The following open scene(s) have been changed on disk:\n\nAssets/Scenes/Main.unity\n\nDo you want to reload the scene(s)?'],
  buttons: ['Reload', 'Ignore'],
});
const TITLE = 'agent-mcp - Main - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.19f1) <DX11>';

test('scenes modified externally: Reload only when the app knows the scenes are clean', () => {
  const [d] = findDialogs([SCENES]);
  assert.equal(d.known?.id, 'scenes-modified');
  assert.deepEqual(decide(d, { autoDismiss: true, scenesClean: true, editorTitle: TITLE }), { click: 'Reload' });
  // Nobody checked (a worker ran git itself): the title cannot tell, so a person decides.
  assert.deepEqual(decide(d, { autoDismiss: true, editorTitle: TITLE }), { report: true });
  // A "*" in the title (some editor window has unsaved changes), or no title at all: never.
  assert.deepEqual(decide(d, { autoDismiss: true, scenesClean: true, editorTitle: TITLE.replace(' <DX11>', '* <DX11>') }), { report: true });
  assert.deepEqual(decide(d, { autoDismiss: true, scenesClean: true }), { report: true });
  assert.deepEqual(decide(d, { autoDismiss: false, scenesClean: true, editorTitle: TITLE }), { report: true });
});

test('scenes modified externally: no modified *.unity file counts as clean (git status)', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { sceneFilesUnchanged } = await import('./watchdog.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'Assets'));
  fs.writeFileSync(path.join(dir, 'Assets', 'Main.unity'), 'a');
  fs.writeFileSync(path.join(dir, 'Assets', 'A.cs'), 'a');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'x');
  fs.writeFileSync(path.join(dir, 'Assets', 'A.cs'), 'b'); // a script change does not matter
  assert.equal(await sceneFilesUnchanged(dir), true);
  fs.writeFileSync(path.join(dir, 'Assets', 'Main.unity'), 'b');
  assert.equal(await sceneFilesUnchanged(dir), false);
  assert.equal(await sceneFilesUnchanged(path.join(dir, 'nope')), false);
  // What decide() then does with it: Reload, unless the title has a "*".
  const [d] = findDialogs([SCENES]);
  assert.deepEqual(decide(d, { autoDismiss: true, scenesClean: true, editorTitle: TITLE }), { click: 'Reload' });
});

test('always-rule dialogs (FMOD, Safe Mode, Addressables build report): pressed every time they come back, reported only in a fast loop', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const at = (sAgo: number) => new Date(now - sAgo * 1000).toISOString();
  for (const [title, text, buttons, answer] of [
    ['Repair FMOD Libraries', 'The following FMOD libraries contain incorrect line endings', ['Repair', 'Ignore'], 'Ignore'],
    ['Enter Safe Mode?', 'The project you are opening contains compilation errors.', ['Enter Safe Mode', 'Ignore', 'Quit'], 'Ignore'],
    ['Addressables Build Report', "There's a new Addressables Build Report you can check out after your content build.  However, this requires that 'Debug Build Layout' is turned on.", ['Yes', 'No'], 'No'],
  ] as const) {
    const [d] = findDialogs([win({ title, text: [text], buttons: [...buttons] })]);
    const past = (ago: number[]) => ago.map((s) => ({ at: at(s), title }));
    // Five presses in the last ten minutes: an ordinary dialog would have given up at three.
    assert.deepEqual(decide(d, { autoDismiss: true, recent: past([60, 120, 240, 400, 590]), nowMs: now }), { click: answer }, title);
    // Back within 20 s of the last press: a loop.
    const loop = decide(d, { autoDismiss: true, recent: past([5, 120]), nowMs: now });
    assert.equal('report' in loop && loop.repeated, true, title);
    assert.match(('why' in loop && loop.why) || '', /within 20 s/);
    // 30 presses in the hour: a loop too; 29 is still fine, and older ones do not count.
    const every = (n: number, gap: number) => Array.from({ length: n }, (_, i) => 30 + i * gap);
    assert.equal('report' in decide(d, { autoDismiss: true, recent: past(every(30, 110)), nowMs: now }), true, title);
    assert.deepEqual(decide(d, { autoDismiss: true, recent: past(every(29, 110)), nowMs: now }), { click: answer }, title);
    assert.deepEqual(decide(d, { autoDismiss: true, recent: past(every(30, 110).map((s) => s + 3600)), nowMs: now }), { click: answer }, title);
  }
  // Dialogs without the rule keep the old limit.
  const [conn] = findDialogs([win({ title: 'Connection Lost', text: ['The connection with the Unity Licensing Client has been lost.'], buttons: ['Retry'] })]);
  const recent = [60, 120, 240].map((s) => ({ at: at(s), title: 'Connection Lost' }));
  assert.deepEqual(decide(conn, { autoDismiss: true, recent, nowMs: now }), { report: true, repeated: true });
});

test('scene backups after a crash: No when no scene file has uncommitted changes, else a person decides', () => {
  // Unity.dll 6000.3 strings.
  const [d] = findDialogs([
    win({
      title: 'Recovering Scene Backups',
      text: ['Scene backups from a previous Editor session have been detected. Your scene might have been backed up when an Editor instance did not close correctly. \n\nDo you want to copy and preserve these backups in Assets/_Recovery/?'],
      buttons: ['Yes', 'No'],
    }),
  ]);
  assert.equal(d.known?.id, 'scene-backups');
  // At startup there is no main window title yet; it is not needed here.
  assert.deepEqual(decide(d, { autoDismiss: true, sceneFilesClean: true }), { click: 'No' });
  assert.deepEqual(decide(d, { autoDismiss: true, sceneFilesClean: false }), { report: true });
  assert.deepEqual(decide(d, { autoDismiss: true }), { report: true });
  // The bridge check that allows Reload for "modified externally" does not count here: only git does.
  assert.deepEqual(decide(d, { autoDismiss: true, scenesClean: true, editorTitle: TITLE }), { report: true });
  assert.deepEqual(decide(d, { autoDismiss: false, sceneFilesClean: true }), { report: true });
});

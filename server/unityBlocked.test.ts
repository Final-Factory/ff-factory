import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unityBlockedNotices } from './unityBlocked.ts';
import { agentAnswers, checkAgentAnswer, findDialogs, KNOWN_DIALOGS, mainWindow, type EditorWindow } from './watchdog.ts';
import { editorSwitchPlan } from './switchBranch.ts';
import { sceneEvidence } from './sandboxes.ts';
import { parseNotice } from '../shared/notices.ts';
import type { UnityBlocked } from '../shared/types.ts';

const win = (w: Partial<EditorWindow>): EditorWindow => ({ hwnd: 1, pid: 100, class: '#32770', title: '', enabled: true, owned: true, text: [], buttons: [], ...w });

// What mp-r2 showed on 2026-10-03 after its worker's `git merge origin/develop` rewrote main.unity under the editor.
const SCENES = win({
  title: 'The open scene(s) have been modified externally',
  text: ['The following open scene(s) have been changed on disk:', 'Assets/Scenes/main.unity', 'Do you want to reload the scene(s)?'],
  buttons: ['&Reload', '&Ignore'],
});
const blockedOn = (w: EditorWindow): UnityBlocked => {
  const d = findDialogs([w])[0];
  return { reason: 'dialog', title: d.title, text: d.text, buttons: d.buttons, dialogId: d.known?.id, advice: d.known?.advice, since: '', resumeState: 'running' };
};

test('who answers: the scene reload question goes to the agents, with Reload and never Ignore', () => {
  assert.deepEqual(agentAnswers(blockedOn(SCENES)), { person: false, buttons: ['&Reload'] });
  const d = findDialogs([SCENES])[0];
  assert.equal(checkAgentAnswer(d, 'Reload'), undefined);
  assert.equal(checkAgentAnswer(d, 'reload'), undefined);
  assert.match(checkAgentAnswer(d, 'Ignore') ?? '', /never pressed.*overwrites the scene file/);
  assert.match(checkAgentAnswer(d, 'Save') ?? '', /has no "Save" button/);
});

test('who answers: a licence, an elevated editor or a missing Unity version needs a person; a stall a restart', () => {
  const lic = blockedOn(win({ title: 'License error', text: ['No valid Unity Editor license found.'], buttons: ['Open Hub', 'Quit'] }));
  assert.deepEqual(agentAnswers(lic), { person: true, buttons: [] });
  const admin = findDialogs([win({ title: 'Unity is running as administrator.', buttons: ['I wish to continue at my own risk', 'Restart Unity as a standard user'] })])[0];
  assert.match(checkAgentAnswer(admin, 'I wish to continue at my own risk') ?? '', /needs a person/);
  assert.deepEqual(agentAnswers({ reason: 'stalled' }), { person: false, buttons: [] });
  assert.deepEqual(agentAnswers({ reason: 'restart-limit' }), { person: true, buttons: [] });
  assert.deepEqual(agentAnswers({ reason: 'elevated' }), { person: true, buttons: [] });
  for (const id of ['admin', 'license', 'project-version']) assert.equal(KNOWN_DIALOGS.find((k) => k.id === id)?.person, true, id);
});

test('who answers: an unknown dialog goes to the agents with all its buttons; Package Manager Retry is never pressed', () => {
  assert.deepEqual(agentAnswers(blockedOn(win({ title: 'Something odd', buttons: ['OK', 'Details'] }))), { person: false, buttons: ['OK', 'Details'] });
  const upm = findDialogs([win({ title: 'Unity Package Manager Error', text: ['An error occurred while resolving packages'], buttons: ['Retry', 'Continue', 'Diagnose'] })])[0];
  assert.match(checkAgentAnswer(upm, 'Retry') ?? '', /relaunches Unity/);
  assert.equal(checkAgentAnswer(upm, 'Continue'), undefined);
});

test('[unity blocked]: the agents are asked with the exact call, nobody is sent to the desktop, the page still reads it', () => {
  const n = unityBlockedNotices('mp-r2', blockedOn(SCENES), ['w262 credits']);
  assert.equal(n.person, false);
  assert.match(n.workers ?? '', /^\[unity blocked\] Your sandbox's Unity editor \(mp-r2\) is stuck on a "The open scene\(s\) have been modified externally" dialog/);
  assert.match(n.workers ?? '', /mcp__sandbox__unity action "answer_dialog" with button "Reload", or action "restart"/);
  assert.match(n.dispatcher, /No person is needed\. Its agent\(s\) "w262 credits" were asked/);
  assert.doesNotMatch(n.dispatcher, /desktop/);
  const p = parseNotice(n.dispatcher);
  assert.equal(p.kind, 'unity-blocked');
  assert.equal((p as { sandboxId?: string }).sandboxId, 'mp-r2');
  assert.match(p.summary, /modified externally/);

  const alone = unityBlockedNotices('mp-r2', blockedOn(SCENES), []);
  assert.equal(alone.workers, undefined);
  assert.match(alone.dispatcher, /No agent is active in it: answer it yourself with the unity tool, action "answer_dialog" with button "Reload"/);

  const lic = unityBlockedNotices('sb', blockedOn(win({ title: 'License error', buttons: ['Open Hub'] })), ['w']);
  assert.equal(lic.person, true);
  assert.equal(lic.workers, undefined);
  assert.match(lic.dispatcher, /It needs a person at the desktop: tell the user \(buttons: Open Hub\)\.$/);
});

test('sceneEvidence: says why Reload was not pressed by itself', () => {
  assert.equal(sceneEvidence([], undefined, 'mp-r2 - main - Unity 6.3'), '');
  const s = sceneEvidence(['Assets/Scenes/main.unity (M)'], { at: 0, scenes: ['Assets/Scenes/main.unity'] }, undefined, 120_000);
  assert.match(s, /switch_branch saw unsaved edits in Assets\/Scenes\/main\.unity 2 min ago/);
  assert.match(s, /scene files with uncommitted changes \(git status\): Assets\/Scenes\/main\.unity \(M\)/);
  assert.match(s, /main window was not found/);
  assert.match(sceneEvidence([], undefined, 'Shader Graph* - Unity'), /"\*" in the title/);
});

test('mainWindow: the container window whose title names Unity, not a floating one listed first', () => {
  const ws = [
    win({ hwnd: 5, class: 'UnityContainerWndClass', title: '' }),
    win({ hwnd: 6, class: 'UnityContainerWndClass', title: 'mp-r2 - main - Windows, Mac, Linux - Unity 6.3 LTS (6000.3.19f1) <DX11>' }),
    win({ hwnd: 7, pid: 200, class: 'UnityContainerWndClass', title: 'other - Unity 6.3' }),
  ];
  assert.equal(mainWindow(ws, 100)?.hwnd, 6);
  assert.equal(mainWindow([ws[0]], 100)?.hwnd, 5);
  assert.equal(mainWindow(ws, 300), undefined);
});

test('switch_branch under an editor: parks only checked clean scenes, refuses everything else before git', () => {
  const clean = { playing: false, dirty: [], scenes: ['Assets/Scenes/main.unity'] };
  assert.deepEqual(editorSwitchPlan('running', clean), { park: true, discarded: [] });
  assert.deepEqual(editorSwitchPlan('running', { ...clean, scenes: [] }), { park: false, discarded: [] });
  assert.deepEqual(editorSwitchPlan('stopped', undefined), { park: false, discarded: [] });
  assert.deepEqual(editorSwitchPlan('crashed', undefined), { park: false, discarded: [] });
  const refuse = (p: ReturnType<typeof editorSwitchPlan>) => ('refuse' in p ? p.refuse : '');
  // The old behaviour switched anyway in each of these, and Unity then asked.
  assert.match(refuse(editorSwitchPlan('running', new Error('no Unity instance named mp-r2@… is connected'))), /could not check.*no Unity instance.*nothing was switched/);
  assert.match(refuse(editorSwitchPlan('running', { ...clean, dirty: ['Assets/Scenes/main.unity'] })), /unsaved scene edits.*discard_scene_edits: true/);
  assert.match(refuse(editorSwitchPlan('running', { ...clean, playing: true })), /play mode/);
  for (const st of ['starting', 'blocked', 'stopping']) assert.match(refuse(editorSwitchPlan(st, undefined)), new RegExp(`the editor is ${st}`));
  assert.deepEqual(editorSwitchPlan('running', { ...clean, dirty: ['Assets/Scenes/main.unity'] }, true), { park: true, discarded: ['Assets/Scenes/main.unity'] });
});

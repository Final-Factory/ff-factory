// w1746: a Live view's idle editor is saved and quit through the editor, or left running with the reason; never killed
// (machine/liveIdle.ts). The editor here is a fake that answers the snippets the way the real one does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DIALOG_POLL_MS, DIALOG_RESCUE_MS, EXIT_NOW_SNIPPET, INSPECT_SNIPPET, LEAVE_PLAY_SNIPPET, SAVE_AND_QUIT_SNIPPET, backupScenes, idleCloseEditor, idleReopenNote, parseLook, type IdleCloseDeps } from '../machine/liveIdle.ts';

interface FakeEditor {
  playing: boolean;
  compiling?: boolean;
  dirty: string[];
  untitled?: number;
  /** It does not quit when asked (a dialog, a hang). */
  stuck?: boolean;
  /** w1829: unfocused and idle, it takes the delayed quit but never updates, so only a quit inside a bridge call goes. */
  noUpdates?: boolean;
  /** w1829: what it is doing when asked to quit again inside a bridge call (it began compiling meanwhile). */
  laterCompiling?: boolean;
  /** The bridge does not answer. */
  noBridge?: boolean;
  /** w1829: the save-and-quit's answer is lost; 'quits': it quit before the answer went out, 'runs': it is still on. */
  answerLost?: 'quits' | 'runs';
  /** Saving leaves this scene dirty. */
  staysDirty?: string;
  inputAgoMs?: number;
}

function fakeEditor(e: FakeEditor) {
  const calls: { code: string; safetyChecks: boolean }[] = [];
  const saved: string[] = [];
  let up = true;
  let quitAsked = false;
  let clock = 0;
  const look = () => `playing=${e.playing ? 'True' : 'False'}|compiling=${e.compiling ? 'True' : 'False'}|updating=False|dirty=${e.dirty.join(';')}|untitled=${e.untitled ?? 0}`;
  const d: IdleCloseDeps = {
    bridge: async (code, o) => {
      calls.push({ code, safetyChecks: o?.safetyChecks ?? true });
      if (e.noBridge) return 'no bridge: connect ECONNREFUSED 127.0.0.1:6400';
      if (code === INSPECT_SNIPPET) return look();
      if (code === LEAVE_PLAY_SNIPPET) {
        e.playing = false;
        return 'leaving play mode';
      }
      if (code === SAVE_AND_QUIT_SNIPPET) {
        if (o?.safetyChecks !== false) return 'error: Blocked pattern detected: EditorApplication.Exit';
        if (e.playing) return 'skip: in play mode';
        if (e.untitled) return 'skip: an untitled scene has unsaved changes';
        const was = [...e.dirty];
        saved.push(...was);
        e.dirty = e.staysDirty ? [e.staysDirty] : [];
        if (e.staysDirty) return `skip: ${e.staysDirty} still has unsaved changes after saving`;
        quitAsked = true;
        if (!e.stuck && !e.noUpdates) up = false;
        if (e.answerLost === 'quits') return 'the bridge closed the connection';
        if (e.answerLost === 'runs') {
          up = true;
          return 'the editor did not answer in time (compiling, or its main thread is busy)';
        }
        return `quitting saved=${was.join(';')}`;
      }
      if (code === EXIT_NOW_SNIPPET) {
        if (o?.safetyChecks !== false) return 'error: Blocked pattern detected: EditorApplication.Exit';
        if (e.laterCompiling) return 'skip: compiling or importing';
        if (e.stuck) return 'the editor did not answer in time (compiling, or its main thread is busy)';
        up = false;
        return 'the bridge closed the connection';
      }
      return 'error: unknown snippet';
    },
    editorPids: async () => (up ? [4242] : []),
    personInputAgoMs: () => e.inputAgoMs,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { d, calls, saved, up: () => up, quitAsked: () => quitAsked };
}

test('w1746: idle in play mode with an unsaved scene: it leaves play mode, saves the scene and the assets, and quits', async () => {
  const ed = fakeEditor({ playing: true, dirty: ['Assets/Scenes/Look.unity'] });
  const r = await idleCloseEditor(ed.d, 15);
  assert.equal(r.closed, true, r.text);
  assert.deepEqual(r.saved, ['Assets/Scenes/Look.unity']);
  assert.match(r.text, /^closed \(saved Assets\/Scenes\/Look\.unity and the assets first\)$/);
  assert.deepEqual(ed.saved, ['Assets/Scenes/Look.unity'], 'no data lost: the scene was saved before the quit');
  assert.equal(ed.up(), false);
  assert.deepEqual(
    ed.calls.map((c) => [c.code === INSPECT_SNIPPET ? 'look' : c.code === LEAVE_PLAY_SNIPPET ? 'leave' : 'save+quit', c.safetyChecks]),
    [['look', true], ['leave', true], ['look', true], ['save+quit', false]],
    'the quit comes only after play mode ended, in the one snippet that saves',
  );
});

test('w1746: an untitled scene with unsaved changes: the close is skipped, nothing quits', async () => {
  const ed = fakeEditor({ playing: false, dirty: [], untitled: 1 });
  const r = await idleCloseEditor(ed.d, 15);
  assert.equal(r.closed, false);
  assert.match(r.text, /^skipped: 1 untitled scene has unsaved changes/);
  assert.equal(ed.quitAsked(), false);
  assert.ok(!ed.calls.some((c) => c.code === SAVE_AND_QUIT_SNIPPET), 'the save and quit was never sent');
});

test('w1746: a scene still dirty after saving: skipped, the editor keeps running', async () => {
  const ed = fakeEditor({ playing: false, dirty: ['Assets/Scenes/A.unity'], staysDirty: 'Assets/Scenes/A.unity' });
  const r = await idleCloseEditor(ed.d, 15);
  assert.equal(r.closed, false);
  assert.match(r.text, /^skipped: Assets\/Scenes\/A\.unity still has unsaved changes after saving$/);
  assert.equal(ed.up(), true);
});

test("w1746: an editor whose state can't be read, or that compiles: skipped", async () => {
  const none = fakeEditor({ playing: false, dirty: [], noBridge: true });
  const r = await idleCloseEditor(none.d, 15);
  assert.match(r.text, /^skipped: its state could not be read over the MCP bridge \(no bridge/);
  assert.equal(none.calls.length, 1);
  const busy = fakeEditor({ playing: false, dirty: [], compiling: true });
  assert.equal((await idleCloseEditor(busy.d, 15)).text, 'skipped: it is compiling or importing');
  assert.equal(busy.up(), true);
});

test('w1746: in play mode with a person at the computer within the idle time: skipped, play mode left alone', async () => {
  const ed = fakeEditor({ playing: true, dirty: [], inputAgoMs: 3 * 60_000 });
  const r = await idleCloseEditor(ed.d, 15);
  assert.equal(r.text, 'skipped: it is in play mode and a person used this computer 3 min ago');
  assert.ok(!ed.calls.some((c) => c.code === LEAVE_PLAY_SNIPPET));
  // An hour ago is not driving now.
  const old = fakeEditor({ playing: true, dirty: [], inputAgoMs: 60 * 60_000 });
  assert.equal((await idleCloseEditor(old.d, 15)).closed, true);
});

test('w1746: an editor that does not quit when asked is left running, never killed', async () => {
  const ed = fakeEditor({ playing: false, dirty: [], stuck: true });
  const r = await idleCloseEditor(ed.d, 15);
  assert.equal(r.closed, false);
  assert.match(r.text, /it still runs after 180 s; left running, never killed$/);
  assert.equal(ed.up(), true);
});

test('w1829: an unfocused idle editor that takes the quit but never updates is quit again inside a bridge call', async () => {
  const ed = fakeEditor({ playing: false, dirty: ['Assets/Scenes/Look.unity'], noUpdates: true });
  const r = await idleCloseEditor(ed.d, 0);
  assert.equal(r.closed, true, r.text);
  assert.deepEqual(r.saved, ['Assets/Scenes/Look.unity']);
  assert.match(r.text, /^closed \(saved Assets\/Scenes\/Look\.unity and the assets first; it quit when asked again inside a bridge call\)$/);
  assert.equal(ed.up(), false);
  const kinds = ed.calls.map((c) => [c.code === INSPECT_SNIPPET ? 'look' : c.code === SAVE_AND_QUIT_SNIPPET ? 'save+quit' : c.code === EXIT_NOW_SNIPPET ? 'exit now' : 'other', c.safetyChecks]);
  assert.deepEqual(kinds, [['look', true], ['save+quit', false], ['exit now', false]], 'asked again once, with the safety checks off');
  assert.match(EXIT_NOW_SNIPPET, /SaveScene\([\s\S]*still has unsaved changes after saving[\s\S]*EditorApplication\.Exit\(0\);/, 'it saves and checks again before it quits');
  assert.doesNotMatch(EXIT_NOW_SNIPPET, /delayCall/, 'it quits inside the call, not at an update that may not come');
});

test('w1829: one that quits by itself within the nudge time is never asked again', async () => {
  const ed = fakeEditor({ playing: false, dirty: [] });
  assert.equal((await idleCloseEditor(ed.d, 0)).closed, true);
  assert.ok(!ed.calls.some((c) => c.code === EXIT_NOW_SNIPPET));
});

test('w1829: asked again while it began compiling: left running, its quit still asked for (the mark stays)', async () => {
  const ed = fakeEditor({ playing: false, dirty: [], noUpdates: true, laterCompiling: true });
  const r = await idleCloseEditor(ed.d, 0);
  assert.equal(r.closed, false);
  assert.equal(r.quitting, true);
  assert.match(r.text, /would not quit then: compiling or importing; left running, never killed$/);
  assert.equal(ed.up(), true);
});

test('w1829: an editor that quit before its answer went out is closed (its mark stays, so the turn reopens it)', async () => {
  const ed = fakeEditor({ playing: false, dirty: ['Assets/Scenes/Look.unity'], answerLost: 'quits' });
  const r = await idleCloseEditor(ed.d, 0);
  assert.equal(r.closed, true, r.text);
  assert.match(r.text, /^closed \(its answer was lost as it quit: the bridge closed the connection; /);
  assert.deepEqual(ed.saved, ['Assets/Scenes/Look.unity'], 'it saved before it quit');
  assert.ok(!ed.calls.some((c) => c.code === EXIT_NOW_SNIPPET), 'not asked again: it is gone');
});

test('w1829: no answer and still running after the wait: skipped as before, never killed', async () => {
  const ed = fakeEditor({ playing: false, dirty: [], answerLost: 'runs' });
  const r = await idleCloseEditor(ed.d, 0);
  assert.equal(r.closed, false);
  assert.equal(r.quitting, undefined);
  assert.match(r.text, /^skipped: the editor did not take the save and quit \(the editor did not answer in time/);
  assert.equal(ed.up(), true);
});

test('w1746: the state line parses, and the reopen note says what was saved and what to do', () => {
  assert.deepEqual(parseLook('playing=True|compiling=False|updating=False|dirty=Assets/A.unity;Assets/B.unity|untitled=0'), { playing: true, compiling: false, updating: false, dirty: ['Assets/A.unity', 'Assets/B.unity'], untitled: 0 });
  assert.equal(parseLook('error: Blocked pattern'), undefined);
  const note = idleReopenNote({ at: '2026-10-22T14:05:00.000Z', minutes: 15, saved: ['Assets/A.unity'] }, 'its start is under way');
  assert.match(note, /^\[live view\] Your sandbox's Unity editor was closed at 14:05Z after 15 min/);
  assert.match(note, /It saved Assets\/A\.unity first/);
  assert.match(note, /stage it again/);
});

// w2116: BEAST's slot3 editor, closed for an exclusive ticket in the middle of an EditMode test run (2026-10-25 08:30Z),
// opened Unity's "Save Scene" dialog inside the save and the close waited on it until the editor was killed by hand.
function dialogEditor(o: { dialogFrom: 'save' | 'never' | 'briefly'; dirty: string[] }) {
  const ed = fakeEditor({ playing: false, dirty: [...o.dirty] });
  let box: string | undefined;
  let up = true;
  let seen = 0;
  let saveAt = -1;
  let gone: (() => void) | undefined;
  const rescues: { dialog: string; dirty: string[]; at: number }[] = [];
  const bridge = ed.d.bridge;
  const d: IdleCloseDeps = {
    ...ed.d,
    bridge: (code, opt) => {
      if (code === SAVE_AND_QUIT_SNIPPET) saveAt = ed.d.now();
      if (code === SAVE_AND_QUIT_SNIPPET && o.dialogFrom === 'save') {
        box = 'Save Scene [&Save / Cancel]';
        return new Promise<string>(() => {}); // the main thread sits in the dialog: no answer, ever
      }
      if (code === SAVE_AND_QUIT_SNIPPET && o.dialogFrom === 'briefly') {
        box = 'Hold on [busy]';
        return new Promise<string>((r) => (gone = () => r(bridge(code, opt))));
      }
      return bridge(code, opt);
    },
    editorPids: async () => (up && (await ed.d.editorPids()).length ? [4242] : []),
    // 'briefly': the dialog goes by itself after three looks (~6 s), and the save answers then.
    dialog: async () => {
      const now = box;
      if (box && gone && ++seen >= 3) {
        box = undefined;
        gone();
      }
      return now;
    },
    rescue: async (dialog, dirty) => {
      rescues.push({ dialog, dirty, at: ed.d.now() });
      up = false;
      box = undefined;
      return 'backed up 0.backup into Logs/bench-close-backup-x; stopped';
    },
  };
  return { d, ed, rescues, up: () => up && ed.up(), saveAt: () => saveAt };
}

test('w2116: a dirty scene closed for an exclusive ticket is saved scene by scene, then the editor quits', async () => {
  const t = dialogEditor({ dialogFrom: 'never', dirty: ['Assets/Scenes/main.unity'] });
  const r = await idleCloseEditor(t.d, 0);
  assert.equal(r.closed, true, r.text);
  assert.equal(r.forced, undefined);
  assert.deepEqual(r.saved, ['Assets/Scenes/main.unity']);
  assert.equal(t.rescues.length, 0, 'no dialog: nothing backed up or force-stopped');
  assert.match(SAVE_AND_QUIT_SNIPPET, /EditorSceneManager\.SaveScene\(UnityEngine\.SceneManagement\.SceneManager\.GetSceneByPath\(p\)\)/);
  assert.doesNotMatch(SAVE_AND_QUIT_SNIPPET, /SaveOpenScenes/, 'SaveOpenScenes opened the Save Scene picker on slot3');
});

test('w2116: a "Save Scene" dialog that holds the close up is waited out ~30 s, then the scenes are backed up and the editor force-stopped', async () => {
  const t = dialogEditor({ dialogFrom: 'save', dirty: ['Assets/Scenes/main.unity'] });
  const r = await idleCloseEditor(t.d, 0);
  assert.equal(r.closed, true, r.text);
  assert.equal(r.forced, true);
  assert.equal(t.rescues.length, 1, 'backed up and force-stopped once');
  assert.deepEqual(t.rescues[0].dirty, ['Assets/Scenes/main.unity'], 'the backup is told which scenes held unsaved changes');
  assert.equal(t.rescues[0].dialog, 'Save Scene [&Save / Cancel]');
  const waited = t.rescues[0].at - t.saveAt();
  assert.ok(waited >= DIALOG_RESCUE_MS && waited <= DIALOG_RESCUE_MS + 2 * DIALOG_POLL_MS, `rescued ${waited} ms after the save was asked for, about ${DIALOG_RESCUE_MS} ms`);
  assert.match(r.text, /^closed by force: the dialog "Save Scene \[&Save \/ Cancel\]" held it \d+ s; backed up /);
  assert.equal(t.up(), false);
  // Cancel is never pressed: the close has no way to press a button (IdleCloseDeps has none); the rescue backs up and stops.
});

test('w2116: a dialog that goes by itself within the wait is not a rescue: the close goes on and saves', async () => {
  const t = dialogEditor({ dialogFrom: 'briefly', dirty: ['Assets/Scenes/main.unity'] });
  const r = await idleCloseEditor(t.d, 0);
  assert.equal(r.closed, true, r.text);
  assert.equal(r.forced, undefined);
  assert.equal(t.rescues.length, 0);
  assert.deepEqual(r.saved, ['Assets/Scenes/main.unity']);
});

test('w2116: without dialog and rescue (the idle close) a dialog is waited out as before, never killed', async () => {
  const ed = fakeEditor({ playing: false, dirty: [], stuck: true });
  const r = await idleCloseEditor(ed.d, 0);
  assert.equal(r.closed, false);
  assert.equal(r.forced, undefined);
  assert.equal(ed.up(), true);
});

test('w2116: backupScenes keeps Unity\'s scene backups and each dirty scene file, with a note, under Logs/', () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'w2116-'));
  fs.mkdirSync(path.join(sb, 'Temp', '__Backupscenes'), { recursive: true });
  fs.writeFileSync(path.join(sb, 'Temp', '__Backupscenes', '0.backup'), 'unity backup');
  fs.mkdirSync(path.join(sb, 'Assets', 'Scenes'), { recursive: true });
  fs.writeFileSync(path.join(sb, 'Assets', 'Scenes', 'main.unity'), 'scene as saved');
  const text = backupScenes(sb, ['Assets/Scenes/main.unity', 'Assets/Scenes/Gone.unity'], 'Save Scene [&Save / Cancel]', new Date('2026-10-25T08:30:45.123Z'));
  const dir = path.join(sb, 'Logs', 'bench-close-backup-20261025T083045Z');
  assert.equal(text, 'backed up Temp/__Backupscenes/0.backup, Assets/Scenes/main.unity (as last saved) into Logs/bench-close-backup-20261025T083045Z');
  assert.equal(fs.readFileSync(path.join(dir, '__Backupscenes', '0.backup'), 'utf8'), 'unity backup');
  assert.equal(fs.readFileSync(path.join(dir, 'scenes', 'Assets', 'Scenes', 'main.unity'), 'utf8'), 'scene as saved');
  assert.match(fs.readFileSync(path.join(dir, 'README.txt'), 'utf8'), /Save Scene \[&Save \/ Cancel\].*\n.*Assets\/Scenes\/main\.unity, Assets\/Scenes\/Gone\.unity/);
});

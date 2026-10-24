// w1746: a Live view's idle editor is saved and quit through the editor, or left running with the reason; never killed
// (machine/liveIdle.ts). The editor here is a fake that answers the snippets the way the real one does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_NOW_SNIPPET, INSPECT_SNIPPET, LEAVE_PLAY_SNIPPET, SAVE_AND_QUIT_SNIPPET, idleCloseEditor, idleReopenNote, parseLook, type IdleCloseDeps } from '../machine/liveIdle.ts';

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
  assert.match(EXIT_NOW_SNIPPET, /SaveOpenScenes\(\)[\s\S]*still has unsaved changes after saving[\s\S]*EditorApplication\.Exit\(0\);/, 'it saves and checks again before it quits');
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

test('w1746: the state line parses, and the reopen note says what was saved and what to do', () => {
  assert.deepEqual(parseLook('playing=True|compiling=False|updating=False|dirty=Assets/A.unity;Assets/B.unity|untitled=0'), { playing: true, compiling: false, updating: false, dirty: ['Assets/A.unity', 'Assets/B.unity'], untitled: 0 });
  assert.equal(parseLook('error: Blocked pattern'), undefined);
  const note = idleReopenNote({ at: '2026-10-22T14:05:00.000Z', minutes: 15, saved: ['Assets/A.unity'] }, 'its start is under way');
  assert.match(note, /^\[live view\] Your sandbox's Unity editor was closed at 14:05Z after 15 min/);
  assert.match(note, /It saved Assets\/A\.unity first/);
  assert.match(note, /stage it again/);
});

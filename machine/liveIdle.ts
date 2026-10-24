// A Live view's idle editor closed (w1746, docs/live-view.md "Idle editors close"): the daemon's half. The portal decides a
// view is idle (server/liveIdle.ts) and sends `live` op idleClose; this saves what the editor has unsaved through the editor
// itself and asks it to quit, or leaves it running and says why. It never kills the process.
//
// lothsahn, 2026-10-22: "If a live view is idle for more than 15 minutes can we close it down to free the box?"

/**
 * The editor's state, as one line: `playing=<bool>|compiling=<bool>|updating=<bool>|dirty=<path;path>|untitled=<n>`.
 * `dirty` lists the open scenes with unsaved changes; `untitled` counts those never saved (saving one would ask where).
 */
export const INSPECT_SNIPPET = [
  'var dirty = new System.Collections.Generic.List<string>();',
  'int untitled = 0;',
  'for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++) {',
  '  var s = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);',
  '  if (!s.isDirty) continue;',
  '  if (string.IsNullOrEmpty(s.path)) untitled++; else dirty.Add(s.path);',
  '}',
  'return "playing=" + UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode + "|compiling=" + UnityEditor.EditorApplication.isCompiling + "|updating=" + UnityEditor.EditorApplication.isUpdating + "|dirty=" + string.Join(";", dirty) + "|untitled=" + untitled;',
].join('\n');

/** Leave play mode: the game's own session ends, and LiveLook puts every knob back (its materials are never saved). */
export const LEAVE_PLAY_SNIPPET = 'UnityEditor.EditorApplication.isPlaying = false; return "leaving play mode";';

/** The checks and the save both quits run first, on the editor's main thread: a "skip: ..." answer, or `saved` filled. */
const SAVE_LINES = [
  'if (UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode) return "skip: in play mode";',
  'if (UnityEditor.EditorApplication.isCompiling || UnityEditor.EditorApplication.isUpdating) return "skip: compiling or importing";',
  'var saved = new System.Collections.Generic.List<string>();',
  'for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++) {',
  '  var s = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);',
  '  if (!s.isDirty) continue;',
  '  if (string.IsNullOrEmpty(s.path)) return "skip: an untitled scene has unsaved changes";',
  '  saved.Add(s.path);',
  '}',
  'if (!UnityEditor.SceneManagement.EditorSceneManager.SaveOpenScenes()) return "skip: saving the open scenes failed";',
  'UnityEditor.AssetDatabase.SaveAssets();',
  'for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++) {',
  '  var s = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);',
  '  if (s.isDirty) return "skip: " + (string.IsNullOrEmpty(s.path) ? s.name : s.path) + " still has unsaved changes after saving";',
  '}',
];

/**
 * Save the open scenes and the assets, check nothing is left unsaved, then quit on the editor's next update. One snippet, on
 * the editor's main thread: nothing can change between the check and the quit. The same calls as the clean quit of a
 * person's main clone (docs/orchestrators.md, "quit its editor"). Needs the bridge's safety checks off (they refuse
 * EditorApplication.Exit). The quit waits for the editor's next update so this answer goes out first, and an unfocused,
 * idle editor may not update for minutes (w1829: BEAST's slot1 editor took it at 03:06Z on 2026-10-24 and quit at 03:15Z,
 * 10 s after a build woke it), so idleCloseEditor follows it with EXIT_NOW_SNIPPET.
 */
export const SAVE_AND_QUIT_SNIPPET = [
  ...SAVE_LINES,
  'UnityEditor.EditorApplication.delayCall += () => UnityEditor.EditorApplication.Exit(0);',
  'UnityEditor.EditorApplication.QueuePlayerLoopUpdate();',
  'return "quitting saved=" + string.Join(";", saved);',
].join('\n');

/**
 * The same checks and save, then quit at once, inside the bridge's own call (w1829). The bridge runs its calls on the main
 * thread even when the editor is unfocused and does not update (MCP for Unity's TransportCommandDispatcher posts them to the
 * main thread's SynchronizationContext), so this quits where the delayed quit waits. Its answer goes with the process; a
 * "skip: ..." answer comes back when it does not quit.
 */
export const EXIT_NOW_SNIPPET = [...SAVE_LINES, 'UnityEditor.EditorApplication.Exit(0);', 'return "exiting saved=" + string.Join(";", saved);'].join('\n');

export interface EditorLook {
  playing: boolean;
  compiling: boolean;
  updating: boolean;
  dirty: string[];
  untitled: number;
}

/** INSPECT_SNIPPET's answer, or undefined when it is not one (an error text, no bridge). */
export function parseLook(text: string): EditorLook | undefined {
  const m = /^playing=(\w+)\|compiling=(\w+)\|updating=(\w+)\|dirty=([^|]*)\|untitled=(\d+)$/.exec(text.trim());
  if (!m) return undefined;
  const yes = (s: string) => s.toLowerCase() === 'true';
  return { playing: yes(m[1]), compiling: yes(m[2]), updating: yes(m[3]), dirty: m[4] ? m[4].split(';').filter(Boolean) : [], untitled: Number(m[5]) };
}

export interface IdleCloseDeps {
  /** Runs C# in the editor through its MCP bridge; resolves its answer or an error text, never throws. */
  bridge(code: string, opts?: { safetyChecks?: boolean }): Promise<string>;
  /** The pids of this sandbox's editor processes now (none: it has quit). */
  editorPids(): Promise<number[]>;
  /** Ms since a person's last key or click on this computer (the tray's report), or undefined when none is known. */
  personInputAgoMs(): number | undefined;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface IdleCloseResult {
  closed: boolean;
  /** The scenes it saved first (asset changes are saved too, unnamed). */
  saved: string[];
  /** What happened, for the log and the portal: "closed ..." or "skipped: ...". */
  text: string;
  /** Not closed yet, but it took the save and quit and is still going (w1829: it may yet go, so its mark stays). */
  quitting?: boolean;
}

/** How long it waits for play mode to end, and for the process to go after the quit (never a kill after either). */
export const LEAVE_PLAY_WAIT_MS = 90_000;
export const QUIT_WAIT_MS = 180_000;
/** How long the delayed quit gets before EXIT_NOW_SNIPPET quits the editor inside a bridge call (w1829). */
export const QUIT_NUDGE_MS = 15_000;
/** How long an editor whose save-and-quit answer never came gets to go before it counts as not closed (w1829). */
export const ANSWER_LOST_WAIT_MS = 15_000;

/**
 * Close an idle editor without losing work: read its state (unreadable: skip), skip while it compiles or imports, or while
 * it is in play mode and a person used this computer within `minutes`; leave play mode, save the open scenes and assets
 * through the editor and quit it (an untitled dirty scene, or one still dirty after saving: skip); then wait for its
 * process to go. One that does not go is left running, never killed.
 */
export async function idleCloseEditor(d: IdleCloseDeps, minutes: number): Promise<IdleCloseResult> {
  const skip = (why: string): IdleCloseResult => ({ closed: false, saved: [], text: `skipped: ${why}` });
  const read = async () => {
    const text = await d.bridge(INSPECT_SNIPPET);
    return { look: parseLook(text), text };
  };
  let { look, text } = await read();
  if (!look) return skip(`its state could not be read over the MCP bridge (${text.slice(0, 160)})`);
  if (look.compiling || look.updating) return skip('it is compiling or importing');
  if (look.playing) {
    const ago = d.personInputAgoMs();
    if (ago !== undefined && ago < minutes * 60_000) return skip(`it is in play mode and a person used this computer ${Math.round(ago / 60_000)} min ago`);
    const left = await d.bridge(LEAVE_PLAY_SNIPPET);
    if (!/leaving play mode/.test(left)) return skip(`it would not leave play mode (${left.slice(0, 160)})`);
    const until = d.now() + LEAVE_PLAY_WAIT_MS;
    for (;;) {
      await d.sleep(2000);
      ({ look, text } = await read());
      if (look && !look.playing) break;
      if (d.now() >= until) return skip(`it did not leave play mode within ${LEAVE_PLAY_WAIT_MS / 1000} s (${look ? 'still playing' : text.slice(0, 160)})`);
    }
  }
  if (look.untitled) return skip(`${look.untitled} untitled scene${look.untitled > 1 ? 's have' : ' has'} unsaved changes (saving would ask where)`);
  const answer = await d.bridge(SAVE_AND_QUIT_SNIPPET, { safetyChecks: false });
  const q = /^quitting saved=(.*)$/.exec(answer.trim());
  if (!q && answer.startsWith('skip: ')) return skip(answer.slice(6));
  if (!q) {
    // w1829: the bridge answers from another thread after the call, and an editor that updates at once quits first: no
    // answer, yet it saved and quit (BEAST, 2026-10-24 05:54Z: slot5's editor quit cleanly 2 s after the call, its mark was
    // dropped as a skip and nothing started it again). It is closed if its process goes.
    const until = d.now() + ANSWER_LOST_WAIT_MS;
    while ((await d.editorPids()).length) {
      if (d.now() >= until) return skip(`the editor did not take the save and quit (${answer.slice(0, 160)})`);
      await d.sleep(2000);
    }
    return { closed: true, saved: [], text: `closed (its answer was lost as it quit: ${answer.slice(0, 160)}; the quit comes only after its scenes and assets are saved)` };
  }
  const saved = q[1].split(';').filter(Boolean);
  const savedText = saved.length ? `saved ${saved.join(', ')} and the assets first` : 'nothing unsaved in its scenes; assets saved';
  const start = d.now();
  let nudged = false;
  while ((await d.editorPids()).length) {
    if (d.now() >= start + QUIT_WAIT_MS) return { closed: false, quitting: true, saved, text: `skipped: asked to quit (${savedText}), it still runs after ${QUIT_WAIT_MS / 1000} s; left running, never killed` };
    if (!nudged && d.now() - start >= QUIT_NUDGE_MS) {
      // w1829: it took the quit and has not updated since (unfocused and idle): quit inside a bridge call, which runs.
      nudged = true;
      const again = (await d.bridge(EXIT_NOW_SNIPPET, { safetyChecks: false })).trim();
      // The delayed quit is still asked for and may go at its next update, so its mark stays (quitting).
      if (again.startsWith('skip: ')) return { closed: false, quitting: true, saved, text: `skipped: asked to quit (${savedText}), it still ran ${Math.round((d.now() - start) / 1000)} s later and would not quit then: ${again.slice(6)}; left running, never killed` };
    }
    await d.sleep(2000);
  }
  return { closed: true, saved, text: `closed (${savedText}${nudged ? '; it quit when asked again inside a bridge call' : ''})` };
}

/** What the Live view and the sandbox line say while the editor is closed idle. */
export function idleClosedDetail(minutes: number): string {
  return `editor closed: idle ${minutes} min; reopens on resume`;
}

/** The line a worker's next message starts with after its sandbox's editor was closed idle and is starting again. */
export function idleReopenNote(c: { at: string; minutes: number; saved?: string[] }, started: string, ownsView = true): string {
  const saved = c.saved?.length ? ` It saved ${c.saved.join(', ')} first (check git status).` : '';
  if (!ownsView) return `[live view] Your sandbox's Unity editor was closed at ${c.at.slice(11, 16)}Z after its Live view (another worker's) sat idle ${c.minutes} min (w1746).${saved} It is starting again now (${started}); mcp__machine__unity status says when it is up.`;
  return `[live view] Your sandbox's Unity editor was closed at ${c.at.slice(11, 16)}Z after ${c.minutes} min with no turn, job, check-in or viewer (w1746), to free the computer.${saved} It is starting again now (${started}). Your Live view is still up and streams again by itself once the game is back in play mode: wait for the editor (mcp__machine__unity status; start it yourself if that says stopped), then stage it again (the scene and the asset on screen in play mode, the HUD hidden, the camera where the person should look) before you answer.`;
}

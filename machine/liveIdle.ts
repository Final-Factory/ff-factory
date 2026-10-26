// A Live view's idle editor closed (w1746, docs/live-view.md "Idle editors close"): the daemon's half. The portal decides a
// view is idle (server/liveIdle.ts) and sends `live` op idleClose; this saves what the editor has unsaved through the editor
// itself and asks it to quit, or leaves it running and says why. It never kills the process.
//
// lothsahn, 2026-10-22: "If a live view is idle for more than 15 minutes can we close it down to free the box?"

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  // w2116: each named dirty scene alone: SaveOpenScenes opened Unity's "Save Scene" file picker on BEAST's slot3 editor in
  // the middle of an EditMode test run (2026-10-25 08:30Z) and the bridge call hung on it until the editor was killed.
  'foreach (var p in saved) {',
  '  if (!UnityEditor.SceneManagement.EditorSceneManager.SaveScene(UnityEngine.SceneManagement.SceneManager.GetSceneByPath(p))) return "skip: saving " + p + " failed";',
  '}',
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
  /** w2116: a modal dialog the editor shows now ("<title> [buttons]"), or undefined; read fresh at each call. */
  dialog?(): Promise<string | undefined>;
  /**
   * w2116: a dialog held the close up for DIALOG_RESCUE_MS: back up the scenes (Unity's own scene backups and the dirty
   * scenes' files), then force-stop the editor. Answers what it did. Without it a dialog is waited out, as before.
   */
  rescue?(dialog: string, dirty: string[]): Promise<string>;
}

export interface IdleCloseResult {
  closed: boolean;
  /** The scenes it saved first (asset changes are saved too, unnamed). */
  saved: string[];
  /** What happened, for the log and the portal: "closed ..." or "skipped: ...". */
  text: string;
  /** Not closed yet, but it took the save and quit and is still going (w1829: it may yet go, so its mark stays). */
  quitting?: boolean;
  /** w2116: a modal dialog held the close up; the scenes were backed up and the editor force-stopped. */
  forced?: boolean;
}

/** How long it waits for play mode to end, and for the process to go after the quit (never a kill after either). */
export const LEAVE_PLAY_WAIT_MS = 90_000;
export const QUIT_WAIT_MS = 180_000;
/** How long the delayed quit gets before EXIT_NOW_SNIPPET quits the editor inside a bridge call (w1829). */
export const QUIT_NUDGE_MS = 15_000;
/** How long an editor whose save-and-quit answer never came gets to go before it counts as not closed (w1829). */
export const ANSWER_LOST_WAIT_MS = 15_000;
/**
 * How long a modal dialog may hold a close up before the scenes are backed up and the editor is force-stopped (w2116,
 * lothsahn: "If a modal dialog still blocks the quit after about 30 s, back the unsaved scenes up first, then force-stop").
 * A dialog blocks the editor's main thread, so no bridge call can save or quit; Cancel is never pressed (it keeps the
 * editor up and the machine busy).
 */
export const DIALOG_RESCUE_MS = 30_000;
/** How often a close looks for a modal dialog while a bridge call or the quit is pending (w2116). */
export const DIALOG_POLL_MS = 2_000;

/**
 * Close an idle editor without losing work: read its state (unreadable: skip), skip while it compiles or imports, or while
 * it is in play mode and a person used this computer within `minutes`; leave play mode, save the open scenes and assets
 * through the editor and quit it (an untitled dirty scene, or one still dirty after saving: skip); then wait for its
 * process to go. One that does not go is left running, never killed.
 */
export async function idleCloseEditor(d: IdleCloseDeps, minutes: number): Promise<IdleCloseResult> {
  const skip = (why: string): IdleCloseResult => ({ closed: false, saved: [], text: `skipped: ${why}` });
  // w2116: with dialog() and rescue(), a modal dialog that holds a bridge call or the quit up for DIALOG_RESCUE_MS ends
  // the close: the scenes are backed up, then the editor is force-stopped. Cancel is never pressed.
  let dirty: string[] = [];
  let since: number | undefined;
  let forced: IdleCloseResult | undefined;
  const dialogHeld = async (): Promise<boolean> => {
    if (!d.dialog || !d.rescue) return false;
    const box = await d.dialog();
    if (!box) {
      since = undefined;
      return false;
    }
    since ??= d.now();
    if (d.now() - since < DIALOG_RESCUE_MS) return false;
    const did = await d.rescue(box, dirty);
    const until = d.now() + ANSWER_LOST_WAIT_MS;
    while ((await d.editorPids()).length && d.now() < until) await d.sleep(DIALOG_POLL_MS);
    const gone = !(await d.editorPids()).length;
    forced = gone
      ? { closed: true, forced: true, saved: [], text: `closed by force: the dialog "${box}" held it ${Math.round((d.now() - since) / 1000)} s; ${did}` }
      : { closed: false, saved: [], text: `skipped: the dialog "${box}" held it up; ${did}; it still runs` };
    return true;
  };
  /** A bridge call raced against the dialog watch: its answer, or undefined once the editor was rescued. */
  const call = async (code: string, o?: { safetyChecks?: boolean }): Promise<string | undefined> => {
    if (!d.dialog || !d.rescue) return d.bridge(code, o);
    let done = false;
    const watch = (async (): Promise<undefined> => {
      while (!done) {
        await d.sleep(DIALOG_POLL_MS);
        if (!done && (await dialogHeld())) return undefined;
      }
      return undefined;
    })();
    const answer = d.bridge(code, o).then((t) => (forced ? undefined : t));
    try {
      return await Promise.race([answer, watch.then(() => (done ? new Promise<undefined>(() => {}) : undefined))]);
    } finally {
      done = true;
    }
  };
  const read = async () => {
    const text = await call(INSPECT_SNIPPET);
    return { look: text === undefined ? undefined : parseLook(text), text: text ?? '' };
  };
  let { look, text } = await read();
  if (forced) return forced;
  if (!look) return skip(`its state could not be read over the MCP bridge (${text.slice(0, 160)})`);
  dirty = look.dirty;
  if (look.compiling || look.updating) return skip('it is compiling or importing');
  if (look.playing) {
    const ago = d.personInputAgoMs();
    if (ago !== undefined && ago < minutes * 60_000) return skip(`it is in play mode and a person used this computer ${Math.round(ago / 60_000)} min ago`);
    const left = await call(LEAVE_PLAY_SNIPPET);
    if (forced) return forced;
    if (!/leaving play mode/.test(left ?? '')) return skip(`it would not leave play mode (${(left ?? '').slice(0, 160)})`);
    const until = d.now() + LEAVE_PLAY_WAIT_MS;
    for (;;) {
      await d.sleep(2000);
      ({ look, text } = await read());
      if (forced) return forced;
      if (look && !look.playing) break;
      if (d.now() >= until) return skip(`it did not leave play mode within ${LEAVE_PLAY_WAIT_MS / 1000} s (${look ? 'still playing' : text.slice(0, 160)})`);
    }
    dirty = look.dirty;
  }
  if (look.untitled) return skip(`${look.untitled} untitled scene${look.untitled > 1 ? 's have' : ' has'} unsaved changes (saving would ask where)`);
  const answer = await call(SAVE_AND_QUIT_SNIPPET, { safetyChecks: false });
  if (forced || answer === undefined) return forced ?? skip('the save and quit was not answered');
  const q = /^quitting saved=(.*)$/.exec(answer.trim());
  if (!q && answer.startsWith('skip: ')) return skip(answer.slice(6));
  if (!q) {
    // w1829: the bridge answers from another thread after the call, and an editor that updates at once quits first: no
    // answer, yet it saved and quit (BEAST, 2026-10-24 05:54Z: slot5's editor quit cleanly 2 s after the call, its mark was
    // dropped as a skip and nothing started it again). It is closed if its process goes.
    const until = d.now() + ANSWER_LOST_WAIT_MS;
    while ((await d.editorPids()).length) {
      if (await dialogHeld()) return forced!;
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
    if (await dialogHeld()) return { ...(forced as unknown as IdleCloseResult), saved };
    if (d.now() >= start + QUIT_WAIT_MS) return { closed: false, quitting: true, saved, text: `skipped: asked to quit (${savedText}), it still runs after ${QUIT_WAIT_MS / 1000} s; left running, never killed` };
    if (!nudged && d.now() - start >= QUIT_NUDGE_MS) {
      // w1829: it took the quit and has not updated since (unfocused and idle): quit inside a bridge call, which runs.
      nudged = true;
      const again = (await call(EXIT_NOW_SNIPPET, { safetyChecks: false }))?.trim();
      if (forced) return { ...(forced as unknown as IdleCloseResult), saved };
      // The delayed quit is still asked for and may go at its next update, so its mark stays (quitting).
      if (again?.startsWith('skip: ')) return { closed: false, quitting: true, saved, text: `skipped: asked to quit (${savedText}), it still ran ${Math.round((d.now() - start) / 1000)} s later and would not quit then: ${again.slice(6)}; left running, never killed` };
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

/**
 * w2116: keep what can be kept of an editor's unsaved scenes before it is force-stopped (a modal dialog blocks its main
 * thread, so nothing can be saved through it): Unity's own crash backups of the open scenes (`Temp/__Backupscenes/*`,
 * its crash-recovery copies of modified scenes; when Unity writes them is its own, so they may lag the edits) and each dirty scene's file as last saved, into `Logs/bench-close-backup-<stamp>/` (ignored by
 * git), with a note naming the scenes and the dialog. Edits made since Unity's last backup lived only in the editor's memory
 * and cannot be kept. Answers what it kept.
 */
export function backupScenes(sbPath: string, dirty: string[], dialog: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.join(sbPath, 'Logs', `bench-close-backup-${stamp}`);
  const kept: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const unityBackups = path.join(sbPath, 'Temp', '__Backupscenes');
    if (fs.existsSync(unityBackups)) {
      fs.cpSync(unityBackups, path.join(dir, '__Backupscenes'), { recursive: true });
      kept.push(...fs.readdirSync(unityBackups).map((f) => `Temp/__Backupscenes/${f}`));
    }
    for (const scene of dirty) {
      const from = path.join(sbPath, scene);
      if (!fs.existsSync(from)) continue;
      const to = path.join(dir, 'scenes', scene);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      kept.push(`${scene} (as last saved)`);
    }
    const note = [
      `Backed up at ${at.toISOString()} before the editor was force-stopped (w2116): the dialog "${dialog}" held its close for a timed run up.`,
      `Scenes with unsaved changes: ${dirty.length ? dirty.join(', ') : 'none named'}.`,
      `__Backupscenes/ holds Unity's own backups of the open scenes (n.backup, a scene file: copy one over the scene to restore it); scenes/ holds each dirty scene as it was last saved.`,
      'Edits made after Unity last wrote its backup lived only in the editor and are gone.',
    ];
    fs.writeFileSync(path.join(dir, 'README.txt'), note.join('\n') + '\n');
  } catch (e) {
    return `backing up the scenes into ${dir} failed partway (${(e as Error).message}); kept ${kept.length ? kept.join(', ') : 'nothing'}`;
  }
  return `backed up ${kept.length ? kept.join(', ') : 'nothing (no Unity scene backups, no dirty scene files)'} into ${path.relative(sbPath, dir).split(path.sep).join('/')}`;
}

/** w2255: the `.mat` files git lists as changed in a worktree now, each with its bytes then (an uncommitted Keep, the worker's own edits). */
export type MatSnapshot = Map<string, Buffer | undefined>;

/** Runs git in a worktree; its stdout, or throws. */
export type GitRun = (cwd: string, args: string[]) => Promise<string>;

export const runGit: GitRun = (cwd, args) =>
  new Promise((resolve, reject) =>
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out))),
  );

/** The tracked `.mat` files `git status` lists as changed (modified or type-changed, staged or not), worktree-relative with `/`. */
async function changedMats(sbPath: string, git: GitRun): Promise<string[]> {
  const out = await git(sbPath, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', '*.mat']);
  const paths: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the rename's source follows
    if (/[MT]/.test(xy)) paths.push(e.slice(3));
  }
  return paths;
}

/** w2255: what the `.mat` files hold before an idle close (snapshotMats), so putBackMats can undo what the close wrote. */
export async function snapshotMats(sbPath: string, git: GitRun = runGit): Promise<MatSnapshot> {
  const snap: MatSnapshot = new Map();
  for (const p of await changedMats(sbPath, git)) {
    try {
      snap.set(p, fs.readFileSync(path.join(sbPath, p)));
    } catch {
      snap.set(p, undefined);
    }
  }
  return snap;
}

/**
 * w2255: put back every `.mat` file an idle close wrote, so no value from a Live view's knobs (or anything else held only in
 * the editor's memory) lands in the worktree without the person's Keep. The close's `AssetDatabase.SaveAssets` writes every
 * dirty material: on m5/slot2 (w2196, 2026-10-26 03:37Z) it rewrote 11, one with the view's ColorBR that nobody kept. A file
 * clean before the close goes back to git's version; one already changed before (an uncommitted Keep, the worker's edit)
 * goes back to its bytes then. What the close wrote is copied first into `Logs/live-close-backup-<stamp>/` (ignored by git),
 * so nothing is lost. Answers what it did, or undefined when the close wrote no `.mat`. Never throws.
 */
export async function putBackMats(sbPath: string, before: MatSnapshot, at: Date, git: GitRun = runGit): Promise<string | undefined> {
  let after: string[];
  try {
    after = await changedMats(sbPath, git);
  } catch (e) {
    return `could not read git status to put back the .mat files the close wrote (${(e as Error).message.slice(0, 160)})`;
  }
  const read = (p: string) => {
    try {
      return fs.readFileSync(path.join(sbPath, p));
    } catch {
      return undefined;
    }
  };
  const written = after.filter((p) => {
    if (!before.has(p)) return true;
    const was = before.get(p);
    const now = read(p);
    return !!was && !!now && !was.equals(now);
  });
  if (!written.length) return undefined;
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.join(sbPath, 'Logs', `live-close-backup-${stamp}`);
  const back: string[] = [];
  const failed: string[] = [];
  for (const p of written) {
    try {
      const now = read(p);
      if (now) {
        const to = path.join(dir, p);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, now);
      }
      const was = before.get(p);
      if (was) fs.writeFileSync(path.join(sbPath, p), was);
      else await git(sbPath, ['checkout', '--', p]);
      back.push(p);
    } catch (e) {
      failed.push(`${p} (${(e as Error).message.slice(0, 80)})`);
    }
  }
  const rel = path.relative(sbPath, dir).split(path.sep).join('/');
  return `put back ${back.length} .mat file${back.length === 1 ? '' : 's'} the close wrote (${back.join(', ')}); what it wrote is in ${rel}${failed.length ? `; could not put back ${failed.join(', ')}` : ''}`;
}

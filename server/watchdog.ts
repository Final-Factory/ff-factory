import path from 'node:path';
import { ROOT } from './config.ts';
import { isWindows, run } from './proc.ts';

/**
 * The Unity editor watchdog: sees an editor stuck on a modal dialog (or silent for too long while
 * starting), presses a safe button on the few dialogs where one exists, and otherwise reports it.
 * The pure parts are here; SandboxManager.poll() drives it. Decisions per dialog: docs/unity-dialogs.md.
 */

/** A visible top-level window of an editor (or of a process it started), as scripts/unity-windows.ps1 reports it. */
export interface EditorWindow {
  hwnd: number;
  pid: number;
  class: string;
  title: string;
  enabled: boolean;
  /** Windows reports the window "not responding" (IsHungAppWindow). */
  hung?: boolean;
  owned: boolean;
  text: string[];
  buttons: string[];
  /** A dialog by its own platform's measure (macOS: an alert window or a sheet, machine/macDialogs.ts). */
  dialog?: boolean;
}

/**
 * `onlyIf: 'scenesClean'`: press only when the scenes count as clean: the app checked over the MCP bridge
 * just before its own branch switch that none had unsaved edits, or no *.unity file in the sandbox has
 * uncommitted changes (`git status`; it cannot see edits held only in the editor, but after a branch switch
 * Reload is the right answer: Ignore and a later save would overwrite the new branch's scene). Unity's
 * title bar cannot tell: in 6000.3 its "*" comes from an editor window's hasUnsavedChanges, never from a
 * dirty scene (docs/unity-dialogs.md).
 *
 * `onlyIf: 'sceneFilesClean'`: press only when no *.unity file in the sandbox has uncommitted changes
 * (`git status`), with no title check (the dialog it guards comes up at startup, before the main window).
 *
 * `always`: a standing rule says this button is always the answer (FMOD line endings, Safe Mode, the
 * Addressables build report prompt), so the
 * watchdog never gives up after a few presses (DISMISS_LIMIT); it only stops at a true loop, when the
 * dialog comes back faster than ALWAYS_LIMIT allows.
 *
 * `singleButton`: an informational dialog of a known project tool; pressed only when its one button is
 * `button` (a second button means it is asking something). `problem`: reported instead of pressed when its
 * title or text matches `match` once the `benign` phrases (e.g. "No coverage errors") are taken out.
 */
export type DialogAction =
  | { kind: 'dismiss'; button: string; onlyIf?: 'scenesClean' | 'sceneFilesClean'; always?: true; singleButton?: true; problem?: { match: RegExp; benign?: RegExp } }
  | { kind: 'notify' };

export interface KnownDialog {
  id: string;
  /** Matched against the title and the text together. */
  match: RegExp;
  action: DialogAction;
  /** One line for people: what it means and what to do. */
  advice: string;
}

/**
 * Every dialog we know can hold an editor at startup. Strings are from Unity 6000.3's Unity.dll and
 * the game's own editor code; see docs/unity-dialogs.md for the evidence and each decision.
 * Only a button that changes nothing on disk is ever pressed automatically.
 */
export const KNOWN_DIALOGS: KnownDialog[] = [
  {
    id: 'admin',
    match: /Unity is running as administrator/i,
    action: { kind: 'notify' },
    advice:
      'the editor was started with administrator rights. Stop it and start it again once the app runs non-elevated (scripts/restart.ps1). Its "Restart Unity as a standard user" button relaunches Unity under a new process the app does not track.',
  },
  {
    id: 'fmod-line-endings',
    // Assets/Plugins/FMOD/src/Editor/EditorUtils.cs CheckMacLibraries(): a mac bundle's Info.plist checked out
    // with CRLF. Rule: anything about line endings gets "Ignore", never a convert/repair button.
    match: /Repair FMOD Libraries|line endings/i,
    action: { kind: 'dismiss', button: 'Ignore', always: true },
    advice: 'FMOD found CRLF line endings in its mac bundles; "Ignore" leaves the files alone (the rule: always Ignore).',
  },
  {
    id: 'safe-mode',
    match: /Enter Safe Mode\?|project you are opening contains compilation errors/i,
    action: { kind: 'dismiss', button: 'Ignore', always: true },
    advice:
      'the project has compile errors. "Ignore" opens the editor normally (with errors) so the MCP bridge comes up and an agent can fix them; Safe Mode would keep the bridge from loading.',
  },
  {
    id: 'addressables-build-report',
    // com.unity.addressables 2.9.1 Editor/Build/DataBuilders/BuildScriptBase.cs NotifyUserAboutBuildReport(): title
    // "Addressables Build Report", "There's a new Addressables Build Report ... requires that 'Debug Build Layout' is
    // turned on ... Would you like to turn it on?", Yes / No. Shown on a content build (a player build too) until
    // answered once; either answer sets userHasBeenInformedAboutBuildReportSettingPreBuild in the project's
    // Library/AddressablesConfig.dat, so it does not come back. Yes would make every content build write a layout report.
    match: /Addressables Build Report|'Debug Build Layout' is turned on/i,
    action: { kind: 'dismiss', button: 'No', always: true },
    advice: 'Addressables offers to turn on "Debug Build Layout" (a build report that makes content builds slower); the rule: always No.',
  },
  {
    id: 'font-coverage',
    // The game's Assets/Editor/FontCoverage.cs, menu Tools > Localization > Validate Font Coverage / Rebuild Font
    // Atlases: DisplayDialog("Font Coverage", "No coverage errors. See the Console for the full report." |
    // "<n> coverage error(s). See the Console and Localization/FontCoverageReport.txt." | "Atlases rebuilt. No
    // coverage errors." | "Atlases rebuilt, but <n> coverage error(s) remain. See the Console.", "OK").
    match: /^Font Coverage(\n|$)/,
    action: { kind: 'dismiss', button: 'OK', always: true, singleButton: true, problem: { match: /error|fail|missing/i, benign: /\bno (coverage )?errors?\b/gi } },
    advice:
      'the Font Coverage tool (Tools > Localization) finished; OK only closes its summary, and is pressed when it reports no errors. With coverage errors it waits for a person: see the Console and Localization/FontCoverageReport.txt. Agents can run the check with no dialog: Editor.FontCoverage.ValidateFontCoverageOrThrow() through execute_code (throws on errors).',
  },
  {
    id: 'licensing-connection-lost',
    match: /connection with the Unity Licensing Client has been lost/i,
    action: { kind: 'dismiss', button: 'Retry' },
    advice: 'the editor lost its licensing client; "Retry" reconnects. If it keeps coming back, the licensing client or Hub needs attention.',
  },
  {
    id: 'scenes-modified',
    // Unity.dll 6000.3, EditorSceneManager.cpp: title "The open scene(s) have been modified externally", text
    // "The following open scene(s) have been changed on disk: <paths> Do you want to reload the scene(s)?".
    match: /open scene\(s\) have been (modified externally|changed on disk)/i,
    action: { kind: 'dismiss', button: 'Reload', onlyIf: 'scenesClean' },
    advice:
      'files of scenes open in the editor changed on disk, usually because a branch was switched with the editor open. "Reload" loads the new files and throws away unsaved in-editor scene edits; "Ignore" keeps the editor\'s copy, and saving it later overwrites the branch\'s version. Save or discard the edits first, then press Reload.',
  },
  {
    id: 'project-version',
    match: /Project (Upgrade|Downgrade|Change) Required/i,
    action: { kind: 'notify' },
    advice: "the project was saved with another Unity version. Continuing would upgrade or downgrade it; check the sandbox's ProjectVersion.txt and the installed editors.",
  },
  {
    id: 'api-updater',
    match: /Update Consent Request|deprecated Unity APIs/i,
    action: { kind: 'notify' },
    advice: 'the API Updater wants to rewrite assemblies or scripts; someone has to decide.',
  },
  {
    id: 'corrupted-library',
    match: /Corrupted Library Detected/i,
    action: { kind: 'notify' },
    advice: 'the Library folder is damaged. "Rebuild Library" re-imports everything (hours); decide per sandbox.',
  },
  {
    id: 'scene-backups',
    // Unity.dll 6000.3: title "Recovering Scene Backups", text "Scene backups from a previous Editor session have been
    // detected. ... Do you want to copy and preserve these backups in Assets/_Recovery/?", buttons Yes / No.
    match: /Recovering Scene Backups|Scene backups from a previous Editor session/i,
    action: { kind: 'dismiss', button: 'No', onlyIf: 'sceneFilesClean' },
    advice:
      'an earlier editor did not close cleanly and left scene backups. "No" drops them; "Yes" copies them into Assets/_Recovery/ as untracked files. It is pressed automatically only when no scene file has uncommitted changes; here one has, so check whether the backups hold work worth keeping.',
  },
  {
    id: 'package-manager',
    match: /Unity Package Manager Error|Unity Package Manager: Manifest relocation/i,
    action: { kind: 'notify' },
    advice: 'the Package Manager failed to resolve packages ("Retry" relaunches Unity as a new process). Read the log first.',
  },
  {
    id: 'license',
    match: /No valid Unity Editor license|License error|active license/i,
    action: { kind: 'notify' },
    advice: 'Unity has no valid licence on this machine; sign in or activate it in Unity Hub.',
  },
  {
    id: 'unsupported-platform',
    match: /Unsupported Platform|build platform has been deprecated/i,
    action: { kind: 'notify' },
    advice: 'the project\'s active build target is no longer supported by this editor.',
  },
  {
    id: 'graphics-api',
    match: /Auto Graphics API/i,
    action: { kind: 'notify' },
    advice: 'Unity asks whether to switch to its new default graphics API; that changes Player Settings.',
  },
];

/** Windows that hold no one up: Unity's own main window, splash and progress windows. */
function isDialogLike(w: EditorWindow): boolean {
  if (w.class !== '#32770' && !w.dialog) return false;
  if (!w.buttons.length) return false; // progress and splash windows have no buttons to press
  // A progress bar with only a Cancel button is work in progress, not a question.
  if (w.buttons.every((b) => /^&?cancel$/i.test(b.trim()))) return false;
  return true;
}

export interface Dialog {
  hwnd: number;
  pid: number;
  title: string;
  text: string;
  buttons: string[];
  known?: KnownDialog;
}

/** The dialogs among an editor's windows, each matched against KNOWN_DIALOGS. */
export function findDialogs(windows: EditorWindow[]): Dialog[] {
  const out: Dialog[] = [];
  for (const w of windows) {
    if (!isDialogLike(w)) continue;
    const text = w.text.join('\n').trim();
    const hay = `${w.title}\n${text}`;
    out.push({ hwnd: w.hwnd, pid: w.pid, title: w.title, text, buttons: w.buttons, known: KNOWN_DIALOGS.find((k) => k.match.test(hay)) });
  }
  return out;
}

const norm = (b: string) => b.replace(/&/g, '').trim().toLowerCase();

/** A dialog that comes back this often after being dismissed is reported instead: pressing on is not helping. */
export const DISMISS_LIMIT = { count: 3, windowMs: 10 * 60_000 };

/**
 * For `always` dialogs: at most one press per minGapMs and perHour presses an hour. Coming back faster than
 * that is a stuck loop, reported like any other; slower repeats (every editor start, every reload) are
 * simply pressed again.
 */
export const ALWAYS_LIMIT = { minGapMs: 20_000, perHour: 30 };

/**
 * What to do about one dialog: press its safe button (only when auto-dismiss is on, the dialog is a
 * known dismissable one, the button is really there, and it has not already been dismissed
 * DISMISS_LIMIT times recently), or report it.
 */
export function decide(
  d: Dialog,
  opts: {
    autoDismiss: boolean;
    recent?: { at: string; title: string }[];
    nowMs?: number;
    /** The scenes count as clean: the app's own bridge check (SandboxManager.markScenesClean) or no modified *.unity file. */
    scenesClean?: boolean;
    /** No *.unity file in the sandbox has uncommitted changes (git status). */
    sceneFilesClean?: boolean;
    /** The editor's main window title; a "*" in it means some editor window has unsaved changes. */
    editorTitle?: string;
  },
): { click: string } | { report: true; repeated?: boolean; why?: string } {
  const a = d.known?.action;
  if (!opts.autoDismiss || a?.kind !== 'dismiss') return { report: true };
  if (a.onlyIf === 'scenesClean' && (!opts.scenesClean || !opts.editorTitle || opts.editorTitle.includes('*'))) return { report: true };
  if (a.onlyIf === 'sceneFilesClean' && !opts.sceneFilesClean) return { report: true };
  const button = d.buttons.find((b) => norm(b) === norm(a.button));
  if (!button) return { report: true };
  if (a.singleButton && d.buttons.length !== 1) return { report: true, why: 'it has more than one button, so it is asking something' };
  if (a.problem && a.problem.match.test(`${d.title}\n${d.text}`.replace(a.problem.benign ?? /$^/, ''))) return { report: true, why: 'it reports a problem' };
  const now = opts.nowMs ?? Date.now();
  const ago = (opts.recent ?? []).filter((r) => r.title === d.title).map((r) => now - Date.parse(r.at));
  if (a.always) {
    if (ago.some((ms) => ms < ALWAYS_LIMIT.minGapMs)) {
      return { report: true, repeated: true, why: `it came back within ${ALWAYS_LIMIT.minGapMs / 1000} s of being dismissed (a loop)` };
    }
    if (ago.filter((ms) => ms < 3_600_000).length >= ALWAYS_LIMIT.perHour) {
      return { report: true, repeated: true, why: `it was dismissed ${ALWAYS_LIMIT.perHour} times within an hour (a loop)` };
    }
    return { click: button };
  }
  if (ago.filter((ms) => ms < DISMISS_LIMIT.windowMs).length >= DISMISS_LIMIT.count) return { report: true, repeated: true };
  return { click: button };
}

/** One line for the card and the status tool: "<title>: <text>", clipped. */
export function describeDialog(d: Dialog, max = 400): string {
  const text = d.text.replace(/\s+/g, ' ').trim();
  const s = text ? `${d.title || '(untitled dialog)'}: ${text}` : d.title || '(untitled dialog)';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Whether a starting editor's log has been silent for too long. */
export function isStalled(lastGrowthMs: number, nowMs: number, stallMinutes: number): boolean {
  return stallMinutes > 0 && nowMs - lastGrowthMs >= stallMinutes * 60_000;
}

// ---------------------------------------------------------------- Windows side

const SCRIPT = path.join(ROOT, 'scripts', 'unity-windows.ps1');

function ps(args: string[]) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], { timeoutMs: 30_000 });
}

/** The visible top-level windows of these processes and their children. Empty off Windows. */
export async function listWindows(pids: number[]): Promise<EditorWindow[]> {
  if (!isWindows || !pids.length) return [];
  const r = await ps(['-Pids', pids.join(',')]);
  if (r.code !== 0) throw new Error(`unity-windows.ps1 failed (${r.code}): ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
  const out = r.stdout.trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed) ? parsed : [parsed]) as EditorWindow[];
}

/** Whether no *.unity file in the working tree at `dir` has uncommitted changes (false when git cannot tell). */
export async function sceneFilesUnchanged(dir: string): Promise<boolean> {
  const r = await run('git', ['-C', dir, 'status', '--porcelain', '--', '*.unity'], { timeoutMs: 30_000 });
  return r.code === 0 && r.stdout.trim() === '';
}

/** Press a button in a window that belongs to `pid` (or a process it started). Returns whether the window closed. */
export async function pressButton(pid: number, hwnd: number, button: string): Promise<boolean> {
  const r = await ps(['-Pids', String(pid), '-Hwnd', String(hwnd), '-Click', button]);
  if (r.code !== 0) throw new Error(`could not press "${button}": ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
  try {
    return !(JSON.parse(r.stdout.trim()) as { stillOpen: boolean }).stillOpen;
  } catch {
    return false;
  }
}

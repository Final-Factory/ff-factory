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
 *
 * `restartAfter`: pressing stops helping once it has come back that often in 10 minutes (the licensing
 * client's "Connection Lost"): the editor is force-restarted instead, within the automatic restart budget.
 */
export type DialogAction =
  | {
      kind: 'dismiss';
      button: string;
      onlyIf?: 'scenesClean' | 'sceneFilesClean';
      always?: true;
      singleButton?: true;
      problem?: { match: RegExp; benign?: RegExp };
      /** Back this many times within DISMISS_LIMIT.windowMs after being pressed: restart the editor instead (decide's `restart`). */
      restartAfter?: number;
    }
  | { kind: 'notify' };

export interface KnownDialog {
  id: string;
  /** Matched against the title and the text together. */
  match: RegExp;
  action: DialogAction;
  /** One line for people: what it means and what to do. */
  advice: string;
  /**
   * Only a person can resolve it (a licence, an elevated app, a missing Unity version): no agent is asked. Every other
   * dialog the watchdog does not answer itself goes to the sandbox's agents first (agentAnswers).
   */
  person?: true;
  /** Buttons an agent may never press through the unity tool's answer_dialog (checkAgentAnswer). */
  never?: { button: RegExp; why: string };
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
    person: true,
    never: { button: /restart unity/i, why: 'it relaunches Unity under a process the app does not track' },
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
    action: { kind: 'dismiss', button: 'Retry', always: true, restartAfter: 3 },
    advice:
      'the editor lost its licensing client; "Retry" reconnects (an always-rule). When it comes back 3 times within 10 minutes the editor is force-restarted, since a fresh editor starts a fresh licensing client; that counts toward the automatic restart limit.',
  },
  {
    id: 'scenes-modified',
    // Unity.dll 6000.3, EditorSceneManager.cpp: title "The open scene(s) have been modified externally", text
    // "The following open scene(s) have been changed on disk: <paths> Do you want to reload the scene(s)?".
    match: /open scene\(s\) have been (modified externally|changed on disk)/i,
    action: { kind: 'dismiss', button: 'Reload', onlyIf: 'scenesClean' },
    advice:
      'files of scenes open in the editor changed on disk (a branch switch, rebase, merge, reset, pull or stash with the editor open). "Reload" loads the new files and throws away unsaved in-editor scene edits. With no in-editor scene edits worth keeping, answer Reload (unity action "answer_dialog", button "Reload"), or restart the editor, which is the same. With edits you need, note them, Reload, and redo them: the editor cannot save them while it asks, and "Ignore" followed by a save would overwrite the new scene file with the old one, so Ignore is refused.',
    never: { button: /^ignore$/i, why: 'Ignore keeps the old scene in the editor, and a later save overwrites the scene file git just wrote' },
  },
  {
    id: 'project-version',
    match: /Project (Upgrade|Downgrade|Change) Required/i,
    action: { kind: 'notify' },
    advice: "the project was saved with another Unity version. Continuing would upgrade or downgrade it; check the sandbox's ProjectVersion.txt and the installed editors.",
    person: true,
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
    advice: 'the Package Manager failed to resolve packages ("Retry" relaunches Unity as a new process). Read the log first; "Continue" opens the editor without the missing packages, or fix the manifest and restart the editor.',
    never: { button: /^retry$/i, why: 'it relaunches Unity as a new process the app does not track; restart the editor with the unity tool instead' },
  },
  {
    id: 'license',
    match: /No valid Unity Editor license|License error|active license/i,
    action: { kind: 'notify' },
    advice: 'Unity has no valid licence on this machine; sign in or activate it in Unity Hub.',
    person: true,
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

/**
 * Editor windows (not dialogs: no native buttons) that a fresh editor opens by itself and that are closed without
 * pressing anything in them, like its title bar's close button. Matched on the whole window title, so Unity's main
 * window never is. Only one whose closing changes nothing on disk is listed. The machines' watch closes them
 * (machine/unity.ts); decisions: docs/unity-dialogs.md.
 */
export interface ClosableWindow {
  id: string;
  title: RegExp;
  advice: string;
}

export const CLOSABLE_WINDOWS: ClosableWindow[] = [
  {
    id: 'fmod-setup-wizard',
    // Assets/Plugins/FMOD/src/Editor/SetupWizard.cs: SetupWizardWindow.Startup() opens it at every editor start while
    // the FMOD settings' HideSetupWizard is off (GetWindow(..., "FMOD Setup Wizard").ShowUtility()). Its window has no
    // OnDisable/OnDestroy, so closing it writes nothing; only its own buttons change settings.
    title: /^FMOD Setup Wizard$/,
    advice: 'FMOD opens its Setup Wizard at every editor start while its settings say so; closing the window changes nothing (it comes back at the next start).',
  },
];

/** The windows among an editor's that CLOSABLE_WINDOWS lists (as a Dialog: `closable` set, no buttons). */
export function findClosable(windows: EditorWindow[]): (Dialog & { closable: ClosableWindow })[] {
  const out: (Dialog & { closable: ClosableWindow })[] = [];
  for (const w of windows) {
    const c = CLOSABLE_WINDOWS.find((k) => k.title.test(w.title.trim()));
    if (c) out.push({ hwnd: w.hwnd, pid: w.pid, title: w.title.trim(), text: '', buttons: [], closable: c });
  }
  return out;
}

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
): { click: string } | { report: true; repeated?: boolean; why?: string } | { restart: true; why: string } {
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
    const lately = ago.filter((ms) => ms < DISMISS_LIMIT.windowMs).length;
    if (a.restartAfter && lately >= a.restartAfter) {
      return { restart: true, why: `"${d.title || 'the dialog'}" came back ${lately + 1} times within ${DISMISS_LIMIT.windowMs / 60_000} minutes; pressing ${a.button} is not fixing it` };
    }
    const loop = alwaysLoop(ago);
    return loop ? { report: true, repeated: true, why: loop } : { click: button };
  }
  if (ago.filter((ms) => ms < DISMISS_LIMIT.windowMs).length >= DISMISS_LIMIT.count) return { report: true, repeated: true };
  return { click: button };
}

/**
 * Who resolves a stuck editor the watchdog did not answer itself: its agents, through the unity tool (answer_dialog
 * with one of `buttons`, or a restart), unless the dialog is one only a person can resolve (`person`). A startup stall
 * is the agents' too: a restart is the answer. Only the automatic restart limit, an elevated editor and the `person`
 * dialogs need someone at the desktop.
 */
export function agentAnswers(b: { reason: string; dialogId?: string; buttons?: string[] }): { person: boolean; buttons: string[] } {
  if (b.reason === 'stalled') return { person: false, buttons: [] };
  if (b.reason !== 'dialog') return { person: true, buttons: [] };
  const known = KNOWN_DIALOGS.find((k) => k.id === b.dialogId);
  if (known?.person) return { person: true, buttons: [] };
  return { person: false, buttons: (b.buttons ?? []).filter((x) => !known?.never?.button.test(norm(x))) };
}

/** Why an agent may not press `button` in this dialog through answer_dialog, or undefined when it may. */
export function checkAgentAnswer(d: Pick<Dialog, 'title' | 'buttons' | 'known'>, button: string): string | undefined {
  const name = `"${d.title || 'the dialog'}"`;
  const real = d.buttons.find((b) => norm(b) === norm(button));
  if (!real) return `${name} has no "${button}" button (its buttons: ${d.buttons.map((b) => `"${norm(b)}"`).join(', ') || 'none'})`;
  if (d.known?.person) return `${name} needs a person: ${d.known.advice}`;
  if (d.known?.never?.button.test(norm(real))) return `"${norm(real)}" is never pressed in ${name}: ${d.known.never.why}`;
  return undefined;
}

/** Unity's main window among an editor's windows: its own UnityContainerWndClass window whose title names Unity, else its first one. */
export function mainWindow(windows: EditorWindow[], pid: number): EditorWindow | undefined {
  const own = windows.filter((w) => w.pid === pid && w.class === 'UnityContainerWndClass');
  return own.find((w) => /\bUnity\b/.test(w.title)) ?? own[0];
}

/** Why an always-answered window coming back after these many ms since each earlier answer is a loop, or undefined (ALWAYS_LIMIT). */
function alwaysLoop(ago: number[]): string | undefined {
  if (ago.some((ms) => ms < ALWAYS_LIMIT.minGapMs)) return `it came back within ${ALWAYS_LIMIT.minGapMs / 1000} s of being dismissed (a loop)`;
  if (ago.filter((ms) => ms < 3_600_000).length >= ALWAYS_LIMIT.perHour) return `it was dismissed ${ALWAYS_LIMIT.perHour} times within an hour (a loop)`;
  return undefined;
}

/** Whether to close a CLOSABLE_WINDOWS window now: always, unless it keeps coming back (the always-rule limits). */
export function decideClose(d: Pick<Dialog, 'title'>, recent: { at: string; title: string }[] = [], nowMs = Date.now()): { close: true } | { report: true; why: string } {
  const loop = alwaysLoop(recent.filter((r) => r.title === d.title).map((r) => nowMs - Date.parse(r.at)));
  return loop ? { report: true, why: loop } : { close: true };
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
  return parsePsJson<EditorWindow>(r.stdout, 'unity-windows.ps1');
}

/**
 * Raw control characters (U+0000-U+001F) inside JSON strings, escaped as \u00XX. Windows PowerShell 5.1's
 * ConvertTo-Json lets some through from window titles and command lines, and JSON.parse refuses them ("Bad
 * control character in string literal", LothDesktop's Unity watch, 2026-09-29).
 */
export function escapeControlInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const hex = () => `u${code.toString(16).padStart(4, '0')}`;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
    } else if (escaped) {
      escaped = false;
      // A backslash followed by a raw control character: the escape becomes \u00XX, the character itself.
      out += code < 0x20 ? hex() : ch;
    } else if (ch === '\\') {
      escaped = true;
      out += ch;
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else out += code < 0x20 ? `\\${hex()}` : ch;
  }
  return out;
}

/** The top-level elements of a JSON array, as text (strings respected), or undefined when `text` is not one. */
function arrayElements(text: string): string[] | undefined {
  const t = text.trim();
  if (!t.startsWith('[')) return undefined;
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = 1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        if (t.slice(start, i).trim()) out.push(t.slice(start, i));
        return out;
      }
    } else if (ch === ',' && depth === 1) {
      out.push(t.slice(start, i));
      start = i + 1;
    }
  }
  // Cut off before its end (a truncated output): what was complete is still worth reading.
  if (t.slice(start).trim()) out.push(t.slice(start));
  return out;
}

/**
 * A PowerShell ConvertTo-Json listing (an array, or one object), tolerant of what Windows PowerShell 5.1 emits: raw
 * control characters in strings are escaped, and when the whole still does not parse, each entry is read on its own
 * and the unreadable ones are skipped and logged, so one odd window title or command line does not fail the watch.
 */
export function parsePsJson<T>(text: string, what: string, log: (line: string) => void = (l) => console.warn(l)): T[] {
  const t = text.trim();
  if (!t) return [];
  const list = (v: unknown) => (Array.isArray(v) ? v : [v]) as T[];
  try {
    return list(JSON.parse(escapeControlInStrings(t)));
  } catch (e) {
    const parts = arrayElements(t);
    if (!parts) throw new Error(`${what}: unreadable output (${(e as Error).message})`);
    const good: T[] = [];
    for (const p of parts) {
      try {
        good.push(JSON.parse(escapeControlInStrings(p)) as T);
      } catch {
        // skipped below
      }
    }
    log(`${what}: skipped ${parts.length - good.length} unreadable of ${parts.length} entries (${(e as Error).message})`);
    return good;
  }
}

/** Whether no *.unity file in the working tree at `dir` has uncommitted changes (false when git cannot tell). */
export async function sceneFilesUnchanged(dir: string): Promise<boolean> {
  return (await modifiedSceneFiles(dir))?.length === 0;
}

/** The *.unity files in the working tree at `dir` with uncommitted changes (git status), or undefined when git cannot tell. */
export async function modifiedSceneFiles(dir: string): Promise<string[] | undefined> {
  const r = await run('git', ['-C', dir, 'status', '--porcelain', '--', '*.unity'], { timeoutMs: 30_000 });
  if (r.code !== 0) return undefined;
  return r.stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => `${l.slice(3)} (${l.slice(0, 2).trim()})`);
}

/**
 * Close a window that belongs to `pid` (or a process it started) and still has the title `title`, as its title bar's
 * close button does (WM_CLOSE). Returns whether it closed.
 */
export async function closeWindow(pid: number, hwnd: number, title: string): Promise<boolean> {
  const r = await ps(['-Pids', String(pid), '-Hwnd', String(hwnd), '-Close', '-Title', title]);
  if (r.code !== 0) throw new Error(`could not close "${title}": ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
  try {
    return !(JSON.parse(r.stdout.trim()) as { stillOpen: boolean }).stillOpen;
  } catch {
    return false;
  }
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

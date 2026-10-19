// A machine's pause, kept by its daemon (w1532, docs/machines.md "Pausing a machine"): the settings and the events that
// machine/pauseRules.ts combines, kept in <app_dir>/pause.json so a daemon restart or update keeps a pause, a schedule and
// a person's 90 minutes. It tells the portal (a `pause` report, and in every hello) and the tray app what holds now.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileDurable } from '../server/durable.ts';
import { DEFAULT_PAUSE_SETTINGS, SUPPRESS_SECONDS, cleanSettings, nextChangeAt, pauseState, personInput, settingsChanged, trayCommand, type PauseMemory } from './pauseRules.ts';
import type { MachinePause, MachinePauseSettings } from '../shared/types.ts';

export const pauseFile = (appDir: string) => path.join(appDir, 'pause.json');
/** 2 (w1574): the activity pause is off unless turned on; a file without it had it on by default. */
const PAUSE_FILE_VERSION = 2;

/** Look again at least this often (a clock change, a missed timer); a schedule edge or a person's 90 minutes is looked at when due. */
const LOOK_EVERY_MS = 60_000;
/** A person's input is logged at most this often while it keeps coming (the first after a quiet minute, and any that pauses). */
const INPUT_LOG_GAP_MS = 60_000;

export interface PauseKeeperDeps {
  file: string;
  now?: () => number;
  log: (line: string) => void;
  /** The state changed (paused or running, why, or until when): told to the portal and the tray. */
  changed: (p: MachinePause) => void;
}

export class PauseKeeper {
  private settings: MachinePauseSettings = DEFAULT_PAUSE_SETTINGS;
  private mem: PauseMemory = {};
  private last?: MachinePause;
  private timer?: NodeJS.Timeout;
  private lastInputLog = 0;
  private trayStatus = 'not started';
  /** pause.json was from before w1574 and its activity pause on: turned off at load, said at start and saved. */
  private migrated = false;
  private readonly now: () => number;

  private readonly d: PauseKeeperDeps;

  constructor(d: PauseKeeperDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    try {
      const j = JSON.parse(fs.readFileSync(d.file, 'utf8')) as { v?: number; settings?: unknown; memory?: PauseMemory };
      this.settings = cleanSettings(j.settings);
      // A pause.json from before w1574 had the activity pause on by default: off on every machine once (lothsahn), then the
      // portal's machines.activityPause or the tray's own choice.
      if ((j.v ?? 1) < PAUSE_FILE_VERSION && this.settings.activity.enabled) {
        this.settings = { ...this.settings, activity: { ...this.settings.activity, enabled: false } };
        this.migrated = true;
      }
      const m = j.memory ?? {};
      this.mem = {
        ...(m.manual && typeof m.manual.at === 'number' ? { manual: { paused: m.manual.paused === true, at: m.manual.at } } : {}),
        ...(typeof m.inputAt === 'number' ? { inputAt: m.inputAt } : {}),
        ...(typeof m.ignoreUntil === 'number' ? { ignoreUntil: m.ignoreUntil } : {}),
      };
    } catch {
      // No file yet (or unreadable): the defaults, no schedule, the activity pause off (w1574).
    }
    this.last = this.state();
  }

  /** What holds now, with the settings and the tray's status: what the portal and the tray are told. */
  state(): MachinePause {
    const now = this.now();
    return { ...pauseState(this.settings, this.mem, now), settings: this.settings, tray: this.trayStatus, at: new Date(now).toISOString() };
  }

  get paused() {
    return this.last?.paused === true;
  }

  current(): MachinePause {
    return this.last ?? this.state();
  }

  currentSettings(): MachinePauseSettings {
    return this.settings;
  }

  start() {
    if (this.migrated) {
      const { inputAt: _, ...rest } = this.mem;
      this.mem = rest;
      this.last = this.state();
      this.d.log('pause: the activity pause is now off on this machine (w1574: off unless config machines.activityPause.enabled or the tray turns it on)');
      this.save();
      this.migrated = false;
    }
    this.d.log(`pause: ${this.describe(this.current())}; ${this.activityText()} (settings in ${this.d.file})`);
    this.schedule();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The tray's Pause or Unpause. */
  command(paused: boolean) {
    this.mem = trayCommand(this.mem, paused, this.now());
    this.d.log(paused ? 'pause: Pause from the tray' : `pause: Unpause from the tray: a person's input is ignored until ${new Date(this.mem.ignoreUntil!).toISOString()}`);
    this.save();
    this.look(true);
  }

  /** A person's key or click (the tray sends only input no program injected). */
  input(kind: string, at: number) {
    const now = this.now();
    // The tray's clock is this computer's: an input "from the future" is taken as now.
    const when = Number.isFinite(at) && at <= now + 5000 ? Math.min(at, now) : now;
    if (!this.settings.activity.enabled) {
      // Off (w1574, the default): a person's input is not even kept, so turning it on later starts from no input.
      if (now - this.lastInputLog >= INPUT_LOG_GAP_MS) {
        this.lastInputLog = now;
        this.d.log(`pause: a person's ${kind} at ${new Date(when).toISOString()} ignored: the activity pause is off on this machine (config machines.activityPause.enabled)`);
      }
      return;
    }
    const before = this.mem;
    this.mem = personInput(this.mem, when);
    const counted = this.mem !== before;
    if (!counted && before.ignoreUntil !== undefined && when < before.ignoreUntil) this.d.log(`pause: a person's ${kind} at ${new Date(when).toISOString()} ignored: inside the ${SUPPRESS_SECONDS} s after the tray's Unpause`);
    if (!counted) return;
    this.save();
    const wasPaused = this.paused;
    this.look();
    if (now - this.lastInputLog >= INPUT_LOG_GAP_MS || (!wasPaused && this.paused)) {
      this.lastInputLog = now;
      this.d.log(`pause: a person's ${kind} at ${new Date(when).toISOString()} (not injected by a program)`);
    }
  }

  /** Input programs injected (SendInput, keybd_event, mouse_event): never a person, counted for the log. */
  injected(keys: number, clicks: number) {
    this.d.log(`pause: ignored ${keys} injected key press(es) and ${clicks} injected click(s) in the last minute: programs' input (an agent driving the game, a test), not a person`);
  }

  /** New settings from the tray. Returns the activity pause when the tray changed it (the daemon tells the portal, w1574). */
  setSettings(raw: unknown, from = 'the tray'): MachinePauseSettings['activity'] | undefined {
    const next = cleanSettings(raw);
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return undefined;
    const activityMoved = JSON.stringify(next.activity) !== JSON.stringify(this.settings.activity);
    this.mem = settingsChanged(this.settings, this.mem, this.now());
    // Off: the input it kept is dropped, so turning it on again does not pause at once for a key pressed while it was off.
    if (!next.activity.enabled && this.mem.inputAt !== undefined) {
      const { inputAt: _, ...rest } = this.mem;
      this.mem = rest;
    }
    this.settings = next;
    this.d.log(`pause: settings changed from ${from}: ${JSON.stringify(next)}${activityMoved ? `; ${this.activityText()}` : ''}`);
    this.save();
    this.look(true);
    return activityMoved ? next.activity : undefined;
  }

  /** The portal's machines.activityPause for this machine (w1574): the activity pause on or off, and its idle minutes. */
  setActivity(a: { enabled: boolean; idleMinutes: number }) {
    this.setSettings({ ...this.settings, activity: { enabled: a.enabled === true, idleMinutes: a.idleMinutes } }, 'the portal (machines.activityPause)');
  }

  /** "the activity pause is off" / "... on (90 min idle)", for the log. */
  activityText() {
    const a = this.settings.activity;
    return a.enabled ? `the activity pause is on (a person's key or click pauses work until ${a.idleMinutes} min idle)` : "the activity pause is off (a person's input never pauses work)";
  }

  /** The tray app's status changed ("running", "not started: …"): the portal shows it. */
  setTray(status: string) {
    if (status === this.trayStatus) return;
    this.trayStatus = status;
    this.look(true);
  }

  /** Look again now; tell the portal and the tray when it changed (or always, `force`). */
  look(force = false) {
    const p = this.state();
    const was = this.last;
    const moved = !was || was.paused !== p.paused || was.reason !== p.reason || was.until !== p.until || was.since !== p.since;
    this.last = p;
    if (moved && (!was || was.paused !== p.paused || was.reason !== p.reason)) this.d.log(`pause: ${this.describe(p)}`);
    if (moved || force) this.d.changed(p);
    this.schedule();
  }

  private describe(p: MachinePause) {
    return `${p.paused ? 'PAUSED' : 'RUNNING'}${p.reason ? ` (${p.reason})` : ''}: ${p.detail}`;
  }

  private schedule() {
    clearTimeout(this.timer);
    const now = this.now();
    const due = nextChangeAt(this.settings, this.mem, now);
    const wait = Math.max(250, Math.min(LOOK_EVERY_MS, due !== undefined ? due - now + 50 : LOOK_EVERY_MS));
    this.timer = setTimeout(() => this.look(), wait);
    this.timer.unref?.();
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
      writeFileDurable(this.d.file, `${JSON.stringify({ v: PAUSE_FILE_VERSION, settings: this.settings, memory: this.mem }, null, 2)}\n`);
    } catch (e) {
      this.d.log(`pause: could not save ${this.d.file}: ${(e as Error).message}`);
    }
  }
}

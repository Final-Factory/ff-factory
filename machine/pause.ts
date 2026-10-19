// A machine's pause, kept by its daemon (w1532, docs/machines.md "Pausing a machine"): the settings and the events that
// machine/pauseRules.ts combines, kept in <app_dir>/pause.json so a daemon restart or update keeps a pause, a schedule and
// a person's 90 minutes. It tells the portal (a `pause` report, and in every hello) and the tray app what holds now.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileDurable } from '../server/durable.ts';
import { DEFAULT_PAUSE_SETTINGS, SUPPRESS_SECONDS, cleanSettings, nextChangeAt, pauseState, personInput, settingsChanged, trayCommand, type PauseMemory } from './pauseRules.ts';
import type { MachinePause, MachinePauseSettings } from '../shared/types.ts';

export const pauseFile = (appDir: string) => path.join(appDir, 'pause.json');

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
  private readonly now: () => number;

  private readonly d: PauseKeeperDeps;

  constructor(d: PauseKeeperDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    try {
      const j = JSON.parse(fs.readFileSync(d.file, 'utf8')) as { settings?: unknown; memory?: PauseMemory };
      this.settings = cleanSettings(j.settings);
      const m = j.memory ?? {};
      this.mem = {
        ...(m.manual && typeof m.manual.at === 'number' ? { manual: { paused: m.manual.paused === true, at: m.manual.at } } : {}),
        ...(typeof m.inputAt === 'number' ? { inputAt: m.inputAt } : {}),
        ...(typeof m.ignoreUntil === 'number' ? { ignoreUntil: m.ignoreUntil } : {}),
      };
    } catch {
      // No file yet (or unreadable): the defaults, no schedule, the activity watch on.
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
    this.d.log(`pause: ${this.describe(this.current())} (settings in ${this.d.file})`);
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
      this.d.log(`pause: a person's ${kind} at ${new Date(when).toISOString()} (not injected by a program)${this.settings.activity.enabled ? '' : '; the activity watch is off, so it does not pause'}`);
    }
  }

  /** Input programs injected (SendInput, keybd_event, mouse_event): never a person, counted for the log. */
  injected(keys: number, clicks: number) {
    this.d.log(`pause: ignored ${keys} injected key press(es) and ${clicks} injected click(s) in the last minute: programs' input (an agent driving the game, a test), not a person`);
  }

  /** New settings from the tray. */
  setSettings(raw: unknown) {
    const next = cleanSettings(raw);
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    this.mem = settingsChanged(this.settings, this.mem, this.now());
    this.settings = next;
    this.d.log(`pause: settings changed from the tray: ${JSON.stringify(next)}`);
    this.save();
    this.look(true);
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
      writeFileDurable(this.d.file, `${JSON.stringify({ settings: this.settings, memory: this.mem }, null, 2)}\n`);
    } catch (e) {
      this.d.log(`pause: could not save ${this.d.file}: ${(e as Error).message}`);
    }
  }
}

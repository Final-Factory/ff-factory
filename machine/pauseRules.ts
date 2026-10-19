// A machine's pause (w1532, docs/machines.md "Pausing a machine"): the rules that combine a pause or unpause from the
// tray, the work schedule and a person's input into one answer, paused or running and why. Pure: the daemon
// (machine/pause.ts) keeps the state, feeds it the clock and the tray's events, and reports what this says.
//
// lothsahn (2026-10-19, w1532): "a small taskbar app that you can right click to pause and unpause all work on that
// machine ... a schedule that you can configure. It'll unpause when the schedule begins and pause when the schedule ends
// ... If someone clicks the mouse or types a key, it should pause and only unpause after 90 minutes of inactivity.
// Unpausing via the taskbar should prevent any such pausing for 30 seconds after unpausing in the taskbar."
//
// How they combine (the latest event wins, and a person at the keyboard wins over both):
// - The base state is the latest of: a pause or unpause from the tray, and the schedule's last edge (a window's start
//   unpauses, its end pauses). So a tray pause holds until the tray unpauses or the next window starts; a tray unpause
//   outside the window holds until the next edge. Without a schedule, the tray's last word holds.
// - A person's input (a key or a click that no program injected) pauses a machine that would run, for as long as input
//   keeps coming and IDLE_MINUTES after the last. It also holds across a window's start: someone is at the machine.
// - A tray unpause clears that and ignores input for SUPPRESS_SECONDS (the click that unpaused, and the person moving away).

import type { MachinePause, MachinePauseSettings } from '../shared/types.ts';

export const IDLE_MINUTES = 90;
export const SUPPRESS_SECONDS = 30;

export const DEFAULT_PAUSE_SETTINGS: MachinePauseSettings = {
  schedule: { enabled: false, start: '22:00', end: '08:00', days: [0, 1, 2, 3, 4, 5, 6] },
  // Off unless a machine turns it on (w1574, lothsahn: "We want it off on all of the workers currently so that they continue
  // to work even if a user is at the station"; config machines.activityPause.enabled, docs/machines.md).
  activity: { enabled: false, idleMinutes: IDLE_MINUTES },
};

/** What the daemon keeps between events (in pause.json beside its settings). Times are epoch ms. */
export interface PauseMemory {
  /** The tray's last word, and when. */
  manual?: { paused: boolean; at: number };
  /** The last input counted as a person's (not injected, not inside the suppression). */
  inputAt?: number;
  /** Input before this is ignored (a tray unpause sets it SUPPRESS_SECONDS ahead). */
  ignoreUntil?: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Settings as read from a file or the tray, every field checked; a field that is wrong keeps its default. */
export function cleanSettings(raw: unknown): MachinePauseSettings {
  const d = DEFAULT_PAUSE_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const s = r.schedule && typeof r.schedule === 'object' ? r.schedule : {};
  const a = r.activity && typeof r.activity === 'object' ? r.activity : {};
  const days = Array.isArray(s.days) ? [...new Set(s.days.filter((x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 6))].sort() as number[] : d.schedule.days;
  const idle = Number(a.idleMinutes);
  return {
    schedule: {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : d.schedule.enabled,
      start: typeof s.start === 'string' && HHMM.test(s.start) ? s.start : d.schedule.start,
      end: typeof s.end === 'string' && HHMM.test(s.end) ? s.end : d.schedule.end,
      days,
    },
    activity: {
      enabled: typeof a.enabled === 'boolean' ? a.enabled : d.activity.enabled,
      idleMinutes: Number.isFinite(idle) && idle >= 1 && idle <= 24 * 60 ? Math.round(idle) : d.activity.idleMinutes,
    },
  };
}

const minutesOf = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

/**
 * The schedule's windows near `now`, in this computer's local time, as [start, end) epoch ms: one per enabled day, starting on
 * that day at `start` and ending at the next `end` after it (the next day when `end` is not after `start`, so 22:00-08:00
 * is a night). Start equal to end is a whole day.
 */
export function windowsAround(s: MachinePauseSettings['schedule'], now: number, days = 8): [number, number][] {
  const out: [number, number][] = [];
  const base = new Date(now);
  const startMin = minutesOf(s.start);
  const endMin = minutesOf(s.end);
  for (let k = -days; k <= days; k++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + k);
    if (!s.days.includes(day.getDay())) continue;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(startMin / 60), startMin % 60).getTime();
    const endDay = endMin > startMin ? 0 : 1;
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + endDay, Math.floor(endMin / 60), endMin % 60).getTime();
    out.push([start, end]);
  }
  return out;
}

/** Whether `now` is inside a window, the last edge at or before it, and the next edge after it (undefined: no schedule). */
export function scheduleAt(s: MachinePauseSettings['schedule'], now: number): { inside: boolean; lastEdge?: number; nextEdge?: number } | undefined {
  if (!s.enabled || !s.days.length) return undefined;
  const wins = windowsAround(s, now);
  // Windows that overlap (a 22:00-23:00 next to a 23:00-08:00 cannot happen with one start and end, but days do touch) are merged.
  wins.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const w of wins) {
    const last = merged.at(-1);
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  const edges = merged.flatMap(([a, b]) => [a, b]).sort((a, b) => a - b);
  const inside = merged.some(([a, b]) => now >= a && now < b);
  const lastEdge = edges.filter((e) => e <= now).at(-1);
  const nextEdge = edges.find((e) => e > now);
  return { inside, lastEdge, nextEdge };
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** "22:00 to 08:00, every day" / "09:00 to 17:00, Mon Tue Wed Thu Fri": the schedule in a menu line. */
export function scheduleText(s: MachinePauseSettings['schedule']): string {
  if (!s.enabled) return 'no schedule (work any time)';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = s.days.length === 7 ? 'every day' : s.days.length ? [1, 2, 3, 4, 5, 6, 0].filter((d) => s.days.includes(d)).map((d) => names[d]).join(' ') : 'no days';
  return `${s.start} to ${s.end}, ${days}`;
}

/** A tray pause or unpause at `now`: the memory after it. */
export function trayCommand(mem: PauseMemory, paused: boolean, now: number): PauseMemory {
  if (paused) return { ...mem, manual: { paused: true, at: now } };
  // Unpause clears a person's pause and ignores input for SUPPRESS_SECONDS (lothsahn: "prevent any such pausing for 30 seconds").
  return { manual: { paused: false, at: now }, ignoreUntil: now + SUPPRESS_SECONDS * 1000 };
}

/** A person's input at `at` (the tray sends only input no program injected): the memory after it. */
export function personInput(mem: PauseMemory, at: number): PauseMemory {
  if (mem.ignoreUntil !== undefined && at < mem.ignoreUntil) return mem;
  if (mem.inputAt !== undefined && at <= mem.inputAt) return mem;
  return { ...mem, inputAt: at };
}

/**
 * Paused or running at `now`, why, since when (as far as this can tell) and until when it changes by itself. `since` for a
 * state that began with an event is that event; for the schedule, its last edge.
 */
export function pauseState(settings: MachinePauseSettings, mem: PauseMemory, now: number): Omit<MachinePause, 'settings' | 'tray'> {
  const sched = scheduleAt(settings.schedule, now);
  const manualLive = mem.manual && (!sched || sched.lastEdge === undefined || mem.manual.at >= sched.lastEdge) ? mem.manual : undefined;
  const until = sched?.nextEdge !== undefined ? new Date(sched.nextEdge).toISOString() : undefined;
  let base: { paused: boolean; reason: 'manual' | 'schedule' | 'always'; since?: number };
  if (manualLive) base = { paused: manualLive.paused, reason: 'manual', since: manualLive.at };
  else if (sched) base = { paused: !sched.inside, reason: 'schedule', since: sched.lastEdge };
  else base = { paused: false, reason: 'always' };
  const idleMs = settings.activity.idleMinutes * 60_000;
  const person = settings.activity.enabled && mem.inputAt !== undefined && now < mem.inputAt + idleMs;
  if (!base.paused && person) {
    const back = mem.inputAt! + idleMs;
    return { paused: true, reason: 'activity', since: new Date(mem.inputAt!).toISOString(), until: new Date(back).toISOString(), detail: `someone is using this PC: work resumes ${settings.activity.idleMinutes} min after the last key or click (at ${hhmm(back)} if nobody touches it)` };
  }
  const since = base.since !== undefined ? new Date(base.since).toISOString() : undefined;
  if (base.paused) {
    if (base.reason === 'manual') return { paused: true, reason: 'manual', since, ...(sched && until ? { until } : {}), detail: `paused from the tray at ${hhmm(base.since!)}${sched?.nextEdge !== undefined ? `; the schedule takes over at ${hhmm(sched.nextEdge)}` : ''}` };
    return { paused: true, reason: 'schedule', since, until, detail: `outside the schedule (${scheduleText(settings.schedule)})${sched?.nextEdge !== undefined ? `: work resumes at ${hhmm(sched.nextEdge)}` : ''}` };
  }
  if (base.reason === 'manual') return { paused: false, reason: 'manual', since, ...(sched && until ? { until } : {}), detail: `unpaused from the tray at ${hhmm(base.since!)}${sched?.nextEdge !== undefined ? `; the schedule takes over at ${hhmm(sched.nextEdge)}` : ''}` };
  if (base.reason === 'schedule') return { paused: false, reason: 'schedule', since, until, detail: `in the schedule (${scheduleText(settings.schedule)}) until ${hhmm(sched!.nextEdge!)}` };
  return { paused: false, detail: 'running: no schedule set' };
}

/**
 * When the answer can next change by itself (a schedule edge, the end of a person's 90 minutes): the daemon looks again
 * then, and at least once a minute anyway.
 */
export function nextChangeAt(settings: MachinePauseSettings, mem: PauseMemory, now: number): number | undefined {
  const at = [scheduleAt(settings.schedule, now)?.nextEdge, settings.activity.enabled && mem.inputAt !== undefined ? mem.inputAt + settings.activity.idleMinutes * 60_000 : undefined, mem.ignoreUntil];
  return at.filter((x): x is number => x !== undefined && x > now).sort((a, b) => a - b)[0];
}

/** "15:40", or "Mon 09:00" when it is not on `now`'s day. */
export function whenText(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? hhmm(ms) : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hhmm(ms)}`;
}

/** What the tray's menu and tooltip say about a state (machine/tray/FFFactoryTray.cs shows them as given). */
export interface TrayView {
  /** Why it is paused or running, one short line. */
  why: string;
  /** What happens next, one short line, or undefined. */
  next?: string;
  /** The tooltip's words after "FF Factory: paused" / "running". */
  tip?: string;
  /** The schedule, for the menu's "Work schedule: …" item. */
  schedule: string;
}

export function trayView(settings: MachinePauseSettings, p: Pick<MachinePause, 'paused' | 'reason' | 'since' | 'until'>, now: number): TrayView {
  const at = (iso?: string) => (iso ? whenText(Date.parse(iso), now) : '');
  const sched = settings.schedule.enabled ? scheduleText(settings.schedule) : 'none';
  const watch = settings.activity.enabled;
  const idle = settings.activity.idleMinutes;
  if (p.paused) {
    if (p.reason === 'activity') return { why: 'Someone is using this PC', next: `Resumes at ${at(p.until)} after ${idle} min idle`, tip: 'someone is using this PC', schedule: sched };
    if (p.reason === 'manual') return { why: `Paused from the tray at ${at(p.since)}`, next: p.until ? `The schedule starts work again at ${at(p.until)}` : 'Until you unpause it here', tip: 'paused from the tray', schedule: sched };
    return { why: 'Outside the work schedule', next: p.until ? `Work starts at ${at(p.until)}` : undefined, tip: 'outside the schedule', schedule: sched };
  }
  const orInput = watch ? ', or when someone uses this PC' : '';
  if (p.reason === 'manual') return { why: `Unpaused from the tray at ${at(p.since)}`, next: p.until ? `The schedule takes over at ${at(p.until)}` : watch ? 'A key or click on this PC pauses work' : undefined, schedule: sched };
  if (p.reason === 'schedule') return { why: 'Inside the work schedule', next: `Work pauses at ${at(p.until)}${orInput}`, schedule: sched };
  return { why: 'No schedule: work runs any time', next: watch ? 'A key or click on this PC pauses work' : undefined, schedule: sched };
}

/**
 * New settings: a tray pause or unpause the old schedule had already overtaken (a window's edge came after it) is dropped, so
 * turning the schedule off or changing it never brings back a word the schedule had replaced.
 */
export function settingsChanged(old: MachinePauseSettings, mem: PauseMemory, now: number): PauseMemory {
  const edge = scheduleAt(old.schedule, now)?.lastEdge;
  if (!mem.manual || edge === undefined || mem.manual.at >= edge) return mem;
  const { manual: _gone, ...rest } = mem;
  return rest;
}

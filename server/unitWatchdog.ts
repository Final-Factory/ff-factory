// What the VM's unit watchdog did about critical systemd units.
//
// fff-health runs as root on the VM every 30 s. It restarts a critical unit (fff-ops.socket, ...) that is down while it should
// be up, backs off between tries, and gives up after a few failed restarts. It writes what it saw and did into
// <dataDir>/unit-watchdog.json (owned by the portal's account, 0600). This module reads that file; the dashboard's banner and
// system_status show which unit, when and why, and a restart the portal has not seen before goes to the host guard's channel
// (a push notification and a message to the orchestrator), once. The file is data written by another process: every string
// is clamped, unknown fields are ignored, and a missing or half-written file shows nothing.

import type { UnitWatchdog, UnitWatchdogEvent, UnitWatchdogUnit } from '../shared/types.ts';
import { unitEventKey } from '../shared/dismissals.ts';
import { filePathHealth } from './pathHealth.ts';

/** The file's name in the portal's data folder; FFF_UNIT_WATCHDOG_FILE overrides the whole path (server/index.ts). */
export const UNIT_WATCHDOG_FILE = 'unit-watchdog.json';
/** fff-health runs every 30 s: silent for this long, what the file says may be old. */
export const UNIT_WATCHDOG_SILENT_AFTER_MS = 10 * 60_000;
/** How long a restart stays on the banner. */
export const RECENT_EVENT_MS = 24 * 3_600_000;
const MAX_EVENTS = 50;
const MAX_UNITS = 100;

const STATES = new Set(['ok', 'backoff', 'gave-up', 'paused', 'held']);
const ACTIONS = new Set(['restart', 'enable', 'gave-up']);

const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 700) : '');
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1_000_000, Math.max(0, Math.round(v))) : 0);

function unitOf(v: unknown): UnitWatchdogUnit | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const unit = str(o.unit);
  if (!unit) return undefined;
  const state = str(o.state);
  return {
    unit,
    active: str(o.active),
    enabled: str(o.enabled),
    state: (STATES.has(state) ? state : 'unknown') as UnitWatchdogUnit['state'],
    attempts: count(o.attempts),
    nextTryAt: str(o.nextTryAt),
  };
}

function eventOf(v: unknown): UnitWatchdogEvent | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const unit = str(o.unit);
  const at = str(o.at);
  const action = str(o.action);
  if (!unit || !at || !ACTIONS.has(action)) return undefined;
  return { at, unit, action: action as UnitWatchdogEvent['action'], why: str(o.why), attempt: count(o.attempt), ok: o.ok === true };
}

/**
 * The watchdog's file as a UnitWatchdog, or undefined when it is not one (a half-written file, another schema). `now` is
 * the clock for the silent-watchdog check. A silent watchdog proves nothing about the units it listed, so they are dropped;
 * what it did (the events) stays true.
 */
export function parseUnitWatchdog(text: string, now: number): UnitWatchdog | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.schema !== 1 || typeof o.updatedAt !== 'string') return undefined;
  const units = (Array.isArray(o.units) ? o.units.slice(0, MAX_UNITS) : []).map(unitOf).filter((u): u is UnitWatchdogUnit => !!u);
  const events = (Array.isArray(o.events) ? o.events.slice(-MAX_EVENTS) : []).map(eventOf).filter((e): e is UnitWatchdogEvent => !!e);
  const updatedAt = str(o.updatedAt);
  const updated = Date.parse(updatedAt);
  const silent = Number.isFinite(updated) && now - updated > UNIT_WATCHDOG_SILENT_AFTER_MS ? Math.round((now - updated) / 60_000) : undefined;
  return {
    updatedAt,
    host: str(o.host),
    units: silent === undefined ? units : [],
    events,
    ...(silent !== undefined ? { silentMinutes: silent } : {}),
  };
}

/** A unit the banner and system_status care about: not healthy, and not held on purpose. */
export const isProblemUnit = (u: UnitWatchdogUnit): boolean => u.state !== 'ok' && u.state !== 'held';

/** The restarts (and enables) in the last 24 hours, newest last. A gave-up event is not a restart: its unit shows as gave-up. */
export function recentRestarts(events: UnitWatchdogEvent[], now: number): UnitWatchdogEvent[] {
  return events.filter((e) => {
    const t = Date.parse(e.at);
    return e.action !== 'gave-up' && Number.isFinite(t) && Math.abs(now - t) <= RECENT_EVENT_MS;
  });
}

/** "2026-10-08T15:33:02Z" as "2026-10-08 15:33Z", for text a person reads in a chat. */
const when = (iso: string): string => iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, 'Z');

/** An event's identity; the banner's per-person dismissals use the same key (shared/dismissals.ts, w751). */
const eventKey = unitEventKey;

export function describeEvent(e: UnitWatchdogEvent): string {
  const what = e.action === 'enable' ? 'enabled' : e.action === 'gave-up' ? 'gave up on' : 'restarted';
  return `The VM watchdog ${what} ${e.unit} at ${when(e.at)}${e.attempt ? ` (attempt ${e.attempt}${e.ok ? '' : ', failed'})` : ''}: ${e.why || 'no reason given'}.`;
}

export interface UnitWatchdogDeps {
  /** The file's text, or undefined when there is none. */
  read: () => string | undefined;
  now: () => number;
  /** What the banner shows changed (undefined: nothing to show). */
  changed: (u: UnitWatchdog | undefined) => void;
  /** A new restart or a unit given up on: a push notification and a message to the orchestrator (server/index.ts). */
  report: (title: string, body: string) => void;
  log: (line: string) => void;
}

/** Reads the watchdog's file, keeps the last status, and reports what is new. */
export class UnitWatchdogMonitor {
  private last: UnitWatchdog | undefined;
  /** Events and gave-up units already reported: "<at>|<unit>|<action>" and "gaveup|<unit>". */
  private reported = new Set<string>();
  private signature = '';
  /** The first read only notes what is already there: a standing problem is not announced again at every restart. */
  private primed = false;

  private readonly deps: UnitWatchdogDeps;

  constructor(deps: UnitWatchdogDeps) {
    this.deps = deps;
  }

  /** The last file as read (all units, all events). */
  get status(): UnitWatchdog | undefined {
    return this.last;
  }

  /** Read the file once. Called every few seconds. */
  tick(): void {
    let text: string | undefined;
    try {
      text = this.deps.read();
    } catch (e) {
      this.deps.log(`unit watchdog: cannot read the watchdog's file: ${e instanceof Error ? e.message : String(e)}`);
    }
    const now = this.deps.now();
    const u = text === undefined ? undefined : parseUnitWatchdog(text, now);
    this.last = u;
    // A file that is there but unreadable right now (half written) says nothing: it must not look like "all events gone".
    if (text === undefined || u) this.reportChanges(u);
    // What the banner shows: units that need a person or are backing off, a silent watchdog, and the last 24 hours of restarts.
    const shown: UnitWatchdog | undefined = u && {
      ...u,
      units: u.units.filter(isProblemUnit),
      events: u.events.filter((e) => e.action === 'gave-up' || recentRestarts([e], now).length > 0),
    };
    const visible = shown && (shown.units.length || shown.silentMinutes !== undefined || recentRestarts(shown.events, now).length) ? shown : undefined;
    const sig = visible ? JSON.stringify([visible.silentMinutes !== undefined, visible.units.map((x) => [x.unit, x.state, x.attempts, x.nextTryAt]), visible.events.map(eventKey)]) : '';
    if (sig !== this.signature) {
      this.signature = sig;
      this.deps.changed(visible);
    }
  }

  private reportChanges(u: UnitWatchdog | undefined): void {
    const events = u?.events ?? [];
    const gaveUp = (u?.units ?? []).filter((x) => x.state === 'gave-up');
    if (!this.primed) {
      this.primed = true;
      for (const e of events) this.reported.add(eventKey(e));
      for (const g of gaveUp) this.reported.add(`gaveup|${g.unit}`);
      if (events.length || gaveUp.length) this.deps.log(`unit watchdog: already in the file at start: ${events.length} event(s), ${gaveUp.length} unit(s) given up on`);
      return;
    }
    const seen = new Set<string>();
    for (const e of events) {
      const key = eventKey(e);
      seen.add(key);
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      if (e.action === 'gave-up') {
        // The unit's gave-up state, if the file shows it too, is the same news.
        this.reported.add(`gaveup|${e.unit}`);
        this.deps.report(`The VM watchdog gave up restarting ${e.unit}`, `${describeEvent(e)} A person must act: run sudo fffctl status on the VM.`);
      } else {
        this.deps.report(`The VM watchdog restarted ${e.unit}`, describeEvent(e));
      }
    }
    // Events that left the file's last 50 can never come back; forget them (not when there is no file to compare with).
    if (u) for (const key of [...this.reported]) if (!key.startsWith('gaveup|') && !seen.has(key)) this.reported.delete(key);
    const gaveUpNow = new Set(gaveUp.map((g) => `gaveup|${g.unit}`));
    for (const g of gaveUp) {
      const key = `gaveup|${g.unit}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      this.deps.report(`The VM watchdog gave up restarting ${g.unit}`, `${g.unit} (${g.active || 'unknown'}) was restarted ${g.attempts} time(s) without staying up, and the watchdog stopped trying. A person must act: run sudo fffctl status on the VM.`);
    }
    // A silent watchdog says nothing about the units: keep what was reported until it speaks again.
    if (u && u.silentMinutes === undefined) for (const key of [...this.reported]) if (key.startsWith('gaveup|') && !gaveUpNow.has(key)) this.reported.delete(key);
  }

  /** The lines system_status adds: every unit that is not ok or held, a silent watchdog, and the restarts of the last 24 hours. */
  statusLines(): string[] {
    const u = this.last;
    if (!u) return [];
    const out: string[] = [];
    if (u.silentMinutes !== undefined) {
      out.push(`WARNING: the VM's unit watchdog (fff-health${u.host ? ` on ${u.host}` : ''}) has been silent for ${u.silentMinutes} min: nobody is restarting a critical unit that fails. Last report ${u.updatedAt}.`);
    }
    for (const x of u.units.filter(isProblemUnit)) {
      const line =
        x.state === 'gave-up'
          ? `PROBLEM: the VM watchdog gave up restarting ${x.unit} (${x.active || 'unknown'}) after ${x.attempts} attempt(s). A person must act: sudo fffctl status on the VM.`
          : x.state === 'backoff'
            ? `Unit ${x.unit} is ${x.active || 'down'}; the VM watchdog is backing off after ${x.attempts} attempt(s)${x.nextTryAt ? `, next try ${when(x.nextTryAt)}` : ''}.`
            : x.state === 'paused'
              ? `Unit ${x.unit} is ${x.active || 'unknown'}; the VM watchdog's restarts are switched off on purpose (paused).`
              : `Unit ${x.unit} is ${x.active || 'unknown'} and the VM watchdog reports a state this portal does not know.`;
      out.push(line);
    }
    const recent = recentRestarts(u.events, this.deps.now());
    if (recent.length) {
      out.push(`The VM watchdog restarted ${recent.length} time(s) in the last 24 h:`);
      for (const e of recent.slice(-10)) out.push(`  - ${e.unit} at ${when(e.at)}${e.ok ? '' : ' (failed)'}: ${e.why || 'no reason given'}`);
    }
    return out;
  }
}

/** The file on this machine. */
export const fileUnitWatchdog = filePathHealth;

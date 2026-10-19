/**
 * When a plan limit resets, for the plan usage hover (w1528, lothsahn: "hovering the plan in the plan usage tab causes it to
 * show the time and day the plan resets"): "Resets Sun 11:00 MDT (in 2 d 4 h)". The day and time are in the viewer's own
 * zone with the zone named; the time left follows. A limit with no reset time says so, never a guess.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "2 d 4 h", "3 h 20 m", "12 m", "under 1 m": the time left, whole units, the smaller one left out when it is zero. */
export function timeLeft(ms: number): string {
  if (ms < MIN) return 'under 1 m';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MIN);
  if (d > 0) return h ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m ? `${h} h ${m} m` : `${h} h`;
  return `${m} m`;
}

/**
 * "Sun 11:00 MDT": weekday, 24-hour time and the zone's short name. A time six days or more away also names its date
 * ("Sun Oct 25 11:00 MDT"), since its weekday could be today's. `timeZone` is the viewer's own unless a test pins one.
 */
export function resetClock(iso: string, now: number, timeZone?: string): string {
  const at = Date.parse(iso);
  if (isNaN(at)) return '';
  const far = at - now >= 6 * DAY;
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    ...(far ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const date = far ? ` ${get('month')} ${get('day')}` : '';
  return `${get('weekday')}${date} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`;
}

/** "Sun 11:00 MDT (in 2 d 4 h)"; "reset time unknown" when the limit gives none. */
export function resetWhen(iso: string | undefined, now: number, timeZone?: string): string {
  const clock = iso ? resetClock(iso, now, timeZone) : '';
  if (!clock) return 'reset time unknown';
  const left = Date.parse(iso!) - now;
  return left <= 0 ? `${clock} (passed, waiting for a fresh reading)` : `${clock} (in ${timeLeft(left)})`;
}

/** The hover's sentence for one limit: "Resets Sun 11:00 MDT (in 2 d 4 h)" or "Reset time unknown". */
export function resetText(iso: string | undefined, now: number, timeZone?: string): string {
  const when = resetWhen(iso, now, timeZone);
  return when === 'reset time unknown' ? 'Reset time unknown' : `Resets ${when}`;
}

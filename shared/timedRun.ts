// A timed run on a play-only machine (w1946; lothsahn, 2026-10-23: "Can the portal do builds on one machine and then use
// this other with an exclusive lock for benchmarks?", then "File it: play-only timing machine, builds elsewhere,
// exclusive lock there"). A worker builds two (to four) players where it is; `timed_run` ships them to a play-only
// computer, which runs the game repo's interleaved A/B (scripts/bench/probe_ab_win.sh) under its own exclusive bench
// ticket and sends the logs back. Within lothsahn's rule ("I don't want a unilateral way into machines... just build
// scoped commands for the functionality needed"), the run is data, never a command: the player is the build's own
// finalfactory.exe, started from the machine's player slot with the fixed arguments below; a variant adds only -ff
// switches. This file is what the portal, the worker's daemon and the timing machine's daemon share.

/** One stretch of one file inside a piece. */
export interface PiecePart {
  /** The file's path inside the build folder, with forward slashes. */
  path: string;
  offset: number;
  length: number;
}

/**
 * What travels: a piece is the bytes of its parts one after another, at most PIECE_MAX_BYTES, named by its SHA-256. A big
 * file is cut into pieces of its own; small files are grouped. The same bytes are one piece wherever they come from, so a
 * second variant or a later run sends only what changed (the two big .resS files were the same in four of five BEAST
 * builds of 2026-10-23: 1.19 GB of a 1.86 GB player, measured).
 */
export interface Piece {
  sha256: string;
  size: number;
  parts: PiecePart[];
}

/** A player to time, as the timing machine rebuilds it. */
export interface TimedVariant {
  name: string;
  /** Its own -ff switches (TIMED_ARG rules), after the fixed arguments. */
  args: string[];
  /** Every file of the folder, for the check that nothing is missing after the pieces are laid out. */
  files: { path: string; size: number }[];
  pieces: Piece[];
}

/** The run's settings: those of probe_ab_win.sh, bounded. */
export interface TimedSettings {
  rounds: number;
  sampleS: number;
  settleS: number;
  dwellS: number;
  res: (typeof TIMED_RESOLUTIONS)[number];
}

/** What the portal sends the timing machine's daemon (`timed_run`). */
export interface TimedRunOrder {
  id: string;
  /** "w1891 RoundRobin belt output (worker 3f2a1b0c)": its bench ticket's `what`. */
  what: string;
  requests: string[];
  session: string;
  variants: TimedVariant[];
  /** The save every leg loads, an attachment the portal lets this machine fetch. */
  save: { id: string; name: string; size: number; sha256: string };
  /** Each piece's attachment id, by SHA-256. */
  pieceIds: Record<string, string>;
  settings: TimedSettings;
}

/** What the timing machine's daemon tells the portal of a run (protocol FromDaemon). */
export type TimedRunReport =
  | { type: 'timed_run_status'; id: string; state: 'queued' | 'fetching' | 'waiting' | 'running' | 'uploading'; line: string }
  | { type: 'timed_run_done'; id: string; ok: boolean; error?: string; summary: string; legs: LegSummary[]; result?: { name: string; size: number; sha256: string } }
  | { type: 'timed_run_result'; id: string; attachmentId?: string; error?: string };

/** One leg's numbers, from its player.log's last PerfSummary line (PerfProbe.cs). */
export interface LegSummary {
  variant: string;
  round: number;
  ok: boolean;
  /** Why it has no numbers (did not start, timed out, no PerfSummary), or what disturbed it. */
  note?: string;
  seconds: number;
  frameAvgMs?: number;
  frameP95Ms?: number;
  frameMaxMs?: number;
  fps?: number;
  ups?: number;
  hb?: number;
  /** The machine's mean CPU load during the leg (all cores), percent. */
  cpuPct?: number;
}

export const PIECE_MAX_BYTES = 64 * 1024 * 1024;
/** A file below this is grouped with others into pieces of up to GROUP_MAX_BYTES. */
export const SMALL_FILE_BYTES = 8 * 1024 * 1024;
export const GROUP_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_VARIANTS = 4;
export const TIMED_RESOLUTIONS = ['1920x1080', '1280x720', '1280x800', '2560x1440'] as const;
export const TIMED_DEFAULTS: TimedSettings = { rounds: 4, sampleS: 20, settleS: 25, dwellS: 5, res: '1920x1080' };
/** Where a play-only machine keeps its players: the install's player slots, which its firewall step already allows (w576). */
export const TIMED_SLOTS = ['slot1-0', 'slot1-1'] as const;

/** Debug files a run needs no copy of: Burst's debug information folder and the .pdb files (63 MB for lib_burst_generated alone). */
export function skippedInBuild(rel: string): boolean {
  return rel.split('/').some((seg) => /_DoNotShip$/i.test(seg)) || /\.pdb$/i.test(rel);
}

/**
 * The pieces of a build folder's files (path order): each file of SMALL_FILE_BYTES or more is cut into pieces of its own,
 * the rest are packed in order into groups of up to GROUP_MAX_BYTES. Without hashes: the daemon fills them in as it reads.
 */
export function planPieces(files: { path: string; size: number }[]): Omit<Piece, 'sha256'>[] {
  const out: Omit<Piece, 'sha256'>[] = [];
  let group: PiecePart[] = [];
  let groupSize = 0;
  const flush = () => {
    if (group.length) out.push({ size: groupSize, parts: group });
    group = [];
    groupSize = 0;
  };
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (f.size >= SMALL_FILE_BYTES) {
      for (let off = 0; off < f.size; off += PIECE_MAX_BYTES) {
        const length = Math.min(PIECE_MAX_BYTES, f.size - off);
        out.push({ size: length, parts: [{ path: f.path, offset: off, length }] });
      }
      continue;
    }
    if (groupSize + f.size > GROUP_MAX_BYTES) flush();
    group.push({ path: f.path, offset: 0, length: f.size });
    groupSize += f.size;
  }
  flush();
  return out;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
const SWITCH = /^-ff[A-Za-z][A-Za-z0-9]{0,63}$/;
const VALUE = /^[A-Za-z0-9_.:+-]{1,64}$/;
/** Switches the run sets itself: a variant may not move the save, the commands, the log or the quit. */
const OWN_SWITCH = /^-ff(Automation|SoloQuit|Solo|LoadSave|Bench)/i;

/** Why a variant's own arguments are refused, or undefined: -ff switches only, each optionally followed by one plain value. */
export function timedArgsProblem(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  if (!Array.isArray(args) || args.length > 8) return 'args: at most 8 strings';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') return 'args: strings only';
    if (SWITCH.test(a)) {
      if (OWN_SWITCH.test(a)) return `args: ${a} is set by the run itself (the save, the commands, the quit); only other -ff switches`;
      continue;
    }
    if (i > 0 && SWITCH.test(String(args[i - 1])) && VALUE.test(a) && !a.startsWith('-')) continue;
    return `args: "${a.slice(0, 40)}" is not a -ff switch or a plain value after one (a timed run takes the game's own -ff switches only, w1946)`;
  }
  return undefined;
}

/** The settings from a tool call, within bounds, or why not. */
export function timedSettingsOf(a: Record<string, unknown>): TimedSettings | string {
  const n = (k: string, d: number, lo: number, hi: number) => {
    const v = a[k] === undefined ? d : Number(a[k]);
    return Number.isInteger(v) && v >= lo && v <= hi ? v : `${k}: a whole number from ${lo} to ${hi}`;
  };
  const rounds = n('rounds', TIMED_DEFAULTS.rounds, 1, 20);
  const sampleS = n('sample_s', TIMED_DEFAULTS.sampleS, 5, 300);
  const settleS = n('settle_s', TIMED_DEFAULTS.settleS, 5, 300);
  for (const v of [rounds, sampleS, settleS]) if (typeof v === 'string') return v;
  const res = a.res === undefined ? TIMED_DEFAULTS.res : String(a.res);
  if (!(TIMED_RESOLUTIONS as readonly string[]).includes(res)) return `res: one of ${TIMED_RESOLUTIONS.join(', ')}`;
  return { rounds: rounds as number, sampleS: sampleS as number, settleS: settleS as number, dwellS: TIMED_DEFAULTS.dwellS, res: res as TimedSettings['res'] };
}

/** A variant name, or why not. */
export function variantNameProblem(name: unknown): string | undefined {
  return typeof name === 'string' && NAME.test(name) ? undefined : `name "${String(name).slice(0, 30)}": 1-24 letters, digits, - or _`;
}

/** A leg's longest life: settle, the sample and its wait, the dwell, and 4 minutes to boot and load the save. */
export const legTimeoutS = (s: TimedSettings) => 240 + s.settleS + 2 * s.sampleS + 10 + s.dwellS;

/** A whole run's longest life, for the worker's check-in: every leg at its bound and 20 minutes for the pieces. */
export const runBoundMinutes = (s: TimedSettings, variants: number) => Math.ceil((s.rounds * variants * legTimeoutS(s)) / 60) + 20;

/**
 * The player's arguments for one leg: probe_ab_win.sh's (w565, w1628), so its tables read the logs as they are
 * (scripts/bench/probe_table.py, ab_stop.py): solo, the save, the perf probe after the settle, quit after the dwell.
 */
export function legArgs(s: TimedSettings, variant: Pick<TimedVariant, 'name' | 'args'>, round: number, saveName: string, logFile: string): string[] {
  const [w, h] = s.res.split('x');
  return [
    '-screen-fullscreen', '0', '-screen-width', w, '-screen-height', h, '-ffNoBackgroundFpsCap',
    '-ffAutomationRole', 'solo', '-ffAutomationSave', saveName, '-ffAutomationWriteReport', 'true', '-ffAutomationLabel', `probe-${variant.name}-${round}`,
    '-ffAutomationPostReadyCommand', `ffauto:wait|${s.settleS};ffauto:perf.sample|${s.sampleS}|20;ffauto:wait|${s.sampleS + 10}`,
    '-ffAutomationPostConnectDelayMs', String(s.dwellS * 1000), '-ffAutomationAutoQuit', 'true',
    '-logFile', logFile,
    ...variant.args,
  ];
}

/** Each round runs every variant once, the order reversed on even rounds (probe_ab_win.sh: drift falls on both arms). */
export function legOrder(names: string[], rounds: number): { variant: string; round: number }[] {
  const out: { variant: string; round: number }[] = [];
  for (let r = 1; r <= rounds; r++) for (const v of r % 2 === 0 ? [...names].reverse() : names) out.push({ variant: v, round: r });
  return out;
}

/** The numbers of a player.log's last PerfSummary line (PerfProbe.cs; probe_table.py reads the same), or undefined. */
export function perfSummaryOf(log: string): Pick<LegSummary, 'frameAvgMs' | 'frameP95Ms' | 'frameMaxMs' | 'fps' | 'ups' | 'hb'> | undefined {
  const line = log.split(/\r?\n/).filter((l) => l.includes('PerfSummary')).pop();
  if (!line) return undefined;
  const kv = Object.fromEntries([...line.matchAll(/([\w:.]+)=([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
  if (!Number.isFinite(kv.frameAvgMs)) return undefined;
  const pick = (k: string) => (Number.isFinite(kv[k]) ? kv[k] : undefined);
  return { frameAvgMs: kv.frameAvgMs, frameP95Ms: pick('frameP95Ms'), frameMaxMs: pick('frameMaxMs'), fps: pick('fps'), ups: pick('ups'), hb: pick('hb') };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => (xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean(xs)) ** 2, 0) / (xs.length - 1)) : 0);

/** The run's table: one line a leg, then each variant's mean ± SD of frameAvgMs and its spread as a share of the mean. */
export function summaryTable(legs: LegSummary[]): string {
  const f = (v: number | undefined, d = 2) => (v === undefined ? '-' : v.toFixed(d));
  const lines = ['variant\tround\tok\tframeAvgMs\tframeP95Ms\tfps\tups\tcpuPct\tseconds\tnote'];
  for (const l of legs) lines.push([l.variant, l.round, l.ok ? 'yes' : 'no', f(l.frameAvgMs), f(l.frameP95Ms), f(l.fps, 1), f(l.ups), f(l.cpuPct, 0), l.seconds, l.note ?? ''].join('\t'));
  lines.push('');
  for (const v of [...new Set(legs.map((l) => l.variant))]) {
    const xs = legs.filter((l) => l.variant === v && l.ok && l.frameAvgMs !== undefined).map((l) => l.frameAvgMs as number);
    lines.push(xs.length ? `${v}: n=${xs.length} frameAvgMs ${mean(xs).toFixed(3)} ± ${sd(xs).toFixed(3)} (SD ${((100 * sd(xs)) / mean(xs)).toFixed(2)}% of the mean)` : `${v}: no leg with numbers`);
  }
  return lines.join('\n');
}

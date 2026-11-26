// w5957 (N7, from w5617's re-review of #1193): the read fence's check on Windows. There the No-Read-Up labels are what
// refuses a Low worker's read, so a probe means a Low child opening each path. In `warn` no label is set on the real
// paths, so the check runs on a mirror: empty folders and files in a scratch folder named after each real path (never a
// byte copied), the same labels set on them as `on` would set on the real ones, then a Low node opens each one, and the
// mirror is removed. In `on` the Low child opens the real paths after the labels are set; when it finds a path workers
// need refused, or cannot judge one, the labels come off again by themselves (recovery that needs nobody at the machine).
// Either way the daemon log gets the same line as macOS and Linux: "N/N closed paths refused, M/M given-back paths open".
import fs from 'node:fs';
import path from 'node:path';
import type { LabelTarget } from './lowIntegrity.ts';
import { judgeReadProbe, READ_PROBE_SCRIPT, sayReadProbe, type ReadFenceMode, type ReadProbeVerdict } from './readFence.ts';

export interface ProbeTargets {
  closed: string[];
  open: string[];
}

/** Where `p` sits in the mirror below `dir`: `D:\work\ffw\daemon` -> `<dir>\D\work\ffw\daemon` (a UNC path under `unc`). */
export function mirrorPath(dir: string, p: string): string {
  const abs = path.win32.resolve(p);
  const rel = /^[A-Za-z]:\\/.test(abs) ? `${abs[0].toUpperCase()}\\${abs.slice(3)}` : `unc\\${abs.replace(/^\\\\+/, '')}`;
  return path.win32.join(dir, rel);
}

export interface PrecheckPlan {
  /** The labels to set, on the mirror's paths. */
  labels: LabelTarget[];
  /** What the Low child opens, in the mirror. */
  t: ProbeTargets;
  /** What to make first: each mirrored path and whether it is a folder or an (empty) file. */
  make: { path: string; kind: 'dir' | 'file' }[];
  /** Mirror path -> real path, for the log line. */
  real: Map<string, string>;
}

/**
 * The mirror for `warn`: every label target and probe target under `dir`, of the same kind as the real one (`kind`, the
 * real path's type; a label's kind is its SDDL's, OICI being a folder's). Labels `on` would skip (`skip`: the system drive)
 * are not set in the mirror either, so the check shows what `on` would leave open there.
 */
export function precheckPlan(o: { dir: string; labels: readonly LabelTarget[]; t: ProbeTargets; kind: (p: string) => 'dir' | 'file' | undefined; skip?: (p: string) => boolean }): PrecheckPlan {
  const real = new Map<string, string>();
  const kinds = new Map<string, 'dir' | 'file'>();
  const at = (p: string, k: 'dir' | 'file' | undefined): string => {
    const m = mirrorPath(o.dir, p);
    real.set(m, p);
    if (k && !kinds.has(m.toLowerCase())) kinds.set(m.toLowerCase(), k);
    return m;
  };
  const labels = o.labels.filter((x) => !o.skip?.(x.path)).map((x) => ({ path: at(x.path, x.sddl.includes('OICI') ? 'dir' : 'file'), sddl: x.sddl }));
  const t = { closed: o.t.closed.map((p) => at(p, o.kind(p))), open: o.t.open.map((p) => at(p, o.kind(p))) };
  const make = [...real.keys()].flatMap((m) => {
    const k = kinds.get(m.toLowerCase());
    return k ? [{ path: m, kind: k }] : [];
  });
  // Folders before the files and folders inside them, so a label set on a folder is inherited as on the real one.
  make.sort((a, b) => a.path.length - b.path.length);
  return { labels, t, make, real };
}

/** Makes the mirror's folders and empty files (no content of any real file). */
export function buildMirror(plan: PrecheckPlan): void {
  for (const m of plan.make) {
    if (m.kind === 'dir') fs.mkdirSync(m.path, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(m.path), { recursive: true });
      if (!fs.existsSync(m.path)) fs.writeFileSync(m.path, '');
    }
  }
}

/** What a Windows verdict means: whether runs wait (blocks) and, in `on`, whether the labels must come off (revert). */
export function windowsReadVerdict(mode: ReadFenceMode, v: ReadProbeVerdict): { blocks: boolean; revert: boolean } {
  const lockout = v.wronglyRefused.length > 0 || v.unknown.length > 0;
  return { blocks: lockout || v.leftOpen.length > 0, revert: mode === 'on' && lockout };
}

/** The verdict with the mirror's paths named by the real ones they stand for. */
export function realVerdict(v: ReadProbeVerdict, real: ReadonlyMap<string, string>): ReadProbeVerdict {
  const name = (s: string) => {
    for (const [m, r] of real) if (s === m || s.startsWith(`${m} (`)) return r + s.slice(m.length);
    return s;
  };
  return { wronglyRefused: v.wronglyRefused.map(name), leftOpen: v.leftOpen.map(name), unknown: v.unknown.map(name) };
}

type Exec = (cmd: string, args: string[], o?: { timeoutMs?: number; cwd?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface WinProbeDeps {
  mode: Exclude<ReadFenceMode, 'off'>;
  /** The real label targets (lowIntegrity.ts noReadUpTargets) and probe targets (readFence.ts readFenceProbeTargets). */
  labels: readonly LabelTarget[];
  t: ProbeTargets;
  /** A Low-labelled node (lowIntegrity.ts lowCopy), or undefined when none could be made. */
  lowNode?: string;
  /** The scratch folder for warn's mirror (not on the system drive). */
  mirrorDir: string;
  /** Whether a path is on the system drive and left unlabelled by `on` (the daemon's labelSystemDrive). */
  skip: (p: string) => boolean;
  run: Exec;
  /** Sets labels (lowIntegrity.ts labelNoReadUp) / takes NR off (openNoReadUp); both true on success. */
  setLabels: (t: readonly LabelTarget[]) => Promise<boolean>;
  openLabels: (t: readonly LabelTarget[]) => Promise<boolean>;
  log: (line: string) => void;
  kind?: (p: string) => 'dir' | 'file' | undefined;
}

const realKind = (p: string): 'dir' | 'file' | undefined => {
  try {
    return fs.statSync(p).isDirectory() ? 'dir' : 'file';
  } catch {
    return undefined;
  }
};

/** Opens `paths` from the Low node; its stdout, or undefined (and why) when it could not run. */
async function lowOpen(d: WinProbeDeps, paths: string[]): Promise<{ stdout: string } | { why: string }> {
  if (!d.lowNode) return { why: 'no Low node copy could be made' };
  const r = await d.run(d.lowNode, ['-e', READ_PROBE_SCRIPT, ...paths], { timeoutMs: 60_000, cwd: path.dirname(d.lowNode) });
  if (r.code !== 0) return { why: `the Low child exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-200)}` };
  return { stdout: r.stdout };
}

/**
 * The check. Returns whether runs must wait (the verdict found a failure, or no verdict). Never throws; in `on` a lockout
 * verdict takes the No-Read-Up labels off the real paths at once and says so.
 */
export async function probeReadFenceWin(d: WinProbeDeps): Promise<{ blocks: boolean; reverted: boolean; line: string }> {
  const say = (line: string) => {
    d.log(line);
    return line;
  };
  if (d.mode === 'warn') {
    if (d.skip(d.mirrorDir)) return { blocks: true, reverted: false, line: say(`read fence (warn, win32) probe: not run: the mirror folder ${d.mirrorDir} is on the system drive, which the fence does not touch`) };
    const plan = precheckPlan({ dir: d.mirrorDir, labels: d.labels, t: d.t, kind: d.kind ?? realKind, skip: d.skip });
    try {
      fs.rmSync(d.mirrorDir, { recursive: true, force: true });
      buildMirror(plan);
      if (!(await d.setLabels(plan.labels))) return { blocks: true, reverted: false, line: say('read fence (warn, win32) probe: not run: the labels could not be set on the mirror (the line above says which)') };
      const r = await lowOpen(d, [...plan.t.closed, ...plan.t.open]);
      if ('why' in r) return { blocks: true, reverted: false, line: say(`read fence (warn, win32) probe: not run: ${r.why}`) };
      const v = realVerdict(judgeReadProbe(plan.t, r.stdout), plan.real);
      const line = `${sayReadProbe('warn', 'win32', v, d.t).replace(' probe:', ' probe (on a mirror of the labels on would set, in ' + d.mirrorDir + '):')}`;
      return { blocks: windowsReadVerdict('warn', v).blocks, reverted: false, line: say(line) };
    } catch (e) {
      return { blocks: true, reverted: false, line: say(`read fence (warn, win32) probe: could not run (${(e as Error).message})`) };
    } finally {
      try {
        // The mirror's labels are No-Write-Up and No-Read-Up at Medium, which the daemon (Medium, the owner) may remove.
        fs.rmSync(d.mirrorDir, { recursive: true, force: true });
      } catch (e) {
        d.log(`read fence (warn, win32) probe: could not remove the mirror ${d.mirrorDir} (${(e as Error).message}); the next probe removes it`);
      }
    }
  }
  const r = await lowOpen(d, [...d.t.closed, ...d.t.open]).catch((e: Error) => ({ why: e.message }));
  const v: ReadProbeVerdict = 'why' in r ? { wronglyRefused: [], leftOpen: [], unknown: [`(the probe could not run: ${r.why})`] } : judgeReadProbe(d.t, r.stdout);
  const line = say(sayReadProbe('on', 'win32', v, d.t));
  const verdict = windowsReadVerdict('on', v);
  if (!verdict.revert) return { blocks: verdict.blocks, reverted: false, line };
  const opened = await d.openLabels(d.labels).catch(() => false);
  say(opened
    ? 'read fence (on, win32): the probe found a path workers need refused or could not judge one, so the No-Read-Up labels are off again and Low workers read as in warn; the mode stays on, and the next start or switch to on labels and probes again'
    : 'read fence (on, win32): WARNING: the probe found a path workers need refused, and not every No-Read-Up label could be taken off (the lines above say which); switch the read fence off from the portal (machine_daemon read-fence-off)');
  return { blocks: true, reverted: opened, line };
}

// CI runner units recover by themselves (w5263, w5264). On biscuit on 2026-11-23 the disk filled at about 08:36Z and two of
// its five Final-Factory/ffu runners took no job for four hours (08:37Z-12:28Z, w5262):
// - ffu-biscuit (user unit ffu-runner.service, ~/ffu-runner): its Runner.Listener aborted on "No space left on device"
//   writing its _diag log (journal 08:37:05Z). run.sh's `cp -f run-helper.sh.template run-helper.sh` then left an empty
//   run-helper.sh, so each restart exited at once; Restart=always with no RestartSec reached systemd's start limit at restart
//   16 (08:37:08Z, "start-limit-hit") and systemd stopped trying, with the disk free again an hour later.
// - ffu-biscuit-2: its Runner.Worker died (exit 134) on the same full disk at 08:37:16Z, and the listener's dispatch of that
//   job faulted on ENOSPC writing its own log ("Worker Dispatch failed ... No space left on device", logged only when the
//   unit stopped at 12:28:50Z). It never finished the job, so it polled GitHub with status=Busy and took nothing. The bench
//   pause (machine/benchRunners.ts) stopped it at 08:37:25Z, 9 s after that fault: not the cause, and continuing it did not
//   clear it either.
// So, on Linux, once a minute for each systemd user unit that runs a registered runner (<dir>/run.sh beside <dir>/.runner):
// (a) a failed unit (start-limit-hit or any other result) is reset and started while its volume is above the disk floor;
// (b) a listener whose _diag log stays busy (a job handed, a worker that finished without the job completing, a poll with
//     status=Busy) for STUCK_MS with no Runner.Worker under it is restarted: never while a worker runs, never while a bench
//     turn or the load gate holds it paused;
// (c) every runner unit gets a drop-in (DROPIN_NAME): RestartSec=30s and StartLimitIntervalSec=0, so a short ENOSPC never
//     ends it for good, and OOMPolicy=continue (w5264): at 11:41:27Z the same day a global OOM killed one test binary of
//     ffu-biscuit-4's job, and systemd's default OOMPolicy=stop ended the whole unit, cancelling ffu PR #998's check job.
// The units' names, labels and count are untouched: only the drop-in is written, and only systemctl --user is run.
import fs from 'node:fs';
import path from 'node:path';
import type { RunnerCensus } from './benchRunners.ts';

/** The drop-in every runner unit gets (c). */
export const DROPIN_NAME = 'ff-runner-recovery.conf';
export const DROPIN = [
  '# Written by FF Factory (w5263, w5264): a runner unit restarts for ever, 30 s apart, and outlives one job\'s OOM kill.',
  '[Unit]',
  'StartLimitIntervalSec=0',
  '[Service]',
  'RestartSec=30s',
  'OOMPolicy=continue',
  '',
].join('\n');

/** A listener busy with no worker for this long is stuck (b): past GitHub's 10-minute job lock, the job is no longer its. */
export const STUCK_MS = 10 * 60_000;
/** A unit this recovery started or restarted is left alone this long, so a unit that keeps failing is not churned. */
export const COOLDOWN_MS = 15 * 60_000;

export interface RunnerUnit {
  unit: string;
  root: string;
}

/** The value of `key=` in a unit file's text (the last one wins, as systemd reads it), or undefined. */
function unitValue(text: string, key: string): string | undefined {
  let v: string | undefined;
  for (const line of text.split('\n')) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (m) v = m[1];
  }
  return v;
}

/** The unit's runner folder: ExecStart is <dir>/run.sh (systemd's -, @, + prefixes allowed) and <dir> holds .runner. */
export function runnerRootOf(text: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const exec = unitValue(text, 'ExecStart')?.replace(/^[-@+!:]+/, '').split(/\s+/)[0];
  if (!exec || path.posix.basename(exec) !== 'run.sh') return undefined;
  const root = path.posix.dirname(exec);
  return exists(path.posix.join(root, '.runner')) ? root : undefined;
}

/** The runner units among the user unit files in `dir` (~/.config/systemd/user). */
export function findRunnerUnits(dir: string, exists: (p: string) => boolean = fs.existsSync): RunnerUnit[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.service')).sort();
  } catch {
    return [];
  }
  const out: RunnerUnit[] = [];
  for (const unit of names) {
    try {
      const root = runnerRootOf(fs.readFileSync(path.join(dir, unit), 'utf8'), exists);
      if (root) out.push({ unit, root });
    } catch {
      /* unreadable: not ours to judge */
    }
  }
  return out;
}

const DIAG_LINE = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)Z [A-Z]+ +\w+\] (.*)$/;
const IDLE = /^(WRITE LINE: .*: Job .* completed with result: |WRITE LINE: .*: Listening for Jobs|Skipping message Job\.|finish job request for job )/;
const BUSY = /^(Acknowledging runner request '|Job request .* received\.|WRITE LINE: .*: Running job: |Worker finished for job |.*[?&]status=Busy\b)/;

/**
 * When a listener's log says it went busy and has not been idle since (the oldest busy line after its newest idle one), or
 * undefined when its newest word is idle or it says neither. A 64 KB tail that is all busy lines counts from its oldest.
 */
export function busySince(tail: string | undefined): number | undefined {
  if (tail === undefined) return undefined;
  const lines = tail.split('\n');
  let since: number | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = DIAG_LINE.exec(lines[i].trimEnd());
    if (!m) continue;
    if (IDLE.test(m[2])) break;
    if (BUSY.test(m[2])) since = Date.parse(`${m[1].replace(' ', 'T')}Z`);
  }
  return since;
}

export interface UnitShow {
  activeState: string;
  result: string;
}

/** `systemctl --user show -p ActiveState -p Result <unit>`. */
export function parseShow(out: string): UnitShow {
  return { activeState: unitValue(out, 'ActiveState') ?? '', result: unitValue(out, 'Result') ?? '' };
}

export interface RunnerUnitsDeps {
  units(): RunnerUnit[];
  /** The drop-in's text now, undefined when there is none. */
  readDropin(unit: string): string | undefined;
  writeDropin(unit: string, text: string): void;
  /** Runs `systemctl --user <args>`; answers its stdout, or throws. */
  systemctl(args: string[]): Promise<string>;
  /** Free bytes on the volume holding `p`, undefined when it cannot be read. */
  freeBytes(p: string): Promise<number | undefined>;
  /** The disk floor (GB): below it a failed unit is not started (it would fail again). */
  floorGB(): number;
  census(): Promise<RunnerCensus>;
  /** The listener's _diag log tail (readListenerLog). */
  diag(root: string): string | undefined;
  /** Listener pids a bench turn or the load gate holds paused now: never restarted. */
  paused(): Set<number>;
  log(text: string): void;
  now(): number;
}

const flat = (p: string) => p.replace(/\/+$/, '');

export class RunnerUnits {
  private readonly d: RunnerUnitsDeps;
  private ticking = false;
  private last = new Map<string, number>();
  /** When each listener (by pid) was first seen busy with no worker, in looks since; any other look clears it. */
  private workerless = new Map<number, number>();
  /** Units whose drop-in could not be written, said once. */
  private said = new Set<string>();

  constructor(d: RunnerUnitsDeps) {
    this.d = d;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } catch (e) {
      this.d.log(`runner units: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private cooling(unit: string): boolean {
    const t = this.last.get(unit);
    return t !== undefined && this.d.now() - t < COOLDOWN_MS;
  }

  private async step() {
    const units = this.d.units();
    if (!units.length) return;
    // (c) the drop-in, then one daemon-reload for all of them
    let wrote = 0;
    for (const u of units) {
      if (this.d.readDropin(u.unit) === DROPIN) continue;
      try {
        this.d.writeDropin(u.unit, DROPIN);
        wrote++;
        this.d.log(`runner units: ${u.unit} (${u.root}): wrote ${DROPIN_NAME} (RestartSec=30s, StartLimitIntervalSec=0, OOMPolicy=continue)`);
      } catch (e) {
        if (!this.said.has(u.unit)) this.d.log(`runner units: ${u.unit}: could not write ${DROPIN_NAME}: ${(e as Error).message}`);
        this.said.add(u.unit);
      }
    }
    if (wrote) await this.d.systemctl(['daemon-reload']);
    let census: RunnerCensus | undefined;
    for (const u of units) {
      if (this.cooling(u.unit)) continue;
      const show = parseShow(await this.d.systemctl(['show', '-p', 'ActiveState', '-p', 'Result', u.unit]));
      if (show.activeState === 'failed') {
        // (a) a failed unit, started again once its disk has room
        const free = await this.d.freeBytes(u.root);
        const floor = this.d.floorGB() * 1024 ** 3;
        if (free === undefined || free < floor) continue;
        await this.d.systemctl(['reset-failed', u.unit]);
        await this.d.systemctl(['start', u.unit]);
        this.last.set(u.unit, this.d.now());
        this.d.log(`runner units: ${u.unit} (${u.root}) had failed (${show.result || 'no result'}): reset and started, ${(free / 1024 ** 3).toFixed(1)} GB free`);
        continue;
      }
      if (show.activeState !== 'active') continue;
      // (b) a listener stuck busy with no worker. One look is not enough: a job that ends well has no worker for the instant
      // between "Worker finished" and its "completed" line, so the state must hold in every look for STUCK_MS.
      census ??= await this.d.census();
      const root = flat(u.root);
      const l = census.listeners.find((x) => flat(x.root) === root);
      if (!l) continue;
      const since = busySince(this.d.diag(u.root));
      if (l.busy || census.workers.some((w) => flat(w.root) === root) || this.d.paused().has(l.pid) || since === undefined) {
        this.workerless.delete(l.pid);
        continue;
      }
      const first = this.workerless.get(l.pid) ?? this.d.now();
      this.workerless.set(l.pid, first);
      if (this.d.now() - first < STUCK_MS || this.d.now() - since < STUCK_MS) continue;
      this.workerless.delete(l.pid);
      await this.d.systemctl(['restart', u.unit]);
      this.last.set(u.unit, this.d.now());
      this.d.log(`runner units: ${u.unit} (${u.root}): listener pid ${l.pid} busy since ${new Date(since).toISOString()} (its log) with no job worker for ${Math.round((this.d.now() - first) / 60_000)} min: restarted`);
    }
  }
}

// w6163: a Windows machine's CI runners run their jobs at Normal priority, however the runner last started. Each ffu runner
// is a scheduled task (ffu tools/ci-runners/install-ffu-runner.ps1 `schtasks /create`), and a task registered that way runs
// at task priority 7, which is BELOW_NORMAL_PRIORITY_CLASS; the listener, its workers and every job step inherit the class.
// At logon the same runner starts from the Startup folder's .cmd instead, at Normal. The daemon starts a runner again with
// Start-ScheduledTask (machine/hostGuard.ts runnerRestartScript), so after one of those its jobs ran BelowNormal: both
// LothDesktop workers were logged at BelowNormal on 2026-11-26 17:46Z (w6110). ffu #1204 makes new installs register the task
// at priority 5 (Normal; 4 to 6 are Normal).
//
// Once a minute (RunnerPriority.tick), for each runner listener running here:
// - its scheduled task's priority is read (at the first tick, when a runner folder not seen before appears, and every
//   TASK_EVERY_MS), and in "enforce" one above 6 is set to 5 through the Task Scheduler (Set-ScheduledTask on the task the
//   user registered: no elevation, no file written), so the next Start-ScheduledTask starts it at Normal;
// - a listener below Normal is raised to Normal in "enforce" (SetPriorityClass through os.setPriority), so the jobs it starts
//   from then on run at Normal without a restart. Nothing is restarted, and a job already running keeps its priority.
//   A listener above Normal is left alone.
// "warn" only logs what it reads, once per change; "off" does nothing. RUNNER_PRIORITY_ENFORCE lists the machines it enforces
// on (lothdesktop): every other machine, BEAST included (Ben's standing hold on BEAST's system settings, 2026-11-26), only
// logs. daemon.json `runnerPriority` overrides it ("warn" or "off" is the recovery, read at the daemon's start).
// Raising to Normal is how the runner starts at logon anyway, and nothing here touches access, network or files, so a
// wrong step costs CPU share at worst.
import os from 'node:os';
import type { RunnerCensus } from './benchRunners.ts';
import { priorityName } from './ciFirstWin.ts';

export type RunnerPriorityMode = 'off' | 'warn' | 'enforce';

/** The machines (by id) whose runners' tasks and listeners are set to Normal; elsewhere it only logs. */
export const RUNNER_PRIORITY_ENFORCE = new Set(['lothdesktop']);

/** How often a runner's scheduled task is read again. */
export const TASK_EVERY_MS = 60 * 60_000;

/** One runner folder's scheduled task, as the Task Scheduler answered. */
export interface TaskRow {
  root: string;
  /** Absent when no scheduled task's action names the folder (it starts from run.cmd or the Startup folder only). */
  task?: string;
  /** The task's priority before (0 highest .. 10 lowest; 4 to 6 are Normal) and after this look. */
  before?: number;
  after?: number;
  error?: string;
}

export interface RunnerPriorityDeps {
  mode: RunnerPriorityMode;
  census: () => Promise<RunnerCensus>;
  priorityOf: (pid: number) => number | undefined;
  setPriority: (pid: number, priority: number) => boolean;
  /** Read (fix: false) or read and set to 5 when above 6 (fix: true) the scheduled tasks of these runner folders. */
  tasks: (roots: string[], fix: boolean) => Promise<TaskRow[]>;
  now: () => number;
  log: (line: string) => void;
}

/** A task priority the Task Scheduler runs at Normal or above (0 to 6). */
export function taskNormal(p: number | undefined): boolean {
  return p !== undefined && p <= 6;
}

function taskPriorityName(p: number | undefined): string {
  if (p === undefined) return '?';
  if (p <= 0) return 'Realtime';
  if (p <= 2) return 'High';
  if (p === 3) return 'AboveNormal';
  if (p <= 6) return 'Normal';
  if (p <= 8) return 'BelowNormal';
  return 'Idle';
}

const folderName = (root: string) => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root;

/** The PowerShell that reads (and with fix, sets) the scheduled task of each runner folder; it prints a JSON array of TaskRow. */
export function runnerTaskScript(roots: string[], fix: boolean): string {
  const wins = roots.map((r) => r.replace(/\//g, '\\').replace(/\\+$/, ''));
  for (const w of wins) if (!/^[a-z]:\\/i.test(w) || /['\r\n]/.test(w)) throw new Error(`${w} is not a runner folder`);
  return [
    `$fix = $${fix ? 'true' : 'false'}`,
    `$all = @(Get-ScheduledTask -ErrorAction Stop)`,
    `$rows = foreach ($root in @(${wins.map((w) => `'${w}'`).join(', ')})) {`,
    // the same match as runnerRestartScript: the folder in the action, not followed by a longer name (-1 is not -10)
    `  $re = [regex]::Escape($root) + '(?![\\w.-])'`,
    `  $t = $all | Where-Object { (($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' ') -match $re } | Select-Object -First 1`,
    `  if (-not $t) { [pscustomobject]@{ root = $root }; continue }`,
    `  $before = [int]$t.Settings.Priority; $err = $null`,
    `  if ($fix -and $before -gt 6) { try { $t.Settings.Priority = 5; Set-ScheduledTask -InputObject $t -ErrorAction Stop | Out-Null } catch { $err = $_.Exception.Message } }`,
    `  $after = [int](Get-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop).Settings.Priority`,
    `  [pscustomobject]@{ root = $root; task = ($t.TaskPath + $t.TaskName); before = $before; after = $after; error = $err }`,
    `}`,
    `[Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 -InputObject @($rows)))`,
  ].join('\n');
}

/** Parse what runnerTaskScript printed. */
export function parseTaskRows(out: string): TaskRow[] {
  const j = JSON.parse(out.trim() || '[]') as unknown;
  const arr = Array.isArray(j) ? j : [j];
  return arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { root?: unknown }).root === 'string')
    .map((r) => ({
      root: r.root as string,
      ...(typeof r.task === 'string' ? { task: r.task } : {}),
      ...(typeof r.before === 'number' ? { before: r.before } : {}),
      ...(typeof r.after === 'number' ? { after: r.after } : {}),
      ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
    }));
}

export class RunnerPriority {
  readonly mode: RunnerPriorityMode;
  private readonly d: RunnerPriorityDeps;
  /** Each runner folder's task, as last said (so a line is logged once per change), and when it was last read. */
  private readonly taskSaid = new Map<string, string>();
  private tasksReadAt = 0;
  private readonly rootsRead = new Set<string>();
  /** Each listener's pid and what was last said about it. */
  private readonly listenerSaid = new Map<number, string>();
  private tasksFailing = false;

  constructor(d: RunnerPriorityDeps) {
    this.d = d;
    this.mode = d.mode;
  }

  async tick(): Promise<void> {
    if (this.mode === 'off') return;
    const enforce = this.mode === 'enforce';
    const listeners = (await this.d.census()).listeners;
    const roots = [...new Map(listeners.map((l) => [l.root.toLowerCase(), l.root])).values()];
    if (roots.length && (this.d.now() - this.tasksReadAt >= TASK_EVERY_MS || roots.some((r) => !this.rootsRead.has(r.toLowerCase())))) {
      await this.lookAtTasks(roots, enforce);
    }
    const NORMAL = os.constants.priority.PRIORITY_NORMAL;
    const live = new Set<number>();
    for (const l of listeners) {
      live.add(l.pid);
      const p = this.d.priorityOf(l.pid);
      if (p === undefined || p <= NORMAL) {
        this.listenerSaid.delete(l.pid);
        continue;
      }
      const name = folderName(l.root);
      let said: string;
      if (!enforce) said = `runner priority: ${name}'s listener (pid ${l.pid}) runs at ${priorityName(p)}, so its jobs do too; this machine only reports it (w6163)`;
      else if (this.d.setPriority(l.pid, NORMAL)) said = `runner priority: raised ${name}'s listener (pid ${l.pid}) from ${priorityName(p)} to Normal, so the jobs it starts from now on run at Normal (w6163)`;
      else said = `runner priority: could not raise ${name}'s listener (pid ${l.pid}) from ${priorityName(p)} to Normal (w6163)`;
      if (this.listenerSaid.get(l.pid) !== said) this.d.log(said);
      this.listenerSaid.set(l.pid, said);
    }
    for (const pid of this.listenerSaid.keys()) if (!live.has(pid)) this.listenerSaid.delete(pid);
  }

  private async lookAtTasks(roots: string[], enforce: boolean) {
    this.tasksReadAt = this.d.now();
    for (const r of roots) this.rootsRead.add(r.toLowerCase());
    let rows: TaskRow[];
    try {
      rows = await this.d.tasks(roots, enforce);
      if (this.tasksFailing) this.d.log('runner priority: the scheduled tasks read again');
      this.tasksFailing = false;
    } catch (e) {
      if (!this.tasksFailing) this.d.log(`runner priority: could not read the runners' scheduled tasks: ${(e as Error).message.slice(0, 200)}`);
      this.tasksFailing = true;
      return;
    }
    for (const r of rows) {
      const name = folderName(r.root);
      let said: string;
      if (!r.task) said = `runner priority: ${name} has no scheduled task (it starts from run.cmd or the Startup folder, at the priority of what starts it)`;
      else if (r.error) said = `runner priority: could not set ${name}'s scheduled task ${r.task} from priority ${r.before} (${taskPriorityName(r.before)}) to 5 (Normal): ${r.error.slice(0, 200)}`;
      else if (r.before !== r.after) said = `runner priority: set ${name}'s scheduled task ${r.task} from priority ${r.before} (${taskPriorityName(r.before)}) to ${r.after} (${taskPriorityName(r.after)}), so a start through it runs its jobs at ${taskPriorityName(r.after)} (w6163)`;
      else if (taskNormal(r.after)) said = `runner priority: ${name}'s scheduled task ${r.task} runs at priority ${r.after} (${taskPriorityName(r.after)})`;
      else said = `runner priority: ${name}'s scheduled task ${r.task} runs at priority ${r.after} (${taskPriorityName(r.after)}), so a start through it runs its jobs at ${taskPriorityName(r.after)}${enforce ? '' : '; this machine only reports it'} (w6163)`;
      if (this.taskSaid.get(r.root.toLowerCase()) !== said) this.d.log(said);
      this.taskSaid.set(r.root.toLowerCase(), said);
    }
  }
}

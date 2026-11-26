// w6163: a Windows machine's ffu CI runners run their jobs at Normal priority, however the runner last started. Each ffu runner
// is a scheduled task (ffu tools/ci-runners/install-ffu-runner.ps1 `schtasks /create`), and a task registered that way runs
// at task priority 7, which starts its process at BELOW_NORMAL_PRIORITY_CLASS, I/O priority Low and memory priority 2; the
// listener, its workers and every job step inherit all three. At logon the same runner starts from the Startup folder's .cmd
// instead, at Normal (class Normal, I/O Normal, memory 5). The daemon starts a runner again with Start-ScheduledTask
// (machine/hostGuard.ts runnerRestartScript), so after one of those its jobs ran low: both LothDesktop workers were logged at
// BelowNormal on 2026-11-26 17:46Z (w6110). Of the task priorities only 4 gives a full Normal start (5 and 6 give Normal
// class but memory priority 4 and 3: docs "Priority (settingsType) Element"); ffu #1204 registers new tasks at 4.
//
// Once a minute (RunnerPriority.tick), for each ffu runner listener running here (its folder's name starts with ffu-, as the
// load gate's, machine/loadRunners.ts):
// - its scheduled task's priority is read (at the first tick, for a runner folder not seen before, and every TASK_EVERY_MS);
//   in "enforce" one above 4 is set to 4 through the Task Scheduler (Set-ScheduledTask on the task the user registered: no
//   elevation; the Schedule service rewrites its own copy of the task), so the next Start-ScheduledTask starts it at Normal;
//   a runner running a job has its task set once it is between jobs;
// - the listener and the cmd.exe and conhost.exe it runs under (run.cmd starts a new listener under the same cmd when one
//   exits 2 to 4, which runnerEnv's relaunch does) are read for class, I/O and memory priority when the listener is new to
//   this daemon or its class reads below Normal; in "enforce" each below Normal is raised to Normal in all three
//   (SetPriorityClass, NtSetInformationProcess ProcessIoPriority, SetProcessInformation ProcessMemoryPriority: same user, no
//   privilege), and read back. The jobs it starts from then on run at Normal. Nothing is restarted, a job already running
//   keeps its priority, and a process above Normal is left alone. A "parent" that started after its child (a reused pid) is
//   not one: the chain ends there. A raise that fails or does not hold is tried again after RAISE_RETRY_MS, not every minute.
// "warn" only logs what it reads, once per change; "off" does nothing. RUNNER_PRIORITY_ENFORCE lists the machines it enforces
// on (lothsahn's lockout rule: warn first; step 1 enforced nowhere, step 2 LothDesktop); everywhere else only logs, BEAST
// included and staying so in code (Ben's standing hold on BEAST's system settings, 2026-11-26). daemon.json `runnerPriority`
// overrides the default at the daemon's start (`ops_worker machine_update runner_priority`: warn is the recovery). Raising to Normal is how the runner starts at logon anyway, and nothing here touches access, network or
// the worker root's files, so a wrong step costs CPU share at worst; a failure is logged once and changes nothing else.
import os from 'node:os';
import type { Proc } from './unity.ts';
import type { RunnerCensus } from './benchRunners.ts';

export type RunnerPriorityMode = 'off' | 'warn' | 'enforce';

/**
 * The machines (by id) whose runners' tasks and processes are set to Normal; everywhere else it only logs. Step 2 of w6163:
 * LothDesktop, once step 1's warn lines there (2026-11-26 20:22Z) showed the daemon reads its tasks (both at 7) and listeners
 * (BelowNormal, I/O 1, memory 2).
 */
export const RUNNER_PRIORITY_ENFORCE = new Set<string>(['lothdesktop']);
/** Never enforced by default, whatever RUNNER_PRIORITY_ENFORCE says: Ben's standing hold on BEAST's system settings (2026-11-26). */
const NEVER_BY_DEFAULT = new Set<string>(['beast']);

/** The mode a daemon runs in: daemon.json's when set, else enforce on RUNNER_PRIORITY_ENFORCE's machines, else warn; off off Windows. */
export function runnerPriorityMode(id: string, platform: NodeJS.Platform, real: boolean, configured?: RunnerPriorityMode): RunnerPriorityMode {
  if (!real || platform !== 'win32') return 'off';
  const i = id.toLowerCase();
  return configured ?? (RUNNER_PRIORITY_ENFORCE.has(i) && !NEVER_BY_DEFAULT.has(i) ? 'enforce' : 'warn');
}

/** In enforce, how long a listener whose raise failed or did not hold is left before it is raised again. */
export const RAISE_RETRY_MS = 30 * 60_000;
/** The error the process script gives a "parent" that started after its child: a reused pid, not the parent; the chain ends there. */
export const REUSED_PID = 'started after its child';

/** How often a runner's scheduled task is read again. */
export const TASK_EVERY_MS = 60 * 60_000;
/** The task priority set: the only one whose start is Normal in class, I/O and memory priority. */
export const TASK_PRIORITY = 4;

/** One runner folder's scheduled task, as the Task Scheduler answered. */
export interface TaskRow {
  root: string;
  /** Absent when no scheduled task's action names the folder (it starts from run.cmd or the Startup folder only). */
  task?: string;
  /** The task's priority before (0 highest .. 10 lowest) and after this look. */
  before?: number;
  after?: number;
  error?: string;
}

/** One process's priorities: class (GetPriorityClass), I/O (0 very low .. 2 normal) and memory (1 .. 5 normal). */
export interface Prio {
  cls?: number;
  io?: number;
  mem?: number;
}
export interface ProcRow {
  pid: number;
  before: Prio;
  after: Prio;
  error?: string;
}

export interface RunnerPriorityDeps {
  mode: RunnerPriorityMode;
  procs: () => Promise<Proc[]>;
  census: (procs: Proc[]) => RunnerCensus;
  /** os.getPriority: the cheap class read that says when to look closer. */
  priorityOf: (pid: number) => number | undefined;
  /** Read (fix: false) or read and raise to Normal (fix: true) these processes' class, I/O and memory priority. */
  raise: (pids: number[], fix: boolean) => Promise<ProcRow[]>;
  /** Read (fix: false) or read and set to TASK_PRIORITY when above it (fix: true) the scheduled tasks of these runner folders. */
  tasks: (roots: string[], fix: boolean) => Promise<TaskRow[]>;
  now: () => number;
  log: (line: string) => void;
}

/** Windows priority classes (GetPriorityClass). */
export const CLASS = { IDLE: 0x40, BELOW_NORMAL: 0x4000, NORMAL: 0x20, ABOVE_NORMAL: 0x8000, HIGH: 0x80, REALTIME: 0x100 } as const;

export function className(c: number | undefined): string {
  const n = Object.entries(CLASS).find(([, v]) => v === c)?.[0];
  return n ? n.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join('') : '?';
}

/** Below Normal in any of the three: what enforce raises. */
export function prioLow(p: Prio): boolean {
  return p.cls === CLASS.IDLE || p.cls === CLASS.BELOW_NORMAL || (p.io !== undefined && p.io < 2) || (p.mem !== undefined && p.mem < 5);
}

function prioText(p: Prio): string {
  return `${className(p.cls)}, I/O ${p.io ?? '?'}, memory ${p.mem ?? '?'}`;
}

export function taskPriorityName(p: number | undefined): string {
  if (p === undefined) return '?';
  if (p === 0) return 'Realtime';
  if (p === 1) return 'High';
  if (p <= 3) return 'AboveNormal';
  if (p === 4) return 'Normal';
  if (p <= 6) return 'Normal class, lower memory';
  if (p <= 8) return 'BelowNormal';
  return 'Idle';
}

const folderName = (root: string) => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root;
const winPath = (r: string) => r.replace(/\//g, '\\').replace(/\\+$/, '');
/**
 * A runner folder a PowerShell single-quoted string can carry: only letters, digits, space, _ . - and \ (a whitelist, as
 * w5946's mediumFolders: a process picks its own command line, and PowerShell ends a single-quoted string at ' and at
 * U+2018..U+201B too).
 */
export const scriptableRoot = (r: string) => /^[a-z]:\\[A-Za-z0-9 _.\\-]+$/i.test(winPath(r));
const isFfu = (root: string) => /^ffu-/i.test(folderName(root));

/** The PowerShell that reads (and with fix, sets) the scheduled task of each runner folder; it prints a JSON array of TaskRow. */
export function runnerTaskScript(roots: string[], fix: boolean): string {
  const wins = roots.map(winPath);
  for (const w of wins) if (!scriptableRoot(w)) throw new Error(`${w} is not a runner folder`);
  return [
    `$fix = $${fix ? 'true' : 'false'}`,
    // SilentlyContinue, as runnerRestartScript: one unreadable task elsewhere does not hide the runners'
    `$all = @(Get-ScheduledTask -ErrorAction SilentlyContinue -ErrorVariable listErr)`,
    // none listed is the Task Scheduler refusing this process (a Low-integrity one gets "path not found"), not "no task"
    `if (-not $all.Count) { [Console]::Error.Write("no scheduled task could be listed: $listErr"); exit 3 }`,
    `$rows = foreach ($root in @(${wins.map((w) => `'${w}'`).join(', ')})) {`,
    // the same match as runnerRestartScript: the folder in the action, not followed by a longer name (-1 is not -10)
    `  $re = [regex]::Escape($root) + '(?![\\w.-])'`,
    `  $t = $all | Where-Object { (($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments) $($_.WorkingDirectory)" }) -join ' ') -match $re } | Select-Object -First 1`,
    `  if (-not $t) { [pscustomobject]@{ root = $root }; continue }`,
    `  $before = [int]$t.Settings.Priority; $err = $null`,
    `  if ($fix -and $before -gt ${TASK_PRIORITY}) { try { $t.Settings.Priority = ${TASK_PRIORITY}; Set-ScheduledTask -InputObject $t -ErrorAction Stop | Out-Null } catch { $err = $_.Exception.Message } }`,
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

/**
 * The PowerShell that reads (and with fix, raises to Normal) each process's class, I/O and memory priority. It prints one line
 * per pid: pid;class;io;mem;class after;io after;mem after;error (an empty field: not read).
 */
export function processPriorityScript(pids: number[], fix: boolean): string {
  for (const p of pids) if (!Number.isInteger(p) || p <= 4) throw new Error(`pid ${p} is not a process to read`);
  return [
    // a failed compile (constrained language, AMSI) exits non-zero instead of printing nothing
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -TypeDefinition @'`,
    `using System; using System.Runtime.InteropServices;`,
    `public static class FFRunnerPrio {`,
    `  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool i, int p);`,
    `  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);`,
    `  [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetPriorityClass(IntPtr h);`,
    `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetPriorityClass(IntPtr h, uint c);`,
    `  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref int v, int l, out int r);`,
    `  [DllImport("ntdll.dll")] static extern int NtSetInformationProcess(IntPtr h, int c, ref int v, int l);`,
    `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessInformation(IntPtr h, int c, ref int v, int l);`,
    `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr h, int c, ref int v, int l);`,
    `  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);`,
    // the creation time of the process One last opened (0: not read), for the next one's notAfter
    `  public static long Last;`,
    `  static string Read(IntPtr h) {`,
    `    uint c = GetPriorityClass(h); int io = 0, r = 0, mem = 0;`,
    `    string a = c == 0 ? "" : c.ToString();`,
    `    string b = NtQueryInformationProcess(h, 33, ref io, 4, out r) == 0 ? io.ToString() : "";`,
    `    string m = GetProcessInformation(h, 0, ref mem, 4) ? mem.ToString() : "";`,
    `    return a + ";" + b + ";" + m;`,
    `  }`,
    `  public static string One(int pid, bool fix, long notAfter) {`,
    `    Last = 0;`,
    // PROCESS_QUERY_INFORMATION, and PROCESS_SET_INFORMATION to raise
    `    IntPtr h = OpenProcess(fix ? 0x0600u : 0x0400u, false, pid);`,
    `    if (h == IntPtr.Zero) return pid + ";;;;;;;OpenProcess failed: error " + Marshal.GetLastWin32Error();`,
    `    try {`,
    `      long cr, e, k, u; if (GetProcessTimes(h, out cr, out e, out k, out u)) Last = cr;`,
    // a parent that started after its child is another process that took a dead parent's pid: left alone, the chain ends
    `      if (notAfter > 0 && Last > notAfter) return pid + ";;;;;;;${REUSED_PID} (a reused pid, not its parent)";`,
    `      string before = Read(h), err = "";`,
    `      if (fix) {`,
    `        uint c = GetPriorityClass(h);`,
    `        if ((c == 0x40 || c == 0x4000) && !SetPriorityClass(h, 0x20)) err += "class: error " + Marshal.GetLastWin32Error() + " ";`,
    `        int io = 0, r = 0; if (NtQueryInformationProcess(h, 33, ref io, 4, out r) == 0 && io < 2) { int n = 2; int s = NtSetInformationProcess(h, 33, ref n, 4); if (s != 0) err += "io: 0x" + s.ToString("X8") + " "; }`,
    `        int mem = 0; if (GetProcessInformation(h, 0, ref mem, 4) && mem < 5) { int n = 5; if (!SetProcessInformation(h, 0, ref n, 4)) err += "memory: error " + Marshal.GetLastWin32Error(); }`,
    `      }`,
    `      return pid + ";" + before + ";" + Read(h) + ";" + err.Trim();`,
    `    } finally { CloseHandle(h); }`,
    `  }`,
    `}`,
    `'@`,
    // in chain order (the listener, then each parent): each is checked against the creation time of the one before it
    `$prev = [long]0`,
    `$out = foreach ($p in @(${pids.join(', ')})) { $line = [FFRunnerPrio]::One($p, $${fix ? 'true' : 'false'}, $prev); $line; if ($line.Contains('${REUSED_PID}')) { break }; $prev = [FFRunnerPrio]::Last }`,
    `[Console]::Out.Write(($out -join "\`n"))`,
  ].join('\n');
}

/** Parse what processPriorityScript printed. */
export function parseProcRows(out: string): ProcRow[] {
  const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : undefined);
  const prio = (c?: string, i?: string, m?: string): Prio => ({
    ...(num(c) !== undefined ? { cls: num(c) } : {}),
    ...(num(i) !== undefined ? { io: num(i) } : {}),
    ...(num(m) !== undefined ? { mem: num(m) } : {}),
  });
  return out
    .split(/\r?\n/)
    .map((l) => l.split(';'))
    .filter((f) => f.length >= 8 && num(f[0]) !== undefined)
    .map((f) => ({ pid: num(f[0])!, before: prio(f[1], f[2], f[3]), after: prio(f[4], f[5], f[6]), ...(f.slice(7).join(';').trim() ? { error: f.slice(7).join(';').trim() } : {}) }));
}

/** The listener and the cmd.exe and conhost.exe it runs under, each started before what it started (Windows reuses pids). */
export function listenerChain(pid: number, procs: Proc[], startedAt?: (pid: number) => number | undefined): number[] {
  const by = new Map(procs.map((p) => [p.pid, p]));
  const chain = [pid];
  let cur = by.get(pid);
  for (let i = 0; cur && i < 6; i++) {
    const up = by.get(cur.ppid);
    if (!up || up.pid === cur.pid || !/^(cmd|conhost)\.exe$/i.test(up.name ?? '')) break;
    const a = startedAt?.(up.pid);
    const b = startedAt?.(cur.pid);
    if (a !== undefined && b !== undefined && a > b) break;
    chain.push(up.pid);
    cur = up;
  }
  return chain;
}

export class RunnerPriority {
  readonly mode: RunnerPriorityMode;
  private readonly d: RunnerPriorityDeps;
  /** Each runner folder's task, as last said (so a line is logged once per change), and when the tasks were last read. */
  private readonly taskSaid = new Map<string, string>();
  private tasksReadAt = 0;
  private readonly rootsRead = new Set<string>();
  /** Each listener's pid and what was last said about it. */
  private readonly listenerSaid = new Map<number, string>();
  private readonly badRootSaid = new Set<string>();
  private tasksFailing = false;
  private procsFailing = false;
  /** A tick still running (a slow PowerShell): the next one is skipped, not run beside it. */
  private ticking = false;
  /** Each listener's chain as the process script last cut it (a reused pid ends it), so a stranger is not looked at again. */
  private readonly chains = new Map<number, number[]>();
  /** In enforce: a listener whose raise failed or did not hold, and when it may be raised again (RAISE_RETRY_MS). */
  private readonly retryAt = new Map<number, number>();
  /** In enforce: runner folders whose task is above TASK_PRIORITY but was left while their runner ran a job. */
  private readonly taskPending = new Set<string>();

  constructor(d: RunnerPriorityDeps) {
    this.d = d;
    this.mode = d.mode;
  }

  async tick(): Promise<void> {
    if (this.mode === 'off' || this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const enforce = this.mode === 'enforce';
    const procs = await this.d.procs();
    const listeners = this.d.census(procs).listeners.filter((l) => isFfu(l.root));
    const roots: string[] = [];
    for (const r of new Map(listeners.map((l) => [l.root.toLowerCase(), l.root])).values()) {
      if (scriptableRoot(r)) roots.push(r);
      else if (!this.badRootSaid.has(r)) {
        this.badRootSaid.add(r);
        this.d.log(`runner priority: ${r} is not a folder its scheduled task can be looked up by; left alone`);
      }
    }
    // a runner running a job: its task is set once it is between jobs (Set-ScheduledTask leaves a running instance alone, but
    // nothing here acts on a runner mid-job that can wait a minute)
    const busy = new Set(listeners.filter((l) => l.busy).map((l) => l.root.toLowerCase()));
    const now = this.d.now();
    const due = now - this.tasksReadAt >= TASK_EVERY_MS || roots.some((r) => !this.rootsRead.has(r.toLowerCase()));
    const pendingFree = enforce && [...this.taskPending].some((r) => !busy.has(r));
    if (roots.length && (due || pendingFree)) await this.lookAtTasks(roots, enforce, busy);
    const live = new Set(listeners.map((l) => l.pid));
    for (const m of [this.listenerSaid, this.chains, this.retryAt]) for (const pid of m.keys()) if (!live.has(pid)) m.delete(pid);
    const NORMAL = os.constants.priority.PRIORITY_NORMAL;
    for (const l of listeners) {
      let chain = this.chains.get(l.pid) ?? listenerChain(l.pid, procs);
      const classLow = chain.some((p) => (this.d.priorityOf(p) ?? NORMAL) > NORMAL);
      const mayRetry = (this.retryAt.get(l.pid) ?? 0) <= now;
      if (this.listenerSaid.has(l.pid) && !(enforce && classLow && mayRetry)) continue;
      let rows: ProcRow[];
      try {
        rows = await this.d.raise(chain, enforce);
        if (this.procsFailing) this.d.log("runner priority: the runners' process priorities read again");
        this.procsFailing = false;
      } catch (e) {
        if (!this.procsFailing) this.d.log(`runner priority: could not read the runners' process priorities: ${(e as Error).message.slice(0, 200)}`);
        this.procsFailing = true;
        return;
      }
      // a "parent" that started after its child is a stranger with a reused pid: the chain ends before it
      const cut = rows.find((r) => r.error?.startsWith(REUSED_PID));
      if (cut && chain.indexOf(cut.pid) > 0) chain = chain.slice(0, chain.indexOf(cut.pid));
      rows = rows.filter((r) => chain.includes(r.pid));
      this.chains.set(l.pid, chain);
      const name = folderName(l.root);
      const low = rows.filter((r) => prioLow(r.before));
      // a pid the script printed no full row for was not read: a failure, never "Normal"
      const full = (r: ProcRow) => r.before.cls !== undefined && r.before.io !== undefined && r.before.mem !== undefined;
      const failed: { pid: number; error?: string }[] = [
        ...rows.filter((r) => r.error),
        ...chain.filter((p) => !rows.some((r) => r.pid === p && (r.error || full(r)))).map((pid) => ({ pid, error: 'not read' })),
      ];
      const stillLow = rows.filter((r) => prioLow(r.after));
      const lead = rows.find((r) => r.pid === l.pid) ?? rows[0];
      const parents = chain.length - 1;
      let said: string;
      if (failed.length) said = `runner priority: could not ${enforce ? 'raise' : 'read'} ${name}'s listener (pid ${l.pid}) and its ${parents} parent(s) to Normal: ${failed.map((r) => `pid ${r.pid}: ${r.error}`).join('; ').slice(0, 300)}`;
      else if (!low.length) said = `runner priority: ${name}'s listener (pid ${l.pid}) and its ${parents} parent(s) run at Normal (${prioText(lead?.after ?? {})})`;
      else if (!enforce) said = `runner priority: ${name}'s listener (pid ${l.pid}) runs at ${prioText(lead?.before ?? {})}, ${low.length} of it and its ${parents} parent(s) below Normal, so its jobs run low too; this machine only reports it (w6163)`;
      else if (stillLow.length) said = `runner priority: raised ${name}'s listener (pid ${l.pid}) and its ${parents} parent(s), but ${stillLow.length} still read below Normal (${stillLow.map((r) => `pid ${r.pid}: ${prioText(r.after)}`).join('; ')}) (w6163)`;
      else said = `runner priority: raised ${name}'s listener (pid ${l.pid}) from ${prioText(lead?.before ?? {})} to ${prioText(lead?.after ?? {})}, and its ${parents} parent(s), so the jobs it starts from now on run at Normal (w6163)`;
      if (this.listenerSaid.get(l.pid) !== said) this.d.log(said);
      this.listenerSaid.set(l.pid, said);
      if (enforce && (failed.length || stillLow.length)) this.retryAt.set(l.pid, now + RAISE_RETRY_MS);
      else this.retryAt.delete(l.pid);
    }
  }

  private async lookAtTasks(roots: string[], enforce: boolean, busy: Set<string>) {
    this.tasksReadAt = this.d.now();
    for (const r of roots) this.rootsRead.add(r.toLowerCase());
    const isBusy = (r: string) => busy.has(r.toLowerCase());
    const fixable = enforce ? roots.filter((r) => !isBusy(r)) : [];
    const readOnly = roots.filter((r) => !fixable.includes(r));
    let rows: TaskRow[];
    try {
      rows = [...(fixable.length ? await this.d.tasks(fixable, true) : []), ...(readOnly.length ? await this.d.tasks(readOnly, false) : [])];
      if (this.tasksFailing) this.d.log('runner priority: the scheduled tasks read again');
      this.tasksFailing = false;
    } catch (e) {
      if (!this.tasksFailing) this.d.log(`runner priority: could not read the runners' scheduled tasks: ${(e as Error).message.slice(0, 200)}`);
      this.tasksFailing = true;
      return;
    }
    this.taskPending.clear();
    for (const r of rows) {
      const name = folderName(r.root);
      const waits = enforce && isBusy(r.root) && !!r.task && r.after !== undefined && r.after > TASK_PRIORITY;
      if (waits) this.taskPending.add(r.root.toLowerCase());
      let said: string;
      if (waits) said = `runner priority: ${name}'s scheduled task ${r.task} runs at priority ${r.after} (${taskPriorityName(r.after)}); it is set to ${TASK_PRIORITY} once its runner is between jobs (w6163)`;
      else if (!r.task) said = `runner priority: ${name} has no scheduled task (it starts from run.cmd or the Startup folder, at the priority of what starts it)`;
      else if (r.error) said = `runner priority: could not set ${name}'s scheduled task ${r.task} from priority ${r.before} (${taskPriorityName(r.before)}) to ${TASK_PRIORITY} (Normal): ${r.error.slice(0, 200)}`;
      else if (r.before !== r.after) said = `runner priority: set ${name}'s scheduled task ${r.task} from priority ${r.before} (${taskPriorityName(r.before)}) to ${r.after} (${taskPriorityName(r.after)}), so a start through it runs its jobs at ${taskPriorityName(r.after)} (w6163)`;
      else if (r.after !== undefined && r.after <= TASK_PRIORITY) said = `runner priority: ${name}'s scheduled task ${r.task} runs at priority ${r.after} (${taskPriorityName(r.after)})`;
      else said = `runner priority: ${name}'s scheduled task ${r.task} runs at priority ${r.after} (${taskPriorityName(r.after)}), so a start through it runs its jobs at ${taskPriorityName(r.after)}${enforce ? '' : '; this machine only reports it'} (w6163)`;
      if (this.taskSaid.get(r.root.toLowerCase()) !== said) this.d.log(said);
      this.taskSaid.set(r.root.toLowerCase(), said);
    }
  }
}

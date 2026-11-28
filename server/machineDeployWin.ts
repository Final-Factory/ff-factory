import { spawn } from 'node:child_process';
import { DAEMON_ENDING_MARKER } from '../machine/freezeWatch.ts';
import { DAEMON_ALIVE, DAEMON_ALIVE_FRESH_S, SELF_REBOOT_STATE } from '../machine/selfReboot.ts';

/**
 * The Windows half of server/machineDeploy.ts (docs/machines.md, "Windows machines"): the PowerShell scripts
 * that probe a Windows PC over ssh, unpack the portal's code into the daemon's folder (%USERPROFILE%\.ff-factory, or
 * the machine's app_dir), write the
 * daemon's config and supervisor, and register the Task Scheduler task that runs the daemon in the user's
 * logged-on session. The script builders are pure (tested in machineDeployWin.test.ts); `psScript` runs one.
 *
 * How a script gets there: Windows OpenSSH Server hands the command line to its default shell, cmd.exe or
 * PowerShell, which quote differently. So the command line is only `powershell.exe ... -EncodedCommand <b64>`
 * (letters, digits, + / =: the same under either shell), a small bootstrap that reads the real script from
 * stdin as UTF-8 and runs it. A small payload may follow the script on stdin after a `#FFDATA` line and
 * reaches the script as $FFData, so nothing binary crosses a PowerShell pipe; the code bundle goes by scp.
 *
 * Under cmd.exe the nested powershell.exe reads ssh's stdin as is. Under PowerShell as the default shell, the
 * outer PowerShell passes stdin on to it as lines of text, with CRLF endings and possibly re-encoded. So the
 * bootstrap turns CRLF back into LF, the scripts are pure ASCII (psq), the payload is base64, and an empty
 * script is an error rather than a silent success. The script ends with END_MARK and the bootstrap reads up to it,
 * never waiting for EOF.
 */

export const TASK_NAME = 'FFFactoryDaemon';

/**
 * Which daemon install a script acts on (w513): its scheduled task's name (default TASK_NAME), and `only`: stop daemons
 * running from its own folder alone. A worker root install (scripts/worker) sets both, so a second install on the same
 * PC (a test root) never stops or replaces the machine's other daemon, which runs from the default folder.
 */
export interface WinService {
  task?: string;
  only?: boolean;
}

/** The task name of `service`, checked: it is spliced into PowerShell and task XML. Exported for tests. */
export function taskName(service?: WinService): string {
  const t = service?.task ?? TASK_NAME;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t)) throw new Error(`"${t}" is not a usable scheduled task name`);
  return t;
}
/** A script run over ssh: its exit code (-1 when it could not start or was killed), output, and whether the timeout killed it. */
export interface RemoteResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
/** What separates the script from its payload on stdin. */
export const DATA_MARK = '\n#FFDATA\n';

/**
 * A PowerShell string literal, single-quoted, and pure ASCII: a character beyond ASCII (a user name such as
 * Björn in a path) is spelled [char]0x00F6, so the script survives any re-encoding on the way in (below).
 */
export function psq(s: string): string {
  const q = (t: string) => `'${t.replace(/'/g, "''")}'`;
  if (!/[^\x00-\x7f]/.test(s)) return q(s);
  const parts: string[] = [];
  let run = '';
  for (const ch of s) {
    if (ch.charCodeAt(0) < 0x80) {
      run += ch;
      continue;
    }
    if (run) parts.push(q(run));
    run = '';
    for (let i = 0; i < ch.length; i++) parts.push(`[char]0x${ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`);
  }
  if (run) parts.push(q(run));
  return `([string]${parts.join(' + ')})`;
}

/**
 * What ends the script (and its payload) on stdin. The bootstrap stops reading there instead of waiting for EOF:
 * on some PCs (Windows 11 with cmd.exe as sshd's default shell) reading stdin to EOF never returns once more
 * than a few KB came in, so the probe hung until its timeout with no output at all.
 */
export const END_MARK = '\n#FFEND\n';

/**
 * The bootstrap run by -EncodedCommand: read stdin (UTF-8) up to END_MARK, split off the payload, run the
 * script; any error exits 1, a script that arrived without its end mark (cut off) exits 3.
 */
export const BOOTSTRAP = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$ms = New-Object IO.MemoryStream',
  '$in = [Console]::OpenStandardInput(); $buf = New-Object byte[] 65536',
  "while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n); $k = [int][Math]::Min($ms.Length, 32); if ([Text.Encoding]::ASCII.GetString($ms.GetBuffer(), [int]$ms.Length - $k, $k).TrimEnd().EndsWith('#FFEND')) { break } }",
  '$all = [Text.Encoding]::UTF8.GetString($ms.ToArray()).Replace([string][char]13 + [char]10, [string][char]10).TrimEnd()',
  "if ($all.Trim() -and -not $all.EndsWith('#FFEND')) { [Console]::Error.WriteLine('the script arrived without its end mark after ' + $ms.Length + ' bytes: cut off on the way'); exit 3 }",
  "if ($all.EndsWith('#FFEND')) { $all = $all.Substring(0, $all.Length - 6).TrimEnd() }",
  "if (-not $all.Trim()) { [Console]::Error.WriteLine('no script arrived on stdin'); exit 3 }",
  "$FFData = ''",
  '$i = $all.IndexOf([string][char]10 + "#FFDATA" + [char]10)',
  'if ($i -ge 0) { $FFData = $all.Substring($i + 9); $all = $all.Substring(0, $i) }',
  'try { & ([scriptblock]::Create($all)) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  'exit 0',
].join('\n');

/** The ssh command line that runs a script fed on stdin under either default shell. */
export function psCommand(): string[] {
  const encoded = Buffer.from(BOOTSTRAP, 'utf16le').toString('base64');
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

/** What goes to the bootstrap on stdin: the script, its payload after DATA_MARK, then END_MARK. */
export function stdinOf(script: string, data?: string): string {
  return (data === undefined ? script : script + DATA_MARK + data) + END_MARK;
}

/** Why a remote run failed, in one line: its exit code (or the timeout that killed it), then stderr and stdout. */
export function failureDetail(r: { code: number; stdout: string; stderr: string; timedOut?: boolean }): string {
  const tail = (t: string) => t.trim().split('\n').slice(-6).join(' | ');
  return [
    r.timedOut ? `timed out and killed (code ${r.code})` : `exit code ${r.code}`,
    r.stderr.trim() ? `stderr: ${tail(r.stderr)}` : 'no stderr',
    r.stdout.trim() ? `stdout: ${tail(r.stdout)}` : 'no stdout',
  ].join('; ');
}

/**
 * Where a script runs: a Windows PC over ssh (its host alias), or this computer itself (LOCAL: the portal's own host
 * as a machine, docs/beast-machine.md), where the same bootstrap is started directly, as this server's user.
 */
export const LOCAL = { local: true } as const;
export type Target = string | typeof LOCAL;
export const isLocal = (t: Target): t is typeof LOCAL => typeof t !== 'string';
export const targetName = (t: Target) => (isLocal(t) ? 'this host' : t);

/** The program and arguments that run a script fed on stdin: ssh to the host, or PowerShell here. Exported for tests. */
export function scriptCommand(target: Target): [string, string[]] {
  const [ps, ...args] = psCommand();
  return isLocal(target) ? [ps, args] : ['ssh', [...SSH, target, ps, ...args]];
}

/** Run a PowerShell script on a Windows `host` over ssh (or here, for LOCAL), with an optional payload ($FFData in the script). */
export function psScript(host: Target, script: string, opts: { timeoutMs?: number; data?: string } = {}): Promise<RemoteResult> {
  return new Promise((resolve) => {
    const [cmd, args] = scriptCommand(host);
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 120_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.replace(/\r\n/g, '\n'), stderr: stderr.replace(/\r\n/g, '\n'), timedOut });
    });
    child.stdin.on('error', () => undefined); // ssh gone early: its exit code says why
    child.stdin.end(stdinOf(script, opts.data));
  });
}

/** Run a native program with its output as text, without PowerShell 5.1 turning its stderr into a terminating error. */
const NATIVE = `
function Invoke-Native([string]$Exe, [string[]]$Argv) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & $Exe @Argv 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
  [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out -join [string][char]10) }
}`;

/**
 * The processes Stop-FFDaemon ends: those whose command line names a mark, and everything below them, except this
 * PowerShell, the kept agent hosts, and a Unity editor or Hub and what those started. A child is a process whose
 * ParentProcessId is the parent's id AND that started no earlier than the parent: Windows never clears a dead parent's
 * id and reuses ids. On a GitHub runner wininit.exe's parent id names no process (w906, measured), so a process of ours
 * that drew that id would "have" wininit as a child, and the walk would end services.exe's tree with the runner's own
 * processes in it (and on a PC, whatever a reused id reaches).
 */
export const KILL_SET = `
function Get-FFKillSet($all, $marks, $hosts, [bool]$Agents) {
  $born = @{}
  foreach ($p in $all) { $born[[int]$p.ProcessId] = $p.CreationDate }
  $queue = New-Object System.Collections.Generic.Queue[int]
  $keep = New-Object System.Collections.Generic.HashSet[int]
  foreach ($p in $all) {
    $c = [string]$p.CommandLine
    foreach ($m in $marks) { if ($c.IndexOf($m, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $queue.Enqueue([int]$p.ProcessId) } }
    if (-not $Agents) { foreach ($h in $hosts) { if ($c.IndexOf($h, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $null = $keep.Add([int]$p.ProcessId) } } }
  }
  $kill = New-Object System.Collections.Generic.List[int]
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    if ($kill.Contains($id) -or $id -eq $PID -or $keep.Contains($id)) { continue }
    $kill.Add($id)
    foreach ($p in $all) {
      $older = $born[$id] -and (-not $p.CreationDate -or $p.CreationDate -lt $born[$id])
      if ([int]$p.ParentProcessId -eq $id -and -not $older -and [string]$p.Name -notmatch '^Unity( Hub)?\\.exe$') { $queue.Enqueue([int]$p.ProcessId) }
    }
  }
  ,$kill
}`;

/**
 * Stop the daemon: end the task, then kill the supervisor and the daemon with everything they started, except a Unity
 * editor or Unity Hub and what those started (the editor is the user's and outlives a daemon restart, as on a Mac) and,
 * unless -Agents, the agent hosts and what they run (w605: the agents, their shells and players outlive a reinstall or
 * restart, and the next daemon takes them back; machine/agentHost.ts). -Agents (a stop, the uninstall) ends those too,
 * a previous daemon's included. The task is disabled meanwhile so its restart-on-failure does not bring it back.
 */
const stopFns = (task: string) => `
${KILL_SET}
function Stop-FFDaemon([switch]$Agents) {
  $task = Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue
  if ($task) { $null = $task | Disable-ScheduledTask -ErrorAction SilentlyContinue; $task | Stop-ScheduledTask -ErrorAction SilentlyContinue }
  $marks = @(); $hosts = @()
  foreach ($d in $FFDirs) { $marks += (Join-Path $d 'app\\machine\\daemon.ts'); $marks += (Join-Path $d 'run-daemon.ps1'); $hosts += (Join-Path $d 'app\\machine\\agentHost.ts') }
  if ($Agents) { $marks += $hosts }
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate)
  $kill = Get-FFKillSet $all $marks $hosts $Agents.IsPresent
  $refused = New-Object System.Collections.Generic.HashSet[int]
  foreach ($id in $kill) { try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $null = $refused.Add($id) } } }
  for ($i = 0; $i -lt 30; $i++) {
    if (-not @($kill | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count) { break }
    if ($i -eq 10) { foreach ($id in $kill) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }
    Start-Sleep -Milliseconds 500
  }
  if ($task) { $null = $task | Enable-ScheduledTask -ErrorAction SilentlyContinue }
  # A survivor would answer beside the daemon started next (w1918: three daemons on LothLaptop): fail, naming it, instead.
  # w6784: except one that took its TerminateProcess and is still there 15 s later: it is stuck mid-exit in the kernel and runs
  # no code of its own again (BEAST, 2026-11-28: pid 16100 for hours), so it cannot answer; it is named and passed.
  $left = @($kill | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  $script:FFStuck = @($left | Where-Object { -not $refused.Contains($_) })
  $left = @($left | Where-Object { $refused.Contains($_) })
  if ($left.Count) { throw "the old daemon did not stop: pid(s) $($left -join ', ') refused Stop-Process and still run 15 s later; nothing new was started beside them" }
  $kill.Count
}

# w6784: a PowerShell snippet in a child, its answer if it ends within $Ms, else nothing: a child stuck in a WMI call is
# left behind (TerminateProcess asked, never waited on) instead of holding this script up. Its output goes through a file, as
# a pipe a stuck child holds would block the read.
function Invoke-FFBounded([string]$Script, [int]$Ms) {
  $o = Join-Path $F ('logs\\bounded-' + $PID + '-' + [guid]::NewGuid().ToString('N') + '.txt')
  try {
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    $c = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $enc) -NoNewWindow -PassThru -RedirectStandardOutput $o
    if ($c.WaitForExit($Ms)) { return ([string](Get-Content -LiteralPath $o -Raw -ErrorAction SilentlyContinue)).Trim() }
    try { $c.Kill() } catch { }
    ''
  } catch { '' } finally { Remove-Item -LiteralPath $o -Force -ErrorAction SilentlyContinue }
}

function Start-FFDaemon {
  Start-ScheduledTask -TaskName '${task}'
}

function Test-FFLoggedOn {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'")) {
    $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($o -and $o.Sid -eq $me) { return $true }
  }
  $false
}`;

/** A Windows folder as the scripts and command lines spell it: backslashes, no trailing one (but C:\ keeps its own). */
export const winDir = (p: string) => p.replace(/\//g, '\\').replace(/(?<![:\\])\\+$/, '');

/** The daemon's folder as a PowerShell expression: the machine's app_dir, else %USERPROFILE%\.ff-factory. */
export function appDirExpr(appDir?: string): string {
  return appDir ? psq(winDir(appDir)) : "(Join-Path $env:USERPROFILE '.ff-factory')";
}

/**
 * The shared head of every script: stop on errors, the helpers, $F (the daemon's folder) and $FFDirs (every folder
 * a daemon of ours may run from, for Stop-FFDaemon: $F, the default one, and the previous deploy's, so a deploy
 * that moves the folder still stops the old daemon).
 */
function head(dirs: { appDir?: string; previous?: string; service?: WinService } = {}): string {
  const prev = dirs.previous && dirs.previous !== dirs.appDir ? `, ${appDirExpr(dirs.previous)}` : '';
  const others = dirs.service?.only ? '' : `, ${appDirExpr()}${prev}`;
  return `$ErrorActionPreference = 'Stop'\n${NATIVE}\n${stopFns(taskName(dirs.service))}\n$F = ${appDirExpr(dirs.appDir)}\n$FFDirs = @(@($F${others}) | Select-Object -Unique)\n`;
}

/**
 * Probe a Windows PC: its user (SID for the task), home, OS, the newest node (PATH and the usual installers:
 * nodejs.org, nvm-windows, Volta, fnm, Scoop), Claude Code, git and the clones of `slug` under the home folder
 * and near the top of each fixed drive (no `slug`: no search, for a deploy that already knows its clone). One
 * `key=value` per line, as the Mac probe prints.
 */
export function probeScript(slug: string): string {
  if (slug && !/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error(`"${slug}" is not an owner/name repo slug`);
  return `${head()}
$ErrorActionPreference = 'Continue'
# A value beyond ASCII (a path with an accented user name) goes as base64: the output may be re-encoded on its way back.
function Emit($k, $v) {
  $s = [string]$v
  if (-not $s) { return }
  if ($s -match '[^\x00-\x7F]') { [Console]::Out.WriteLine($k + '~b64=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))) } else { [Console]::Out.WriteLine($k + '=' + $s) }
}
Emit 'platform' 'win32'
Emit 'home' $env:USERPROFILE
Emit 'user' ($env:USERDOMAIN + '\\' + $env:USERNAME)
Emit 'sid' ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
Emit 'os' ((Get-CimInstance Win32_OperatingSystem).Caption + ' ' + [Environment]::OSVersion.Version)
Emit 'loggedOn' ([string](Test-FFLoggedOn))
Emit 'tar' ([string](Test-Path (Join-Path $env:SystemRoot 'System32\\tar.exe')))
$cands = New-Object System.Collections.Generic.List[string]
foreach ($c in @(Get-Command node.exe -All -ErrorAction SilentlyContinue)) { $cands.Add($c.Source) }
$pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$globs = @(
  (Join-Path $env:ProgramFiles 'nodejs\\node.exe'),
  $(if ($pf86) { Join-Path $pf86 'nodejs\\node.exe' }),
  (Join-Path $env:LOCALAPPDATA 'Programs\\nodejs\\node.exe'),
  $(if ($env:NVM_HOME) { Join-Path $env:NVM_HOME 'v*\\node.exe' }),
  (Join-Path $env:APPDATA 'nvm\\v*\\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Volta\\tools\\image\\node\\*\\node.exe'),
  (Join-Path $env:APPDATA 'fnm\\node-versions\\*\\installation\\node.exe'),
  (Join-Path $env:USERPROFILE 'scoop\\apps\\nodejs*\\current\\node.exe')
)
foreach ($g in $globs) { if ($g) { foreach ($p in @(Resolve-Path $g -ErrorAction SilentlyContinue)) { $cands.Add($p.Path) } } }
$best = ''; $bestv = [version]'0.0'
foreach ($n in @($cands | Select-Object -Unique)) {
  if (-not $n -or -not (Test-Path -LiteralPath $n)) { continue }
  # "$(...)", not [string](...): Windows PowerShell casts a pipeline with no output to $null, and .Trim() on it throws.
  # (& ...) first, then the first line: Select-Object -First 1 inside the pipeline ends node as it exits (w906).
  $v = "$((& $n -p 'process.versions.node' 2>$null) | Select-Object -First 1)"
  $pv = $null
  if ([version]::TryParse($v.Trim(), [ref]$pv) -and $pv -gt $bestv) { $best = $n; $bestv = $pv }
}
Emit 'node' $best
if ($best) { Emit 'nodev' $bestv.ToString() }
# Claude Code: the native claude.exe (the SDK can start it; an npm claude.cmd shim it cannot, so then the SDK's own).
$claude = ''
foreach ($c in @((Join-Path $env:USERPROFILE '.local\\bin\\claude.exe')) + @(Get-Command claude.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })) {
  if ($c -and (Test-Path -LiteralPath $c)) { $claude = $c; break }
}
Emit 'claude' $claude
if (-not $claude) { Emit 'claudeShim' (Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Source }) }
$git = Get-Command git.exe -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Source }
if (-not $git) { foreach ($g in @((Join-Path $env:ProgramFiles 'Git\\cmd\\git.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\\Git\\cmd\\git.exe'))) { if (Test-Path -LiteralPath $g) { $git = $g; break } } }
Emit 'git' $git
Emit 'gh' (Get-Command gh.exe -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Source })
$slug = ${psq(slug)}
if ($git -and $slug) {
  $want = '[:/]' + [regex]::Escape($slug) + '(\\.git)?/?$'
  $roots = @(@{ Path = $env:USERPROFILE; Depth = 3 })
  foreach ($d in [IO.DriveInfo]::GetDrives()) { if ($d.DriveType -eq 'Fixed' -and $d.IsReady) { $roots += @{ Path = $d.RootDirectory.FullName; Depth = 2 } } }
  $seen = @{}
  $appData = (Join-Path $env:USERPROFILE 'AppData') + '\\'
  foreach ($r in $roots) {
    foreach ($g in @(Get-ChildItem -LiteralPath $r.Path -Directory -Force -Recurse -Depth $r.Depth -Filter '.git' -ErrorAction SilentlyContinue)) {
      $repo = $g.Parent.FullName
      if ($seen.ContainsKey($repo) -or $repo.StartsWith($appData, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $seen[$repo] = $true
      # A repo without an origin prints nothing: "$(...)" keeps that an empty string (BEAST, w424: the probe died on one).
      $u = "$((& $git -C $repo remote get-url origin 2>$null) | Select-Object -First 1)"
      if ($u.Trim() -match $want) { Emit 'repo' $repo }
    }
  }
}
`;
}

/**
 * The read fence's give-back label (machine/lowIntegrity.ts READ_BACK.dir, the default policy written out) on a folder,
 * for app.new while it is staged (w5980). Under the read fence `on`, the daemon's folder carries No-Read-Up, and app.new,
 * made inside it, inherits that; the rename to app keeps app.new's own descriptor, so Low workers were refused the new app
 * (the gh shim: "Cannot find module ...\\machine\\ghApp.ts") until the restarted daemon's label pass gave it back, 4-8
 * minutes later (measured on BEAST and LothDesktop, 2026-11-26). Set before tar unpacks, so every file inherits it as it
 * is made. Harmless with the fence off: it is what a Medium folder has anyway. A failure is said, never fatal: the
 * daemon's own pass still gives it back. Never on the system drive, by its path or the real one a junction leads to
 * (as machine/lowIntegrity.ts onSystemDrive): the fence labels nothing there.
 */
export function readBackScript(folderVar: string): string {
  return `try {
  if (-not ('FfStageLabel' -as [type])) {
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class FfStageLabel {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint rev, out IntPtr sd, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] public static extern uint SetNamedSecurityInfoW(string path, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetFinalPathNameByHandleW(IntPtr h, System.Text.StringBuilder buf, uint size, uint flags);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static string RealPath(string path) {
    IntPtr h = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return null;
    try { var b = new System.Text.StringBuilder(1024); uint n = GetFinalPathNameByHandleW(h, b, 1024, 0); return n > 0 && n < 1024 ? b.ToString() : null; } finally { CloseHandle(h); }
  }
  public static uint Set(string path, string sddl) {
    IntPtr sd; if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, IntPtr.Zero)) return (uint)Marshal.GetLastWin32Error();
    try { bool p, d; IntPtr sacl; if (!GetSecurityDescriptorSacl(sd, out p, out sacl, out d)) return (uint)Marshal.GetLastWin32Error();
      return SetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl); } finally { LocalFree(sd); }
  }
}
"@
  }
  $sysDrive = if ($env:SystemDrive) { $env:SystemDrive.Substring(0, 2) } else { 'C:' }
  $realPath = [FfStageLabel]::RealPath(${folderVar})
  if (-not $realPath) { Write-Output "read-back label on $(${folderVar}) skipped: its real path is unknown" }
  elseif (([IO.Path]::GetFullPath(${folderVar})).Substring(0, 2) -ieq $sysDrive -or $realPath.TrimStart([char[]]'\\?').Substring(0, 2) -ieq $sysDrive) {
    Write-Output "read-back label on $(${folderVar}) skipped: on the system drive, which the read fence never labels"
  } else {
    $lr = [FfStageLabel]::Set(${folderVar}, 'S:(ML;OICI;NW;;;ME)')
    if ($lr -ne 0) { Write-Output "read-back label on $(${folderVar}) not set ($lr): the daemon's start gives it back" }
  }
} catch { Write-Output "read-back label on $(${folderVar}) not set: $($_.Exception.Message)" }`;
}

/**
 * Unpack the code bundle (a .tar.gz) into app.new in the daemon's folder with Windows' own tar. The bundle is
 * `file`, copied there by scp (a path, or a name in the user's home, where scp puts it; deleted after), else
 * $FFData (base64). The deploy uses scp: on some PCs stdin through sshd stalls after ~200 KB (END_MARK above).
 */
export function uploadScript(appDir?: string, file?: string): string {
  const from = file
    ? `$tgz = ${psq(file)}
if (-not [IO.Path]::IsPathRooted($tgz)) { $tgz = Join-Path $env:USERPROFILE $tgz }
if (-not (Test-Path -LiteralPath $tgz)) { throw "the code bundle $tgz did not arrive" }`
    : `$tgz = Join-Path $F 'app.tgz'
[IO.File]::WriteAllBytes($tgz, [Convert]::FromBase64String($FFData.Trim()))`;
  return `${head({ appDir })}
$new = Join-Path $F 'app.new'
if (Test-Path -LiteralPath $new) { Remove-Item -LiteralPath $new -Recurse -Force }
New-Item -ItemType Directory -Force $new, (Join-Path $F 'logs') | Out-Null
${readBackScript('$new')}
${from}
# System32's bsdtar, not a Git or MSYS tar on the PATH (those read C: as a remote host).
$r = Invoke-Native (Join-Path $env:SystemRoot 'System32\\tar.exe') @('-xzf', $tgz, '-C', $new)
Remove-Item -LiteralPath $tgz -Force
if ($r.Code -ne 0) { throw "tar failed ($($r.Code)): $($r.Out)" }
`;
}

/** Stamp the version and install the production dependencies with the chosen node's own npm. */
export function npmScript(node: string, version: string, appDir?: string): string {
  return `${head({ appDir })}
$app = Join-Path $F 'app.new'
Set-Location -LiteralPath $app
[IO.File]::WriteAllText((Join-Path $app 'machine\\VERSION'), ${psq(version)} + [char]10)
$nodeDir = Split-Path -Parent ${psq(node)}
$env:Path = $nodeDir + ';' + $env:Path
$npm = Join-Path $nodeDir 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) { $npm = 'npm.cmd' }
$r = Invoke-Native $npm @('ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error')
if ($r.Code -ne 0) { throw "npm ci failed ($($r.Code)): $($r.Out)" }
`;
}

/**
 * The supervisor the task runs (hidden): starts the daemon, and again whenever it exits, backing off when it
 * keeps dying quickly, like the portal's own scripts/supervise.ps1. The daemon's output goes to
 * logs\daemon.log and daemon.err.log; before each start the last run's are moved to daemon.log.<UTC stamp> (w2038), which
 * the daemon gzips and prunes (machine/logRetention.ts).
 */
/** w6784: a daemon that wrote its ending marker and is still running this long after is logged as stuck mid-exit. */
export const SUPERVISOR_STUCK_AFTER_S = 120;
/** w6784: the supervisor's own state ({pid, daemonPid, abandoned, at}), rewritten every 5 s step, in logs. */
export const SUPERVISOR_STATE = 'supervisor.json';
/** w6784: a restart asked of a live supervisor ({why, at}), in logs; it takes the file away and acts once. */
export const SUPERVISOR_REQUEST = 'daemon-restart-request.json';
/** w6784: this file in the daemon's folder turns the stage-2 recovery off: a daemon stuck mid-exit is only logged. */
export const SUPERVISOR_WARN_ONLY = 'supervisor-warn-only';
/** w6784: a supervisor whose state file is older than this is not live (it rewrites it every 5 s step). */
export const SUPERVISOR_FRESH_S = 30;
/** w6784: how long a start or restart waits for a live supervisor to start a fresh daemon (15 s to end the old one, then the start). */
export const SUPERVISOR_ANSWER_S = 60;
/** w6784: how long a start waits for the task's state before it goes on without it. */
export const TASK_STATE_WAIT_MS = 15_000;
/**
 * w6792: a stuck episode (a daemon stuck mid-exit, w6784) that no working daemon has ended this long after it began lets an
 * eligible machine reboot itself (lothsahn, 2026-11-28: "If the daemon is stuck, can we reboot after 15minutes?").
 */
export const SUPERVISOR_REBOOT_AFTER_S = 900;
/** w6792: no reboot while the console had keyboard or mouse input this recently: someone may be at the machine. */
export const SUPERVISOR_REBOOT_IDLE_S = 1800;
/** w6792: at most one automatic reboot per machine in this long. */
export const SUPERVISOR_REBOOT_EVERY_S = 6 * 3600;
/** w6792: how often the supervisor reads again whether this machine may reboot itself (never during a stuck episode). */
export const SUPERVISOR_ELIGIBLE_EVERY_S = 3600;
/**
 * w6792: a boot whose user logon came this soon after it started, and within SUPERVISOR_AUTOLOGON_CONNECT_S of the console
 * connecting, logged on by itself (BEAST, 2026-11-28: 11 s after boot, 2.3 s after the console connected); with
 * AutoAdminLogon still 1 after it, Winlogon found the stored password, which only an administrator can check directly.
 */
export const SUPERVISOR_AUTOLOGON_BOOT_S = 120;
export const SUPERVISOR_AUTOLOGON_CONNECT_S = 5;
/** w6792: this file in the daemon's folder turns the automatic reboot off: a stuck episode is only logged. */
export const SUPERVISOR_NO_REBOOT = 'supervisor-no-reboot';
/**
 * w6792, lothsahn's lockout rule: warn only first. False: the supervisor logs "would reboot now" and tells the portal, and
 * its script has no way to reboot at all; the live route comes in its own reviewed PR once the warn lines look right.
 */
export const SUPERVISOR_REBOOT_LIVE = false;

/**
 * w6792: the helper the supervisor compiles (Add-Type, off its loop) to read the console's last input, the uptime, which
 * session has the console and the logon session's times. It reads; it changes nothing.
 */
const SELF_REBOOT_NATIVE = `using System;
using System.Runtime.InteropServices;
public static class FFSelfReboot {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
  public static long IdleMs() { LASTINPUTINFO i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) return -1; return (long)unchecked((uint)Environment.TickCount - i.dwTime); }
  public static long UptimeMs() { return (long)GetTickCount64(); }
  public static int ConsoleSession() { return unchecked((int)WTSGetActiveConsoleSessionId()); }
  // WTSSessionInfo (24): WTSINFOW's ConnectTime and LogonTime (FILETIME, UTC) at bytes 176 and 200; empty when unreadable.
  public static long[] SessionTimes(int session) {
    IntPtr b; int n;
    if (!WTSQuerySessionInformationW(IntPtr.Zero, session, 24, out b, out n)) return new long[0];
    try { if (n < 216) return new long[0]; return new long[] { Marshal.ReadInt64(b, 176), Marshal.ReadInt64(b, 200) }; } finally { WTSFreeMemory(b); }
  }
}`;

/**
 * w6792: whether this machine comes back by itself after a reboot, detected, never configured by name: automatic logon on
 * (Winlogon AutoAdminLogon 1) to the daemon's own user (DefaultUserName, or a Microsoft account's address, matched by SID;
 * AutoLogonSID, when there, this user's), a stored password for it, and the daemon's logon task. The password's value is
 * never read: a DefaultPassword value counts by its name; one in the LSA (Sysinternals Autologon, netplwiz), which only an
 * administrator can see, counts when the last boot logged this user on by itself and AutoAdminLogon stayed 1 (Winlogon
 * turns it off when it finds no password). Run in a runspace by the supervisor (params: task name, the FFSelfReboot source,
 * the last answer about the task, SUPERVISOR_AUTOLOGON_BOOT_S, SUPERVISOR_AUTOLOGON_CONNECT_S); answers {eligible, why, task}.
 * Its readers come first, so a test can define fakes after them (the line ELIG_READERS_END).
 */
export const ELIG_READERS_END = '# (the readers above; what they answer decides below)';
export function selfRebootEligibilityScript(): string {
  return `param($taskName, $native, $prevTask, $bootS, $connectS)
try { if (-not ('FFSelfReboot' -as [type])) { Add-Type -TypeDefinition $native -ErrorAction Stop } } catch { }
# Each value by its name: the stored password's value is never read, only whether its name is there.
function Read-Winlogon {
  $k = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon')
  if (-not $k) { return $null }
  try { @{ names = @($k.GetValueNames()); auto = [string]$k.GetValue('AutoAdminLogon'); user = [string]$k.GetValue('DefaultUserName'); domain = [string]$k.GetValue('DefaultDomainName'); autoSid = [string]$k.GetValue('AutoLogonSID') } } finally { $k.Close() }
}
function Read-Who {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  @{ name = $me.Name; sid = $me.User.Value; groups = @($me.Groups | ForEach-Object { $_.Value }); user = $env:USERNAME; domain = $env:USERDOMAIN; computer = $env:COMPUTERNAME }
}
function Read-Sid($domain, $user) {
  $a = if ($domain) { New-Object Security.Principal.NTAccount($domain, $user) } else { New-Object Security.Principal.NTAccount($user) }
  $a.Translate([Security.Principal.SecurityIdentifier]).Value
}
# This session's logon: seconds after the boot and after the console connected, or $null.
function Read-Logon {
  $t = [FFSelfReboot]::SessionTimes([Diagnostics.Process]::GetCurrentProcess().SessionId)
  if ($t.Count -ne 2 -or $t[1] -le 0) { return $null }
  $boot = (Get-Date).ToUniversalTime().AddMilliseconds(-[FFSelfReboot]::UptimeMs())
  $logon = [DateTime]::FromFileTimeUtc($t[1])
  @(($logon - $boot).TotalSeconds, ($logon - [DateTime]::FromFileTimeUtc($t[0])).TotalSeconds)
}
# The logon task: $true when schtasks finds it, else what schtasks said, or $null when the Task Scheduler does not answer in
# 15 s (it hung on BEAST, w6784).
function Read-Task {
  $psi = New-Object Diagnostics.ProcessStartInfo 'schtasks.exe', ('/query /tn "' + $taskName + '"')
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $q = [Diagnostics.Process]::Start($psi)
  $o = $q.StandardOutput.ReadToEndAsync(); $e = $q.StandardError.ReadToEndAsync()
  if ($q.WaitForExit(15000)) {
    if ($q.ExitCode -eq 0) { return $true }
    $said = (([string]$e.Result) + ' ' + ([string]$o.Result)).Trim() -replace '\\s+', ' '
    if (-not $said) { $said = "exit code $($q.ExitCode)" }
    return $said
  }
  try { $q.Kill() } catch { }
  $null
}
${ELIG_READERS_END}
function No($why, $task = $prevTask) { [pscustomobject]@{ eligible = $false; why = $why; task = $task } }
$w = $null
try { $w = Read-Winlogon } catch { }
if (-not $w) { return No 'the Winlogon key could not be read' }
if ($w.auto -ne '1') { return No "automatic logon is off (Winlogon AutoAdminLogon is '$($w.auto)', not 1)" }
$me = Read-Who
if ($w.autoSid -and $w.autoSid -ne $me.sid) { return No "automatic logon is for another account (Winlogon AutoLogonSID is not this daemon's user, $($me.name))" }
# DefaultUserName: a local or domain account's name, or a Microsoft account's address (domain MicrosoftAccount), which this
# user's token carries as a group (S-1-11-96-...): matched by SID, so a Microsoft account matches the local user it signs in as.
$match = $false
if ($w.user) {
  if ($w.user -ieq $me.user -and (-not $w.domain -or $w.domain -ieq $me.domain -or $w.domain -ieq $me.computer)) { $match = $true }
  else { try { $sid = Read-Sid $w.domain $w.user; $match = $sid -eq $me.sid -or $me.groups -contains $sid } catch { } }
}
if (-not $match) { return No "automatic logon names another account than this daemon's user ($($me.name))" }
$secret = $null
if ($w.names -contains 'DefaultPassword') { $secret = 'its password stored (a DefaultPassword value, not read)' }
else {
  $l = $null
  try { $l = Read-Logon } catch { }
  if ($l -and $l[0] -le $bootS -and $l[1] -ge 0 -and $l[1] -le $connectS) { $secret = "its password stored (the last boot logged this user on by itself $([int]$l[0]) s after it started, $([Math]::Round($l[1], 1)) s after the console connected, and AutoAdminLogon stayed 1)" }
  else {
    $seen = if ($l) { "this user's logon came $([int]$l[0]) s after the last boot and $([Math]::Round($l[1], 1)) s after the console connected (by itself: within $bootS s and $connectS s)" } else { "this session's logon times could not be read" }
    return No "no stored password for automatic logon can be seen: no DefaultPassword value, and $seen; one in the LSA only an administrator can check"
  }
}
$task = $prevTask
$said = $null
try { $t = Read-Task; if ($t -is [string]) { $said = $t; $task = $false } elseif ($null -ne $t) { $task = [bool]$t } } catch { $said = $_.Exception.Message; $task = $false }
if ($null -eq $task) { return No "the Task Scheduler did not say in 15 s whether the $taskName logon task is there" $null }
if (-not $task) { return No "schtasks finds no $taskName logon task ($(if ($said) { $said } else { 'the last answer' })), so the daemon would not start after a reboot" $false }
[pscustomobject]@{ eligible = $true; why = "automatic logon to this daemon's user ($($me.name)), $secret, and the $taskName logon task"; task = $true }
`;
}

export function supervisorScript(node: string, flag: boolean, service?: WinService): string {
  const flags = [...(flag ? ['--experimental-strip-types'] : []), '--disable-warning=ExperimentalWarning'].join(' ');
  return `# FF Factory machine daemon supervisor (docs/machines.md), started at logon by the ${taskName(service)} task.
# Written by the portal's deploy into the daemon's folder (its own folder here); a redeploy replaces it.
$ErrorActionPreference = 'Continue'
$F = $PSScriptRoot
$app = Join-Path $F 'app'
$logs = Join-Path $F 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$node = ${psq(node)}
# node's own folder first, then Claude Code's native install, then what the user's environment has.
$env:Path = (Split-Path -Parent $node) + ';' + (Join-Path $env:USERPROFILE '.local\\bin') + ';' + $env:Path
$daemon = Join-Path $app 'machine\\daemon.ts'
$argv = ${psq(flags)} + ' "' + $daemon + '" "' + (Join-Path $F 'daemon.json') + '"'
$log = Join-Path $logs 'supervisor.log'
$delay = 10
$leftWaitS = 10
# w6784: the daemon writes this ({pid, at, why}; machine/freezeWatch.ts DAEMON_ENDING_MARKER) just before the freeze watch ends
# it and at every exit. A daemon that wrote it and is still not gone $stuckAfter s later is stuck mid-exit (BEAST, 2026-11-28
# 07:41Z: hours after its SIGKILL, with this supervisor waiting on it the whole time). The wait is in steps so it can act.
$marker = Join-Path $logs '${DAEMON_ENDING_MARKER}'
$stuckAfter = ${SUPERVISOR_STUCK_AFTER_S}
$waitStepMs = 5000
# w6784: this supervisor's own state, rewritten every step: a start or restart over ssh reads it to tell a live supervisor
# (then it asks this one, by the request file, and needs neither the Task Scheduler nor WMI, both hung on BEAST).
$state = Join-Path $logs '${SUPERVISOR_STATE}'
$request = Join-Path $logs '${SUPERVISOR_REQUEST}'
# w6784: this file in the daemon's folder keeps the stage-1 behaviour: a daemon stuck mid-exit is only logged, never left behind.
$warnOnly = Join-Path $F '${SUPERVISOR_WARN_ONLY}'
$abandoned = New-Object System.Collections.Generic.List[int]
# w6792: a stuck episode begins when a daemon is found stuck mid-exit and ends when the daemon running then says it works
# (its heartbeat, machine/selfReboot.ts, fresh and linked to the portal). One still going $rebootAfterS later reboots a machine
# that comes back by itself, unless someone used its console in the last $rebootIdleS or it rebooted itself in the last
# $rebootEveryS. $rebootLive false: it only says so ("would reboot now"), and this script has no way to reboot at all.
$rebootAfterS = ${SUPERVISOR_REBOOT_AFTER_S}
$rebootIdleS = ${SUPERVISOR_REBOOT_IDLE_S}
$rebootEveryS = ${SUPERVISOR_REBOOT_EVERY_S}
$eligEveryS = ${SUPERVISOR_ELIGIBLE_EVERY_S}
$rebootLive = $${SUPERVISOR_REBOOT_LIVE}
$rebootState = Join-Path $logs '${SELF_REBOOT_STATE}'
$aliveFile = Join-Path $logs '${DAEMON_ALIVE}'
$noReboot = Join-Path $F '${SUPERVISOR_NO_REBOOT}'
$stuckSince = $null
$stuckWhy = $null
$rebootSaid = $false
$skipSaid = $null
$skipNow = $null
$elig = $null
$eligPs = $null
$eligAsync = $null
$eligStarted = $null
$eligNext = [DateTime]::MinValue
$rebootLast = $null
$rebootLastLive = $null
function Say($line) { "$(Get-Date -Format s) $line" | Out-File $log -Append -Encoding utf8 }
# w6792: a state file another process reads, swapped in by ReplaceFile. Move-Item -Force deletes the old file before it moves the
# new one in, and a reader in between found none (CI's w6792 test). ReplaceFile narrows that gap but does not close it, and a
# reader can find the file busy while it runs (measured on BEAST, 3000 swaps against a reader: Move-Item 6184 reads found no
# file, ReplaceFile 3152 found none and 4608 found it busy), so every reader tries again (askSupervisor, the daemon's next tick).
function Put-File($tmp, $to) {
  if ([IO.File]::Exists($to)) { [IO.File]::Replace($tmp, $to, [NullString]::Value) } else { [IO.File]::Move($tmp, $to) }
}
function Beat($daemonPid) {
  $alive = @($abandoned | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  try { [pscustomobject]@{ pid = $PID; daemonPid = $daemonPid; abandoned = $alive; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath "$state.tmp" -Encoding utf8; Put-File "$state.tmp" $state } catch { }
}
# A restart asked over ssh (controlScript): its why, once; the file is taken away so each ask acts once.
function Take-Request {
  if (-not (Test-Path -LiteralPath $request)) { return $null }
  # One older than the asker's wait (an ask whose asker died before it could take it back, w6790) is dropped, never acted on.
  $age = 0
  try { $age = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $request).LastWriteTimeUtc).TotalSeconds } catch { }
  if ($age -gt ${SUPERVISOR_ANSWER_S}) { Remove-Item -LiteralPath $request -Force -ErrorAction SilentlyContinue; Say "dropped a restart request $([int]$age) s old: its asker gave up on it (w6784)"; return $null }
  $why = 'no reason given'
  try { $why = [string](Get-Content -LiteralPath $request -Raw -ErrorAction Stop | ConvertFrom-Json).why } catch { }
  Remove-Item -LiteralPath $request -Force -ErrorAction SilentlyContinue
  $why
}
# The daemon's output files: daemon.log, or daemon.held<N>.log while an abandoned daemon still holds the ones before (Windows
# keeps a stuck process's handles). Each run's output is kept under the time it closed (w2038) as daemon.log.<stamp>, whichever
# name it ran under; the daemon gzips and prunes those (machine/logRetention.ts).
function Rotate-Out($base) {
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmssfff'Z'")
  foreach ($f in @(Get-ChildItem -LiteralPath $logs -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "$base.log" -or $_.Name -match ('^' + [regex]::Escape($base) + '\\.held\\d+\\.log$') })) {
    try {
      if ($f.Length -gt 0) {
        $to = Join-Path $logs "$base.log.$stamp"
        $i = 0
        while ((Test-Path -LiteralPath $to) -or (Test-Path -LiteralPath ($to + '.gz'))) { $i++; $to = Join-Path $logs "$base.log.$stamp-$i" }
        Move-Item -LiteralPath $f.FullName -Destination $to -ErrorAction Stop
      } elseif ($f.Name -ne "$base.log") { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop }
    } catch { }
  }
  $name = "$base.log"
  for ($n = 1; (Test-Path -LiteralPath (Join-Path $logs $name)) -and (Get-Item -LiteralPath (Join-Path $logs $name)).Length -gt 0; $n++) { $name = "$base.held$n.log" }
  $name
}
# Ends the daemon and checks it went (w6785's review: the supervisor, not the daemon, owns the kill and its check). Answers
# whether it is gone. It ends it through the handle this supervisor holds from Start-Process (Process.Kill uses it), which has
# every access right, so a live daemon cannot refuse it (w6790: a refused Stop-Process must never leave a healthy daemon behind
# a fresh one); TerminateProcess on that handle fails only for a process already ending, which is the stuck case.
function Stop-Held($p) { $p.Kill() }
function End-Daemon($p) {
  try { Stop-Held $p } catch { Say "ending the daemon, pid $($p.Id), answered: $($_.Exception.Message) (it is already ending)" }
  $p.WaitForExit(15000)
}
# w6792: whether this machine may reboot itself, read off this loop in a runspace (selfRebootEligibilityScript: the registry,
# a SID lookup and schtasks could each block), at start and hourly but never during a stuck episode; its helper type, compiled
# there, is the process's, so the console checks below use it once it is in.
$nativeSrc = @'
${SELF_REBOOT_NATIVE}
'@
$eligCheck = @'
${selfRebootEligibilityScript()}'@
function To-Utc($v) { if ($v -is [DateTime]) { return $v.ToUniversalTime() }; [DateTime]::Parse([string]$v, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() }
function Iso($d) { if ($d) { $d.ToString('o') } }
function Idle-S { if ('FFSelfReboot' -as [type]) { [FFSelfReboot]::IdleMs() / 1000 } else { -1 } }
function Console-Why { if (-not ('FFSelfReboot' -as [type])) { return "which session has the console can't be read yet" }; $s = [Diagnostics.Process]::GetCurrentProcess().SessionId; $c = [FFSelfReboot]::ConsoleSession(); if ($c -ne $s) { "the console is session $c, not this daemon's session $s (someone else may be at it, or this session is remote)" } }
# What it saw and did, for the daemon to tell the portal (machine/selfReboot.ts); last and lastLiveAt outlive a reboot.
function Write-RebootState {
  $o = [ordered]@{ mode = $(if ($rebootLive) { 'live' } else { 'warn' }); why = 'not read yet' }
  if ($elig) { $o.eligible = [bool]$elig.eligible; $o.why = [string]$elig.why; $o.checkedAt = Iso $elig.at }
  if ($stuckSince) { $o.stuckSince = Iso $stuckSince }
  if ($rebootLast) { $o.last = $rebootLast }
  if ($skipNow) { $o.skip = $skipNow }
  if ($rebootLastLive) { $o.lastLiveAt = Iso $rebootLastLive }
  try { [pscustomobject]$o | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath "$rebootState.tmp" -Encoding utf8; Put-File "$rebootState.tmp" $rebootState } catch { }
}
try {
  $r0 = Get-Content -LiteralPath $rebootState -Raw -ErrorAction Stop | ConvertFrom-Json
  if ($r0.last) { $rebootLast = [pscustomobject]@{ at = Iso (To-Utc $r0.last.at); mode = [string]$r0.last.mode; why = [string]$r0.last.why; stuckSince = $(if ($r0.last.stuckSince) { Iso (To-Utc $r0.last.stuckSince) }) } }
  if ($r0.lastLiveAt) { $rebootLastLive = To-Utc $r0.lastLiveAt }
} catch { }
function Check-Eligible {
  if ($eligAsync) {
    if (-not $eligAsync.IsCompleted) {
      if (((Get-Date) - $eligStarted).TotalSeconds -gt 120) { Say "self-reboot: its eligibility check has not answered in 120 s; left, and tried again in $([int]($eligEveryS / 60)) min (w6792)"; $script:eligAsync = $null; $script:eligNext = (Get-Date).AddSeconds($eligEveryS) }
      return
    }
    $r = $null
    try { $r = @($eligPs.EndInvoke($eligAsync)) | Select-Object -Last 1 } catch { }
    if (-not $r) { $err = 'it answered nothing'; try { if ($eligPs.Streams.Error.Count) { $err = [string]$eligPs.Streams.Error[0] } } catch { }; $r = [pscustomobject]@{ eligible = $false; why = "its check failed: $err"; task = $null } }
    try { $eligPs.Dispose() } catch { }
    $script:eligAsync = $null
    $was = $elig
    $script:elig = [pscustomobject]@{ eligible = [bool]$r.eligible; why = [string]$r.why; task = $r.task; at = (Get-Date).ToUniversalTime() }
    if (-not $was -or $was.eligible -ne $elig.eligible -or $was.why -ne $elig.why) { Say "self-reboot: $(if ($elig.eligible) { 'eligible' } else { 'not eligible' }): $($elig.why); mode $(if ($rebootLive) { 'live' } else { 'warn only' }) (w6792)" }
    Write-RebootState
  }
  if ($stuckSince -or (Get-Date) -lt $eligNext) { return }
  $script:eligNext = (Get-Date).AddSeconds($eligEveryS)
  try {
    $script:eligPs = [powershell]::Create().AddScript($eligCheck).AddArgument('${taskName(service)}').AddArgument($nativeSrc).AddArgument($(if ($elig) { $elig.task })).AddArgument(${SUPERVISOR_AUTOLOGON_BOOT_S}).AddArgument(${SUPERVISOR_AUTOLOGON_CONNECT_S})
    $script:eligStarted = Get-Date
    $script:eligAsync = $eligPs.BeginInvoke()
  } catch { Say "self-reboot: its eligibility check could not start: $($_.Exception.Message) (w6792)" }
}
function Begin-Stuck($since, $why) {
  if ($stuckSince) { return }
  $script:stuckSince = $since
  $script:stuckWhy = $why
  $script:rebootSaid = $false
  $script:skipSaid = $null
  $script:skipNow = $null
  Say "self-reboot: a stuck episode began at $(Iso $since) ($why); with no working daemon by $(Iso $since.AddSeconds($rebootAfterS)) this machine $(if ($rebootLive) { 'reboots' } else { 'would reboot (warn only)' }) if it may (w6792)"
  Write-RebootState
}
function End-Stuck($line) {
  Say $line
  $script:stuckSince = $null
  $script:skipNow = $null
  Write-RebootState
}
# Why not to reboot now ({key, why}: logged once per key), or nothing.
function Reboot-Skip {
  if (Test-Path -LiteralPath $noReboot) { return @{ key = 'off'; why = "$noReboot turns it off" } }
  if (-not $elig) { return @{ key = 'unread'; why = 'whether this machine comes back by itself has not been read yet' } }
  if (-not $elig.eligible) { return @{ key = 'not eligible'; why = "this machine would not come back by itself: $($elig.why)" } }
  $c = Console-Why
  if ($c) { return @{ key = 'console'; why = $c } }
  $idle = Idle-S
  if ($idle -lt 0) { return @{ key = 'input'; why = "the console's last input can't be read" } }
  if ($idle -lt $rebootIdleS) { return @{ key = 'idle'; why = "the console had keyboard or mouse input $([int]($idle / 60)) min ago; it waits for $([int]($rebootIdleS / 60)) min with none" } }
  if ($rebootLastLive -and ((Get-Date).ToUniversalTime() - $rebootLastLive).TotalSeconds -lt $rebootEveryS) { return @{ key = 'rate'; why = "it rebooted itself at $(Iso $rebootLastLive), under $([int]($rebootEveryS / 3600)) h ago" } }
  $null
}
# Every step: the eligibility check's answer; a stuck episode ended by a working daemon, or held back, or answered. Its own
# failure is said once and never reaches w6784's loop, where a throw reads as "could not start" (w6809's review).
function Watch-Reboot($daemonPid) {
  try { Watch-RebootStep $daemonPid } catch { if (-not $watchFailSaid) { Say "self-reboot: its check failed: $($_.Exception.Message) (w6792)"; $script:watchFailSaid = $true } }
}
function Watch-RebootStep($daemonPid) {
  Check-Eligible
  if (-not $stuckSince) { return }
  $mins = [int](((Get-Date).ToUniversalTime() - $stuckSince).TotalMinutes)
  if ($daemonPid) {
    try {
      $a = Get-Content -LiteralPath $aliveFile -Raw -ErrorAction Stop | ConvertFrom-Json
      # Written since the stuck state began: with supervisor-warn-only a stuck daemon keeps its pid, and its last heartbeat,
      # from before it said it ends, is still under ${DAEMON_ALIVE_FRESH_S} s old (w6809's review).
      $wrote = (Get-Item -LiteralPath $aliveFile).LastWriteTimeUtc
      $age = ((Get-Date).ToUniversalTime() - $wrote).TotalSeconds
      if ([int]$a.pid -eq $daemonPid -and $a.linked -eq $true -and $age -le ${DAEMON_ALIVE_FRESH_S} -and $wrote -gt $stuckSince) { End-Stuck "self-reboot: the daemon, pid $daemonPid, works (linked to the portal) $mins min after the stuck state began: the episode is over, no reboot (w6792)"; return }
    } catch { }
  }
  if ($rebootSaid -or ((Get-Date).ToUniversalTime() - $stuckSince).TotalSeconds -lt $rebootAfterS) { return }
  $skip = Reboot-Skip
  if ($skip) {
    if ($skip.key -ne $skipSaid) { Say "self-reboot: stuck $mins min, no reboot: $($skip.why) (w6792)"; $script:skipSaid = $skip.key; $script:skipNow = [pscustomobject]@{ at = Iso (Get-Date).ToUniversalTime(); why = $skip.why }; Write-RebootState }
    return
  }
  $script:rebootSaid = $true
  $script:skipNow = $null
  $why = "the daemon was stuck $mins min ($stuckWhy) and this supervisor's own recovery brought back no working daemon"
  $script:rebootLast = [pscustomobject]@{ at = Iso (Get-Date).ToUniversalTime(); mode = 'warn'; why = $why; stuckSince = Iso $stuckSince }
  Say "self-reboot: would reboot now (warn only), reason: $why (w6792)"
  Write-RebootState
}
Check-Eligible
while ($true) {
  $out = Rotate-Out 'daemon'
  $err = Rotate-Out 'daemon.err'
  if ($out -ne 'daemon.log') { Say "daemon.log is still held (abandoned daemon pid(s) $($abandoned -join ', ')); this daemon writes $out and $err (w6784)" }
  $started = Get-Date
  $asked = $false
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  try {
    $proc = Start-Process -FilePath $node -ArgumentList $argv -WorkingDirectory $app -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs $out) -RedirectStandardError (Join-Path $logs $err)
    $null = $proc.Handle
    Say "started the daemon, pid $($proc.Id)"
    Beat $proc.Id
    # w6784: wait in steps. A restart asked over ssh ends this daemon; one that said it ends and is still there after
    # $stuckAfter s is ended once more and, if still there, left behind and a fresh one started (warn-only file: only logged).
    $stuckSaid = $false
    $left = $false
    while (-not $proc.WaitForExit($waitStepMs)) {
      Beat $proc.Id
      Watch-Reboot $proc.Id
      $ask = Take-Request
      if ($ask) {
        Say "a restart was asked ($ask): ending the daemon, pid $($proc.Id) (w6784)"
        $asked = $true
        if (End-Daemon $proc) { break }
        Begin-Stuck ((Get-Date).ToUniversalTime().AddSeconds(-15)) "pid $($proc.Id) did not end when a restart was asked ($ask)"
        if (Test-Path -LiteralPath $warnOnly) { Say "the daemon, pid $($proc.Id), is still there 15 s after it was ended; $warnOnly says warn only, so this supervisor goes on waiting for it"; continue }
        $left = $true
        Say "the daemon, pid $($proc.Id), is still there 15 s after it was ended: it is stuck mid-exit; left behind, a fresh one starts beside it (w6784)"
        break
      }
      if ($stuckSaid -or -not (Test-Path -LiteralPath $marker)) { continue }
      try {
        $m = Get-Content -LiteralPath $marker -Raw -ErrorAction Stop | ConvertFrom-Json
        $for = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $marker).LastWriteTimeUtc).TotalSeconds
        if ([int]$m.pid -ne $proc.Id -or $for -lt $stuckAfter) { continue }
      } catch { continue }
      $stuckSaid = $true
      $stuckFrom = (Get-Date).ToUniversalTime().AddSeconds(-$for)
      $stuckAs = "pid $($proc.Id) said it ends ($($m.why)) and did not exit"
      if (Test-Path -LiteralPath $warnOnly) {
        Begin-Stuck $stuckFrom $stuckAs
        Say "the daemon, pid $($proc.Id), said it ends ($($m.why)) $([int]$for) s ago and has still not exited: it is stuck mid-exit; $warnOnly says warn only, so this supervisor goes on waiting for it (w6784)"
        continue
      }
      Say "the daemon, pid $($proc.Id), said it ends ($($m.why)) $([int]$for) s ago and has still not exited: ending it again (w6784)"
      if (End-Daemon $proc) { break }
      Begin-Stuck $stuckFrom $stuckAs
      $left = $true
      Say "the daemon, pid $($proc.Id), is still there: it is stuck mid-exit; left behind, a fresh one starts beside it (w6784)"
      break
    }
    if ($left) {
      $abandoned.Add($proc.Id)
      $why = "was left behind stuck mid-exit"
    } else {
      if ($stuckSaid) { Say "the daemon, pid $($proc.Id), has exited after all" }
      # 75 (machine/daemon.ts DAEMON_YIELD_EXIT): a newer daemon of this machine took over, so this supervisor ends too (w1918).
      if ($proc.ExitCode -eq 75 -and -not $asked) { Say "the daemon ended for a newer one of this machine; this supervisor ends"; break }
      $why = "exited with code $($proc.ExitCode)"
    }
  } catch {
    $why = "could not start: $($_.Exception.Message)"
  }
  if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 10 } elseif (-not $left -and -not $asked) { $delay = [Math]::Min($delay * 2, 300) }
  # An asked restart starts at once and a left-behind daemon's successor after $leftWaitS, but neither resets the back-off:
  # $delay = 0 doubled stays 0, and the supervisor restarted a daemon an update's Stop-FFDaemon had just ended, at once, so
  # the update could not move app aside (w6784's Worker update CI, 2026-11-28).
  $wait = $delay
  if ($asked) { $wait = 0 } elseif ($left) { $wait = $leftWaitS }
  Say "the daemon $why; starting it again in $wait s"
  # The back-off is in steps too: the state stays fresh, and a restart asked meanwhile starts it at once.
  $until = (Get-Date).AddSeconds($wait)
  while ((Get-Date) -lt $until) {
    Beat $null
    Watch-Reboot $null
    $ask = Take-Request
    if ($ask) { Say "a restart was asked ($ask): starting the daemon now (w6784)"; break }
    Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Min($waitStepMs, ($until - (Get-Date)).TotalMilliseconds)))
  }
}
`;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The Task Scheduler task: at logon of this user (by SID), in their interactive session (the Claude login,
 * the GPU and the desktop Unity needs), not elevated, normal priority (a task's default 7 would hand the
 * daemon's agents and Unity below-normal CPU, I/O and memory priority), no time limit, never stopped for
 * batteries or idleness, one instance, restarted by Task Scheduler if the supervisor itself fails.
 * The supervisor runs under a headless console host (w603): an interactive task's console app gets a visible
 * window, and where Windows Terminal is the default terminal powershell's -WindowStyle Hidden cannot hide it
 * (LothDesktop, 2026-10-07: a "powershell.exe" Terminal window stayed open from the daemon's start, and closing it
 * closes the supervisor's console). conhost --headless gives it a console with no window at all.
 */
export function taskXml(sid: string, home: string, appDir?: string): string {
  if (!/^S-1-[\d-]+$/.test(sid)) throw new Error(`"${sid}" is not a Windows SID`);
  const f = appDir ? winDir(appDir) : `${home.replace(/[\\/]+$/, '')}\\.ff-factory`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>FF Factory machine daemon: runs the portal's agents on this PC (docs/machines.md). Installed and updated by the portal over ssh.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(sid)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(sid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${xml(f)}\\run-daemon.ps1"</Arguments>
      <WorkingDirectory>${xml(f)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * The one-shot task a worker install's update job runs in (w1596, machine/osJob.ts): its own task, so the daemon's restart
 * (Stop-FFDaemon ends the daemon's task and everything the daemon started) does not end it. As the daemon's task: this
 * user, their interactive session, not elevated, headless. At logon too, so a job a reboot cut off finishes or puts the old
 * code back (scripts/worker/linkJob.ts does nothing for a job that ended). Four hours at most. `<SID>` is filled in by
 * jobScript, on the PC.
 */
export function jobTaskXml(o: { node: string; args: string[]; cwd: string }): string {
  const arg = (a: string) => (/^[\w.:\\/=-]+$/.test(a) ? a : `"${a.replace(/"/g, '')}"`);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>FF Factory: a worker install update job the portal asked for over the daemon's link (docs/worker-install.md, "Updates over the daemon's link"). It ends by itself.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>&lt;SID&gt;</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>&lt;SID&gt;</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${xml(['--headless', arg(winDir(o.node)), ...o.args.map(arg)].join(' '))}</Arguments>
      <WorkingDirectory>${xml(winDir(o.cwd))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Register the job's task (jobTaskXml) for this user and start it. Prints `job=started`. */
export function jobScript(task: string, xmlText: string): string {
  const name = taskName({ task });
  return `$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(xmlText, 'utf8')}')).Replace('&lt;SID&gt;', $sid)
$null = Register-ScheduledTask -TaskName '${name}' -Xml $xml -Force
Start-ScheduledTask -TaskName '${name}'
'job=started'
`;
}

/** Remove a job's task once it has ended (never one still running). Prints `job=removed`, `job=running` or `job=none`. */
export function jobRemoveScript(task: string): string {
  const name = taskName({ task });
  return `$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue
if (-not $t) { 'job=none' } elseif ($t.State -eq 'Running') { 'job=running' } else { Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false; 'job=removed' }
`;
}

/**
 * Put the code that ran before back (w1596, scripts/worker/linkJob.ts): stop the daemon (its agent hosts run on), app ->
 * app.failed, app.old -> app, and the supervisor it ran with back (run-daemon.ps1.old, w6603), start it. Only files in
 * the daemon's own folder move; an earlier app.failed is removed first. Prints `started=True|False`.
 */
export function rollbackScript(appDir: string, service?: WinService): string {
  return `${head({ appDir, service })}
$app = Join-Path $F 'app'; $old = Join-Path $F 'app.old'; $failed = Join-Path $F 'app.failed'
if (-not (Test-Path -LiteralPath $old)) { throw 'there is no app.old to put back' }
$null = Stop-FFDaemon
function Move-Retry($from, $to) {
  for ($i = 0; ; $i++) {
    try { Move-Item -LiteralPath $from -Destination $to -Force; return } catch { if ($i -ge 10) { throw "could not move $from to $($to): $($_.Exception.Message) (a process still has a file open there)" }; Start-Sleep 1 }
  }
}
if (Test-Path -LiteralPath $failed) { Remove-Item -LiteralPath $failed -Recurse -Force }
if (Test-Path -LiteralPath $app) { Move-Retry $app $failed }
Move-Retry $old $app
# The supervisor the old code ran with (w6603, installScript keeps it): its node with it. The one that failed is kept as
# run-daemon.ps1.failed. An install from before w6603 kept none: the supervisor there stays.
$sup = Join-Path $F 'run-daemon.ps1'
if (Test-Path -LiteralPath ($sup + '.old')) {
  if (Test-Path -LiteralPath $sup) { Move-Item -LiteralPath $sup -Destination ($sup + '.failed') -Force }
  Move-Item -LiteralPath ($sup + '.old') -Destination $sup -Force
  'supervisor=restored'
}
if (Test-FFLoggedOn) { Start-FFDaemon; 'started=True' } else { 'started=False' }
`;
}

const b64 = (s: string, enc: 'utf8' | 'utf8bom') => (enc === 'utf8bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]) : Buffer.from(s, 'utf8')).toString('base64');

/**
 * Swap in the new code and (re)start the daemon: stop the old one, app -> app.old, app.new -> app, write
 * daemon.json (UTF-8 without a BOM, which JSON.parse refuses) and the supervisor (UTF-8 with a BOM, so Windows
 * PowerShell reads a non-ASCII path right), register the task and run it.
 * Prints `started=True` or `started=False` (nobody is logged on: it starts at the next logon).
 */
export function installScript(o: { sid: string; home: string; config: string; node: string; flag: boolean; appDir?: string; previousAppDir?: string; service?: WinService }): string {
  const TASK = taskName(o.service);
  return `${head({ appDir: o.appDir, previous: o.previousAppDir, service: o.service })}
$app = Join-Path $F 'app'; $old = Join-Path $F 'app.old'; $new = Join-Path $F 'app.new'
if (-not (Test-Path -LiteralPath $new)) { throw 'the new code is missing (app.new)' }
$null = Stop-FFDaemon
function Move-Retry($from, $to) {
  for ($i = 0; ; $i++) {
    try { Move-Item -LiteralPath $from -Destination $to -Force; return } catch { if ($i -ge 10) { throw "could not move $from to $($to): $($_.Exception.Message) (a process still has a file open there)" }; Start-Sleep 1 }
  }
}
if (Test-Path -LiteralPath $old) {
  try { Remove-Item -LiteralPath $old -Recurse -Force } catch { Move-Retry $old ($old + '-' + (Get-Date -Format yyyyMMddHHmmss)) }
}
if (Test-Path -LiteralPath $app) { Move-Retry $app $old }
# The supervisor the code in app.old ran with goes beside it as run-daemon.ps1.old (w6603), in the same step: a rollback
# puts both back, so the old code runs on the node it ran on before. With no supervisor there, none is kept.
$sup = Join-Path $F 'run-daemon.ps1'
if (Test-Path -LiteralPath $sup) { Copy-Item -LiteralPath $sup -Destination ($sup + '.old') -Force } elseif (Test-Path -LiteralPath ($sup + '.old')) { Remove-Item -LiteralPath ($sup + '.old') -Force }
Move-Retry $new $app
New-Item -ItemType Directory -Force (Join-Path $F 'agents'), (Join-Path $F 'logs') | Out-Null
function Write-B64($name, $data) { [IO.File]::WriteAllBytes((Join-Path $F $name), [Convert]::FromBase64String($data)) }
Write-B64 'daemon.json' '${b64(o.config, 'utf8')}'
Write-B64 'run-daemon.ps1' '${b64(supervisorScript(o.node, o.flag, o.service), 'utf8bom')}'
$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(taskXml(o.sid, o.home, o.appDir), 'utf8')}'))
try { $null = Register-ScheduledTask -TaskName '${TASK}' -Xml $xml -Force } catch {
  # Not elevated (the portal's own host deploys as the server's non-elevated user): a task an administrator registered
  # once keeps working, since its action runs this folder's run-daemon.ps1. Without one, say exactly what to run once.
  $why = $_.Exception.Message
  $x = Join-Path $F 'daemon-task.xml'
  [IO.File]::WriteAllText($x, $xml, [Text.Encoding]::Unicode)
  if (-not (Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue)) {
    throw "registering the ${TASK} task failed ($why). Register it once from an administrator PowerShell: Register-ScheduledTask -TaskName ${TASK} -Xml (Get-Content -Raw '$x'); then redeploy"
  }
  'registered=kept'
}
if (Test-FFLoggedOn) { Start-FFDaemon; 'started=True' } else { 'started=False' }
`;
}

/** Only the stop (prints `stopped=<n>`): with `agents`, the agent hosts too. Exported for tests. */
export function stopScript(agents: boolean, appDir?: string, service?: WinService): string {
  return `${head({ appDir, service })}
'stopped=' + (Stop-FFDaemon${agents ? ' -Agents' : ''})
`;
}

/**
 * Start, stop or restart the daemon (its task and processes). A stop ends its agents too; a restart leaves the agent
 * hosts running for the new daemon (w605). Prints `stopped=<n>` and/or `started=True|False`.
 */
export function controlScript(action: 'start' | 'stop' | 'restart', appDir?: string, service?: WinService): string {
  if (action === 'stop') return `${head({ appDir, service })}\n'stopped=' + (Stop-FFDaemon -Agents)\nif ($script:FFStuck.Count) { 'stuck=' + ($script:FFStuck -join ',') }\n`;
  return `${head({ appDir, service })}
${askSupervisor(action)}
if (-not $viaSupervisor) {
${action === 'restart' ? "  'stopped=' + (Stop-FFDaemon)\n  if ($script:FFStuck.Count) { 'stuck=' + ($script:FFStuck -join ',') }" : startState(taskName(service))}
  if (Test-FFLoggedOn) { Start-FFDaemon; 'started=True' } else { 'started=False' }
}
`;
}

/**
 * w6784: a start or restart asks the daemon's live supervisor first, by a file it reads every 5 s step (supervisorScript):
 * no Task Scheduler and no WMI, both hung on BEAST on 2026-11-28 (Get-ScheduledTask, schtasks and the task's start all
 * hung), and the supervisor already runs in the user's interactive session, which Unity needs. A supervisor is live when
 * its state file is under SUPERVISOR_FRESH_S old and its pid runs. A restart asks it always; a start asks it only while it
 * has no daemon (it skips the rest of its back-off), and else says which daemon it has. Prints `supervisor=<pid>
 * daemonPid=<pid|none>`, then `restartedBy=supervisor daemonPid=<new pid>` or `supervisorAnswered=False`; sets
 * $viaSupervisor when it answered, so the task route is skipped.
 */
const askSupervisor = (action: 'start' | 'restart') => `$ErrorActionPreference = 'Continue'
$viaSupervisor = $false
$sj = Join-Path $F 'logs\\${SUPERVISOR_STATE}'
$req = Join-Path $F 'logs\\${SUPERVISOR_REQUEST}'
$live = $null
# Up to 5 tries 100 ms apart: the supervisor swaps the file in every few seconds, and a read in the swap finds none or finds it
# busy (w6792); taken as no supervisor, a restart went the Task Scheduler route (w6784's ssh restart test on CI).
for ($try = 0; $try -lt 5 -and -not $live; $try++) {
  if ($try) { Start-Sleep -Milliseconds 100 }
  try {
    $s0 = Get-Content -LiteralPath $sj -Raw -ErrorAction Stop | ConvertFrom-Json
    $age = ((Get-Date).ToUniversalTime() - (Get-Item -LiteralPath $sj -ErrorAction Stop).LastWriteTimeUtc).TotalSeconds
    if ($age -lt ${SUPERVISOR_FRESH_S} -and (Get-Process -Id ([int]$s0.pid) -ErrorAction SilentlyContinue)) { $live = $s0 } else { break }
  } catch { }
}
if ($live) {
  $old = [string]$live.daemonPid
  'supervisor=' + $live.pid + ' daemonPid=' + $(if ($old) { $old } else { 'none' })
  if (${action === 'restart' ? '$true' : '-not $old'}) {
    [pscustomobject]@{ why = 'machine_daemon ${action} over ssh'; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $req -Encoding utf8
    $until = (Get-Date).AddSeconds(${SUPERVISOR_ANSWER_S})
    while ((Get-Date) -lt $until -and -not $viaSupervisor) {
      Start-Sleep -Milliseconds 500
      try {
        $s1 = Get-Content -LiteralPath $sj -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($s1.daemonPid -and [string]$s1.daemonPid -ne $old -and -not (Test-Path -LiteralPath $req)) { 'restartedBy=supervisor daemonPid=' + $s1.daemonPid; $viaSupervisor = $true }
      } catch { }
    }
    if (-not $viaSupervisor) { Remove-Item -LiteralPath $req -Force -ErrorAction SilentlyContinue; 'supervisorAnswered=False' }
  } else { $viaSupervisor = $true }
}
$ErrorActionPreference = 'Stop'`;

/**
 * w6784: before a start, the task's state and the supervisor's last daemon. Start-ScheduledTask on a task that is already
 * running does nothing (one instance), and BEAST's start at 2026-11-28 08:20Z answered "started" while its supervisor sat on a
 * daemon stuck mid-exit. Get-ScheduledTask is a CIM cmdlet, and WMI hung there (w6785's review), so it runs in a child
 * given TASK_STATE_WAIT_MS (Invoke-FFBounded: no answer is an empty state); Get-Process reads no WMI.
 */
const startState = (task: string) => `$ErrorActionPreference = 'Continue'
'state=' + (Invoke-FFBounded "(Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue).State" ${TASK_STATE_WAIT_MS}) + ''
$sup = Join-Path $F 'logs\\supervisor.log'
if (Test-Path -LiteralPath $sup) {
  $last = Get-Content -LiteralPath $sup -Tail 200 -ErrorAction SilentlyContinue | Select-String 'started the daemon, pid (\\d+)' | Select-Object -Last 1
  if ($last) { $dp = [int]$last.Matches[0].Groups[1].Value; 'daemonPid=' + $dp + ' alive=' + [bool](Get-Process -Id $dp -ErrorAction SilentlyContinue) }
}
$ErrorActionPreference = 'Stop'`;

/** Stop the daemon and its agents and delete its task; its files stay in its folder. */
export function uninstallScript(appDir?: string, service?: WinService): string {
  return `${head({ appDir, service })}
$null = Stop-FFDaemon -Agents
Unregister-ScheduledTask -TaskName '${taskName(service)}' -Confirm:$false -ErrorAction SilentlyContinue
`;
}

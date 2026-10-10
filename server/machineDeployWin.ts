import { spawn } from 'node:child_process';

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
 * processes in it: a job that hangs to its timeout and loses its whole log, as two Windows CI jobs did.
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
  foreach ($id in $kill) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 30; $i++) {
    if (-not @($kill | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($task) { $null = $task | Enable-ScheduledTask -ErrorAction SilentlyContinue }
  $kill.Count
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
 * logs\daemon.log and daemon.err.log (the previous run's kept as *.prev).
 */
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
while ($true) {
  foreach ($f in 'daemon.log', 'daemon.err.log') {
    $p = Join-Path $logs $f
    if (Test-Path -LiteralPath $p) { Move-Item -Force -LiteralPath $p -Destination ($p + '.prev') }
  }
  $started = Get-Date
  try {
    $proc = Start-Process -FilePath $node -ArgumentList $argv -WorkingDirectory $app -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'daemon.log') -RedirectStandardError (Join-Path $logs 'daemon.err.log')
    $null = $proc.Handle
    "$(Get-Date -Format s) started the daemon, pid $($proc.Id)" | Out-File $log -Append -Encoding utf8
    $proc.WaitForExit()
    $why = "exited with code $($proc.ExitCode)"
  } catch {
    $why = "could not start: $($_.Exception.Message)"
  }
  if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 10 } else { $delay = [Math]::Min($delay * 2, 300) }
  "$(Get-Date -Format s) the daemon $why; starting it again in $delay s" | Out-File $log -Append -Encoding utf8
  Start-Sleep $delay
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
  return `${head({ appDir, service })}
${action === 'stop' ? "'stopped=' + (Stop-FFDaemon -Agents)" : action === 'restart' ? "'stopped=' + (Stop-FFDaemon)" : ''}
${action !== 'stop' ? "if (Test-FFLoggedOn) { Start-FFDaemon; 'started=True' } else { 'started=False' }" : ''}
`;
}

/** Stop the daemon and its agents and delete its task; its files stay in its folder. */
export function uninstallScript(appDir?: string, service?: WinService): string {
  return `${head({ appDir, service })}
$null = Stop-FFDaemon -Agents
Unregister-ScheduledTask -TaskName '${taskName(service)}' -Confirm:$false -ErrorAction SilentlyContinue
`;
}

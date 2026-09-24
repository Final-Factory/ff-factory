# Publishes this app's GitHub repo as open source with a fresh one-commit history (docs/republish.md):
#   preflight  the squashed commit of the private main (single root commit, same tree), gitleaks and a scan
#              for this machine's own names on it, the private repo's full history intact
#   rename     <owner>/<name> -> <owner>/<name>-private (keeps every commit)
#   create     a public <owner>/<name>
#   push       the squashed commit as its main
#   settings   private vulnerability reporting on
#   move       an app update, which moves this checkout onto the public history (update-steps.ps1 keeps the
#              old HEAD on a pre-republish-* branch), then a check that it did
#   report     a [republish] message to the orchestrator (data/orchestrator-inbox)
# Every step checks whether it is already done, so a rerun resumes. It deletes nothing; on a failure it
# stops, logs to data/supervisor.log and messages the orchestrator. Started by the republish_public tool
# (outside the server, so the restart in the middle does not stop it) or by hand. -DryRun: preflight only.
param([switch]$DryRun)

. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $AppRoot
$ErrorActionPreference = 'Continue'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$PID | Out-File (Join-Path $DataDir 'republish.pid') -Encoding ascii
$work = Join-Path $DataDir 'republish'
New-Item -ItemType Directory -Force $work | Out-Null
$Description = 'Self-hosted portal for running Claude Code agents in parallel on a Unity project'
$AuthorName = 'Final Factory'

function Log([string]$m) { Write-AppLog "republish: $m" | Out-Null }
function Tell([string]$text) {
  $dir = Join-Path $DataDir 'orchestrator-inbox'
  New-Item -ItemType Directory -Force $dir | Out-Null
  [IO.File]::WriteAllText((Join-Path $dir "$(Get-Date -Format yyyyMMdd-HHmmss)-republish.txt"), $text)
}
function Fail([string]$m) {
  Log "FAILED: $m"
  Tell "[republish] FAILED, stopped: $m (log: data/supervisor.log, lines 'republish:'). Nothing was deleted; fix the cause and call republish_public again to resume."
  exit 1
}
# Native commands: output as one string with plain `n line ends (Out-String joins lines with CRLF, and a
# stray CR in a ref name broke the first real run), and a throw with that output when the exit code is not 0.
function X([string]$exe, [string[]]$a) {
  $out = ((& $exe @a 2>&1 | Out-String) -replace "`r", '').Trim()
  if ($LASTEXITCODE -ne 0) { throw "$exe $($a -join ' ') failed ($LASTEXITCODE): $out" }
  return $out
}
function TryX([string]$exe, [string[]]$a) {
  $out = ((& $exe @a 2>&1 | Out-String) -replace "`r", '').Trim()
  if ($LASTEXITCODE -ne 0) { return $null }
  return $out
}
# "<full_name> <visibility>" of a repo (GitHub follows a rename's redirect), or $null when there is none.
# (No double quotes inside native arguments: Windows PowerShell 5.1 does not escape them.)
function RepoInfo([string]$name) {
  $o = TryX gh @('api', "repos/$name", '--jq', '.full_name, .visibility')
  if ($null -eq $o) { return $null }
  return (($o -split "`n") | ForEach-Object { $_.Trim() }) -join ' '
}

try {
  Log "started$(if ($DryRun) { ' (dry run)' })"
  X gh @('auth', 'status') | Out-Null

  # ---------------------------------------------------------------- where things are
  $origin = X git @('config', '--get', 'remote.origin.url')  # as configured (get-url applies insteadOf)
  if ($origin -notmatch 'github\.com[:/]([^/]+/[^/]+?)(\.git)?/?$') { Fail "origin ($origin) is not a GitHub repo" }
  $slug = $Matches[1]
  $private = "$slug-private"
  $pub = RepoInfo $slug
  $priv = RepoInfo $private
  $renamed = $false; $created = $false
  if (!$priv -and $pub -eq "$slug private") { }
  elseif ($priv -eq "$private private" -and (!$pub -or $pub -like "$private *")) { $renamed = $true }
  elseif ($priv -eq "$private private" -and $pub -eq "$slug public") { $renamed = $true; $created = $true }
  else { Fail "unexpected repo state: $slug = '$pub', $private = '$priv'" }
  $privNow = if ($renamed) { $private } else { $slug }
  Log "repos: private history at $privNow; public $slug $(if ($created) { 'exists' } else { 'not created yet' })"

  # ---------------------------------------------------------------- preflight: the private history
  $bare = Join-Path $work 'private.git'
  if (!(Test-Path $bare)) { X git @('clone', '--bare', '--quiet', "https://github.com/$privNow.git", $bare) | Out-Null }
  X git @('-C', $bare, 'remote', 'set-url', 'origin', "https://github.com/$privNow.git") | Out-Null
  X git @('-C', $bare, 'fetch', '--quiet', 'origin', '+refs/heads/*:refs/heads/*') | Out-Null
  $count = [int](X git @('-C', $bare, 'rev-list', '--count', 'main'))
  if ($count -lt 2) { Fail "$privNow main has $count commit(s): that is not the full private history" }
  $tree = X git @('-C', $bare, 'rev-parse', 'main^{tree}')
  Log "private history: $count commits on main, tree $tree"

  # ---------------------------------------------------------------- the squashed commit
  $idLogin = (X gh @('api', 'user', '--jq', '.id, .login')) -split "`n" | ForEach-Object { $_.Trim() }
  $noreply = "$($idLogin[0])+$($idLogin[1])@users.noreply.github.com"
  # Reuse a public-main* branch OF THE PRIVATE REPO (ls-remote, not the local clone: a local-only branch
  # proves nothing) that is a single root commit of main's tree. Otherwise build one; a real run pushes it
  # as a new branch, a dry run only builds it (no branch, nothing left behind for the next run to pick up).
  $sha = $null
  $heads = @(TryX git @('-C', $bare, 'ls-remote', '--heads', 'origin', 'public-main*')) -split "`n" | Where-Object { $_ }
  foreach ($line in $heads) {
    $c, $ref = $line -split '\s+', 2
    $parents = X git @('-C', $bare, 'rev-list', '--parents', '-n', '1', $c)
    if (($parents -split ' ').Count -eq 1 -and (X git @('-C', $bare, 'rev-parse', "$c^{tree}")) -eq $tree) { $sha = $c; Log "squashed commit: $ref = $sha"; break }
  }
  if (!$sha) {
    $env:GIT_AUTHOR_NAME = $AuthorName; $env:GIT_AUTHOR_EMAIL = $noreply
    $env:GIT_COMMITTER_NAME = $AuthorName; $env:GIT_COMMITTER_EMAIL = $noreply
    $sha = X git @('-C', $bare, 'commit-tree', $tree, '-m', 'FF Factory: first public release', '-m', "$Description. MIT licence.")
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL' | ForEach-Object { Remove-Item "env:$_" }
    $taken = $heads | ForEach-Object { ($_ -split '\s+', 2)[1] }
    $branch = if ($taken -contains 'refs/heads/public-main') { "public-main-$(Get-Date -Format yyyyMMdd-HHmmss)" } else { 'public-main' }
    if (!$DryRun) { X git @('-C', $bare, 'push', '--quiet', 'origin', "${sha}:refs/heads/$branch") | Out-Null }
    Log "squashed commit: built $sha from main's tree$(if ($DryRun) { ' (dry run: not kept as a branch)' } else { " and pushed it to $privNow as $branch" })"
  }
  $author = X git @('-C', $bare, 'log', '-1', '--format=%ae %ce', $sha)
  $myEmail = TryX git @('config', '--global', 'user.email')
  if ($myEmail -and $author -match [regex]::Escape($myEmail)) { Fail "the squashed commit carries $myEmail" }

  # ---------------------------------------------------------------- preflight: scans of exactly what goes public
  $scan = Join-Path $work 'scan'
  if (!(Test-Path $scan)) { X git @('-C', $bare, 'worktree', 'add', '--detach', $scan, $sha) | Out-Null }
  else { X git @('-C', $scan, 'checkout', '--quiet', '--detach', $sha) | Out-Null }
  $gl = (Get-Command gitleaks -ErrorAction SilentlyContinue).Source
  if (!$gl) {
    $glDir = Join-Path $DataDir 'tools\gitleaks'
    $gl = Join-Path $glDir 'gitleaks.exe'
    if (!(Test-Path $gl)) {
      New-Item -ItemType Directory -Force $glDir | Out-Null
      X gh @('release', 'download', '-R', 'gitleaks/gitleaks', '-p', '*windows_x64.zip', '-D', $glDir, '--clobber') | Out-Null
      Expand-Archive -Force (Get-ChildItem $glDir -Filter '*windows_x64.zip' | Select-Object -First 1).FullName $glDir
    }
  }
  X $gl @('git', $scan, '--log-opts', "$sha -1", '--redact', '--no-banner', '--exit-code', '1') | Out-Null
  X $gl @('dir', $scan, '--redact', '--no-banner', '--exit-code', '1') | Out-Null
  # This machine's own names must not be in it: user, host, git identity, Funnel host, tailnet name, ssh key files.
  $tokens = @($env:USERNAME, $env:COMPUTERNAME, $myEmail) + ((TryX git @('config', '--global', 'user.name')) -split '\s+')
  try {
    $cfgJson = Get-Content (Join-Path $AppRoot 'config.json') -Raw | ConvertFrom-Json
    if ($cfgJson.publicUrl) { $h = ([uri]$cfgJson.publicUrl).Host; $tokens += $h; $tokens += $h.Split('.') }
  } catch { }
  $ts = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($ts) { $dns = TryX $ts.Source @('status', '--json'); if ($dns) { try { $n = ($dns | ConvertFrom-Json).Self.DNSName.TrimEnd('.'); $tokens += $n; $tokens += $n.Split('.') } catch { } } }
  $sshDir = Join-Path $env:USERPROFILE '.ssh'
  if (Test-Path $sshDir) { $tokens += Get-ChildItem $sshDir -File | ForEach-Object { $_.BaseName } | Where-Object { $_ -notmatch '^(id_(rsa|ed25519|ecdsa|dsa)|config|known_hosts.*|authorized_keys|environment)$' } }
  $generic = 'ts', 'net', 'com', 'github', 'users', 'noreply', 'final', 'factory', 'desktop', 'admin', 'user'
  $tokens = $tokens | Where-Object { $_ -and $_.Length -ge 4 -and $generic -notcontains $_.ToLower() } | Sort-Object -Unique
  $hits = foreach ($t in $tokens) { $f = TryX git @('-C', $scan, 'grep', '-I', '-i', '-w', '-F', '-l', '-e', $t); if ($f) { "'$t' in $($f -replace "`r?`n", ', ')" } }
  if ($hits) { Fail "the squashed tree names this machine: $($hits -join '; ')" }
  Log "preflight ok: gitleaks clean (history and tree), none of $($tokens.Count) local names found, author $author"
  if ($DryRun) {
    Tell "[republish] Dry run OK: $privNow has $count commits; squashed commit $sha (tree of main) passes gitleaks and the local-name scan. A real run would$(if (!$renamed) { " rename $slug to $private," })$(if (!$created) { " create public $slug," }) push $sha as its main, turn on vulnerability reporting, and update this app onto the public history."
    exit 0
  }

  # The last step (the app update) needs the supervisor; refuse before anything irreversible, not after.
  $moved = $null -ne (TryX git @('merge-base', '--is-ancestor', $sha, 'HEAD'))
  if (!$moved -and (Get-Supervisor).State -eq 'none') { Fail 'no supervisor is running, and the last step (the app update) needs one; start the app with scripts\restart.ps1, then call republish_public again. Nothing was changed on GitHub.' }

  # ---------------------------------------------------------------- rename, create, push, settings
  if (!$renamed) {
    X gh @('repo', 'rename', ($private -split '/')[1], '-R', $slug, '--yes') | Out-Null
    for ($i = 0; $i -lt 30 -and (RepoInfo $private) -ne "$private private"; $i++) { Start-Sleep 2 }
    Log "renamed $slug to $private"
  }
  if (!$created) {
    X gh @('repo', 'create', $slug, '--public', '--description', $Description) | Out-Null
    for ($i = 0; $i -lt 30 -and (RepoInfo $slug) -ne "$slug public"; $i++) { Start-Sleep 2 }
    Log "created public $slug"
  }
  $remoteMain = TryX git @('ls-remote', "https://github.com/$slug.git", 'refs/heads/main')
  if (!$remoteMain) {
    X git @('-C', $bare, 'push', '--quiet', "https://github.com/$slug.git", "${sha}:refs/heads/main") | Out-Null
    Log "pushed $sha as main of ${slug}: it is public now"
  } else {
    X git @('-C', $bare, 'fetch', '--quiet', "https://github.com/$slug.git", '+refs/heads/main:refs/remotes/public/main') | Out-Null
    X git @('-C', $bare, 'merge-base', '--is-ancestor', $sha, 'refs/remotes/public/main') | Out-Null  # throws if public main is something else
    Log "main of $slug already has $sha"
  }
  $pvr = TryX gh @('api', '-X', 'PUT', "repos/$slug/private-vulnerability-reporting")
  $pvrNote = if ($null -ne $pvr) { 'private vulnerability reporting is on' } else { 'turning on private vulnerability reporting FAILED (do it in the repo settings)' }
  Log $pvrNote

  # ---------------------------------------------------------------- move this checkout onto the public history
  if ($null -eq (TryX git @('merge-base', '--is-ancestor', $sha, 'HEAD'))) {
    if ((Get-Supervisor).State -eq 'none') { Fail 'no supervisor is running, so nothing would run the update; run scripts\restart.ps1 -Update at the desktop, then call republish_public again' }
    $t0 = (Get-Date).ToUniversalTime()
    [IO.File]::WriteAllText((Join-Path $DataDir 'restart.request'), '{"drain":"auto","drainMinutes":10,"reason":"republish: move to the public repo","update":true,"hold":false}')
    Log 'asked the server to drain and update (the checkout moves onto the public history)'
    $result = $null
    $poll = if ($env:FFSB_REPUBLISH_POLL_SECONDS) { [int]$env:FFSB_REPUBLISH_POLL_SECONDS } else { 10 }  # tests poll faster
    for ($i = 0; $i -lt 3600 / $poll -and !$result; $i++) {
      Start-Sleep $poll
      try {
        $r = Get-Content (Join-Path $DataDir 'update.result.json') -Raw | ConvertFrom-Json
        if ([datetime]::Parse($r.at).ToUniversalTime() -ge $t0) { $result = $r }
      } catch { }
    }
    if (!$result) { Fail 'the update did not finish within an hour (see data/supervisor.log)' }
    if (!$result.ok) { Fail "the update failed: $($result.error)" }
  }
  if ($null -eq (TryX git @('merge-base', '--is-ancestor', $sha, 'HEAD'))) { Fail "this checkout's HEAD does not contain $sha after the update" }
  $backup = (X git @('branch', '--list', 'pre-republish-*', '--format=%(refname:short)')) -split "`n" | Select-Object -Last 1
  if (!$backup) { Fail 'no pre-republish-* branch: the old history was not kept here' }
  $head = X git @('rev-parse', '--short', 'HEAD')
  Log "done: $slug public at $sha; checkout at $head; old history on $backup and in $private"
  Tell "[republish] Done. $slug is public, main starts at $($sha.Substring(0, 9)) (one squashed commit, gitleaks clean). The full private history is in $private ($count commits). $pvrNote. This app's checkout is on the public history at $head; its old HEAD is kept on branch $backup. Next: redeploy the Macs (add_machine for each machine id) so their daemons run this code, and tell the user."
  exit 0
} catch {
  Fail $_.Exception.Message
}

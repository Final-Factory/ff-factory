# The update itself: pull, install exactly what the lock files say, rebuild the web UI. The server
# must already be stopped (npm ci deletes node_modules, which node and its claude.exe children run
# from). Used by update.ps1 (by hand) and by supervise.ps1 (after the request_app_update tool).
# Throws on the first failing step.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
function Step($what, [scriptblock]$cmd) {
  "== $what"
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}
# Installs must never leave tracked files modified (that blocks the next pull); discard any that did.
Step 'reset generated files' { git checkout -- package.json package-lock.json web/package.json web/package-lock.json }
# The GitHub repo was renamed ff-sandboxes -> ff-factory (2026-09-23). GitHub redirects the old URL, but once the
# new name exists, point origin at it so this checkout stops depending on the redirect. No-op before the
# rename (the probe fails fast: no credential prompt) and after it (origin already moved).
$origin = git remote get-url origin
if ($origin -match 'Final-Factory/ff-sandboxes(\.git)?/?$') {
  $new = 'https://github.com/Final-Factory/ff-factory.git'
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'
  git ls-remote --heads $new *> $null
  if ($LASTEXITCODE -eq 0) {
    git remote set-url origin $new
    "== origin repointed to $new"
  }
  $global:LASTEXITCODE = 0
}
# If the repo was republished with a fresh history (the public ff-factory starts from one squashed commit),
# the upstream shares no commit with this checkout and a fast-forward pull can never work. Move to it only
# when nothing tracked is modified here: reset --hard keeps ignored state (config.json, data/, node_modules),
# and the old HEAD stays on a pre-republish-<time> branch.
Step 'git fetch' { git fetch origin }
git merge-base HEAD '@{u}' *> $null
if ($LASTEXITCODE -eq 1) {
  $dirty = git status --porcelain --untracked-files=no
  if ($dirty) { throw "the upstream has a new, unrelated history and this checkout has modified tracked files; commit or discard them, then update again" }
  $backup = 'pre-republish-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Step "keep the old history as $backup" { git branch $backup HEAD }
  Step 'move to the republished history' { git reset --hard '@{u}' }
}
$global:LASTEXITCODE = 0
Step 'git pull' { git pull --ff-only }
Step 'npm ci' { npm.cmd ci --no-audit --no-fund }
Push-Location web
try {
  Step 'npm ci (web)' { npm.cmd ci --no-audit --no-fund }
  Step 'build web' { npm.cmd run build }
} finally {
  Pop-Location
}

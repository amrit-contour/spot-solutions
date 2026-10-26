<#
  Spot Solutions server tasks on Windows: update, local-on, local-off.

  Run as SYSTEM by the scheduled task "SpotSolutionsUpdate" (registered by install.ps1), which the server console starts
  with `schtasks /run`. The task runs C:\SpotSolutions\update.ps1, a tiny stub that copies THIS file next to it and runs
  the copy, so replacing the app folder never replaces a script that is running. Nothing here needs an interactive admin.

  Progress goes to C:\SpotSolutions\data\update.json for the console. Which task to run is in data\task.json.
  Test hooks: SPOT_DIST_URL, SPOT_ROOT.
#>
param([string]$Task = "")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root      = if ($env:SPOT_ROOT) { $env:SPOT_ROOT } else { "C:\SpotSolutions" }
$AppDir    = "$Root\app"
$NodeDir   = "$Root\node"
# Where the data and the AI models live: the Server Console's "Move data" writes these two files when they are moved to
# another drive. The installer reads them too, so neither an update nor a re-install puts them back on C:.
$DataDir   = "$Root\data"
$ModelsDir = "$Root\ollama"
foreach ($p in @(@{ File = "$Root\data-dir.txt"; Name = "DataDir" }, @{ File = "$Root\models-dir.txt"; Name = "ModelsDir" })) {
  if (Test-Path $p.File) { $v = (Get-Content $p.File -Raw).Trim(); if ($v) { Set-Variable -Name $p.Name -Value $v } }
}
$ChromeDir = "$Root\chrome"
$EnvFile   = "$AppDir\apps\worker\.env"
$WorkerTask  = "SpotSolutionsWorker"
$ConsoleTask = "SpotSolutionsConsole"
$Dist      = if ($env:SPOT_DIST_URL) { $env:SPOT_DIST_URL } else { "https://spot-solutions.web.app" }
$ProgressFile = "$DataDir\update.json"
$Utf8 = New-Object System.Text.UTF8Encoding($false)   # no BOM: the console parses these files with JSON.parse

if (-not $Task) {
  try { $Task = (Get-Content "$DataDir\task.json" -Raw | ConvertFrom-Json).task } catch { $Task = "" }
}
if ($Task -notin @("update", "local-on", "local-off", "move-data", "move-cleanup")) { throw "Unknown task '$Task'." }

$From = if (Test-Path "$AppDir\VERSION") { (Get-Content "$AppDir\VERSION" -Raw).Trim() } else { "none" }
$To = $null
$Started = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())

function Set-Progress([string]$State, [string]$Step, [string]$Err = "") {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $o = [ordered]@{ state = $State; step = $Step; error = $(if ($Err) { $Err } else { $null }); from = $From; to = $To; startedAt = $Started; task = $Task }
  [IO.File]::WriteAllText($ProgressFile, ($o | ConvertTo-Json -Compress), $Utf8)
}

function Get-EnvValue([string]$Key) {
  if (-not (Test-Path $EnvFile)) { return "" }
  $m = Select-String -Path $EnvFile -Pattern "^$Key=(.*)$" | Select-Object -Last 1
  if ($m) { return $m.Matches[0].Groups[1].Value.Trim() } else { return "" }
}
function Set-EnvValue([string]$Key, [string]$Value) {
  $text = if (Test-Path $EnvFile) { Get-Content $EnvFile -Raw } else { "" }
  if ($text -match "(?m)^$Key=") { $text = $text -replace "(?m)^$Key=.*", "$Key=$Value" } else { $text = $text.TrimEnd() + "`r`n$Key=$Value`r`n" }
  Set-Content -Encoding ASCII $EnvFile $text
}
function Test-NoLocal { return ((Get-EnvValue "SPOT_NO_LOCAL_MODEL") -match '^(1|true|yes)$') }
function Get-ModelName([string]$Default = "gemma3:4b") {
  $m = Get-EnvValue "SPOT_LOCAL_MODEL"
  if ($m -match '^[A-Za-z0-9._:/-]{1,100}$') { return $m } else { return $Default }
}

function Find-Ollama {
  foreach ($c in @("$Root\ollama-app\ollama.exe", "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe", "C:\Windows\System32\config\systemprofile\AppData\Local\Programs\Ollama\ollama.exe")) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  $g = Get-Command ollama -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($g) { return $g.Source }
  return $null
}
function Test-OllamaUp { try { Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 | Out-Null; return $true } catch { return $false } }

function Stop-WorkerProcesses {
  Stop-ScheduledTask -TaskName $WorkerTask -ErrorAction SilentlyContinue
  # The console's node is spared: it restarts last, from the task's own loop.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*SpotSolutions*' -and $_.CommandLine -notlike '*console*server.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$ChromeDir\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
function Restart-Console {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*SpotSolutions*console*server.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }   # the task's loop starts it again
}
function Invoke-Pull([string]$Model) {
  $ollama = Find-Ollama
  if (-not $ollama) { return }
  $env:OLLAMA_MODELS = $ModelsDir
  $started = $null
  if (-not (Test-OllamaUp)) { $started = Start-Process -FilePath $ollama -ArgumentList "serve" -WindowStyle Hidden -PassThru }
  for ($i = 0; $i -lt 60; $i++) { if (Test-OllamaUp) { break }; Start-Sleep 1 }
  Set-Progress "running" "Downloading the local model ($Model)"
  & $ollama pull $Model
  if ($LASTEXITCODE -ne 0) { Write-Host "Model pull failed; it is retried on the next update." }
  # A copy we started ourselves would die with this task; the worker launcher starts Ollama for good.
  if ($started) { Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue }
}

try {
  Set-Progress "running" "Starting"

  # ------------------------------------------------------------------ move the data to another drive, or delete the old copy
  # move.mjs does the work (copy, verify, switch, restart, check WhatsApp, roll back on any failure) and reports through
  # update.json itself. It runs as SYSTEM here, so the new folder is made with SYSTEM and Administrators access only.
  if ($Task -eq "move-data" -or $Task -eq "move-cleanup") {
    $mv = "$AppDir\apps\worker\console\move.mjs"
    if (-not (Test-Path $mv)) { throw "move.mjs isn't in the app folder. Update Spot Solutions first." }
    $env:SPOT_ROOT = $Root
    & "$NodeDir\node.exe" $mv $Task
    $moveCode = $LASTEXITCODE
    if ($moveCode -ne 0) { Start-ScheduledTask -TaskName $WorkerTask -ErrorAction SilentlyContinue }   # whatever happened, never leave the server stopped
    exit $moveCode
  }

  # ------------------------------------------------------------------ local model off
  if ($Task -eq "local-off") {
    Set-Progress "running" "Turning the local model off"
    Set-EnvValue "SPOT_NO_LOCAL_MODEL" "1"
    Stop-WorkerProcesses
    Get-Process -Name "ollama", "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $WorkerTask
    Set-Progress "done" "Local model off"
    return
  }

  # ------------------------------------------------------------------ local model on
  if ($Task -eq "local-on") {
    Set-Progress "running" "Installing Ollama"
    $ollama = Find-Ollama
    if (-not $ollama) {
      # winget needs a signed-in user; this runs as SYSTEM, so use Ollama's own silent installer.
      $setup = "$Root\OllamaSetup.exe"
      Invoke-WebRequest "https://ollama.com/download/OllamaSetup.exe" -OutFile $setup
      Start-Process -FilePath $setup -ArgumentList "/VERYSILENT", "/NORESTART", "/SP-", "/SUPPRESSMSGBOXES", "/DIR=`"$Root\ollama-app`"" -Wait
      Remove-Item $setup -Force -ErrorAction SilentlyContinue
      Get-Process -Name "ollama", "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      $ollama = Find-Ollama
    }
    if (-not $ollama) { throw "Couldn't install Ollama. Install it from https://ollama.com/download, then try again." }
    New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
    [Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $ModelsDir, "Machine")
    [Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE", "24h", "Machine")
    Stop-WorkerProcesses
    Invoke-Pull (Get-ModelName)
    Set-EnvValue "SPOT_NO_LOCAL_MODEL" "0"
    Set-Progress "running" "Restarting the worker"
    Start-ScheduledTask -TaskName $WorkerTask
    Restart-Console   # so its Ollama path is current
    Set-Progress "done" "Local model on"
    return
  }

  # ------------------------------------------------------------------ update
  Set-Progress "running" "Checking the latest version"
  $v = Invoke-RestMethod "$Dist/dl/version.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -TimeoutSec 30
  $latest = "$($v.version)"; $sha = "$($v.sha256)".ToLower(); $lmodel = "$($v.model)"
  if ($latest -notmatch '^[0-9A-Za-z._-]{1,40}$' -or $sha -notmatch '^[0-9a-f]{64}$') { throw "The version file from Spot Solutions isn't valid." }
  if ($lmodel -notmatch '^[A-Za-z0-9._:/-]{1,100}$') { $lmodel = "gemma3:4b" }
  $To = $latest
  if ($latest -eq $From) { Set-Progress "done" "Already up to date"; return }

  Set-Progress "running" "Downloading $latest"
  $work = "$Root\update-work"
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $tgz = "$work\app.tgz"
  Invoke-WebRequest "$Dist/dl/spot-solutions.tar.gz" -OutFile $tgz

  Set-Progress "running" "Verifying the download"
  if ((Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower() -ne $sha) { throw "The download didn't match its checksum, so it was not installed." }
  # Windows' own tar by full path (Git's tar can shadow it and misreads C:\ paths).
  $tar = "$env:SystemRoot\System32\tar.exe"
  $list = & $tar -tzf $tgz
  if ($LASTEXITCODE -ne 0) { throw "The download isn't a valid archive." }
  if ($list | Where-Object { $_ -match '(^[/\\])|(^|[/\\])\.\.([/\\]|$)|^[A-Za-z]:' }) { throw "The download contains unsafe paths, so it was not installed." }
  $stage = "$work\stage"
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  & $tar -xzf $tgz -C $stage
  if ($LASTEXITCODE -ne 0) { throw "Unpacking the download failed." }
  if (-not (Test-Path "$stage\apps\worker\package.json") -or ((Get-Content "$stage\VERSION" -Raw).Trim() -ne $latest)) { throw "The download isn't the version it claims to be." }

  Set-Progress "running" "Installing files"
  $oldLock = if (Test-Path "$AppDir\pnpm-lock.yaml") { (Get-FileHash "$AppDir\pnpm-lock.yaml" -Algorithm SHA256).Hash } else { "none" }
  Stop-WorkerProcesses   # nothing may hold the files or run next to the new code
  robocopy $stage $AppDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying the new files failed (robocopy $LASTEXITCODE)." }
  $newLock = if (Test-Path "$AppDir\pnpm-lock.yaml") { (Get-FileHash "$AppDir\pnpm-lock.yaml" -Algorithm SHA256).Hash } else { "none" }
  if ($oldLock -ne $newLock -or -not (Test-Path "$AppDir\apps\worker\node_modules")) {
    Set-Progress "running" "Installing packages"
    $env:Path = "$NodeDir;$env:Path"
    $env:PUPPETEER_CACHE_DIR = $ChromeDir
    Push-Location $AppDir
    & "$NodeDir\npx.cmd" -y pnpm@9.15.4 install --frozen-lockfile --filter "@spot/worker..."
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "Installing packages failed (see the console log). Try again." }
  }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue

  Set-Progress "running" "Restarting the worker"
  Start-ScheduledTask -TaskName $WorkerTask
  if (-not (Test-NoLocal)) { Invoke-Pull (Get-ModelName $lmodel) }
  Set-Progress "done" "Updated to $latest"
  Restart-Console   # last: the console serves the new page once its loop starts it again
}
catch {
  Set-Progress "error" "Failed" $_.Exception.Message
  # Whatever failed, never leave the server stopped.
  Start-ScheduledTask -TaskName $WorkerTask -ErrorAction SilentlyContinue
  exit 1
}

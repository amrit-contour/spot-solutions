<#
  Nothing BOT Server tasks on Windows: update, local-on, local-off.

  Run as SYSTEM by the scheduled task "NothingBotServerUpdate" (registered by install.ps1), which the server console starts
  with `schtasks /run`. The task runs C:\NothingBotServer\update.ps1, a tiny stub that copies THIS file next to it and runs
  the copy, so replacing the app folder never replaces a script that is running. Nothing here needs an interactive admin.

  Progress goes to C:\NothingBotServer\data\update.json for the console. Which task to run is in data\task.json.
  Test hooks: NBS_DIST_URL, NBS_ROOT.
#>
param([string]$Task = "")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Settings from before the rename to Nothing BOT Server were called SPOT_*; keep honouring them.
Get-ChildItem Env: | Where-Object { $_.Name -like 'SPOT_*' } | ForEach-Object { $n = 'NBS_' + $_.Name.Substring(5); if (-not (Test-Path "Env:$n")) { Set-Item "Env:$n" $_.Value } }

$Root      = if ($env:NBS_ROOT) { $env:NBS_ROOT } else { "C:\NothingBotServer" }
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
$WorkerTask  = "NothingBotServerWorker"
$ConsoleTask = "NothingBotServerConsole"
$Dist      = if ($env:NBS_DIST_URL) { $env:NBS_DIST_URL } else { "https://nothingbotcurating.web.app" }
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
# A server the owner stopped (console: Stop server) stays stopped: an update, the local-model switch or a move never starts it.
function Test-WorkerStopped { return ((Get-EnvValue "NBS_WORKER_STOPPED") -match '^(1|true|yes)$') }
function Start-Worker {
  if (Test-WorkerStopped) { return }
  Enable-ScheduledTask -TaskName $WorkerTask -ErrorAction SilentlyContinue | Out-Null
  Start-ScheduledTask -TaskName $WorkerTask -ErrorAction SilentlyContinue
}
# Launchers from before "Stop server" / the Ollama Stop button don't look at the flags: teach them (it takes effect when the loop
# is next started). Each patch is independent, so a launcher that knows the worker flag still learns the model flag.
function Update-Launcher {
  $f = "$Root\run-worker.ps1"
  if (-not (Test-Path $f)) { return }
  $t = Get-Content $f -Raw
  $orig = $t
  if ($t -notmatch 'NBS_WORKER_STOPPED') {
    $fn = "function Stopped { try { (Get-Content '$EnvFile' -Raw) -match '(?m)^NBS_WORKER_STOPPED=(1|true|yes)\s*$' } catch { `$false } }"
    $t = $t.Replace("function No-Local {", "$fn`r`nfunction No-Local {")
    $t = [regex]::Replace($t, '(?m)^(while \(\$true\) \{)\r?$', '$1' + "`r`n  if (Stopped) { Start-Sleep 10; continue }")
  }
  if ($t -notmatch 'NBS_MODEL_STOPPED') {
    $fn = "function Model-Stopped { try { (Get-Content '$EnvFile' -Raw) -match '(?m)^NBS_MODEL_STOPPED=(1|true|yes)\s*$' } catch { `$false } }"
    $t = $t.Replace("function No-Local {", "$fn`r`nfunction No-Local {")
    $t = $t.Replace('if (-not (No-Local) -and -not (Ollama-Up))', 'if (-not (No-Local) -and -not (Model-Stopped) -and -not (Ollama-Up))')
  }
  if ($t -ne $orig) { Set-Content -Encoding UTF8 $f $t }
}
# The console shortcut's icon is the Nothing BOT Server icon (it arrives with the code). Servers installed before it existed
# get it here: copy the file and point the existing Console shortcuts at it. Never fatal.
function Update-ConsoleIcon {
  try {
    $src = "$AppDir\deploy\windows\nbs-server.ico"
    if (-not (Test-Path $src)) { return }
    $dst = "$Root\nbs-server.ico"
    Copy-Item $src $dst -Force
    $shell = New-Object -ComObject WScript.Shell
    $dirs = @([Environment]::GetFolderPath("CommonDesktopDirectory"), "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Nothing BOT Server")
    foreach ($d in $dirs) {
      $f = "$d\Nothing BOT Server Console.lnk"
      if (Test-Path $f) { $l = $shell.CreateShortcut($f); if ($l.IconLocation -notlike "*nbs-server.ico*") { $l.IconLocation = $dst; $l.Save() } }
    }
  } catch { Write-Host "Couldn't refresh the console icon: $($_.Exception.Message)" }
}
# The owner stopped Ollama from the console (Ollama, Stop): updates leave it stopped until Start (or turning the local model on).
function Test-ModelStopped { return ((Get-EnvValue "NBS_MODEL_STOPPED") -match '^(1|true|yes)$') }
function Test-NoLocal { return ((Get-EnvValue "NBS_NO_LOCAL_MODEL") -match '^(1|true|yes)$') }
function Get-ModelName([string]$Default = "gemma3:4b") {
  $m = Get-EnvValue "NBS_LOCAL_MODEL"
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
    Where-Object { $_.CommandLine -like '*NothingBotServer*' -and $_.CommandLine -notlike '*console*server.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$ChromeDir\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
function Restart-Console {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*NothingBotServer*console*server.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }   # the task's loop starts it again
}
function Invoke-Pull([string]$Model) {
  $ollama = Find-Ollama
  if (-not $ollama) { return }
  if (Test-ModelStopped) { return }   # stopped by the owner: no model download until Start
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
    if (-not (Test-Path $mv)) { throw "move.mjs isn't in the app folder. Update Nothing BOT Server first." }
    $env:NBS_ROOT = $Root
    & "$NodeDir\node.exe" $mv $Task
    $moveCode = $LASTEXITCODE
    if ($moveCode -ne 0) { Start-Worker }   # whatever happened, never leave the server stopped
    exit $moveCode
  }

  # ------------------------------------------------------------------ local model off
  if ($Task -eq "local-off") {
    Set-Progress "running" "Turning the local model off"
    Set-EnvValue "NBS_NO_LOCAL_MODEL" "1"
    Stop-WorkerProcesses
    Get-Process -Name "ollama", "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Worker
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
    Set-EnvValue "NBS_MODEL_STOPPED" "0"   # turning the local model on starts it
    Invoke-Pull (Get-ModelName)
    Set-EnvValue "NBS_NO_LOCAL_MODEL" "0"
    Set-Progress "running" "Restarting the worker"
    Start-Worker
    Restart-Console   # so its Ollama path is current
    Set-Progress "done" "Local model on"
    return
  }

  # ------------------------------------------------------------------ update
  Set-Progress "running" "Checking the latest version"
  $v = Invoke-RestMethod "$Dist/dl/nothing-bot-server.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -TimeoutSec 30
  $latest = "$($v.version)"; $sha = "$($v.sha256)".ToLower(); $lmodel = "$($v.model)"
  if ($latest -notmatch '^[0-9A-Za-z._-]{1,40}$' -or $sha -notmatch '^[0-9a-f]{64}$') { throw "The version file from the update site isn't valid." }
  if ($lmodel -notmatch '^[A-Za-z0-9._:/-]{1,100}$') { $lmodel = "gemma3:4b" }
  $To = $latest
  if ($latest -eq $From) { Set-Progress "done" "Already up to date"; return }

  Set-Progress "running" "Downloading $latest"
  $work = "$Root\update-work"
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $tgz = "$work\app.tgz"
  Invoke-WebRequest "$Dist/dl/nothing-bot-server.tar.gz" -OutFile $tgz

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
  # Every update: the doctor finds, reuses or downloads what this release needs (the browser build follows the pinned
  # puppeteer; pnpm skips puppeteer's own download when it installs from its store cache). apps\worker\console\doctor.mjs
  Set-Progress "running" "Checking WhatsApp's browser and settings"
  $env:Path = "$NodeDir;$env:Path"
  $env:PUPPETEER_CACHE_DIR = $ChromeDir
  $env:NBS_DATA_DIR = $DataDir; $env:NBS_ENV_FILE = "$AppDir\apps\worker\.env"
  & "$NodeDir\node.exe" "$AppDir\apps\worker\console\doctor-run.mjs" --repair
  if ($LASTEXITCODE -ne 0) { throw "Something this version needs couldn't be set up (see the console log). Check the internet connection and try again." }
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  Update-Launcher
  Update-ConsoleIcon

  Set-Progress "running" "Restarting the worker"
  Start-Worker
  if (-not (Test-NoLocal)) { Invoke-Pull (Get-ModelName $lmodel) }
  Set-Progress "done" "Updated to $latest"
  Restart-Console   # last: the console serves the new page once its loop starts it again
}
catch {
  Set-Progress "error" "Failed" $_.Exception.Message
  # Whatever failed, never leave the server stopped.
  Start-Worker
  exit 1
}

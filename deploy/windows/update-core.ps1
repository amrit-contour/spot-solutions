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
$DefaultModels = "$Root\ollama"
# move.mjs writes data-dir (no extension); older notes used .txt. The extension-less file is read last, so it wins.
foreach ($p in @(@{ File = "$Root\data-dir.txt"; Name = "DataDir" }, @{ File = "$Root\data-dir"; Name = "DataDir" })) {
  if (Test-Path $p.File) { $v = (Get-Content $p.File -Raw).Trim(); if ($v) { Set-Variable -Name $p.Name -Value $v } }
}
# The models folder is looked up (see Models-Dir), not assumed: wherever models really are wins, and the pointer is updated to it, so an update never falls back to a default.
$ModelsFn = @'
function Has-Models($d) { try { [bool]$d -and (Test-Path (Join-Path $d 'blobs')) -and [bool](Get-ChildItem (Join-Path $d 'manifests\registry.ollama.ai') -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1) } catch { $false } }
# Where the models are is looked up, never assumed: the first of these that really holds models wins (the models-dir pointer, OLLAMA_MODELS at machine then
# user level, the install's own folder, Ollama's own default in each profile). With none, the pointer, else the install's folder. A winner that is not
# the pointer is written to it, so every launcher and the updater use that exact folder from then on.
function Models-Dir {
  $ptr = $null; foreach ($f in @('__ROOT__\models-dir.txt', '__ROOT__\models-dir')) { try { $v = (Get-Content $f -Raw).Trim(); if ($v) { $ptr = $v } } catch {} }
  $profiles = @(Get-ChildItem "$env:SystemDrive\Users" -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName '.ollama\models' })
  $found = @($ptr, [Environment]::GetEnvironmentVariable('OLLAMA_MODELS', 'Machine'), [Environment]::GetEnvironmentVariable('OLLAMA_MODELS', 'User'), '__MODELS__', (Join-Path $env:USERPROFILE '.ollama\models')) + $profiles | Where-Object { $_ -and (Has-Models $_) } | Select-Object -First 1
  if (-not $found) { if ($ptr) { return $ptr } else { return '__MODELS__' } }
  if ($found -ne $ptr) { try { New-Item -ItemType Directory -Force -Path '__ROOT__' | Out-Null; [IO.File]::WriteAllText('__ROOT__\models-dir', "$found`n") } catch {} }
  $found
}
'@
Invoke-Expression ($ModelsFn.Replace('__ROOT__', $Root).Replace('__MODELS__', $DefaultModels))
$ModelsDir = Models-Dir
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
  # Launchers that baked the models folder in, or only read the pointer: look the models up every time (Models-Dir), and restart an Ollama that is reading another folder.
  if ($t -notmatch 'function Has-Models') {
    $fn = $ModelsFn.Replace('__ROOT__', $Root).Replace('__MODELS__', $DefaultModels)
    if ($t -match '(?m)^function Models-Dir .*$') {
      $t = [regex]::Replace($t, '(?m)^function Models-Dir .*$', { $fn })   # the pointer-only version
    } else {
      $t = [regex]::Replace($t, "(?m)^\`$env:OLLAMA_MODELS = '([^']*)'[ \t]*\r?$", { "$fn`r`n`$env:OLLAMA_MODELS = Models-Dir" })
      $wrongFn = 'function Ollama-Wrong { try { $m = @((Invoke-RestMethod ''http://127.0.0.1:11434/api/tags'' -TimeoutSec 2).models); if ($m.Count -gt 0) { return $false }; return [bool](Get-ChildItem (Join-Path (Models-Dir) ''manifests'') -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1) } catch { $false } }'
      $t = $t.Replace("function Find-Ollama {", "$wrongFn`r`nfunction Find-Ollama {")
      $old = 'if (-not (No-Local) -and -not (Model-Stopped) -and -not (Ollama-Up)) { $o = Find-Ollama; if ($o) { Start-Process -FilePath $o -ArgumentList ''serve'' -WindowStyle Hidden; Start-Sleep 5 } }'
      $new = 'if (-not (No-Local) -and -not (Model-Stopped)) { $env:OLLAMA_MODELS = Models-Dir; if ((Ollama-Up) -and (Ollama-Wrong)) { Get-Process -Name ''ollama'', ''ollama app'' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 2 }; if (-not (Ollama-Up)) { $o = Find-Ollama; if ($o) { Start-Process -FilePath $o -ArgumentList ''serve'' -WindowStyle Hidden; Start-Sleep 5 } } }'
      $t = $t.Replace($old, $new)
    }
  }
  # Ollama's keep-alive follows NBS_OLLAMA_KEEP_ALIVE (default 5m, like the worker); older launchers pinned 24h.
  if ($t -match "OLLAMA_KEEP_ALIVE = '24h'") {
    $ka = 'function Keep-Alive { try { if ((Get-Content ''__ENVFILE__'' -Raw) -match ''(?m)^NBS_OLLAMA_KEEP_ALIVE=(-1|0|\d+(\.\d+)?(ms|s|m|h))\s*$'') { return $Matches[1] } } catch {}; ''5m'' }'.Replace('__ENVFILE__', $EnvFile)
    $t = $t.Replace("`$env:OLLAMA_KEEP_ALIVE = '24h'", "$ka`r`n`$env:OLLAMA_KEEP_ALIVE = Keep-Alive")
  }
  if ($t -ne $orig) { Set-Content -Encoding UTF8 $f $t }
  # The console's launcher: the folder is only a fallback there (the console reads the pointer itself), but keep it right too.
  $cf = "$Root\run-console.ps1"
  if (Test-Path $cf) {
    $ct = Get-Content $cf -Raw
    if ($ct -notmatch 'function Has-Models') {
      $fn = $ModelsFn.Replace('__ROOT__', $Root).Replace('__MODELS__', $DefaultModels)
      $ct2 = [regex]::Replace($ct, '(?m)^\$env:OLLAMA_MODELS = .*$', { "$fn`r`n`$env:OLLAMA_MODELS = Models-Dir" })
      if ($ct2 -ne $ct) { Set-Content -Encoding UTF8 $cf $ct2 }
    }
  }
}
# ---------------------------------------------------------------------------------------------------------------------
# Older installs ("Spot Solutions" / "Spot Server", folder C:\SpotSolutions) and the shortcuts we leave behind.
# Shared by install.ps1 and update-core.ps1 (keep the two copies identical). Only things that are ours are touched:
# matched by the old install folder, old task names, old shortcut names/targets. The old data folder is never deleted.
# ---------------------------------------------------------------------------------------------------------------------
$LegacyRoot = "C:\SpotSolutions"
$LegacyPattern = 'SpotSolutions|spot-solutions\.web\.app|spot\.ico|Spot Solutions|Spot Server'
function Log([string]$m) { Write-Host "  $m" }

function Remove-LegacyInstall {
  $found = $false
  # Startup tasks (also any task whose action runs something from the old folder).
  foreach ($t in @(Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    $txt = (@($t.Actions) | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' '
    if ($t.TaskName -match '^(SpotSolutions|Spot Solutions|Spot Server|SpotServer)' -or $txt -match 'SpotSolutions') {
      $found = $true
      Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false -ErrorAction SilentlyContinue
      Log "Removed old startup task $($t.TaskName)"
    }
  }
  # Startup entries in the registry.
  foreach ($k in 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') {
    $p = Get-ItemProperty $k -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    foreach ($n in @($p.PSObject.Properties.Name)) {
      if ($n -like 'PS*') { continue }
      if ($n -match '^(SpotSolutions|Spot Solutions|Spot Server|SpotServer)' -or "$($p.$n)" -match $LegacyPattern) {
        $found = $true
        Remove-ItemProperty -Path $k -Name $n -ErrorAction SilentlyContinue
        Log "Removed old startup entry '$n'"
      }
    }
  }
  # Running processes from the old folder: the launcher loops first (or they restart the rest), then node and the browser.
  $mine = @($PID)
  $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue).ParentProcessId
  if ($parent) { $mine += $parent }
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $mine -notcontains $_.ProcessId -and (($_.CommandLine -and $_.CommandLine -match 'SpotSolutions') -or ($_.ExecutablePath -and $_.ExecutablePath -like "$LegacyRoot\*"))
  })
  foreach ($order in 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'node.exe', 'chrome.exe') {
    foreach ($p in ($procs | Where-Object { $_.Name -eq $order })) {
      $found = $true
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      Log "Stopped old $($p.Name) (process $($p.ProcessId))"
    }
  }
  Remove-NetFirewallRule -DisplayName "Spot Solutions Console" -ErrorAction SilentlyContinue
  # Shortcuts (desktops, Start menus, taskbar and Start pins, Startup folders) for every user on this PC.
  $dirs = @([Environment]::GetFolderPath('CommonDesktopDirectory'), "$env:ProgramData\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Startup")
  foreach ($u in @(Get-ChildItem "$env:SystemDrive\Users" -Directory -ErrorAction SilentlyContinue)) {
    $h = $u.FullName
    $dirs += "$h\Desktop", "$h\OneDrive\Desktop", "$h\AppData\Roaming\Microsoft\Windows\Start Menu\Programs", "$h\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup",
             "$h\AppData\Roaming\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar", "$h\AppData\Roaming\Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu"
  }
  $shell = New-Object -ComObject WScript.Shell
  $removedPin = $false
  foreach ($d in ($dirs | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)) {
    foreach ($f in @(Get-ChildItem $d -Recurse -Depth 2 -Include *.lnk, *.url -ErrorAction SilentlyContinue)) {
      $txt = $f.BaseName
      try {
        if ($f.Extension -eq '.lnk') { $l = $shell.CreateShortcut($f.FullName); $txt = "$($f.BaseName) $($l.TargetPath) $($l.Arguments) $($l.IconLocation)" }
        else { $txt = "$($f.BaseName) $(Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue)" }
      } catch { }
      if ($txt -match $LegacyPattern) {
        $found = $true
        Remove-Item -Force -ErrorAction SilentlyContinue $f.FullName
        if ($d -like '*User Pinned*') { $removedPin = $true }
        Log "Removed old shortcut $($f.FullName)"
      }
    }
    foreach ($sub in 'Spot Solutions', 'Spot Server') {
      if (Test-Path "$d\$sub") { $found = $true; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$d\$sub"; Log "Removed old Start menu folder $d\$sub" }
    }
  }
  if ($removedPin) { Log "An old taskbar/Start pin was removed. It disappears after signing out and in again; pin 'Nothing BOT Server Console' from the desktop to replace it." }
  if ($found) { Log "Old Spot Solutions server cleaned up. Its data in $LegacyRoot\data is kept." }
  return $found
}

# Port 7420 must belong to this server's console. A console left from an older install (or an old copy that was never
# stopped) would keep serving the old page, so stop it; the console task's loop then starts the new one.
function Release-ConsolePort {
  $freed = $false
  foreach ($c in @(Get-NetTCPConnection -LocalPort 7420 -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    if ("$($p.CommandLine) $($p.ExecutablePath)" -match 'SpotSolutions') {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      Log "Port 7420 was held by the old Spot Solutions console (process $($p.ProcessId)); stopped it."
      $freed = $true
    } elseif ("$($p.CommandLine)" -notmatch 'NothingBotServer') {
      Write-Host "  Port 7420 is used by another program ($($p.Name), process $($p.ProcessId)), so the Server Console can't open. Close it and run this again." -ForegroundColor Yellow
    }
  }
  return $freed
}

# Waits until the console answers on port 7420 and the listener is ours.
function Wait-Console([int]$Seconds = 40) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    Release-ConsolePort | Out-Null
    try { Invoke-WebRequest "http://127.0.0.1:7420/" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { Start-Sleep 1 }
  }
  return $false
}

# Desktop + Start menu shortcuts, always rewritten so icons and addresses are current: the console uses the Nothing BOT
# Server icon, the Curate web app uses the Curate icon (both ship in the code download, no downloading at install time).
function Install-Shortcuts {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
    $serverIcon = $null; $curatingIcon = $null
    foreach ($src in @("$AppDir\deploy\windows\nbs-server.ico", "$PSScriptRoot\nbs-server.ico")) { if ($src -and (Test-Path $src)) { Copy-Item $src "$Root\nbs-server.ico" -Force; $serverIcon = "$Root\nbs-server.ico"; break } }
    foreach ($src in @("$AppDir\deploy\windows\nbc-curating.ico", "$PSScriptRoot\nbc-curating.ico", "$AppDir\apps\web\public\favicon.ico")) { if ($src -and (Test-Path $src)) { Copy-Item $src "$Root\nbc-curating.ico" -Force; $curatingIcon = "$Root\nbc-curating.ico"; break } }
    Remove-Item -Force -ErrorAction SilentlyContinue "$Root\nbs.ico", "$Root\spot.ico"
    $places = @([Environment]::GetFolderPath("CommonDesktopDirectory"), "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Nothing BOT Server")
    New-Item -ItemType Directory -Force -Path $places[1] | Out-Null
    foreach ($dir in $places) {
      # The web app was called "Nothing BOT Curating" before the rename: drop the old-named shortcut.
      Remove-Item -Force -ErrorAction SilentlyContinue "$dir\Nothing BOT Curating.lnk"
      foreach ($sc in @(
        @{ Name = "Nothing BOT Server Console"; Url = "http://localhost:7420"; Icon = $serverIcon },
        @{ Name = "Nothing BOT Curate"; Url = "https://nothingbotcurate.web.app"; Icon = $curatingIcon }
      )) {
        $lnk = $shell.CreateShortcut("$dir\$($sc.Name).lnk")
        if (Test-Path $edge) { $lnk.TargetPath = $edge; $lnk.Arguments = "--app=$($sc.Url)" } else { $lnk.TargetPath = $sc.Url; $lnk.Arguments = "" }
        if ($sc.Icon) { $lnk.IconLocation = "$($sc.Icon),0" }
        $lnk.Save()
      }
    }
    # Windows keeps showing a shortcut's old picture from its icon cache; ask it to rebuild.
    try { Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList "-show" -WindowStyle Hidden -ErrorAction SilentlyContinue } catch { }
    Log "Shortcuts refreshed: 'Nothing BOT Server Console' and 'Nothing BOT Curate' (desktop and Start menu)"
  } catch { Write-Host "  Couldn't refresh the shortcuts: $($_.Exception.Message)" -ForegroundColor Yellow }
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
# Ollama is up but lists no models while the models folder has them: it is reading another folder (Ollama's tray app, or an old environment).
function Test-OllamaWrongFolder {
  try {
    $m = @((Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 2).models)
    if ($m.Count -gt 0) { return $false }
    return [bool](Get-ChildItem (Join-Path $ModelsDir "manifests") -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)
  } catch { return $false }
}
function Invoke-Pull([string]$Model) {
  $ollama = Find-Ollama
  if (-not $ollama) { return }
  if (Test-ModelStopped) { return }   # stopped by the owner: no model download until Start
  $env:OLLAMA_MODELS = $ModelsDir
  if ((Test-OllamaUp) -and (Test-OllamaWrongFolder)) {
    Get-Process -Name "ollama", "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep 2
  }
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
    [Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE", $(if ((Get-EnvValue "NBS_OLLAMA_KEEP_ALIVE") -match '^(-1|0|\d+(\.\d+)?(ms|s|m|h))$') { Get-EnvValue "NBS_OLLAMA_KEEP_ALIVE" } else { "5m" }), "Machine")
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
  # VERSION is written last, once everything below worked: a half-finished update is retried instead of "already up to date".
  $newVersion = (Get-Content "$stage\VERSION" -Raw).Trim()
  Remove-Item -Force "$stage\VERSION"
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
  Set-Progress "running" "Refreshing shortcuts and icons"
  Remove-LegacyInstall | Out-Null   # an old Spot Solutions server or shortcut left on this PC
  Install-Shortcuts

  Set-Progress "running" "Restarting the worker"
  Start-Worker
  if (-not (Test-NoLocal)) { Invoke-Pull (Get-ModelName $lmodel) }
  [IO.File]::WriteAllText("$AppDir\VERSION", "$newVersion`n", $Utf8)
  Set-Progress "done" "Updated to $latest"
  Restart-Console   # last: the console serves the new page once its loop starts it again
  Start-Sleep 4
  Wait-Console 30 | Out-Null   # and port 7420 must be this server's console, not an old copy
}
catch {
  Set-Progress "error" "Failed" $_.Exception.Message
  # Whatever failed, never leave the server stopped.
  Start-Worker
  exit 1
}

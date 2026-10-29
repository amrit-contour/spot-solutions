<#
  Nothing BOT Server: native install for Windows 10/11.

  Installs its own Node.js (C:\NothingBotServer\node) and Ollama (via winget), pulls Gemma, clones the repo, and registers a Scheduled Task that starts the worker at boot
  (before anyone logs in) and restarts it if it crashes. Also stops the laptop sleeping on power.

  Easiest: double-click "Install Nothing BOT Server.cmd". Or, in PowerShell as Administrator:

    Set-ExecutionPolicy -Scope Process Bypass -Force
    irm https://nothingbotcurating.web.app/install.ps1 | iex

  Re-running is safe: it updates the code and restarts the task. After this first install the server updates itself:
  the Server Console has an Update now button and installs updates automatically (scheduled task NothingBotServerUpdate).

  Local model or Gemini only? You choose in the Server Console (AI models) and can switch any time. The installer picks
  for you: a local model on PCs with about 8 GB of memory or more, Gemini only on smaller ones. To force it, set
  $env:NBS_NO_LOCAL_MODEL = "1" (or "0") first, or use "Install Nothing BOT Server (Gemini only).cmd".
  Re-running without it keeps whatever the previous install chose.

  Where the data and AI models live (WhatsApp logins, backups, logs, models): a fresh install asks, listing the drives with free
  space and pre-selecting the fixed drive with the most room (one Enter accepts it; the helper is deploy/datadir.mjs). Cloud-synced
  folders (OneDrive, Dropbox, Google Drive, iCloud), removable/USB/network drives and the program folder are refused. Unattended:
  $env:NBS_DATA_DIR = "D:\Nothing BOT Server" (or -DataDir "D:\Nothing BOT Server" on the command line) uses that folder, and
  $env:NBS_YES = "1" (or -Yes) takes the suggestion. Re-running or updating keeps an earlier choice and does not ask again.
  The program itself always stays in C:\NothingBotServer.
#>
$ErrorActionPreference = "Stop"
# Settings from before the rename to Nothing BOT Server were called SPOT_*; keep honouring them.
Get-ChildItem Env: | Where-Object { $_.Name -like 'SPOT_*' } | ForEach-Object { $n = 'NBS_' + $_.Name.Substring(5); if (-not (Test-Path "Env:$n")) { Set-Item "Env:$n" $_.Value } }
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is painfully slow with the progress bar
# Run through `irm | iex`, PowerShell blames every error on "line 1". Show the real statement instead.
trap {
  Write-Host "`n  Install failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  At: $("$($_.InvocationInfo.Line)".Trim())" -ForegroundColor Red
  break
}

# Unattended data location: -DataDir <folder> / -Yes on the command line, or NBS_DATA_DIR / NBS_YES (read from $args, so it also runs through irm | iex).
$ReqDataDir = $env:NBS_DATA_DIR
$AssumeYes = [bool]($env:NBS_YES -match '^(1|true|yes)$')
for ($i = 0; $i -lt $args.Count; $i++) {
  if ("$($args[$i])" -match '^-{1,2}DataDir$' -and $i + 1 -lt $args.Count) { $ReqDataDir = [string]$args[$i + 1]; $i++ }
  elseif ("$($args[$i])" -match '^-{1,2}(Yes|y)$') { $AssumeYes = $true }
}

$BaseUrl   = if ($env:NBS_BASE_URL) { $env:NBS_BASE_URL } else { "https://nothingbotcurating.web.app" }
$SrcUrl    = if ($env:NBS_SRC_URL) { $env:NBS_SRC_URL } else { "$BaseUrl/dl/nothing-bot-server.tar.gz" }
$Root      = "C:\NothingBotServer"
$AppDir    = "$Root\app"
$DataDir   = "$Root\data"
$DefaultModels = "$Root\ollama"   # shared by the tray app and the boot task, so Gemma downloads once
# The data (and the AI models) may have been moved to another drive in the Server Console (Storage, Move data). That choice
# is kept in these two files: re-running the installer keeps the chosen folders instead of going back to C:.
# The console's "Move data" writes data-dir / models-dir (no extension); older notes used .txt. Either works.
foreach ($f in @("$Root\data-dir", "$Root\data-dir.txt")) { if (Test-Path $f) { $p = (Get-Content $f -Raw).Trim(); if ($p) { $DataDir = $p; break } } }
# The models folder is looked up (see Models-Dir below), not assumed: wherever models really are wins, and the pointer is updated to it.
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
if ($DataDir -ne "$Root\data") {
  if (-not (Test-Path (Split-Path $DataDir -Qualifier))) { throw "Your data lives on $(Split-Path $DataDir -Qualifier) ($DataDir), but that drive isn't connected. Plug it in and run this again." }
  Write-Host "Keeping the data in $DataDir (chosen in the Server Console)." -ForegroundColor Cyan
}
$ChromeDir = "$Root\chrome"   # Chrome for WhatsApp Web, readable by the SYSTEM account
$TaskName  = "NothingBotServerWorker"
$Model     = if ($env:GEMMA_MODEL) { $env:GEMMA_MODEL } else { "gemma3:4b" }

# Gemini-only? An explicit NBS_NO_LOCAL_MODEL wins; otherwise keep what an earlier install wrote to .env.
$NoLocal = $false
if ($env:NBS_NO_LOCAL_MODEL) { $NoLocal = ($env:NBS_NO_LOCAL_MODEL -match '^(1|true|yes)$') }
elseif (Test-Path "$AppDir\apps\worker\.env") { $NoLocal = [bool](Select-String -Path "$AppDir\apps\worker\.env" -Pattern '^NBS_NO_LOCAL_MODEL=1' -Quiet) }
else {
  # A fresh install: a local model needs about 8 GB. Switchable later in the Server Console.
  $ram = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).TotalPhysicalMemory
  if ($ram -and $ram -lt 7.3e9) { $NoLocal = $true; Write-Host "This PC has under 8 GB of memory, so it will use Gemini. You can turn on a local model later in the Server Console." }
}
$NoLocalFlag = if ($NoLocal) { "1" } else { "0" }

function Step($msg) { Write-Host "`n> $msg" -ForegroundColor Yellow }
function Ok($msg) { Write-Host "  $msg" -ForegroundColor Green }

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


$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this as Administrator (double-click 'Install Nothing BOT Server.cmd')." }

# Our own Node stays first: an older system Node (e.g. v18) must never run pnpm or the worker.
function Refresh-Path {
  $env:Path = "$Root\node;" + [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# A fresh install isn't on this window's PATH yet, so look in the usual places too.
function Find-Exe($name, [string[]]$candidates) {
  Refresh-Path
  $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Winget-Install($id) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return }
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
}

$OllamaCandidates = @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe")

Step "Node.js"
# Our own copy in C:\NothingBotServer\node. The boot task runs as SYSTEM, which can't use per-user
# installs (nvm, Volta, fnm, AppData), and a system Node may be too old or a shim that prints nothing.
$NodeDir = "$Root\node"
$Node    = "$NodeDir\node.exe"
function Node-Major {
  if (-not (Test-Path $Node)) { return 0 }
  $v = "$(& $Node -v 2>$null)".Trim()
  if ($v -match '^v(\d+)\.') { return [int]$Matches[1] } else { return 0 }
}
if ((Node-Major) -lt 22) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $v = "v22.12.0"
  try {
    # Assign first: Windows PowerShell passes a JSON array down the pipeline as one item otherwise.
    $releases = Invoke-RestMethod "https://nodejs.org/dist/index.json"
    $latest = ($releases | Where-Object { $_.lts -and $_.version -like "v22.*" } | Select-Object -First 1).version
    if ($latest) { $v = $latest }
  } catch { Write-Host "  Couldn't read the Node.js release list, using $v" }
  Write-Host "  Downloading Node.js $v ($arch)..."
  $zip = "$env:TEMP\node-$v-win-$arch.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-$arch.zip" -OutFile $zip
  $unpack = "$env:TEMP\nbs-node"
  Remove-Item -Recurse -Force $unpack, $NodeDir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $unpack | Out-Null
  # .NET's zip reader: present on every Windows, unlike tar.exe (Git's tar can shadow it and can't read zips).
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpack)
  $exe = Get-ChildItem $unpack -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $exe) { throw "Unpacking Node.js failed: node.exe isn't in the download. Run this again." }
  # On a fresh install C:\NothingBotServer doesn't exist yet, and Move-Item won't create the parent folder.
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  Move-Item $exe.Directory.FullName $NodeDir
}
$major = Node-Major
if ($major -lt 22) { throw "Couldn't set up Node.js in $NodeDir. Check the internet connection and run this again." }
$env:Path = "$NodeDir;$env:Path"
Ok "Node $(& $Node -v) at $Node"

Step "Where to keep the data"
# deploy/datadir.mjs (fetched next to this installer: the code isn't unpacked yet) lists the drives, pre-selects the one with the most
# room, refuses cloud-synced / removable / network places and the program folder, and writes the same data-dir / models-dir pointer
# files the Server Console's Move data writes. A pointer from an earlier install or a move is kept and nothing is asked.
if ((Test-Path "$Root\data-dir") -or (Test-Path "$Root\data-dir.txt")) {
  Ok "Keeping the data in $DataDir (chosen earlier)"
} else {
  $DataJs = $env:NBS_DATADIR_SCRIPT
  if (-not $DataJs) {
    $DataJs = "$env:TEMP\nbs-datadir.mjs"
    try { Invoke-WebRequest "$BaseUrl/datadir.mjs" -OutFile $DataJs -UseBasicParsing }
    catch { $DataJs = $null; Write-Host "  Couldn't fetch the data-location helper, so the data goes in $DataDir. Move it later in the Server Console (Storage)." }
  }
  if ($DataJs) {
    $DataRes = "$env:TEMP\nbs-datadir.json"
    Remove-Item $DataRes -ErrorAction SilentlyContinue
    $dargs = @($DataJs, "choose", "--platform", "win32", "--state-dir", $Root, "--program-root", $Root, "--program-dir", $AppDir, "--forbid", "$Root\node", "--forbid", "$Root\chrome", "--forbid", "$Root\ollama-app", "--model", $Model, "--out", $DataRes)
    if ($NoLocal) { $dargs += "--no-local" }
    if ($AssumeYes) { $dargs += "--yes" }
    if ($ReqDataDir) { $dargs += @("--data-dir", $ReqDataDir) }
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    & $Node @dargs
    if ($LASTEXITCODE -ne 0) { throw "Nothing was installed because of the data location above. Run again with -DataDir <folder> (or set `$env:NBS_DATA_DIR) to use another folder, or leave it out to use $DataDir." }
    Remove-Item $DataRes -ErrorAction SilentlyContinue
    # The pointer files are the answer (none: the default folders).
    foreach ($f in @("$Root\data-dir", "$Root\data-dir.txt")) { if (Test-Path $f) { $p = (Get-Content $f -Raw).Trim(); if ($p) { $DataDir = $p; break } } }
    $ModelsDir = Models-Dir
    if ($DataDir -ne "$Root\data") {
      # Browser profiles nest deeper than 260 characters (the same setting Move data makes).
      reg.exe add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f | Out-Null
      Ok "Data in $DataDir, AI models in $ModelsDir"
    }
  }
}

New-Item -ItemType Directory -Force -Path $ModelsDir, $DataDir, $ChromeDir | Out-Null
$Ollama = $null
if ($NoLocal) {
  Step "Gemini-only server: skipping Ollama and Gemma"
  Ok "AI will use Gemini (add a Gemini key in the Server Console or the app)"
} else {
Step "Ollama + Gemma ($Model)"
$Ollama = Find-Exe "ollama" $OllamaCandidates
if (-not $Ollama) { Winget-Install "Ollama.Ollama"; $Ollama = Find-Exe "ollama" $OllamaCandidates }
if (-not $Ollama) { throw "Couldn't install Ollama. Install it from https://ollama.com/download, then run this again." }
Ok "Ollama at $Ollama"
[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $ModelsDir, "Machine")
[Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE", "5m", "Machine")   # NBS_OLLAMA_KEEP_ALIVE default; the launchers read the override
$env:OLLAMA_MODELS = $ModelsDir
# The tray app may already be running with its default model folder; restart the server on ours.
Get-Process -Name "ollama", "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2
Start-Process -FilePath $Ollama -ArgumentList "serve" -WindowStyle Hidden
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep 1 }
}
& $Ollama pull $Model
if ($LASTEXITCODE -ne 0) { throw "Downloading $Model failed. Check the internet connection and run this again." }
} # end of: not Gemini-only

Step "Nothing BOT Server code"
[Environment]::SetEnvironmentVariable("PUPPETEER_CACHE_DIR", $ChromeDir, "Machine")
$env:PUPPETEER_CACHE_DIR = $ChromeDir
# Code comes as a tarball (Windows 10+ ships tar.exe). .env and node_modules aren't in it, so updates keep them.
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$tgz = "$env:TEMP\nothing-bot-server.tar.gz"
Invoke-WebRequest $SrcUrl -OutFile $tgz
# Windows' own tar by full path: Git for Windows' tar can come first on PATH and reads "C:\..." as a remote host.
& "$env:SystemRoot\System32\tar.exe" -xzf $tgz -C $AppDir
if ($LASTEXITCODE -ne 0) { throw "Unpacking the code failed." }
Push-Location $AppDir
# Run the exact pnpm the repo pins, through npx (no corepack needed).
$env:Path = "$NodeDir;$env:Path"   # again: steps above may have refreshed PATH
& "$NodeDir\npx.cmd" -y pnpm@9.15.4 install --frozen-lockfile --filter "@spot/worker..."
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "Installing dependencies failed (see above)." }
# pnpm skips puppeteer's own Chrome download when it installs from its store cache, so make sure the browser is there
# (an older install's identical build is copied instead of downloaded).
Step "WhatsApp's browser"
& "$NodeDir\node.exe" "$AppDir\deploy\ensure-browser.mjs" --from "C:\SpotSolutions\chrome"
if ($LASTEXITCODE -ne 0) { throw "Couldn't install the browser WhatsApp needs (Chrome). Check the internet connection and run this again." }

Step "Configuration"
# Same flow as Linux: no questions here. Keys go in through the Server Console afterwards
# (desktop shortcut), and the worker waits until a Firebase key is there.
$EnvFile = "$AppDir\apps\worker\.env"
$KeyFile = "$DataDir\service-account.json"
if (-not (Test-Path $EnvFile)) {
  @"
FIREBASE_SERVICE_ACCOUNT=$KeyFile
FIREBASE_PROJECT_ID=
OLLAMA_URL=http://127.0.0.1:11434
GEMINI_API_KEY=
NBS_ADMIN_EMAILS=$($env:ADMIN_EMAILS)
WWEBJS_DATA=$DataDir\wwebjs
CHROME_PATH=
NBS_NO_LOCAL_MODEL=$NoLocalFlag
"@ | Set-Content -Encoding ASCII $EnvFile
}
# Record the choice in an existing .env too (re-running to switch between local model and Gemini-only).
$envText = Get-Content $EnvFile -Raw
if ($envText -match '(?m)^NBS_NO_LOCAL_MODEL=') { $envText = $envText -replace '(?m)^NBS_NO_LOCAL_MODEL=.*', "NBS_NO_LOCAL_MODEL=$NoLocalFlag" }
else { $envText = $envText.TrimEnd() + "`r`nNBS_NO_LOCAL_MODEL=$NoLocalFlag`r`n" }
Set-Content -Encoding ASCII $EnvFile $envText
# Only SYSTEM (the boot tasks) and Administrators can read config and keys.
icacls $DataDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
icacls $EnvFile /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
Ok "Config at $EnvFile"

Step "Checking for an older install"
# An old Spot Solutions server (C:\SpotSolutions, tasks SpotSolutions*, shortcuts "Spot Solutions" / "Spot Server") would fight
# this one for the same WhatsApp login and port 7420, and its shortcuts would keep opening the old page. Stop it and remove its
# startup tasks, startup entries, shortcuts and firewall rule. Its data folder is kept.
if (Remove-LegacyInstall) {
  Ok "This server restores your WhatsApp login from the cloud vault by itself once it is connected to the same account."
} else { Ok "Nothing old found" }

Step "Start at boot"
# Re-install over a running copy: stop the old task, its worker and the browsers it left behind, so nothing keeps
# a lock on the files below and the new worker never runs next to an old one on the same WhatsApp profiles.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
# (The Server Console's node is spared: it may be what started this install.)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*NothingBotServer*' -and $_.CommandLine -notlike '*console*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$ChromeDir\*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
# Launcher: start Ollama if needed (unless the owner stopped it: NBS_MODEL_STOPPED), then keep the worker running. Full paths, so it works as SYSTEM. Whether a local
# model is wanted, and where Ollama is, are looked up each time round, so turning it on later in the console just works.
$Launcher = "$Root\run-worker.ps1"
@'
__MODELSFN__
function Keep-Alive { try { if ((Get-Content '__ENVFILE__' -Raw) -match '(?m)^NBS_OLLAMA_KEEP_ALIVE=(-1|0|\d+(\.\d+)?(ms|s|m|h))\s*$') { return $Matches[1] } } catch {}; '5m' }
$env:OLLAMA_MODELS = Models-Dir
$env:OLLAMA_KEEP_ALIVE = Keep-Alive
$env:PUPPETEER_CACHE_DIR = '__CHROME__'
$env:Path = '__NODEDIR__;' + $env:Path
function Ollama-Up { try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; $true } catch { $false } }
function Stopped { try { (Get-Content '__ENVFILE__' -Raw) -match '(?m)^NBS_WORKER_STOPPED=(1|true|yes)\s*$' } catch { $false } }
function Model-Stopped { try { (Get-Content '__ENVFILE__' -Raw) -match '(?m)^NBS_MODEL_STOPPED=(1|true|yes)\s*$' } catch { $false } }
function No-Local { try { (Get-Content '__ENVFILE__' -Raw) -match '(?m)^NBS_NO_LOCAL_MODEL=(1|true|yes)\s*$' } catch { $false } }
# Ollama is up but lists no models while the models folder has them: it is reading a different folder (Ollama's tray app, or an old environment).
function Ollama-Wrong { try { $m = @((Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2).models); if ($m.Count -gt 0) { return $false }; return [bool](Get-ChildItem (Join-Path (Models-Dir) 'manifests') -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1) } catch { $false } }
function Find-Ollama {
  foreach ($c in @('__ROOT__\ollama-app\ollama.exe', "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe", 'C:\Windows\System32\config\systemprofile\AppData\Local\Programs\Ollama\ollama.exe')) { if (Test-Path $c) { return $c } }
  $g = Get-Command ollama -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($g) { return $g.Source }
  return $null
}
Set-Location '__APPDIR__\apps\worker'
while ($true) {
  # Idle while the owner has stopped the server (console: Stop server), and until the server is connected (a key exists).
  if (Stopped) { Start-Sleep 10; continue }
  if (-not (Test-Path '__KEYFILE__')) { Start-Sleep 10; continue }
  # Ollama is started only when a local model is wanted and the owner hasn't stopped it (console: Ollama, Stop).
  if (-not (No-Local) -and -not (Model-Stopped)) {
    $env:OLLAMA_MODELS = Models-Dir   # fresh: a move may have changed it since this script started
    if ((Ollama-Up) -and (Ollama-Wrong)) { Get-Process -Name 'ollama', 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 2 }
    if (-not (Ollama-Up)) { $o = Find-Ollama; if ($o) { Start-Process -FilePath $o -ArgumentList 'serve' -WindowStyle Hidden; Start-Sleep 5 } }
  }
  "$(Get-Date -Format s) starting worker" | Out-File -Append -Encoding utf8 '__DATADIR__\worker.log'
  & '__NODE__' '__APPDIR__\apps\worker\node_modules\tsx\dist\cli.mjs' --env-file-if-exists=.env src\index.ts *>> '__DATADIR__\worker.log'
  Start-Sleep 10
}
'@.Replace('__MODELSFN__', $ModelsFn) -replace '__MODELS__', $DefaultModels -replace '__CHROME__', $ChromeDir -replace '__NODEDIR__', $NodeDir -replace '__ENVFILE__', $EnvFile -replace '__ROOT__', $Root -replace '__APPDIR__', $AppDir -replace '__KEYFILE__', $KeyFile -replace '__DATADIR__', $DataDir -replace '__NODE__', $Node | Set-Content -Encoding UTF8 $Launcher

$action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
             -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
# Hand Ollama over to the task: stop the copy this installer started (nothing to stop when Gemini-only).
if (-not $NoLocal) { Get-Process -Name "ollama" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName $TaskName
Ok "Task '$TaskName' registered and started"

Step "Server Console (port 7420)"
$ConsoleTask = "NothingBotServerConsole"
$cEnvScript = "$Root\run-console.ps1"
@'
$env:NBS_DATA_DIR = '__DATADIR__'
$env:NBS_ENV_FILE = '__ENVFILE__'
__MODELSFN__
$env:OLLAMA_MODELS = Models-Dir
# Looked up on every start (the console is restarted after the local model is turned on).
foreach ($c in @('__ROOT__\ollama-app\ollama.exe', "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe", 'C:\Windows\System32\config\systemprofile\AppData\Local\Programs\Ollama\ollama.exe')) { if (Test-Path $c) { $env:NBS_OLLAMA_EXE = $c; break } }
while ($true) { & '__NODE__' '__APPDIR__\apps\worker\console\server.mjs' *>> '__DATADIR__\console.log'; Start-Sleep 5 }
'@.Replace('__MODELSFN__', $ModelsFn) -replace '__DATADIR__', $DataDir -replace '__ENVFILE__', $EnvFile -replace '__MODELS__', $DefaultModels -replace '__ROOT__', $Root -replace '__NODE__', $Node -replace '__APPDIR__', $AppDir | Set-Content -Encoding UTF8 $cEnvScript
$cAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$cEnvScript`""
Unregister-ScheduledTask -TaskName $ConsoleTask -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $ConsoleTask -Action $cAction -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $ConsoleTask
# The update task: the console starts it (schtasks /run) to update the server or turn the local model on or off. It runs
# as SYSTEM with no trigger, so updates work unattended and outlive the worker and console restarts they cause.
$UpdateTask = "NothingBotServerUpdate"
$stub = "$Root\update.ps1"
@'
# Started by the Server Console. Runs a private copy of the release's update-core.ps1, so the app folder can be
# replaced while it runs.
$core = '__APPDIR__\deploy\windows\update-core.ps1'
$run = '__ROOT__\update-core.run.ps1'
if (-not (Test-Path $core)) { throw "update-core.ps1 isn't in the app folder. Run the Nothing BOT Server installer again." }
Copy-Item $core $run -Force
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $run
exit $LASTEXITCODE
'@ -replace '__APPDIR__', $AppDir -replace '__ROOT__', $Root | Set-Content -Encoding UTF8 $stub
$uAction   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$stub`""
$uSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Unregister-ScheduledTask -TaskName $UpdateTask -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $UpdateTask -Action $uAction -Principal $principal -Settings $uSettings | Out-Null
# Reachable from phones/laptops on your home or office network (Private and Domain profiles; never Public Wi-Fi).
# A network Windows calls Public still blocks it: the console's Status page warns and has a "Make private" button.
Remove-NetFirewallRule -DisplayName "Nothing BOT Server Console" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Nothing BOT Server Console" -Direction Inbound -Protocol TCP -LocalPort 7420 -Action Allow -Profile Private,Domain | Out-Null
if (@(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }).Count -gt 0) { Write-Host "  This network is set to Public, so other devices can't open the console. Make it Private in Windows Settings (or with the button in the console)." -ForegroundColor Yellow }
if (Wait-Console) { Ok "Console running on port 7420, open on private networks" } else { Write-Host "  The console didn't answer on port 7420 yet. It keeps retrying; if the page doesn't open, run Open Server Console.cmd in a minute." -ForegroundColor Yellow }

Step "Desktop and Start Menu shortcuts"
Install-Shortcuts
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }

Step "Keep the laptop awake on power"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0  # lid closed on power: do nothing
powercfg /setactive SCHEME_CURRENT
Ok "Sleep off while plugged in, lid close ignored"
# The same settings plus disk/USB/Wi-Fi power saving and Windows Update's restart hours, as chosen in the console (Stay on; data\power.json).
$env:NBS_DATA_DIR = $DataDir; $env:NBS_ENV_FILE = $EnvFile
& $Node "$AppDir\apps\worker\console\power-run.mjs" --apply
Ok "Stay-on settings applied (the console's Stay on section shows them)"

Step "Checking everything"
# The doctor (apps\worker\console\doctor.mjs): finds, reuses or downloads what this server needs, and says what it did.
$env:NBS_DATA_DIR = $DataDir; $env:NBS_ENV_FILE = $EnvFile
& $Node "$AppDir\apps\worker\console\doctor-run.mjs" --repair
if ($LASTEXITCODE -ne 0) { Write-Host "  Something this server needs is still broken (see above). It can be retried from the console: Check and repair." -ForegroundColor Yellow }

Step "Done"
Start-Sleep 5
$token = (Get-Content "$DataDir\console-token" -ErrorAction SilentlyContinue)
$ip = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "169.*" } | Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "Open 'Nothing BOT Server Console' on the desktop (it's opening now):" -ForegroundColor Green
Write-Host "  1. Click Connect with Nothing BOT Curate and sign in with Google (an admin account). The worker starts by itself."
Write-Host "     No admin yet (a brand-new project)? Use 'First server ever? Use a key file' in the same card."
if ($NoLocal) { Write-Host "     This server uses Gemini: add a Gemini key under AI models (or each curator in the app). A local model can be turned on there too." }
else { Write-Host "     Local or Gemini only, and which models, is under AI models in the console." }
Write-Host "  2. Link WhatsApp at https://nothingbotcurate.web.app -> Settings."
Write-Host "  The server updates itself; the console has an Update now button."
if ($token -and $ip) {
  $phoneUrl = "http://${ip}:7420/?token=$token"
  Write-Host ""
  Write-Host "Manage this server from your phone (same Wi-Fi): scan this QR code, or open the link." -ForegroundColor Cyan
  # Node writes the QR's block characters straight to the console, which handles them correctly.
  & $Node "$AppDir\apps\worker\console\qr.mjs" $phoneUrl 2>$null
  Write-Host $phoneUrl -ForegroundColor Cyan
}
# The console reads its page once at start. Now that the new files are in place, restart its node so it serves them;
# the task's loop brings it straight back (spared earlier because it may be what started this install).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*NothingBotServer*console*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 4
Wait-Console 30 | Out-Null
if (Test-Path $edge) { Start-Process $edge "--app=http://localhost:7420" } else { Start-Process "http://localhost:7420" }

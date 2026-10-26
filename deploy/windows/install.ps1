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

$BaseUrl   = if ($env:NBS_BASE_URL) { $env:NBS_BASE_URL } else { "https://nothingbotcurating.web.app" }
$SrcUrl    = if ($env:NBS_SRC_URL) { $env:NBS_SRC_URL } else { "$BaseUrl/dl/nothing-bot-server.tar.gz" }
$Root      = "C:\NothingBotServer"
$AppDir    = "$Root\app"
$DataDir   = "$Root\data"
$ModelsDir = "$Root\ollama"   # shared by the tray app and the boot task, so Gemma downloads once
# The data (and the AI models) may have been moved to another drive in the Server Console (Storage, Move data). That choice
# is kept in these two files: re-running the installer keeps the chosen folders instead of going back to C:.
if (Test-Path "$Root\data-dir.txt") { $p = (Get-Content "$Root\data-dir.txt" -Raw).Trim(); if ($p) { $DataDir = $p } }
if (Test-Path "$Root\models-dir.txt") { $p = (Get-Content "$Root\models-dir.txt" -Raw).Trim(); if ($p) { $ModelsDir = $p } }
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
[Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE", "24h", "Machine")
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
# An old Spot Solutions server (C:\SpotSolutions, tasks SpotSolutions*) would fight this one for the same WhatsApp login and
# port 7420. Stop it and remove its startup tasks, shortcuts and firewall rule. Its data folder is kept.
$legacyFound = $false
foreach ($t in "SpotSolutionsWorker", "SpotSolutionsConsole", "SpotSolutionsUpdate") {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    $legacyFound = $true
    Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
  }
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*C:\SpotSolutions*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like 'C:\SpotSolutions\chrome\*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-NetFirewallRule -DisplayName "Spot Solutions Console" -ErrorAction SilentlyContinue
Remove-Item -Force -ErrorAction SilentlyContinue "$([Environment]::GetFolderPath('CommonDesktopDirectory'))\Spot Server Console.lnk"
Remove-Item -Force -ErrorAction SilentlyContinue "$([Environment]::GetFolderPath('CommonDesktopDirectory'))\Spot Solutions.lnk"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Spot Solutions"
if ($legacyFound) {
  Ok "Stopped the old Spot Solutions server. Its data in C:\SpotSolutions\data is kept."
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
# Launcher: start Ollama if needed, then keep the worker running. Full paths, so it works as SYSTEM. Whether a local
# model is wanted, and where Ollama is, are looked up each time round, so turning it on later in the console just works.
$Launcher = "$Root\run-worker.ps1"
@'
$env:OLLAMA_MODELS = '__MODELS__'
$env:OLLAMA_KEEP_ALIVE = '24h'
$env:PUPPETEER_CACHE_DIR = '__CHROME__'
$env:Path = '__NODEDIR__;' + $env:Path
function Ollama-Up { try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; $true } catch { $false } }
function Stopped { try { (Get-Content '__ENVFILE__' -Raw) -match '(?m)^NBS_WORKER_STOPPED=(1|true|yes)\s*$' } catch { $false } }
function No-Local { try { (Get-Content '__ENVFILE__' -Raw) -match '(?m)^NBS_NO_LOCAL_MODEL=(1|true|yes)\s*$' } catch { $false } }
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
  if (-not (No-Local) -and -not (Ollama-Up)) { $o = Find-Ollama; if ($o) { Start-Process -FilePath $o -ArgumentList 'serve' -WindowStyle Hidden; Start-Sleep 5 } }
  "$(Get-Date -Format s) starting worker" | Out-File -Append -Encoding utf8 '__DATADIR__\worker.log'
  & '__NODE__' '__APPDIR__\apps\worker\node_modules\tsx\dist\cli.mjs' --env-file-if-exists=.env src\index.ts *>> '__DATADIR__\worker.log'
  Start-Sleep 10
}
'@ -replace '__MODELS__', $ModelsDir -replace '__CHROME__', $ChromeDir -replace '__NODEDIR__', $NodeDir -replace '__ENVFILE__', $EnvFile -replace '__ROOT__', $Root -replace '__APPDIR__', $AppDir -replace '__KEYFILE__', $KeyFile -replace '__DATADIR__', $DataDir -replace '__NODE__', $Node | Set-Content -Encoding UTF8 $Launcher

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
$env:OLLAMA_MODELS = '__MODELS__'
# Looked up on every start (the console is restarted after the local model is turned on).
foreach ($c in @('__ROOT__\ollama-app\ollama.exe', "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe", 'C:\Windows\System32\config\systemprofile\AppData\Local\Programs\Ollama\ollama.exe')) { if (Test-Path $c) { $env:NBS_OLLAMA_EXE = $c; break } }
while ($true) { & '__NODE__' '__APPDIR__\apps\worker\console\server.mjs' *>> '__DATADIR__\console.log'; Start-Sleep 5 }
'@ -replace '__DATADIR__', $DataDir -replace '__ENVFILE__', $EnvFile -replace '__MODELS__', $ModelsDir -replace '__ROOT__', $Root -replace '__NODE__', $Node -replace '__APPDIR__', $AppDir | Set-Content -Encoding UTF8 $cEnvScript
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
# Reachable from phones/laptops on your home network (private profile only).
Remove-NetFirewallRule -DisplayName "Nothing BOT Server Console" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Nothing BOT Server Console" -Direction Inbound -Protocol TCP -LocalPort 7420 -Action Allow -Profile Private | Out-Null
Ok "Console running, port 7420 open on private networks"

Step "Desktop and Start Menu shortcuts"
$shell = New-Object -ComObject WScript.Shell
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$icon = "$Root\nbs.ico"
try { Invoke-WebRequest "https://spot-solutions.web.app/icons/spot.ico" -OutFile $icon } catch { $icon = $null }
$places = @([Environment]::GetFolderPath("CommonDesktopDirectory"), "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Nothing BOT Server")
New-Item -ItemType Directory -Force -Path $places[1] | Out-Null
foreach ($dir in $places) {
  foreach ($sc in @(
    @{ Name = "Nothing BOT Server Console"; Url = "http://localhost:7420" },
    @{ Name = "Nothing BOT Curating"; Url = "https://spot-solutions.web.app" }
  )) {
    $lnk = $shell.CreateShortcut("$dir\$($sc.Name).lnk")
    if (Test-Path $edge) { $lnk.TargetPath = $edge; $lnk.Arguments = "--app=$($sc.Url)" } else { $lnk.TargetPath = $sc.Url }
    if ($icon) { $lnk.IconLocation = $icon }
    $lnk.Save()
  }
}
Ok "Shortcuts: 'Nothing BOT Server Console' and 'Nothing BOT Curating' on the desktop and in Start"

Step "Keep the laptop awake on power"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0  # lid closed on power: do nothing
powercfg /setactive SCHEME_CURRENT
Ok "Sleep off while plugged in, lid close ignored"

Step "Done"
Start-Sleep 5
$token = (Get-Content "$DataDir\console-token" -ErrorAction SilentlyContinue)
$ip = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "169.*" } | Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "Open 'Nothing BOT Server Console' on the desktop (it's opening now):" -ForegroundColor Green
Write-Host "  1. Click Connect with Nothing BOT Curating and sign in with Google (an admin account). The worker starts by itself."
Write-Host "     No admin yet (a brand-new project)? Use 'First server ever? Use a key file' in the same card."
if ($NoLocal) { Write-Host "     This server uses Gemini: add a Gemini key under AI models (or each curator in the app). A local model can be turned on there too." }
else { Write-Host "     Local or Gemini only, and which models, is under AI models in the console." }
Write-Host "  2. Link WhatsApp at https://spot-solutions.web.app -> Settings."
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
Start-Sleep 6
if (Test-Path $edge) { Start-Process $edge "--app=http://localhost:7420" } else { Start-Process "http://localhost:7420" }

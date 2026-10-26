<#
  Spot Solutions worker: native install for Windows 10/11.

  Installs its own Node.js (C:\SpotSolutions\node) and Ollama (via winget), pulls Gemma, clones the repo, and registers a Scheduled Task that starts the worker at boot
  (before anyone logs in) and restarts it if it crashes. Also stops the laptop sleeping on power.

  Easiest: double-click "Install Spot Solutions.cmd". Or, in PowerShell as Administrator:

    Set-ExecutionPolicy -Scope Process Bypass -Force
    irm https://spot-solutions.web.app/install.ps1 | iex

  Re-running is safe: it updates the code and restarts the task.

  Gemini-only server (skips Ollama and the Gemma download; AI goes to Gemini, so add a Gemini key later):
  double-click "Install Spot Solutions (Gemini only).cmd", or set $env:SPOT_NO_LOCAL_MODEL = "1" before running the install.
  Re-running without it keeps whatever the previous install chose. A Gemini-only server can't host accounts set to "Local only".
#>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is painfully slow with the progress bar
# Run through `irm | iex`, PowerShell blames every error on "line 1". Show the real statement instead.
trap {
  Write-Host "`n  Install failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  At: $("$($_.InvocationInfo.Line)".Trim())" -ForegroundColor Red
  break
}

$SrcUrl    = if ($env:SPOT_SRC_URL) { $env:SPOT_SRC_URL } else { "https://spot-solutions.web.app/dl/spot-solutions.tar.gz" }
$Root      = "C:\SpotSolutions"
$AppDir    = "$Root\app"
$DataDir   = "$Root\data"
$ModelsDir = "$Root\ollama"   # shared by the tray app and the boot task, so Gemma downloads once
$ChromeDir = "$Root\chrome"   # Chrome for WhatsApp Web, readable by the SYSTEM account
$TaskName  = "SpotSolutionsWorker"
$Model     = if ($env:GEMMA_MODEL) { $env:GEMMA_MODEL } else { "gemma3:4b" }

# Gemini-only? An explicit SPOT_NO_LOCAL_MODEL wins; otherwise keep what an earlier install wrote to .env.
$NoLocal = $false
if ($env:SPOT_NO_LOCAL_MODEL) { $NoLocal = ($env:SPOT_NO_LOCAL_MODEL -match '^(1|true|yes)$') }
elseif ((Test-Path "$AppDir\apps\worker\.env") -and (Select-String -Path "$AppDir\apps\worker\.env" -Pattern '^SPOT_NO_LOCAL_MODEL=1' -Quiet)) { $NoLocal = $true }
$NoLocalFlag = if ($NoLocal) { "1" } else { "0" }

function Step($msg) { Write-Host "`n> $msg" -ForegroundColor Yellow }
function Ok($msg) { Write-Host "  $msg" -ForegroundColor Green }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this as Administrator (double-click 'Install Spot Solutions.cmd')." }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
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
# Our own copy in C:\SpotSolutions\node. The boot task runs as SYSTEM, which can't use per-user
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
  $unpack = "$env:TEMP\spot-node"
  Remove-Item -Recurse -Force $unpack, $NodeDir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $unpack | Out-Null
  # .NET's zip reader: present on every Windows, unlike tar.exe (Git's tar can shadow it and can't read zips).
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpack)
  $exe = Get-ChildItem $unpack -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $exe) { throw "Unpacking Node.js failed: node.exe isn't in the download. Run this again." }
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

Step "Spot Solutions code"
[Environment]::SetEnvironmentVariable("PUPPETEER_CACHE_DIR", $ChromeDir, "Machine")
$env:PUPPETEER_CACHE_DIR = $ChromeDir
# Code comes as a tarball (Windows 10+ ships tar.exe). .env and node_modules aren't in it, so updates keep them.
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$tgz = "$env:TEMP\spot-solutions.tar.gz"
Invoke-WebRequest $SrcUrl -OutFile $tgz
# Windows' own tar by full path: Git for Windows' tar can come first on PATH and reads "C:\..." as a remote host.
& "$env:SystemRoot\System32\tar.exe" -xzf $tgz -C $AppDir
if ($LASTEXITCODE -ne 0) { throw "Unpacking the code failed." }
Push-Location $AppDir
# Run the exact pnpm the repo pins, through npx (no corepack needed).
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
SPOT_ADMIN_EMAILS=$($env:ADMIN_EMAILS)
WWEBJS_DATA=$DataDir\wwebjs
CHROME_PATH=
SPOT_NO_LOCAL_MODEL=$NoLocalFlag
"@ | Set-Content -Encoding ASCII $EnvFile
}
# Record the choice in an existing .env too (re-running to switch between local model and Gemini-only).
$envText = Get-Content $EnvFile -Raw
if ($envText -match '(?m)^SPOT_NO_LOCAL_MODEL=') { $envText = $envText -replace '(?m)^SPOT_NO_LOCAL_MODEL=.*', "SPOT_NO_LOCAL_MODEL=$NoLocalFlag" }
else { $envText = $envText.TrimEnd() + "`r`nSPOT_NO_LOCAL_MODEL=$NoLocalFlag`r`n" }
Set-Content -Encoding ASCII $EnvFile $envText
# Only SYSTEM (the boot tasks) and Administrators can read config and keys.
icacls $DataDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
icacls $EnvFile /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
Ok "Config at $EnvFile"

Step "Start at boot"
# Re-install over a running copy: stop the old task, its worker and the browsers it left behind, so nothing keeps
# a lock on the files below and the new worker never runs next to an old one on the same WhatsApp profiles.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
# (The Server Console's node is spared: it may be what started this install.)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*SpotSolutions*' -and $_.CommandLine -notlike '*console*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$ChromeDir\*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
# Launcher: start Ollama if needed, then keep the worker running. Full paths, so it works as SYSTEM.
$Launcher = "$Root\run-worker.ps1"
@"
`$env:OLLAMA_MODELS = '$ModelsDir'
`$env:OLLAMA_KEEP_ALIVE = '24h'
`$env:PUPPETEER_CACHE_DIR = '$ChromeDir'
`$env:SPOT_OLLAMA_EXE = '$Ollama'
`$env:Path = '$NodeDir;' + `$env:Path
function Ollama-Up { try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; `$true } catch { `$false } }
Set-Location '$AppDir\apps\worker'
while (`$true) {
  # Idle until a Firebase key is added in the Server Console.
  if (-not (Test-Path '$KeyFile')) { Start-Sleep 10; continue }
  if ('$NoLocalFlag' -ne '1' -and -not (Ollama-Up)) { Start-Process -FilePath '$Ollama' -ArgumentList 'serve' -WindowStyle Hidden; Start-Sleep 5 }
  "`$(Get-Date -Format s) starting worker" | Out-File -Append -Encoding utf8 '$DataDir\worker.log'
  & '$Node' '$AppDir\apps\worker\node_modules\tsx\dist\cli.mjs' --env-file-if-exists=.env src\index.ts *>> '$DataDir\worker.log'
  Start-Sleep 10
}
"@ | Set-Content -Encoding UTF8 $Launcher

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
$ConsoleTask = "SpotSolutionsConsole"
$cEnvScript = "$Root\run-console.ps1"
@"
`$env:SPOT_DATA_DIR = '$DataDir'
`$env:SPOT_ENV_FILE = '$EnvFile'
`$env:SPOT_OLLAMA_EXE = '$Ollama'
`$env:OLLAMA_MODELS = '$ModelsDir'
while (`$true) { & '$Node' '$AppDir\apps\worker\console\server.mjs' *>> '$DataDir\console.log'; Start-Sleep 5 }
"@ | Set-Content -Encoding UTF8 $cEnvScript
$cAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$cEnvScript`""
Unregister-ScheduledTask -TaskName $ConsoleTask -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $ConsoleTask -Action $cAction -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $ConsoleTask
# Reachable from phones/laptops on your home network (private profile only).
Remove-NetFirewallRule -DisplayName "Spot Solutions Console" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Spot Solutions Console" -Direction Inbound -Protocol TCP -LocalPort 7420 -Action Allow -Profile Private | Out-Null
Ok "Console running, port 7420 open on private networks"

Step "Desktop and Start Menu shortcuts"
$shell = New-Object -ComObject WScript.Shell
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
$icon = "$Root\spot.ico"
try { Invoke-WebRequest "https://spot-solutions.web.app/icons/spot.ico" -OutFile $icon } catch { $icon = $null }
$places = @([Environment]::GetFolderPath("CommonDesktopDirectory"), "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Spot Solutions")
New-Item -ItemType Directory -Force -Path $places[1] | Out-Null
foreach ($dir in $places) {
  foreach ($sc in @(
    @{ Name = "Spot Server Console"; Url = "http://localhost:7420" },
    @{ Name = "Spot Solutions"; Url = "https://spot-solutions.web.app" }
  )) {
    $lnk = $shell.CreateShortcut("$dir\$($sc.Name).lnk")
    if (Test-Path $edge) { $lnk.TargetPath = $edge; $lnk.Arguments = "--app=$($sc.Url)" } else { $lnk.TargetPath = $sc.Url }
    if ($icon) { $lnk.IconLocation = $icon }
    $lnk.Save()
  }
}
Ok "Shortcuts: 'Spot Server Console' and 'Spot Solutions' on the desktop and in Start"

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
Write-Host "Open 'Spot Server Console' on the desktop (it's opening now):" -ForegroundColor Green
Write-Host "  1. Drop this server's own Firebase key into it (one key per device; admins create it with deploy/new-server-key.sh, see /help). The worker starts by itself."
if ($NoLocal) { Write-Host "     Gemini-only: also add a Gemini key (Server Console, or each curator in the app)." }
Write-Host "  2. Add your email under Admins to see this server in the app, from anywhere."
Write-Host "  3. Link WhatsApp at https://spot-solutions.web.app -> Settings."
if ($token -and $ip) { Write-Host "From a phone on this Wi-Fi: http://${ip}:7420/?token=$token" -ForegroundColor Cyan }
if (Test-Path $edge) { Start-Process $edge "--app=http://localhost:7420" } else { Start-Process "http://localhost:7420" }

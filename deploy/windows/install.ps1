<#
  Spot Solutions worker: native install for Windows 10/11.

  Installs Node.js and Ollama (via winget, with a direct-download fallback for Node),
  pulls Gemma, clones the repo, and registers a Scheduled Task that starts the worker at boot
  (before anyone logs in) and restarts it if it crashes. Also stops the laptop sleeping on power.

  Easiest: double-click "Install Spot Solutions.cmd". Or, in PowerShell as Administrator:

    Set-ExecutionPolicy -Scope Process Bypass -Force
    irm https://spot-solutions.web.app/install.ps1 | iex

  Re-running is safe: it updates the code and restarts the task.
#>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is painfully slow with the progress bar

$SrcUrl    = if ($env:SPOT_SRC_URL) { $env:SPOT_SRC_URL } else { "https://spot-solutions.web.app/dl/spot-solutions.tar.gz" }
$Root      = "C:\SpotSolutions"
$AppDir    = "$Root\app"
$DataDir   = "$Root\data"
$ModelsDir = "$Root\ollama"   # shared by the tray app and the boot task, so Gemma downloads once
$ChromeDir = "$Root\chrome"   # Chrome for WhatsApp Web, readable by the SYSTEM account
$TaskName  = "SpotSolutionsWorker"
$Model     = if ($env:GEMMA_MODEL) { $env:GEMMA_MODEL } else { "gemma3:4b" }

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

$NodeCandidates   = @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
$OllamaCandidates = @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe")

Step "Node.js"
$Node = Find-Exe "node" $NodeCandidates
if (-not $Node) { Winget-Install "OpenJS.NodeJS.LTS"; $Node = Find-Exe "node" $NodeCandidates }
if (-not $Node) {
  Write-Host "  winget didn't work, downloading Node.js from nodejs.org..."
  $v = (Invoke-RestMethod "https://nodejs.org/dist/index.json" | Where-Object { $_.lts -and $_.version -like "v22.*" } | Select-Object -First 1).version
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $msi = "$env:TEMP\node-$v-$arch.msi"
  Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-$arch.msi" -OutFile $msi
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  $Node = Find-Exe "node" $NodeCandidates
}
if (-not $Node) { throw "Couldn't install Node.js. Install it from https://nodejs.org (LTS), then run this again." }
$NodeDir = Split-Path $Node
$env:Path = "$NodeDir;$env:Path"
$nodeVersion = (& $Node -v)
if ([int]($nodeVersion.TrimStart("v").Split(".")[0]) -lt 22) { throw "Node $nodeVersion is too old. Spot Solutions needs Node 22 or newer. Update it from https://nodejs.org and run this again." }
Ok "Node $nodeVersion at $Node"

Step "Ollama + Gemma ($Model)"
$Ollama = Find-Exe "ollama" $OllamaCandidates
if (-not $Ollama) { Winget-Install "Ollama.Ollama"; $Ollama = Find-Exe "ollama" $OllamaCandidates }
if (-not $Ollama) { throw "Couldn't install Ollama. Install it from https://ollama.com/download, then run this again." }
Ok "Ollama at $Ollama"
New-Item -ItemType Directory -Force -Path $ModelsDir, $DataDir, $ChromeDir | Out-Null
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

Step "Spot Solutions code"
[Environment]::SetEnvironmentVariable("PUPPETEER_CACHE_DIR", $ChromeDir, "Machine")
$env:PUPPETEER_CACHE_DIR = $ChromeDir
# Code comes as a tarball (Windows 10+ ships tar.exe). .env and node_modules aren't in it, so updates keep them.
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$tgz = "$env:TEMP\spot-solutions.tar.gz"
Invoke-WebRequest $SrcUrl -OutFile $tgz
tar.exe -xzf $tgz -C $AppDir
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
"@ | Set-Content -Encoding ASCII $EnvFile
}
# Only SYSTEM (the boot tasks) and Administrators can read config and keys.
icacls $DataDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
icacls $EnvFile /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
Ok "Config at $EnvFile"

Step "Start at boot"
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
  if (-not (Ollama-Up)) { Start-Process -FilePath '$Ollama' -ArgumentList 'serve' -WindowStyle Hidden; Start-Sleep 5 }
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
# Hand Ollama over to the task: stop the copy this installer started.
Get-Process -Name "ollama" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
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
Write-Host "  1. Drop your Firebase service-account key into it. The worker starts by itself."
Write-Host "  2. Add your email under Admins to see this server in the app, from anywhere."
Write-Host "  3. Link WhatsApp at https://spot-solutions.web.app -> Settings."
if ($token -and $ip) { Write-Host "From a phone on this Wi-Fi: http://${ip}:7420/?token=$token" -ForegroundColor Cyan }
if (Test-Path $edge) { Start-Process $edge "--app=http://localhost:7420" } else { Start-Process "http://localhost:7420" }

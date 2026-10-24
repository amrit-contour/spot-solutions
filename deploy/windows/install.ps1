<#
  Spot Solutions worker: native install for Windows 10/11.

  Installs Node.js, Git and Ollama (via winget, with a direct-download fallback for Node),
  pulls Gemma, clones the repo, and registers a Scheduled Task that starts the worker at boot
  (before anyone logs in) and restarts it if it crashes. Also stops the laptop sleeping on power.

  Easiest: double-click "Install Spot Solutions.cmd". Or, in PowerShell as Administrator:

    Set-ExecutionPolicy -Scope Process Bypass -Force
    irm https://raw.githubusercontent.com/amrit-dash/spot-solutions/main/deploy/windows/install.ps1 | iex

  Re-running is safe: it updates the code and restarts the task.
#>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is painfully slow with the progress bar

$Repo      = "https://github.com/amrit-dash/spot-solutions.git"
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
$GitCandidates    = @("$env:ProgramFiles\Git\cmd\git.exe", "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe")
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

Step "Git"
$Git = Find-Exe "git" $GitCandidates
if (-not $Git) { Winget-Install "Git.Git"; $Git = Find-Exe "git" $GitCandidates }
if (-not $Git) { throw "Couldn't install Git. Install it from https://git-scm.com/download/win, then run this again." }
Ok "Git at $Git"

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
if (Test-Path "$AppDir\.git") { & $Git -C $AppDir pull --ff-only } else { & $Git clone --depth 1 $Repo $AppDir }
if ($LASTEXITCODE -ne 0) { throw "Downloading the code failed." }
Push-Location $AppDir
# Run the exact pnpm the repo pins, through npx (no corepack needed).
& "$NodeDir\npx.cmd" -y pnpm@9.15.4 install --frozen-lockfile --filter "@spot/worker..."
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "Installing dependencies failed (see above)." }

Step "Firebase key"
$EnvFile = "$AppDir\apps\worker\.env"
$KeyFile = "$DataDir\service-account.json"
if (-not (Test-Path $EnvFile)) {
  Write-Host "  Pick your Firebase service-account key (the .json file you downloaded)."
  $src = $null
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = "Choose your Firebase service-account key (.json)"
    $dlg.Filter = "JSON key (*.json)|*.json"
    $dlg.InitialDirectory = "$env:USERPROFILE\Downloads"
    if ($dlg.ShowDialog() -eq "OK") { $src = $dlg.FileName }
  } catch { }
  if (-not $src) { $src = (Read-Host "  Or paste the full path to the .json file").Trim('"', "'", " ") }
  if (-not (Test-Path $src)) { throw "File not found: $src" }
  $key = Get-Content $src -Raw | ConvertFrom-Json
  if ($key.type -ne "service_account" -or -not $key.project_id) { throw "That file isn't a Firebase service-account key. Generate one in Firebase console -> Project settings -> Service accounts." }
  Copy-Item $src $KeyFile -Force
  Ok "Key for project '$($key.project_id)'"
  $gemini = Read-Host "  Gemini API key for backup when the laptop is slow (optional, press Enter to skip)"
  @"
FIREBASE_SERVICE_ACCOUNT=$KeyFile
FIREBASE_PROJECT_ID=$($key.project_id)
OLLAMA_URL=http://127.0.0.1:11434
GEMINI_API_KEY=$gemini
WWEBJS_DATA=$DataDir\wwebjs
CHROME_PATH=
"@ | Set-Content -Encoding ASCII $EnvFile
  # Only SYSTEM (the boot task) and Administrators can read the secrets.
  foreach ($f in @($EnvFile, $KeyFile)) { icacls $f /inheritance:r /grant:r "SYSTEM:(R)" "Administrators:(F)" | Out-Null }
  Write-Host "  You can now delete the downloaded key from $(Split-Path $src); a locked-down copy is in $DataDir." -ForegroundColor Cyan
} else {
  Ok "Already configured ($EnvFile)"
}

Step "Start at boot"
# Launcher: start Ollama if needed, then keep the worker running. Full paths, so it works as SYSTEM.
$Launcher = "$Root\run-worker.ps1"
@"
`$env:OLLAMA_MODELS = '$ModelsDir'
`$env:OLLAMA_KEEP_ALIVE = '24h'
`$env:PUPPETEER_CACHE_DIR = '$ChromeDir'
`$env:Path = '$NodeDir;' + `$env:Path
function Ollama-Up { try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; `$true } catch { `$false } }
Set-Location '$AppDir\apps\worker'
while (`$true) {
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

Step "Keep the laptop awake on power"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0  # lid closed on power: do nothing
powercfg /setactive SCHEME_CURRENT
Ok "Sleep off while plugged in, lid close ignored"

Step "Checking it started"
Start-Sleep 20
if (Test-Path "$DataDir\worker.log") { Get-Content "$DataDir\worker.log" -Tail 5 }
Write-Host ""
Write-Host "Done. Look for '[worker] starting · ollama up' above (it can take a minute)." -ForegroundColor Green
Write-Host "Then open https://spot-solutions.web.app -> Settings -> Show QR code."
Write-Host "Logs anytime: double-click 'View Logs.cmd'."

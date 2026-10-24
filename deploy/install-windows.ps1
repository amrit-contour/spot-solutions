<#
  Spot Solutions worker: native install for Windows 10/11.

  Installs Node.js 22, Git and Ollama (via winget), pulls Gemma, clones the repo,
  and registers a Scheduled Task that starts the worker at boot (before anyone logs in)
  and restarts it if it crashes. Also stops the laptop from sleeping while plugged in.

  Run in an elevated PowerShell (Run as administrator):

    Set-ExecutionPolicy -Scope Process Bypass -Force
    irm https://raw.githubusercontent.com/amrit-dash/spot-solutions/main/deploy/install-windows.ps1 | iex

  Re-running is safe: it updates the code and restarts the task.
#>
$ErrorActionPreference = "Stop"

$Repo      = "https://github.com/amrit-dash/spot-solutions.git"
$AppDir    = "C:\SpotSolutions\app"
$DataDir   = "C:\SpotSolutions\data"
$TaskName  = "SpotSolutionsWorker"
$Model     = if ($env:GEMMA_MODEL) { $env:GEMMA_MODEL } else { "gemma3:4b" }

function Step($msg) { Write-Host "`n> $msg" -ForegroundColor Yellow }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this in PowerShell as Administrator." }
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "winget not found. Install 'App Installer' from the Microsoft Store, then re-run." }

function Ensure($id, $cmd) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
  }
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

Step "Node.js 22, Git, Ollama"
Ensure "OpenJS.NodeJS.LTS" "node"
Ensure "Git.Git" "git"
Ensure "Ollama.Ollama" "ollama"
Refresh-Path
$nodeMajor = [int]((node -v).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) { throw "Node $nodeMajor found; Spot Solutions needs Node 22+. Update Node and re-run." }
corepack enable

Step "Gemma ($Model)"
# The Ollama installer starts its tray app; make sure the server is up before pulling.
if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) { Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden; Start-Sleep 5 }
ollama pull $Model
[Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE", "24h", "Machine")

Step "Code"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# Chrome for WhatsApp Web must live somewhere SYSTEM (the task's account) can find it, not in your user profile.
$env:PUPPETEER_CACHE_DIR = "C:\SpotSolutions\chrome"
[Environment]::SetEnvironmentVariable("PUPPETEER_CACHE_DIR", $env:PUPPETEER_CACHE_DIR, "Machine")
if (Test-Path "$AppDir\.git") { git -C $AppDir pull --ff-only } else { git clone --depth 1 $Repo $AppDir }
Push-Location $AppDir
corepack pnpm install --frozen-lockfile --filter "@spot/worker..."
Pop-Location

Step "Configuration"
$EnvFile = "$AppDir\apps\worker\.env"
if (-not (Test-Path $EnvFile)) {
  $project = Read-Host "Firebase project ID"
  $saSrc   = Read-Host "Full path to your service-account JSON (e.g. C:\Users\you\Downloads\service-account.json)"
  Copy-Item $saSrc "$DataDir\service-account.json" -Force
  $gemini  = Read-Host "Gemini API key for fallback (optional, Enter to skip)"
  @"
FIREBASE_SERVICE_ACCOUNT=$DataDir\service-account.json
FIREBASE_PROJECT_ID=$project
OLLAMA_URL=http://127.0.0.1:11434
GEMINI_API_KEY=$gemini
WWEBJS_DATA=$DataDir\wwebjs
CHROME_PATH=
"@ | Set-Content -Encoding ASCII $EnvFile
  # Only SYSTEM and Administrators can read the secrets.
  foreach ($f in @($EnvFile, "$DataDir\service-account.json")) {
    icacls $f /inheritance:r /grant:r "SYSTEM:(R)" "Administrators:(F)" | Out-Null
  }
}

Step "Start at boot (Scheduled Task)"
# A small launcher so the task runs Ollama and the worker together, restarting the worker if it exits.
$Launcher = "C:\SpotSolutions\run-worker.ps1"
@"
`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine')
`$env:OLLAMA_KEEP_ALIVE = '24h'
`$env:PUPPETEER_CACHE_DIR = 'C:\SpotSolutions\chrome'
if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) { Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden; Start-Sleep 5 }
Set-Location '$AppDir\apps\worker'
while (`$true) {
  corepack pnpm start *>> '$DataDir\worker.log'
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
Start-ScheduledTask -TaskName $TaskName

Step "Keep the laptop awake on power"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
# Lid closed on AC power: do nothing.
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT

Step "Done"
Write-Host "Logs:    Get-Content $DataDir\worker.log -Wait -Tail 50"
Write-Host "Status:  Get-ScheduledTask $TaskName | Get-ScheduledTaskInfo"
Write-Host "Restart: Stop-ScheduledTask $TaskName; Start-ScheduledTask $TaskName"
Write-Host "Then open https://spot-solutions.web.app -> Settings -> Show QR code."

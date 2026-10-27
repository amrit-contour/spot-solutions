<#
  Nothing BOT Server: uninstall on Windows. Removes the new server AND the old "Spot Solutions" server
  (C:\NothingBotServer and C:\SpotSolutions): startup tasks, firewall rules, shortcuts and program files.

  KEEPS the data folders (WhatsApp login, keys, settings, backups) and the Ollama models unless you pass -DeleteData.
  A data folder you moved to another drive is never deleted, even with -DeleteData.

  Easiest: double-click "Uninstall.cmd". Or, in PowerShell as Administrator:
    .\uninstall.ps1                 (keeps the data)
    .\uninstall.ps1 -DeleteData     (deletes the data folders on C: too)
#>
param([switch]$DeleteData)
$ErrorActionPreference = "Continue"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this as Administrator (double-click Uninstall.cmd)." }

function Step($msg) { Write-Host "`n> $msg" -ForegroundColor Yellow }
function Ok($msg) { Write-Host "  $msg" -ForegroundColor Green }

$Roots = @("C:\NothingBotServer", "C:\SpotSolutions")

Step "Stopping the server"
foreach ($t in "NothingBotServerWorker", "NothingBotServerConsole", "NothingBotServerUpdate", "SpotSolutionsWorker", "SpotSolutionsConsole", "SpotSolutionsUpdate") {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    Ok "Removed task $t"
  }
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*NothingBotServer*' -or $_.CommandLine -like '*C:\SpotSolutions*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like 'C:\NothingBotServer\chrome\*' -or $_.ExecutablePath -like 'C:\SpotSolutions\chrome\*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2

Step "Firewall rules and shortcuts"
foreach ($r in "Nothing BOT Server Console", "Spot Solutions Console") { Remove-NetFirewallRule -DisplayName $r -ErrorAction SilentlyContinue }
$desktop = [Environment]::GetFolderPath("CommonDesktopDirectory")
foreach ($l in "Nothing BOT Server Console.lnk", "Spot Server Console.lnk", "Spot Solutions.lnk", "Nothing BOT Curating.lnk") { Remove-Item -Force -ErrorAction SilentlyContinue "$desktop\$l" }
foreach ($f in "Nothing BOT Server", "Spot Solutions") { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\$f" }
Ok "Done"

# Where the data and models live: the default folders, plus anything moved to another drive.
$dataDirs = @()
$modelDirs = @()
foreach ($r in $Roots) {
  $dataDirs += "$r\data"
  $modelDirs += "$r\ollama"
  if (Test-Path "$r\data-dir.txt") { $p = (Get-Content "$r\data-dir.txt" -Raw).Trim(); if ($p) { $dataDirs += $p } }
  if (Test-Path "$r\models-dir.txt") { $p = (Get-Content "$r\models-dir.txt" -Raw).Trim(); if ($p) { $modelDirs += $p } }
}
$dataDirs = $dataDirs | Where-Object { Test-Path $_ } | Select-Object -Unique
$modelDirs = $modelDirs | Where-Object { Test-Path $_ } | Select-Object -Unique

Step "Removing the program files"
foreach ($r in $Roots) {
  if (-not (Test-Path $r)) { continue }
  foreach ($sub in "app", "node", "chrome", "ollama-app") { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$r\$sub" }
  foreach ($f in "run-worker.ps1", "run-console.ps1", "update.ps1", "update-core.run.ps1", "spot.ico", "nbs.ico", "nbs-server.ico", "nbc-curating.ico") { Remove-Item -Force -ErrorAction SilentlyContinue "$r\$f" }
  Ok "Removed the program files in $r"
}

if ($DeleteData) {
  Step "Deleting data (-DeleteData)"
  foreach ($d in ($dataDirs + $modelDirs)) {
    $isOurs = $false
    foreach ($r in $Roots) { if ($d -like "$r\*") { $isOurs = $true } }
    if ($isOurs) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $d; Ok "Deleted $d" }
    else { Write-Host "  NOT deleted (another drive, delete it yourself if you want it gone): $d" -ForegroundColor Yellow }
  }
  foreach ($r in $Roots) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $r }
} else {
  Step "Kept"
  foreach ($d in $dataDirs) { Write-Host "  Data kept (WhatsApp login, keys, settings): $d" }
  foreach ($d in $modelDirs) { Write-Host "  AI models kept: $d" }
  Write-Host "  To delete the data as well, run uninstall.ps1 -DeleteData"
}

Step "Done"
Write-Host "Install again any time:  irm https://nothingbotcurating.web.app/install.ps1 | iex"

@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" & exit /b)
echo This stops Spot Solutions and removes the startup task.
echo Your WhatsApp session and settings in C:\SpotSolutions\data are kept.
pause
powershell -NoProfile -Command "Unregister-ScheduledTask SpotSolutionsWorker -Confirm:$false -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*SpotSolutions*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host Removed."
pause

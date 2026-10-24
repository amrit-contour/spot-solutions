@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" & exit /b)
powershell -NoProfile -Command "Stop-ScheduledTask SpotSolutionsWorker -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*SpotSolutions*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-ScheduledTask SpotSolutionsWorker; Write-Host Restarted."
pause

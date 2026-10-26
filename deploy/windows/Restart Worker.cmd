@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" & exit /b)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*SpotSolutions*src*index.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.ExecutablePath -like 'C:\SpotSolutions\chrome\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host 'Worker stopped. It starts again within 10 seconds.'"
pause

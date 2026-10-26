@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" & exit /b)
echo This stops Spot Solutions and removes its startup tasks and shortcuts.
echo Your WhatsApp session and settings in C:\SpotSolutions\data are kept.
pause
powershell -NoProfile -Command "Unregister-ScheduledTask SpotSolutionsWorker -Confirm:$false -ErrorAction SilentlyContinue; Unregister-ScheduledTask SpotSolutionsConsole -Confirm:$false -ErrorAction SilentlyContinue; Remove-NetFirewallRule -DisplayName 'Spot Solutions Console' -ErrorAction SilentlyContinue; Remove-Item -Force -ErrorAction SilentlyContinue \"$([Environment]::GetFolderPath('CommonDesktopDirectory'))\Spot*.lnk\"; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue \"$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Spot Solutions\"; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*SpotSolutions*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.ExecutablePath -like 'C:\SpotSolutions\chrome\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host Removed."
pause

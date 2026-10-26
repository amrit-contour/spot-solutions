@echo off
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" & exit /b)
echo This stops Nothing BOT Server and removes its startup tasks, shortcuts and program files.
echo It also removes the old Spot Solutions server if it is still on this PC.
echo Your WhatsApp login, keys and settings (C:\NothingBotServer\data, and C:\SpotSolutions\data from the old server) are KEPT.
echo To delete them as well, run uninstall.ps1 with -DeleteData in PowerShell instead.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
pause

@echo off
rem Nothing BOT Server, Gemini-only: skips Ollama and the Gemma download. AI goes to Gemini (add a key later).
rem Can't host accounts set to "Local only". Double-click; asks for admin rights.
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'" & exit /b)
set NBS_NO_LOCAL_MODEL=1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause

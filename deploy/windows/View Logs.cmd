@echo off
rem Live worker log. Closing this window doesn't stop the worker.
powershell -NoProfile -Command "Get-Content C:\SpotSolutions\data\worker.log -Wait -Tail 60"

@echo off
REM ASCII-only wrapper. Real logic lives in checkup.ps1 (UTF-8 with BOM).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\checkup.ps1"
if errorlevel 1 pause
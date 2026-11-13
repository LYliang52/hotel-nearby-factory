@echo off
REM ASCII-only wrapper. Real logic lives in edit-config.ps1 (UTF-8 with BOM).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\edit-config.ps1"
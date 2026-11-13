@echo off
REM ASCII-only wrapper. Real logic lives in launcher.ps1 (UTF-8 with BOM),
REM because cmd.exe mis-parses UTF-8 batch files containing Chinese text.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\launcher.ps1"
if errorlevel 1 (
  echo.
  echo   Launcher failed. See the message above.
  pause
)

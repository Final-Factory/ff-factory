@echo off
rem Double-click to restart FF Factory (drains busy agents, resumes them afterwards, never leaves it
rem elevated). Add -Update to pull and rebuild first. Run as administrator only to stop an app that
rem was started elevated. See docs\restart.md.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart.ps1" %*
set rc=%errorlevel%
echo.
if "%FFSB_NOPAUSE%"=="" pause
exit /b %rc%

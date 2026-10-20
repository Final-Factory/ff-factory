@echo off
rem FF Factory: adds this PC to the portal at __FF_PORTAL_URL__ (w1592, docs/worker-install.md "Adding a machine with a join code").
rem Double-click it on the new PC while it is connected to Tailscale. It runs the portal's join bootstrap (join.ps1) in
rem PowerShell, as you, not as administrator: Windows asks for administrator rights itself where a step needs them.
setlocal
title FF Factory: adding this PC
set "FF_JOIN_CODE=__FF_JOIN_CODE__"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm '__FF_PORTAL_URL__/join/windows.ps1' | iex"
if errorlevel 1 (
  echo.
  echo It stopped before the end: read the lines above. Is this PC connected to Tailscale, and does __FF_PORTAL_URL__ open in its browser?
)
set "FF_JOIN_CODE="
echo.
pause

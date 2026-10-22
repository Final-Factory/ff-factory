@echo off
rem FF Factory: adds this PC to the portal at __FF_PORTAL_URL__ (w1592, docs/worker-install.md "Adding a machine with a join code").
rem Double-click it on the new PC while it is connected to Tailscale, or run it from a Command Prompt or PowerShell,
rem administrator or not. It downloads the portal's join bootstrap (join.ps1) to a file and runs that file in PowerShell.
rem Never a PowerShell command line that downloads and runs a script (irm piped into iex): Microsoft Defender blocks that
rem PowerShell, and cmd then prints only "Access is denied." (desktop-coosego, w1603).
setlocal EnableExtensions
title FF Factory: adding this PC
set "FF_JOIN_CODE=__FF_JOIN_CODE__"
set "FF_JOIN_DIR=%LOCALAPPDATA%\FFFactory\join"
set "FF_JOIN_LOG=%LOCALAPPDATA%\FFFactory\join\join.log"
set "FF_JOIN_PS1=%LOCALAPPDATA%\FFFactory\join\join.ps1"
rem join.ps1 writes "started" into this file first thing: still "waiting" afterwards means PowerShell never ran it.
set "FF_JOIN_STARTED=%LOCALAPPDATA%\FFFactory\join\started.txt"
echo FF Factory: adding this PC to __FF_PORTAL_URL__.
echo This run's log (no secrets in it): %FF_JOIN_LOG%
if not exist "%FF_JOIN_DIR%\" mkdir "%FF_JOIN_DIR%"
if not exist "%FF_JOIN_DIR%\" (
  echo.
  echo FAILED at step 1 of 2, making the folder %FF_JOIN_DIR%: Windows refused it, for the reason on the line above.
  goto done
)
>>"%FF_JOIN_LOG%" echo.
>>"%FF_JOIN_LOG%" echo %DATE% %TIME% ff-factory-join.cmd as %USERNAME% in %CD%

echo.
echo == Step 1 of 2: downloading the join script (__FF_PORTAL_URL__/join/windows.ps1)
rem Windows' own curl, never the first on PATH: Git for Windows' curl 8.14 exits 0 when --retry gives up (w1758, measured),
rem and an older join.ps1 left here would then run as if downloaded. That one is removed first.
set "FF_CURL=%SystemRoot%\System32\curl.exe"
if not exist "%FF_CURL%" (
  echo FAILED at step 1 of 2: this Windows has no curl.exe ^(Windows 10 before version 1803^). Update Windows, or use the PowerShell line on the dashboard's Add a machine.
  >>"%FF_JOIN_LOG%" echo step 1 FAILED: no curl.exe
  goto done
)
if exist "%FF_JOIN_PS1%" del /f /q "%FF_JOIN_PS1%"
"%FF_CURL%" -fsS --connect-timeout 20 --retry 2 -o "%FF_JOIN_PS1%" "__FF_PORTAL_URL__/join/windows.ps1"
set "FF_RC=%ERRORLEVEL%"
if "%FF_RC%"=="0" if not exist "%FF_JOIN_PS1%" set "FF_RC=0, but no file"
if not "%FF_RC%"=="0" (
  >>"%FF_JOIN_LOG%" echo step 1 FAILED: curl exit %FF_RC%
  echo.
  if "%FF_RC%"=="22" (
    echo FAILED at step 1 of 2: the portal answered, but with an error instead of the join script ^(the line above^).
  ) else (
    echo FAILED at step 1 of 2: this PC could not reach the portal ^(curl exit %FF_RC%, the line above^).
    echo Is this PC connected to Tailscale, and does __FF_PORTAL_URL__ open in its browser?
  )
  goto done
)
>>"%FF_JOIN_LOG%" echo step 1: downloaded %FF_JOIN_PS1%

echo.
echo == Step 2 of 2: running it in Windows PowerShell
>"%FF_JOIN_STARTED%" echo waiting
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%FF_JOIN_PS1%"
set "FF_RC=%ERRORLEVEL%"
>>"%FF_JOIN_LOG%" echo step 2: join.ps1 exit %FF_RC%
findstr /c:"started" "%FF_JOIN_STARTED%" >nul 2>&1
if errorlevel 1 (
  >>"%FF_JOIN_LOG%" echo step 2 FAILED: PowerShell did not start join.ps1
  echo.
  echo FAILED at step 2 of 2: Windows did not let PowerShell run the join script ^(exit %FF_RC%^).
  echo "Access is denied." here means Microsoft Defender, another antivirus, Smart App Control or a policy blocked it:
  echo Windows Security, Virus and threat protection, Protection history shows what was blocked and why.
  goto done
)
if "%FF_RC%"=="0" goto done
echo.
if "%FF_RC%"=="3" (
  echo It could not reach the portal: is this PC connected to Tailscale, and does __FF_PORTAL_URL__ open in its browser?
) else (
  echo It stopped at the step named above ^(exit %FF_RC%^).
)

:done
set "FF_JOIN_CODE="
echo.
echo The whole run is in %FF_JOIN_LOG%
pause

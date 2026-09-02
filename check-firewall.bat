@echo off
REM check-firewall.bat
REM Called from start.bat / start-node.bat. Checks whether this machine may be reached by the other
REM agents, and offers to fix it once if not.
REM
REM Deliberately NOT applied automatically: adding firewall rules needs Administrator rights, and
REM changing a machine's firewall as a side effect of "start the app" is not something software
REM should do to someone unasked. Asking once costs a keystroke and keeps the decision with the
REM person whose machine it is.
REM
REM Skipped silently when the rules already exist, so this is invisible after the first run.

netsh advfirewall firewall show rule name="AliveAgents (TCP)" >nul 2>&1
if not errorlevel 1 goto :eof

echo.
echo   ------------------------------------------------------------------
echo    Windows blocks incoming connections on networks it considers
echo    public. Without a firewall rule the other agents cannot reach this
echo    machine -- presentations stay blank and hub discovery goes unheard.
echo.
echo    Needed: TCP 8787/8788/8789 and UDP 8790, from the local network
echo    only, and only for this project's own node.exe.
echo   ------------------------------------------------------------------
echo.
echo    Only the rule-adding step is elevated, in its own window. The agent
echo    itself keeps running as your normal user account.
echo.
set /p ADDRULES="   Add these rules now? (y/n) "

if /i not "%ADDRULES%"=="y" (
  echo.
  echo   Skipped. Run allow-firewall.bat as administrator whenever you want to.
  echo.
  goto :eof
)

echo.
echo   Asking Windows for admin rights...
REM Start-Process -Verb RunAs elevates ONLY this new process. The cmd running start.bat is
REM untouched and stays at normal user rights -- the agent must never run elevated just because
REM its firewall rules once needed adding.
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0allow-firewall.bat' -Verb RunAs" 2>nul
if errorlevel 1 (
  echo   Could not elevate. Right-click allow-firewall.bat and choose "Run as administrator".
) else (
  echo   A separate window has opened -- confirm there, close it, then press a key here.
)
echo.
pause

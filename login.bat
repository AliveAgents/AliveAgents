@echo off
REM login.bat
REM Wires up Node/npm/claude for this window and starts the Claude Code CLI's login step.

set "ROOT=%~dp0"
set "PATH=%ROOT%tools\node;%PATH%"
cd /d "%ROOT%"

claude setup-token

echo.
echo ================================================================
echo  Scroll UP in this window -- the token is printed there.
echo  Copy it into token.local.bat (see token.local.bat.example).
echo  This window stays open until you press a key.
echo ================================================================
pause

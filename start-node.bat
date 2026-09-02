@echo off
REM start-node.bat
REM Starts the agent node on the SECOND laptop (not on Oscar's machine).
REM Connects to the hub over an encrypted channel and waits for tasks.

set "ROOT=%~dp0"
set "PATH=%ROOT%tools\node;%PATH%"
cd /d "%ROOT%"
if exist "%ROOT%token.local.bat" call "%ROOT%token.local.bat"

REM Offers to open the firewall the first time, then never says anything again.
if exist "%ROOT%check-firewall.bat" call "%ROOT%check-firewall.bat"

node node-agent.js
pause

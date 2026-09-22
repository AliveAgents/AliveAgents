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

REM Exit code 75: the agent installed an update of itself and wants to be started again (updater.js).
set "ALIVEAGENTS_RESTARTABLE=1"
:run
node node-agent.js
if "%ERRORLEVEL%"=="75" goto run
pause

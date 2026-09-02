@echo off
REM start.bat
REM Starts the Lebende Agenten bridge server with the portable Node from tools\node.
REM Only wires up Node for this cmd window -- no system-wide change.

set "ROOT=%~dp0"
set "PATH=%ROOT%tools\node;%PATH%"
cd /d "%ROOT%"
if exist "%ROOT%token.local.bat" call "%ROOT%token.local.bat"

REM Offers to open the firewall the first time, then never says anything again.
if exist "%ROOT%check-firewall.bat" call "%ROOT%check-firewall.bat"

node agent-bridge-server.js

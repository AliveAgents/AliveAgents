@echo off
REM env.bat
REM Wires up the portable Node/npm/claude from tools\node into PATH for this cmd window only,
REM without changing the system-wide PATH variable.
REM
REM Usage: just run it in the project folder:  env.bat

set "ROOT=%~dp0"
set "PATH=%ROOT%tools\node;%PATH%"
cd /d "%ROOT%"
if exist "%ROOT%token.local.bat" call "%ROOT%token.local.bat"

echo Node/npm/claude are available for this window (portable, from tools\node).

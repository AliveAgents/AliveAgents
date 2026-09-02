@echo off
REM enroll.bat
REM Joins this machine to an existing agent network using a one-time pairing code from the hub.
REM   enroll.bat <hub-ip> <code> <name>
REM   e.g.  enroll.bat 192.168.178.90 K7QF-2M9X-BTLR ada
REM
REM Generates this machine's own key pair locally -- the private key is written here and never
REM leaves. Only the certificate travels, and only over a channel the code authenticates.

set "ROOT=%~dp0"
set "PATH=%ROOT%tools\node;%PATH%"
cd /d "%ROOT%"

node enroll.js %*
pause

@echo off
REM allow-firewall.bat
REM Run ONCE per machine, as Administrator. Opens exactly the ports this project needs, for
REM exactly this project's bundled node.exe, and only towards the local network.
REM
REM Why this is needed at all: Windows classifies an unknown WiFi as "Public" and then blocks
REM incoming connections. Move both machines to a new network -- a different flat, a hotspot -- and
REM the agents can suddenly no longer reach each other, with no error message anywhere. Rules tied
REM to the program survive that, because they apply on both the Private and Public profile.
REM
REM Deliberately narrow:
REM   * bound to THIS folder's node.exe, not to node in general
REM   * only the four ports actually used
REM   * RemoteAddress=LocalSubnet, so nothing is reachable from beyond the local network
REM
REM What needs which:
REM   8788/tcp  hub only  -- nodes dial in here (a node itself needs nothing inbound for this)
REM   8789/tcp  hub only  -- the short-lived enrollment window for a new agent
REM   8787/tcp  every machine -- other machines fetch presentations and the deck runtime from it
REM   8790/udp  every machine -- hub discovery beacons and probes

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   This has to run as Administrator -- firewall rules cannot be added otherwise.
  echo   Right-click allow-firewall.bat and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

set "NODE=%~dp0tools\node\node.exe"
if not exist "%NODE%" (
  echo.
  echo   Not found: %NODE%
  echo   Run this from the project folder that contains tools\node\node.exe
  echo.
  pause
  exit /b 1
)

echo.
echo   Allowing: %NODE%
echo.

REM Removed first so re-running simply refreshes the rules instead of piling up duplicates.
netsh advfirewall firewall delete rule name="AliveAgents (TCP)" >nul 2>&1
netsh advfirewall firewall delete rule name="AliveAgents (UDP discovery)" >nul 2>&1

netsh advfirewall firewall add rule name="AliveAgents (TCP)" dir=in action=allow ^
  program="%NODE%" protocol=TCP localport=8787,8788,8789 ^
  remoteip=LocalSubnet profile=private,public enable=yes >nul
if errorlevel 1 (echo   FAILED to add the TCP rule) else (echo   TCP  8787, 8788, 8789  allowed from the local network)

netsh advfirewall firewall add rule name="AliveAgents (UDP discovery)" dir=in action=allow ^
  program="%NODE%" protocol=UDP localport=8790 ^
  remoteip=LocalSubnet profile=private,public enable=yes >nul
if errorlevel 1 (echo   FAILED to add the UDP rule) else (echo   UDP  8790              allowed from the local network)

echo.
echo   Done. This machine can now be reached by the others on any network it joins.
echo.
pause

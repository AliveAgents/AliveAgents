# start.ps1
# Starts the Lebende Agenten bridge server with the portable Node from tools\node.
# Only wires up Node into PATH for this PowerShell session -- no system-wide change.
#
# Usage: right-click -> "Run with PowerShell" or in the terminal: .\start.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeDir = Join-Path $root "tools\node"
$env:PATH = "$nodeDir;$env:PATH"

Set-Location $root
node agent-bridge-server.js

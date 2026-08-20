# env.ps1
# Wires up the portable Node/npm/claude from tools\node into PATH for this session only,
# without changing the system-wide PATH variable. Afterward, node, npm, and claude
# are normally available in this terminal window.
#
# Usage: . .\env.ps1   (with a leading dot, so it takes effect in the current session)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeDir = Join-Path $root "tools\node"
$env:PATH = "$nodeDir;$env:PATH"
Set-Location $root

Write-Host "Node/npm/claude are available for this session (portable, from tools\node)." -ForegroundColor Green

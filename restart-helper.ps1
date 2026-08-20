# restart-helper.ps1 -- disposable helper script only for remotely (re-)starting node-agent.js
# over SSH, gets deleted again afterward. Avoids the nested-quoting chaos of
# "ssh ... 'powershell -Command \"cmd /c \"\"...\"\"\"'" by using a real file instead of a
# command line nested inside itself multiple times.
$root = "E:\Hobbies\LebendeAgenten"
Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

$env:PATH = "$root\tools\node;$env:PATH"
$tokenBat = Join-Path $root "token.local.bat"
if (Test-Path $tokenBat) {
  $content = Get-Content $tokenBat -Raw
  if ($content -match 'set\s+"CLAUDE_CODE_OAUTH_TOKEN=([^"\r\n]+)"') {
    $env:CLAUDE_CODE_OAUTH_TOKEN = $matches[1]
  }
}

$logFile = Join-Path $root "restart-log.txt"
if (Test-Path $logFile) { Remove-Item $logFile -Force }

Start-Process -FilePath "$root\tools\node\node.exe" -ArgumentList "node-agent.js" `
  -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"

Start-Sleep -Seconds 4
Write-Output "--- node process ---"
Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id, StartTime
Write-Output "--- stdout ---"
if (Test-Path $logFile) { Get-Content $logFile }
Write-Output "--- stderr ---"
if (Test-Path "$logFile.err") { Get-Content "$logFile.err" }

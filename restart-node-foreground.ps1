# restart-node-foreground.ps1 -- like restart-helper.ps1, but WITHOUT Start-Process/detach: starts
# node-agent.js in the FOREGROUND of this powershell.exe process. Windows OpenSSH ties the
# lifetime of every child process started over SSH to the SSH session's own job object -- a child
# process DETACHED via Start-Process still dies the moment the SSH session ends (documented,
# already-investigated behavior, see [[project-lebende-agenten]]). A foreground process, in
# contrast, keeps running for exactly as long as the calling SSH connection stays open -- not a
# durable fix, but enough for immediate testing while the SSH connection is held open (as a
# background task on the calling side). For a TRULY durable restart (survives the session ending),
# it's still: run start-node.bat by hand on this machine.
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

Set-Location $root
& "$root\tools\node\node.exe" node-agent.js

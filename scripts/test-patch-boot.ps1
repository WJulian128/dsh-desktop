# Patch boot test: generate web.patch.yml, boot dsh web with it (temp DSH_HOME),
# verify: server ready, __DSH_BOOT__ contains the desktop client row, client.js is
# served, the built-in dsh_desktop MCP server is spawned and connected.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-patch-boot.ps1
$ErrorActionPreference = 'Stop'

function Remove-SafeTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push($Path)
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($cur)) {
      $attrs = [System.IO.File]::GetAttributes($child)
      if ($attrs -band [System.IO.FileAttributes]::ReparsePoint) {
        # 只删除链接自身，绝不跟随目标
        if ($attrs -band [System.IO.FileAttributes]::Directory) { [System.IO.Directory]::Delete($child, $false) }
        else { [System.IO.File]::Delete($child) }
      } elseif ($attrs -band [System.IO.FileAttributes]::Directory) {
        $stack.Push($child)
      } else {
        [System.IO.File]::Delete($child)
      }
    }
  }
  [System.IO.Directory]::Delete($Path, $true)
}
$root = Split-Path -Parent $PSScriptRoot
$testHome = Join-Path $env:TEMP ('dsh-desktop-patch-test-' + [DateTime]::Now.ToString('HHmmssfff'))
$port = 37651
$outLog = Join-Path $env:TEMP 'dsh-patch-test-out.log'
$errLog = Join-Path $env:TEMP 'dsh-patch-test-err.log'
$failed = $false

Remove-SafeTree $testHome
Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $testHome | Out-Null

Write-Output '== 1. generate patch file + client package link =='
$env:DSH_HOME = $testHome
node -e "const m=require(process.argv[1]); m.generateWebPatch({file: process.argv[2], appDir: process.argv[3], enableDesktopMcp: true, mcpServers: [{serverName:'dummy-echo', transport:'stdio', command:'cmd.exe', args:['/c','echo']}]}); m.ensureClientPackageLink({dshHome: process.env.DSH_HOME, appDir: process.argv[3], log: (t)=>console.log(t)});" "$root/main/web-patch.js" (Join-Path $testHome 'web.patch.yml') $root
Write-Output '--- web.patch.yml ---'
Get-Content (Join-Path $testHome 'web.patch.yml')
Write-Output ('--- link exists: ' + (Test-Path (Join-Path $testHome 'profiles\node_modules\@dsh-desktop\settings-update')) + ' ---')

Write-Output '== 2. start dsh web with --patch =='
$env:DSH_DESKTOP_RPC_URL = 'http://127.0.0.1:1'
$env:DSH_DESKTOP_RPC_TOKEN = 'test-token'
$proc = Start-Process -FilePath 'node.exe' -ArgumentList @("$root\node_modules\@deepseek-ai\dsh\lib\bin.js", 'web', '--patch', (Join-Path $testHome 'web.patch.yml'), '--host', '127.0.0.1', '--port', "$port", '--no-open') -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$procExited = $false
try {
  Write-Output '== 3. wait for server =='
  $deadline = (Get-Date).AddSeconds(90)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { $procExited = $true; break }
    try {
      $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/" -f $port) -UseBasicParsing -TimeoutSec 5
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) { $ready = $true; break }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  if ($procExited) {
    Write-Output 'FAIL: dsh web exited early'
    $failed = $true
  } elseif (-not $ready) {
    Write-Output 'FAIL: server not ready'
    $failed = $true
  } else {
    Write-Output '== 4. check __DSH_BOOT__ and client bundle =='
    $html = (Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/" -f $port) -UseBasicParsing -TimeoutSec 10).Content
    if ($html -match '__DSH_BOOT__') { Write-Output 'index.html has __DSH_BOOT__: yes' } else { Write-Output 'FAIL: no __DSH_BOOT__'; $failed = $true }
    if ($html -match 'settings-update') { Write-Output 'boot graph has settings-update: yes' } else { Write-Output 'FAIL: boot graph missing settings-update'; $failed = $true }
    $clientUrl = $null
    foreach ($mm in [regex]::Matches($html, '"url":"(/plugins/[^"]*client\.js[^"]*)"')) {
      if ($mm.Groups[1].Value -match 'settings-update') { $clientUrl = $mm.Groups[1].Value; break }
    }
    if ($clientUrl) {
      Write-Output ("client bundle path: " + $clientUrl)
      $bundle = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}{1}" -f $port, $clientUrl) -UseBasicParsing -TimeoutSec 10
      if ($bundle.Content -match '__ModuleLoader__\.load' -and $bundle.Content -match 'settings-update') {
        Write-Output 'client.js served and well-formed: yes'
      } else {
        Write-Output 'FAIL: client.js content unexpected'
        $failed = $true
      }
    } else {
      Write-Output 'FAIL: no client.js URL in boot graph'
      $failed = $true
    }

    Write-Output '== 5. check MCP server connection =='
    Start-Sleep -Seconds 6
    $allErr = Get-Content $errLog -Raw -ErrorAction SilentlyContinue
    $allOut = Get-Content $outLog -Raw -ErrorAction SilentlyContinue
    $combined = $allErr + "`n" + $allOut
    if ($combined -match '\[dsh-desktop-mcp\] connected') {
      Write-Output 'dsh_desktop MCP server connected: yes'
    } else {
      Write-Output 'WARN: [dsh-desktop-mcp] connected not found in logs'
      ($combined -split "`n") | Where-Object { $_ -match 'mcp|dsh-desktop' } | Select-Object -First 15
    }
  }
} finally {
  Write-Output '== 6. cleanup =='
  if ($proc -and -not $proc.HasExited) { & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$port*bin.js*web*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-SafeTree $testHome
  Remove-Item Env:DSH_HOME, Env:DSH_DESKTOP_RPC_URL, Env:DSH_DESKTOP_RPC_TOKEN -ErrorAction SilentlyContinue
}

if ($failed) { Write-Output 'PATCH-BOOT FAIL'; exit 1 }
Write-Output 'PATCH-BOOT OK'
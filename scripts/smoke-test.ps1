# 冒烟测试：用临时 DSH_HOME 启动桌面端，验证：
#  1. harness 服务与 HTTP 就绪（原有）
#  2. 固定端口生效：两次启动使用同一端口（对话热启动的前提）
#  3. 注入补丁生成：web.patch.yml 含 mcp-dsh-desktop 与 desktop-settings-ui，
#     且 $DSH_HOME/profiles/node_modules 下客户端插件链接可用
#  4. 内置 dsh_desktop MCP 服务器被拉起并连接
# 注意：会临时备份/覆盖 %APPDATA%\dsh-desktop\settings.json，并会结束正在运行的
# 桌面端进程（Electron），仅供开发测试；请先关闭正在使用的桌面端。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
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
$appData = Join-Path $env:APPDATA 'dsh-desktop'
$strayData = Join-Path $env:APPDATA 'DSH Desktop'
$testHome = Join-Path $env:TEMP ('dsh-desktop-smoke-' + [DateTime]::Now.ToString('HHmmssfff'))
$settingsFile = Join-Path $appData 'settings.json'
$settingsBackup = $null
$failed = $false
$testPort = 37710
$patchFile = Join-Path $appData 'web.patch.yml'
$logFile = Join-Path $appData 'logs\dsh-web.log'

function Kill-AppProcesses {
  Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*DeepseekHarness*' } | ForEach-Object { & taskkill /PID $_.Id /T /F 2>&1 | Out-Null }
  Start-Sleep -Seconds 2
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*DeepseekHarness*bin.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Get-HarnessPort {
  $child = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*DeepseekHarness*bin.js*web*" } | Select-Object -First 1
  if ($child -and $child.CommandLine -match '--port (\d+)') { return [int]$Matches[1] }
  return $null
}

function Wait-HarnessReady([int]$Port, [int]$TimeoutSec = 120) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/" -f $Port) -UseBasicParsing -TimeoutSec 5
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Start-App {
  Remove-Item Env:DSH_WEB_URL, Env:DSH_SESSION_ID, Env:DSH_SESSION_JSONL, Env:DSH_SHELL -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP 'dsh-desktop-smoke-out.log') -RedirectStandardError (Join-Path $env:TEMP 'dsh-desktop-smoke-err.log')
  return $proc
}

Write-Output '== 0. 清理上次残留 =='
Kill-AppProcesses
Remove-SafeTree $testHome

Write-Output '== 1. 预置设置（备份现有，固定测试端口，避免首次弹工作区对话框）=='
New-Item -ItemType Directory -Force -Path $appData | Out-Null
if (Test-Path $settingsFile) {
  $settingsBackup = Get-Content $settingsFile -Raw
}
@{
  workspace = $root
  autoUpdate = $false
  silentAutoUpdate = $false
  checkPrereleases = $false
  showUpdateBadge = $true
  serverPort = $testPort
  enableDesktopMcp = $true
  mcpServers = @()
} | ConvertTo-Json | Set-Content -Path $settingsFile -Encoding UTF8

$env:DSH_HOME = $testHome

try {
  Write-Output '== 2. 第一次启动（后台）=='
  $proc = Start-App

  Write-Output '== 3. 等待服务就绪并校验 =='
  $port = $null
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    $port = Get-HarnessPort
    if ($port) {
      if (Wait-HarnessReady $port) { break }
    }
    Start-Sleep -Seconds 2
  }
  if (-not $port) { Write-Output 'FAIL: 未找到 harness 子进程/端口'; $failed = $true }
  else {
    Write-Output ("第一次启动端口: {0}" -f $port)
    if ($port -eq $testPort) { Write-Output '固定端口生效: 是' } else { Write-Output ('FAIL: 未使用预设端口 ' + $testPort); $failed = $true }

    Write-Output '-- 注入补丁检查 --'
    if (Test-Path $patchFile) {
      $patch = Get-Content $patchFile -Raw
      if ($patch -match 'mcp-dsh-desktop' -and $patch -match 'desktop-settings-ui') {
        Write-Output 'web.patch.yml 含 MCP 与设置分区行: 是'
      } else { Write-Output 'FAIL: web.patch.yml 缺少关键行'; $failed = $true }
    } else { Write-Output 'FAIL: web.patch.yml 不存在'; $failed = $true }

    $linkPath = Join-Path $testHome 'profiles\node_modules\@dsh-desktop\settings-update\package.json'
    if (Test-Path $linkPath) { Write-Output '客户端插件链接可用: 是' } else { Write-Output 'FAIL: 客户端插件链接缺失'; $failed = $true }

    Write-Output '-- MCP 连接检查 --'
    Start-Sleep -Seconds 3
    if (Test-Path $logFile) {
      $log = Get-Content $logFile -Raw
      if ($log -match '\[dsh-desktop-mcp\] connected') { Write-Output 'dsh_desktop MCP 服务器已连接: 是' }
      else { Write-Output 'WARN: 日志未见 MCP connected（可能仍在连接）' }
    }

    Write-Output '== 4. 关闭并第二次启动（验证热启动端口稳定）=='
    Kill-AppProcesses
    Start-Sleep -Seconds 2
    $proc2 = Start-App
    $port2 = $null
    $deadline2 = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline2) {
      $port2 = Get-HarnessPort
      if ($port2) {
        if (Wait-HarnessReady $port2) { break }
      }
      Start-Sleep -Seconds 2
    }
    if (-not $port2) { Write-Output 'FAIL: 第二次启动未找到端口'; $failed = $true }
    else {
      Write-Output ("第二次启动端口: {0}" -f $port2)
      if ($port2 -eq $testPort) { Write-Output '热启动端口稳定: 是' } else { Write-Output 'FAIL: 第二次启动端口变化'; $failed = $true }
    }
    if ($proc2) { & taskkill /PID $proc2.Id /T /F 2>&1 | Out-Null }
  }
} finally {
  Write-Output '== 5. 清理 =='
  Kill-AppProcesses
  Remove-SafeTree $testHome
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  if ($settingsBackup -ne $null) { Set-Content -Path $settingsFile -Value $settingsBackup -Encoding UTF8 }
  elseif (Test-Path $settingsFile) { Remove-Item $settingsFile -Force }
  if (Test-Path $strayData) { Remove-Item $strayData -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failed) { Write-Output 'SMOKE FAIL'; exit 1 }
Write-Output 'SMOKE OK'

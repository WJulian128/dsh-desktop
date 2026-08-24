# Packaged-mode smoke test: boot the packaged dsh web using the packaged
# Electron binary with ELECTRON_RUN_AS_NODE (simulates a machine without
# system Node). Validates: exe-as-node -> real app paths -> dsh module graph
# -> HTTP server ready. No GUI, never touches the real DSH_HOME.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-packaged-boot.ps1
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot '..\release\win-unpacked\DSH Desktop.exe'
$appDir = Join-Path $PSScriptRoot '..\release\win-unpacked\resources\app'
if (-not (Test-Path $exe)) { throw "Packaged app not found: $exe (run npm run pack first)" }

$testHome = Join-Path $env:TEMP ("dsh-packaged-smoke-" + (Get-Random))
New-Item -ItemType Directory -Path $testHome | Out-Null
$port = 18377
$stdoutFile = Join-Path $testHome 'boot.stdout.log'
$stderrFile = Join-Path $testHome 'boot.stderr.log'
$proc = $null
$ok = $false
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:DSH_HOME = $testHome
  $proc = Start-Process -FilePath $exe `
    -ArgumentList '--expose-internals', 'node_modules\@deepseek-ai\dsh\lib\bin.js', 'web', '--host', '127.0.0.1', '--port', "$port", '--no-open' `
    -WorkingDirectory $appDir -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
  Write-Host ("started pid=" + $proc.Id + " DSH_HOME=" + $testHome)
  for ($i = 1; $i -le 120; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port) -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) {
        $ok = $true
        Write-Host ("HTTP 200 after " + ($i * 2) + "s, body bytes=" + $r.RawContentLength)
        break
      }
    } catch {
      if ($i % 10 -eq 0) { Write-Host ("poll " + $i + " no response yet") }
    }
    if ($proc.HasExited) { Write-Host ("process exited early, code=" + $proc.ExitCode); break }
  }
} finally {
  if ($proc -and -not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>&1 | Out-Null }
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
}
if (-not $ok) {
  Write-Host '--- boot.stderr.log ---'
  if (Test-Path $stderrFile) { Get-Content $stderrFile -Tail 30 }
  Write-Host '--- boot.stdout.log ---'
  if (Test-Path $stdoutFile) { Get-Content $stdoutFile -Tail 30 }
  Write-Host '--- DSH_HOME layout ---'
  Get-ChildItem $testHome -Recurse -ErrorAction SilentlyContinue | Select-Object -First 15 -ExpandProperty FullName
  exit 1
}
Remove-Item $testHome -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'PACKAGED-BOOT OK'

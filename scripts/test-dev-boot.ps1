# Dev-mode harness boot verification: spawn dsh web with the EXACT arguments the
# desktop bat version uses (--expose-internals + real patch + real DSH_HOME),
# verify HTTP 200, then clean up. ASCII only.
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\user\Desktop\DeepseekHarness'
$patch = 'C:\Users\user\AppData\Roaming\dsh-desktop\web.patch.yml'
$out = Join-Path $env:TEMP 'devboot.out.log'
$err = Join-Path $env:TEMP 'devboot.err.log'
$env:DSH_DESKTOP_RPC_URL = 'http://127.0.0.1:19999'
$env:DSH_DESKTOP_RPC_TOKEN = 'dummy-token'
$proc = $null
$ok = $false
try {
  $proc = Start-Process -FilePath 'node' `
    -ArgumentList '--expose-internals', 'node_modules\@deepseek-ai\dsh\lib\bin.js', 'web', '--patch', $patch, '--host', '127.0.0.1', '--port', '18990', '--no-open' `
    -WorkingDirectory $repo -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err
  Write-Host ("started pid=" + $proc.Id)
  for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest 'http://127.0.0.1:18990' -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ok = $true; Write-Host ("HTTP 200 after " + ($i * 2) + "s, bytes=" + $r.RawContentLength); break }
    } catch {
      if (($i % 10) -eq 0) {
        $status = if ($proc.HasExited) { 'EXITED code=' + $proc.ExitCode } else { 'running' }
        Write-Host ("poll " + $i + " - " + $status)
      }
    }
  }
} finally {
  if ($proc -and -not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>&1 | Out-Null }
  Remove-Item Env:DSH_DESKTOP_RPC_URL -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_DESKTOP_RPC_TOKEN -ErrorAction SilentlyContinue
}
if (-not $ok) {
  Write-Host '--- stderr tail ---'
  if (Test-Path $err) { Get-Content $err -Tail 25 }
  Write-Host '--- stdout tail ---'
  if (Test-Path $out) { Get-Content $out -Tail 10 }
  exit 1
}
Write-Host 'DEV-BOOT OK'

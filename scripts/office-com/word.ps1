# Office COM helper (ASCII only; stdout carries only OK/ERR marker,
# results are written as UTF-8 JSON to the file given by -Json).
# Actions:
#   detect      - create Word.Application COM to verify automation works
#   export-pdf  - open docx (hidden) and SaveAs2 PDF (format 17)
#   open        - open docx visibly for the user (keeps Word running)
param(
  [string]$Action = 'detect',
  [string]$In = '',
  [string]$Out = '',
  [string]$Json = ''
)
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-JsonResult {
  param([hashtable]$Data)
  if ($Json) {
    try { [System.IO.File]::WriteAllText($Json, ($Data | ConvertTo-Json -Compress -Depth 6), $utf8NoBom) } catch { }
  }
}

try {
  if ($Action -eq 'detect') {
    $word = $null
    try {
      $word = New-Object -ComObject Word.Application
      $word.Visible = $false
      Write-JsonResult @{ ok = $true; version = $word.Version }
      Write-Output 'OK'
    } finally {
      if ($word) { try { $word.Quit() } catch { } }
    }
    exit 0
  }

  if ($Action -eq 'export-pdf' -or $Action -eq 'open') {
    $word = $null
    $doc = $null
    try {
      $word = New-Object -ComObject Word.Application
      if ($Action -eq 'export-pdf') {
        $word.Visible = $false
        $word.DisplayAlerts = 0
        $doc = $word.Documents.Open($In, $false, $true)
        $doc.SaveAs2([ref]$Out, [ref]17)   # 17 = wdFormatPDF
        Write-JsonResult @{ ok = $true }
      } else {
        $word.Visible = $true
        $doc = $word.Documents.Open($In, $false, $false)
        Write-JsonResult @{ ok = $true }
      }
      Write-Output 'OK'
    } finally {
      if ($Action -eq 'export-pdf') {
        if ($doc) { try { $doc.Close($false) } catch { } }
        if ($word) { try { $word.Quit() } catch { } }
      }
    }
    exit 0
  }

  Write-JsonResult @{ ok = $false; error = 'unknown action: ' + $Action }
  Write-Output 'ERR'
  exit 2
} catch {
  Write-JsonResult @{ ok = $false; error = $_.Exception.Message }
  Write-Output 'ERR'
  exit 1
}

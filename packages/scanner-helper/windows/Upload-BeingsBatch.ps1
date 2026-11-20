<#
.SYNOPSIS
  Upload the ballot pictures of a SEALED, reviewed batch to the image store, asking for SCANNER_UPLOAD_TOKEN at a hidden
  prompt (paste it from the password app). The token lives only in this process's environment and is removed at the end.
  With no -Url, pictures go to the Cloudflare R2 Worker (https://beings-ballot-images.beingsvote-test.workers.dev).
  -Url, or IMAGE_STORE_URL in the environment, overrides that.

.EXAMPLE
  .\Upload-BeingsBatch.ps1 -BatchDir C:\...\BEINGS-Scans\ABC123\batch-20261110-081500 -Readings C:\private\readings.json -NodePath "C:\Program Files\nodejs\node.exe"
  (shows the plan, asks you to type the batch id to approve, then asks for the token)
#>
param(
  [Parameter(Mandatory = $true)][string]$BatchDir,
  [Parameter(Mandatory = $true)][string]$Readings,
  [Parameter(Mandatory = $true)][string]$NodePath,
  [int]$RetentionDays,
  [string]$Url,
  [switch]$IncludeFlagged
)
$ErrorActionPreference = "Stop"
$cli = Join-Path $PSScriptRoot "..\src\cli.mjs"
$common = @("upload", $BatchDir, "--readings", $Readings)
if ($RetentionDays) { $common += @("--retention-days", "$RetentionDays") }
if ($Url) { $common += @("--url", $Url) }
if ($IncludeFlagged) { $common += "--include-flagged" }

& $NodePath $cli @common          # dry run: prints the exact pages and hashes
if ($LASTEXITCODE -ne 0) { Write-Host "The plan has problems. Nothing was sent." -ForegroundColor Red; exit $LASTEXITCODE }
$batchId = Split-Path $BatchDir -Leaf
$typed = Read-Host "Type the batch id ($batchId) to approve sending these pictures"
if ($typed -ne $batchId) { Write-Host "Not approved. Nothing was sent." -ForegroundColor Yellow; exit 1 }
$sec = Read-Host "Paste SCANNER_UPLOAD_TOKEN (hidden)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $env:SCANNER_UPLOAD_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  & $NodePath $cli @common --approve $batchId
  $code = $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:\SCANNER_UPLOAD_TOKEN -ErrorAction SilentlyContinue
}
exit $code

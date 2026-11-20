<#
.SYNOPSIS
  Scan a stack of B.E.I.N.G.S. paper ballots from a WIA scanner's document feeder (USB or network/Wi-Fi, e.g. Brother
  DCP-L2640DW) into a new, never-reused batch folder, following the INCIDENT-001 protocol.

.DESCRIPTION
  * Lists scanners with -ListDevices (add -Json for machine-readable output).
  * Each run writes BEINGS-Scans\<SHORTCODE>\batch-YYYYMMDD-HHMMSS\ with page-01.png ..., a live manifest.json
    (page, file, bytes, SHA-256, size, time) and an append-only batch.log.
  * The expected sheet count is required up front. The operator confirms a hand count before the feeder starts.
  * Refuses to start while an earlier batch for the same election is neither sealed (DONE.txt) nor SUPERSEDED.
  * Never writes DONE. A clean, complete capture ends in state CAPTURED; anything else ends INCOMPLETE or
    INTERRUPTED with a loud "do not record" message. Ctrl+C or a jam can't look like success.
  * Sealing (DONE line), reading marks and uploading are separate Node steps: see packages\scanner-helper\README.md.
  * Never signs, never uploads, never needs a token.

.EXAMPLE
  .\Scan-BeingsBatch.ps1 -ListDevices
  .\Scan-BeingsBatch.ps1 -ElectionCode BEINGS-2026-ABC123 -ExpectedPages 7
  .\Scan-BeingsBatch.ps1 -ElectionCode BEINGS-2026-ABC123 -ExpectedPages 7 -DeviceName "Brother DCP-L2640DW" -NodePath "C:\Program Files\nodejs\node.exe"
#>
[CmdletBinding(DefaultParameterSetName = "Scan")]
param(
  [Parameter(ParameterSetName = "List", Mandatory = $true)][switch]$ListDevices,
  [Parameter(ParameterSetName = "Scan", Mandatory = $true)][ValidatePattern('^BEINGS-\d{4}-[A-Z0-9]{6}$')][string]$ElectionCode,
  [Parameter(ParameterSetName = "Scan", Mandatory = $true)][ValidateRange(1, 1000)][int]$ExpectedPages,
  [Parameter(ParameterSetName = "Scan")][ValidateSet(150, 200, 300, 600)][int]$Dpi = 300,
  [Parameter(ParameterSetName = "Scan")][ValidateSet("Color", "Grayscale")][string]$ColorMode = "Color",
  # Legal is the extent used for every batch so far (2550x4200 at 300 dpi) and reads fine with Letter ballots.
  [Parameter(ParameterSetName = "Scan")][ValidateSet("Letter", "Legal", "A4")][string]$PageSize = "Legal",
  [Parameter(ParameterSetName = "Scan")][string]$OutputRoot = (Join-Path $env:USERPROFILE "Documents\BEINGS-Scans"),
  [Parameter(ParameterSetName = "Scan")][string]$DeviceId,
  [Parameter(ParameterSetName = "Scan")][string]$DeviceName,
  [Parameter(ParameterSetName = "Scan")][switch]$OperatorCountConfirmed,
  [Parameter(ParameterSetName = "Scan")][string]$NodePath,
  [switch]$Json
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$WIA_FORMAT_BMP = "{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}"
$WIA_ERROR_PAPER_EMPTY = -2145320957   # 0x80210003
$WIA_ERROR_PAPER_JAM = -2145320958     # 0x80210002
$WIA_ERROR_BUSY = -2145320954          # 0x80210006
$WIA_ERROR_OFFLINE = -2145320955       # 0x80210005
$PROP_DHS = 3088; $PROP_DH_STATUS = 3087; $PROP_PAGES = 3096
$PROP_INTENT = 6146; $PROP_XRES = 6147; $PROP_YRES = 6148; $PROP_XPOS = 6149; $PROP_YPOS = 6150; $PROP_XEXT = 6151; $PROP_YEXT = 6152; $PROP_DEPTH = 4104
$PAGE_INCHES = @{ Letter = @(8.5, 11); Legal = @(8.5, 14); A4 = @(8.27, 11.69) }
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Set-WiaProp($props, [int]$id, $value) {
  foreach ($p in $props) { if ($p.PropertyID -eq $id) { $p.Value = $value; return $true } }
  return $false
}
function Get-WiaProp($props, [int]$id) {
  foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p.Value } }
  return $null
}
function Get-InfoProp($info, [string]$name) {
  try { return $info.Properties.Item($name).Value } catch { return $null }
}

function Format-BeingsError($err, [string]$step) {
  $ex = $err.Exception
  if ($ex.InnerException) { $ex = $ex.InnerException }
  $type = "Exception"
  $hr = 0
  $message = "$err"
  if ($ex) {
    try { $type = $ex.GetType().FullName } catch { $type = "Exception" }
    try { $hr = [int]$ex.HResult } catch { $hr = 0 }
    if ($ex.Message) { $message = "$($ex.Message)" }
  }
  $hex = "0x{0:X8}" -f ($hr -band [uint32]4294967295)
  $text = "step ${step}: ${type} ${hex}: ${message}"
  return [pscustomobject]@{ step = $step; type = $type; hresult = $hex; message = $message; text = $text }
}

function Initialize-BeingsWiaBytes {
  if ("BeingsWiaBytes" -as [type]) { return }
  Add-Type -TypeDefinition @"
using System;
using System.Reflection;
public static class BeingsWiaBytes {
  public static byte[] Copy(object imageFile) {
    if (imageFile == null) throw new ArgumentNullException("imageFile");
    object fileData = imageFile.GetType().InvokeMember("FileData", BindingFlags.GetProperty, null, imageFile, null);
    if (fileData == null) throw new InvalidOperationException("WIA image has no FileData");
    object raw = fileData.GetType().InvokeMember("BinaryData", BindingFlags.GetProperty, null, fileData, null);
    byte[] direct = raw as byte[];
    if (direct != null) return direct;
    Array arr = raw as Array;
    if (arr == null) throw new InvalidCastException("WIA FileData.BinaryData was not a byte array");
    byte[] bytes = new byte[arr.Length];
    arr.CopyTo(bytes, 0);
    return bytes;
  }
}
"@
}

function Invoke-BeingsTransfer($item) {
  # One feed. The driver's own format is the default. BMP is only a second call when that
  # call fails with a COM error that is not "feeder empty", a jam, offline, or busy.
  # An invalid cast is not retried: the sheet may already have moved.
  try {
    return @{ ok = $true; image = $item.Transfer() }
  } catch [System.Runtime.InteropServices.COMException] {
    $hr = 0
    try { $hr = [int]$_.Exception.HResult } catch { $hr = 0 }
    if ($hr -eq $WIA_ERROR_PAPER_EMPTY -or $hr -eq $WIA_ERROR_PAPER_JAM -or $hr -eq $WIA_ERROR_OFFLINE -or $hr -eq $WIA_ERROR_BUSY) {
      return @{ ok = $false; com = $true; hresult = $hr; error = $_ }
    }
    $first = Format-BeingsError $_ "transfer"
    Log $first.text
    try {
      return @{ ok = $true; image = $item.Transfer($WIA_FORMAT_BMP) }
    } catch [System.Runtime.InteropServices.COMException] {
      $hr2 = 0
      try { $hr2 = [int]$_.Exception.HResult } catch { $hr2 = 0 }
      Log (Format-BeingsError $_ "transfer").text
      return @{ ok = $false; com = $true; hresult = $hr2; error = $_ }
    } catch {
      Log (Format-BeingsError $_ "transfer").text
      return @{ ok = $false; com = $false; hresult = 0; error = $_ }
    }
  } catch {
    Log (Format-BeingsError $_ "transfer").text
    return @{ ok = $false; com = $false; hresult = 0; error = $_ }
  }
}

function Save-ScannedPng($img, [string]$Dir, [string]$PngName, [string]$RawName) {
  $rawPath = Join-Path $Dir $RawName
  $pngPath = Join-Path $Dir $PngName
  if ((Test-Path -LiteralPath $pngPath) -or (Test-Path -LiteralPath $rawPath)) { throw "step save: ${PngName} already exists" }
  $bytes = $null
  try {
    Initialize-BeingsWiaBytes
    $bytes = [BeingsWiaBytes]::Copy($img)
    [System.IO.File]::WriteAllBytes($rawPath, $bytes)
    Log "KEPT $RawName bytes=$($bytes.Length)"
  } catch {
    $copyErr = Format-BeingsError $_ "filedata"
    Log $copyErr.text
    try {
      $img.SaveFile($rawPath)
      if (-not (Test-Path -LiteralPath $rawPath)) { throw "SaveFile did not write a file" }
      $bytes = [System.IO.File]::ReadAllBytes($rawPath)
      Log "KEPT $RawName via SaveFile bytes=$($bytes.Length)"
    } catch {
      $saveErr = Format-BeingsError $_ "filedata"
      Log $saveErr.text
      throw $saveErr.text
    }
  }
  $ms = $null
  $src = $null
  $owned = $null
  try {
    Add-Type -AssemblyName System.Drawing | Out-Null
    $ms = New-Object System.IO.MemoryStream (,$bytes)
    $src = New-Object System.Drawing.Bitmap $ms
    $owned = New-Object System.Drawing.Bitmap $src
    $owned.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $size = @{ width = $owned.Width; height = $owned.Height }
  } catch {
    $conv = Format-BeingsError $_ "convert"
    Log $conv.text
    throw $conv.text
  } finally {
    if ($owned) { $owned.Dispose() }
    if ($src) { $src.Dispose() }
    if ($ms) { $ms.Dispose() }
  }
  Remove-Item -LiteralPath $rawPath -Force -ErrorAction SilentlyContinue
  return $size
}

function Get-BeingsScanners {
  $dm = New-Object -ComObject WIA.DeviceManager
  $out = @()
  for ($i = 1; $i -le $dm.DeviceInfos.Count; $i++) {
    $info = $dm.DeviceInfos.Item($i)
    if ($info.Type -ne 1) { continue }  # 1 = scanner
    $out += [pscustomobject]@{
      deviceId = $info.DeviceID
      name = (Get-InfoProp $info "Name")
      manufacturer = (Get-InfoProp $info "Manufacturer")
      port = (Get-InfoProp $info "Port")
      server = (Get-InfoProp $info "Server")
      connection = $(if ("$(Get-InfoProp $info 'Port')" -match '^(\\\\\?\\usb|USB)') { "usb" } elseif ("$(Get-InfoProp $info 'Port')" -match 'wsd|http|tcp|\d+\.\d+\.\d+\.\d+') { "network" } else { "unknown" })
    }
  }
  return ,$out
}

if ($ListDevices) {
  $list = Get-BeingsScanners
  if ($Json) { ConvertTo-Json -InputObject @($list) -Depth 3 -Compress; exit 0 }
  if ($list.Count -eq 0) { Write-Host "No WIA scanners found. Check the scanner is on, and for Wi-Fi models that it was added in Settings > Bluetooth & devices > Printers & scanners."; exit 0 }
  $list | Format-Table name, connection, port, deviceId -AutoSize
  exit 0
}

# ------------------------------------------------------------------ before the feeder starts
$ElectionCode = $ElectionCode.ToUpperInvariant()   # ValidatePattern is case-insensitive
$short = $ElectionCode -replace '^BEINGS-\d{4}-', ''
$electionDir = Join-Path $OutputRoot $short
New-Item -ItemType Directory -Force -Path $electionDir | Out-Null

$unresolved = @(Get-ChildItem -Path $electionDir -Directory -Filter "batch-*" -ErrorAction SilentlyContinue | Where-Object {
  -not (Test-Path (Join-Path $_.FullName "DONE.txt")) -and -not (Test-Path (Join-Path $_.FullName "SUPERSEDED.txt"))
})
if ($unresolved.Count -gt 0) {
  Write-Host ""
  Write-Host "STOP: earlier batch(es) for $ElectionCode are not sealed and not superseded:" -ForegroundColor Red
  $unresolved | ForEach-Object { Write-Host "   $($_.Name)" -ForegroundColor Red }
  Write-Host "Resolve them first: seal a complete one, or mark an interrupted one superseded:" -ForegroundColor Yellow
  Write-Host "   node packages\scanner-helper\src\cli.mjs supersede `"<batch folder>`" --reason `"interrupted, re-fed full stack`"" -ForegroundColor Yellow
  if ($Json) { ConvertTo-Json -Compress @{ ok = $false; error = "unresolved earlier batch"; batches = @($unresolved | ForEach-Object Name) } }
  exit 3
}

if (-not $OperatorCountConfirmed) {
  Write-Host "Count the ballots by hand before loading the feeder. Expected: $ExpectedPages sheet(s)."
  $typed = Read-Host "How many sheets did you count?"
  if ("$typed".Trim() -ne "$ExpectedPages") {
    Write-Host "STOP: you counted '$typed' but $ExpectedPages are expected. Find the difference before scanning." -ForegroundColor Red
    exit 4
  }
}

. (Join-Path $PSScriptRoot "Select-BeingsScanner.ps1")
$scanners = Get-BeingsScanners
$pick = $null
if ($DeviceId) { $pick = @($scanners | Where-Object deviceId -eq $DeviceId) | Select-Object -First 1 }
elseif ($DeviceName) { $pick = @($scanners | Where-Object { $_.name -like "*$DeviceName*" }) | Select-Object -First 1 }
else {
  $choice = Select-BeingsScanner $scanners
  if ($choice.ok) { $pick = $choice.device }
  else {
    Write-Host $choice.error -ForegroundColor Yellow
    if ($Json) { ConvertTo-Json -Compress @{ ok = $false; error = $choice.error } }
    exit 5
  }
}
if (-not $pick) {
  Write-Host "That scanner was not in the Windows list. Found:" -ForegroundColor Yellow
  $scanners | Format-Table name, connection, deviceId -AutoSize
  if ($Json) { ConvertTo-Json -Compress @{ ok = $false; error = "scanner not found" } }
  exit 5
}

$started = Get-Date
$batchId = "batch-" + $started.ToString("yyyyMMdd-HHmmss")
$batchDir = Join-Path $electionDir $batchId
if (Test-Path $batchDir) { Write-Host "STOP: $batchDir already exists. Never write into an earlier batch." -ForegroundColor Red; exit 6 }
New-Item -ItemType Directory -Path $batchDir | Out-Null
$logPath = Join-Path $batchDir "batch.log"
$manifestPath = Join-Path $batchDir "manifest.json"

function Log([string]$line) { [System.IO.File]::AppendAllText($logPath, (Get-Date).ToString("o") + " " + $line + "`r`n", $Utf8NoBom) }

$manifest = [ordered]@{
  schema = "beings-scan-batch/1"
  electionCode = $ElectionCode
  batchId = $batchId
  expectedPages = $ExpectedPages
  operatorCountConfirmed = $true
  dpi = $Dpi
  colorMode = $ColorMode
  pageSize = $PageSize
  device = [ordered]@{ name = $pick.name; deviceId = $pick.deviceId; connection = $pick.connection }
  computer = $env:COMPUTERNAME
  startedAt = $started.ToString("o")
  endedAt = $null
  state = "CAPTURING"
  stateReason = $null
  pages = @()
}
function Save-Manifest { [System.IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject $manifest -Depth 6), $Utf8NoBom) }
Save-Manifest
Log "START $ElectionCode $batchId expected=$ExpectedPages dpi=$Dpi color=$ColorMode pageSize=$PageSize device=`"$($pick.name)`" PID $PID"

# ------------------------------------------------------------------ scan
$finished = $false
$script:failStep = $null
try {
  try {
    $dm = New-Object -ComObject WIA.DeviceManager
    $info = $null
    for ($i = 1; $i -le $dm.DeviceInfos.Count; $i++) { if ($dm.DeviceInfos.Item($i).DeviceID -eq $pick.deviceId) { $info = $dm.DeviceInfos.Item($i) } }
    if (-not $info) { throw "scanner disappeared" }
    $dev = $info.Connect()
    if (-not (Set-WiaProp $dev.Properties $PROP_DHS 1)) { throw "this scanner has no document feeder setting" }   # 1 = FEEDER
    [void](Set-WiaProp $dev.Properties $PROP_PAGES 1)
    $item = $dev.Items.Item(1)
    $w = [int][math]::Round($PAGE_INCHES[$PageSize][0] * $Dpi); $h = [int][math]::Round($PAGE_INCHES[$PageSize][1] * $Dpi)
    [void](Set-WiaProp $item.Properties $PROP_INTENT $(if ($ColorMode -eq "Color") { 1 } else { 2 }))
    [void](Set-WiaProp $item.Properties $PROP_XRES $Dpi)
    [void](Set-WiaProp $item.Properties $PROP_YRES $Dpi)
    [void](Set-WiaProp $item.Properties $PROP_XPOS 0)
    [void](Set-WiaProp $item.Properties $PROP_YPOS 0)
    [void](Set-WiaProp $item.Properties $PROP_XEXT $w)
    [void](Set-WiaProp $item.Properties $PROP_YEXT $h)
    [void](Set-WiaProp $item.Properties $PROP_DEPTH $(if ($ColorMode -eq "Color") { 24 } else { 8 }))
    Log "SETTINGS DHS=1 extent=${w}x${h}"
    $status = Get-WiaProp $dev.Properties $PROP_DH_STATUS
    if ($null -ne $status -and (($status -band 1) -eq 0)) { throw "the feeder is empty or not ready (status $status). Load the ballots and run again." }
  } catch {
    $settings = Format-BeingsError $_ "settings"
    Log $settings.text
    throw $settings.text
  }

  $maxPages = $ExpectedPages + 25   # keep going past the expected count so extra sheets are noticed, not silently dropped
  $n = 0
  while ($n -lt $maxPages) {
    $next = $n + 1
    Log "PRE $next status=$(Get-WiaProp $dev.Properties $PROP_DH_STATUS)"
    $xfer = Invoke-BeingsTransfer $item
    if (-not $xfer.ok) {
      if ($xfer.com -and $xfer.hresult -eq $WIA_ERROR_PAPER_EMPTY) { Log "FEEDER EMPTY after $n"; break }
      if ($xfer.com -and $xfer.hresult -eq $WIA_ERROR_PAPER_JAM) { throw "step transfer: paper jam on sheet $next" }
      if ($xfer.com -and $xfer.hresult -eq $WIA_ERROR_OFFLINE) { throw "step transfer: scanner went offline on sheet $next" }
      if ($xfer.com -and $xfer.hresult -eq $WIA_ERROR_BUSY) { throw "step transfer: scanner is busy on sheet $next" }
      if ($xfer.error) { throw (Format-BeingsError $xfer.error "transfer").text }
      throw "step transfer: the scanner did not return a picture for sheet $next"
    }
    $pngName = "page-{0:D2}.png" -f $next
    $rawName = "page-{0:D2}.scan" -f $next
    $size = Save-ScannedPng $xfer.image $batchDir $pngName $rawName
    $n = $next
    $path = Join-Path $batchDir $pngName
    try {
      $fi = Get-Item -LiteralPath $path
      $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
      $manifest.pages += [ordered]@{ index = $n; file = $pngName; bytes = $fi.Length; sha256 = $sha; width = $size.width; height = $size.height; savedAt = (Get-Date).ToString("o") }
      Save-Manifest
      Log "SAVED $('{0:D2}' -f $n) $($size.width)x$($size.height) sha256=$sha"
    } catch {
      $record = Format-BeingsError $_ "record"
      Log $record.text
      throw $record.text
    }
    if (-not $Json) { Write-Host ("  saved page {0} of {1}" -f $n, $ExpectedPages) }
  }
  $saved = $manifest.pages.Count
  if ($saved -eq $ExpectedPages) { $manifest.state = "CAPTURED"; $manifest.stateReason = "$saved of $ExpectedPages pages" }
  else { $manifest.state = "INCOMPLETE"; $manifest.stateReason = "$saved of $ExpectedPages pages saved" }
  $finished = $true
} catch {
  $manifest.state = "INTERRUPTED"
  $msg = "$($_.Exception.Message)"
  if ($msg -match '^step ([^:]+):') { $script:failStep = $Matches[1] } else {
    $wrapped = Format-BeingsError $_ "scan"
    $msg = $wrapped.text
    $script:failStep = "scan"
    Log $wrapped.text
  }
  $manifest.stateReason = $msg
  Log "ERROR $msg"
  $finished = $true
} finally {
  if (-not $finished) {
    # Ctrl+C, window closed, or the process was stopped: never leave it looking like success.
    $manifest.state = "INTERRUPTED"
    $manifest.stateReason = "cancelled by the operator or stopped before the feeder finished"
  }
  $manifest.endedAt = (Get-Date).ToString("o")
  Save-Manifest
  Log "END state=$($manifest.state) saved=$($manifest.pages.Count) expected=$ExpectedPages"
  if ($manifest.state -ne "CAPTURED") {
    Write-Host ""
    Write-Host "==================================================================" -ForegroundColor Red
    Write-Host " INCOMPLETE - DO NOT RECORD THIS BATCH" -ForegroundColor Red
    Write-Host " $batchId : $($manifest.state) ($($manifest.stateReason))" -ForegroundColor Red
    Write-Host " Mark it superseded, then re-feed the FULL stack into a new batch:" -ForegroundColor Red
    Write-Host "   node packages\scanner-helper\src\cli.mjs supersede `"$batchDir`" --reason `"$($manifest.state)`"" -ForegroundColor Red
    Write-Host "==================================================================" -ForegroundColor Red
  }
}

# ------------------------------------------------------------------ hand over to the Node seal step
$sealed = $false
if ($manifest.state -eq "CAPTURED") {
  if ($NodePath -and (Test-Path $NodePath)) {
    $cli = Join-Path $PSScriptRoot "..\src\cli.mjs"
    & $NodePath $cli seal $batchDir
    $sealed = ($LASTEXITCODE -eq 0)
  } elseif (-not $Json) {
    Write-Host "Captured $($manifest.pages.Count) of $ExpectedPages. Next, seal it (writes the DONE line only if every check passes):" -ForegroundColor Green
    Write-Host "   node packages\scanner-helper\src\cli.mjs seal `"$batchDir`"" -ForegroundColor Green
  }
}
if ($Json) {
  ConvertTo-Json -Compress -InputObject ([ordered]@{ ok = ($manifest.state -eq "CAPTURED"); batchId = $batchId; state = $manifest.state; reason = $manifest.stateReason; step = $script:failStep; saved = $manifest.pages.Count; expected = $ExpectedPages; sealed = $sealed })
}
if ($manifest.state -eq "CAPTURED") { exit 0 } else { exit 2 }

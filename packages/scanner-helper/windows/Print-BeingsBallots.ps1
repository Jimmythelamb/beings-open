<#
.SYNOPSIS
  Print a B.E.I.N.G.S. ballot PDF straight to a chosen printer, using only what ships with Windows.

.DESCRIPTION
  * -ListPrinters shows installed printers (USB, network and Wi-Fi, e.g. Brother DCP-L2640DW).
  * Counts the PDF's pages and refuses to print when that differs from -ExpectedPages.
  * The default path is Windows built-in printing. PowerShell 5.1 renders each page with
    Windows.Data.Pdf (PdfDocument.LoadFromFileAsync, PdfPage.RenderToStreamAsync at 300 DPI)
    and sends the bitmaps with System.Drawing.Printing.PrintDocument. The job names the chosen
    printer, is single-sided, uses zero margins, and fits the printable area without scaling
    the page larger than its physical size. StandardPrintController suppresses the progress dialog.
    No PDF app window is opened.
  * SumatraPDF is used only when it is already installed and the built-in path fails. This script
    never downloads it and never uses the PrintTo verb.
  * Writes print-log.json next to the PDF: file SHA-256, pages, printer, time. It never logs ballot codes.

.EXAMPLE
  .\Print-BeingsBallots.ps1 -ListPrinters
  .\Print-BeingsBallots.ps1 -PdfPath C:\...\BEINGS-2026-ABC123-ballots.pdf -PrinterName "Brother DCP-L2640DW series" -ExpectedPages 7
#>
[CmdletBinding(DefaultParameterSetName = "Print")]
param(
  [Parameter(ParameterSetName = "List", Mandatory = $true)][switch]$ListPrinters,
  [Parameter(ParameterSetName = "Print", Mandatory = $true)][string]$PdfPath,
  [Parameter(ParameterSetName = "Print", Mandatory = $true)][string]$PrinterName,
  [Parameter(ParameterSetName = "Print", Mandatory = $true)][ValidateRange(1, 5000)][int]$ExpectedPages,
  [Parameter(ParameterSetName = "Print")][string]$SumatraPath,
  [Parameter(ParameterSetName = "Print")][string]$NodePath,
  [Parameter(ParameterSetName = "Print")][switch]$WhatIf,
  [switch]$Json
)
Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$script:WinRtOp = $null
$script:WinRtAction = $null

function Get-BeingsPrinters {
  $list = @()
  $defaultName = $null
  try {
    $def = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Default -eq $true } | Select-Object -First 1
    if ($def) { $defaultName = $def.Name }
  } catch { }
  if (Get-Command Get-Printer -ErrorAction SilentlyContinue) {
    foreach ($p in Get-Printer) {
      $list += [pscustomobject]@{ name = $p.Name; driver = $p.DriverName; port = $p.PortName; type = "$($p.Type)"; shared = $p.Shared; status = "$($p.PrinterStatus)"; default = ($p.Name -eq $defaultName); connection = $(if ($p.PortName -match '^USB') { "usb" } elseif ($p.PortName -match '^(BRW|WSD|IP_)|WSD|\d+\.\d+\.\d+\.\d+|http') { "network" } else { "other" }) }
    }
  } else {
    foreach ($p in Get-CimInstance Win32_Printer) { $list += [pscustomobject]@{ name = $p.Name; driver = $p.DriverName; port = $p.PortName; type = ""; shared = $p.Shared; status = "$($p.PrinterStatus)"; default = [bool]$p.Default; connection = "unknown" } }
  }
  return ,$list
}

function Resolve-ExistingSumatra([string]$Explicit) {
  $candidates = @()
  if ($Explicit) { $candidates += $Explicit }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA "SumatraPDF\SumatraPDF.exe"),
    (Join-Path $env:ProgramFiles "SumatraPDF\SumatraPDF.exe")
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "SumatraPDF\SumatraPDF.exe") }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

function Initialize-WinRtAwaiters {
  if ($script:WinRtOp) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
  $script:WinRtOp = $methods | Where-Object {
    $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  $script:WinRtAction = $methods | Where-Object {
    $_.Name -eq "AsTask" -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncAction"
  } | Select-Object -First 1
  if (-not $script:WinRtOp -or -not $script:WinRtAction) { throw "Windows could not prepare the built-in PDF renderer." }
}

function Wait-WinRtOperation($operation, $resultType) {
  Initialize-WinRtAwaiters
  $task = $script:WinRtOp.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  if ($task.IsFaulted) {
    $inner = $task.Exception.InnerException
    if ($inner) { throw $inner }
    throw $task.Exception
  }
  return $task.Result
}

function Wait-WinRtAction($action) {
  Initialize-WinRtAwaiters
  $task = $script:WinRtAction.Invoke($null, @($action))
  $task.Wait()
  if ($task.IsFaulted) {
    $inner = $task.Exception.InnerException
    if ($inner) { throw $inner }
    throw $task.Exception
  }
}

function Get-PdfPageBitmaps([string]$Path, [int]$Dpi) {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  Add-Type -AssemblyName System.Drawing | Out-Null
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $file = Wait-WinRtOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $doc = Wait-WinRtOperation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $bitmaps = New-Object System.Collections.Generic.List[System.Drawing.Bitmap]
  try {
    for ($i = 0; $i -lt $doc.PageCount; $i++) {
      $page = $null
      $ras = $null
      $net = $null
      $copy = $null
      $shown = $null
      try {
        $page = $doc.GetPage([uint32]$i)
        $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
        $opts.DestinationWidth = [uint32][Math]::Round(([double]$page.Size.Width) * $Dpi / 96.0)
        $opts.DestinationHeight = [uint32][Math]::Round(([double]$page.Size.Height) * $Dpi / 96.0)
        $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        Wait-WinRtAction ($page.RenderToStreamAsync($ras, $opts))
        $ras.Seek(0) | Out-Null
        $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStream($ras)
        $copy = New-Object System.IO.MemoryStream
        $net.CopyTo($copy)
        $copy.Position = 0
        $shown = New-Object System.Drawing.Bitmap $copy
        $owned = New-Object System.Drawing.Bitmap $shown
        $bitmaps.Add($owned)
      } finally {
        if ($shown) { $shown.Dispose() }
        if ($copy) { $copy.Dispose() }
        if ($net) { $net.Dispose() }
        if ($page) { $page.Dispose() }
      }
    }
  } catch {
    foreach ($b in $bitmaps) { try { $b.Dispose() } catch { } }
    throw
  }
  return ,$bitmaps.ToArray()
}

function Send-BitmapsToPrinter($bitmaps, [string]$Name, [int]$Dpi) {
  Add-Type -AssemblyName System.Drawing | Out-Null
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings.PrinterName = $Name
  if (-not $doc.PrinterSettings.IsValid) { throw "Windows does not have a printer named '$Name'." }
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins 0, 0, 0, 0
  $doc.OriginAtMargins = $false
  if ($doc.PrinterSettings.CanDuplex) { $doc.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Simplex }
  $state = @{ index = 0; pages = @($bitmaps); dpi = $Dpi }
  $handler = {
    param($sender, $e)
    $bmp = $state.pages[$state.index]
    $area = $e.PageSettings.PrintableArea
    $physW = ($bmp.Width * 100.0) / $state.dpi
    $physH = ($bmp.Height * 100.0) / $state.dpi
    $scale = 1.0
    if ($area.Width -gt 0 -and $physW -gt $area.Width) { $scale = [Math]::Min($scale, ($area.Width / $physW)) }
    if ($area.Height -gt 0 -and $physH -gt $area.Height) { $scale = [Math]::Min($scale, ($area.Height / $physH)) }
    if ($scale -gt 1) { $scale = 1 }
    $e.Graphics.DrawImage($bmp, [single]$area.X, [single]$area.Y, [single]($physW * $scale), [single]($physH * $scale))
    $state.index++
    $e.HasMorePages = ($state.index -lt $state.pages.Count)
  }.GetNewClosure()
  $doc.add_PrintPage($handler)
  try {
    $doc.Print()
  } finally {
    $doc.remove_PrintPage($handler)
    $doc.Dispose()
    foreach ($b in @($bitmaps)) { try { $b.Dispose() } catch { } }
  }
}

function Send-PdfWithWindows([string]$Path, [string]$Name) {
  $bitmaps = Get-PdfPageBitmaps $Path 300
  if (@($bitmaps).Count -lt 1) { throw "Windows did not render any pages from the PDF." }
  Send-BitmapsToPrinter $bitmaps $Name 300
}

function Get-QueueJobs([string]$Name) {
  try {
    return @(Get-CimInstance -ClassName Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ($Name + ",*") })
  } catch {
    return @()
  }
}

# Print() only hands the job to the spooler. Wait briefly and report error, offline, or paper-out bits.
function Wait-SpoolerJob([string]$Name, $beforeIds) {
  $deadline = (Get-Date).AddSeconds(12)
  $seen = $null
  do {
    Start-Sleep -Milliseconds 500
    $jobs = @(Get-QueueJobs $Name)
    $fresh = @($jobs | Where-Object { $beforeIds -notcontains $_.JobId })
    if ($fresh.Count -eq 0 -and $seen) {
      return @{ gone = $true; jobStatus = 0; status = "left the queue"; jobId = $seen.jobId }
    }
    if ($fresh.Count -gt 0) {
      $job = $fresh | Sort-Object JobId -Descending | Select-Object -First 1
      $bits = 0
      try { $bits = [int]$job.JobStatus } catch { $bits = 0 }
      $seen = @{ gone = $false; jobStatus = $bits; status = [string]$job.Status; jobId = [int]$job.JobId }
      if (($bits -band 2) -or ($bits -band 32) -or ($bits -band 64) -or ($bits -band 512) -or ($bits -band 1024)) { return $seen }
      if (($bits -band 128) -or ($bits -band 4096)) { return $seen }
    }
  } while ((Get-Date) -lt $deadline)
  if ($seen) { return $seen }
  return @{ gone = $true; jobStatus = 0; status = "left the queue"; jobId = $null }
}

if ($ListPrinters) {
  $l = Get-BeingsPrinters
  if ($Json) { ConvertTo-Json -InputObject @($l) -Compress; exit 0 }
  $l | Format-Table name, connection, port, status -AutoSize
  exit 0
}

if (-not (Test-Path -LiteralPath $PdfPath)) { Write-Host "No such file: $PdfPath" -ForegroundColor Red; exit 2 }
$pdf = (Resolve-Path -LiteralPath $PdfPath).Path
$printer = Get-BeingsPrinters | Where-Object name -eq $PrinterName | Select-Object -First 1
if (-not $printer) { Write-Host "No printer named '$PrinterName'. Run with -ListPrinters to see the names." -ForegroundColor Red; exit 2 }

$pages = $null
if ($NodePath -and (Test-Path -LiteralPath $NodePath)) {
  $cli = Join-Path $PSScriptRoot "..\src\cli.mjs"
  $out = & $NodePath $cli pdf-pages $pdf 2>$null
  if ($LASTEXITCODE -eq 0) { $pages = ([int]((ConvertFrom-Json ($out | Select-Object -Last 1)).pages)) }
}
if ($null -eq $pages) {
  $text = [System.Text.Encoding]::GetEncoding(28591).GetString([System.IO.File]::ReadAllBytes($pdf))
  $pages = ([regex]::Matches($text, '/Type\s*/Page(?![s\w])')).Count
  if ($pages -eq 0) { Write-Host "Could not count the PDF's pages without Node. Re-run with -NodePath `"C:\Program Files\nodejs\node.exe`"." -ForegroundColor Red; exit 3 }
}
if ($pages -ne $ExpectedPages) {
  Write-Host "STOP: the PDF has $pages page(s) but $ExpectedPages ballot(s) are expected. Not printing." -ForegroundColor Red
  exit 4
}
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $pdf).Hash.ToLowerInvariant()

$method = "Windows built-in"
$spooler = $null
$printError = $null
if ($WhatIf) {
  Write-Host "Would print $pages page(s) of $pdf to '$PrinterName' with Windows built-in printing. Nothing was sent."
} else {
  try {
    # Render the PDF ourselves and print with PrintDocument. This does not open Adobe or any other PDF app.
    # The helper starts PowerShell with -STA; PrintDocument fails from an MTA thread.
    $before = @(Get-QueueJobs $PrinterName | ForEach-Object { $_.JobId })
    Send-PdfWithWindows $pdf $PrinterName
    $spooler = Wait-SpoolerJob $PrinterName $before
  } catch {
    $printError = $_.Exception.Message
    Write-Host "Windows built-in printing did not finish: $printError" -ForegroundColor Yellow
    $sumatra = Resolve-ExistingSumatra $SumatraPath
    if (-not $sumatra) {
      Write-Host "SumatraPDF is not installed. This helper does not open a PDF app. Nothing was printed." -ForegroundColor Red
      if ($Json) { ConvertTo-Json -Compress -InputObject ([ordered]@{ ok = $false; printed = $false; method = $method; printer = $PrinterName; error = $printError; message = "Windows built-in printing did not finish: $printError. No PDF app was opened. Nothing was printed." }) }
      exit 5
    }
    Write-Host "Trying SumatraPDF that is already installed. This helper did not download it." -ForegroundColor Yellow
    $method = "SumatraPDF"
    $proc = Start-Process -FilePath $sumatra -ArgumentList @("-print-to", "`"$PrinterName`"", "-print-settings", "`"noscale,simplex`"", "-silent", "-exit-when-done", "`"$pdf`"") -PassThru -Wait -WindowStyle Hidden
    if ($proc.ExitCode -ne 0) {
      $printError = "SumatraPDF reported an error ($($proc.ExitCode))."
      Write-Host $printError -ForegroundColor Red
      if ($Json) { ConvertTo-Json -Compress -InputObject ([ordered]@{ ok = $false; printed = $false; method = $method; printer = $PrinterName; error = $printError; message = $printError }) }
      exit 5
    }
    $printError = $null
  }
}

$bits = 0
if ($spooler) { try { $bits = [int]$spooler.jobStatus } catch { $bits = 0 } }
$spoolerError = ($bits -band 2) -or ($bits -band 32) -or ($bits -band 64) -or ($bits -band 512) -or ($bits -band 1024)
$stillQueued = ($bits -band 8) -or ($bits -band 16)
$printedOk = (-not $WhatIf) -and (-not $printError) -and (-not $spoolerError) -and (-not $stillQueued)
$log = Join-Path (Split-Path -Parent $pdf) "print-log.json"
$entry = [ordered]@{ ok = $printedOk; printed = $printedOk; at = (Get-Date).ToString("o"); file = (Split-Path -Leaf $pdf); sha256 = $sha; pages = $pages; expectedPages = $ExpectedPages; printer = $PrinterName; connection = $printer.connection; method = $method; whatIf = [bool]$WhatIf; computer = $env:COMPUTERNAME; spooler = $spooler; error = $printError }
$all = @()
if (Test-Path -LiteralPath $log) { try { $all = @(Get-Content -LiteralPath $log -Raw | ConvertFrom-Json) } catch { $all = @() } }
$all += [pscustomobject]$entry
[System.IO.File]::WriteAllText($log, (ConvertTo-Json -InputObject @($all) -Depth 5), $Utf8NoBom)
if ($spoolerError) {
  $why = if ($spooler.status) { $spooler.status } else { "Windows print queue error (status $bits)" }
  Write-Host "The job for '$PrinterName' did not finish: $why" -ForegroundColor Red
  $entry.message = "Windows put the job on '$PrinterName' and then reported: $why. Nothing was confirmed on paper."
  if ($Json) { ConvertTo-Json -Compress -InputObject $entry }
  exit 6
}
if ($printedOk) { Write-Host "Printed $pages page(s) to '$PrinterName' with $method. Count the sheets in the tray: it must be $ExpectedPages." -ForegroundColor Green }
if ($Json) { ConvertTo-Json -Compress -InputObject $entry }
exit 0

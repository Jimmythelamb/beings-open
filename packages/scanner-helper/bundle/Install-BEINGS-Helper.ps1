# Install the BEINGS scanner helper for the current Windows user.
# Launched by Install-BEINGS-Helper.cmd with -ExecutionPolicy Bypass for this process only.
# No administrator rights. Does not change the machine execution policy.
# Replaces any older copy in %LOCALAPPDATA%\BEINGS\scanner-helper.
# Stops a helper that is already running, then starts the new one with no console window.
# Signs the helper in at the next Windows sign-in. Registers beings-helper://start.
# This script was syntax-checked with PowerShell on Linux. It was not run on a real Windows PC in CI
# (no Windows installer, WScript shortcut, or nodejs.org download was executed there).
$ErrorActionPreference = "Stop"
try { $Host.UI.RawUI.WindowTitle = "Install BEINGS scanner helper" } catch { }

function Write-Step([string]$Message) {
  Write-Host $Message
}

function Get-NodeMajor([string]$Exe) {
  if (-not $Exe) { return 0 }
  if ($Exe -match '\\WindowsApps\\') { return 0 }
  try {
    $raw = & $Exe -p "process.versions.node" 2>$null
    if (-not $raw) { return 0 }
    $m = [regex]::Match([string]$raw, '(\d+)')
    if (-not $m.Success) { return 0 }
    return [int]$m.Groups[1].Value
  } catch {
    return 0
  }
}

function Find-ExistingNode {
  $best = $null
  $bestMajor = 0
  $cmds = @(Get-Command node -All -ErrorAction SilentlyContinue)
  foreach ($c in $cmds) {
    $src = $c.Source
    if (-not $src) { $src = [string]$c.Definition }
    $major = Get-NodeMajor $src
    if ($major -ge 20 -and $major -gt $bestMajor) {
      $best = $src
      $bestMajor = $major
    }
  }
  $programs = Join-Path $env:LOCALAPPDATA "Programs"
  if (Test-Path -LiteralPath $programs) {
    $dirs = @(Get-ChildItem -LiteralPath $programs -Directory -Filter "node-*" -ErrorAction SilentlyContinue)
    foreach ($d in $dirs) {
      $exe = Join-Path $d.FullName "node.exe"
      $major = Get-NodeMajor $exe
      if ($major -ge 20 -and $major -gt $bestMajor) {
        $best = $exe
        $bestMajor = $major
      }
    }
  }
  return $best
}

function Enable-Tls12 {
  try {
    $tls12 = [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor $tls12
  } catch {
    # Windows PowerShell 5.1 needs Tls12. PowerShell 7 already uses TLS 1.2+.
  }
}

function Get-NodeLtsSpec {
  $indexUrl = "https://nodejs.org/dist/index.json"
  # Invoke-RestMethod on Windows PowerShell 5.1 has no -UseBasicParsing. Invoke-WebRequest below does.
  $index = @(Invoke-RestMethod -Uri $indexUrl)
  foreach ($rel in $index) {
    $isLts = $false
    if ($rel.lts -and ($rel.lts -ne $false)) { $isLts = $true }
    $files = @($rel.files)
    if ($isLts -and ($files -contains "win-x64-zip")) {
      $version = [string]$rel.version
      if ($version -notmatch '^v\d+\.\d+\.\d+$') { throw "nodejs.org returned an unexpected version: $version" }
      $zipName = "node-$version-win-x64.zip"
      return [pscustomobject]@{
        Version = $version
        ZipName = $zipName
        ZipUrl  = "https://nodejs.org/dist/$version/$zipName"
        SumUrl  = "https://nodejs.org/dist/$version/SHASUMS256.txt"
      }
    }
  }
  throw "Could not find a Node.js LTS Windows 64-bit zip on nodejs.org."
}

function Assert-OfficialNodeUrl([string]$Url, [string]$Pattern) {
  if ($Url -notmatch $Pattern) { throw "Refusing a Node.js URL that is not the official nodejs.org file: $Url" }
}

function Install-OfficialNode {
  Enable-Tls12
  $spec = Get-NodeLtsSpec
  Assert-OfficialNodeUrl $spec.ZipUrl '^https://nodejs\.org/dist/v\d+\.\d+\.\d+/node-v\d+\.\d+\.\d+-win-x64\.zip$'
  Assert-OfficialNodeUrl $spec.SumUrl '^https://nodejs\.org/dist/v\d+\.\d+\.\d+/SHASUMS256\.txt$'
  Write-Step "Downloading Node.js $($spec.Version) for 64-bit Windows from nodejs.org..."
  $work = Join-Path $env:TEMP ("beings-node-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    $zipPath = Join-Path $work $spec.ZipName
    $sumPath = Join-Path $work "SHASUMS256.txt"
    Invoke-WebRequest -Uri $spec.SumUrl -OutFile $sumPath -UseBasicParsing
    Invoke-WebRequest -Uri $spec.ZipUrl -OutFile $zipPath -UseBasicParsing
    $length = (Get-Item -LiteralPath $zipPath).Length
    if ($length -lt 1MB -or $length -gt 80MB) {
      throw "The Node.js download is an unexpected size ($length bytes). Nothing was installed."
    }
    $expected = $null
    foreach ($line in ([System.IO.File]::ReadAllText($sumPath) -split "`n")) {
      $trim = $line.Trim()
      if ($trim -match '^([a-fA-F0-9]{64})\s+\*?(.+)$') {
        $name = $Matches[2].Trim()
        if ($name -eq $spec.ZipName) { $expected = $Matches[1].ToLower(); break }
      }
    }
    if (-not $expected) { throw "SHASUMS256.txt from nodejs.org has no line for $($spec.ZipName). Nothing was installed." }
    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
      throw "The Node.js download did not match the SHA256 published by nodejs.org. Expected $expected but the file is $actual. Nothing was installed."
    }
    Write-Step "SHA256 matches nodejs.org. Unpacking Node.js..."
    $extract = Join-Path $work "extract"
    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extract -Force
    $extracted = @(Get-ChildItem -LiteralPath $extract -Directory)
    if ($extracted.Count -ne 1) { throw "The Node.js zip did not contain a single folder. Nothing was installed." }
    $programs = Join-Path $env:LOCALAPPDATA "Programs"
    New-Item -ItemType Directory -Force -Path $programs | Out-Null
    $target = Join-Path $programs $extracted[0].Name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Move-Item -LiteralPath $extracted[0].FullName -Destination $target
    $nodeExe = Join-Path $target "node.exe"
    if (-not (Test-Path -LiteralPath $nodeExe)) { throw "node.exe was not in the Node.js zip. Nothing else was changed." }
    if ((Get-NodeMajor $nodeExe) -lt 20) { throw "The downloaded Node.js is older than version 20." }
    return $nodeExe
  } finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Copy-Tree([string]$From, [string]$To) {
  if (-not (Test-Path -LiteralPath $To)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $To) | Out-Null
    Copy-Item -LiteralPath $From -Destination $To -Recurse -Force
    return
  }
  Get-ChildItem -LiteralPath $From -Force | ForEach-Object {
    $dest = Join-Path $To $_.Name
    if ($_.PSIsContainer) { Copy-Tree $_.FullName $dest }
    else { Copy-Item -LiteralPath $_.FullName -Destination $dest -Force }
  }
}

function Stop-BeingsHelper {
  try {
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -eq "node.exe" -and $_.CommandLine -and ($_.CommandLine -like "*cli.mjs*bridge*")
    })
    foreach ($p in $procs) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch { }
  Start-Sleep -Milliseconds 400
}

function New-HiddenShortcut([string]$LnkPath, [string]$VbsPath, [string]$Work, [string]$Description) {
  $dir = Split-Path -Parent $LnkPath
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($LnkPath)
  $sc.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
  $sc.Arguments = '//B "' + $VbsPath + '"'
  $sc.WorkingDirectory = $Work
  $sc.WindowStyle = 7
  $sc.Description = $Description
  $sc.Save()
}

function Register-BeingsAutostart([string]$VbsPath) {
  $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
  $value = '"' + $wscript + '" //B "' + $VbsPath + '"'
  $run = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  if (-not (Test-Path -LiteralPath $run)) { New-Item -Path $run -Force | Out-Null }
  Set-ItemProperty -LiteralPath $run -Name "BEINGS scanner helper" -Value $value
}

function Register-BeingsProtocol([string]$VbsPath) {
  $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
  $cls = "HKCU:\Software\Classes\beings-helper"
  New-Item -Path $cls -Force | Out-Null
  Set-Item -Path $cls -Value "URL:BEINGS Helper Protocol"
  New-ItemProperty -Path $cls -Name "URL Protocol" -PropertyType String -Value "" -Force | Out-Null
  $commandKey = Join-Path $cls "shell\open\command"
  New-Item -Path $commandKey -Force | Out-Null
  Set-Item -Path $commandKey -Value ('"' + $wscript + '" //B "' + $VbsPath + '" "%1"')
}

function Register-BeingsUninstall([string]$Version, [string]$UninstallCommand) {
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BEINGS scanner helper"
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name "DisplayName" -Value "BEINGS scanner helper" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "DisplayVersion" -Value $Version -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "Publisher" -Value "BEINGS" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "UninstallString" -Value $UninstallCommand -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $key -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $here) { throw "Run this script with -File from Install-BEINGS-Helper.cmd." }
$here = [System.IO.Path]::GetFullPath($here)
$dest = Join-Path $env:LOCALAPPDATA "BEINGS\scanner-helper"
$destFull = [System.IO.Path]::GetFullPath($dest)

Write-Step "Installing the BEINGS scanner helper for this Windows user."
Write-Step "No administrator password is needed."
Write-Step "Stopping the helper if it is already running."
Stop-BeingsHelper

if ($here.TrimEnd('\') -ne $destFull.TrimEnd('\')) {
  Write-Step "Copying the helper to $destFull"
  Copy-Tree $here $destFull
} else {
  Write-Step "The helper is already in $destFull"
}

$bundled = Join-Path $destFull "node\node.exe"
$nodeExe = $null
if ((Test-Path -LiteralPath $bundled) -and ((Get-NodeMajor $bundled) -ge 20)) {
  $nodeExe = $bundled
  Write-Step "Using the Node.js included with this helper."
} else {
  $nodeExe = Find-ExistingNode
  if ($nodeExe) {
    Write-Step "Using Node.js already on this PC: $nodeExe"
  } else {
    Write-Step "Node.js 20 or newer was not found on PATH or under %LOCALAPPDATA%\Programs\node-*."
    $nodeExe = Install-OfficialNode
    Write-Step "Installed Node.js at $nodeExe"
  }
}

$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $destFull "node-path.txt"), $nodeExe.Trim(), $utf8)

$stamp = Join-Path $destFull "Write-InstallStamp.ps1"
if (-not (Test-Path -LiteralPath $stamp)) { throw "Write-InstallStamp.ps1 is missing from the helper folder." }
& $stamp

$launch = Join-Path $destFull "Launch-BEINGS-Helper.vbs"
$stop = Join-Path $destFull "Stop-BEINGS-Helper.vbs"
if (-not (Test-Path -LiteralPath $launch)) { throw "Launch-BEINGS-Helper.vbs is missing from the helper folder." }
if (-not (Test-Path -LiteralPath $stop)) { throw "Stop-BEINGS-Helper.vbs is missing from the helper folder." }

$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
New-HiddenShortcut (Join-Path $startMenu "Start BEINGS helper.lnk") $launch $destFull "Start the BEINGS scanner helper in the background"
New-HiddenShortcut (Join-Path $startMenu "Stop BEINGS helper.lnk") $stop $destFull "Stop the BEINGS scanner helper"
New-HiddenShortcut (Join-Path $startMenu "Startup\Start BEINGS helper.lnk") $launch $destFull "Start the BEINGS scanner helper when you sign in"
$desktop = [Environment]::GetFolderPath("Desktop")
if ($desktop) { New-HiddenShortcut (Join-Path $desktop "Start BEINGS helper.lnk") $launch $destFull "Start the BEINGS scanner helper in the background" }
Write-Step "Added Start BEINGS helper and Stop BEINGS helper to the Start menu."

Register-BeingsAutostart $launch
Write-Step "The helper will start in the background when you sign in. There is no window to keep open."
Register-BeingsProtocol $launch
Write-Step "Registered beings-helper://start for this Windows user."

$version = "0.0.0"
$versionFile = Join-Path $destFull "version.txt"
if (Test-Path -LiteralPath $versionFile) { $version = ([System.IO.File]::ReadAllText($versionFile)).Trim() }
$uninstall = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $destFull "Uninstall-BEINGS-Helper.ps1") + '"'
Register-BeingsUninstall $version $uninstall

Write-Step "Printing uses Windows built-in printing. This installer does not download a PDF app."
Start-Process -FilePath (Join-Path $env:WINDIR "System32\wscript.exe") -ArgumentList @("//B", $launch) -WindowStyle Hidden
Write-Step "Installed. You can close this window. The helper is running in the background."

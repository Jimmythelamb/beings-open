# Removes the per-user BEINGS scanner helper. No administrator rights.
# Apps & features can point here for a zip install. The setup .exe has its own uninstaller.
$ErrorActionPreference = "Continue"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $dir) { throw "Run this script with -File from the helper folder." }
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
$stop = Join-Path $dir "Stop-BEINGS-Helper.vbs"
if ((Test-Path -LiteralPath $wscript) -and (Test-Path -LiteralPath $stop)) {
  Start-Process -FilePath $wscript -ArgumentList @("//B", $stop) -Wait -WindowStyle Hidden
}
Remove-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "BEINGS scanner helper" -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "HKCU:\Software\Classes\beings-helper" -Recurse -Force -ErrorAction SilentlyContinue
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
foreach ($name in @("Start BEINGS helper.lnk", "Stop BEINGS helper.lnk")) {
  foreach ($folder in @($startMenu, (Join-Path $startMenu "Startup"), [Environment]::GetFolderPath("Desktop"))) {
    if (-not $folder) { continue }
    $link = Join-Path $folder $name
    if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue }
  }
}
Remove-Item -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BEINGS scanner helper" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "HKCU:\Software\BEINGS\Scanner Helper" -Recurse -Force -ErrorAction SilentlyContinue
$cleanup = Join-Path $env:TEMP "beings-helper-uninstall.cmd"
$cmd = "@echo off`r`ntimeout /t 2 /nobreak >nul`r`nrd /s /q `"$dir`"`r`ndel `"%~f0`"`r`n"
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($cleanup, $cmd, $utf8)
Start-Process -FilePath $cleanup -WindowStyle Hidden

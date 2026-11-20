# Writes install.json { version, installedAt } and a line in helper.log.
# The setup program and the zip installer both call this after the files are in place.
# Windows PowerShell 5.1. No administrator rights.
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $dir) { throw "Run this script with -File from the helper folder." }
$versionPath = Join-Path $dir "version.txt"
$version = ([System.IO.File]::ReadAllText($versionPath)).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "version.txt is not a helper version." }
$installedAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
$json = '{"version":"' + $version + '","installedAt":"' + $installedAt + '"}'
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $dir "install.json"), $json, $utf8)
$line = $installedAt + " installed " + $version + "`r`n"
[System.IO.File]::AppendAllText((Join-Path $dir "helper.log"), $line, $utf8)

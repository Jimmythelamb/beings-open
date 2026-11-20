# Pure picker for WIA scanner lists. No COM, no network. Dot-sourced by Scan-BeingsBatch.ps1.
# Same rule as src/pick-scanner.mjs: one machine listed twice (Microsoft WSD plus the
# maker's own driver) is the same model. Keep the maker's driver. Different models are refused.

function Get-BeingsScannerModel([string]$Name) {
  $raw = "$Name"
  $hit = [regex]::Match($raw, '(?i)\b(dcp|mfc|hl)[- ]?[a-z0-9]+\b')
  if ($hit.Success) { return ($hit.Value -replace '[- ]', '').ToLowerInvariant() }
  $raw = [regex]::Replace($raw, '\[[^\]]*\]', ' ')
  $raw = [regex]::Replace($raw, '(?i)\b(lan|series|wsd|usb|network|scanner|printer)\b', ' ')
  $raw = [regex]::Replace($raw, '[^a-zA-Z0-9]+', ' ').Trim().ToLowerInvariant()
  return $raw
}

function Test-BeingsMicrosoftDriver($Device) {
  return "$($Device.manufacturer)".Trim() -match '^(?i)microsoft\b'
}

function Select-BeingsScanner($Devices) {
  $list = @($Devices | Where-Object { $_ -and ($_.deviceId -or $_.name) })
  if ($list.Count -eq 0) {
    return [pscustomobject]@{ ok = $false; sameModel = $false; error = "No scanners were found."; device = $null }
  }
  $keys = @($list | ForEach-Object { Get-BeingsScannerModel $_.name } | Where-Object { $_ } | Select-Object -Unique)
  $sameModel = $keys.Count -le 1
  if ($list.Count -eq 1) {
    return [pscustomobject]@{ ok = $true; sameModel = $sameModel; auto = $false; device = $list[0]; error = $null }
  }
  $own = @($list | Where-Object { -not (Test-BeingsMicrosoftDriver $_) })
  $pool = $(if ($own.Count -gt 0) { $own } else { $list })
  if ($sameModel) {
    return [pscustomobject]@{ ok = $true; sameModel = $true; auto = $true; device = @($pool)[0]; error = $null }
  }
  $names = ($list | ForEach-Object { if ($_.name) { $_.name } else { $_.deviceId } }) -join "; "
  return [pscustomobject]@{ ok = $false; sameModel = $false; auto = $false; device = $null; error = "Several different scanners were found: $names. Choose the one on this desk." }
}

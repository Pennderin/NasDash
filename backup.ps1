<#
  NasDash backup — copies the live PC-side NasDash files into the recovery kit.

  Runs daily via the "NasDash Backup" scheduled task (created by install.ps1),
  and can be run by hand at any time:  right-click > Run with PowerShell.

  Public code  -> app\, agents\           (tracked in git)
  Private bits -> private\                (NOT in git: layouts, Beszel identity)
#>
param(
  [string]$Kit = '\\192.168.0.190\General Storage\NasDash Recovery'
)
$ErrorActionPreference = 'Stop'
$L = $env:LOCALAPPDATA
if (-not (Test-Path $Kit)) { Write-Warning "Kit folder not reachable: $Kit"; exit 1 }

function Copy-Set($fromDir, $toDir, [string[]]$names) {
  New-Item -ItemType Directory -Force $toDir | Out-Null
  foreach ($n in $names) {
    $src = Join-Path $fromDir $n
    if (Test-Path $src) { Copy-Item $src (Join-Path $toDir $n) -Force }
  }
}

# ── public code ──
Copy-Set "$L\NasDashHomepage" "$Kit\app" @('main.js', 'index.html', 'package.json', 'package-lock.json', 'launch-silent.vbs', 'toggle-desktop.ps1', 'tray-icon.png')
Copy-Set "$L\SteamAgent" "$Kit\agents\steam-agent" @('steam-agent.js', 'run.bat', 'silent.vbs', 'hide-spotify.ps1')

# ── private, machine-specific ──
Copy-Set "$L\NasDashHomepage" "$Kit\private\nasdash-state" @('display-bounds.json', 'opacity.json', 'widget-state.json')
Copy-Set "$L\BeszelAgent\data" "$Kit\private\beszel" @('fingerprint')
Copy-Set "$L\BeszelAgent" "$Kit\private\beszel" @('beszel-agent.exe')
# Beszel connection values (hub key + token): agent.env, or pulled out of an older inline launcher
Copy-Set "$L\BeszelAgent" "$Kit\private\beszel" @('agent.env')
$vbs = "$L\BeszelAgent\silent.vbs"
if (-not (Test-Path "$L\BeszelAgent\agent.env") -and (Test-Path $vbs)) {
  $txt = Get-Content $vbs -Raw
  $vals = @{}
  foreach ($k in 'KEY', 'TOKEN', 'HUB_URL', 'SYSTEM_NAME') {
    $m = [regex]::Match($txt, 'env\("' + $k + '"\)\s*=\s*"([^"]*)"')
    if ($m.Success) { $vals[$k] = $m.Groups[1].Value }
  }
  ($vals.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "`r`n" |
    Set-Content "$Kit\private\beszel\agent.env" -Encoding ascii
}

Set-Content "$Kit\private\LAST-BACKUP.txt" -Encoding ascii -Value ("Last backup from {0}: {1:yyyy-MM-dd HH:mm}" -f $env:COMPUTERNAME, (Get-Date))
Write-Host "NasDash backup complete -> $Kit"

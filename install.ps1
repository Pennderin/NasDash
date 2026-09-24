<#
  NasDash installer — rebuilds the whole PC side of NasDash after a Windows reinstall.

  HOW TO RUN (no AI needed):
    1. Open \\192.168.0.190\General Storage\NasDash Recovery  (or a GitHub download of the repo)
    2. Right-click install.ps1 > "Run with PowerShell"
       (if Windows blocks it: open PowerShell and run
        powershell -ExecutionPolicy Bypass -File ".\install.ps1")
    3. Approve the one admin prompt (firewall rule). Done — NasDash starts on its own.

  WHAT IT DOES
    - Installs Node.js and the Spotify desktop app (winget) if missing
    - Installs NasDash, the Steam agent and the Beszel stats agent into %LOCALAPPDATA%
    - Restores your window layouts and the Beszel identity from the NAS kit (private\)
    - Creates the three startup shortcuts, the daily backup task and the firewall rule
    - Launches everything

  Safe to re-run: it stops the running copies, overwrites code, keeps your layouts.

  TEST SWITCHES
    -Target <dir>   install somewhere other than %LOCALAPPDATA% (for a dry run)
    -SkipPrereqs    don't install Node/Spotify     -NoStartup   no startup shortcuts
    -NoTask         no backup task                 -NoFirewall  no firewall rule
    -NoLaunch       don't start anything at the end
#>
param(
  [string]$Target = $env:LOCALAPPDATA,
  [switch]$SkipPrereqs, [switch]$NoStartup, [switch]$NoTask, [switch]$NoFirewall, [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$Kit = $PSScriptRoot
$Private = Join-Path $Kit 'private'
$NasKit = '\\192.168.0.190\General Storage\NasDash Recovery'
$BeszelVersion = '0.20.0'
$todo = New-Object System.Collections.ArrayList

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   !!  $m" -ForegroundColor Yellow; [void]$todo.Add($m) }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

# The private folder (layouts, Beszel identity) is only on the NAS copy of the kit.
# If running from a GitHub download, borrow it from the NAS when reachable.
if (-not (Test-Path $Private) -and (Test-Path "$NasKit\private")) { $Private = "$NasKit\private" }

Write-Host "NasDash installer" -ForegroundColor White
Write-Host "  kit:    $Kit"
Write-Host "  target: $Target"
Write-Host "  private data: $(if (Test-Path $Private) { $Private } else { 'not found (layouts/Beszel identity will need manual steps)' })"

# ── 1. prerequisites ────────────────────────────────────────────────────────
Step 'Prerequisites'
if (-not $SkipPrereqs) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Warn 'winget not found: install "App Installer" from the Microsoft Store, then re-run.'; exit 1 }
  if (Get-Command node -ErrorAction SilentlyContinue) { Ok "Node.js $(node --version) already installed" }
  else {
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements --silent | Out-Host
    Refresh-Path
    if (Get-Command node -ErrorAction SilentlyContinue) { Ok "Node.js $(node --version) installed" } else { Warn 'Node.js install failed: install it from nodejs.org, then re-run.'; exit 1 }
  }
  if (Get-AppxPackage SpotifyAB.SpotifyMusic -ErrorAction SilentlyContinue) { Ok 'Spotify already installed' }
  else {
    winget install --id 9NCBCSZSJRSB -s msstore --accept-package-agreements --accept-source-agreements | Out-Host
    if (Get-AppxPackage SpotifyAB.SpotifyMusic -ErrorAction SilentlyContinue) { Ok 'Spotify installed' } else { Warn 'Spotify did not install: get "Spotify" from the Microsoft Store.' }
  }
  if (Get-AppxPackage SpotifyAB.SpotifyMusic -ErrorAction SilentlyContinue) {
    [void]$todo.Add('Open Spotify once and sign in (so the PC shows up as a Spotify device), then close it.')
  }
} else { Ok 'skipped (-SkipPrereqs)' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Warn 'Node.js is required.'; exit 1 }

# ── 2. stop running copies (re-install) ─────────────────────────────────────
Step 'Stopping running copies'
if ($Target -eq $env:LOCALAPPDATA) {
  Get-Process | Where-Object { $_.Path -like "*\NasDashHomepage\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'steam-agent\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Get-Process beszel-agent -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 1
}
Ok 'done'

# ── 3. NasDash app ──────────────────────────────────────────────────────────
Step 'NasDash app'
$app = Join-Path $Target 'NasDashHomepage'
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item "$Kit\app\*" $app -Recurse -Force
foreach ($f in 'display-bounds.json', 'opacity.json', 'widget-state.json', 'cam-windows.json', 'coms.json') {
  $src = Join-Path $Private "nasdash-state\$f"
  if ((Test-Path $src) -and -not (Test-Path (Join-Path $app $f))) { Copy-Item $src $app }
}
if (Test-Path (Join-Path $Private 'nasdash-state')) { Ok 'saved layouts/opacity restored' } else { Warn 'No saved layouts found: position NasDash, then use the gear menu > Save layout.' }
Push-Location $app
try {
  Write-Host '   installing Electron (downloads ~100 MB, takes a minute)...'
  if (Test-Path package-lock.json) { & npm ci --no-audit --no-fund 2>&1 | Out-Host } else { & npm install --no-audit --no-fund 2>&1 | Out-Host }
  if ($LASTEXITCODE -ne 0) { throw "npm failed ($LASTEXITCODE)" }
  # Electron 44+ no longer downloads its binary during npm install (it is lazy, on first
  # `npx electron`). NasDash launches dist\electron.exe directly, so fetch it now.
  & node node_modules\electron\install.js 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Electron download failed ($LASTEXITCODE)" }
} finally { Pop-Location }
if (Test-Path "$app\node_modules\electron\dist\electron.exe") { Ok 'Electron installed' } else { Warn 'Electron missing: in the NasDashHomepage folder run "npm install".' }

# ── 4. Steam agent ──────────────────────────────────────────────────────────
Step 'Steam agent'
$sa = Join-Path $Target 'SteamAgent'
New-Item -ItemType Directory -Force $sa | Out-Null
Copy-Item "$Kit\agents\steam-agent\*" $sa -Force
Ok "installed to $sa"

# ── 5. Beszel stats agent ───────────────────────────────────────────────────
Step 'Beszel stats agent (PC tile in the system strip)'
$bz = Join-Path $Target 'BeszelAgent'
New-Item -ItemType Directory -Force "$bz\data" | Out-Null
Copy-Item "$Kit\agents\beszel\silent.vbs" $bz -Force
$exe = Join-Path $bz 'beszel-agent.exe'
if (Test-Path (Join-Path $Private 'beszel\beszel-agent.exe')) { Copy-Item (Join-Path $Private 'beszel\beszel-agent.exe') $exe -Force; Ok 'agent binary restored from NAS kit' }
elseif (-not (Test-Path $exe)) {
  $zip = Join-Path $env:TEMP 'beszel-agent.zip'
  $base = "https://github.com/henrygd/beszel/releases/download/v$BeszelVersion"
  Invoke-WebRequest "$base/beszel-agent_windows_amd64.zip" -OutFile $zip -UseBasicParsing
  $sums = (Invoke-WebRequest "$base/beszel_${BeszelVersion}_checksums.txt" -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $expected = (($sums -split "`n") | Where-Object { $_ -match 'beszel-agent_windows_amd64.zip' }) -replace '\s.*', ''
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($expected -and $expected.Trim() -eq $actual) { Expand-Archive $zip $bz -Force; Remove-Item $zip; Ok "agent v$BeszelVersion downloaded (checksum verified)" }
  else { Remove-Item $zip; Warn 'Beszel download failed its checksum: see docs/TROUBLESHOOTING.md' }
}
if (Test-Path (Join-Path $Private 'beszel\agent.env')) { Copy-Item (Join-Path $Private 'beszel\agent.env') $bz -Force; Ok 'hub connection settings restored' }
else { Warn 'No Beszel agent.env: create it (docs/SECRETS.md > Beszel) or the PC tile shows "agent not connected".' }
if (Test-Path (Join-Path $Private 'beszel\fingerprint')) { Copy-Item (Join-Path $Private 'beszel\fingerprint') "$bz\data\fingerprint" -Force; Ok 'identity restored: reconnects as the same "PC" (history kept)' }
else { Warn 'No Beszel fingerprint: the PC will need re-registering in the hub (docs/SECRETS.md > Beszel).' }

# ── 6. startup shortcuts ────────────────────────────────────────────────────
Step 'Startup shortcuts'
if (-not $NoStartup) {
  $startup = [Environment]::GetFolderPath('Startup')
  $sh = New-Object -ComObject WScript.Shell
  foreach ($s in @(@('NasDash', "$app\launch-silent.vbs"), @('SteamAgent', "$sa\silent.vbs"), @('BeszelAgent', "$bz\silent.vbs"))) {
    $lnk = $sh.CreateShortcut((Join-Path $startup "$($s[0]).lnk"))
    $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"; $lnk.Arguments = "`"$($s[1])`""
    $lnk.WorkingDirectory = Split-Path $s[1]; $lnk.WindowStyle = 7; $lnk.Save()
  }
  Ok 'NasDash, SteamAgent and BeszelAgent start at login'
} else { Ok 'skipped (-NoStartup)' }

# ── 7. no PC-side backup task ────────────────────────────────────────────────
# The PC deliberately runs NO scheduled scripts from the NAS (a script on a
# share is code anyone with NAS access could change). Git is the source of
# truth for rebuilds; remove the old task if an earlier install created it.
Step 'Legacy backup task'
if (Get-ScheduledTask -TaskName 'NasDash Backup' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'NasDash Backup' -Confirm:$false
  Ok 'removed old "NasDash Backup" task (the PC no longer runs scripts from the NAS)'
} else { Ok 'none (good)' }

# ── 8. firewall rule (needs admin once) ─────────────────────────────────────
Step 'Firewall rule for the Steam agent (port 7790)'
if (-not $NoFirewall) {
  if (Get-NetFirewallRule -DisplayName 'Steam Agent LAN' -ErrorAction SilentlyContinue) { Ok 'already present' }
  else {
    $cmd = "New-NetFirewallRule -DisplayName 'Steam Agent LAN' -Direction Inbound -Protocol TCP -LocalPort 7790 -RemoteAddress LocalSubnet -Action Allow"
    try { Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-Command', $cmd; Ok 'added (LAN only)' }
    catch { Warn 'Firewall rule not added (admin prompt declined): only matters for opening the dashboard from other devices. See docs/TROUBLESHOOTING.md.' }
  }
} else { Ok 'skipped (-NoFirewall)' }

# ── 9. launch ───────────────────────────────────────────────────────────────
Step 'Starting NasDash'
if (-not $NoLaunch) {
  & wscript.exe "$sa\silent.vbs"; & wscript.exe "$bz\silent.vbs"; Start-Sleep 2; & wscript.exe "$app\launch-silent.vbs"
  Start-Sleep 6
  try { if ((Invoke-RestMethod http://127.0.0.1:7790/health -TimeoutSec 5).ok) { Ok 'Steam agent answering on :7790' } } catch { Warn 'Steam agent not answering: run it by hand (docs/TROUBLESHOOTING.md).' }
  if (Get-Process beszel-agent -ErrorAction SilentlyContinue) { Ok 'Beszel agent running' } else { Warn 'Beszel agent not running.' }
  if (Get-Process | Where-Object { $_.Path -like "*\NasDashHomepage\*" }) { Ok 'NasDash window started' } else { Warn 'NasDash did not start: double-click launch-silent.vbs in the NasDashHomepage folder.' }
} else { Ok 'skipped (-NoLaunch)' }

Write-Host "`nNasDash install finished." -ForegroundColor White
if ($todo.Count) { Write-Host "`nStill to do by hand:" -ForegroundColor Yellow; $i = 1; foreach ($t in $todo) { Write-Host "  $i. $t"; $i++ } }
Write-Host "`nEverything else (NAS side, keys, troubleshooting) is in README.md and docs\."
if ($Host.Name -eq 'ConsoleHost' -and -not $env:NASDASH_NONINTERACTIVE) { Read-Host "`nPress Enter to close" | Out-Null }

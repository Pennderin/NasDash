# Troubleshooting

Each card gets its data from one place. When something is blank, check that place.

| Symptom | Check |
|---|---|
| NasDash window doesn't appear at login | Double-click `%LOCALAPPDATA%\NasDashHomepage\launch-silent.vbs`. If nothing happens, Electron is missing: in that folder run `npm install` then `node node_modules\electron\install.js`. |
| NasDash shows an error page | Homepage is down: open http://192.168.0.190:3000 in a browser. On the NAS: `docker start homepage`. NasDash retries by itself for 30 s at startup. |
| A card looks old / changes don't show | Click NasDash's ↻ (it bypasses the cache). |
| System strip says "Stats unavailable" | Beszel hub: http://192.168.0.190:8093. A single tile says "agent not connected": that machine's agent isn't running (PC: double-click `%LOCALAPPDATA%\BeszelAgent\silent.vbs`). |
| Audiobookshelf / Spotify / Home cards blank | media-bridge: http://192.168.0.190:7792/health should say `"ok":true`. On the NAS: `docker logs media-bridge`. |
| Spotify card says **Reconnect Spotify** | Normal every 6 months. Click it and approve (NasDash must be running). |
| Spotify won't play | Play only ever targets this PC. If Spotify isn't running, the card starts it hidden via the Steam agent. Check the Steam agent is up (next row) and Spotify is installed and signed in. |
| Steam card says "PC offline" | Steam agent: http://127.0.0.1:7790/health. Start it: double-click `%LOCALAPPDATA%\SteamAgent\silent.vbs`. |
| Steam art missing | Art comes from Steam's local cache; open the game once in Steam and it appears. |
| Home controls say "Unreachable" | Home Assistant on JARVIS (http://192.168.0.26:8123) or its token (docs/SECRETS.md). |
| Friends pill shows just "Friends" | `STEAM_API_KEY` missing in `bridge.env`, or Steam's API is down. |
| Layout squeezed after zoom | Ctrl+scroll to zoom, then ⚙ → **Save layout** (per display). |
| The page has a scrollbar | Zoom out a notch (Ctrl+scroll) and Save layout. |

## Running pieces by hand
```powershell
# Steam agent (shows errors in the console)
node "$env:LOCALAPPDATA\SteamAgent\steam-agent.js"
# Beszel agent
& "$env:LOCALAPPDATA\BeszelAgent\beszel-agent.exe" --help
# NasDash with a visible console
cd "$env:LOCALAPPDATA\NasDashHomepage"; .\node_modules\electron\dist\electron.exe .
```

## Things that bit us before
- **Electron 44 doesn't download itself on `npm install`.** `install.ps1` runs
  `node node_modules\electron\install.js` explicitly; do the same if you ever reinstall by hand.
- **The Microsoft Store Spotify** is launched through its app alias
  `%LOCALAPPDATA%\Microsoft\WindowsApps\Spotify.exe`. Node's `existsSync` can't see
  that alias (it's a reparse point), so the agent checks it with `lstat`.
- **Hiding Spotify's window** must be done from a *non-detached* PowerShell; a
  detached one can't see the window. Spotify also re-shows its window as it
  finishes loading, so `hide-spotify.ps1` keeps re-hiding it for 12 seconds.
- **Homepage caches `custom.js`/`custom.css`** without cache headers. NasDash
  forces revalidation; in a normal browser use Ctrl+F5 after editing them.
- **Beszel uses port 8093**, not its default 8090 (SABnzbd).
- **Winget IDs**: Node.js `OpenJS.NodeJS.LTS`; Spotify (Store build) `9NCBCSZSJRSB`.

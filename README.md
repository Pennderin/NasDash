# NasDash

A desktop dashboard for a home Unraid server. NasDash is a small Electron
window that sits on the Windows desktop and shows a heavily customised
[Homepage](https://gethomepage.dev) dashboard running on the NAS, themed as a
monospace "terminal steel" console with live system stats, media players and
home controls.

> **This is the recovery kit.** Everything needed to rebuild NasDash after a
> Windows reinstall is in this repo plus the NAS copy. The installer does
> almost all of it; the rest is written down here. No AI required.

---

## After reinstalling Windows (about 10 minutes)

1. **Sign in to Windows** as normal and make sure the PC is on the home network.
2. **Open the kit** in File Explorer:
   `\\192.168.0.190\General Storage\NasDash Recovery`
   (No NAS? Download this repo from GitHub: *Code → Download ZIP*, and extract it.)
3. **Right-click `install.ps1` → Run with PowerShell.**
   If Windows refuses to run it, open PowerShell in that folder and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
4. **Approve the admin prompt** when it appears (it only adds one firewall rule).
5. **Do the short "still to do" list** the installer prints at the end, usually just:
   - Open **Spotify** once, sign in, then close it.

That's it. NasDash starts by itself and will start at every login from now on.

### What the installer does
| Step | Detail |
|---|---|
| Prerequisites | Installs **Node.js LTS** and the **Spotify** desktop app (Microsoft Store build) via `winget` if missing |
| NasDash app | Copies `app/` to `%LOCALAPPDATA%\NasDashHomepage`, installs Electron, restores your saved window layouts/opacity |
| Steam agent | Copies `agents/steam-agent/` to `%LOCALAPPDATA%\SteamAgent` |
| Beszel agent | Installs the PC stats agent to `%LOCALAPPDATA%\BeszelAgent` and restores its identity so it reconnects as the same "PC" (history kept) |
| Startup | Creates `NasDash`, `SteamAgent` and `BeszelAgent` shortcuts in the Startup folder |
| Backups | Creates the **NasDash Backup** scheduled task (daily, 3:15 AM) |
| Firewall | Adds **Steam Agent LAN** (TCP 7790, local subnet only) |
| Launch | Starts everything and checks each piece is answering |

It is safe to run again at any time: it stops the running copies, replaces the
code and keeps your saved layouts.

---

## How NasDash is put together

```
 PC (Windows)                                   NAS (Unraid, 192.168.0.190)
 ─────────────                                  ───────────────────────────
 NasDash window (Electron) ── shows ──────────▶ Homepage          :3000  theme + add-ons in custom.css / custom.js
   └ Spotify login catcher 127.0.0.1:8888          │
 Steam agent (Node)        :7790 ◀── page ─────────┤  (Steam card, game art, launches games, starts Spotify hidden)
 Beszel agent ──────────── stats ──────────────▶ Beszel hub       :8093  (PC / NAS / JARVIS system strip)
 Spotify desktop app  ◀── Spotify Connect ──────  media-bridge     :7792  (Audiobookshelf, Spotify, Home Assistant,
                                                                          Beszel, Steam friends — holds all API keys)
```

| Part | Lives in | In this repo |
|---|---|---|
| NasDash window | PC `%LOCALAPPDATA%\NasDashHomepage` | `app/` |
| Steam agent | PC `%LOCALAPPDATA%\SteamAgent` | `agents/steam-agent/` |
| Beszel PC agent | PC `%LOCALAPPDATA%\BeszelAgent` | `agents/beszel/` |
| Homepage theme, cards, config | NAS `/mnt/user/system/docker/homepage` | `homepage/` (keys redacted) |
| media-bridge | NAS `/mnt/user/appdata/media-bridge` | `media-bridge/` |
| Beszel hub + NAS agent | NAS containers | `nas-containers.sh` |
| JARVIS stats agent | JARVIS `~/beszel-agent` | `agents/beszel/jarvis-run.sh` |

### The dashboard, top to bottom
- **System strip**: PC / NAS / JARVIS tiles with CPU, RAM and GPU rings, per-GPU bars, a 1-hour CPU sparkline (Beszel).
- **Speed** (WAN vs VPN) and **Home** (Home Assistant: lights, bedroom temp, AC, alarm, with a Controls panel).
- **Audiobookshelf**: built-in player with book switcher, volume, speed, chapters.
- **Spotify**: now playing, controls, volume, and a Recent / Playlists / Artists / Up next browser. Plays on the PC only; starts Spotify hidden if it isn't running.
- **Plex**, **SABnzbd**, **Steam** (last game, recently played, searchable library popout, friends online), the *arr apps, and tools.

---

## Keeping the kit up to date

Two backups run automatically, so the kit always matches what is running:

| Backup | Runs | Copies |
|---|---|---|
| `backup.ps1` (PC task "NasDash Backup") | daily 3:15 AM | NasDash app, Steam agent → `app/`, `agents/`; layouts + Beszel identity → `private/` |
| `nas-backup.sh` (NAS cron) | daily 3:30 AM | Homepage theme/config, media-bridge → `homepage/`, `media-bridge/`, **with every key redacted** |

To publish the latest version to GitHub, commit and push the kit folder
(everything except `private/`, which is git-ignored). `nas-backup.sh` refuses
to finish if anything that looks like a key slipped through.

### `private/` (NAS only, never in git)
Machine-specific things the installer restores automatically when the NAS is reachable:
- `nasdash-state/`: saved window positions, zoom and opacity per display
- `beszel/`: the PC agent's identity (`fingerprint`), hub connection (`agent.env`) and the agent binary

---

## More documentation
- **[docs/SECRETS.md](docs/SECRETS.md)**: every key and token, where it lives and how to regenerate it
- **[docs/NAS-REBUILD.md](docs/NAS-REBUILD.md)**: rebuilding the NAS side (containers, config, cron)
- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**: when a card is blank or something won't start

## Older version
The original standalone NasDash widget (v1: Plex now-playing, pipeline and
drag-to-reorder cards) is preserved at the git tag **`v1-legacy`**.

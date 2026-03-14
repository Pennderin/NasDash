# NasDash

A sleek, always-on-top desktop widget for monitoring your Unraid NAS at a glance.

![Electron](https://img.shields.io/badge/Electron-36-blue) ![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey)

## Features

- **Speed Test** — Ookla-powered, runs every 6 hours, cached between restarts
- **Now Playing** — Live Plex stream monitoring with progress bars
- **Pipeline** — Media Manager job status (transfers, renames, queued)
- **Services** — Health-check grid for all NAS Docker containers, click to open web UI
  - Add/remove services with `+` / `−` buttons
  - Reorder with `↕` drag-and-drop
- **Recently Added** — Latest media from Plex libraries
- **Library Stats** — Total movies, shows, and combined count
- **NAS Storage** — Disk usage bar

## Widget Controls

| Button | Function |
|--------|----------|
| 🔓 | Lock/unlock — prevents accidental moving or resizing |
| — | Collapse to just the header bar |
| ✕ | Close (still in system tray) |

- **Drag header** to move the widget
- **Drag edges** to resize (horizontal + vertical)
- **Drag card handles** (thin bars between sections) to redistribute vertical space between cards
- **Tray icon** — click to show/hide, right-click for menu

## Persistence

Everything survives restarts:
- Window position & size
- Card height ratios
- Lock state
- Service selection & order
- Speed test results

## Setup

### Quick Start (Development)
1. Clone the repo
2. Drop `speedtest.exe` from [Ookla Speedtest CLI](https://www.speedtest.net/apps/cli) into the project root
3. Edit the NAS IP and Plex token in `index.html`
4. `npm install && npm start`

### Portable Build
```bash
npm run build
```
Produces `Unraid-NAS-Widget.exe` in `dist/`.

### Auto-Start with Windows
The included `launch-silent.vbs` runs the widget without a visible console window. Create a shortcut to it in your Startup folder:
```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
```

## Configuration

Edit these values near the top of `index.html`:
- `NAS_IP` — your Unraid server IP
- `PLEX_TOKEN` — your Plex authentication token
- `ALL_SERVICES` — master list of NAS services with ports and URLs

## Tech

- Electron (frameless, transparent window)
- Node.js `http` module for direct API calls (no browser dependencies)
- Plex XML API for streams, library, recently added
- Media Manager REST API for pipeline status
- Ookla Speedtest CLI for speed tests
- Custom IPC-based resize (transparent windows don't support native resize on Windows)

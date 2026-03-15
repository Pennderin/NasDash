# NasDash

A sleek, always-on-bottom desktop widget for monitoring your Unraid NAS, Plex, media pipeline, and Steam library at a glance. Styled to match Steam's dark UI so it blends seamlessly with your desktop.

![NasDash](https://img.shields.io/badge/platform-Windows-blue) ![Electron](https://img.shields.io/badge/electron-powered-47848F)

## Features

- **Speed Test** — Ookla CLI speed test, runs every 6 hours with cached results
- **Now Playing** — Live Plex streams with username, progress bar, S01E12 format for shows
- **Pipeline** — Media Manager job status, polls every 3 seconds
- **Services** — Health-check grid for all your NAS services, clickable to open web UI
- **Recently Added** — Latest Plex media with FILM/SHOW/SSN/EP badges
- **Library + Storage** — Plex library counts and NAS storage bar
- **Steam** — Click header to open library, S/TV/Friends buttons, recent games, full game drawer overlay
- **Desktop Icons Toggle** — Hide/show desktop icons with one click
- **Card Reordering** — Drag cards to rearrange, saved across restarts
- **Per-Card Font Scaling** — Independent Title (T) and Body (B) zoom per card
- **Multi-Monitor Memory** — Remembers position and font scales per display configuration
- **Auto-Start** — Launches silently on Windows startup with no terminal flash

---

## Fresh Install Guide

### Prerequisites

- **Windows 10/11**
- **Node.js 18+** — Download from [nodejs.org](https://nodejs.org)
- **Git** (optional) — or just download the ZIP from GitHub

### Step 1: Download

```bash
git clone https://github.com/Pennderin/NasDash.git
```

Or click **Code → Download ZIP** on GitHub and extract it to a permanent location like:
```
C:\Users\YourName\AppData\Local\NasDash
```

> **Important:** This folder IS the install — pick a permanent spot.

### Step 2: Install Dependencies

Open a terminal in the NasDash folder and run:

```bash
npm install
```

### Step 3: Configure Your Network

Open **`index.html`** in any text editor (Notepad works fine) and search for this line:

```javascript
const NAS_IP='192.168.0.190', PLEX_TOKEN='LAKWMV_Mz2oFF4w5yBWf', MM_PORT=9876, PLEX_PORT=32400, REFRESH_MS=30000;
```

Change these values to match YOUR setup:

| Setting | What it is | How to find it |
|---------|-----------|----------------|
| `NAS_IP` | Your Unraid server's local IP address | Unraid WebUI → Settings → Network Settings |
| `PLEX_TOKEN` | Your Plex authentication token | See [Finding your Plex Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/) |
| `MM_PORT` | Media Manager port (if you use it) | Default `9876`. If you don't run Media Manager, the Pipeline card will just say "unreachable" — harmless |
| `PLEX_PORT` | Your Plex server port | Almost always `32400` — probably don't change this |
| `REFRESH_MS` | Data refresh interval in milliseconds | Default `30000` (30 seconds) |

### Step 4: Configure Services

In the same **`index.html`**, find the `ALL_SERVICES` array. This is your catalog of NAS services:

```javascript
const ALL_SERVICES=[
  {name:'Plex', port:32400, url:'http://YOUR_NAS_IP:32400/web'},
  {name:'Sonarr', port:8989, url:'http://YOUR_NAS_IP:8989'},
  // add your own...
];
```

For each service, set:
- **`name`** — What to display
- **`port`** — Port number (used for health check — green dot = up, red = down)
- **`url`** — Full URL to open when you click it

Replace all IP addresses with your NAS IP.

Then update `DEFAULT_SVC` to choose which services appear by default:

```javascript
const DEFAULT_SVC=['Plex','Sonarr','Radarr']; // names must match ALL_SERVICES entries
```

You can always add/remove services later from within the widget using the + and − buttons.

### Step 5: Configure Steam Libraries

Find the `STEAM_LIBS` line:

```javascript
const STEAM_LIBS=['C:\\Program Files (x86)\\Steam\\steamapps','D:\\SteamLibrary\\steamapps'];
```

Update these paths to where YOUR Steam games are installed. To find them: open Steam → Settings → Storage. List every library folder path here.

### Step 6: Update Storage Display

The NAS storage bar is static. Search for this section and update the numbers to match your array:

```html
<div class="storage-bar-fill" style="width:51%"></div>
<div class="storage-bar-label">51% Used</div>
```
```html
<span>11.1 TB used</span><span>10.7 TB free</span><span>21.8 TB total</span>
```

### Step 7: Speed Test (Optional)

Download `speedtest.exe` from [speedtest.net/apps/cli](https://www.speedtest.net/apps/cli) and place it in the NasDash folder. Without it, the Speed Test card shows "Failed" but everything else works fine.

### Step 8: Test It

```bash
npx electron .
```

The widget should appear on the right edge of your primary monitor. If your NAS IP and Plex token are correct, you'll see live data within seconds.

### Step 9: Auto-Start on Boot

To have NasDash launch silently every time Windows starts:

1. **Edit `launch-silent.vbs`** — open it in Notepad and update the path on line 2:
   ```vbs
   WshShell.CurrentDirectory = "C:\Users\YourName\AppData\Local\NasDash"
   ```
   Make this match wherever you put the NasDash folder.

2. **Create a startup shortcut:**
   - Press **Win+R**, type `shell:startup`, press **Enter**
   - Right-click in the folder → **New → Shortcut**
   - For the target, browse to your `launch-silent.vbs` file
   - Name it **NasDash**

That's it. On next reboot, NasDash will start silently with no terminal flash.

> **Tip:** You can also just double-click **START.bat** anytime to launch manually.

---

## Widget Controls

| Button | Where | What it does |
|--------|-------|-------------|
| **—** | Left of clock | Collapse widget to header-only bar |
| **📁** | Right of clock | Toggle desktop icons visible/hidden |
| **⚙** | Gear icon | Opens settings dropdown (Lock, Font Size, Reorder) |
| **✕** | Far right | Close window (widget stays in system tray) |

### Settings Menu (⚙)

- **Lock** — Prevents accidental moving/resizing
- **Font Size** — Shows T/B controls on each card. **T** scales section titles, **B** scales body content. Independent per card.
- **Reorder** — Enables drag-to-reorder on all cards

### Steam Card

- **Click "Steam" text** → Opens Steam library in large mode
- **👥** → Opens Steam Friends list
- **S** → Opens Steam in Small Mode
- **📺** → Opens Big Picture Mode
- **Click any game** → Launches it
- **▼ All Games** → Full-widget scrollable game drawer overlay

---

## File Structure

```
NasDash/
├── main.js              # Electron main process
├── index.html           # All UI, styling, and logic
├── package.json         # Dependencies and config
├── tray-icon.png        # System tray icon (ND)
├── toggle-desktop.ps1   # Desktop icons toggle script
├── launch-silent.vbs    # Silent startup launcher
├── START.bat            # Manual launcher (double-click)
├── speedtest.exe        # Ookla speed test CLI (download separately)
└── README.md
```

### Auto-Generated State Files

Created on first run in the NasDash folder. Safe to delete to reset settings.

| File | Stores |
|------|--------|
| `display-bounds.json` | Window position per monitor setup |
| `card-order.json` | Card arrangement |
| `card-ratios.json` | Vertical card sizing ratios |
| `font-scales.json` | T/B font scales per monitor setup |
| `services-config.json` | Active services and order |
| `speedtest-results.json` | Cached speed test data |
| `widget-state.json` | Lock on/off |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| No data showing | Verify `NAS_IP` and `PLEX_TOKEN` in `index.html`. Test by visiting `http://YOUR_IP:32400/web` in a browser. |
| Speed Test says "Failed" | Download `speedtest.exe` from [Ookla](https://www.speedtest.net/apps/cli) and put it in the NasDash folder. |
| Services show red dots | That service is unreachable — check it's running and the port is correct in `ALL_SERVICES`. |
| No Steam games | Update `STEAM_LIBS` paths to match your Steam library folders. |
| Wrong monitor | Drag the widget to the right monitor. Position saves automatically. Delete `display-bounds.json` to reset. |
| Terminal flashes on boot | Use `launch-silent.vbs` for the startup shortcut, not `START.bat`. |

---

## License

MIT

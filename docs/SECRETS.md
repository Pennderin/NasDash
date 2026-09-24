# Secrets: where every key lives and how to get a new one

Nothing in this repo contains a real key. They live in exactly three places on
the NAS (plus one small file on the PC), none of which are published:

| File (on the NAS unless noted) | Holds |
|---|---|
| `/mnt/user/appdata/media-bridge-data/bridge.env` | Audiobookshelf, Spotify, Home Assistant, Beszel and Steam keys for the media-bridge |
| `/mnt/user/system/docker/homepage/services.yaml` | API keys for the Homepage cards (Plex, *arr apps, SABnzbd, ...) |
| `/mnt/user/appdata/beszel/` | hub data + admin password (`.admin-password`), NAS agent `agent.env` |
| PC: `%LOCALAPPDATA%\BeszelAgent\agent.env` | PC agent hub key + token (backed up to the kit's `private/`) |

`bridge.env` is one `NAME=value` per line; the list of names is in
`media-bridge/bridge.env.example`. After changing it, recreate the container:
`bash nas-containers.sh media-bridge`.

---

## media-bridge (`bridge.env`)

| Name | Value |
|---|---|
| `PORT` | `7792` |
| `DATA_DIR` | `/data` |
| `ALLOW_ORIGINS` | `http://192.168.0.190:3000` |
| `ABS_URL` | `http://192.168.0.190:13378` |
| `ABS_KEY` | Audiobookshelf API key (below) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | from the Spotify developer app (below) |
| `SPOTIFY_REDIRECT` | `http://127.0.0.1:8888/callback` |
| `HA_URL` | `http://192.168.0.26:8123` |
| `HA_TOKEN` | Home Assistant long-lived token (below) |
| `BESZEL_URL` | `http://192.168.0.190:8093` |
| `BESZEL_EMAIL` / `BESZEL_PASSWORD` | Beszel hub login (below) |
| `STEAM_API_KEY` | Steam Web API key (below) |
| `PLEX_URL` | `http://192.168.0.190:32400` |
| `PLEX_TOKEN` | a Plex token (same as the Plex card key in `services.yaml`) |
| `SAB_URL` / `SAB_KEY` | `http://192.168.0.190:8090` / SABnzbd API key (Config → General) |
| `GO2RTC_URL` | `http://go2rtc:1984` |

### Audiobookshelf: `ABS_KEY`
Audiobookshelf → **Settings → API Keys → Add** (name it `homepage`). The same
key goes in `services.yaml` under the Audiobookshelf card's `key:`.

### Spotify: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
1. https://developer.spotify.com/dashboard → your app **NasDash** (or *Create app*).
2. Redirect URI must be exactly `http://127.0.0.1:8888/callback` (Spotify no longer accepts `localhost`). APIs: *Web API*.
3. Copy the Client ID and Client secret into `bridge.env`.
4. On the dashboard's Spotify card click **Connect Spotify** and approve. The login is
   saved in `/mnt/user/appdata/media-bridge-data/spotify.json`.
5. **Spotify expires the login every 6 months**: the card shows **Reconnect Spotify**; click it, approve, done.
   (The login page opens in your browser and returns to NasDash's catcher on `127.0.0.1:8888`, so NasDash must be running.)

### Home Assistant: `HA_TOKEN`
http://192.168.0.26:8123/profile/security → **Long-lived access tokens → Create token**
(name `NasDash`). It is shown once. The bridge only uses it for the lights, fans,
AC and alarm status listed in `media-bridge/server.js` (the `HA` allow-list).

### Plex: `PLEX_TOKEN`
Used for the Plex card's *who's watching* list (hover/click **Active Streams**). Same token as the Plex card's `key:`; see *Homepage card keys* below for how to find it.

### Steam: `STEAM_API_KEY`
https://steamcommunity.com/dev/apikey (domain: anything, e.g. `nasdash`). Used only
for the "friends online" count. The Steam account ID is derived from your local
Steam files; set `STEAM_ID` in `bridge.env` only if it ever changes.

### Beszel hub login: `BESZEL_EMAIL`, `BESZEL_PASSWORD`
Login `anthony@nasdash.local`; the password is in `/mnt/user/appdata/beszel/.admin-password`.
On a brand-new hub, start it once with `-e USER_EMAIL=... -e USER_PASSWORD=...`
(see `docs/NAS-REBUILD.md`) to create the account.

---

## Ring cameras (Security card)

- **ring-mqtt** (on JARVIS, `~/jarvis/ring-mqtt/config.json`) must have `"enable_cameras": true`
  and a **`livestream_user` / `livestream_pass`**. Without a password its stream server
  (port 8554 on JARVIS) would serve the cameras to anyone on the network.
- **go2rtc** (NAS, `/mnt/user/appdata/go2rtc/go2rtc.yaml`, root-only) holds the same
  credentials in each camera's stream URL:
  `rtsp://<user>:<pass>@192.168.0.26:8554/<camera-id>_live`. Camera ids are in the
  ring-mqtt log (`docker logs ring-mqtt | grep stream_Source`).
- **media-bridge** reaches go2rtc at `GO2RTC_URL=http://go2rtc:1984` over the private
  `nasdash` Docker network; go2rtc publishes no ports.
- Changing the stream password: update ring-mqtt's config (restart it), then the three URLs
  in go2rtc.yaml (`bash nas-containers.sh go2rtc`).

## Beszel agents (`KEY` + `TOKEN`)

Each agent needs the hub's public **KEY** and a **TOKEN**. An agent that already
registered also keeps a `fingerprint` file; with the same fingerprint + token it
reconnects as the same system with its history.

- **Where to find them:** Beszel (http://192.168.0.190:8093) → **Settings → Tokens & Fingerprints**
  shows the hub key and each system's token. **Add System** also shows a ready-made command.
- **PC:** `%LOCALAPPDATA%\BeszelAgent\agent.env` with lines `KEY=...`, `TOKEN=...`,
  `HUB_URL=http://192.168.0.190:8093`, `SYSTEM_NAME=PC`. The installer restores it from the kit.
- **NAS:** `/mnt/user/appdata/beszel/agent.env` (`KEY=`, `TOKEN=`), used by `nas-containers.sh beszel-agent`.
- **JARVIS:** `~/beszel-agent/run.sh` on JARVIS (template: `agents/beszel/jarvis-run.sh`),
  started from the user crontab: `@reboot $HOME/beszel-agent/run.sh >/dev/null 2>&1`.

**Registering a machine from scratch** (lost fingerprint): in the hub go to
Settings → Tokens & Fingerprints, enable a **temporary universal token**, put it in
that machine's `TOKEN=`, start the agent (it appears as a new system), then disable
the universal token again. Delete the old, now-offline system entry if you like.

---

## Homepage card keys (`services.yaml`)

The copy in this repo shows `<REDACTED — see docs/SECRETS.md>` in place of each
card's `key:`. Each key comes from that app's own settings:

| Card | Where to find the key |
|---|---|
| Plex | a Plex token (Plex Web → any item → *Get Info → View XML*, `X-Plex-Token` in the URL) |
| Audiobookshelf | Settings → API Keys (same as `ABS_KEY`) |
| Seerr | Settings → General → API Key |
| Radarr / Sonarr / Prowlarr | Settings → General → API Key |
| Bazarr | Settings → General → Security → API Key |
| SABnzbd | Config → General → API Key |

## GitHub
The GitHub token (PAT) is **never stored** anywhere, not in files, scripts or
git remotes. Create one when you need to push, use it inline, and let it expire.

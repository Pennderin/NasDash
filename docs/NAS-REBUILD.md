# Rebuilding the NAS side

You only need this if the **NAS** (not the PC) loses its Docker containers or
appdata. For a PC reinstall, see the README: the NAS side is untouched by that.

Everything below runs in the Unraid web terminal (top-right `>_` icon) as root.

## 0. Get the kit onto the NAS
If `/mnt/user/General Storage/NasDash Recovery` survived, use it. Otherwise:
```bash
cd "/mnt/user/General Storage" && git clone https://github.com/Pennderin/NasDash.git "NasDash Recovery"
```
(Unraid has no git by default: download the ZIP from GitHub on a PC and copy it into that share instead.)

## 1. Homepage (the dashboard itself)
Homepage's config folder is `/mnt/user/system/docker/homepage`.
1. Copy the kit's `homepage/` files into it:
   `custom.css`, `custom.js`, `settings.yaml`, `widgets.yaml`, `docker.yaml`, `bookmarks.yaml`, `services.yaml`.
2. In `services.yaml`, replace every `<REDACTED ...>` with the real key (docs/SECRETS.md → *Homepage card keys*).
3. In `widgets.yaml`, put your coordinates back in the weather widget (`latitude`/`longitude`).
4. `bash nas-containers.sh homepage`

## 2. media-bridge
1. `mkdir -p /mnt/user/appdata/media-bridge /mnt/user/appdata/media-bridge-data`
2. `cp media-bridge/server.js /mnt/user/appdata/media-bridge/`
3. Create `/mnt/user/appdata/media-bridge-data/bridge.env` from `media-bridge/bridge.env.example`,
   filling in each value (docs/SECRETS.md), then `chmod 600` it.
4. `bash nas-containers.sh media-bridge`
5. On the dashboard: Spotify card → **Connect Spotify** (one-time login).

## 2b. Security cameras (go2rtc)
1. On JARVIS, in ring-mqtt's `config.json`: `"enable_cameras": true` plus a stream
   username/password (docs/SECRETS.md > Ring cameras); restart ring-mqtt.
2. Create `/mnt/user/appdata/go2rtc/go2rtc.yaml` (`chmod 600`) with one stream per camera
   (`front_door`, `living_room`, `garage`) pointing at ring-mqtt, then
   `bash nas-containers.sh go2rtc` and `bash nas-containers.sh media-bridge`.
3. The camera names/ids the dashboard expects are listed in `media-bridge/server.js` (`CAMS`).

## 3. Beszel (system stats strip)
**If `/mnt/user/appdata/beszel/hub` survived**: `bash nas-containers.sh beszel-hub` and you're done;
users, systems and history are all in that folder.

**Brand-new hub:**
```bash
mkdir -p /mnt/user/appdata/beszel/hub
PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20); echo "$PW" > /mnt/user/appdata/beszel/.admin-password; chmod 600 /mnt/user/appdata/beszel/.admin-password
docker run -d --name beszel --restart unless-stopped -p 8093:8090 \
  -v /mnt/user/appdata/beszel/hub:/beszel_data -e APP_URL=http://192.168.0.190:8093 \
  -e USER_EMAIL=anthony@nasdash.local -e USER_PASSWORD="$PW" henrygd/beszel:latest
```
Then register the three machines (docs/SECRETS.md → *Registering a machine from scratch*),
put `BESZEL_EMAIL`/`BESZEL_PASSWORD` in `bridge.env`, and recreate the media-bridge.
The system names must be exactly **PC**, **NAS** and **JARVIS** (the dashboard looks them up by name).

**NAS agent:** create `/mnt/user/appdata/beszel/agent.env` (`KEY=`, `TOKEN=`), then
`bash nas-containers.sh beszel-agent`.

## 4. Nightly kit backup (cron)
Unraid rebuilds cron from the USB stick, so add the schedule there:
```bash
cat > /boot/config/plugins/dynamix/nasdash-backup.cron <<'EOF'
# NasDash recovery kit: refresh redacted Homepage/bridge copies nightly
30 3 * * * /bin/bash "/mnt/user/General Storage/NasDash Recovery/nas-backup.sh" >/dev/null 2>&1
EOF
update_cron
```

## Ports at a glance
| Port | Service |
|---|---|
| 3000 | Homepage (the dashboard) |
| 7792 | media-bridge |
| 8093 | Beszel hub (8090 is taken by SABnzbd) |
| 7790 | Steam agent (on the PC) |
| 8888 | NasDash Spotify login catcher (PC, loopback only) |

## Other pieces the dashboard reads (not part of this repo)
- **Speed card**: `speedtest-aggregator` container, port 7791 (WAN + VPN speedtest-tracker instances).
- **Plex / *arr / SABnzbd / Seerr / Prowlarr / Hunterr / Homebridge / Open WebUI** cards: standard Homepage widgets pointing at those apps.

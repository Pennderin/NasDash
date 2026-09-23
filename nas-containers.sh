#!/bin/bash
# Recreate the NAS-side NasDash containers. Run on the Unraid host (terminal or
# User Scripts). Each block is safe to re-run: it removes and recreates only
# its own container. Settings/secrets are read from appdata, never from here.
# See docs/NAS-REBUILD.md for first-time setup (where the settings files come from).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAS=192.168.0.190

homepage() {
  # Dashboard. Config (services.yaml etc. + custom.css/js) lives in the bind mount.
  docker rm -f homepage 2>/dev/null || true
  docker run -d --name homepage --restart unless-stopped -p 3000:3000 \
    -v /mnt/user/system/docker/homepage:/app/config \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v /mnt/user:/mnt/host:ro \
    -e PUID=0 -e PGID=0 -e TZ=America/Los_Angeles \
    -e HOMEPAGE_ALLOWED_HOSTS=$NAS:3000 \
    ghcr.io/gethomepage/homepage:latest
}

media_bridge() {
  # API proxy for ABS / Spotify / Home Assistant / Beszel / Steam friends.
  # Code: /mnt/user/appdata/media-bridge/server.js (copy from media-bridge/ in this kit)
  # Settings: /mnt/user/appdata/media-bridge-data/bridge.env (template: bridge.env.example)
  local ENVF=/mnt/user/appdata/media-bridge-data/bridge.env
  [ -f "$ENVF" ] || { echo "Missing $ENVF - create it from media-bridge/bridge.env.example (docs/SECRETS.md)"; return 1; }
  mkdir -p /mnt/user/appdata/media-bridge
  [ -f /mnt/user/appdata/media-bridge/server.js ] || cp "$HERE/media-bridge/server.js" /mnt/user/appdata/media-bridge/
  docker rm -f media-bridge 2>/dev/null || true
  docker run -d --name media-bridge --restart unless-stopped -p 7792:7792 \
    -v /mnt/user/appdata/media-bridge:/app:ro \
    -v /mnt/user/appdata/media-bridge-data:/data \
    -w /app --env-file "$ENVF" node:20-alpine node server.js
}

beszel_hub() {
  # Stats hub. Port 8093 on the host (8090 is SABnzbd). Data + users in appdata.
  docker rm -f beszel 2>/dev/null || true
  docker run -d --name beszel --restart unless-stopped -p 8093:8090 \
    -v /mnt/user/appdata/beszel/hub:/beszel_data \
    -e APP_URL=http://$NAS:8093 \
    henrygd/beszel:latest
}

beszel_agent() {
  # NAS stats agent (Nvidia build for the Tesla P4). Identity: appdata/beszel/agent.
  # KEY/TOKEN: /mnt/user/appdata/beszel/agent.env  (KEY=... TOKEN=...; docs/SECRETS.md)
  local ENVF=/mnt/user/appdata/beszel/agent.env
  [ -f "$ENVF" ] || { echo "Missing $ENVF (KEY=, TOKEN=) - see docs/SECRETS.md"; return 1; }
  docker rm -f beszel-agent 2>/dev/null || true
  docker run -d --name beszel-agent --restart unless-stopped --network host --runtime nvidia \
    -e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=utility \
    -v /mnt/user/appdata/beszel/agent:/var/lib/beszel-agent \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    -v /mnt/user:/extra-filesystems/array:ro \
    --env-file "$ENVF" -e LISTEN=45876 -e HUB_URL=http://$NAS:8093 -e SYSTEM_NAME=NAS \
    henrygd/beszel-agent-nvidia:latest
}

case "${1:-all}" in
  homepage) homepage ;; media-bridge) media_bridge ;; beszel-hub) beszel_hub ;; beszel-agent) beszel_agent ;;
  all) homepage; media_bridge; beszel_hub; beszel_agent ;;
  *) echo "usage: $0 [all|homepage|media-bridge|beszel-hub|beszel-agent]"; exit 1 ;;
esac

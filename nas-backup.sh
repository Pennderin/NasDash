#!/bin/bash
# NasDash NAS-side backup — copies the Homepage theme/config and the media
# bridge into the recovery kit, with every secret redacted (the kit is on a
# LAN share and mirrors a public GitHub repo). Runs daily from cron (see
# docs/NAS-REBUILD.md); safe to run by hand any time.
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
HP=/mnt/user/system/docker/homepage
MB=/mnt/user/appdata/media-bridge
MBDATA=/mnt/user/appdata/media-bridge-data

REDACT='s/^(\s*-?\s*(key|token|password|username|apiKey|api_key|secret)\s*:\s*).+$/\1<REDACTED — see docs\/SECRETS.md>/I'

mkdir -p "$KIT/homepage" "$KIT/media-bridge"

# Theme + add-ons: no secrets in these
cp "$HP/custom.css" "$HP/custom.js" "$HP/settings.yaml" "$HP/docker.yaml" "$HP/bookmarks.yaml" "$KIT/homepage/"

# widgets.yaml: drop home coordinates (public repo)
sed -E 's/^(\s*(latitude|longitude)\s*:\s*).+$/\1<your-coordinates>/' "$HP/widgets.yaml" > "$KIT/homepage/widgets.yaml"

# services.yaml: keys/tokens/passwords/usernames and token query params redacted
sed -E "$REDACT" "$HP/services.yaml" \
  | sed -E 's/([?&](X-Plex-Token|token|apikey|api_key)=)[^&" ]+/\1REDACTED/Ig' \
  > "$KIT/homepage/services.yaml"

# Media bridge code + a settings template (names only, no values)
cp "$MB/server.js" "$KIT/media-bridge/"
if [ -f "$MBDATA/bridge.env" ]; then
  sed -E 's/=.*$/=/' "$MBDATA/bridge.env" > "$KIT/media-bridge/bridge.env.example"
fi

# Guard: fail loudly if anything that looks like a secret slipped through
if grep -rIlE '(eyJ[A-Za-z0-9_-]{20,}|[0-9a-f]{32}|ghp_[A-Za-z0-9]{20,})' \
     "$KIT/homepage" "$KIT/media-bridge" 2>/dev/null; then
  echo "WARNING: possible secret found in the files above — check before pushing to git" >&2
  exit 2
fi

chown -R nobody:users "$KIT/homepage" "$KIT/media-bridge" 2>/dev/null || true
date '+%Y-%m-%d %H:%M' > "$KIT/homepage/.last-nas-backup"
echo "NAS backup complete -> $KIT"

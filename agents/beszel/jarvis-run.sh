#!/bin/sh
# Beszel agent for JARVIS - reports to the hub on the NAS (read-only monitoring).
# Started from the user crontab (@reboot); restarts itself if it ever exits.
export KEY="<see docs/SECRETS.md>"
export TOKEN="<see docs/SECRETS.md>"
export HUB_URL="http://192.168.0.190:8093"
export SYSTEM_NAME="JARVIS"
export LISTEN="127.0.0.1:45876"
export DATA_DIR="$HOME/beszel-agent/data"
cd "$HOME/beszel-agent" || exit 1
while true; do
  ./beszel-agent > agent.log 2>&1
  sleep 5
done

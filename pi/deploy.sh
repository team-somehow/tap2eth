#!/usr/bin/env bash
# Run from the laptop: copies the terminal to the Pi and installs it as a service + kiosk screen.
# Usage: pi/deploy.sh <relayer-url> [pi-host]
#   relayer-url: e.g. https://xxxx.trycloudflare.com (the tunnel URL) or http://<laptop-ip>:8787
set -euo pipefail
RELAYER="${1:?usage: pi/deploy.sh <relayer-url> [pi-host]}"
PI="${2:-jovian@raspberrypi.local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$ROOT/reader/tools/capk.txt" ] || curl -sL -o "$ROOT/reader/tools/capk.txt" \
  https://raw.githubusercontent.com/RfidResearchGroup/proxmark3/master/client/resources/capk.txt

ssh "$PI" 'mkdir -p ~/tap2eth/terminal ~/tap2eth/reader/tools ~/tap2eth/pi'
scp "$ROOT/terminal/terminal.py" "$ROOT/terminal/reader_i2c.py" "$ROOT/terminal/ui.html" "$PI:~/tap2eth/terminal/"
scp "$ROOT/reader/tools/capk.txt" "$PI:~/tap2eth/reader/tools/"
scp "$ROOT/pi/setup.sh" "$ROOT/pi/kiosk.sh" "$PI:~/tap2eth/pi/"
ssh "$PI" "bash ~/tap2eth/pi/setup.sh '$RELAYER'"

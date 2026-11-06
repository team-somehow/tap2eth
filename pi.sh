#!/usr/bin/env bash
# The Raspberry Pi terminal, from the laptop. Reads PI_HOST and the backend URL from .env.
#   ./pi.sh url       point the Pi at the backend URL from .env (live in a few seconds, no restart)
#   ./pi.sh deploy    copy the terminal code to the Pi, restart it, and set the URL
#   ./pi.sh restart   restart the terminal and reopen the full-screen UI
#   ./pi.sh logs      follow the terminal's log
#   ./pi.sh ssh       open a shell on the Pi
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "No .env yet. Run: cp .env.example .env  and fill it in."; exit 1; }
set -a; . ./.env; set +a
HOST="${PI_HOST:-pi}"
URL="${PI_RELAYER_URL:-${RELAYER_URL:-}}"

set_url() {
  [ -n "$URL" ] || { echo "Set RELAYER_URL (or PI_RELAYER_URL) in .env first."; exit 1; }
  # The terminal re-reads this file on every request; it wins over --relayer in the service.
  echo "$URL" | ssh "$HOST" 'cat > ~/.tap2eth-relayer'
  echo "Pi now uses $URL"
}

restart() {
  # Anchored pattern, so it can't match this ssh session's own shell. systemd starts the terminal again.
  ssh "$HOST" 'pkill -f "^/usr/bin/python3 /home/[^/]*/tap2eth/terminal/terminal.py" || true
    sleep 6
    systemctl is-active tap2eth-terminal >/dev/null && echo "terminal running" || echo "terminal NOT running: ./pi.sh logs"
    setsid nohup bash ~/tap2eth/pi/kiosk.sh >/tmp/kiosk.log 2>&1 < /dev/null &'
  echo "Screen reopened."
}

case "${1:-url}" in
  url) set_url ;;
  deploy)
    ssh "$HOST" 'mkdir -p ~/tap2eth/terminal ~/tap2eth/pi'
    scp -q terminal/terminal.py terminal/reader_i2c.py terminal/buzzer.py terminal/melodies.py terminal/chain.py terminal/ui.html "$HOST:~/tap2eth/terminal/"
    scp -q pi/kiosk.sh pi/setup.sh pi/README.md "$HOST:~/tap2eth/pi/"
    echo "Code copied."
    set_url
    restart ;;
  restart) restart ;;
  logs) exec ssh "$HOST" 'journalctl -u tap2eth-terminal -f -o cat' ;;
  ssh) exec ssh "$HOST" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac

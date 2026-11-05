#!/usr/bin/env bash
# Full-screen terminal UI on the Pi's display.
sleep 3
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
B=$(command -v chromium-browser || command -v chromium)
pkill -f 'chromium.*localhost:8080' 2>/dev/null
exec "$B" --kiosk --ozone-platform=wayland --force-device-scale-factor=0.95 --password-store=basic --noerrdialogs --disable-infobars --incognito --check-for-update-interval=31536000 http://localhost:8080

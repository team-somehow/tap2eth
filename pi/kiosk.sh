#!/usr/bin/env bash
# Full-screen terminal UI on the Pi's display.
sleep 3
B=$(command -v chromium-browser || command -v chromium)
exec "$B" --kiosk --noerrdialogs --disable-infobars --incognito --check-for-update-interval=31536000 http://localhost:8080

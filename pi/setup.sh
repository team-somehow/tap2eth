#!/usr/bin/env bash
# Runs ON the Pi (called by deploy.sh). Installs deps, a systemd service for the terminal,
# and a full-screen browser that opens the terminal UI on boot.
set -euo pipefail
RELAYER="${1:?relayer url}"
READER="${2:---i2c-bus 0}"   # or "--serial /dev/ttyACM0" for the M5Stick over USB
DIR="$HOME/tap2eth"

if ! python3 -c "import serial" 2>/dev/null || ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y python3-serial chromium || sudo apt-get install -y python3-serial chromium-browser
fi
sudo usermod -aG dialout,i2c "$USER"   # serial + I2C access

# The M5Stick shows up as /dev/ttyACM0 on Linux (ESP32-S3 native USB).
sudo tee /etc/systemd/system/tap2eth-terminal.service >/dev/null <<UNIT
[Unit]
Description=Tap2ETH merchant terminal
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR/terminal
ExecStart=/usr/bin/python3 $DIR/terminal/terminal.py $READER --relayer $RELAYER --capk $DIR/reader/tools/capk.txt
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now tap2eth-terminal

# Kiosk: open the terminal UI full screen when the desktop starts.
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/tap2eth-kiosk.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Tap2ETH kiosk
Exec=bash $DIR/pi/kiosk.sh
DESK
chmod +x "$DIR/pi/kiosk.sh"
# Raspberry Pi OS (labwc / Wayland) also reads ~/.config/labwc/autostart
mkdir -p "$HOME/.config/labwc"
grep -q tap2eth "$HOME/.config/labwc/autostart" 2>/dev/null || cat >> "$HOME/.config/labwc/autostart" <<AUTO
wlr-randr --output SPI-1 --transform 90   # tap2eth: Waveshare 3.5" in landscape
bash $DIR/pi/kiosk.sh &  # tap2eth
AUTO
rm -f "$HOME/.config/autostart/tap2eth-kiosk.desktop"   # labwc autostart above starts the kiosk

echo
echo "Done. Terminal service: $(systemctl is-active tap2eth-terminal)"
echo "UI: http://localhost:8080 (kiosk opens it on next desktop login, or run: bash $DIR/pi/kiosk.sh)"
echo "Logs: journalctl -u tap2eth-terminal -f"

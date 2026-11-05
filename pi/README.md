# Raspberry Pi merchant terminal

The Pi runs `terminal/terminal.py` (the merchant screen plus the card-reader logic) and shows
the UI full screen.

**Now:** the M5StickS3 + RFID 2 reader plugs into the Pi over USB (`/dev/ttyACM0`).
**Later:** the RFID 2 reader goes straight onto the Pi's I2C pins. That needs the reader
logic ported from the firmware to Python; not done yet.

## Deploy (from the laptop, on the same network as the Pi)

1. One time, so the laptop can log in without a password:
   ```bash
   ssh-copy-id -i ~/.ssh/id_ed25519.pub jovian@10.71.143.26
   ```
2. Start the relayer and tunnel on the laptop (see `RUNNING.md`), then:
   ```bash
   pi/deploy.sh https://<your-tunnel>.trycloudflare.com
   ```
   Use the tunnel URL, so the Pi reaches the relayer on any Wi-Fi.
3. Plug the M5Stick into the Pi. The service restarts on its own if the reader is replugged.

Useful commands on the Pi:
```bash
journalctl -u tap2eth-terminal -f      # logs
sudo systemctl restart tap2eth-terminal
bash ~/tap2eth/pi/kiosk.sh             # open the full-screen UI now
```

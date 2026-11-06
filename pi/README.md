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

## Settings screen (volume, Wi-Fi)

Hold the café name at the top of the home screen for 2 seconds. Volume works straight away.
Joining a Wi-Fi network needs a one-time permission, because the terminal runs as a background
service and NetworkManager only lets it change Wi-Fi through `sudo`. `setup.sh` adds it; on a Pi
set up before that, run once on the Pi:

```bash
echo "jovian ALL=(root) NOPASSWD: /usr/bin/nmcli" | sudo tee /etc/sudoers.d/tap2eth-nmcli >/dev/null
sudo chmod 440 /etc/sudoers.d/tap2eth-nmcli && sudo visudo -cf /etc/sudoers.d/tap2eth-nmcli
```

The Wi-Fi settings only answer the Pi's own screen, not other machines on the network.

## Where the terminal finds the relayer

`~/.tap2eth-relayer` on the Pi holds the relayer URL and wins over `--relayer` in the service. It is
re-read on every request, so editing it needs no sudo and no restart. Use the laptop's network name,
not its IP, so a new IP from the Wi-Fi doesn't break payments:

```bash
echo "http://$(scutil --get LocalHostName).local:8787" | ssh pi 'cat > ~/.tap2eth-relayer'   # run on the Mac
```

The name only works while the Pi and the laptop are on the same network. For different networks,
put a tunnel URL there instead (see `RUNNING.md`).
If the relayer can't be reached, the home screen says "Offline", and a payment already waiting on the
customer's phone keeps checking for 90 seconds instead of being declined.

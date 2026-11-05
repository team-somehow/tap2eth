#!/usr/bin/env python3
"""Live RFID detection check: alternates between reader configs and prints every detection.
Hold a card on the reader while it runs. Prints only detection events, never card data."""
import sys
import time

from reader_i2c import I2CReader

r = I2CReader(bus=int(sys.argv[1]) if len(sys.argv) > 1 else 0)
CONFIGS = {
    "default": dict(gain=0x48, thr=0x84, pwr=0x20),   # MFRC522 power-on defaults
    "firmware": dict(gain=0x70, thr=0x84, pwr=0x30),  # what worked on the M5Stick
    "boosted": dict(gain=0x70, thr=0x55, pwr=0x3F),   # current terminal settings
}
print("TxControl=0x%02X TxASK=0x%02X Mode=0x%02X" % (r.rd(0x14), r.rd(0x15), r.rd(0x11)), flush=True)
hits = {k: 0 for k in CONFIGS}
tries = {k: 0 for k in CONFIGS}
end = time.monotonic() + float(sys.argv[2] if len(sys.argv) > 2 else 40)
while time.monotonic() < end:
    for name, c in CONFIGS.items():
        r.wr(0x26, c["gain"])
        r.wr(0x18, c["thr"])
        r.set_power(c["pwr"])
        r.field_reset()
        r.wr(0x0E, r.rd(0x0E) & ~0x80)
        atqa = r.xfer(b"\x26", bits=7, timeout_ms=5)  # REQA
        tries[name] += 1
        if atqa and len(atqa) == 2:
            hits[name] += 1
            print(f"{time.strftime('%H:%M:%S')} {name}: card answered (ATQA {atqa.hex()})", flush=True)
for k in CONFIGS:
    print(f"{k}: detected {hits[k]}/{tries[k]}")

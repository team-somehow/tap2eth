#!/usr/bin/env python3
"""Auto-tune the RFID reader for one-tap reads. Leave a card resting on the reader and run:
    python3 tune_reader.py [--bus 0] [--tries 4]
For each combination of receiver gain / threshold / TX power it does several full EMV reads
(activate -> PPSE -> AID -> GPO -> all records) and reports success rate, time, and the failing step.
Prints only timings and error steps — never card data.
"""
import argparse
import itertools
import time

from reader_i2c import CardError, I2CReader

ap = argparse.ArgumentParser()
ap.add_argument("--bus", type=int, default=0)
ap.add_argument("--tries", type=int, default=4)
a = ap.parse_args()

r = I2CReader(bus=a.bus)
print(f"reader chip 0x{r.version:02X}")
print("waiting for a card on the reader (up to 90 s)...", flush=True)
t0 = time.monotonic()
while not r.card_present(reset=True):
    if time.monotonic() - t0 > 90:
        raise SystemExit("no card seen in 90 s")
    time.sleep(0.2)
print(f"card detected after {time.monotonic() - t0:.1f}s — keep it still", flush=True)

GAINS = [0x40, 0x50, 0x60, 0x70]          # RFCfgReg RxGain: 33, 38, 43, 48 dB
THRESH = [0x84, 0x55, 0x44]               # RxThresholdReg: default, more sensitive, most
POWER = [0x3F, 0x30]                      # CWGsPReg/ModGsPReg

results = []
for gain, th, pw in itertools.product(GAINS, THRESH, POWER):
    ok, times, fails = 0, [], {}
    for _ in range(a.tries):
        r.wr(0x26, gain)
        r.wr(0x18, th)
        r.set_power(pw)
        r.field_reset()
        time.sleep(0.02)
        t0 = time.monotonic()
        try:
            if not r.card_present(reset=True):
                raise CardError("no card (WUPA)")
            r.read_card()
            ok += 1
            times.append(time.monotonic() - t0)
        except (CardError, OSError) as e:
            k = str(e).split(" — ")[0]
            fails[k] = fails.get(k, 0) + 1
        r.release()
    avg = sum(times) / len(times) if times else 0
    results.append((ok, -avg, gain, th, pw))
    print(f"gain=0x{gain:02X} thr=0x{th:02X} pwr=0x{pw:02X}: {ok}/{a.tries} ok"
          + (f", {avg:.2f}s" if times else "") + (f"  fails={fails}" if fails else ""), flush=True)

best = max(results)
print(f"\nBEST gain=0x{best[2]:02X} thr=0x{best[3]:02X} pwr=0x{best[4]:02X}  ({best[0]}/{a.tries}, {-best[1]:.2f}s)")

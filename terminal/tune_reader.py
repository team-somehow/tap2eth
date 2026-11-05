#!/usr/bin/env python3
"""Reader reliability test. Leave a card resting on the reader, then:
    touch /tmp/tap2eth-pause; python3 tune_reader.py; rm /tmp/tap2eth-pause
Runs full read + sign cycles (what a payment does) for each setting; prints success rate,
time per cycle and failing steps. Never prints card data."""
import argparse, itertools, time
from reader_i2c import CardError, I2CReader

ap = argparse.ArgumentParser()
ap.add_argument("--bus", type=int, default=0)
ap.add_argument("--tries", type=int, default=6)
a = ap.parse_args()
r = I2CReader(bus=a.bus)
print(f"reader chip 0x{r.version:02X}; waiting for a card...", flush=True)
t0 = time.monotonic()
while not r.card_present(reset=True):
    if time.monotonic() - t0 > 90:
        raise SystemExit("no card seen in 90 s")
    time.sleep(0.2)
print("card detected — keep it still", flush=True)

results = []
for gain, fsdi in itertools.product([0x40, 0x50, 0x60, 0x70], [4, 2]):
    ok, times, fails = 0, [], {}
    for _ in range(a.tries):
        r.init(); r.wr(0x26, gain); r.fsdi = fsdi
        t = time.monotonic()
        try:
            if not r.card_present(reset=True):
                raise CardError("no card (WUPA)")
            r.read_card()
            r.internal_authenticate("00112233")
            ok += 1; times.append(time.monotonic() - t)
        except (CardError, OSError) as e:
            k = str(e).split(" — ")[0]; fails[k] = fails.get(k, 0) + 1
        r.release()
    avg = sum(times) / len(times) if times else 0
    results.append((ok, -avg, gain, fsdi))
    print(f"gain=0x{gain:02X} frame={'48' if fsdi == 4 else '32'}B: {ok}/{a.tries} ok"
          + (f", {avg:.2f}s" if times else "") + (f"  fails={fails}" if fails else ""), flush=True)
b = max(results)
print(f"\nBEST gain=0x{b[2]:02X} frame={'48' if b[3] == 4 else '32'}B ({b[0]}/{a.tries}, {-b[1]:.2f}s)")

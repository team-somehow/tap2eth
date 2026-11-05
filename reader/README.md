# Card reader: M5StickS3 + M5Stack RFID 2

This is the day-1 proof of concept. It gets a real contactless Mastercard or Visa card to sign
a random challenge, then verifies that signature against the card's certificate chain.

- `firmware/` is the PlatformIO project for the M5StickS3. It talks to the WS1850S
  (MFRC522-compatible) reader over I2C, runs the EMV commands and prints a masked summary over
  USB serial.
- `tools/verify_dda.py` reads the stick's output and checks the chain:
  Mastercard CA key → issuer key → card key → signature over our challenge.

## Hardware

- **M5StickS3** (ESP32-S3-PICO-1, 8 MB flash), with the **M5Stack RFID 2 unit** on the Grove
  port.
- **Grove pins:** SDA=GPIO9, SCL=GPIO10, reader at I2C address 0x28.
- **Grove 5V** has to be switched on through the PMIC (M5PM1 at 0x6E on the internal I2C bus,
  SDA=47 / SCL=48): register 0x06, bit 3. The firmware does this at boot.
- **Antenna:** polling uses the default strength. Once a card is selected, the firmware raises
  the transmitter conductance (`CWGsPReg` and `ModGsPReg` = 0x3F), because without it the card
  browns out during payment commands.
- **Range is about 1–2 cm.** Hold the card flat and still for about 3–5 seconds.

## What the firmware does on each tap

1. Field reset, then WUPA → anticollision / SELECT → RATS (opens ISO-DEP).
2. SELECT PPSE → SELECT AID → GET PROCESSING OPTIONS (with a random 4-byte `9F37`
   challenge) → READ RECORD for every AFL entry.
3. INTERNAL AUTHENTICATE with the challenge, which makes the card return its DDA signature.
4. GENERATE AC with CDA requested. This currently times out on this reader; it isn't needed.
5. Prints the result, then waits for the card to be removed.

It prints the card number masked to the last 4 digits only. For the verifier, it also prints
`RAW …` lines. **Those include the card's certificates and records, which contain the PAN.**
They only go over the local USB cable; the verifier keeps them in memory and prints only
pass/fail. Don't log or paste them anywhere.

## Build and flash

```bash
cd reader/firmware
~/.platformio/penv/bin/pio run -t upload --upload-port /dev/cu.usbmodem1101
```

After flashing, the stick may sit in download mode. Kick it into the app with:

```bash
~/.platformio/penv/bin/esptool --port /dev/cu.usbmodem1101 --after watchdog_reset chip_id
```

## Verify a card signature

The verifier needs the public payment-network CA key list from Proxmark3. It isn't committed
because of its licence, so download it first:

```bash
curl -sL -o reader/tools/capk.txt https://raw.githubusercontent.com/RfidResearchGroup/proxmark3/master/client/resources/capk.txt
```

Then run the verifier and tap the card:

```bash
~/.platformio/penv/bin/python -I reader/tools/verify_dda.py /dev/cu.usbmodem1101 180 reader/tools/capk.txt
```

Example result from our Mastercard:

```
VERIFY: Mastercard CA key 06: 1984-bit, e=3
VERIFY: issuer certificate format=OK hash=OK -> issuer key 1408-bit
VERIFY: card certificate format=OK hash=OK -> card key 1024-bit, e=3
VERIFY: signature over challenge 81D0D5FF: format=OK hash=OK
VERIFY RESULT: VALID - chain CA -> issuer -> card -> signature all check out
```

The verifier currently only knows Mastercard's RID (`a000000004`). For Visa, use
`a000000003`.

## Known issues

- Detection is hit-or-miss because of the reader's short range. Use a cradle for the demo.
- GENERATE AC (CDA) times out, probably because its long command needs send chaining or more
  power.
- Type A cards only.

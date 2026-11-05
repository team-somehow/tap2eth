#!/usr/bin/env python3
"""Tap2ETH merchant terminal.

Talks to the card reader (M5Stick + RFID over USB serial) and the relayer, and serves the
merchant screen at http://localhost:8080.

On each tap the reader sends the card's records; we rebuild the card's public key from its
certificate chain (CA -> issuer -> card), ask the relayer for the challenge for this payment
(or registration), send it to the reader, and forward the card's signature to the relayer.

Card data (PAN, certificates) stays in memory only and is never logged or sent anywhere: only
the card's public key and signature go to the relayer.

Usage: python3 terminal.py --serial /dev/cu.usbmodem1101 --relayer http://localhost:8787
Requires: pyserial
"""
import argparse
import hashlib
import http.server
import json
import os
import threading
import time
import urllib.request

import serial

HERE = os.path.dirname(os.path.abspath(__file__))

# Live payment-network CA public keys (public data, loaded into every card terminal).
# Loaded from capk.txt (Proxmark3 format) at startup — see README for the download command.
CAPKS = {}


def load_capks(path):
    for line in open(path):
        f = line.split()
        if len(f) >= 6 and f[3] == "rsa":
            rid = f[0].replace(":", "").lower()
            CAPKS[(rid, f[1].lower())] = (int(f[5].replace(":", ""), 16), int(f[4].replace(":", ""), 16),
                                          len(f[5].replace(":", "")) // 2)


# ------------------------------------------------------------------------------- EMV parsing

def tlv_iter(d):
    i = 0
    while i < len(d):
        if d[i] in (0x00, 0xFF):
            i += 1
            continue
        tag = d[i]
        cons = d[i] & 0x20
        if d[i] & 0x1F == 0x1F:
            i += 1
            tag = (tag << 8) | d[i]
            while d[i] & 0x80:
                i += 1
                tag = (tag << 8) | d[i]
        i += 1
        L = d[i]
        i += 1
        if L & 0x80:
            nb = L & 0x7F
            L = int.from_bytes(d[i:i + nb], "big")
            i += nb
        v = d[i:i + L]
        i += L
        yield tag, v
        if cons:
            yield from tlv_iter(v)


def find(d, tag):
    for t, v in tlv_iter(d):
        if t == tag:
            return v
    return None


def card_public_key(aid, gpo, recs):
    """Recover (modulus, exponent) of the card's RSA key from its certificate chain."""
    allrec = b"".join(r for _, _, r in recs)
    if gpo[0] == 0x80:
        aip, afl = gpo[2:4], gpo[4:2 + gpo[1]]
    else:
        aip, afl = find(gpo, 0x82), find(gpo, 0x94)
    rid = aid[:5].hex()
    ca = CAPKS.get((rid, find(allrec, 0x8F).hex()))
    if not ca:
        raise ValueError("unknown CA key")
    n_ca, e_ca, ca_len = ca

    x = pow(int.from_bytes(find(allrec, 0x90), "big"), e_ca, n_ca).to_bytes(ca_len, "big")
    rem, e_iss = find(allrec, 0x92) or b"", find(allrec, 0x9F32)
    if x[0] != 0x6A or x[1] != 0x02 or x[-1] != 0xBC or hashlib.sha1(x[1:-21] + rem + e_iss).digest() != x[-21:-1]:
        raise ValueError("issuer certificate invalid")
    ni = x[13]
    n_iss = int.from_bytes((x[15:15 + ca_len - 36] + rem)[:ni], "big")

    oda = b""
    for i in range(0, len(afl), 4):
        sfi, first, cnt = afl[i] >> 3, afl[i + 1], afl[i + 3]
        for rec in range(first, first + cnt):
            r = next((b for sf, rn, b in recs if sf == sfi and rn == rec), None)
            if r is not None:
                oda += find(r, 0x70) if sfi <= 10 else r
    if find(allrec, 0x9F4A) == b"\x82":
        oda += aip
    y = pow(int.from_bytes(find(allrec, 0x9F46), "big"), int.from_bytes(e_iss, "big"), n_iss).to_bytes(ni, "big")
    rem2, e_icc = find(allrec, 0x9F48) or b"", find(allrec, 0x9F47)
    if y[0] != 0x6A or y[1] != 0x04 or y[-1] != 0xBC or hashlib.sha1(y[1:-21] + rem2 + e_icc + oda).digest() != y[-21:-1]:
        raise ValueError("card certificate invalid")
    nic = y[19]
    modulus = (y[21:21 + ni - 42] + rem2)[:nic]
    return modulus, e_icc


def sdad_from(ia):
    if ia[0] == 0x80:
        return ia[3:] if ia[1] == 0x81 else ia[2:]
    return find(ia, 0x9F4B)


# ------------------------------------------------------------------------------- relayer + state

class Terminal:
    def __init__(self, port, relayer, i2c_bus=None):
        self.relayer = relayer.rstrip("/")
        self.ser, self.reader = None, None
        if i2c_bus is not None:  # RFID reader wired straight to this machine's I2C (Raspberry Pi)
            from reader_i2c import I2CReader
            self.reader = I2CReader(bus=i2c_bus)
        else:  # M5Stick reader over USB serial
            self.ser = serial.Serial()
            self.ser.port, self.ser.baudrate, self.ser.timeout = port, 115200, 0.2
            self.ser.dtr = self.ser.rts = False
            self.ser.open()
        self.lock = threading.Lock()
        self.sig_event = threading.Event()
        self.state = {"mode": "idle", "screen": "Ready", "detail": "", "amount": None, "code": None, "tx": None, "ok": None}
        self._reset_tap()

    def _reset_tap(self):
        self.aid, self.gpo, self.recs, self.ia = None, None, [], None

    def set(self, **kw):
        with self.lock:
            self.state.update(kw)
            s = dict(self.state)
        # Mirror the status on the M5Stick's screen.
        color = "G" if s["ok"] is True else "R" if s["ok"] is False else "B" if s["mode"] in ("register", "waiting") else "Y" if s["mode"] == "pay" else "W"
        ascii_ = lambda t: "".join(ch for ch in str(t or "") if 32 <= ord(ch) < 127).replace("|", "/").strip()[:26]
        l1, l2 = ascii_(s["screen"]), ascii_(s["detail"])
        if s["mode"] == "waiting":
            l1, l2 = "Approve on phone", f"{s['amount']} tUSDC"
        try:
            self.write(f"SHOW {color}|{l1 or 'Tap2ETH'}|{l2}")
        except Exception:  # noqa: BLE001
            pass

    def post(self, path, body=None):
        req = urllib.request.Request(self.relayer + path, data=json.dumps(body or {}).encode() if body is not None else None,
                                     headers={"content-type": "application/json"}, method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(json.loads(e.read()).get("error", str(e)))

    # merchant actions
    def start_payment(self, amount):
        self.set(mode="pay", amount=amount, screen=f"{amount} tUSDC", detail="Tap card", tx=None, ok=None, code=None)

    def start_register(self, code):
        self.set(mode="register", code=code, screen="Register card", detail=f"Code {code} — tap card", tx=None, ok=None, amount=None)

    def cancel(self):
        self.set(mode="idle", screen="Ready", detail="", amount=None, code=None, tx=None, ok=None)

    def write(self, line):
        if self.ser is None:
            return
        try:
            self.ser.write((line + "\n").encode())
        except (serial.SerialException, OSError):
            self._reconnect()

    def _reconnect(self):
        """The reader resets or gets replugged sometimes: reopen its port (it may change name)."""
        import glob
        try:
            self.ser.close()
        except Exception:  # noqa: BLE001
            pass
        while True:
            time.sleep(1)
            ports = [self.ser.port] + sorted(p for p in glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/ttyACM*") if "R3C" not in p)
            for p in ports:
                try:
                    self.ser.port = p
                    self.ser.open()
                    print(f"reader connected on {p}", flush=True)
                    return
                except (serial.SerialException, OSError):
                    continue

    # serial loop
    def run(self):
        while True:
            try:
                line = self.ser.readline().decode(errors="replace").strip()
            except (serial.SerialException, OSError):
                self._reconnect()
                continue
            if not line:
                continue
            if line.startswith("RAW "):
                parts = line.split(" ", 2)
                k, h = parts[1], parts[2] if len(parts) > 2 else ""
                b = bytes.fromhex(h)
                if k == "AID":
                    self.aid = b
                elif k == "GPO":
                    self.gpo = b
                elif k == "IA":
                    self.ia = b
                elif k.startswith("REC_"):
                    _, sfi, rec = k.split("_")
                    self.recs.append((int(sfi), int(rec), b))
                continue
            if line == "=== TEST START ===":
                self._reset_tap()
            elif line == "READY":
                threading.Thread(target=self.on_card, args=(self._serial_sign,), daemon=True).start()
            elif line in ("SIGNED", "SIGFAIL"):
                self.sig_event.set()
            elif line.startswith("FAIL") or line == "NOCHAL":
                if self.state["mode"] != "idle" and self.state["ok"] is None:
                    self.set(detail="Card read failed — tap again")

    def _serial_sign(self, chal):
        self.write("CHAL " + chal)
        if not self.sig_event.wait(6) or not self.ia:
            raise RuntimeError("card moved away — tap again")
        return sdad_from(self.ia)

    def run_i2c(self):
        """Poll the Pi-attached reader; only talk to cards when the merchant is charging/registering."""
        from reader_i2c import CardError
        while True:
            if self.state["mode"] not in ("pay", "register") or not self.reader.card_present():
                time.sleep(0.05)
                continue
            # Retry straight away while the card is still on the reader: no need to lift and re-tap.
            for attempt in range(5):
                self.set(detail="Reading card… hold it still" if attempt == 0 else "Almost… keep holding")
                try:
                    card = self.reader.read_card()
                    self.aid, self.gpo, self.recs = card["aid"], card["gpo"], card["recs"]
                    t_read = time.monotonic()
                    self.on_card(self.reader.internal_authenticate)
                    print(f"card handled in attempt {attempt + 1}", flush=True)
                    break
                except (CardError, OSError) as e:
                    err = e
                    print(f"read attempt {attempt + 1} failed: {e}", flush=True)
                    self.reader.release()
                    self.reader.init()  # full chip reset so a stuck card can be woken again
                    if not self.reader.card_present(reset=True):
                        break
            else:
                err = None
            if self.state["mode"] in ("pay", "register") and self.state["ok"] is None:
                self.set(detail="Couldn't read the card — hold it flat and still, then tap again")
            self.reader.release()
            self._reset_tap()
            self.reader.wait_removed()

    def on_card(self, sign):
        mode = self.state["mode"]
        if mode == "idle":
            self.write("SKIP")
            return
        try:
            self.set(detail="Reading card…")
            modulus, exponent = card_public_key(self.aid, self.gpo, self.recs)
            self.sig_event = threading.Event()
            if mode == "pay":
                r = self.post("/api/pay/start", {"cardModulus": modulus.hex(), "amount": self.state["amount"]})
                pay_id, chal = r["id"], r["challenge"]
            else:
                chal = self.post(f"/api/register/{self.state['code']}/challenge")["challenge"]
            sig = sign(chal).hex()
            if mode == "register":
                self.set(detail="Creating wallet…")
                w = self.post(f"/api/register/{self.state['code']}/card", {"cardModulus": modulus.hex(), "cardExponent": exponent.hex(), "cardSig": sig})
                self.set(mode="done", screen="Card registered ✓", detail=f"Wallet {w['wallet'][:10]}…", ok=True)
                return
            self.post(f"/api/pay/{pay_id}/card", {"cardSig": sig})
            self.set(mode="waiting", detail="Card ✓ — approve on your phone…")
            while True:
                time.sleep(1)
                p = self.post(f"/api/pay/{pay_id}")
                if p["status"] == "paid":
                    self.set(mode="done", screen=f"Paid {p['amount']} tUSDC ✓", detail="Thank you!", tx=p.get("txHash"), ok=True)
                    return
                if p["status"] in ("failed", "rejected"):
                    self.set(mode="done", screen="Declined ✗", detail=p.get("error") or p["status"], ok=False)
                    return
        except Exception as e:  # noqa: BLE001
            print(f"payment step failed: {e}", flush=True)
            self.write("SKIP")
            if self.state["mode"] in ("pay", "register", "waiting"):
                self.set(detail=f"{e}", ok=None if "tap again" in str(e) else False,
                         screen=self.state["screen"] if "tap again" in str(e) else "Declined ✗")
        finally:
            self._reset_tap()


# ------------------------------------------------------------------------------- web UI

def make_handler(term):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if self.path == "/state":
                return self._json(term.state)
            b = open(os.path.join(HERE, "ui.html"), "rb").read()
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(b)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            if self.path == "/pay":
                term.start_payment(str(body["amount"]))
            elif self.path == "/register":
                term.start_register(str(body["code"]))
            elif self.path == "/cancel":
                term.cancel()
            self._json(term.state)
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", default="/dev/cu.usbmodem1101")
    ap.add_argument("--relayer", default="http://localhost:8787")
    ap.add_argument("--capk", default=os.path.join(HERE, "..", "reader", "tools", "capk.txt"))
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--i2c-bus", type=int, default=None, help="use an RFID reader on this I2C bus (Raspberry Pi) instead of --serial")
    a = ap.parse_args()
    load_capks(a.capk)
    term = Terminal(a.serial, a.relayer, a.i2c_bus)
    threading.Thread(target=term.run_i2c if term.reader else term.run, daemon=True).start()
    src = f"i2c-{a.i2c_bus} (chip 0x{term.reader.version:02X})" if term.reader else a.serial
    print(f"terminal UI on http://localhost:{a.port}  (reader {src}, relayer {a.relayer})", flush=True)
    http.server.ThreadingHTTPServer(("0.0.0.0", a.port), make_handler(term)).serve_forever()


if __name__ == "__main__":
    main()

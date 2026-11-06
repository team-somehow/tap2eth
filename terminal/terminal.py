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
import re
import shutil
import subprocess
import signal
import sys
import threading
import time
import urllib.error
import urllib.request

import serial

from buzzer import DEFAULT_VOLUME, KINDS, SilentBuzzer, make_buzzer
from chain import DEFAULT_RPC, Declined, Edge, EdgeDown
from melodies import KEY_NOTES, cue_for

HERE = os.path.dirname(os.path.abspath(__file__))

# Loudness is a level from 0 (mute) to 10 (loudest), changed from the screen and remembered across restarts.
MAX_LEVEL = 10
VOLUME_FILE = os.path.expanduser("~/.tap2eth-volume")
# Where the relayer is. Wins over --relayer and is re-read on every request, so it can be changed without
# sudo or a restart. Best as the laptop's network name (http://<name>.local:8787): it survives IP changes.
RELAYER_FILE = os.path.expanduser("~/.tap2eth-relayer")
OFFLINE = "Can't reach the payment server. Check the terminal's Wi-Fi."
NGROK_HEADER = {"ngrok-skip-browser-warning": "1"}  # ngrok's free plan may otherwise answer with a warning page
# The chain RPC the terminal reads directly (see chain.py). Public data only; set by ./pi.sh url.
RPC_FILE = os.path.expanduser("~/.tap2eth-rpc")


def load_level(default_percent):
    try:
        return max(0, min(MAX_LEVEL, int(open(VOLUME_FILE).read().strip())))
    except (OSError, ValueError):
        return max(0, min(MAX_LEVEL, round(default_percent / 10)))

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
    def __init__(self, port, relayer, i2c_bus=None, buzzer=None, level=5):
        self.relayer = relayer.rstrip("/")
        self.buzzer = buzzer or SilentBuzzer()
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
        self.state = {"mode": "idle", "screen": "Ready", "detail": "", "amount": None, "code": None, "tx": None, "ok": None, "volume": level, "online": None}
        self.edge, self.edge_tried = None, 0  # the terminal's own chain checks (chain.py), once the relayer gives us its config
        self._reset_tap()

    def set_volume(self, level):
        """Set the buzzer loudness (0 mute .. 10 loudest), remember it, and play a note so it can be heard."""
        level = max(0, min(MAX_LEVEL, int(level)))
        self.buzzer.set_volume(level * 10)
        with self.lock:
            self.state["volume"] = level
        try:
            with open(VOLUME_FILE, "w") as f:
                f.write(str(level))
        except OSError:
            pass
        self.buzzer.play("volume")

    def _reset_tap(self):
        self.aid, self.gpo, self.recs, self.ia = None, None, [], None

    def set(self, **kw):
        with self.lock:
            before = dict(self.state)
            self.state.update(kw)
            s = dict(self.state)
        self.buzzer.play(cue_for(before, s))
        # Mirror the status on the M5Stick's screen.
        color = "G" if s["ok"] is True else "R" if s["ok"] is False else "B" if s["mode"] in ("register", "waiting") else "Y" if s["mode"] == "pay" else "W"
        ascii_ = lambda t: "".join(ch for ch in str(t or "") if 32 <= ord(ch) < 127).replace("|", "/").strip()[:26]
        l1, l2 = ascii_(s["screen"]), ascii_(s["detail"])
        if s["mode"] == "waiting":
            l1, l2 = "Approve on phone", f"{s['amount']} USDT"
        try:
            self.write(f"SHOW {color}|{l1 or 'Tap2ETH'}|{l2}")
        except Exception:  # noqa: BLE001
            pass

    def relayer_url(self):
        try:
            url = open(RELAYER_FILE).read().strip()
            if url:
                return url.rstrip("/")
        except OSError:
            pass
        return self.relayer

    def watch_relayer(self):
        """Check every few seconds that the relayer answers, so the screen can warn before a payment fails."""
        while True:
            try:
                urllib.request.urlopen(urllib.request.Request(self.relayer_url() + "/", headers=NGROK_HEADER), timeout=4)
                online = True
            except urllib.error.HTTPError:
                online = True  # it answered, just not with a page
            except Exception:  # noqa: BLE001
                online = False
            with self.lock:
                self.state["online"] = online
            if online and self.edge is None and time.monotonic() - self.edge_tried > 60:
                self.setup_edge()
            time.sleep(5)

    def setup_edge(self):
        """Read the chain ourselves for each tap. Without it (old relayer, chain down) payments use the relayer's checks."""
        self.edge_tried = time.monotonic()
        try:
            cfg = self.post("/api/terminal/config")
            try:
                rpc = open(RPC_FILE).read().strip() or DEFAULT_RPC
            except OSError:
                rpc = DEFAULT_RPC
            self.edge = Edge(rpc, cfg)
            print(f"terminal checks payments itself on chain {cfg['chainId']} via {rpc.split('/')[2]}", flush=True)
        except Exception as e:  # noqa: BLE001 - an old relayer has no /api/terminal/config; that's fine
            self.edge = None
            print(f"terminal-side checks off, using the relayer's: {e}", flush=True)

    def post(self, path, body=None):
        req = urllib.request.Request(self.relayer_url() + path, data=json.dumps(body or {}).encode() if body is not None else None,
                                     headers={"content-type": "application/json", **NGROK_HEADER}, method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error")
            except ValueError:  # not our API: a 404 page, or the tunnel's own error page
                msg = None
            raise RuntimeError(msg or f"The payment server answered {e.code}.")
        except (urllib.error.URLError, OSError) as e:
            print(f"relayer unreachable at {self.relayer_url()}: {e}", flush=True)
            raise RuntimeError(OFFLINE)

    # merchant actions
    def start_payment(self, amount):
        self.set(mode="pay", amount=amount, screen=f"{amount} USDT", detail="Tap card", tx=None, ok=None, code=None)

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

    def _sign_timed(self, chal, t_read):
        """Have the card sign. Logs how long it sat idle in the field first (the terminal's chain checks run then)."""
        print(f"card idle {int((time.monotonic() - t_read) * 1000)} ms before signing", flush=True)
        return self.reader.internal_authenticate(chal)

    def pay_with_edge(self, modulus, sign):
        """Check the payment on chain here, have the card sign our hash, and hand both to the relayer in one call.
        Returns the payment id, or None to fall back to the relayer's checks. Raises Declined to stop the payment."""
        edge = self.edge
        if edge is None:
            return None
        try:
            pre = edge.prepare(modulus, self.state["amount"])
        except EdgeDown as e:
            print(f"terminal-side checks unavailable, using the relayer's: {e}", flush=True)
            return None
        print(f"terminal checks passed in {pre['ms']} ms", flush=True)
        sig = sign(pre["challenge"]).hex()
        try:
            r = self.post("/api/pay/tapped", {"cardModulus": modulus.hex(), "cardId": pre["cardId"], "amount": self.state["amount"],
                                              "nonce": pre["nonce"], "expiry": pre["expiry"], "hash": pre["hash"], "cardSig": sig})
        except RuntimeError as e:
            if "didn't match" in str(e) or "Stale" in str(e):
                self.edge = None  # the relayer's settings may have changed: fetch them again before the next tap
            raise
        return r["id"]

    def _serial_sign(self, chal):
        self.write("CHAL " + chal)
        if not self.sig_event.wait(6) or not self.ia:
            raise RuntimeError("card moved away — tap again")
        return sdad_from(self.ia)

    def run_i2c(self):
        """Poll the Pi-attached reader; only talk to cards when the merchant is charging/registering."""
        from reader_i2c import CardError
        while True:
            if os.path.exists("/tmp/tap2eth-pause"):  # reader tests (tune_reader.py) running
                time.sleep(0.5)
                continue
            if self.state["mode"] not in ("pay", "register") or not self.reader.card_present():
                time.sleep(0.05)
                continue
            # Retry straight away while the card is still on the reader: no need to lift and re-tap.
            t_seen = time.monotonic()
            for attempt in range(5):
                self.set(detail="Reading card… hold it still" if attempt == 0 else "Almost… keep holding")
                try:
                    card = self.reader.read_card()
                    self.aid, self.gpo, self.recs = card["aid"], card["gpo"], card["recs"]
                    t_read = time.monotonic()
                    self.on_card(lambda c: self._sign_timed(c, t_read))
                    print(f"card handled in attempt {attempt + 1}", flush=True)
                    break
                except (CardError, OSError) as e:
                    err = e
                    print(f"read attempt {attempt + 1} failed: {e}  (card seen {int((time.monotonic() - t_seen) * 1000)} ms ago)", flush=True)
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
            if mode == "register":
                chal = self.post(f"/api/register/{self.state['code']}/challenge")["challenge"]
                sig = sign(chal).hex()
                self.set(detail="Creating wallet…")
                w = self.post(f"/api/register/{self.state['code']}/card", {"cardModulus": modulus.hex(), "cardExponent": exponent.hex(), "cardSig": sig})
                self.set(mode="done", screen="Card registered ✓", detail=f"Wallet {w['wallet'][:10]}…", ok=True)
                return
            pay_id = self.pay_with_edge(modulus, sign)
            if pay_id is None:  # the relayer does the checks and builds the hash (two round trips)
                r = self.post("/api/pay/start", {"cardModulus": modulus.hex(), "amount": self.state["amount"]})
                pay_id = r["id"]
                sig = sign(r["challenge"]).hex()
                self.post(f"/api/pay/{pay_id}/card", {"cardSig": sig})
            self.set(mode="waiting", detail="Card ✓ — approve on your phone…")
            lost = 0
            while True:
                time.sleep(1)
                # The payment may still go through while the network is down: never call it declined for that.
                try:
                    p = self.post(f"/api/pay/{pay_id}")
                except RuntimeError as e:
                    if str(e) != OFFLINE:
                        raise
                    lost += 1
                    if lost == 1:
                        self.set(detail="Connection lost — reconnecting…")
                    if lost > 90:
                        raise RuntimeError("Lost the payment server. Check the customer's phone before charging again.")
                    continue
                if lost:
                    lost = 0
                    self.set(detail="Card ✓ — approve on your phone…")
                if p["status"] == "paid":
                    self.set(mode="done", screen=f"Paid {p['amount']} USDT ✓", detail="Thank you!", tx=p.get("txHash"), ok=True)
                    return
                if p["status"] in ("failed", "rejected"):
                    self.set(mode="done", screen="Declined ✗", detail=p.get("error") or p["status"], ok=False)
                    return
        except Exception as e:  # noqa: BLE001
            print(f"payment step failed: {e}", flush=True)
            if self.reader is not None and type(e).__name__ in ("CardError", "OSError"):
                raise  # card hiccup while signing: let run_i2c retry while the card is still there
            self.write("SKIP")
            if self.state["mode"] in ("pay", "register", "waiting"):
                if "tap again" in str(e).lower():
                    self.set(detail=f"{e}")
                else:
                    self.set(mode="done", screen="Declined ✗", detail=f"{e}", ok=False)
        finally:
            self._reset_tap()


# ------------------------------------------------------------------------------- Wi-Fi (settings screen)

class WifiError(Exception):
    pass


def nmcli(args, timeout=20):
    """Run nmcli; if NetworkManager refuses the service user, retry through sudo (setup.sh allows nmcli only)."""
    if not shutil.which("nmcli"):
        raise WifiError("Wi-Fi settings work on the Pi only.")
    err = ""
    for cmd in (["nmcli", *args], ["sudo", "-n", "nmcli", *args]):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise WifiError("Wi-Fi took too long to answer. Try again.")
        if r.returncode == 0:
            return r.stdout
        err = (r.stderr or r.stdout).strip()
        if not re.search(r"not authori[sz]ed|permission|privileges", err, re.I):
            break
    if re.search(r"not authori[sz]ed|permission|privileges|password is required", err, re.I):
        raise WifiError("This terminal isn't allowed to change Wi-Fi yet. Run the one-time setup in pi/README.md.")
    raise WifiError(err or "Wi-Fi command failed.")


def _fields(line):
    """nmcli -t separates fields with ':' and escapes ':' inside values as '\\:'."""
    return [p.replace("\\:", ":") for p in re.split(r"(?<!\\):", line)]


def wifi_scan(rescan=False):
    fields = ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan"]
    try:
        out = nmcli(fields + ["yes" if rescan else "auto"], timeout=30)
    except WifiError:
        if not rescan:
            raise
        out = nmcli(fields + ["no"], timeout=30)  # a fresh scan needs permission; the last scan's list does not
    nets, current = {}, None
    for line in out.splitlines():
        f = _fields(line)
        if len(f) < 4 or not f[1]:
            continue  # hidden networks have no name to show
        ssid, signal, secure = f[1], int(f[2] or 0), f[3] not in ("", "--")
        if f[0] == "*":
            current = ssid
        if ssid not in nets or signal > nets[ssid]["signal"]:
            nets[ssid] = {"ssid": ssid, "signal": signal, "secure": secure}
    nets = sorted(nets.values(), key=lambda n: (n["ssid"] != current, -n["signal"]))
    return {"current": current, "networks": nets}


def wifi_connect(ssid, password):
    """Join a network. The password goes to nmcli only: never logged, never sent back."""
    try:
        nmcli(["device", "wifi", "connect", ssid] + (["password", password] if password else []), timeout=45)
    except WifiError as e:
        m = str(e)
        if re.search(r"secrets were required|802-11-wireless-security|psk", m, re.I):
            raise WifiError("Wrong password. Try again.")
        if re.search(r"no network with ssid", m, re.I):
            raise WifiError("That network is out of range.")
        raise


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

        def _local(self):
            # Settings (Wi-Fi) only from the Pi's own screen, never from another machine on the network.
            return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

        def do_GET(self):
            if self.path == "/state":
                return self._json(term.state)
            if self.path.startswith("/wifi"):
                if not self._local():
                    return self._json({"error": "Settings work on the terminal's own screen only."}, 403)
                try:
                    return self._json(wifi_scan(rescan="rescan=1" in self.path))
                except WifiError as e:
                    return self._json({"error": str(e)}, 500)
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
            elif self.path == "/volume":
                try:
                    term.set_volume(body["level"])
                except (KeyError, TypeError, ValueError):
                    return self._json({"error": "level must be 0-10"}, 400)
            elif self.path == "/wifi":
                if not self._local():
                    return self._json({"error": "Settings work on the terminal's own screen only."}, 403)
                ssid, pw = body.get("ssid"), body.get("password") or ""
                if not isinstance(ssid, str) or not 0 < len(ssid) <= 32 or not isinstance(pw, str) or len(pw) > 63:
                    return self._json({"error": "Check the network name and password."}, 400)
                try:
                    wifi_connect(ssid, pw)
                except WifiError as e:
                    return self._json({"error": str(e)}, 400)
                return self._json({"ok": True, "current": ssid})
            elif self.path == "/key":
                key = body.get("key")
                if not isinstance(key, str) or key not in KEY_NOTES:
                    return self._json({"error": "unknown key"}, 400)
                term.buzzer.key(key)
            self._json(term.state)
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", default="/dev/cu.usbmodem1101")
    ap.add_argument("--relayer", default="http://localhost:8787")
    ap.add_argument("--capk", default=os.path.join(HERE, "..", "reader", "tools", "capk.txt"))
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--i2c-bus", type=int, default=None, help="use an RFID reader on this I2C bus (Raspberry Pi) instead of --serial")
    ap.add_argument("--buzzer-pin", type=int, default=None, help="BCM GPIO number of the buzzer (Raspberry Pi); no sound if unset")
    ap.add_argument("--buzzer-kind", choices=KINDS, default="active", help="active plays rhythm only, passive plays real notes")
    ap.add_argument("--buzzer-active-low", action="store_true", help="the buzzer sounds while the pin is low")
    ap.add_argument("--buzzer-volume", type=int, default=DEFAULT_VOLUME, help="starting loudness in percent (0-100); the level saved from the screen wins")
    a = ap.parse_args()
    load_capks(a.capk)
    level = load_level(a.buzzer_volume)
    buzzer = make_buzzer(a.buzzer_pin, a.buzzer_kind, a.buzzer_active_low, level * 10)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # so systemd restarts leave the pin quiet
    term = Terminal(a.serial, a.relayer, a.i2c_bus, buzzer, level)
    threading.Thread(target=term.run_i2c if term.reader else term.run, daemon=True).start()
    threading.Thread(target=term.watch_relayer, daemon=True).start()
    src = f"i2c-{a.i2c_bus} (chip 0x{term.reader.version:02X})" if term.reader else a.serial
    print(f"terminal UI on http://localhost:{a.port}  (reader {src}, relayer {term.relayer_url()})", flush=True)
    buzzer.play("ready")
    try:
        http.server.ThreadingHTTPServer(("0.0.0.0", a.port), make_handler(term)).serve_forever()
    finally:
        buzzer.close()


if __name__ == "__main__":
    main()

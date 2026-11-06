"""MFRC522-class reader (M5Stack RFID 2 / WS1850S) wired straight to a Raspberry Pi's I2C bus.

Python port of reader/firmware/src/main.cpp: ISO 14443-A activation, ISO-DEP (T=CL) with
chaining / WTX, and the EMV commands Tap2ETH needs. No dependencies beyond the standard library.

    r = I2CReader(bus=0, addr=0x28)
    if r.card_present():
        card = r.read_card()                 # {'aid', 'gpo', 'recs'} - stays in memory
        sig = r.internal_authenticate(chal)  # card signs our 4-byte challenge
"""
import fcntl
import os
import random
import time

I2C_SLAVE = 0x0703


class CardError(Exception):
    pass


def crc_a(data):
    crc = 0x6363
    for b in data:
        ch = (b ^ (crc & 0xFF)) & 0xFF
        ch = (ch ^ (ch << 4)) & 0xFF
        crc = ((crc >> 8) ^ (ch << 8) ^ (ch << 3) ^ (ch >> 4)) & 0xFFFF
    return bytes([crc & 0xFF, crc >> 8])


def with_crc(data):
    return bytes(data) + crc_a(data)


def crc_ok(data):
    return len(data) >= 3 and crc_a(data[:-2]) == data[-2:]


def tlv_find(d, want):
    i = 0
    while i < len(d):
        if d[i] in (0x00, 0xFF):
            i += 1
            continue
        tag, cons = d[i], d[i] & 0x20
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
        if tag == want:
            return v
        if cons:
            r = tlv_find(v, want)
            if r is not None:
                return r
    return None


# Terminal data a card may request in its PDOL / DDOL.
def dol_data(dol, un):
    vals = {0x9F66: b"\x27\x80\x00\x00", 0x9F02: bytes(6), 0x9F03: bytes(6), 0x9F1A: b"\x03\x56", 0x5F2A: b"\x03\x56",
            0x9A: b"\x26\x11\x06", 0x9C: b"\x00", 0x9F37: un, 0x9F35: b"\x22", 0x9F33: b"\xE0\xF0\xC8",
            0x9F40: b"\x60\x00\xF0\xA0\x01"}
    out, i = b"", 0
    while i < len(dol):
        tag = dol[i]
        if dol[i] & 0x1F == 0x1F:
            i += 1
            tag = (tag << 8) | dol[i]
            while dol[i] & 0x80:
                i += 1
                tag = (tag << 8) | dol[i]
        i += 1
        L = dol[i]
        i += 1
        out += (vals.get(tag, b"") + bytes(L))[:L]
    return out


class I2CReader:
    def __init__(self, bus=0, addr=0x28):
        self.fd = os.open(f"/dev/i2c-{bus}", os.O_RDWR)
        fcntl.ioctl(self.fd, I2C_SLAVE, addr)
        self.fsc, self.fwt_ms, self.bn = 32, 50, 0
        self.fsdi = 4  # frame size we accept from the card: 4 = 48 bytes, 2 = 32 bytes
        self.step = ""  # which command is running, so a failure can say where it happened
        self.wtx = 0    # how many "wait longer" requests the card made for the last block
        self.init()

    # ---------------------------------------------------------------- registers
    def wr(self, reg, val):
        os.write(self.fd, bytes([reg, val]))

    def rd(self, reg):
        os.write(self.fd, bytes([reg]))
        return os.read(self.fd, 1)[0]

    def wr_buf(self, reg, data):
        os.write(self.fd, bytes([reg]) + bytes(data))

    def rd_buf(self, reg, n):
        os.write(self.fd, bytes([reg]))
        return os.read(self.fd, n)

    def init(self):
        self.wr(0x01, 0x0F)  # soft reset
        time.sleep(0.05)
        # Tuned on the Pi with a real Mastercard (tune_reader.py): RxGain 33 dB + default threshold
        # + max TX power read 3/3 in ~1.5 s at 100 kHz; a lower RX threshold (0x55) caused failures.
        for reg, val in ((0x12, 0x00), (0x13, 0x00), (0x24, 0x26), (0x15, 0x40), (0x11, 0x3D), (0x26, 0x40), (0x18, 0x84)):
            self.wr(reg, val)
        self.set_power(0x3F)  # maximum transmitter power, always
        self._polls = 0
        self.wr(0x14, self.rd(0x14) | 0x03)  # antenna on
        self.version = self.rd(0x37)
        if self.version in (0x00, 0xFF):
            raise CardError("RFID reader not responding")

    def set_power(self, level):
        self.wr(0x28, level)  # CWGsPReg
        self.wr(0x29, level)  # ModGsPReg

    def field_reset(self):
        """Turn the RF field off long enough that the card really loses power and restarts.
        (10 ms isn't enough: a card left mid-transaction then ignores every wake-up request.)"""
        t = self.rd(0x14)
        self.wr(0x14, t & ~0x03)
        time.sleep(0.06)
        self.wr(0x14, t | 0x03)
        time.sleep(0.015)

    def release(self):
        """Politely end the session (DESELECT, then HALT) so the card can be woken again."""
        try:
            self.xfer(with_crc(b"\xC2"), timeout_ms=20)
        except OSError:
            pass
        try:
            self.xfer(with_crc(b"\x50\x00"), timeout_ms=5)
        except OSError:
            pass

    def set_timeout(self, ms):
        if ms <= 1600:
            p, rl = 0xA9, ms * 40
        else:
            p, rl = 0xFFF, ms * 1655 // 1000
        rl = max(1, min(0xFFFF, int(rl)))
        self.wr(0x2A, 0x80 | ((p >> 8) & 0x0F))
        self.wr(0x2B, p & 0xFF)
        self.wr(0x2C, rl >> 8)
        self.wr(0x2D, rl & 0xFF)

    def xfer(self, tx, bits=0, timeout_ms=10):
        """Raw transceive; returns bytes received or None on timeout/error."""
        self.set_timeout(timeout_ms)
        self.wr(0x01, 0x00)
        self.wr(0x04, 0x7F)
        self.wr(0x0A, 0x80)
        self.wr_buf(0x09, tx)
        self.wr(0x0D, bits)
        self.wr(0x01, 0x0C)
        self.wr(0x0D, 0x80 | bits)
        t0, got = time.monotonic(), b""
        while True:
            irq = self.rd(0x04)
            if irq & 0x30:
                break
            if irq & 0x01 or time.monotonic() - t0 > timeout_ms / 1000 + 0.1:
                self.wr(0x0D, 0)
                return None
            if irq & 0x40:  # sent; drain FIFO during long receptions
                lvl = self.rd(0x0A) & 0x7F
                if lvl > 16:
                    got += self.rd_buf(0x09, lvl - 4)
        self.wr(0x0D, 0)
        if self.rd(0x06) & 0x13:
            return None
        n = self.rd(0x0A) & 0x7F
        return got + (self.rd_buf(0x09, n) if n else b"")

    # ---------------------------------------------------------------- ISO 14443-A
    def card_present(self, reset=False):
        """WUPA. Only cycle the RF field when needed (after a failed read, or every ~1.5 s),
        so a card resting on the reader stays powered."""
        self._polls += 1
        if reset or self._polls % 10 == 0:
            self.field_reset()
        self.wr(0x0E, self.rd(0x0E) & ~0x80)
        r = self.xfer(b"\x52", bits=7, timeout_ms=5)  # WUPA
        return r is not None and len(r) == 2

    def activate(self):
        sak = None
        for sel in (0x93, 0x95, 0x97):
            r = self.xfer(bytes([sel, 0x20]), timeout_ms=10)
            if not r or len(r) != 5 or (r[0] ^ r[1] ^ r[2] ^ r[3]) != r[4]:
                raise CardError("card moved away")
            sr = self.xfer(with_crc(bytes([sel, 0x70]) + r), timeout_ms=10)
            if not sr or len(sr) != 3 or not crc_ok(sr):
                raise CardError("card moved away")
            sak = sr[0]
            if not sak & 0x04:
                break
        if not sak & 0x20:
            raise CardError("not a payment card")
        for _ in range(3):  # RATS, FSDI=4 (48-byte frames)
            ats = self.xfer(with_crc(bytes([0xE0, self.fsdi << 4])), timeout_ms=200)
            if ats and crc_ok(ats):
                break
        else:
            raise CardError("card didn't open its payment channel")
        fsci, fwi, sfgi = 2, 4, 0
        if ats[0] > 1:
            t0, p = ats[1], 2
            fsci = t0 & 0x0F
            if t0 & 0x10:
                p += 1
            if t0 & 0x20:
                fwi, sfgi = ats[p] >> 4, ats[p] & 0x0F
        self.fsc = [16, 24, 32, 40, 48, 64, 96, 128, 256][min(fsci, 8)]
        self.fwt_ms = int(0.302 * (1 << fwi)) + 1
        time.sleep((0.302 * (1 << sfgi) + 2) / 1000 if sfgi else 0.002)
        self.bn = 0

    def _block(self, frame, timeout_ms):
        r = self.xfer(with_crc(frame), timeout_ms=timeout_ms)
        self.wtx = 0
        for _ in range(50):  # S(WTX): the card asks for more time (RSA signing can take a while)
            if not (r and crc_ok(r) and (r[0] & 0xF7) == 0xF2):
                break
            self.wtx += 1
            m = r[1] & 0x3F
            r = self.xfer(with_crc(bytes([r[0], m])), timeout_ms=self.fwt_ms * max(m, 1) + 100)
        if not r or not crc_ok(r):
            return None
        return r[:-2]

    def apdu(self, cmd, timeout_ms=None):
        # Wait about 3x the card's own frame-wait time; it sends WTX if it needs longer.
        max_inf, to, off = min(self.fsc, 64) - 3, timeout_ms or max(self.fwt_ms * 3, 120), 0
        while True:  # send, chaining if needed
            chunk = cmd[off:off + max_inf]
            more = off + len(chunk) < len(cmd)
            r = self._block(bytes([0x02 | self.bn | (0x10 if more else 0)]) + chunk, to)
            for _ in range(2):
                if r:
                    break
                r = self._block(bytes([0xB2 | self.bn]), to)  # R(NAK): resend
            if not r:
                raise CardError(f"card moved away — hold it still [{self.step}]")
            if more:
                if (r[0] & 0xF6) != 0xA2:
                    raise CardError(f"card protocol error (expected R(ACK), got 0x{r[0]:02X})")
                self.bn ^= 1
                off += len(chunk)
                continue
            break
        resp = b""
        while True:  # receive, acknowledging chained blocks
            if (r[0] & 0xE2) != 0x02:
                raise CardError(f"card protocol error (got block 0x{r[0]:02X}, len {len(r)}, bn {self.bn}, {self.wtx} wait-extensions) [{self.step}]")
            if (r[0] & 1) == self.bn:
                self.bn ^= 1
            resp += r[1:]
            if not r[0] & 0x10:
                break
            r = self._block(bytes([0xA2 | self.bn]), to)
            if not r:
                raise CardError(f"card moved away — hold it still [{self.step}, receiving]")
        if len(resp) < 2:
            raise CardError("card protocol error")
        return resp[:-2], (resp[-2] << 8) | resp[-1]

    # ---------------------------------------------------------------- EMV
    def read_card(self):
        """Activate the card and read what's needed to rebuild its public key."""
        self.step = "activate"
        self.activate()
        self.step = "select PSE"
        data, sw = self.apdu(b"\x00\xA4\x04\x00\x0E2PAY.SYS.DDF01\x00")
        if sw != 0x9000:
            raise CardError("this doesn't look like a bank card")
        aid = tlv_find(data, 0x4F)
        self.step = "select app"
        data, sw = self.apdu(bytes([0x00, 0xA4, 0x04, 0x00, len(aid)]) + aid + b"\x00")
        if sw != 0x9000:
            raise CardError("the card's payment app didn't open")
        pdol = tlv_find(data, 0x9F38)
        pd = dol_data(pdol, bytes(random.getrandbits(8) for _ in range(4))) if pdol else b""
        self.step = "GPO"
        gpo, sw = self.apdu(bytes([0x80, 0xA8, 0x00, 0x00, len(pd) + 2, 0x83, len(pd)]) + pd + b"\x00")
        if sw != 0x9000:
            raise CardError("the card refused to start")
        afl = gpo[4:2 + gpo[1]] if gpo[0] == 0x80 else tlv_find(gpo, 0x94)
        recs = []
        for i in range(0, len(afl) - 3, 4):
            sfi = afl[i] >> 3
            for rec in range(afl[i + 1], afl[i + 2] + 1):
                self.step = f"read record {sfi}/{rec}"
                d, sw = self.apdu(bytes([0x00, 0xB2, rec, (sfi << 3) | 4, 0x00]))
                if sw == 0x9000:
                    recs.append((sfi, rec, d))
        return {"aid": aid, "gpo": gpo, "recs": recs}

    def internal_authenticate(self, challenge_hex):
        """The card signs our 4-byte challenge (EMV DDA). Returns the signature bytes."""
        # RSA signing is slow on the card: give this one command a long wait.
        self.step = "sign"
        d, sw = self.apdu(b"\x00\x88\x00\x00\x04" + bytes.fromhex(challenge_hex) + b"\x00", timeout_ms=1500)
        if sw != 0x9000:
            raise CardError("the card refused to sign")
        if d[0] == 0x80:
            return d[3:] if d[1] == 0x81 else d[2:]
        return tlv_find(d, 0x9F4B)

    def wait_removed(self, timeout=30):
        t0, misses = time.monotonic(), 0
        while misses < 3 and time.monotonic() - t0 < timeout:
            time.sleep(0.2)
            misses = 0 if self.card_present(reset=True) else misses + 1

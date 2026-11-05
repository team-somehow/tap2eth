# Reads the stick's serial output, verifies the EMV certificate chain and the DDA
# signature over our challenge. Prints only verdicts and key sizes; raw card data
# (which contains the PAN) stays in memory and is never printed or saved.
import sys, time, hashlib, serial

PORT, SECS, CAPK_FILE = sys.argv[1], float(sys.argv[2]), sys.argv[3]

def load_capk(rid, idx):
    for line in open(CAPK_FILE):
        f = line.split()
        if len(f) >= 6 and f[0].replace(":", "").lower() == rid and f[1].lower() == idx:
            return int(f[5].replace(":", ""), 16), int(f[4].replace(":", ""), 16), len(f[5].replace(":", "")) // 2
    return None

def tlv_iter(d):
    i = 0
    while i < len(d):
        if d[i] in (0x00, 0xFF): i += 1; continue
        t0 = i; tag = d[i]; cons = d[i] & 0x20
        if d[i] & 0x1F == 0x1F:
            i += 1; tag = (tag << 8) | d[i]
            while d[i] & 0x80: i += 1; tag = (tag << 8) | d[i]
        i += 1
        L = d[i]; i += 1
        if L & 0x80:
            nb = L & 0x7F; L = int.from_bytes(d[i:i + nb], "big"); i += nb
        v = d[i:i + L]; i += L
        yield tag, v
        if cons: yield from tlv_iter(v)

def find(d, tag):
    for t, v in tlv_iter(d):
        if t == tag: return v
    return None

def recover(data, e, n, nlen):
    x = pow(int.from_bytes(data, "big"), e, n).to_bytes(nlen, "big")
    return x

def main():
    s = serial.Serial(); s.port = PORT; s.baudrate = 115200; s.timeout = 0.5; s.dtr = False; s.rts = False
    for _ in range(20):
        try: s.open(); break
        except Exception: time.sleep(0.5)
    raw = {}; recs = []
    end = time.time() + SECS
    while time.time() < end:
        l = s.readline().decode(errors="replace").rstrip()
        if not l or l == "waiting for card...": continue
        if l.startswith("RAW "):
            _, k, h = (l.split(" ", 2) + [""])[:3]
            b = bytes.fromhex(h)
            if k.startswith("REC_"): recs.append((int(k.split("_")[1]), int(k.split("_")[2]), b))
            else: raw[k] = b
            continue
        print(l, flush=True)
        if "=== TEST END ===" in l: break
    if "IA" not in raw:
        print("VERIFY: no signature captured"); return

    allrec = b"".join(r for _, _, r in recs)
    gpo = raw["GPO"]
    if gpo[0] == 0x80: aip, afl = gpo[2:4], gpo[4:2 + gpo[1]]
    else: aip, afl = find(gpo, 0x82), find(gpo, 0x94)

    capk_idx = find(allrec, 0x8F).hex()
    ca = load_capk("a000000004", capk_idx)
    if not ca: print("VERIFY: CA key", capk_idx, "not in list"); return
    n_ca, e_ca, ca_len = ca
    print(f"VERIFY: Mastercard CA key {capk_idx}: {ca_len*8}-bit, e={e_ca}")

    # 1) issuer certificate
    x = recover(find(allrec, 0x90), e_ca, n_ca, ca_len)
    ok_fmt = x[0] == 0x6A and x[1] == 0x02 and x[-1] == 0xBC
    ni = x[13]
    rem = find(allrec, 0x92) or b""
    e_iss_b = find(allrec, 0x9F32)
    h = hashlib.sha1(x[1:-21] + rem + e_iss_b).digest()
    ok_iss = ok_fmt and h == x[-21:-1]
    n_iss = int.from_bytes((x[15:15 + ca_len - 36] + rem)[:ni], "big")
    print(f"VERIFY: issuer certificate format={'OK' if ok_fmt else 'BAD'} hash={'OK' if ok_iss else 'BAD'} -> issuer key {ni*8}-bit, cert expiry {x[6]:02X}/20{x[7]:02X}")

    # 2) card (ICC) certificate; static data = ODA records from AFL (SFI 1-10: value of 70 template)
    oda = b""
    for i in range(0, len(afl), 4):
        sfi, first, last, cnt = afl[i] >> 3, afl[i + 1], afl[i + 2], afl[i + 3]
        for rec in range(first, first + cnt):
            r = next((b for sf, rn, b in recs if sf == sfi and rn == rec), None)
            if r is None: continue
            oda += find(r, 0x70) if sfi <= 10 else r
    tl = find(allrec, 0x9F4A)
    if tl and tl == b"\x82": oda += aip
    y = recover(find(allrec, 0x9F46), int.from_bytes(e_iss_b, "big"), n_iss, ni)
    ok_fmt2 = y[0] == 0x6A and y[1] == 0x04 and y[-1] == 0xBC
    nic = y[19]
    rem2 = find(allrec, 0x9F48) or b""
    e_icc_b = find(allrec, 0x9F47)
    h2 = hashlib.sha1(y[1:-21] + rem2 + e_icc_b + oda).digest()
    ok_icc = ok_fmt2 and h2 == y[-21:-1]
    n_icc = int.from_bytes((y[21:21 + ni - 42] + rem2)[:nic], "big")
    print(f"VERIFY: card certificate format={'OK' if ok_fmt2 else 'BAD'} hash={'OK' if ok_icc else 'BAD'} -> card key {nic*8}-bit, e={int.from_bytes(e_icc_b,'big')}")

    # 3) DDA signature over our challenge
    ia = raw["IA"]
    sdad = ia[2:] if ia[0] == 0x80 and ia[1] < 0x80 else (ia[3:] if ia[0] == 0x80 else find(ia, 0x9F4B))
    if ia[0] == 0x80 and ia[1] == 0x81: sdad = ia[3:]
    z = recover(sdad, int.from_bytes(e_icc_b, "big"), n_icc, nic)
    ok_fmt3 = z[0] == 0x6A and z[1] == 0x05 and z[-1] == 0xBC
    h3 = hashlib.sha1(z[1:-21] + raw["DDOLDATA"]).digest()
    ok_sig = ok_fmt3 and h3 == z[-21:-1]
    print(f"VERIFY: signature over challenge {raw['DDOLDATA'].hex().upper()}: format={'OK' if ok_fmt3 else 'BAD'} hash={'OK' if ok_sig else 'BAD'}")
    print("VERIFY RESULT:", "VALID - chain CA -> issuer -> card -> signature all check out" if (ok_iss and ok_icc and ok_sig)
          else f"issuer={ok_iss} card={ok_icc} signature={ok_sig}")

main()

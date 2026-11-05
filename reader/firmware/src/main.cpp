// Card test: M5StickS3 + MFRC522/WS1850S (I2C 0x28) on Grove (SDA=9, SCL=10).
// Prints a masked summary over USB serial. Never prints PAN/track data/certs.
#include <Arduino.h>
#include <Wire.h>
#include <M5Unified.h>

// ---------- Screen: big status text so people can see what the terminal is doing ----------
static void show(uint16_t color, const char* l1, const char* l2 = "") {
  auto& d = M5.Display;
  d.fillScreen(TFT_BLACK);
  d.fillRect(0, 0, d.width(), 6, color);
  d.setTextDatum(middle_center);
  d.setTextColor(color, TFT_BLACK);
  d.setFont(&fonts::FreeSansBold12pt7b);
  d.drawString(l1, d.width() / 2, d.height() / 2 - 12);
  d.setTextColor(TFT_WHITE, TFT_BLACK);
  d.setFont(&fonts::FreeSans9pt7b);
  d.drawString(l2, d.width() / 2, d.height() / 2 + 20);
}
// Host command: "SHOW <G|R|Y|B|W>|line 1|line 2"
static void handleShow(const String& line) {
  int a = line.indexOf('|'), b = line.indexOf('|', a + 1);
  if (a < 0) return;
  char c = line.charAt(5);
  uint16_t col = c == 'G' ? TFT_GREEN : c == 'R' ? TFT_RED : c == 'Y' ? TFT_YELLOW : c == 'B' ? TFT_CYAN : TFT_WHITE;
  String l1 = line.substring(a + 1, b < 0 ? line.length() : b), l2 = b < 0 ? "" : line.substring(b + 1);
  show(col, l1.c_str(), l2.c_str());
}
static String hostLine;
static void pollHost() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n') { hostLine.trim(); if (hostLine.startsWith("SHOW ")) handleShow(hostLine); hostLine = ""; }
    else hostLine += ch;
  }
}

static uint8_t RC = 0x28;

// ---------- PMIC: enable Grove 5V ----------
static void enableGrovePower() {
  Wire1.begin(47, 48, 100000);
  for (int i = 0; i < 3; i++) { Wire1.beginTransmission(0x6E); Wire1.write(0x00); Wire1.endTransmission(); delay(5); }
  Wire1.beginTransmission(0x6E); Wire1.write(0x09); Wire1.write(0x00); Wire1.endTransmission();  // no I2C sleep
  Wire1.beginTransmission(0x6E); Wire1.write(0x06); Wire1.endTransmission();
  Wire1.requestFrom(0x6E, 1);
  int v = Wire1.available() ? Wire1.read() : -1;
  if (v >= 0) { Wire1.beginTransmission(0x6E); Wire1.write(0x06); Wire1.write(v | 0x08); Wire1.endTransmission(); }
  Serial.printf("PMIC PWR_CFG before=%d (boost bit -> on)\n", v);
  delay(200);
}

// ---------- MFRC522 over I2C ----------
static void wr(uint8_t r, uint8_t v) { Wire.beginTransmission(RC); Wire.write(r); Wire.write(v); Wire.endTransmission(); }
static uint8_t rd(uint8_t r) { Wire.beginTransmission(RC); Wire.write(r); Wire.endTransmission(); Wire.requestFrom((int)RC, 1); return Wire.available() ? Wire.read() : 0; }
static void wrBuf(uint8_t r, const uint8_t* d, size_t n) { Wire.beginTransmission(RC); Wire.write(r); Wire.write(d, n); Wire.endTransmission(); }
static void rdBuf(uint8_t r, uint8_t* d, size_t n) { Wire.beginTransmission(RC); Wire.write(r); Wire.endTransmission(); Wire.requestFrom((int)RC, (int)n); size_t i = 0; while (Wire.available() && i < n) d[i++] = Wire.read(); }

static void setTimeoutMs(uint32_t ms) {
  uint16_t p; uint32_t rl;
  if (ms <= 1600) { p = 0xA9; rl = ms * 40; } else { p = 0xFFF; rl = ms * 1655 / 1000; }
  if (rl > 0xFFFF) rl = 0xFFFF; if (!rl) rl = 1;
  wr(0x2A, 0x80 | ((p >> 8) & 0x0F)); wr(0x2B, p & 0xFF); wr(0x2C, rl >> 8); wr(0x2D, rl & 0xFF);
}

static bool rcInit() {
  wr(0x01, 0x0F); delay(50);
  wr(0x12, 0x00); wr(0x13, 0x00); wr(0x24, 0x26);
  wr(0x15, 0x40); wr(0x11, 0x3D); wr(0x26, 0x70);
  wr(0x28, 0x30); wr(0x29, 0x30);  // polling power: a step above default (0x20)
  uint8_t t = rd(0x14); wr(0x14, t | 0x03);
  uint8_t ver = rd(0x37);
  Serial.printf("Reader version reg: 0x%02X\n", ver);
  return ver != 0x00 && ver != 0xFF;
}
static void fieldReset() { uint8_t t = rd(0x14); wr(0x14, t & ~0x03); delay(10); wr(0x14, t | 0x03); delay(10); }

static int xfer(const uint8_t* tx, size_t tl, uint8_t bits, uint8_t* rx, size_t rmax, uint32_t to) {
  setTimeoutMs(to);
  wr(0x01, 0x00); wr(0x04, 0x7F); wr(0x0A, 0x80);
  wrBuf(0x09, tx, tl);
  wr(0x0D, bits); wr(0x01, 0x0C); wr(0x0D, 0x80 | bits);
  uint32_t t0 = millis();
  size_t got = 0;
  while (true) {
    uint8_t irq = rd(0x04);
    if (irq & 0x30) break;
    if (irq & 0x01) { wr(0x0D, 0); return -1; }
    if (millis() - t0 > to + 300) { wr(0x0D, 0); return -2; }
    if (!(irq & 0x40)) continue;    // TxIRq: only drain after our frame is fully sent
    uint8_t lvl = rd(0x0A) & 0x7F;  // drain FIFO during long receptions
    if (lvl > 16) { size_t k = lvl - 4; if (got + k > rmax) return -4; rdBuf(0x09, rx + got, k); got += k; }
  }
  wr(0x0D, 0);
  uint8_t err = rd(0x06);
  if (err & 0x13) { Serial.printf("  [xfer err=0x%02X got=%u]\n", err, (unsigned)got); return -3; }
  uint8_t n = rd(0x0A) & 0x7F;
  if (got + n > rmax) return -4;
  if (n) rdBuf(0x09, rx + got, n);
  return got + n;
}

static uint16_t crcA(const uint8_t* d, size_t n) {
  uint16_t c = 0x6363;
  for (size_t i = 0; i < n; i++) { uint8_t ch = d[i] ^ (uint8_t)(c & 0xFF); ch ^= (uint8_t)(ch << 4); c = (c >> 8) ^ ((uint16_t)ch << 8) ^ ((uint16_t)ch << 3) ^ ((uint16_t)ch >> 4); }
  return c;
}
static void addCrc(uint8_t* b, size_t n) { uint16_t c = crcA(b, n); b[n] = c & 0xFF; b[n + 1] = c >> 8; }
static bool okCrc(const uint8_t* b, int n) { if (n < 3) return false; uint16_t c = crcA(b, n - 2); return b[n - 2] == (c & 0xFF) && b[n - 1] == (c >> 8); }

static bool wupa(uint8_t atqa[2]) { wr(0x0E, rd(0x0E) & ~0x80); uint8_t c = 0x52; return xfer(&c, 1, 7, atqa, 2, 5) == 2; }

static bool selectCard(uint8_t* sak, int* uidLen) {
  const uint8_t sel[3] = {0x93, 0x95, 0x97}; *uidLen = 0;
  for (int l = 0; l < 3; l++) {
    uint8_t ac[2] = {sel[l], 0x20}, r[8];
    if (xfer(ac, 2, 0, r, 8, 10) != 5) return false;
    if ((r[0] ^ r[1] ^ r[2] ^ r[3]) != r[4]) return false;
    uint8_t s[9] = {sel[l], 0x70, r[0], r[1], r[2], r[3], r[4]}; addCrc(s, 7);
    uint8_t sr[4];
    int n = xfer(s, 9, 0, sr, 4, 10);
    if (n != 3 || !okCrc(sr, 3)) return false;
    *sak = sr[0]; *uidLen += (r[0] == 0x88) ? 3 : 4;
    if (!(sr[0] & 0x04)) return true;
  }
  return false;
}

static uint16_t fsc = 32; static uint32_t fwt = 50; static uint8_t bn = 0;

static bool rats() {
  uint8_t f[4] = {0xE0, 0x40}; addCrc(f, 2);
  uint8_t r[64]; int n = -9;
  for (int t = 0; t < 3; t++) {
    n = xfer(f, 4, 0, r, 64, 200);
    Serial.printf("RATS try %d: n=%d err=0x%02X bytes:", t, n, rd(0x06));
    for (int i = 0; i < n; i++) Serial.printf(" %02X", r[i]);
    Serial.println();
    if (n >= 3 && okCrc(r, n)) break;
    delay(20);
  }
  if (n < 3 || !okCrc(r, n)) return false;
  uint8_t fsci = 2, fwi = 4, sfgi = 0;
  if (r[0] > 1) { uint8_t t0 = r[1]; fsci = t0 & 0x0F; int p = 2; if (t0 & 0x10) p++; if (t0 & 0x20) { fwi = r[p] >> 4; sfgi = r[p] & 0x0F; } }
  static const uint16_t T[] = {16, 24, 32, 40, 48, 64, 96, 128, 256};
  fsc = fsci <= 8 ? T[fsci] : 256;
  fwt = (uint32_t)(0.302f * (1UL << fwi)) + 1;
  Serial.printf("ATS ok: FSC=%u FWI=%u (FWT~%lums)\n", fsc, fwi, (unsigned long)fwt);
  delay(sfgi ? (uint32_t)(0.302f * (1UL << sfgi)) + 2 : 2);
  bn = 0; return true;
}

static int block(const uint8_t* fr, size_t len, uint8_t* r, size_t rmax, uint32_t to) {
  uint8_t tx[80]; memcpy(tx, fr, len); addCrc(tx, len);
  int n = xfer(tx, len + 2, 0, r, rmax, to);
  for (int k = 0; k < 20 && n >= 3 && okCrc(r, n) && (r[0] & 0xF7) == 0xF2; k++) {
    uint8_t m = r[1] & 0x3F; uint8_t s[4] = {r[0], m}; addCrc(s, 2);
    n = xfer(s, 4, 0, r, rmax, fwt * (m ? m : 1) + 100);
  }
  if (n < 3 || !okCrc(r, n)) { Serial.printf("  [block fail n=%d crc=%d pcb=%02X]\n", n, n >= 3 ? okCrc(r, n) : -1, n > 0 ? r[0] : 0); return -1; }
  return n - 2;
}

static int apdu(const uint8_t* c, size_t cl, uint8_t* resp, size_t rmax) {
  size_t maxInf = (fsc < 64 ? fsc : 64) - 3;
  static uint8_t r[300]; int n = -1; size_t off = 0; uint32_t to = 1500;
  while (true) {
    size_t ch = cl - off; bool more = false;
    if (ch > maxInf) { ch = maxInf; more = true; }
    uint8_t f[72]; f[0] = 0x02 | bn | (more ? 0x10 : 0); memcpy(f + 1, c + off, ch);
    n = block(f, ch + 1, r, sizeof r, to);
    for (int k = 0; k < 2 && n < 1; k++) { uint8_t nak = 0xB2 | bn; Serial.println("  [timeout -> R(NAK)]"); n = block(&nak, 1, r, sizeof r, to); }
    if (n < 1) return -1;
    if (more) { if ((r[0] & 0xF6) != 0xA2) return -2; bn ^= 1; off += ch; continue; }
    break;
  }
  size_t rl = 0;
  while (true) {
    if ((r[0] & 0xE2) != 0x02) return -3;
    if ((r[0] & 1) == bn) bn ^= 1;
    size_t inf = n - 1; if (rl + inf > rmax) return -4;
    memcpy(resp + rl, r + 1, inf); rl += inf;
    if (!(r[0] & 0x10)) break;
    uint8_t ack = 0xA2 | bn;
    n = block(&ack, 1, r, sizeof r, to);
    if (n < 1) return -5;
  }
  return rl;
}

// ---------- TLV ----------
static bool tlvFind(const uint8_t* d, size_t n, uint32_t want, const uint8_t** v, size_t* vl) {
  size_t i = 0;
  while (i < n) {
    if (d[i] == 0x00 || d[i] == 0xFF) { i++; continue; }
    bool cons = d[i] & 0x20; uint32_t tag = d[i];
    if ((d[i] & 0x1F) == 0x1F) { do { i++; if (i >= n) return false; tag = (tag << 8) | d[i]; } while (d[i] & 0x80); }
    i++; if (i >= n) return false;
    size_t len = d[i++];
    if (len & 0x80) { int nb = len & 0x7F; len = 0; while (nb--) { if (i >= n) return false; len = (len << 8) | d[i++]; } }
    if (i + len > n) return false;
    if (tag == want) { *v = d + i; *vl = len; return true; }
    if (cons && tlvFind(d + i, len, want, v, vl)) return true;
    i += len;
  }
  return false;
}

static uint8_t UN[4];
static void termVal(uint32_t tag, uint8_t* out, uint8_t len) {
  uint8_t v[32]; size_t vl = 0; bool num = false;
  memset(out, 0, len);
  switch (tag) {
    case 0x9F66: { uint8_t t[] = {0x27, 0x80, 0x00, 0x00}; memcpy(v, t, 4); vl = 4; break; }
    case 0x9F02: { uint8_t t[] = {0, 0, 0, 0, 1, 0}; memcpy(v, t, 6); vl = 6; num = true; break; }
    case 0x9F1A: case 0x5F2A: { v[0] = 0x03; v[1] = 0x56; vl = 2; num = true; break; }
    case 0x9A: { v[0] = 0x26; v[1] = 0x11; v[2] = 0x05; vl = 3; break; }
    case 0x9F37: memcpy(v, UN, 4); vl = 4; break;
    case 0x9F35: v[0] = 0x22; vl = 1; break;
    case 0x9F34: v[0] = 0x1F; v[1] = 0x03; v[2] = 0x02; vl = 3; break;
    case 0x9F21: v[0] = 0x12; vl = 3; v[1] = 0; v[2] = 0; break;
    case 0x9F33: v[0] = 0xE0; v[1] = 0xF0; v[2] = 0xC8; vl = 3; break;
    case 0x9F40: { uint8_t t[] = {0x60, 0x00, 0xF0, 0xA0, 0x01}; memcpy(v, t, 5); vl = 5; break; }
    case 0x9F1C: case 0x9F1E: memcpy(v, "12345678", 8); vl = 8; break;
    case 0x9F15: v[0] = 0x59; v[1] = 0x99; vl = 2; break;
    case 0x9F16: case 0x9F4E: memset(v, 0x20, 20); vl = len < 20 ? len : 20; break;
    default: return;
  }
  if (vl >= len) memcpy(out, num ? v + (vl - len) : v, len);
  else if (num) memcpy(out + (len - vl), v, vl); else memcpy(out, v, vl);
}
static size_t buildDol(const uint8_t* dol, size_t dl, uint8_t* out) {
  size_t i = 0, o = 0;
  Serial.print("  DOL tags:");
  while (i < dl) {
    uint32_t tag = dol[i];
    if ((dol[i] & 0x1F) == 0x1F) { do { i++; tag = (tag << 8) | dol[i]; } while ((dol[i] & 0x80) && i < dl); }
    i++; uint8_t len = dol[i++];
    Serial.printf(" %lX(%u)", (unsigned long)tag, len);
    termVal(tag, out + o, len); o += len;
  }
  Serial.println();
  return o;
}

static void raw(const char* tag, const uint8_t* d, int n) { Serial.printf("RAW %s ", tag); for (int i = 0; i < n; i++) Serial.printf("%02X", d[i]); Serial.println(); }
static uint16_t sw(const uint8_t* r, int n) { return n >= 2 ? (r[n - 2] << 8) | r[n - 1] : 0; }

static void runTest() {
  Serial.println("=== TEST START ===");
  uint8_t sak; int ul;
  if (!selectCard(&sak, &ul)) { Serial.println("FAIL: anticollision/select"); Serial.println("=== TEST END ==="); return; }
  wr(0x28, 0x3F); wr(0x29, 0x3F);  // full power for ISO-DEP
  Serial.printf("Card selected: SAK=0x%02X uidLen=%d ISO14443-4=%s\n", sak, ul, (sak & 0x20) ? "yes" : "no");
  if (!rats()) { Serial.println("FAIL: RATS (no ISO-DEP)"); Serial.println("=== TEST END ==="); return; }

  static uint8_t r[600]; int n;
  const uint8_t ppse[] = {0x00, 0xA4, 0x04, 0x00, 0x0E, '2', 'P', 'A', 'Y', '.', 'S', 'Y', 'S', '.', 'D', 'D', 'F', '0', '1', 0x00};
  n = apdu(ppse, sizeof ppse, r, sizeof r);
  Serial.printf("SELECT PPSE: len=%d SW=%04X\n", n, sw(r, n));
  if (n < 2) { Serial.println("FAIL: no APDU response"); Serial.println("=== TEST END ==="); return; }
  const uint8_t* aid; size_t al;
  if (!tlvFind(r, n - 2, 0x4F, &aid, &al)) { Serial.println("FAIL: no AID in PPSE"); Serial.println("=== TEST END ==="); return; }
  Serial.print("AID: "); for (size_t i = 0; i < al; i++) Serial.printf("%02X", aid[i]); Serial.println();
  raw("AID", aid, al);
  uint8_t sel[32] = {0x00, 0xA4, 0x04, 0x00, (uint8_t)al}; memcpy(sel + 5, aid, al); sel[5 + al] = 0;
  n = apdu(sel, 6 + al, r, sizeof r);
  Serial.printf("SELECT AID: len=%d SW=%04X\n", n, sw(r, n));
  if (n < 2) { Serial.println("=== TEST END ==="); return; }

  for (int i = 0; i < 4; i++) UN[i] = esp_random() & 0xFF;
  Serial.printf("Our challenge (9F37): %02X%02X%02X%02X\n", UN[0], UN[1], UN[2], UN[3]);
  uint8_t gpo[100] = {0x80, 0xA8, 0x00, 0x00, 0, 0x83, 0};
  size_t pl = 0; const uint8_t* pdol; size_t pdl;
  if (tlvFind(r, n - 2, 0x9F38, &pdol, &pdl)) { Serial.println("PDOL present"); pl = buildDol(pdol, pdl, gpo + 7); }
  gpo[4] = pl + 2; gpo[6] = pl; gpo[7 + pl] = 0;
  n = apdu(gpo, 8 + pl, r, sizeof r);
  Serial.printf("GPO: len=%d SW=%04X\n", n, sw(r, n));
  if (n > 2) raw("GPO", r, n - 2);
  if (n < 4 || sw(r, n) != 0x9000) { Serial.println("=== TEST END ==="); return; }
  uint8_t aip[2] = {0, 0}; uint8_t afl[64]; size_t afll = 0;
  const uint8_t *v; size_t vl;
  bool gpoSig = false;
  if (r[0] == 0x80) { size_t L = r[1]; aip[0] = r[2]; aip[1] = r[3]; afll = L - 2; memcpy(afl, r + 4, afll); }
  else {
    if (tlvFind(r, n - 2, 0x82, &v, &vl)) memcpy(aip, v, 2);
    if (tlvFind(r, n - 2, 0x94, &v, &vl)) { afll = vl; memcpy(afl, v, vl); }
    if (tlvFind(r, n - 2, 0x9F4B, &v, &vl)) { gpoSig = true; Serial.printf("GPO SIGNATURE 9F4B: %u bytes (= %u-bit card key)\n", (unsigned)vl, (unsigned)vl * 8); }
  }
  Serial.printf("AIP=%02X%02X  SDA=%d DDA=%d CDA=%d\n", aip[0], aip[1], !!(aip[0] & 0x40), !!(aip[0] & 0x20), !!(aip[0] & 0x01));

  static uint8_t cdol1[64]; size_t c1l = 0; static uint8_t ddol[32]; size_t ddl = 0;
  bool have8F = false, recSig = false;
  for (size_t i = 0; i + 3 < afll + 1 && i + 4 <= afll; i += 4) {
    uint8_t sfi = afl[i] >> 3;
    for (uint8_t rec = afl[i + 1]; rec <= afl[i + 2]; rec++) {
      uint8_t rr[5] = {0x00, 0xB2, rec, (uint8_t)((sfi << 3) | 4), 0x00};
      n = apdu(rr, 5, r, sizeof r);
      if (n > 2 && sw(r, n) == 0x9000) { char t[16]; snprintf(t, sizeof t, "REC_%u_%u", sfi, rec); raw(t, r, n - 2); }
      Serial.printf("READ RECORD sfi=%u rec=%u: len=%d SW=%04X ->", sfi, rec, n, sw(r, n));
      if (n < 2 || sw(r, n) != 0x9000) { Serial.println(); continue; }
      const uint32_t tags[] = {0x8F, 0x90, 0x92, 0x9F32, 0x9F46, 0x9F47, 0x9F48, 0x9F49, 0x8C, 0x5A, 0x9F4B};
      for (uint32_t t : tags) if (tlvFind(r, n - 2, t, &v, &vl)) {
        if (t == 0x5A) { Serial.print(" PAN=****"); uint8_t last = v[vl - 1], prev = v[vl - 2]; Serial.printf("%X%X%X%X", prev >> 4, prev & 15, last >> 4, last & 15); continue; }
        Serial.printf(" %lX(%u)", (unsigned long)t, (unsigned)vl);
        if (t == 0x8F || t == 0x9F32 || t == 0x9F47) { Serial.print("="); for (size_t k = 0; k < vl; k++) Serial.printf("%02X", v[k]); }
        if (t == 0x8F) have8F = true;
        if (t == 0x8C) { c1l = vl < 64 ? vl : 64; memcpy(cdol1, v, c1l); }
        if (t == 0x9F49) { ddl = vl < 32 ? vl : 32; memcpy(ddol, v, ddl); }
        if (t == 0x9F4B) recSig = true;
      }
      Serial.println();
    }
  }

  bool iaSig = false, cdaSig = false;
  // Terminal mode: hand the card data to the host, then wait for the challenge to sign.
  Serial.println("READY");
  show(TFT_CYAN, "Card read", "Hold still...");
  bool haveChal = false;
  {
    String line; uint32_t t0 = millis();
    while (millis() - t0 < 8000) {
      while (Serial.available()) {
        char ch = Serial.read();
        if (ch == '\n') {
          line.trim();
          if (line.startsWith("SHOW ")) { handleShow(line); line = ""; continue; }
          if (line.startsWith("CHAL ") && line.length() >= 13) {
            for (int i = 0; i < 4; i++) UN[i] = strtoul(line.substring(5 + 2 * i, 7 + 2 * i).c_str(), nullptr, 16);
            haveChal = true;
            show(TFT_CYAN, "Signing...", "Hold the card still");
          }
          if (line == "SKIP" || haveChal) goto gotLine;
          line = "";
        } else line += ch;
      }
      delay(2);
    }
  }
gotLine:
  if (!haveChal) { Serial.println("NOCHAL"); Serial.println("=== TEST END ==="); return; }
  // INTERNAL AUTHENTICATE (DDA)
  {
    uint8_t ia[64] = {0x00, 0x88, 0x00, 0x00, 0}; size_t dl;
    if (ddl) dl = buildDol(ddol, ddl, ia + 5); else { memcpy(ia + 5, UN, 4); dl = 4; }
    ia[4] = dl; ia[5 + dl] = 0;
    raw("DDOLDATA", ia + 5, dl);
    n = apdu(ia, 6 + dl, r, sizeof r);
    if (n > 2) raw("IA", r, n - 2);
    if (n > 2 && sw(r, n) == 0x9000) Serial.println("SIGNED"); else Serial.println("SIGFAIL");
    Serial.printf("INTERNAL AUTHENTICATE: len=%d SW=%04X", n, sw(r, n));
    if (n > 2 && sw(r, n) == 0x9000) {
      if (r[0] == 0x80) { size_t L = r[1] & 0x80 ? r[2] : r[1]; Serial.printf(" SIGNATURE %u bytes", (unsigned)L); iaSig = true; }
      else if (tlvFind(r, n - 2, 0x9F4B, &v, &vl)) { Serial.printf(" SIGNATURE 9F4B %u bytes", (unsigned)vl); iaSig = true; }
    }
    Serial.println();
  }
  // GENERATE AC with CDA requested (ARQC + CDA) — disabled: times out on the RFID 2 reader
  if (false && c1l) {
    static uint8_t g[120] = {0x80, 0xAE, 0x90, 0x00, 0};
    size_t dl = buildDol(cdol1, c1l, g + 5);
    g[4] = dl; g[5 + dl] = 0;
    n = apdu(g, 6 + dl, r, sizeof r);
    Serial.printf("GENERATE AC (ARQC+CDA): len=%d SW=%04X", n, sw(r, n));
    if (n > 2 && sw(r, n) == 0x9000) {
      if (tlvFind(r, n - 2, 0x9F27, &v, &vl)) Serial.printf(" CID=%02X", v[0]);
      if (tlvFind(r, n - 2, 0x9F4B, &v, &vl)) { Serial.printf(" SIGNATURE 9F4B %u bytes (= %u-bit card key)", (unsigned)vl, (unsigned)vl * 8); cdaSig = true; }
      else if (r[0] == 0x80) Serial.print(" (format 1: cryptogram only, no CDA signature)");
    }
    Serial.println();
  } else Serial.println("No CDOL1 found; skipped GENERATE AC");

  Serial.printf("RESULT: CA key index present=%s | signature via GPO=%s, record=%s, INTERNAL AUTH=%s, CDA=%s\n",
                have8F ? "yes" : "no", gpoSig ? "YES" : "no", recSig ? "YES" : "no", iaSig ? "YES" : "no", cdaSig ? "YES" : "no");
  Serial.printf("VERDICT: %s\n", (gpoSig || recSig || iaSig || cdaSig) ? "CARD SIGNS OUR CHALLENGE" : "NO SIGNATURE RETURNED");
  Serial.println("=== TEST END ===");
}

void setup() {
  auto cfg = M5.config();
  cfg.output_power = true;   // Grove 5V for the RFID reader
  M5.begin(cfg);
  M5.Display.setRotation(1);
  M5.Display.setBrightness(160);
  show(TFT_WHITE, "Tap2ETH", "Starting...");
  Serial.begin(115200);
  delay(1500);
  Serial.println("\nBoot: card test firmware");
  // Grove 5V is switched on by M5.begin() (cfg.output_power) — M5Unified owns the internal I2C bus.
  Wire.begin(9, 10, 400000);
  Serial.print("Grove I2C scan:");
  int found = 0;
  for (uint8_t a = 8; a < 0x78; a++) { Wire.beginTransmission(a); if (Wire.endTransmission() == 0) { Serial.printf(" 0x%02X", a); found++; } }
  Serial.println(found ? "" : " none");
  if (!rcInit()) { Serial.println("Reader NOT responding at 0x28"); show(TFT_RED, "No reader", "Check the RFID cable"); }
  else { Serial.println("Reader OK. Tap card..."); show(TFT_WHITE, "Tap2ETH", "Ready"); }
}

void loop() {
  M5.update();
  pollHost();
  static uint32_t lastBeat = 0;
  if (millis() - lastBeat > 5000) { lastBeat = millis(); Serial.println("waiting for card..."); }
  uint8_t atqa[2];
  fieldReset();
  if (!wupa(atqa)) { delay(150); return; }
  Serial.printf("Card detected: ATQA=%02X%02X\n", atqa[0], atqa[1]);
  show(TFT_YELLOW, "Reading card...", "Hold it flat and still");
  runTest();
  wr(0x28, 0x30); wr(0x29, 0x30);  // polling power: a step above default (0x20)
  for (int miss = 0; miss < 3;) { delay(200); fieldReset(); uint8_t a[2]; if (wupa(a)) miss = 0; else miss++; }
  Serial.println("Card removed. Tap again to retest.");
}

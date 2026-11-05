// Talks to a contactless EMV bank card over the phone's NFC (ISO-DEP), rebuilds the card's RSA
// public key from its certificate chain, and asks the card to sign a 4-byte challenge (DDA).
// Card data (PAN, certificates) stays in memory; only the public key and signature leave this file.
import NfcManager, { NfcTech } from "react-native-nfc-manager";
import { sha1 } from "@noble/hashes/legacy.js";
import CAPK from "./capk.json";

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const big = (u8) => (u8.length ? BigInt("0x" + hex(u8)) : 0n);
const toBytes = (x, len) => fromHex(x.toString(16).padStart(len * 2, "0"));

function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
const rsa = (data, e, n, len) => toBytes(modPow(big(data), e, n), len);

// ---------------------------------------------------------------- TLV
function* tlv(d) {
  let i = 0;
  while (i < d.length) {
    if (d[i] === 0x00 || d[i] === 0xff) { i++; continue; }
    let tag = d[i];
    const cons = d[i] & 0x20;
    if ((d[i] & 0x1f) === 0x1f) { do { i++; tag = (tag << 8) | d[i]; } while (d[i] & 0x80); }
    i++;
    let len = d[i++];
    if (len & 0x80) { const nb = len & 0x7f; len = 0; for (let k = 0; k < nb; k++) len = (len << 8) | d[i++]; }
    const v = d.subarray(i, i + len);
    i += len;
    yield [tag >>> 0, v];
    if (cons) yield* tlv(v);
  }
}
const find = (d, tag) => { for (const [t, v] of tlv(d)) if (t === tag) return v; return null; };

// ---------------------------------------------------------------- APDU
async function apdu(bytes) {
  const r = Uint8Array.from(await NfcManager.isoDepHandler.transceive(Array.from(bytes)));
  const sw = (r[r.length - 2] << 8) | r[r.length - 1];
  return { data: r.subarray(0, r.length - 2), sw };
}
const select = (aid) => apdu(concat([0x00, 0xa4, 0x04, 0x00, aid.length], aid, [0x00]));

// Terminal data a card may ask for in its PDOL (GPO). Zero amount; India; random number.
function dolData(dol, un) {
  const val = {
    0x9f66: [0x27, 0x80, 0, 0], 0x9f02: [0, 0, 0, 0, 0, 0], 0x9f03: [0, 0, 0, 0, 0, 0], 0x9f1a: [0x03, 0x56],
    0x5f2a: [0x03, 0x56], 0x9a: [0x26, 0x11, 0x06], 0x9c: [0], 0x9f37: Array.from(un), 0x9f35: [0x22],
    0x9f33: [0xe0, 0xf0, 0xc8], 0x9f40: [0x60, 0, 0xf0, 0xa0, 0x01],
  };
  const out = [];
  let i = 0;
  while (i < dol.length) {
    let tag = dol[i];
    if ((dol[i] & 0x1f) === 0x1f) { do { i++; tag = (tag << 8) | dol[i]; } while (dol[i] & 0x80); }
    i++;
    const len = dol[i++];
    const v = val[tag >>> 0] || [];
    for (let k = 0; k < len; k++) out.push(v[k] ?? 0);
  }
  return Uint8Array.from(out);
}

/** Reads the card and returns { aid, gpo, recs } — everything needed to rebuild its key. */
async function readCard() {
  const ppse = await select(new TextEncoder().encode("2PAY.SYS.DDF01"));
  if (ppse.sw !== 0x9000) throw new Error("This doesn't look like a bank card.");
  const aid = find(ppse.data, 0x4f);
  const sel = await select(aid);
  if (sel.sw !== 0x9000) throw new Error("The card's payment app didn't open.");
  const pdol = find(sel.data, 0x9f38);
  const pd = pdol ? dolData(pdol, Uint8Array.from({ length: 4 }, () => Math.floor(Math.random() * 256))) : new Uint8Array();
  const gpo = await apdu(concat([0x80, 0xa8, 0x00, 0x00, pd.length + 2, 0x83, pd.length], pd, [0x00]));
  if (gpo.sw !== 0x9000) throw new Error("The card refused to start (GPO).");
  const g = gpo.data;
  const afl = g[0] === 0x80 ? g.subarray(4, 2 + g[1]) : find(g, 0x94);
  const recs = [];
  for (let i = 0; i + 4 <= afl.length; i += 4) {
    const sfi = afl[i] >> 3;
    for (let rec = afl[i + 1]; rec <= afl[i + 2]; rec++) {
      const r = await apdu([0x00, 0xb2, rec, (sfi << 3) | 4, 0x00]);
      if (r.sw === 0x9000) recs.push({ sfi, rec, data: r.data });
    }
  }
  return { aid, gpo: g, afl, recs };
}

/** CA key -> issuer key -> card key. Returns { modulus, exponent } as hex. */
function cardPublicKey({ aid, gpo, afl, recs }) {
  const all = concat(...recs.map((r) => r.data));
  const rid = hex(aid.subarray(0, 5));
  const idx = find(all, 0x8f);
  const ca = idx && CAPK[`${rid}:${hex(idx)}`];
  if (!ca) throw new Error("This card's network isn't supported yet (Visa and Mastercard only).");
  const nCa = BigInt("0x" + ca.n), caLen = ca.n.length / 2;

  const x = rsa(find(all, 0x90), BigInt("0x" + ca.e), nCa, caLen);
  const rem = find(all, 0x92) || new Uint8Array();
  const eIss = find(all, 0x9f32);
  if (x[0] !== 0x6a || x[1] !== 0x02 || x[caLen - 1] !== 0xbc || !eq(sha1(concat(x.subarray(1, caLen - 21), rem, eIss)), x.subarray(caLen - 21, caLen - 1)))
    throw new Error("The bank's certificate on this card didn't check out.");
  const ni = x[13];
  const nIss = big(concat(x.subarray(15, 15 + caLen - 36), rem).subarray(0, ni));

  let oda = new Uint8Array();
  for (let i = 0; i + 4 <= afl.length; i += 4) {
    const sfi = afl[i] >> 3;
    for (let rec = afl[i + 1]; rec < afl[i + 1] + afl[i + 3]; rec++) {
      const r = recs.find((q) => q.sfi === sfi && q.rec === rec);
      if (r) oda = concat(oda, sfi <= 10 ? find(r.data, 0x70) : r.data);
    }
  }
  const tagList = find(all, 0x9f4a);
  if (tagList && tagList.length === 1 && tagList[0] === 0x82) oda = concat(oda, gpo[0] === 0x80 ? gpo.subarray(2, 4) : find(gpo, 0x82));

  const y = rsa(find(all, 0x9f46), big(eIss), nIss, ni);
  const rem2 = find(all, 0x9f48) || new Uint8Array();
  const eIcc = find(all, 0x9f47);
  if (y[0] !== 0x6a || y[1] !== 0x04 || y[ni - 1] !== 0xbc || !eq(sha1(concat(y.subarray(1, ni - 21), rem2, eIcc, oda)), y.subarray(ni - 21, ni - 1)))
    throw new Error("The card's certificate didn't check out.");
  const nic = y[19];
  const modulus = concat(y.subarray(21, 21 + ni - 42), rem2).subarray(0, nic);
  return { modulus: hex(modulus), exponent: hex(eIcc) };
}

/** INTERNAL AUTHENTICATE: the card signs our 4-byte challenge with its private key. */
async function cardSign(challengeHex) {
  const r = await apdu(concat([0x00, 0x88, 0x00, 0x00, 0x04], fromHex(challengeHex), [0x00]));
  if (r.sw !== 0x9000) throw new Error("The card refused to sign.");
  const d = r.data;
  const sdad = d[0] === 0x80 ? (d[1] === 0x81 ? d.subarray(3) : d.subarray(2)) : find(d, 0x9f4b);
  return hex(sdad);
}

let started = false;
/**
 * One tap: read the card, rebuild its key, then (optionally) ask the card to sign.
 * `getChallenge(cardKey)` may call the server while the card is still on the phone.
 */
export async function withCard(getChallenge) {
  if (!started) { await NfcManager.start(); started = true; }
  if (!(await NfcManager.isEnabled())) throw new Error("Turn on NFC in your phone's settings.");
  try {
    await NfcManager.requestTechnology(NfcTech.IsoDep, { alertMessage: "Hold your card to the back of the phone" });
    try { await NfcManager.setTimeout(3000); } catch {}
    const card = await readCard();
    const key = cardPublicKey(card);
    const challenge = await getChallenge(key);
    const signature = challenge ? await cardSign(challenge) : null;
    return { ...key, signature };
  } finally {
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }
}

export const cancelCard = () => NfcManager.cancelTechnologyRequest().catch(() => {});

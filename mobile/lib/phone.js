// The phone's key: P-256 in Android Keystore, unlocked by fingerprint for every signature.
// Signatures are packaged in WebAuthn format (authenticatorData + clientDataJSON), which is what
// the wallet contract verifies — the same format a browser passkey produces.
import { sha256 } from "@noble/hashes/sha2.js";
import { DEMO, demoPhone } from "./demo";

// In demo mode (Expo Go, no native module) the real Keystore module can't load, so only require it when present.
const Keystore = DEMO ? null : require("../modules/keystore-signer/src/KeystoreSignerModule").default;

const ALIAS = "tap2eth-phone-key";
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g).map((b) => parseInt(b, 16)));
const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const bytesToB64 = (u) => btoa(String.fromCharCode(...u));
const b64url = (u) => bytesToB64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const phoneKeyExists = () => (DEMO ? true : Keystore.hasKey(ALIAS));
export const forgetPhoneKey = () => (DEMO ? undefined : Keystore.deleteKey(ALIAS));
export const biometricsReady = () => (DEMO ? true : Keystore.biometricsAvailable());

/** Creates (or reuses) the phone key; returns its public point. */
export function createPhoneKey() {
  if (DEMO) return demoPhone.createKey();
  const spki = b64ToBytes(Keystore.generateKey(ALIAS)); // ... 04 || X || Y
  const xy = spki.subarray(spki.length - 64);
  return { phoneX: "0x" + hex(xy.subarray(0, 32)), phoneY: "0x" + hex(xy.subarray(32)) };
}

/** Fingerprint, then sign the 32-byte hash. Returns the struct the contract's verifyPhone expects. */
export async function signWithPhone(hashHex, title, subtitle) {
  if (DEMO) return demoPhone.sign(hashHex);
  const rpIdHash = sha256(new TextEncoder().encode("tap2eth.app"));
  const authenticatorData = new Uint8Array([...rpIdHash, 0x05, 0, 0, 0, 0]); // flags: user present + verified
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: b64url(fromHex(hashHex)), origin: "android:app:tap2eth" });
  const message = new Uint8Array([...authenticatorData, ...sha256(new TextEncoder().encode(clientDataJSON))]);
  const der = b64ToBytes(await Keystore.sign(ALIAS, bytesToB64(message), title, subtitle));
  const { r, s } = derToRS(der);
  return {
    authenticatorData: "0x" + hex(authenticatorData),
    clientDataJSON,
    challengeIndex: clientDataJSON.indexOf('"challenge":"'),
    typeIndex: clientDataJSON.indexOf('"type":"webauthn.get"'),
    r,
    s,
  };
}

function derToRS(der) {
  let i = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const read = () => { i++; const len = der[i++]; const v = der.subarray(i, i + len); i += len; return BigInt("0x" + hex(v)); };
  const r = read();
  let s = read();
  if (s > P256_N / 2n) s = P256_N - s;
  const h = (x) => "0x" + x.toString(16).padStart(64, "0");
  return { r: h(r), s: h(s) };
}

// Test helpers: a fake EMV card (RSA e=3, ISO 9796-2 DDA signatures) and a fake passkey (P-256 WebAuthn).
const crypto = require("crypto");

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bufToBig = (b) => BigInt("0x" + Buffer.from(b).toString("hex"));
const bigToBuf = (x, len) => Buffer.from(x.toString(16).padStart(len * 2, "0"), "hex");
function modPow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** Fake card with a 1024-bit RSA key, exponent 3 — same shape as a real Mastercard DDA key. */
function makeCard() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 3 });
  const jwk = privateKey.export({ format: "jwk" });
  const n = Buffer.from(jwk.n, "base64url");
  const d = bufToBig(Buffer.from(jwk.d, "base64url"));
  const N = bufToBig(n);
  return {
    modulus: n,
    exponent: Buffer.from([3]),
    /** INTERNAL AUTHENTICATE: sign the 4-byte challenge like an EMV card does. */
    sign(challenge4) {
      const len = n.length;
      const dyn = crypto.randomBytes(9); // ICC dynamic data (card's own random/counter bytes)
      const padLen = len - 4 - dyn.length - 21;
      const body = Buffer.concat([Buffer.from([0x05, 0x01, dyn.length]), dyn, Buffer.alloc(padLen, 0xbb)]);
      const hash = crypto.createHash("sha1").update(Buffer.concat([body, Buffer.from(challenge4)])).digest();
      const m = Buffer.concat([Buffer.from([0x6a]), body, hash, Buffer.from([0xbc])]);
      if (m.length !== len) throw new Error("bad block length");
      return bigToBuf(modPow(bufToBig(m), d, N), len);
    },
  };
}

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** Fake passkey: P-256 key producing WebAuthn assertions over a 32-byte challenge. */
function makePasskey(origin = "https://tap2eth.local") {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    x: "0x" + Buffer.from(jwk.x, "base64url").toString("hex"),
    y: "0x" + Buffer.from(jwk.y, "base64url").toString("hex"),
    sign(hashHex) {
      const authenticatorData = Buffer.concat([crypto.randomBytes(32), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
      const clientDataJSON = JSON.stringify({
        type: "webauthn.get",
        challenge: b64url(Buffer.from(hashHex.slice(2), "hex")),
        origin,
        crossOrigin: false,
      });
      const signed = Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]);
      const sig = crypto.sign("sha256", signed, { key: privateKey, dsaEncoding: "ieee-p1363" });
      let r = bufToBig(sig.subarray(0, 32));
      let s = bufToBig(sig.subarray(32));
      if (s > P256_N / 2n) s = P256_N - s;
      return {
        authenticatorData: "0x" + authenticatorData.toString("hex"),
        clientDataJSON,
        challengeIndex: clientDataJSON.indexOf('"challenge":"'),
        typeIndex: clientDataJSON.indexOf('"type":"webauthn.get"'),
        r: "0x" + r.toString(16).padStart(64, "0"),
        s: "0x" + s.toString(16).padStart(64, "0"),
      };
    },
  };
}

module.exports = { makeCard, makePasskey };

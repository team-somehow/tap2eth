// Dev helper: a simulated phone passkey, so the real card + terminal path can be tested without HTTPS.
//   node scripts/fake-phone.js new        -> creates a passkey, starts signup, prints the code
//   node scripts/fake-phone.js approve    -> approves the wallet's pending payment
//   node scripts/fake-phone.js status     -> prints wallet state
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RELAYER = process.env.RELAYER || "http://localhost:8787";
const FILE = path.join(__dirname, ".fake-phone.json");
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const b64url = (b) => Buffer.from(b).toString("base64url");

async function api(p, body) {
  const r = await fetch(RELAYER + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}

function sign(key, hashHex) {
  const authenticatorData = Buffer.concat([crypto.createHash("sha256").update("localhost").digest(), Buffer.from([0x05, 0, 0, 0, 1])]);
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: b64url(Buffer.from(hashHex.slice(2), "hex")), origin: "http://localhost:8787", crossOrigin: false });
  const sig = crypto.sign("sha256", Buffer.concat([authenticatorData, crypto.createHash("sha256").update(clientDataJSON).digest()]), { key, dsaEncoding: "ieee-p1363" });
  let s = BigInt("0x" + sig.subarray(32).toString("hex"));
  if (s > P256_N / 2n) s = P256_N - s;
  return {
    authenticatorData: "0x" + authenticatorData.toString("hex"),
    clientDataJSON,
    challengeIndex: clientDataJSON.indexOf('"challenge":"'),
    typeIndex: clientDataJSON.indexOf('"type":"webauthn.get"'),
    r: "0x" + sig.subarray(0, 32).toString("hex"),
    s: "0x" + s.toString(16).padStart(64, "0"),
  };
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === "new") {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const x = "0x" + Buffer.from(jwk.x, "base64url").toString("hex");
    const y = "0x" + Buffer.from(jwk.y, "base64url").toString("hex");
    const { code } = await api("/api/register/start", { phoneX: x, phoneY: y, credentialId: "fake" });
    fs.writeFileSync(FILE, JSON.stringify({ jwk: privateKey.export({ format: "jwk" }), code }));
    console.log(code);
    return;
  }
  const st = JSON.parse(fs.readFileSync(FILE));
  if (!st.wallet) {
    const r = await api("/api/register/" + st.code);
    if (r.wallet) { st.wallet = r.wallet; fs.writeFileSync(FILE, JSON.stringify(st)); }
  }
  if (!st.wallet) return console.log("not linked yet");
  const key = crypto.createPrivateKey({ key: st.jwk, format: "jwk" });
  const w = await api("/api/wallet/" + st.wallet);
  if (cmd === "status") return console.log(JSON.stringify({ wallet: st.wallet, balance: w.balance, frozen: w.frozen, pending: w.pending.length, history: w.history.map((p) => `${p.amount} ${p.status} ${p.error || ""}`) }, null, 1));
  if (cmd === "approve") {
    const p = w.pending[0];
    if (!p) return console.log("no pending payment");
    const r = await api(`/api/pay/${p.id}/phone`, { phoneSig: sign(key, p.hash) });
    console.log(JSON.stringify({ status: r.status, amount: r.amount, tx: r.txHash, gas: r.gasUsed, error: r.error }));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

// Dev helper: plays the terminal's part with a simulated card, against a running relayer.
//   node scripts/simulate.js register <code>   -> links a fake card to a PWA signup code
//   node scripts/simulate.js pay <amount>      -> starts a payment with that fake card (phone must approve)
// The fake card's key is kept in .sim-card.json so payments use the same card.
const fs = require("fs");
const path = require("path");
const { makeCard } = require("../../contracts/test/helpers");

const RELAYER = process.env.RELAYER || "http://localhost:8787";
const FILE = path.join(__dirname, ".sim-card.json");
const crypto = require("crypto");

function card() {
  if (fs.existsSync(FILE)) {
    const j = JSON.parse(fs.readFileSync(FILE));
    const key = crypto.createPrivateKey({ key: j.jwk, format: "jwk" });
    return makeCard(key);
  }
  const c = makeCard();
  fs.writeFileSync(FILE, JSON.stringify({ jwk: c.privateKey.export({ format: "jwk" }) }));
  return c;
}

async function post(p, body) {
  const r = await fetch(RELAYER + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j;
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  const c = card();
  if (cmd === "register") {
    const { challenge } = await post(`/api/register/${arg}/challenge`);
    const sig = c.sign(Buffer.from(challenge, "hex"));
    console.log(await post(`/api/register/${arg}/card`, { cardModulus: c.modulus.toString("hex"), cardExponent: "03", cardSig: sig.toString("hex") }));
  } else if (cmd === "pay") {
    const { id, challenge } = await post("/api/pay/start", { cardModulus: c.modulus.toString("hex"), amount: arg });
    await post(`/api/pay/${id}/card`, { cardSig: c.sign(Buffer.from(challenge, "hex")).toString("hex") });
    console.log("payment waiting for phone:", id);
  } else {
    console.log("usage: simulate.js register <code> | pay <amount>");
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

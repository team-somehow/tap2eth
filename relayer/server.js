// Tap2ETH relayer: links cards to passkeys, creates payment requests for the terminal,
// waits for the phone's approval, then submits the transaction (paying the gas).
// It can't forge anything: the wallet contract checks the card and phone signatures itself.
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { ethers } = require("ethers");

const PORT = Number(process.env.PORT || 8787);
const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const STATE_FILE = path.join(__dirname, "state.json");
const ART = path.join(__dirname, "..", "contracts", "artifacts", "contracts", "Tap2EthWallet.sol");
const PER_TX = ethers.parseUnits(process.env.PER_TX_LIMIT || "50", 6);
const DAILY = ethers.parseUnits(process.env.DAILY_LIMIT || "200", 6);
const SIGNUP_GIFT = ethers.parseUnits(process.env.SIGNUP_GIFT || "100", 6);
const PAYMENT_TTL = 300; // seconds

const load = (name, file = "Tap2EthWallet.sol") =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(ART), file, `${name}.json`)));
const WalletArt = load("Tap2EthWallet");
const FactoryArt = load("Tap2EthFactory");
const TokenArt = load("TestUSDC", "TestUSDC.sol");

const provider = new ethers.JsonRpcProvider(RPC);
// Relayer key: env var, or Hardhat's well-known dev account #0 for local testing.
const relayer = new ethers.NonceManager(
  new ethers.Wallet(process.env.RELAYER_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider)
);
const MERCHANT = process.env.MERCHANT_ADDRESS || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // dev account #1

let state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE)) : {};
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
let factory, token;

async function setup() {
  const net = await provider.getNetwork();
  const chainKey = String(net.chainId);
  state[chainKey] ||= {};
  const s = state[chainKey];
  const hasCode = async (a) => a && (await provider.getCode(a)) !== "0x";
  if (!(await hasCode(s.factory))) {
    const f = await new ethers.ContractFactory(FactoryArt.abi, FactoryArt.bytecode, relayer).deploy();
    s.factory = await f.getAddress();
  }
  if (!(await hasCode(s.token))) {
    const t = await new ethers.ContractFactory(TokenArt.abi, TokenArt.bytecode, relayer).deploy();
    s.token = await t.getAddress();
  }
  save();
  factory = new ethers.Contract(s.factory, FactoryArt.abi, relayer);
  token = new ethers.Contract(s.token, TokenArt.abi, relayer);
  console.log(`chain ${chainKey}  factory ${s.factory}  token ${s.token}  merchant ${MERCHANT}`);
}

// An idle local chain's last block can be hours old; the next block uses the real clock.
const chainNow = async () => Math.max((await provider.getBlock("latest")).timestamp, Math.floor(Date.now() / 1000));
const walletAt = (a) => new ethers.Contract(a, WalletArt.abi, relayer);
const hex = (b) => (b.startsWith("0x") ? b : "0x" + b);

// In-memory sessions (fine for a hackathon demo).
const registrations = new Map(); // code -> { phoneX, phoneY, credentialId, wallet?, status }
const payments = new Map(); // id -> { ... }
const actions = new Map(); // id -> freeze/unfreeze requests

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "..", "pwa")));

// --- signup -----------------------------------------------------------------------------------

// PWA: "I made a passkey, give me a code to type on the terminal".
app.post("/api/register/start", (req, res) => {
  const { phoneX, phoneY, credentialId } = req.body || {};
  if (!/^0x[0-9a-fA-F]{64}$/.test(phoneX || "") || !/^0x[0-9a-fA-F]{64}$/.test(phoneY || "")) {
    return res.status(400).json({ error: "bad passkey public key" });
  }
  let code;
  do code = String(crypto.randomInt(1000, 10000)); while (registrations.has(code));
  registrations.set(code, { phoneX, phoneY, credentialId, status: "waiting_for_card", created: Date.now() });
  res.json({ code });
});

app.get("/api/register/:code", (req, res) => {
  const r = registrations.get(req.params.code);
  if (!r) return res.status(404).json({ error: "unknown code" });
  res.json({ status: r.status, wallet: r.wallet, error: r.error });
});

// Terminal: the user typed their code and tapped their card. The terminal sends the card's
// public key (recovered from its certificates) plus a signature over our registration challenge.
app.get("/api/register/:code/challenge", (req, res) => {
  const r = registrations.get(req.params.code);
  if (!r) return res.status(404).json({ error: "unknown code" });
  r.challenge = crypto.randomBytes(4).toString("hex");
  res.json({ challenge: r.challenge });
});

app.post("/api/register/:code/card", async (req, res) => {
  const r = registrations.get(req.params.code);
  if (!r || !r.challenge) return res.status(404).json({ error: "unknown code" });
  const { cardModulus, cardExponent, cardSig } = req.body || {};
  try {
    if (!verifyCardSig(cardModulus, cardExponent, r.challenge, cardSig)) throw new Error("card signature invalid");
    const key = ethers.keccak256(hex(cardModulus));
    if ((await factory.walletOf(key)) !== ethers.ZeroAddress) throw new Error("this card already has a wallet");
    r.status = "creating_wallet";
    await (await factory.createWallet(hex(cardModulus), hex(cardExponent), r.phoneX, r.phoneY, PER_TX, DAILY)).wait();
    r.wallet = await factory.walletOf(key);
    await (await token.faucet(r.wallet, SIGNUP_GIFT)).wait();
    r.status = "done";
    res.json({ wallet: r.wallet });
  } catch (e) {
    r.status = "failed";
    r.error = e.shortMessage || e.message;
    res.status(400).json({ error: r.error });
  }
});

// --- phone-only signup (native app scans the card itself) ---------------------------------------

const directChallenges = new Map(); // id -> challenge hex

app.get("/api/signup/challenge", (req, res) => {
  const id = crypto.randomUUID();
  const challenge = crypto.randomBytes(4).toString("hex");
  directChallenges.set(id, challenge);
  res.json({ id, challenge });
});

app.post("/api/signup", async (req, res) => {
  const { id, phoneX, phoneY, cardModulus, cardExponent, cardSig } = req.body || {};
  const challenge = directChallenges.get(id);
  directChallenges.delete(id);
  try {
    if (!challenge) throw new Error("signup expired, try again");
    if (!verifyCardSig(cardModulus, cardExponent, challenge, cardSig)) throw new Error("card signature invalid");
    const key = ethers.keccak256(hex(cardModulus));
    let wallet = await factory.walletOf(key);
    if (wallet !== ethers.ZeroAddress) {
      const w = walletAt(wallet);
      if ((await w.phoneX()) !== phoneX || (await w.phoneY()) !== phoneY) throw new Error("this card is already linked to another phone");
      return res.json({ wallet, existing: true });
    }
    await (await factory.createWallet(hex(cardModulus), hex(cardExponent), phoneX, phoneY, PER_TX, DAILY)).wait();
    wallet = await factory.walletOf(key);
    await (await token.faucet(wallet, SIGNUP_GIFT)).wait();
    res.json({ wallet });
  } catch (e) {
    res.status(400).json({ error: e.shortMessage || e.message });
  }
});

// Unfreeze needs card + phone: the app scans the card (signs hash[0:4]) and the fingerprint signs the hash.
app.post("/api/unfreeze/start", async (req, res) => {
  try {
    const w = walletAt(req.body.wallet);
    const expiry = (await chainNow()) + PAYMENT_TTL;
    const hash = await w.actionHash("unfreeze", "0x", await w.nonce(), expiry);
    const id = crypto.randomUUID();
    actions.set(id, { id, wallet: req.body.wallet, expiry, hash });
    res.json({ id, hash, challenge: hash.slice(2, 10) });
  } catch (e) {
    res.status(400).json({ error: e.shortMessage || e.message });
  }
});

app.post("/api/unfreeze/:id", async (req, res) => {
  const a = actions.get(req.params.id);
  if (!a) return res.status(404).json({ error: "unknown request" });
  try {
    const rc = await (await walletAt(a.wallet).unfreeze(a.expiry, hex(req.body.cardSig), req.body.phoneSig)).wait();
    res.json({ status: "active", txHash: rc.hash });
  } catch (e) {
    res.status(400).json({ error: decodeError(e) });
  }
});

// --- payments -----------------------------------------------------------------------------------

// Terminal: merchant typed an amount and the customer tapped. Look up the card's wallet and
// return the 4-byte challenge the card must sign (first 4 bytes of the payment hash).
app.post("/api/pay/start", async (req, res) => {
  try {
    const { cardModulus, amount } = req.body || {};
    const wallet = await factory.walletOf(ethers.keccak256(hex(cardModulus)));
    if (wallet === ethers.ZeroAddress) return res.status(404).json({ error: "card not registered" });
    const w = walletAt(wallet);
    const value = ethers.parseUnits(String(amount), 6);
    const expiry = (await chainNow()) + PAYMENT_TTL;
    const nonce = await w.nonce();
    const h = await w.paymentHash(await token.getAddress(), MERCHANT, value, nonce, expiry);
    const id = crypto.randomUUID();
    payments.set(id, { id, wallet, amount: String(amount), value: value.toString(), expiry, nonce: nonce.toString(), hash: h, status: "waiting_for_card_sig", created: Date.now() });
    res.json({ id, challenge: h.slice(2, 10), wallet });
  } catch (e) {
    res.status(400).json({ error: e.shortMessage || e.message });
  }
});

app.post("/api/pay/:id/card", (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: "unknown payment" });
  p.cardSig = hex(req.body.cardSig);
  // Only the newest tap is approvable: older requests for this wallet are superseded,
  // so the phone never shows a stale sale first.
  for (const q of payments.values()) {
    if (q !== p && q.wallet === p.wallet && q.status === "waiting_for_phone") q.status = "superseded";
  }
  p.status = "waiting_for_phone";
  res.json({ status: p.status });
});

app.get("/api/pay/:id", (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: "unknown payment" });
  res.json(publicPayment(p));
});

// Phone: approve with the passkey.
app.post("/api/pay/:id/phone", async (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: "unknown payment" });
  if (p.status !== "waiting_for_phone") return res.status(409).json({ error: `payment is ${p.status}` });
  p.status = "submitting";
  try {
    const tx = await walletAt(p.wallet).pay(await token.getAddress(), MERCHANT, p.value, p.expiry, p.cardSig, req.body.phoneSig);
    const rc = await tx.wait();
    p.status = "paid";
    p.txHash = rc.hash;
    p.gasUsed = rc.gasUsed.toString();
  } catch (e) {
    p.status = "failed";
    p.error = decodeError(e);
  }
  res.json(publicPayment(p));
});

app.post("/api/pay/:id/reject", (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) return res.status(404).json({ error: "unknown payment" });
  if (p.status === "waiting_for_phone") p.status = "rejected";
  res.json(publicPayment(p));
});

// --- wallet view + freeze --------------------------------------------------------------------

app.get("/api/wallet/:addr", async (req, res) => {
  try {
    const w = walletAt(req.params.addr);
    const [balance, perTx, daily, spent, spentDay, frozen] = await Promise.all([
      token.balanceOf(req.params.addr), w.perTxLimit(), w.dailyLimit(), w.spentToday(), w.spentDay(), w.frozen(),
    ]);
    const now = (await provider.getBlock("latest")).timestamp;
    const today = BigInt(Math.floor(now / 86400));
    const pending = [...payments.values()].filter((p) => p.wallet.toLowerCase() === req.params.addr.toLowerCase() && p.status === "waiting_for_phone");
    const history = [...payments.values()].filter((p) => p.wallet.toLowerCase() === req.params.addr.toLowerCase() && ["paid", "failed", "rejected"].includes(p.status)).slice(-10).reverse();
    res.json({
      wallet: req.params.addr,
      balance: ethers.formatUnits(balance, 6),
      perTxLimit: ethers.formatUnits(perTx, 6),
      dailyLimit: ethers.formatUnits(daily, 6),
      spentToday: ethers.formatUnits(spentDay === today ? spent : 0n, 6),
      frozen,
      pending: pending.map(publicPayment),
      history: history.map(publicPayment),
      merchant: MERCHANT,
    });
  } catch (e) {
    res.status(400).json({ error: e.shortMessage || e.message });
  }
});

app.post("/api/freeze/start", async (req, res) => {
  try {
    const w = walletAt(req.body.wallet);
    const expiry = (await chainNow()) + PAYMENT_TTL;
    const hash = await w.actionHash("freeze", "0x", await w.nonce(), expiry);
    const id = crypto.randomUUID();
    actions.set(id, { id, wallet: req.body.wallet, expiry, hash });
    res.json({ id, hash });
  } catch (e) {
    res.status(400).json({ error: e.shortMessage || e.message });
  }
});

app.post("/api/freeze/:id", async (req, res) => {
  const a = actions.get(req.params.id);
  if (!a) return res.status(404).json({ error: "unknown request" });
  try {
    const rc = await (await walletAt(a.wallet).freeze(a.expiry, req.body.phoneSig)).wait();
    res.json({ status: "frozen", txHash: rc.hash });
  } catch (e) {
    res.status(400).json({ error: decodeError(e) });
  }
});

// --- helpers ------------------------------------------------------------------------------------

function publicPayment(p) {
  const { id, wallet, amount, expiry, hash, status, txHash, error, gasUsed } = p;
  return { id, wallet, amount, expiry, hash, status, txHash, error, gasUsed, merchant: MERCHANT, merchantName: process.env.MERCHANT_NAME || "Tap2ETH Café" };
}

function decodeError(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (data) {
    try {
      return new ethers.Interface(WalletArt.abi).parseError(data)?.name || e.shortMessage;
    } catch {}
  }
  return e.shortMessage || e.message;
}

/** Off-chain copy of the contract's EMV DDA check, used to prove card possession at signup. */
function verifyCardSig(modulusHex, exponentHex, challengeHex, sigHex) {
  const n = BigInt(hex(modulusHex));
  const e = BigInt(hex(exponentHex));
  const len = (hex(modulusHex).length - 2) / 2;
  let base = BigInt(hex(sigHex)) % n, r = 1n, k = e;
  while (k > 0n) { if (k & 1n) r = (r * base) % n; base = (base * base) % n; k >>= 1n; }
  const m = Buffer.from(r.toString(16).padStart(len * 2, "0"), "hex");
  if (m[0] !== 0x6a || m[1] !== 0x05 || m[len - 1] !== 0xbc) return false;
  const h = crypto.createHash("sha1").update(Buffer.concat([m.subarray(1, len - 21), Buffer.from(challengeHex, "hex")])).digest();
  return h.equals(m.subarray(len - 21, len - 1));
}

setup()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`relayer + PWA on http://0.0.0.0:${PORT}`)))
  .catch((e) => {
    console.error("setup failed:", e.message);
    process.exit(1);
  });

// Tap2ETH relayer for the v2 wallet contracts (multi-signer, limits, small card-only payments).
// It passes requests between the merchant terminal and the phone app, collects the signatures,
// then submits the transaction and pays the gas. It can't forge anything: the wallet contract
// checks every signature itself.
//
// Gas protection (what stops someone draining the relayer):
//   1. every call is simulated first, so a bad signature costs no gas;
//   2. it only ever calls our own factory and wallet contracts, which need valid card + phone signatures;
//   3. per-IP rate limits on every write endpoint, and a tighter one on wallet creation;
//   4. a daily gas budget (DAILY_GAS_BUDGET, in the chain's native coin) and a gas price cap (MAX_GAS_PRICE_GWEI);
//   5. it refuses to start on a real network without its own RELAYER_KEY.
// Not covered: it does not yet check that a new card's key really comes from a bank (certificate chain).
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { ethers } = require("ethers");

const PORT = Number(process.env.PORT || 8787);
const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const IS_LOCAL = /127\.0\.0\.1|localhost/.test(RPC);
const STATE_FILE = path.join(__dirname, "state.v2.json");
const ART = path.join(__dirname, "..", "contracts", "artifacts", "contracts");
const DEPLOYMENTS = path.join(__dirname, "..", "contracts", "deployments");
const TTL = 300; // seconds a payment or action request stays valid
const MAX_GAS_PRICE = ethers.parseUnits(process.env.MAX_GAS_PRICE_GWEI || "100", "gwei");
const DAILY_GAS_BUDGET = ethers.parseEther(process.env.DAILY_GAS_BUDGET || "0.5");
const MERCHANT = process.env.MERCHANT_ADDRESS || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Hardhat account #1
const MERCHANT_NAME = process.env.MERCHANT_NAME || "Tap2ETH Café";
const RECOVERY_DELAY = Number(process.env.RECOVERY_DELAY || 86400);

const art = (file, name) => JSON.parse(fs.readFileSync(path.join(ART, file, `${name}.json`)));
const WalletArt = art("v2/Tap2EthV2.sol", "Tap2EthWalletV2");
const FactoryArt = art("v2/Tap2EthV2.sol", "Tap2EthFactoryV2");
const TokenArt = art("TestUSDC.sol", "TestUSDC");
const walletIface = new ethers.Interface(WalletArt.abi);

// batchMaxCount 1: public RPC endpoints (Ankr) reject batched requests as too large.
const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public dev account #0
if (!process.env.RELAYER_KEY && !IS_LOCAL) {
  console.error("RELAYER_KEY is required on a real network (refusing to use the public Hardhat key).");
  process.exit(1);
}
const relayer = new ethers.NonceManager(new ethers.Wallet(process.env.RELAYER_KEY || HARDHAT_KEY, provider));

const coder = ethers.AbiCoder.defaultAbiCoder();
const PHONE_T = "tuple(bytes authenticatorData,string clientDataJSON,uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s)";
const hex = (b) => (String(b).startsWith("0x") ? String(b) : "0x" + b);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const KIND_CARD = 0n;

let state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE)) : {};
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
let factory, token, tokenAddr, decimals, giftable = false, chainKey;
const chainNow = async () => Math.max((await provider.getBlock("latest")).timestamp, Math.floor(Date.now() / 1000));
const walletAt = (a) => new ethers.Contract(a, WalletArt.abi, relayer);
const money = (v) => ethers.formatUnits(v, decimals);
const units = (x) => ethers.parseUnits(String(x), decimals);

// ------------------------------------------------------------------ setup

async function setup() {
  const net = await provider.getNetwork();
  chainKey = String(net.chainId);
  state[chainKey] ||= { wallets: {} };
  const s = state[chainKey];
  const hasCode = async (a) => a && (await provider.getCode(a)) !== "0x";

  // Factory: env, then contracts/deployments/<chainId>.json, then (local chains only) deploy a new one.
  let factoryAddr = process.env.FACTORY_V2;
  const depFile = path.join(DEPLOYMENTS, `${chainKey}.json`);
  if (!factoryAddr && fs.existsSync(depFile)) factoryAddr = JSON.parse(fs.readFileSync(depFile)).factoryV2;
  if (!factoryAddr && (await hasCode(s.factory))) factoryAddr = s.factory;
  if (!(await hasCode(factoryAddr))) {
    if (!IS_LOCAL && !process.env.ALLOW_DEPLOY) throw new Error("No v2 factory found for this chain. Deploy one or set FACTORY_V2.");
    const f = await new ethers.ContractFactory(FactoryArt.abi, FactoryArt.bytecode, relayer).deploy();
    await f.waitForDeployment();
    factoryAddr = await f.getAddress();
  }
  s.factory = factoryAddr;
  factory = new ethers.Contract(factoryAddr, FactoryArt.abi, relayer);

  // Token: the real stablecoin if TOKEN_ADDRESS is set, otherwise a throwaway TestUSDC (local or smoke tests only).
  tokenAddr = process.env.TOKEN_ADDRESS;
  if (tokenAddr) {
    token = new ethers.Contract(tokenAddr, ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "event Transfer(address indexed from, address indexed to, uint256 value)"], relayer);
  } else {
    if (!(await hasCode(s.token))) {
      const t = await new ethers.ContractFactory(TokenArt.abi, TokenArt.bytecode, relayer).deploy();
      await t.waitForDeployment();
      s.token = await t.getAddress();
      save(); // remember it now, so a restart reuses this token instead of deploying another
    }
    tokenAddr = s.token;
    token = new ethers.Contract(tokenAddr, TokenArt.abi, relayer);
    giftable = true;
  }
  decimals = Number(await token.decimals());
  save();
  console.log(`chain ${chainKey}  factory ${factoryAddr}  token ${tokenAddr}${giftable ? " (test token with faucet)" : ""}  relayer ${await relayer.getAddress()}`);
}

// ------------------------------------------------------------------ gas protection

const gas = { day: "", spent: 0n };
function gasGuard() {
  const today = new Date().toISOString().slice(0, 10);
  if (gas.day !== today) { gas.day = today; gas.spent = 0n; }
  if (gas.spent >= DAILY_GAS_BUDGET) throw httpError(503, "The service has used its gas budget for today. Try again tomorrow.");
}
async function priceGuard() {
  const fee = await provider.getFeeData();
  if ((fee.gasPrice ?? 0n) > MAX_GAS_PRICE) throw httpError(503, "Network fees are unusually high right now. Try again soon.");
}
const hits = new Map();
const limit = (name, max, windowMs) => (req, res, next) => {
  const k = `${name}:${req.ip}`;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return res.status(429).json({ error: "Too many requests. Try again in a moment." });
  arr.push(now);
  hits.set(k, arr);
  next();
};
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

/** Simulate first (a failure costs no gas), then send and account for the gas. */
async function send(contract, method, args) {
  gasGuard();
  await priceGuard();
  await contract[method].staticCall(...args); // throws the contract's error without spending gas
  const rc = await (await contract[method](...args)).wait();
  gas.spent += rc.fee ?? 0n;
  return rc;
}

function decodeError(e) {
  if (e?.revert?.name) return e.revert.name;
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (data) { try { const n = walletIface.parseError(data)?.name; if (n) return n; } catch {} }
  const m = /custom error '(\w+)\(/.exec(e?.message || "");
  return m ? m[1] : (e?.shortMessage || e?.message || "Failed");
}

// ------------------------------------------------------------------ wallet helpers

async function signersOf(w) {
  const n = Number(await w.signerCount());
  const out = await Promise.all(Array.from({ length: n }, async (_, id) => {
    const r = await w.getSigner(id);
    return { id, kind: r[0], active: r[1], a: r[2], b: r[3] };
  }));
  return out.filter((s) => s.active);
}
const cardIdOf = (list, modulus) => list.find((s) => s.kind === KIND_CARD && ethers.keccak256(s.a) === ethers.keccak256(hex(modulus)))?.id;
const phoneIdsOf = (list) => list.filter((s) => s.kind !== KIND_CARD).map((s) => s.id);
const cardEntry = (id, sig) => ({ id, data: hex(sig) });
const phoneEntry = (id, ps) => ({ id, data: coder.encode([PHONE_T], [[ps.authenticatorData, ps.clientDataJSON, BigInt(ps.challengeIndex), BigInt(ps.typeIndex), ps.r, ps.s]]) });
const sorted = (entries) => entries.slice().sort((x, y) => x.id - y.id);

/** Tries each registered phone until the contract accepts the signature (usually there is exactly one). */
async function withPhone(contract, method, buildArgs, list, phoneSig) {
  let lastErr;
  for (const id of phoneIdsOf(list)) {
    const args = buildArgs(phoneEntry(id, phoneSig));
    try { await contract[method].staticCall(...args); return args; } catch (e) { lastErr = e; }
  }
  throw lastErr || httpError(400, "No phone is registered on this wallet.");
}

async function spentToday(w) {
  const [spent, day, now] = await Promise.all([w.spentToday(), w.spentDay(), chainNow()]);
  return day === BigInt(Math.floor(now / 86400)) ? spent : 0n;
}

// ------------------------------------------------------------------ app

const app = express();
app.use(express.json({ limit: "64kb" }));
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.status ? e.message : decodeError(e) }); }
};

app.get("/api/health", wrap(async (req, res) => {
  const addr = await relayer.getAddress();
  res.json({ chainId: chainKey, relayer: addr, relayerBalance: ethers.formatEther(await provider.getBalance(addr)), gasSpentToday: ethers.formatEther(gas.spent), dailyGasBudget: ethers.formatEther(DAILY_GAS_BUDGET), factory: await factory.getAddress(), token: tokenAddr });
}));

// --- signup: the card and the phone both sign the creation hash (proof they exist) ---------------

const signups = new Map(); // id -> { params, hash, created }

app.post("/api/signup/start", limit("signup", 10, 3600_000), wrap(async (req, res) => {
  const { phoneX, phoneY, cardModulus, cardExponent } = req.body || {};
  if (!/^0x[0-9a-fA-F]{64}$/.test(phoneX || "") || !/^0x[0-9a-fA-F]{64}$/.test(phoneY || "")) throw httpError(400, "bad phone key");
  const key = ethers.keccak256(hex(cardModulus));
  const existing = await factory.walletOf(key);
  if (existing !== ethers.ZeroAddress) {
    const w = walletAt(existing);
    const phones = (await signersOf(w)).filter((s) => s.kind !== KIND_CARD);
    const mine = phones.some((s) => s.a.toLowerCase() === phoneX.toLowerCase() && s.b.toLowerCase() === phoneY.toLowerCase());
    if (!mine) throw httpError(409, "This card is already linked to another phone.");
    return res.json({ existing: true, wallet: existing });
  }
  const params = { cardModulus: hex(cardModulus), cardExponent: hex(cardExponent), phoneX, phoneY, perTxLimit: units(process.env.PER_TX_LIMIT || 50), dailyLimit: units(process.env.DAILY_LIMIT || 200), recoveryDelay: RECOVERY_DELAY };
  const hash = await factory.createHash(params);
  const id = crypto.randomUUID();
  signups.set(id, { params, hash, created: Date.now() });
  res.json({ id, hash, challenge: hash.slice(2, 10) });
}));

app.post("/api/signup/:id", limit("signup-finish", 10, 3600_000), wrap(async (req, res) => {
  const s = signups.get(req.params.id);
  signups.delete(req.params.id);
  if (!s || Date.now() - s.created > TTL * 1000) throw httpError(400, "Signup expired. Try again.");
  const ps = req.body.phoneSig;
  const args = [s.params, hex(req.body.cardSig), { authenticatorData: ps.authenticatorData, clientDataJSON: ps.clientDataJSON, challengeIndex: ps.challengeIndex, typeIndex: ps.typeIndex, r: ps.r, s: ps.s }];
  const rc = await send(factory, "createWallet", args);
  const wallet = await factory.walletOf(ethers.keccak256(s.params.cardModulus));
  state[chainKey].wallets[wallet] = { names: { 0: "My card" }, createdBlock: rc.blockNumber, history: [] };
  save();
  if (giftable) await send(token, "faucet", [wallet, units(process.env.SIGNUP_GIFT || 100)]);
  res.json({ wallet });
}));

// --- payments --------------------------------------------------------------------------------

const payments = new Map();

// Opens a payment request for a wallet. Used by the terminal (pays the merchant) and by the app's Send (pays any address).
async function openPayment({ cardModulus, amount, to, kind }) {
  const wallet = await factory.walletOf(ethers.keccak256(hex(cardModulus)));
  if (wallet === ethers.ZeroAddress) throw httpError(404, "card not registered");
  const w = walletAt(wallet);
  const [frozen, threshold, softLimit, softCardOnly, perTx, daily, list] = await Promise.all([w.frozen(), w.threshold(), w.softLimit(), w.softCardOnly(), w.perTxLimit(), w.dailyLimit(), signersOf(w)]);
  const value = units(amount);
  if (value <= 0n) throw httpError(400, "Enter an amount above 0.");
  if (frozen) throw httpError(400, "IsFrozen");
  if (value > perTx || (await spentToday(w)) + value > daily) throw httpError(400, "OverLimit");
  const soft = softLimit > 0n && value <= softLimit;
  if (!soft && threshold > 2n) throw httpError(400, `This wallet needs ${threshold} signatures; the terminal supports 2 for now.`);
  const cardId = cardIdOf(list, cardModulus);
  if (cardId === undefined) throw httpError(404, "card not registered");
  const expiry = (await chainNow()) + TTL;
  const nonce = await w.nonce();
  const hash = await w.paymentHash(tokenAddr, to, value, nonce, expiry);
  const id = crypto.randomUUID();
  // A send is always approved with the phone on the same device, so it never uses the card-only shortcut.
  const cardOnly = kind !== "send" && soft && softCardOnly;
  const p = { id, kind, wallet, to, amount: String(amount), value, expiry, hash, cardId, cardOnly, status: "waiting_for_card_sig", created: Date.now() };
  payments.set(id, p);
  return p;
}

// Terminal: the merchant typed an amount and the customer tapped. Returns the 4-byte challenge for the card.
app.post("/api/pay/start", limit("pay-start", 120, 60_000), wrap(async (req, res) => {
  const p = await openPayment({ cardModulus: req.body?.cardModulus, amount: req.body?.amount, to: MERCHANT, kind: "payment" });
  res.json({ id: p.id, challenge: p.hash.slice(2, 10), wallet: p.wallet, cardOnly: p.cardOnly });
}));

// App "Send": the owner pays any address. The same phone taps the card and signs, so the app also gets the hash.
app.post("/api/send/start", limit("send-start", 60, 60_000), wrap(async (req, res) => {
  const { cardModulus, amount, to } = req.body || {};
  if (!ethers.isAddress(to)) throw httpError(400, "That is not a valid address.");
  const dest = ethers.getAddress(to);
  if (dest === ethers.ZeroAddress || dest.toLowerCase() === tokenAddr.toLowerCase()) throw httpError(400, "That address cannot receive money.");
  const p = await openPayment({ cardModulus, amount, to: dest, kind: "send" });
  if (dest.toLowerCase() === p.wallet.toLowerCase()) { payments.delete(p.id); throw httpError(400, "That is your own wallet."); }
  res.json({ id: p.id, challenge: p.hash.slice(2, 10), hash: p.hash, wallet: p.wallet, to: dest, expiry: p.expiry });
}));

async function submitPayment(p, phoneSig) {
  const w = walletAt(p.wallet);
  const list = await signersOf(w);
  p.status = "submitting";
  try {
    let args;
    const build = (extra) => [tokenAddr, p.to, p.value, p.expiry, sorted([cardEntry(p.cardId, p.cardSig), ...extra])];
    if (p.cardOnly) args = build([]);
    else args = await withPhone(w, "pay", (pe) => build([pe]), list, phoneSig);
    const rc = await send(w, "pay", args);
    p.status = "paid";
    p.txHash = rc.hash;
    p.gasUsed = rc.gasUsed.toString();
  } catch (e) {
    p.status = "failed";
    p.error = decodeError(e);
  }
  p.finished = Date.now();
  const rec = state[chainKey].wallets[p.wallet];
  if (rec) { rec.history = [historyItem(p), ...(rec.history || [])].slice(0, 200); save(); }
}

app.post("/api/pay/:id/card", wrap(async (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) throw httpError(404, "unknown payment");
  p.cardSig = hex(req.body.cardSig);
  // Only the newest tap is approvable: older requests for this wallet are superseded.
  for (const q of payments.values()) if (q !== p && q.wallet === p.wallet && q.status === "waiting_for_phone") q.status = "superseded";
  if (p.cardOnly) await submitPayment(p);
  else p.status = "waiting_for_phone";
  res.json(publicPayment(p));
}));

const payStatus = wrap(async (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) throw httpError(404, "unknown payment");
  res.json(publicPayment(p));
});
app.get("/api/pay/:id", payStatus);
app.post("/api/pay/:id", payStatus); // the terminal polls with POST

app.post("/api/pay/:id/phone", wrap(async (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) throw httpError(404, "unknown payment");
  if (p.status !== "waiting_for_phone") throw httpError(409, `payment is ${p.status}`);
  if ((await chainNow()) > p.expiry) { p.status = "failed"; p.error = "Expired"; return res.json(publicPayment(p)); }
  await submitPayment(p, req.body.phoneSig);
  res.json(publicPayment(p));
}));

app.post("/api/pay/:id/reject", wrap(async (req, res) => {
  const p = payments.get(req.params.id);
  if (!p) throw httpError(404, "unknown payment");
  if (p.status === "waiting_for_phone") {
    p.status = "rejected";
    p.finished = Date.now();
    const rec = state[chainKey].wallets[p.wallet];
    if (rec) { rec.history = [historyItem(p), ...(rec.history || [])].slice(0, 200); save(); }
  }
  res.json(publicPayment(p));
}));

// --- wallet changes that need the full threshold: limits, small payments, add a card, unfreeze ------

const actions = new Map();

async function actionHash(w, action, params, expiry) {
  switch (action) {
    case "freeze": return w.actionHash("freeze", "0x", expiry);
    case "unfreeze": return w.actionHash("unfreeze", "0x", expiry);
    case "limits": return w.actionHash("limits", coder.encode(["uint256", "uint256"], [units(params.perTx), units(params.daily)]), expiry);
    case "soft": return w.actionHash("softLimit", coder.encode(["uint256", "bool"], [units(params.amount || 0), !!params.cardOnly]), expiry);
    case "addCard": return w.actionHash("addSigner", coder.encode(["uint8", "bytes32", "bytes32"], [0, ethers.keccak256(hex(params.cardModulus)), ethers.keccak256(hex(params.cardExponent))]), expiry);
    default: throw httpError(400, "unknown action");
  }
}

async function startAction(req, res, action, wallet, params) {
  const w = walletAt(wallet);
  const expiry = (await chainNow()) + TTL;
  const hash = await actionHash(w, action, params || {}, expiry);
  const id = crypto.randomUUID();
  actions.set(id, { id, wallet, action, params: params || {}, expiry, hash, created: Date.now() });
  res.json({ id, hash, challenge: hash.slice(2, 10) });
}

async function finishAction(a, body) {
  const w = walletAt(a.wallet);
  const list = await signersOf(w);
  const cardId = body.cardModulus ? cardIdOf(list, body.cardModulus) : list.filter((s) => s.kind === KIND_CARD)[0]?.id;
  const needCard = a.action !== "freeze";
  if (needCard && cardId === undefined) throw httpError(400, "That card isn't part of this wallet.");
  const base = needCard ? [cardEntry(cardId, body.cardSig)] : [];
  const p = a.params;
  const call = {
    freeze: ["freeze", (pe) => [a.expiry, sorted([...base, pe])]],
    unfreeze: ["unfreeze", (pe) => [a.expiry, sorted([...base, pe])]],
    limits: ["setLimits", (pe) => [units(p.perTx), units(p.daily), a.expiry, sorted([...base, pe])]],
    soft: ["setSoftLimit", (pe) => [units(p.amount || 0), !!p.cardOnly, a.expiry, sorted([...base, pe])]],
    addCard: ["addSigner", (pe) => [KIND_CARD, hex(p.cardModulus), hex(p.cardExponent), a.expiry, sorted([...base, pe]), hex(body.newCardSig)]],
  }[a.action];
  const [method, build] = call;
  const args = await withPhone(w, method, build, list, body.phoneSig);
  const rc = await send(w, method, args);
  if (a.action === "addCard") {
    const rec = (state[chainKey].wallets[a.wallet] ||= { names: {}, history: [] });
    const after = await signersOf(w);
    const newId = cardIdOf(after, p.cardModulus);
    rec.names[newId] = String(p.name || `Card ${newId}`).slice(0, 24);
    save();
  }
  return rc;
}

app.post("/api/action/start", limit("action", 30, 60_000), wrap(async (req, res) => {
  const { wallet, action, params } = req.body || {};
  if (!ethers.isAddress(wallet)) throw httpError(400, "bad wallet");
  if (!["limits", "soft", "addCard"].includes(action)) throw httpError(400, "unknown action");
  await startAction(req, res, action, wallet, params);
}));
app.post("/api/action/:id", limit("action-finish", 30, 60_000), wrap(async (req, res) => {
  const a = actions.get(req.params.id);
  if (!a) throw httpError(404, "unknown request");
  if ((await chainNow()) > a.expiry) { actions.delete(a.id); throw httpError(400, "Expired"); }
  actions.delete(a.id);
  const rc = await finishAction(a, req.body || {});
  res.json({ status: "done", txHash: rc.hash });
}));

app.post("/api/freeze/start", limit("action", 30, 60_000), wrap(async (req, res) => startAction(req, res, "freeze", req.body.wallet)));
app.post("/api/freeze/:id", wrap(async (req, res) => {
  const a = actions.get(req.params.id);
  if (!a) throw httpError(404, "unknown request");
  actions.delete(a.id);
  const rc = await finishAction(a, req.body || {});
  res.json({ status: "frozen", txHash: rc.hash });
}));
app.post("/api/unfreeze/start", limit("action", 30, 60_000), wrap(async (req, res) => startAction(req, res, "unfreeze", req.body.wallet)));
app.post("/api/unfreeze/:id", wrap(async (req, res) => {
  const a = actions.get(req.params.id);
  if (!a) throw httpError(404, "unknown request");
  actions.delete(a.id);
  const rc = await finishAction(a, req.body || {});
  res.json({ status: "active", txHash: rc.hash });
}));

// --- wallet view for the app -----------------------------------------------------------------

const receivedCache = new Map(); // wallet -> { at, items }
async function received(wallet, fromBlock) {
  const c = receivedCache.get(wallet);
  if (c && Date.now() - c.at < 15_000) return c.items;
  const logs = await token.queryFilter(token.filters.Transfer(null, wallet), fromBlock || 0);
  const items = [];
  for (const l of logs.slice(-30)) {
    const b = await provider.getBlock(l.blockNumber);
    items.push({ id: `${l.transactionHash}:${l.index}`, kind: "received", merchantName: "Received", from: l.args[0] === ethers.ZeroAddress ? "Test deposit" : short(l.args[0]), amount: money(l.args[2]), status: "paid", time: b.timestamp * 1000, txHash: l.transactionHash });
  }
  receivedCache.set(wallet, { at: Date.now(), items });
  return items;
}

function historyItem(p) {
  if (p.kind === "send") return { id: p.id, kind: "sent", merchantName: short(p.to), to: p.to, amount: p.amount, status: p.status, error: p.error, txHash: p.txHash, time: p.finished || p.created };
  return { id: p.id, kind: "payment", merchantName: MERCHANT_NAME, amount: p.amount, status: p.status, error: p.error, cardOnly: !!p.cardOnly, txHash: p.txHash, time: p.finished || p.created };
}
function publicPayment(p) {
  const { id, wallet, amount, expiry, hash, status, txHash, error, gasUsed, cardOnly, kind, to } = p;
  return { id, wallet, amount, expiry, hash, status, txHash, error, gasUsed, cardOnly, kind, to, merchant: to || MERCHANT, merchantName: kind === "send" ? short(to) : MERCHANT_NAME };
}

app.get("/api/wallet/:addr", wrap(async (req, res) => {
  const addr = req.params.addr;
  if (!ethers.isAddress(addr)) throw httpError(400, "bad wallet");
  const w = walletAt(addr);
  const rec = state[chainKey].wallets[addr] || { names: {}, history: [] };
  const [balance, perTx, daily, spent, frozen, softLimit, softCardOnly, threshold, list] = await Promise.all([token.balanceOf(addr), w.perTxLimit(), w.dailyLimit(), spentToday(w), w.frozen(), w.softLimit(), w.softCardOnly(), w.threshold(), signersOf(w)]);
  const pending = [...payments.values()].filter((p) => p.wallet.toLowerCase() === addr.toLowerCase() && p.kind !== "send" && p.status === "waiting_for_phone").map(publicPayment);
  const history = [...(rec.history || []), ...(await received(addr, rec.createdBlock))].sort((x, y) => y.time - x.time).slice(0, 50);
  res.json({
    v2: true,
    wallet: addr,
    balance: money(balance),
    perTxLimit: money(perTx),
    dailyLimit: money(daily),
    spentToday: money(spent),
    frozen,
    softLimit: money(softLimit),
    softCardOnly,
    threshold: Number(threshold),
    cards: list.filter((s) => s.kind === KIND_CARD).map((s) => ({ id: s.id, name: rec.names?.[s.id] || `Card ${s.id + 1}`, active: true })),
    pending,
    history,
    merchant: MERCHANT,
  });
}));

app.get("/", (req, res) => res.type("text").send("Tap2ETH relayer v2. See /api/health."));

setup()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log(`relayer v2 on http://0.0.0.0:${PORT}`)))
  .catch((e) => { console.error("setup failed:", e.message); process.exit(1); });

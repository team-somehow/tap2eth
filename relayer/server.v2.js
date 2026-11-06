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
// NETWORK picks the chain: "whitechain" (Whitechain testnet, 1874), "arc" (Arc testnet, 5042002, gas paid in USDC) or
// "sepolia" (Ethereum Sepolia, 11155111: the customer's ETH is swapped to the merchant's USDT on Uniswap v3).
// Unset = whatever RPC_URL points at (local Hardhat by default).
const NETWORKS = {
  whitechain: { chainId: 1874, name: "Whitechain testnet", rpc: "https://rpc.testnet.whitechain.io", rpcBackups: ["https://rpc.ankr.com/whitechain_testnet"], explorer: "https://explorer.testnet.whitechain.io", symbol: "USDT", keyEnv: "RELAYER_KEY", tokenEnv: "TOKEN_ADDRESS", token: null, gasPrice: "100", batch: 10 },
  arc: { chainId: 5042002, name: "Arc testnet", rpc: "https://rpc.testnet.arc.network", rpcBackups: ["https://rpc.testnet.arc.io"], explorer: "https://explorer.testnet.arc.io", symbol: "USDC", keyEnv: "ARC_RELAYER_KEY", tokenEnv: "ARC_TOKEN_ADDRESS", token: "0x3600000000000000000000000000000000000000", gasPrice: "200", batch: 10 },
  // Swap mode: wallets hold ETH, and a payment swaps it to exactly the USDT amount with the merchant as the swap recipient.
  sepolia: { chainId: 11155111, name: "Ethereum Sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com", rpcBackups: ["https://sepolia.drpc.org"], explorer: "https://sepolia.etherscan.io", symbol: "USDT", keyEnv: "RELAYER_KEY", tokenEnv: "SEPOLIA_TOKEN_ADDRESS", token: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0", gasPrice: "50", batch: 1,
    swap: { dex: "Uniswap v3", router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E", quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3", weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", fees: [500, 3000, 10000], slippageBps: 100n } },
};
const NETWORK = (process.env.NETWORK || "").toLowerCase();
if (NETWORK && !NETWORKS[NETWORK]) { console.error(`NETWORK must be "whitechain", "arc" or "sepolia", not "${NETWORK}".`); process.exit(1); }
const NET = NETWORKS[NETWORK] || { name: "Local chain", explorer: "", symbol: "USDC", keyEnv: "RELAYER_KEY", tokenEnv: "TOKEN_ADDRESS", gasPrice: "100" };
const RPC = NETWORK ? (process.env[`${NETWORK.toUpperCase()}_RPC_URL`] || NET.rpc) : (process.env.RPC_URL || "http://127.0.0.1:8545");
const NET_KEY = process.env[NET.keyEnv] || (NETWORK ? "" : process.env.RELAYER_KEY);
const NET_TOKEN = process.env[NET.tokenEnv] || NET.token || (NETWORK ? "" : process.env.TOKEN_ADDRESS);
// POWERED_BY=off hides the "Powered by <chain>" badge in the app and on the terminal; anything else shows it.
const POWERED_BY = NETWORK && !/^(off|none|no|false|0)$/i.test(process.env.POWERED_BY || "on") ? { arc: "Arc", whitechain: "Whitechain", sepolia: "Ethereum Sepolia" }[NETWORK] : "";
const SWAP = NET.swap || null; // set on networks where payments are ETH -> USDT swaps
const NET_INFO = { network: NETWORK || "local", name: NET.name, explorer: NET.explorer, symbol: NET.symbol, poweredBy: POWERED_BY, ...(SWAP ? { swap: { dex: SWAP.dex, ethSymbol: "ETH" } } : {}) };
const IS_LOCAL = /127\.0\.0\.1|localhost/.test(RPC);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "state.v2.json");
const ART = path.join(__dirname, "..", "contracts", "artifacts", "contracts");
const DEPLOYMENTS = path.join(__dirname, "..", "contracts", "deployments");
const TTL = 300; // seconds a payment or action request stays valid
const MAX_GAS_PRICE = ethers.parseUnits(process.env.MAX_GAS_PRICE_GWEI || NET.gasPrice, "gwei");
const DAILY_GAS_BUDGET = ethers.parseEther(process.env.DAILY_GAS_BUDGET || "0.5");
// Where every terminal (POS) payment goes: the cafe owner's wallet. The terminal never chooses the receiver.
// Only the address is used here; CAFE_OWNER_KEY in .env is for the owner to move the money later, never read by the server.
const MERCHANT_RAW = process.env.CAFE_OWNER_ADDRESS || process.env.MERCHANT_ADDRESS || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // last: Hardhat account #1
if (!ethers.isAddress(MERCHANT_RAW)) throw new Error(`CAFE_OWNER_ADDRESS is not a valid address: ${MERCHANT_RAW}`);
const MERCHANT = ethers.getAddress(MERCHANT_RAW);
const MERCHANT_NAME = process.env.MERCHANT_NAME || "Team Somehow Café";
const RECOVERY_DELAY = Number(process.env.RECOVERY_DELAY || 86400);
// Wallet creations and recoveries allowed per IP per hour. Generous by default so a hackathon demo (many sign-ups from
// one laptop and one network) never hits it; set SIGNUP_LIMIT=10 on a public deployment.
const SIGNUP_LIMIT = Number(process.env.SIGNUP_LIMIT || 1000);

const art = (file, name) => JSON.parse(fs.readFileSync(path.join(ART, file, `${name}.json`)));
const WalletArt = SWAP ? art("swap/Tap2EthSwap.sol", "Tap2EthWalletSwap") : art("v2/Tap2EthV2.sol", "Tap2EthWalletV2");
// Tap2Eth is the single contract (registry + wallet logic). Its ABI also covers the older separate factory.
const FactoryArt = SWAP ? art("swap/Tap2EthSwap.sol", "Tap2EthFactorySwap") : fs.existsSync(path.join(ART, "v2/Tap2Eth.sol")) ? art("v2/Tap2Eth.sol", "Tap2Eth") : art("v2/Tap2EthV2.sol", "Tap2EthFactoryV2");
const TokenArt = art("TestUSDC.sol", "TestUSDC");
const walletIface = new ethers.Interface(WalletArt.abi);

// batchMaxCount 1: public RPC endpoints (Ankr) reject batched requests as too large.
// A flaky connection (DNS or timeouts) must not fail a payment: retry once, then try the backup RPC servers.
const TRANSIENT = /cancel|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|socket hang up|fetch failed|timeout|TLS|SERVER_ERROR|UND_ERR|network/i;
class FailoverProvider extends ethers.JsonRpcProvider {
  constructor(urls) {
    // With a known chain ID, skip ethers' network-detection calls (they loop with "failed to detect network" when a node is slow).
    const known = NET.chainId ? ethers.Network.from(NET.chainId) : undefined;
    const opts = { batchMaxCount: NET.batch || 1, ...(known ? { staticNetwork: known } : {}) };
    super(urls[0], known, opts);
    this.backups = urls.slice(1).map((u) => new ethers.JsonRpcProvider(u, known, opts));
  }
  async send(method, params) {
    let last;
    for (const next of [null, null, ...this.backups]) {
      try { return await (next ? next.send(method, params) : super.send(method, params)); } catch (e) {
        last = e;
        if (!TRANSIENT.test(`${e.message} ${e.code} ${e.cause?.code || ""}`)) throw e; // a real answer (revert, bad request): don't retry
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw last;
  }
}
const provider = new FailoverProvider([RPC, ...(NET.rpcBackups || []), ...(process.env[`${NETWORK.toUpperCase()}_RPC_BACKUP_URL`] ? [process.env[`${NETWORK.toUpperCase()}_RPC_BACKUP_URL`]] : [])]);
const HARDHAT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public dev account #0
if (!NET_KEY && !IS_LOCAL) {
  console.error(`${NET.keyEnv} is required on a real network (refusing to use the public Hardhat key).`);
  process.exit(1);
}
const relayer = new ethers.NonceManager(new ethers.Wallet(NET_KEY || HARDHAT_KEY, provider));

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

// --- Uniswap v3 quote (swap mode): the ETH needed for EXACTLY `out` USDT. Tries every fee tier, takes the cheapest.
const quoterIface = SWAP && new ethers.Interface(["function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160, uint32, uint256)"]);
async function quoteSwap(out) {
  let best;
  for (const fee of SWAP.fees) {
    try {
      const raw = await provider.call({ to: SWAP.quoter, data: quoterIface.encodeFunctionData("quoteExactOutputSingle", [{ tokenIn: SWAP.weth, tokenOut: tokenAddr, amount: out, fee, sqrtPriceLimitX96: 0 }]) });
      const amountIn = quoterIface.decodeFunctionResult("quoteExactOutputSingle", raw)[0];
      if (!best || amountIn < best.quote) best = { fee, quote: amountIn };
    } catch { /* no pool at this fee tier, or not enough liquidity */ }
  }
  if (!best) throw httpError(400, "No Uniswap pool can swap that amount right now.");
  return { fee: best.fee, quote: best.quote, max: best.quote + (best.quote * SWAP.slippageBps) / 10000n };
}
const swapInfo = (q) => ({ dex: SWAP.dex, fee: q.fee, ethQuote: ethers.formatEther(q.quote), ethMax: ethers.formatEther(q.max), slippagePct: Number(SWAP.slippageBps) / 100 });

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
  if (!factoryAddr && fs.existsSync(depFile)) { const d = JSON.parse(fs.readFileSync(depFile)); factoryAddr = SWAP ? d.factorySwap : d.factoryV2; }
  if (!factoryAddr && (await hasCode(s.factory))) factoryAddr = s.factory;
  if (!(await hasCode(factoryAddr))) {
    if (!IS_LOCAL && !process.env.ALLOW_DEPLOY) throw new Error("No v2 factory found for this chain. Deploy one or set FACTORY_V2.");
    if (SWAP) throw new Error("Deploy the swap factory first: npx hardhat run scripts/deploySwap.js --network sepolia");
    const f = await new ethers.ContractFactory(FactoryArt.abi, FactoryArt.bytecode, relayer).deploy();
    await f.waitForDeployment();
    factoryAddr = await f.getAddress();
  }
  s.factory = factoryAddr;
  factory = new ethers.Contract(factoryAddr, FactoryArt.abi, relayer);

  // Token: the real stablecoin if TOKEN_ADDRESS is set, otherwise a throwaway TestUSDC (local or smoke tests only).
  tokenAddr = NET_TOKEN;
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
  console.log(`network ${NET_INFO.name}  chain ${chainKey}  factory ${factoryAddr}  token ${tokenAddr}${giftable ? " (test token with faucet)" : ""}  relayer ${await relayer.getAddress()}`);
  console.log(`terminal payments go to the cafe owner ${MERCHANT}`);
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
  let tx;
  try { tx = await contract[method](...args); } catch (e) {
    // Something else used this account's nonce (another tool, a manual transfer): re-read it once and retry.
    if (!/nonce/i.test(`${e?.code} ${e?.shortMessage || ""} ${e?.message || ""}`)) throw e;
    relayer.reset();
    tx = await contract[method](...args);
  }
  const rc = await tx.wait();
  gas.spent += rc.fee ?? 0n;
  chainViews.clear(); // balances and settings changed
  return rc;
}

function decodeError(e) {
  // A dropped connection to the chain is not the customer's mistake and not a cancel: say what happened.
  if (/CANCELLED|TIMEOUT|NETWORK_ERROR|SERVER_ERROR|ECONNRESET|ENOTFOUND|ETIMEDOUT|request timeout|cancelled before sending|socket|TLS/i.test(`${e?.code} ${e?.shortMessage || ""} ${e?.message || ""}`)) return "The blockchain connection dropped. Nothing was paid. Try again in a moment.";
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
  try { await fn(req, res); } catch (e) {
    // Someone else sent a transaction from the relayer's account (a manual transfer): our saved counter is behind.
    // Re-read it from the chain so the next request works.
    if (/nonce (has already been used|too low)|NONCE_EXPIRED/i.test(`${e.message} ${e.code} ${e.shortMessage || ""}`)) { relayer.reset(); console.log("relayer nonce out of date, reset"); }
    res.status(e.status || 400).json({ error: e.status ? e.message : decodeError(e) }); }
};

app.get("/api/health", wrap(async (req, res) => {
  const addr = await relayer.getAddress();
  res.json({ chainId: chainKey, relayer: addr, relayerBalance: ethers.formatEther(await provider.getBalance(addr)), gasSpentToday: ethers.formatEther(gas.spent), dailyGasBudget: ethers.formatEther(DAILY_GAS_BUDGET), factory: await factory.getAddress(), token: tokenAddr });
}));

// --- signup: the card and the phone both sign the creation hash (proof they exist) ---------------

const signups = new Map(); // id -> { params, hash, created }

app.post("/api/signup/start", limit("signup", SIGNUP_LIMIT, 3600_000), wrap(async (req, res) => {
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
  const params = { cardModulus: hex(cardModulus), cardExponent: hex(cardExponent), phoneX, phoneY, perTxLimit: units(process.env.PER_TX_LIMIT || 50), dailyLimit: units(process.env.DAILY_LIMIT || 50), recoveryDelay: RECOVERY_DELAY };
  const hash = await factory.createHash(params);
  const id = crypto.randomUUID();
  signups.set(id, { params, hash, created: Date.now() });
  res.json({ id, hash, challenge: hash.slice(2, 10) });
}));

app.post("/api/signup/:id", limit("signup-finish", SIGNUP_LIMIT, 3600_000), wrap(async (req, res) => {
  const s = signups.get(req.params.id);
  signups.delete(req.params.id);
  if (!s || Date.now() - s.created > TTL * 1000) throw httpError(400, "Signup expired. Try again.");
  const ps = req.body.phoneSig;
  const args = [s.params, hex(req.body.cardSig), { authenticatorData: ps.authenticatorData, clientDataJSON: ps.clientDataJSON, challengeIndex: ps.challengeIndex, typeIndex: ps.typeIndex, r: ps.r, s: ps.s }];
  const rc = await send(factory, "createWallet", args);
  // Take the address from the receipt, not from a fresh chain read: a load-balanced public RPC can answer the read
  // from a node that has not seen the new block yet and return the zero address.
  const created = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "WalletCreated");
  const wallet = created ? created.args.wallet : await factory.walletOf(ethers.keccak256(s.params.cardModulus));
  if (wallet === ethers.ZeroAddress) throw httpError(503, "The wallet was created but the network is slow to show it. Try again in a moment.");
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
  const [frozen, threshold, softLimit, softCardOnly, perTx, daily, list, balance] = await Promise.all([w.frozen(), w.threshold(), w.softLimit(), w.softCardOnly(), w.perTxLimit(), w.dailyLimit(), signersOf(w), SWAP ? provider.getBalance(wallet) : token.balanceOf(wallet)]);
  const value = units(amount);
  if (value <= 0n) throw httpError(400, "Enter an amount above 0.");
  if (frozen) throw httpError(400, "IsFrozen");
  if (value > perTx || (await spentToday(w)) + value > daily) throw httpError(400, "OverLimit");
  const q = SWAP ? await quoteSwap(value) : null; // swap mode: what the customer will pay, in ETH
  if (SWAP ? balance < q.max : balance < value) throw httpError(400, "InsufficientBalance"); // fail now, not after the phone approves
  const soft = softLimit > 0n && value <= softLimit;
  if (!soft && threshold > 2n) throw httpError(400, `This wallet needs ${threshold} signatures; the terminal supports 2 for now.`);
  const cardId = cardIdOf(list, cardModulus);
  if (cardId === undefined) throw httpError(404, "card not registered");
  const expiry = (await chainNow()) + TTL;
  const nonce = await w.nonce();
  const hash = SWAP ? await w.swapPaymentHash(to, value, q.max, q.fee, nonce, expiry) : await w.paymentHash(tokenAddr, to, value, nonce, expiry);
  const id = crypto.randomUUID();
  // A send is always approved with the phone on the same device, so it never uses the card-only shortcut.
  const cardOnly = kind !== "send" && soft && softCardOnly;
  const p = { id, kind, wallet, to, amount: String(amount), value, expiry, hash, cardId, cardOnly, status: "waiting_for_card_sig", created: Date.now(), ...(q ? { swap: q } : {}) };
  payments.set(id, p);
  return p;
}

// Terminal: the merchant typed an amount and the customer tapped. Returns the 4-byte challenge for the card.
app.post("/api/pay/start", limit("pay-start", 120, 60_000), wrap(async (req, res) => {
  const p = await openPayment({ cardModulus: req.body?.cardModulus, amount: req.body?.amount, to: MERCHANT, kind: "payment" });
  res.json({ id: p.id, challenge: p.hash.slice(2, 10), wallet: p.wallet, cardOnly: p.cardOnly, ...(p.swap ? { swap: swapInfo(p.swap) } : {}) });
}));

// --- terminal-side checks ("edge"): the terminal reads the chain itself, checks the payment and has the card
// sign the hash before it calls us, so a tap costs one round trip here instead of two plus our chain reads.

// Public facts the terminal needs to build the same payment hash. Nothing secret.
app.get("/api/terminal/config", wrap(async (req, res) => {
  // Swap mode: the terminal cannot rebuild the hash itself (it needs a live Uniswap quote), so it uses /api/pay/start.
  if (SWAP) return res.json({ v: 2, mode: "swap", chainId: Number(chainKey), merchant: MERCHANT, merchantName: MERCHANT_NAME, ttl: TTL, ...NET_INFO });
  res.json({ v: 2, chainId: Number(chainKey), factory: await factory.getAddress(), token: tokenAddr, decimals, merchant: MERCHANT, merchantName: MERCHANT_NAME, ttl: TTL, ...NET_INFO });
}));

const walletByCard = new Map(); // keccak(card modulus) -> wallet; a card's wallet never changes
const PAY_TAG = "TAP2ETH_V2_PAY";

// The terminal already checked the wallet and got the card's signature. We don't take its word for anything:
// the hash is rebuilt here with OUR merchant and token and the wallet's current nonce, and must match exactly.
// The contract checks the card signature, the limits and the balance again when the payment is sent.
app.post("/api/pay/tapped", limit("pay-start", 120, 60_000), wrap(async (req, res) => {
  if (SWAP) throw httpError(400, "Use /api/pay/start on this network.");
  const { cardModulus, cardId, amount, nonce, expiry, hash, cardSig } = req.body || {};
  if (!/^(0x)?[0-9a-fA-F]+$/.test(cardModulus || "") || !/^(0x)?[0-9a-fA-F]+$/.test(cardSig || "")) throw httpError(400, "bad card data");
  if (!Number.isInteger(cardId) || cardId < 0) throw httpError(400, "bad card id");
  const value = units(amount);
  if (value <= 0n) throw httpError(400, "Enter an amount above 0.");
  const key = ethers.keccak256(hex(cardModulus));
  let wallet = walletByCard.get(key);
  if (!wallet) {
    wallet = await factory.walletOf(key);
    if (wallet === ethers.ZeroAddress) throw httpError(404, "card not registered");
    walletByCard.set(key, wallet);
  }
  const w = walletAt(wallet);
  const [current, softLimit, softCardOnly, now] = await Promise.all([w.nonce(), w.softLimit(), w.softCardOnly(), chainNow()]);
  const exp = Number(expiry);
  if (BigInt(nonce) !== current) throw httpError(409, "Stale tap: the wallet changed. Tap again.");
  if (!(exp > now && exp <= now + TTL + 120)) throw httpError(400, "Expired");
  const expected = ethers.keccak256(coder.encode(["string", "uint256", "address", "address", "address", "uint256", "uint256", "uint256"],
    [PAY_TAG, BigInt(chainKey), wallet, tokenAddr, MERCHANT, value, current, BigInt(exp)]));
  if (expected.toLowerCase() !== String(hash).toLowerCase()) throw httpError(400, "The terminal's payment didn't match. Tap again.");
  const soft = softLimit > 0n && value <= softLimit;
  const p = { id: crypto.randomUUID(), kind: "payment", wallet, to: MERCHANT, amount: String(amount), value, expiry: exp, hash: expected,
    cardId, cardOnly: soft && softCardOnly, cardSig: hex(cardSig), status: "waiting_for_card_sig", created: Date.now(), edge: true };
  payments.set(p.id, p);
  for (const q of payments.values()) if (q !== p && q.wallet === p.wallet && q.status === "waiting_for_phone") q.status = "superseded";
  if (p.cardOnly) await submitPayment(p);
  else p.status = "waiting_for_phone";
  res.json({ ...publicPayment(p), id: p.id });
}));

// App "Send": the owner pays any address. The same phone taps the card and signs, so the app also gets the hash.
app.post("/api/send/start", limit("send-start", 60, 60_000), wrap(async (req, res) => {
  const { cardModulus, amount, to } = req.body || {};
  if (!ethers.isAddress(to)) throw httpError(400, "That is not a valid address.");
  const dest = ethers.getAddress(to);
  if (dest === ethers.ZeroAddress || dest.toLowerCase() === tokenAddr.toLowerCase()) throw httpError(400, "That address cannot receive money.");
  const p = await openPayment({ cardModulus, amount, to: dest, kind: "send" });
  if (dest.toLowerCase() === p.wallet.toLowerCase()) { payments.delete(p.id); throw httpError(400, "That is your own wallet."); }
  res.json({ id: p.id, challenge: p.hash.slice(2, 10), hash: p.hash, wallet: p.wallet, to: dest, expiry: p.expiry, ...(p.swap ? { swap: swapInfo(p.swap) } : {}) });
}));

async function submitPayment(p, phoneSig) {
  const w = walletAt(p.wallet);
  const list = await signersOf(w);
  p.status = "submitting";
  try {
    let args;
    const build = SWAP
      ? (extra) => [p.to, p.value, p.swap.max, p.swap.fee, p.expiry, sorted([cardEntry(p.cardId, p.cardSig), ...extra])]
      : (extra) => [tokenAddr, p.to, p.value, p.expiry, sorted([cardEntry(p.cardId, p.cardSig), ...extra])];
    const method = SWAP ? "payWithSwap" : "pay";
    if (p.cardOnly) args = build([]);
    else args = await withPhone(w, method, (pe) => build([pe]), list, phoneSig);
    const rc = await send(w, method, args);
    if (SWAP) { // the ETH the swap really cost, from the wallet's PaidWithSwap event
      const ev = rc.logs.map((l) => { try { return walletIface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "PaidWithSwap");
      if (ev) p.ethPaid = ethers.formatEther(ev.args.ethIn);
    }
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
    case "cancelPhoneRecovery": return w.actionHash("cancelPhoneRecovery", "0x", expiry);
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
  const needCard = a.action !== "freeze" && a.action !== "cancelPhoneRecovery"; // a phone alone can freeze or cancel
  if (needCard && cardId === undefined) throw httpError(400, "That card isn't part of this wallet.");
  const base = needCard ? [cardEntry(cardId, body.cardSig)] : [];
  const p = a.params;
  const call = {
    freeze: ["freeze", (pe) => [a.expiry, sorted([...base, pe])]],
    unfreeze: ["unfreeze", (pe) => [a.expiry, sorted([...base, pe])]],
    cancelPhoneRecovery: ["cancelPhoneRecovery", (pe) => [a.expiry, sorted([...base, pe])]],
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

// --- lost phone: two cards (no phone signature) replace the phone after a delay -------------------

const RECOVERY_TTL = 900; // seconds to tap two cards and confirm with the fingerprint
const recoveries = new Map(); // id -> { wallet, x, y, expiry, hash, created }
const isKey32 = (v) => /^0x[0-9a-fA-F]{64}$/.test(v || "");
const phoneIsSigner = (list, x, y) => list.some((s) => s.kind !== KIND_CARD && s.a.toLowerCase() === x.toLowerCase() && s.b.toLowerCase() === y.toLowerCase());
function ensureRecord(wallet) {
  const rec = (state[chainKey].wallets[wallet] ||= { names: {}, history: [] });
  if (!Array.isArray(rec.received)) rec.received = [];
  save();
}

// The first card tapped on the new phone finds the wallet. Returns the 4-byte challenge for that card.
app.post("/api/recover/start", limit("recover", SIGNUP_LIMIT, 3600_000), wrap(async (req, res) => {
  const { cardModulus, phoneX, phoneY } = req.body || {};
  if (!isKey32(phoneX) || !isKey32(phoneY)) throw httpError(400, "bad phone key");
  const wallet = await factory.walletOf(ethers.keccak256(hex(cardModulus)));
  if (wallet === ethers.ZeroAddress) throw httpError(404, "No wallet was found for this card.");
  const w = walletAt(wallet);
  const list = await signersOf(w);
  ensureRecord(wallet);
  if (phoneIsSigner(list, phoneX, phoneY)) return res.json({ existing: true, wallet }); // this phone is already a signer
  if (list.filter((s) => s.kind === KIND_CARD).length < 2) {
    throw httpError(400, "This wallet has only one card. Recovery needs two cards, so add a second card while you still have your phone.");
  }
  const pr = await w.phoneRecovery();
  if (pr.readyAt > 0n) {
    if (pr.x.toLowerCase() === phoneX.toLowerCase() && pr.y.toLowerCase() === phoneY.toLowerCase()) return res.json({ pending: true, wallet, readyAt: Number(pr.readyAt), now: await chainNow() });
    throw httpError(409, "Another phone replacement is already waiting on this wallet.");
  }
  const expiry = (await chainNow()) + RECOVERY_TTL;
  const hash = await w.phoneRecoveryHash(phoneX, phoneY, expiry);
  const id = crypto.randomUUID();
  recoveries.set(id, { wallet, x: phoneX, y: phoneY, expiry, hash, created: Date.now() });
  res.json({ id, wallet, hash, challenge: hash.slice(2, 10), expiry, delay: Number(await w.recoveryDelay()) });
}));

// Anyone can finish a replacement once the delay has passed.
app.post("/api/recover/finish", limit("recover-finish", 30, 60_000), wrap(async (req, res) => {
  const { wallet } = req.body || {};
  if (!ethers.isAddress(wallet) || !state[chainKey].wallets[wallet]) throw httpError(400, "bad wallet");
  const rc = await send(walletAt(wallet), "executePhoneRecovery", []);
  res.json({ status: "done", txHash: rc.hash });
}));

// Two different cards signed the same 4-byte challenge, and the new phone signed the full hash.
app.post("/api/recover/:id", limit("recover-submit", SIGNUP_LIMIT, 3600_000), wrap(async (req, res) => {
  const r = recoveries.get(req.params.id);
  if (!r) throw httpError(404, "This recovery request expired. Start again.");
  recoveries.delete(r.id);
  if (Date.now() - r.created > RECOVERY_TTL * 1000) throw httpError(400, "Expired");
  const { cards, phoneSig } = req.body || {};
  if (!Array.isArray(cards) || cards.length < 2) throw httpError(400, "Two cards are needed.");
  const w = walletAt(r.wallet);
  const list = await signersOf(w);
  const entries = cards.map((c) => {
    const id = cardIdOf(list, c.cardModulus);
    if (id === undefined) throw httpError(400, "One of those cards isn't part of this wallet.");
    return cardEntry(id, c.cardSig);
  });
  if (new Set(entries.map((e) => e.id)).size < entries.length) throw httpError(400, "Use two different cards.");
  const proof = phoneEntry(0, phoneSig).data;
  const rc = await send(w, "proposePhoneRecovery", [r.x, r.y, r.expiry, sorted(entries), proof]);
  const pr = await w.phoneRecovery();
  res.json({ status: "waiting", wallet: r.wallet, readyAt: Number(pr.readyAt), now: await chainNow(), txHash: rc.hash });
}));

// Where is a replacement? Used by the new phone while it waits, and by the old phone to show a warning.
app.get("/api/recover/status/:wallet", wrap(async (req, res) => {
  const wallet = req.params.wallet;
  if (!ethers.isAddress(wallet)) throw httpError(400, "bad wallet");
  const { x, y } = req.query;
  const w = walletAt(wallet);
  const [pr, list, now] = await Promise.all([w.phoneRecovery(), signersOf(w), chainNow()]);
  const pending = pr.readyAt > 0n;
  res.json({
    pending,
    readyAt: Number(pr.readyAt),
    now,
    active: isKey32(x) && isKey32(y) ? phoneIsSigner(list, x, y) : false, // this phone is already a signer
    mine: pending && isKey32(x) && isKey32(y) && pr.x.toLowerCase() === x.toLowerCase() && pr.y.toLowerCase() === y.toLowerCase(),
  });
}));

// The old phone (if it still works) can cancel a replacement with its fingerprint alone.
app.post("/api/recovery-cancel/start", limit("action", 30, 60_000), wrap(async (req, res) => {
  const { wallet } = req.body || {};
  if (!ethers.isAddress(wallet)) throw httpError(400, "bad wallet");
  await startAction(req, res, "cancelPhoneRecovery", wallet);
}));
app.post("/api/recovery-cancel/:id", wrap(async (req, res) => {
  const a = actions.get(req.params.id);
  if (!a) throw httpError(404, "unknown request");
  actions.delete(a.id);
  const rc = await finishAction(a, req.body || {});
  res.json({ status: "cancelled", txHash: rc.hash });
}));

// --- wallet view for the app -----------------------------------------------------------------

// Received money comes from the token's Transfer logs. Instead of looking it up on every request, one background
// poll (every POLL_MS, about 10 blocks) reads everything since the last saved block, for all wallets at once, in
// chunks the public RPC accepts. The wallet screen just reads what was saved.
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const POLL_MS = Number(process.env.POLL_MS || 10_000);
const LOG_CHUNK = 900; // public RPCs allow about 1,000 blocks per log query
const MAX_CHUNKS = 40; // at most this many queries per poll while catching up
const blockTimes = new Map();
async function blockTime(n) {
  if (!blockTimes.has(n)) blockTimes.set(n, (await provider.getBlock(n)).timestamp * 1000);
  return blockTimes.get(n);
}
const receivedOf = (rec) => (rec && Array.isArray(rec.received) ? rec.received : []);

async function pollTransfers() {
  const st = state[chainKey];
  const head = await provider.getBlockNumber();
  const wallets = Object.keys(st.wallets);
  if (st.scanned === undefined) {
    // First run: start at the oldest wallet's creation block, or now if there are no wallets yet.
    const starts = wallets.map((w) => st.wallets[w].createdBlock).filter((n) => n !== undefined);
    st.scanned = (starts.length ? Math.min(...starts) : head) - 1;
  }
  for (const w of wallets) if (!Array.isArray(st.wallets[w].received)) st.wallets[w].received = [];
  let chunks = 0;
  let dirty = false;
  while (st.scanned < head && chunks++ < MAX_CHUNKS) {
    const from = st.scanned + 1;
    const to = Math.min(from + LOG_CHUNK - 1, head);
    if (wallets.length) {
      const logs = await provider.getLogs({ address: tokenAddr, topics: [TRANSFER_TOPIC, null, wallets.map((w) => ethers.zeroPadValue(w, 32))], fromBlock: from, toBlock: to });
      for (const l of logs) {
        const to_ = ethers.getAddress("0x" + l.topics[2].slice(26));
        const rec = st.wallets[to_];
        const id = `${l.transactionHash}:${l.index}`;
        if (!rec || rec.received.some((x) => x.id === id)) continue;
        const sender = ethers.getAddress("0x" + l.topics[1].slice(26));
        rec.received.push({ id, kind: "received", merchantName: "Received", from: sender === ethers.ZeroAddress ? "Test deposit" : short(sender), amount: money(BigInt(l.data)), status: "paid", time: await blockTime(l.blockNumber), txHash: l.transactionHash });
        rec.received = rec.received.slice(-30);
        dirty = true;
      }
    }
    st.scanned = to;
  }
  if (dirty || chunks > 1) save(); // the cursor itself is only written when something changed or after catching up
}
let pollFailures = 0;
async function pollLoop() {
  try { await pollTransfers(); pollFailures = 0; }
  catch (e) { if (pollFailures++ % 6 === 0) console.log("transfer poll failed:", String(e.shortMessage || e.message).slice(0, 120)); }
  setTimeout(pollLoop, POLL_MS);
}

function historyItem(p) {
  if (p.kind === "send") return { id: p.id, kind: "sent", merchantName: short(p.to), to: p.to, amount: p.amount, status: p.status, error: p.error, txHash: p.txHash, time: p.finished || p.created };
  return { id: p.id, kind: "payment", merchantName: MERCHANT_NAME, amount: p.amount, status: p.status, error: p.error, cardOnly: !!p.cardOnly, txHash: p.txHash, ...(p.ethPaid ? { ethPaid: p.ethPaid } : {}), time: p.finished || p.created };
}
function publicPayment(p) {
  const { id, wallet, amount, expiry, hash, status, txHash, error, gasUsed, cardOnly, kind, to } = p;
  return { id, wallet, amount, expiry, hash, status, txHash, error, gasUsed, cardOnly, kind, to, ...(p.swap ? { swap: { ...swapInfo(p.swap), ethPaid: p.ethPaid } } : {}), merchant: to || MERCHANT, merchantName: kind === "send" ? short(to) : MERCHANT_NAME };
}

// The chain reads behind the wallet screen (balance, limits, cards...) are cached for a few seconds, so many app polls
// cost one set of RPC calls. If the RPC fails, the last good answer is returned marked `stale`, so the app keeps
// showing data instead of an error. `?fresh=1` (pull to refresh) skips the cache. A successful transaction clears it.
const VIEW_TTL = Number(process.env.VIEW_TTL_MS || 4000);
const chainViews = new Map(); // wallet -> { at, data }

async function readChainView(addr) {
  const w = walletAt(addr);
  const [balance, perTx, daily, spent, frozen, softLimit, softCardOnly, threshold, list, pr] = await Promise.all([token.balanceOf(addr), w.perTxLimit(), w.dailyLimit(), spentToday(w), w.frozen(), w.softLimit(), w.softCardOnly(), w.threshold(), signersOf(w), w.phoneRecovery()]);
  return {
    ...(SWAP ? { ethBalance: ethers.formatEther(await provider.getBalance(addr)) } : {}),
    balance: money(balance),
    perTxLimit: money(perTx),
    dailyLimit: money(daily),
    spentToday: money(spent),
    frozen,
    softLimit: money(softLimit),
    softCardOnly,
    threshold: Number(threshold),
    phoneRecovery: { pending: pr.readyAt > 0n, readyAt: Number(pr.readyAt) },
    cardIds: list.filter((x) => x.kind === KIND_CARD).map((x) => x.id),
  };
}

app.get("/api/wallet/:addr", wrap(async (req, res) => {
  const addr = req.params.addr;
  if (!ethers.isAddress(addr)) throw httpError(400, "bad wallet");
  const rec = state[chainKey].wallets[addr] || { names: {}, history: [] };
  let c = chainViews.get(addr);
  let stale = false;
  const refresh = async () => { const d = await readChainView(addr); chainViews.set(addr, { at: Date.now(), data: d }); return chainViews.get(addr); };
  if (!c || req.query.fresh === "1") {
    try { c = await refresh(); } catch (e) {
      if (!c) throw e; // nothing cached yet: this is a real error
      stale = true; // the RPC failed: keep showing the last good numbers
    }
  } else if (Date.now() - c.at > VIEW_TTL) {
    // Answer at once with the last numbers and refresh in the background: a slow chain must not make the screen wait.
    if (!c.refreshing) { c.refreshing = true; refresh().catch(() => {}).finally(() => { c.refreshing = false; }); }
  }
  // Pending approvals and our own history live in memory, so they are always current.
  const pending = [...payments.values()].filter((p) => p.wallet.toLowerCase() === addr.toLowerCase() && p.kind !== "send" && p.status === "waiting_for_phone").map(publicPayment);
  const history = [...(rec.history || []), ...receivedOf(rec)].sort((x, y) => y.time - x.time).slice(0, 50);
  const { cardIds, ...chain } = c.data;
  res.json({
    v2: true,
    net: NET_INFO,
    wallet: addr,
    ...chain,
    cards: cardIds.map((id) => ({ id, name: rec.names?.[id] || `Card ${id + 1}`, active: true })),
    pending,
    history,
    merchant: MERCHANT,
    stale,
    updatedAt: c.at,
  });
}));


app.get("/", (req, res) => res.type("text").send("Tap2ETH relayer v2. See /api/health."));

// The network can blip while starting (Wi-Fi switching, DNS): try a few times before giving up.
async function setupWithRetry(tries = 8) {
  for (let i = 1; ; i++) {
    try { return await setup(); } catch (e) {
      const transient = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|fetch failed|timeout|could not detect network|SERVER_ERROR/i.test(`${e.message} ${e.code} ${e.cause?.code || ""}`);
      if (!transient || i >= tries) throw e;
      console.log(`can't reach ${RPC.split("/")[2]} yet (${e.cause?.code || e.code || e.message}). Retrying in 5 s (${i}/${tries - 1})...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

setupWithRetry()
  .then(() => { pollLoop(); return app.listen(PORT, "0.0.0.0", () => console.log(`relayer v2 on http://0.0.0.0:${PORT}`)); })
  .catch((e) => { console.error("setup failed:", e.message); process.exit(1); });

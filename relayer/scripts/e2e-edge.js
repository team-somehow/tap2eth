// The terminal ("edge") payment path: /api/pay/tapped, the one the Pi uses. The terminal rebuilds the payment hash itself,
// the card signs it, and the relayer checks it and submits. Regression test for a payment that was wrongly marked "failed"
// after it had gone through. Run against a local chain, with the relayer started WITHOUT relayer/.env (see e2e-v2.js):
//   BASE=http://localhost:8793 LOCAL_RPC=http://127.0.0.1:8545 node scripts/e2e-edge.js
const { ethers } = require("ethers");
const { makeCard, makePasskey } = require("../../contracts/test/helpers");

const BASE = process.env.BASE || "http://localhost:8793";
const RPC = process.env.LOCAL_RPC || "http://127.0.0.1:8545";
const results = [];
const check = (label, pass, extra = "") => { results.push(pass); console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); };
const hexOf = (b) => Buffer.from(b).toString("hex");
async function call(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, ...(await res.json().catch(() => ({}))) };
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const card = makeCard(), phone = makePasskey();
  const cfg = await call("/api/terminal/config");
  check("terminal config available", cfg.ok && cfg.factory && cfg.token, JSON.stringify({ chainId: cfg.chainId }));

  let r = await call("/api/signup/start", { phoneX: phone.x, phoneY: phone.y, cardModulus: hexOf(card.modulus), cardExponent: hexOf(card.exponent) });
  r = await call("/api/signup/" + r.id, { cardSig: "0x" + hexOf(card.sign(Buffer.from(r.challenge, "hex"))), phoneSig: phone.sign(r.hash) });
  const wallet = r.wallet;
  check("wallet created", r.ok && ethers.isAddress(wallet), r.error || wallet);

  const token = new ethers.Contract(cfg.token, ["function balanceOf(address) view returns (uint256)"], provider);
  const w = new ethers.Contract(wallet, ["function nonce() view returns (uint256)"], provider);
  const before = await token.balanceOf(wallet);
  const merchantBefore = await token.balanceOf(cfg.merchant);

  // What the terminal does: build the hash for THIS wallet, merchant and amount, have the card sign its first 4 bytes.
  const value = ethers.parseUnits("0.2", cfg.decimals), nonce = await w.nonce(), expiry = Math.floor(Date.now() / 1000) + 200;
  const hash = ethers.keccak256(coder.encode(["string", "uint256", "address", "address", "address", "uint256", "uint256", "uint256"], ["TAP2ETH_V2_PAY", BigInt(cfg.chainId), wallet, cfg.token, cfg.merchant, value, nonce, BigInt(expiry)]));
  r = await call("/api/pay/tapped", { cardModulus: hexOf(card.modulus), cardId: 0, amount: "0.2", nonce: nonce.toString(), expiry, hash, cardSig: hexOf(card.sign(Buffer.from(hash.slice(2, 10), "hex"))) });
  check("terminal payment accepted, waiting for the phone", r.ok && r.status === "waiting_for_phone", r.error || r.status);
  const id = r.id;

  r = await call(`/api/pay/${id}/phone`, { phoneSig: phone.sign(hash) });
  check("payment is PAID (not failed after the transaction)", r.status === "paid", r.error || r.status);
  check("it has a transaction hash and no error", !!r.txHash && !r.error);
  r = await call(`/api/pay/${id}`);
  check("status stays paid when read again", r.status === "paid" && !r.error, r.error || "");
  check("merchant received exactly 0.2", (await token.balanceOf(cfg.merchant)) - merchantBefore === value);
  check("wallet balance went down by 0.2", before - (await token.balanceOf(wallet)) === value);
  const v = await call("/api/wallet/" + wallet + "?fresh=1");
  check("History shows it as paid", v.history.some((h) => h.kind === "payment" && h.status === "paid" && Number(h.amount) === 0.2), v.history.map((h) => h.status).join(","));

  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

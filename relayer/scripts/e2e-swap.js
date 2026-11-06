// End-to-end test of swap mode (NETWORK=sepolia) over HTTP, on the REAL Ethereum Sepolia and the REAL Uniswap v3 pool.
// It plays the app, the terminal, the bank card and the phone key (fake ones), funds the new wallet with a little ETH
// from the relayer account, and checks the merchant receives EXACTLY the USDT amount.
// Usage:  NETWORK=sepolia PORT=8791 STATE_FILE=/tmp/s.json node --env-file=.env server.v2.js
//         BASE=http://localhost:8791 node --env-file=.env scripts/e2e-swap.js
const { ethers } = require("ethers");
const { makeCard, makePasskey } = require("../../contracts/test/helpers");

const BASE = process.env.BASE || "http://localhost:8791";
let MERCHANT; // asked from the relayer, so the test checks the address that really gets paid
const USDT = "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0";
const results = [];
const check = (label, pass, extra = "") => { results.push(pass); console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); };
const hexOf = (b) => Buffer.from(b).toString("hex");
async function call(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, ...(await res.json().catch(() => ({}))) };
}

(async () => {
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111, { staticNetwork: true });
  const funder = new ethers.Wallet(process.env.RELAYER_KEY, provider);
  const usdt = new ethers.Contract(USDT, ["function balanceOf(address) view returns (uint256)"], provider);
  const card = makeCard(), phone = makePasskey();

  console.log("\n== 1. config says swap mode");
  const cfg = await call("/api/terminal/config");
  MERCHANT = cfg.merchant;
  check("terminal config: mode swap, poweredBy Ethereum Sepolia, dex Uniswap", cfg.mode === "swap" && cfg.poweredBy === "Ethereum Sepolia" && /Uniswap/.test(cfg.swap?.dex || ""), JSON.stringify({ mode: cfg.mode, poweredBy: cfg.poweredBy, swap: cfg.swap }));

  console.log("\n== 2. sign up");
  let r = await call("/api/signup/start", { phoneX: phone.x, phoneY: phone.y, cardModulus: hexOf(card.modulus), cardExponent: hexOf(card.exponent) });
  r = await call("/api/signup/" + r.id, { cardSig: "0x" + hexOf(card.sign(Buffer.from(r.challenge, "hex"))), phoneSig: phone.sign(r.hash) });
  check("wallet created", r.ok && ethers.isAddress(r.wallet), r.error || r.wallet);
  const wallet = r.wallet;
  await new Promise((r) => setTimeout(r, 6000)); // a public RPC can need a few seconds before every node knows the new wallet

  console.log("\n== 3. wallet holds no ETH yet: payment refused up front");
  r = await call("/api/pay/start", { cardModulus: hexOf(card.modulus), amount: "0.1" });
  check("refused with InsufficientBalance", !r.ok && /Insufficient/.test(r.error || ""), r.error || "");

  console.log("\n== 4. fund the wallet with ETH (the customer's balance)");
  await (await funder.sendTransaction({ to: wallet, value: ethers.parseEther("0.00002") })).wait();
  await new Promise((r) => setTimeout(r, 6000)); // let every RPC node see the deposit
  let v = await call("/api/wallet/" + wallet + "?fresh=1");
  check("wallet view shows the ETH balance", Number(v.ethBalance) > 0, `ethBalance ${v.ethBalance}`);

  console.log("\n== 5. terminal: 0.1 USDT, card taps, phone approves");
  const before = await usdt.balanceOf(MERCHANT);
  r = await call("/api/pay/start", { cardModulus: hexOf(card.modulus), amount: "0.1" });
  check("payment opened with an ETH quote from Uniswap", r.ok && r.swap && Number(r.swap.ethQuote) > 0, JSON.stringify(r.swap || r.error));
  const id = r.id, hash = r.challenge;
  r = await call(`/api/pay/${id}/card`, { cardSig: hexOf(card.sign(Buffer.from(hash, "hex"))) });
  check("waits for the phone", r.status === "waiting_for_phone");
  r = await call(`/api/pay/${id}/phone`, { phoneSig: phone.sign((await call(`/api/pay/${id}`)).hash) });
  check("paid", r.status === "paid", r.error || r.txHash);
  console.log("     tx", r.txHash, " ETH paid", r.swap?.ethPaid, " quote", r.swap?.ethQuote);
  const got = (await usdt.balanceOf(MERCHANT)) - before;
  check("merchant received EXACTLY 0.1 USDT", got === 100000n, `got ${ethers.formatUnits(got, 6)} USDT`);
  check("customer paid no more than the quoted max", Number(r.swap?.ethPaid) > 0 && Number(r.swap.ethPaid) <= Number(r.swap.ethMax));

  console.log("\n== 6. history");
  v = await call("/api/wallet/" + wallet + "?fresh=1");
  check("history shows the payment with the ETH paid", v.history.some((h) => h.kind === "payment" && h.status === "paid" && Number(h.ethPaid) > 0));

  const ok = results.every(Boolean);
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

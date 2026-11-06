// End-to-end test of Sepolia mode (NETWORK=sepolia) over HTTP, on the REAL Ethereum Sepolia and the REAL Uniswap v3 pool.
// It plays the app, the terminal, the bank card and the phone key (fake ones), funds a new wallet with a little ETH from the
// relayer account, and checks every way of paying: USDT, ETH swapped to USDT on Uniswap (exact USDT out), the Swap button,
// plain ETH sends, the pay-at-shops preference (no silent fallback), the progress steps and the activity list.
// Usage:  NETWORK=sepolia PORT=8791 STATE_FILE=/tmp/s.json node --env-file=.env server.v2.js
//         BASE=http://localhost:8791 node --env-file=.env scripts/e2e-swap.js
const { ethers } = require("ethers");
const { makeCard, makePasskey } = require("../../contracts/test/helpers");

const BASE = process.env.BASE || "http://localhost:8791";
const USDT = "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0";
const results = [];
const check = (label, pass, extra = "") => { results.push(pass); console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); };
const step = (t) => console.log(`\n== ${t}`);
const hexOf = (b) => Buffer.from(b).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, body) {
  const t0 = Date.now();
  try { return await call0(path, body); } finally { if (/\/start$/.test(path)) console.log(`     (${path} took ${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
}
async function call0(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, ...(await res.json().catch(() => ({}))) };
}

(async () => {
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", 11155111, { staticNetwork: true });
  const funder = new ethers.Wallet(process.env.RELAYER_KEY, provider);
  const usdt = new ethers.Contract(USDT, ["function balanceOf(address) view returns (uint256)"], provider);
  const card = makeCard(), phone = makePasskey();
  const cm = hexOf(card.modulus);
  const fresh = () => ethers.Wallet.createRandom().address;
  const usdtOf = (a) => usdt.balanceOf(a);
  // A public RPC can answer from a node that is a block behind: wait (up to 40 s) until a balance reaches what we expect.
  const settles = async (read, want) => { for (let i = 0; i < 20; i++) { if ((await read()) === want) return true; await sleep(2000); } return false; };
  const view = (w) => call("/api/wallet/" + w + "?fresh=1");

  // Card taps and phone approves a started payment. Returns the final payment and the progress snapshots seen on the way.
  async function approve(started, { watch = false } = {}) {
    const id = started.id;
    let r = await call(`/api/pay/${id}/card`, { cardSig: hexOf(card.sign(Buffer.from(started.challenge, "hex"))) });
    if (r.status !== "waiting_for_phone") return r;
    const h = (await call(`/api/pay/${id}`)).hash;
    const snaps = [];
    const t0 = Date.now();
    const phoneCall = call(`/api/pay/${id}/phone`, { phoneSig: phone.sign(h) });
    phoneCall.then(() => console.log(`     (approval request took ${((Date.now() - t0) / 1000).toFixed(1)} s)`));
    let finished = false;
    phoneCall.then(() => { finished = true; });
    while (watch && !finished) { const g = await call(`/api/pay/${id}`); snaps.push(g.steps.map((s) => s.state[0]).join("")); await sleep(350); }
    const out = await phoneCall;
    out.snaps = snaps;
    return out;
  }

  step("1. config: swap mode, no badge");
  const cfg = await call("/api/terminal/config");
  check("terminal config says swap mode with Uniswap and shows no 'Powered by'", cfg.mode === "swap" && !cfg.poweredBy && /Uniswap/.test(cfg.swap?.dex || ""), JSON.stringify({ mode: cfg.mode, poweredBy: cfg.poweredBy }));
  const MERCHANT = cfg.merchant;

  step("2. sign up");
  let r = await call("/api/signup/start", { phoneX: phone.x, phoneY: phone.y, cardModulus: cm, cardExponent: hexOf(card.exponent) });
  r = await call("/api/signup/" + r.id, { cardSig: "0x" + hexOf(card.sign(Buffer.from(r.challenge, "hex"))), phoneSig: phone.sign(r.hash) });
  check("wallet created", r.ok && ethers.isAddress(r.wallet), r.error || r.wallet);
  const wallet = r.wallet;
  await sleep(6000); // a public RPC can need a few seconds before every node knows the new wallet

  step("3. token list and the pay-at-shops preference");
  let v = await view(wallet);
  const symbols = (v.tokens || []).map((t) => t.symbol);
  check("wallet view lists ETH, USDT, USDC, DAI and UNI with balances", ["ETH", "USDT", "USDC", "DAI", "UNI"].every((s) => symbols.includes(s)) && v.tokens.every((t) => t.balance !== undefined), symbols.join(","));

  step("4. an empty wallet is refused with 'insufficient'");
  r = await call("/api/pay/start", { cardModulus: cm, amount: "0.1" });
  check("no USDT and no ETH: refused with InsufficientBalance", !r.ok && /InsufficientBalance/.test(r.error || ""), r.error);

  step("5. receive ETH");
  await (await funder.sendTransaction({ to: wallet, value: ethers.parseEther("0.0002") })).wait();
  await sleep(6000);
  v = await view(wallet);
  check("ETH balance shows", Number(v.ethBalance) >= 0.0002, `ethBalance ${v.ethBalance}`);
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) { v = await view(wallet); seen = v.history.some((h) => h.kind === "received" && h.symbol === "ETH" && Number(h.amount) === 0.0002); if (!seen) await sleep(2000); }
  check("Activity shows 'Received 0.0002 ETH'", seen);

  step("6. POS asks 0.1 USDT, wallet has only ETH: it is swapped on Uniswap automatically, watching the progress steps");
  const m0 = await usdtOf(MERCHANT);
  r = await call("/api/pay/start", { cardModulus: cm, amount: "0.1" });
  check("payment opened, mode swap, with an ETH quote", r.ok && r.swap && Number(r.swap.ethQuote) > 0, JSON.stringify(r.swap || r.error));
  r = await approve(r, { watch: true });
  check("paid", r.status === "paid", r.error || r.txHash);
  console.log("     tx", r.txHash, " ETH paid", r.swap?.ethPaid, " steps seen:", [...new Set(r.snaps)].join(" > "));
  check("merchant received EXACTLY 0.1 USDT", (await usdtOf(MERCHANT)) - m0 === 100000n);
  check("customer paid no more than the quoted max", Number(r.swap?.ethPaid) > 0 && Number(r.swap.ethPaid) <= Number(r.swap.ethMax));
  check("progress had 6 steps and ended with all done", r.steps?.length === 6 && r.steps.every((s) => s.state === "done"), r.steps?.map((s) => s.state).join(","));
  check("steps only move forward (no tick before its time)", r.snaps.every((s, i) => i === 0 || (s.match(/d/g) || []).length >= (r.snaps[i - 1].match(/d/g) || []).length));

  step("7. Swap button: 0.2 USDT into the wallet's own USDT (ETH to USDT only)");
  const u0 = await usdtOf(wallet);
  r = await call("/api/swap/start", { cardModulus: cm, amount: "0.2" });
  check("swap started, to = the wallet itself", r.ok && r.to === wallet && r.swap, r.error || "");
  r = await approve(r);
  check("swap paid", r.status === "paid", r.error || r.txHash);
  await sleep(4000);
  check("wallet received exactly 0.2 USDT", (await usdtOf(wallet)) - u0 === 200000n);
  v = await view(wallet);
  check("History has the swap row once, and no duplicate 'Received' for the same transaction", v.history.filter((h) => h.txHash === r.txHash).length === 1 && v.history.some((h) => h.kind === "swap" && h.txHash === r.txHash));
  check("wallet view shows the 0.2 USDT in the token list", Number(v.tokens.find((t) => t.symbol === "USDT")?.balance) >= 0.2);

  step("8. POS asks 0.1 USDT, wallet now has USDT: paid from it, no swap");
  const m1 = await usdtOf(MERCHANT), u1 = await usdtOf(wallet);
  r = await call("/api/pay/start", { cardModulus: cm, amount: "0.1" });
  check("payment opened with no swap", r.ok && !r.swap, r.error || "");
  r = await approve(r);
  check("paid with USDT", r.status === "paid" && r.mode === "pay", r.error || r.txHash);
  await sleep(2000);
  check("merchant +0.1 USDT and wallet -0.1 USDT", (await usdtOf(MERCHANT)) - m1 === 100000n && u1 - (await usdtOf(wallet)) === 100000n);

  step("9. Send ETH");
  const friend = fresh();
  r = await call("/api/send/start", { cardModulus: cm, amount: "0.00001", to: friend, asset: "eth" });
  check("ETH send started", r.ok && r.mode === "eth", r.error || "");
  r = await approve(r);
  check("ETH send paid", r.status === "paid", r.error || "");
  check("friend got exactly 0.00001 ETH", await settles(() => provider.getBalance(friend), ethers.parseEther("0.00001")));
  r = await call("/api/send/start", { cardModulus: cm, amount: "0.06", to: friend, asset: "eth" });
  check("0.06 ETH is over the default 0.05 ETH limit: refused", !r.ok && /OverLimit/.test(r.error || ""), r.error || "");

  step("10. Send USDT, paid with ETH (swap) and paid with USDT");
  const f2 = fresh();
  r = await call("/api/send/start", { cardModulus: cm, amount: "0.05", to: f2, asset: "usdt", payWith: "eth" });
  check("USDT send paid with ETH: mode swap", r.ok && r.mode === "swap" && r.swap, r.error || "");
  r = await approve(r);
  check("recipient got exactly 0.05 USDT", r.status === "paid" && (await settles(() => usdtOf(f2), 50000n)), r.error || "");
  const f3 = fresh();
  r = await call("/api/send/start", { cardModulus: cm, amount: "0.05", to: f3, asset: "usdt", payWith: "usdt" });
  check("USDT send paid with USDT: mode pay", r.ok && r.mode === "pay" && !r.swap, r.error || "");
  r = await approve(r);
  check("recipient got exactly 0.05 USDT", r.status === "paid" && (await settles(() => usdtOf(f3), 50000n)), r.error || "");

  const ok = results.every(Boolean);
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

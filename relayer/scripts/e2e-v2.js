// End-to-end test of the v2 relayer over HTTP. It plays every role: the phone app, the merchant terminal,
// the bank card and the phone key (fake ones from the contract test helpers).
// Usage: start a chain and the relayer, then `npm run e2e:v2` (BASE=http://localhost:8787 by default).
const { makeCard, makePasskey } = require("../../contracts/test/helpers");

const BASE = process.env.BASE || "http://localhost:8787";
const results = [];
const check = (label, pass, extra = "") => { results.push(pass); console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); };
const step = (t) => console.log(`\n== ${t}`);

async function call(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...j };
}
const hexOf = (b) => Buffer.from(b).toString("hex");
const cardSign = (card, challengeHex) => hexOf(card.sign(Buffer.from(challengeHex, "hex")));
const view = (w) => call("/api/wallet/" + w);

async function main() {
  const card = makeCard();
  const phone = makePasskey();

  step("1. Sign up (the app: card + phone sign the creation hash)");
  let r = await call("/api/signup/start", { phoneX: phone.x, phoneY: phone.y, cardModulus: hexOf(card.modulus), cardExponent: hexOf(card.exponent) });
  check("relayer returns a hash and a 4-byte challenge", r.ok && r.hash && r.challenge.length === 8);
  r = await call("/api/signup/" + r.id, { cardSig: "0x" + cardSign(card, r.challenge), phoneSig: phone.sign(r.hash) });
  check("wallet created", r.ok && /^0x[0-9a-fA-F]{40}$/.test(r.wallet || ""), r.error || "");
  const wallet = r.wallet;
  let v = await view(wallet);
  check("wallet view says v2, one card, 100 balance from the test faucet", v.v2 === true && v.cards.length === 1 && Number(v.balance) === 100, `balance ${v.balance}`);
  check("limits set by the relayer (50 per payment, 200 a day)", Number(v.perTxLimit) === 50 && Number(v.dailyLimit) === 200);
  check("history already shows the received 100", v.history.some((h) => h.kind === "received" && Number(h.amount) === 100));

  step("2. A card for another phone is refused");
  const other = makePasskey();
  r = await call("/api/signup/start", { phoneX: other.x, phoneY: other.y, cardModulus: hexOf(card.modulus), cardExponent: hexOf(card.exponent) });
  check("signing up the same card with a different phone is refused", !r.ok && /another phone/.test(r.error || ""), r.error);
  r = await call("/api/signup/start", { phoneX: phone.x, phoneY: phone.y, cardModulus: hexOf(card.modulus), cardExponent: hexOf(card.exponent) });
  check("signing up again with the same phone returns the existing wallet", r.ok && r.existing && r.wallet === wallet);

  step("3. A 12 payment at the terminal: card taps, phone approves");
  r = await call("/api/pay/start", { cardModulus: hexOf(card.modulus), amount: "12" });
  check("terminal gets a payment id and challenge", r.ok && r.challenge?.length === 8 && r.cardOnly === false, r.error || "");
  const pay1 = r.id;
  r = await call(`/api/pay/${pay1}/card`, { cardSig: cardSign(card, r.challenge) });
  check("after the card tap it waits for the phone", r.status === "waiting_for_phone");
  v = await view(wallet);
  check("the app sees one pending request", v.pending.length === 1 && v.pending[0].id === pay1);
  r = await call(`/api/pay/${pay1}/phone`, { phoneSig: phone.sign(v.pending[0].hash) });
  check("phone approves and the payment is paid with a transaction", r.status === "paid" && !!r.txHash, r.error || "");
  v = await view(wallet);
  check("balance fell to 88 and the payment shows in history", Number(v.balance) === 88 && v.history.some((h) => h.kind === "payment" && h.status === "paid" && Number(h.amount) === 12));

  step("4. Limits");
  r = await call("/api/pay/start", { cardModulus: hexOf(card.modulus), amount: "60" });
  check("60 is refused up front (over the 50 limit)", !r.ok && r.error === "OverLimit", r.error);
  let a = await call("/api/action/start", { wallet, action: "limits", params: { perTx: 80, daily: 300 } });
  r = await call("/api/action/" + a.id, { cardModulus: hexOf(card.modulus), cardSig: "0x" + cardSign(card, a.challenge), phoneSig: phone.sign(a.hash) });
  check("limits changed with card + phone", r.status === "done", r.error || "");
  v = await view(wallet);
  check("new limits are 80 / 300", Number(v.perTxLimit) === 80 && Number(v.dailyLimit) === 300);
  a = await call("/api/action/start", { wallet, action: "limits", params: { perTx: 500, daily: 500 } });
  r = await call("/api/action/" + a.id, { cardModulus: hexOf(card.modulus), cardSig: "0x" + cardSign(makeCard(), a.challenge), phoneSig: phone.sign(a.hash) });
  check("a different card cannot change the limits", !r.ok, r.error);

  step("5. Small payments with the card alone (up to 10)");
  a = await call("/api/action/start", { wallet, action: "soft", params: { amount: 10, cardOnly: true } });
  r = await call("/api/action/" + a.id, { cardModulus: hexOf(card.modulus), cardSig: "0x" + cardSign(card, a.challenge), phoneSig: phone.sign(a.hash) });
  check("card-only small payments switched on", r.status === "done", r.error || "");
  r = await call("/api/pay/start", { cardModulus: hexOf(card.modulus), amount: "6" });
  check("terminal is told this is a card-only payment", r.ok && r.cardOnly === true);
  const pay2 = r.id;
  r = await call(`/api/pay/${pay2}/card`, { cardSig: cardSign(card, r.challenge) });
  check("a 6 payment is paid right after the card tap, with no phone", r.status === "paid" && r.cardOnly === true, r.error || "");
  r = await call("/api/pay/start", { cardModulus: hexOf(card.modulus), amount: "11" });
  check("11 is above the small limit, so it needs the phone", r.ok && r.cardOnly === false);
  await call(`/api/pay/${r.id}/reject`, {});

  step("6. Add a second card (2 of 3)");
  const card2 = makeCard();
  a = await call("/api/action/start", { wallet, action: "addCard", params: { name: "Dad's Visa", cardModulus: hexOf(card2.modulus), cardExponent: hexOf(card2.exponent) } });
  r = await call("/api/action/" + a.id, { cardModulus: hexOf(card.modulus), cardSig: "0x" + cardSign(card, a.challenge), newCardSig: "0x" + cardSign(card2, a.challenge), phoneSig: phone.sign(a.hash) });
  check("second card added with card 1 + phone + the new card's own proof", r.status === "done", r.error || "");
  v = await view(wallet);
  check("the app lists both cards, with the name we gave", v.cards.length === 2 && v.cards.some((c) => c.name === "Dad's Visa"));
  r = await call("/api/pay/start", { cardModulus: hexOf(card2.modulus), amount: "20" });
  check("the terminal accepts the second card", r.ok, r.error || "");
  const pay3 = r.id;
  r = await call(`/api/pay/${pay3}/card`, { cardSig: cardSign(card2, r.challenge) });
  v = await view(wallet);
  r = await call(`/api/pay/${pay3}/phone`, { phoneSig: phone.sign(v.pending[0].hash) });
  check("a 20 payment with card 2 + phone is paid", r.status === "paid", r.error || "");

  step("7. Freeze and unfreeze");
  a = await call("/api/freeze/start", { wallet });
  r = await call("/api/freeze/" + a.id, { phoneSig: phone.sign(a.hash) });
  check("freeze with the phone alone", r.status === "frozen", r.error || "");
  r = await call("/api/pay/start", { cardModulus: hexOf(card.modulus), amount: "1" });
  check("a payment while frozen is refused up front", !r.ok && r.error === "IsFrozen", r.error);
  a = await call("/api/unfreeze/start", { wallet });
  r = await call("/api/unfreeze/" + a.id, { cardModulus: hexOf(card.modulus), cardSig: "0x" + cardSign(card, a.challenge), phoneSig: phone.sign(a.hash) });
  check("unfreeze with card + phone", r.status === "active", r.error || "");
  v = await view(wallet);
  check("wallet is active again", v.frozen === false);

  step("8. Relayer health");
  const h = await call("/api/health");
  check("health reports the relayer account, its balance and its gas budget", !!h.relayer && h.dailyGasBudget && Number(h.gasSpentToday) > 0, `spent today ${h.gasSpentToday}`);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  console.log("wallet", wallet);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

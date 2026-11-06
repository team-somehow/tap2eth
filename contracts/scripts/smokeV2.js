// Live smoke test of the v2 contracts on a real network, with THROWAWAY fake cards and passkeys.
// Uses a throwaway TestUSDC (NOT the track USDT) so it can mint money to play with.
// Usage: npx hardhat run scripts/smokeV2.js --network whitechainSepolia
//
// Covers: create (proof of possession), receiving small random deposits, sending them out with both signatures,
// adding a second card (2 of 3), paying with the second card, one-signature rejections, a 3-of-3 threshold,
// the per-day spending limit being hit and then raised, card-only payments for tiny amounts (5-10),
// phone-only freeze and a payment blocked while frozen, then unfreeze.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { makeCard, makePasskey } = require("../test/helpers");

const coder = ethers.AbiCoder.defaultAbiCoder();
const PHONE_T = "tuple(bytes authenticatorData,string clientDataJSON,uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s)";
const U = (x) => ethers.parseUnits(String(x), 6);
const fmt = (n) => ethers.formatUnits(n, 6);
const rndAmount = () => Number((1 + Math.random() * 4).toFixed(2)); // 1.00 to 5.00
const cardSig = (card, h) => "0x" + card.sign(Buffer.from(h.slice(2, 10), "hex")).toString("hex");
const sigOf = (s, h) => ({ id: s.id, data: s.kind === "card" ? cardSig(s.obj, h) : coder.encode([PHONE_T], [s.obj.sign(h)]) });
const sigs = (list, h) => list.slice().sort((a, b) => a.id - b.id).map((s) => sigOf(s, h));

const results = [];
const gasRows = [];
function check(label, pass, extra = "") {
  results.push(pass);
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
}
const step = (t) => console.log(`\n== ${t}`);

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const depFile = path.join(__dirname, "..", "deployments", `${chainId}.json`);
  const saved = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile)).factoryV2 : null;
  const [relayer] = await ethers.getSigners();
  // On a network with a saved v2 deployment (Whitechain) use it; on a throwaway local chain deploy a fresh one.
  const factory = saved
    ? await ethers.getContractAt("Tap2EthFactoryV2", saved)
    : await (await ethers.getContractFactory("Tap2EthFactoryV2")).deploy();
  const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
  const k = ethers.keccak256;

  // ---------------------------------------------------------------- 1. create
  step("1. Create a wallet (card + phone must both prove they exist)");
  const card = makeCard();
  const phone = makePasskey();
  const params = { cardModulus: card.modulus, cardExponent: card.exponent, phoneX: phone.x, phoneY: phone.y, perTxLimit: U(20), dailyLimit: U(30), recoveryDelay: 3600 };
  const h0 = await factory.createHash(params);
  let rc = await (await factory.createWallet(params, cardSig(card, h0), phone.sign(h0))).wait();
  gasRows.push(["Create wallet (clone + 2 proofs)", rc.gasUsed]);
  const walletAddr = await factory.walletOf(k(card.modulus));
  const wallet = await ethers.getContractAt("Tap2EthWalletV2", walletAddr);
  console.log("  wallet", walletAddr);
  check("wallet starts at 2 signatures needed, 2 signers", (await wallet.threshold()) === 2n && (await wallet.activeCount()) === 2n);
  check("limits set at creation: 20 per payment, 30 per day", (await wallet.perTxLimit()) === U(20) && (await wallet.dailyLimit()) === U(30));

  const token = await (await ethers.getContractFactory("TestUSDC")).deploy();
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  const C = { kind: "card", obj: card, id: 0 };
  const P = { kind: "phone", obj: phone, id: 1 };

  // Helpers bound to this wallet
  async function callPay(list, amount, to, mode) {
    const exp = (await now()) + 300;
    const h = await wallet.paymentHash(tokenAddr, to, amount, await wallet.nonce(), exp);
    const args = [tokenAddr, to, amount, exp, sigs(list, h)];
    if (mode === "static") return wallet.pay.staticCall(...args);
    return (await (await wallet.pay(...args)).wait());
  }
  async function pay(label, list, amount, to) {
    const rc = await callPay(list, amount, to);
    gasRows.push([label, rc.gasUsed]);
    return rc;
  }
  // Reads the contract's error name whether the node reports it as decoded data, raw data, or only in the message.
  function errName(e) {
    if (e.revert?.name) return e.revert.name;
    const m = /custom error '(\w+)\(/.exec(e.message || "");
    if (m) return m[1];
    const data = e.data || e.error?.data || e.info?.error?.data;
    try {
      if (data) return wallet.interface.parseError(data)?.name;
    } catch {}
    return String(e.shortMessage || e.message).slice(0, 40);
  }
  async function rejected(label, list, amount, expectedError) {
    try {
      await callPay(list, amount, ethers.Wallet.createRandom().address, "static");
      check(label, false, "(it was accepted)");
    } catch (e) {
      const name = errName(e);
      check(label, name === expectedError, `-> ${name}`);
    }
  }
  async function act(label, name, p, list, send) {
    const exp = (await now()) + 300;
    const h = await wallet.actionHash(name, p, exp);
    const rc = await (await send(exp, sigs(list, h), h)).wait();
    gasRows.push([label, rc.gasUsed]);
    return rc;
  }

  // ---------------------------------------------------------------- 2. receive
  step("2. Receive two small random deposits from a stranger");
  await (await token.faucet(relayer.address, U(100))).wait(); // the "stranger" is the relayer account, minted test money
  const in1 = rndAmount();
  const in2 = rndAmount();
  await (await token.transfer(walletAddr, U(in1))).wait();
  await (await token.transfer(walletAddr, U(in2))).wait();
  const balance1 = await token.balanceOf(walletAddr);
  check(`received ${in1} + ${in2}`, balance1 === U(in1) + U(in2), `-> balance ${fmt(balance1)}`);

  // ---------------------------------------------------------------- 3. send it out with both signatures
  step("3. Send the received money out with card + phone (both sign)");
  const friend = ethers.Wallet.createRandom().address;
  await pay("Pay, card 1 + phone", [C, P], U(in1), friend);
  check(`sent ${in1} to a friend`, (await token.balanceOf(friend)) === U(in1));
  await rejected("card alone cannot pay", [C], U(in2), "NotEnoughSignatures");
  await rejected("phone alone cannot pay", [P], U(in2), "NotEnoughSignatures");

  // ---------------------------------------------------------------- 4. second card
  step("4. Add a second card (2 of 3) and use it");
  const card2 = makeCard();
  await act("Add a second card", "addSigner", coder.encode(["uint8", "bytes32", "bytes32"], [0, k(card2.modulus), k(card2.exponent)]), [C, P], (e, s, h) =>
    wallet.addSigner(0, card2.modulus, card2.exponent, e, s, cardSig(card2, h)),
  );
  const C2 = { kind: "card", obj: card2, id: 2 };
  check("3 signers now, and the factory finds the wallet by card 2", (await wallet.activeCount()) === 3n && (await factory.walletOf(k(card2.modulus))) === walletAddr);
  await pay("Pay, card 2 + phone", [C2, P], U(in2), friend);
  check(`sent the other ${in2} using card 2 + phone`, (await token.balanceOf(friend)) === U(in1) + U(in2));
  await rejected("two cards without the phone are refused", [C, C2], U(1), "PhoneRequired");

  // ---------------------------------------------------------------- 5. 3-of-3
  step("5. Raise the requirement to 3 signatures, then lower it again");
  await (await token.faucet(walletAddr, U(100))).wait(); // top up so there is money to move
  await act("Set threshold to 3", "threshold", coder.encode(["uint256"], [3]), [C, P], (e, s) => wallet.setThreshold(3, e, s));
  check("threshold is 3", (await wallet.threshold()) === 3n);
  await rejected("2 signatures no longer enough", [C, P], U(1), "NotEnoughSignatures");
  await pay("Pay, card 1 + card 2 + phone (3 of 3)", [C, C2, P], U(1), friend);
  check("a 3-signature payment went through", true);
  await act("Set threshold back to 2 (needs all 3)", "threshold", coder.encode(["uint256"], [2]), [C, C2, P], (e, s) => wallet.setThreshold(2, e, s));
  check("threshold back to 2", (await wallet.threshold()) === 2n);

  // ---------------------------------------------------------------- 6. daily limit
  step("6. Spending limit per day: hit it, then raise it with both signatures");
  const spent = await wallet.spentToday();
  console.log("  already spent today:", fmt(spent), "of 30");
  await pay("Pay 15", [C, P], U(15), friend);
  await rejected("another 15 goes over the 30 a day", [C, P], U(15), "OverLimit");
  await rejected("a single payment of 21 is over the 20 per-payment limit", [C, P], U(21), "OverLimit");
  await act("Raise limits to 50 per payment, 100 per day", "limits", coder.encode(["uint256", "uint256"], [U(50), U(100)]), [C, P], (e, s) => wallet.setLimits(U(50), U(100), e, s));
  check("limits are now 50 / 100", (await wallet.perTxLimit()) === U(50) && (await wallet.dailyLimit()) === U(100));
  await pay("Pay 15 after raising the limit", [C, P], U(15), friend);
  check("the same payment now goes through", true);
  try {
    const exp = (await now()) + 300;
    const h = await wallet.actionHash("limits", coder.encode(["uint256", "uint256"], [U(500), U(500)]), exp);
    await wallet.setLimits.staticCall(U(500), U(500), exp, sigs([P], h));
    check("changing limits with one signature is refused", false);
  } catch (e) {
    check("changing limits with one signature is refused", errName(e) === "NotEnoughSignatures", `-> ${errName(e)}`);
  }

  // ---------------------------------------------------------------- 7. card-only tiny payments
  step("7. Card alone for tiny payments (up to 10)");
  await act("Turn on card-only payments up to 10", "softLimit", coder.encode(["uint256", "bool"], [U(10), true]), [C, P], (e, s) => wallet.setSoftLimit(U(10), true, e, s));
  check("small-payment limit is 10, card-only allowed", (await wallet.softLimit()) === U(10) && (await wallet.softCardOnly()) === true);
  const tiny1 = rndAmount() + 3; // 4 to 8
  await pay(`Pay ${tiny1} with the card alone`, [C], U(tiny1), friend);
  check(`a ${tiny1} payment with only the card went through`, true);
  await pay("Pay 10 with the second card alone", [C2], U(10), friend);
  check("exactly 10 with only card 2 went through", true);
  await rejected("11 with the card alone is refused (above 10)", [C], U(11), "NotEnoughSignatures");
  await pay("Pay 11 with card + phone", [C, P], U(11), friend);
  check("11 with card + phone still works", true);

  // ---------------------------------------------------------------- 8. freeze
  step("8. Freeze with the phone alone, then unfreeze with the full threshold");
  await act("Freeze (phone alone)", "freeze", "0x", [P], (e, s) => wallet.freeze(e, s));
  check("wallet is frozen", (await wallet.frozen()) === true);
  await rejected("a payment while frozen is refused", [C, P], U(1), "IsFrozen");
  await rejected("a card-only payment while frozen is refused too", [C], U(1), "IsFrozen");
  try {
    const exp = (await now()) + 300;
    const h = await wallet.actionHash("unfreeze", "0x", exp);
    await wallet.unfreeze.staticCall(exp, sigs([P], h));
    check("unfreeze with the phone alone is refused", false);
  } catch (e) {
    check("unfreeze with the phone alone is refused", errName(e) === "NotEnoughSignatures", `-> ${errName(e)}`);
  }
  await act("Unfreeze (card + phone)", "unfreeze", "0x", [C, P], (e, s) => wallet.unfreeze(e, s));
  check("wallet is active again", (await wallet.frozen()) === false);
  await pay("Pay 2 after unfreezing", [C, P], U(2), friend);
  check("payments work again", true);

  // ---------------------------------------------------------------- summary
  console.log("\n== Gas on this network");
  for (const [label, g] of gasRows) console.log(`  ${label.padEnd(46)} ${g}`);
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  console.log(`wallet ${walletAddr}\nsmoke-only token ${tokenAddr} (not the track USDT)\nfriend (received) ${friend}: ${fmt(await token.balanceOf(friend))}`);
  console.log(`wallet balance left ${fmt(await token.balanceOf(walletAddr))}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

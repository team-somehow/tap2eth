const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { makeCard, makePasskey } = require("./helpers");

const coder = ethers.AbiCoder.defaultAbiCoder();
const PHONE_T = "tuple(bytes authenticatorData,string clientDataJSON,uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s)";
const USDC = (x) => ethers.parseUnits(String(x), 6);
const CARD = 0;

const cardSig = (card, h) => "0x" + card.sign(Buffer.from(h.slice(2, 10), "hex")).toString("hex");
const sigOf = (s, h) => ({ id: s.id, data: s.kind === "card" ? cardSig(s.obj, h) : coder.encode([PHONE_T], [s.obj.sign(h)]) });
const sigs = (list, h) => list.slice().sort((a, b) => a.id - b.id).map((s) => sigOf(s, h));
/** The three 4-byte pieces of a hash: bytes 0-3, 4-7, 8-11. */
const pieces = (h) => [h.slice(2, 10), h.slice(10, 18), h.slice(18, 26)];
const strong = (s, h) => ({ id: s.id, parts: pieces(h).map((p) => "0x" + s.obj.sign(Buffer.from(p, "hex")).toString("hex")) });

describe("Tap2ETH wallet v3 (three-piece card recovery)", function () {
  let factory, token, wallet, merchant, card, phone, card2;
  const C = () => ({ kind: "card", obj: card, id: 0 });
  const P = () => ({ kind: "phone", obj: phone, id: 1 });
  const C2 = () => ({ kind: "card", obj: card2, id: 2 });
  const expiry = async () => (await time.latest()) + 300;

  async function act(name, params, list, send) {
    const exp = await expiry();
    const h = await wallet.actionHash(name, params, exp);
    return send(exp, sigs(list, h), h);
  }

  beforeEach(async () => {
    [, merchant] = await ethers.getSigners();
    factory = await (await ethers.getContractFactory("Tap2EthFactoryV3")).deploy();
    token = await (await ethers.getContractFactory("TestUSDC")).deploy();
    card = makeCard();
    phone = makePasskey();
    const params = { cardModulus: card.modulus, cardExponent: card.exponent, phoneX: phone.x, phoneY: phone.y, perTxLimit: USDC(50), dailyLimit: USDC(80), recoveryDelay: 3600 };
    const h = await factory.createHash(params);
    await factory.createWallet(params, cardSig(card, h), phone.sign(h));
    wallet = await ethers.getContractAt("Tap2EthWalletV3", await factory.walletOf(ethers.keccak256(card.modulus)));
    await token.faucet(await wallet.getAddress(), USDC(1000));
    card2 = makeCard();
    const k = ethers.keccak256;
    await act("addSigner", coder.encode(["uint8", "bytes32", "bytes32"], [CARD, k(card2.modulus), k(card2.exponent)]), [C(), P()], (exp, s, h2) =>
      wallet.addSigner(CARD, card2.modulus, card2.exponent, exp, s, cardSig(card2, h2)),
    );
  });

  async function pay(list, amount) {
    const exp = await expiry();
    const h = await wallet.paymentHash(await token.getAddress(), merchant.address, amount, await wallet.nonce(), exp);
    return wallet.pay(await token.getAddress(), merchant.address, amount, exp, sigs(list, h));
  }

  /** Cards sign all three pieces; `proofPhone` is the new phone's full-hash proof. */
  async function proposeStrong(np, cards = [C(), C2()], exp) {
    exp = exp || (await expiry());
    const h = await wallet.strongRecoveryHash(np.x, np.y, exp);
    return wallet.proposePhoneRecoveryStrong(np.x, np.y, exp, cards.slice().sort((a, b) => a.id - b.id).map((c) => strong(c, h)), coder.encode([PHONE_T], [np.sign(h)]));
  }

  it("splits a hash into three 4-byte pieces", async () => {
    const h = "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    expect(await wallet.recoveryParts(h)).to.deep.equal(["0x01020304", "0x05060708", "0x090a0b0c"]);
  });

  it("keeps normal v2 behaviour: pay with card + phone, one signature refused", async () => {
    await pay([C(), P()], USDC(5));
    expect(await token.balanceOf(merchant.address)).to.equal(USDC(5));
    await expect(pay([C()], USDC(5))).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
  });

  it("the one-piece recovery from v2 is switched off", async () => {
    const np = makePasskey();
    const exp = await expiry();
    const h = await wallet.phoneRecoveryHash(np.x, np.y, exp);
    await expect(wallet.proposePhoneRecovery(np.x, np.y, exp, sigs([C(), C2()], h), coder.encode([PHONE_T], [np.sign(h)])))
      .to.be.revertedWithCustomError(wallet, "UseStrongRecovery");
  });

  it("replaces the phone after the delay with two cards signing three pieces each", async () => {
    const np = makePasskey();
    const rc = await (await proposeStrong(np)).wait();
    console.log("      gas used for proposePhoneRecoveryStrong() with 2 cards x 3 pieces:", rc.gasUsed.toString());
    await expect(wallet.executePhoneRecovery()).to.be.revertedWithCustomError(wallet, "RecoveryNotReady");
    await pay([C(), P()], USDC(1)); // old phone still works during the delay
    await time.increase(3601);
    await wallet.executePhoneRecovery();
    await expect(pay([C(), P()], USDC(1))).to.be.revertedWithCustomError(wallet, "UnknownSigner");
    await pay([C(), { kind: "phone", obj: np, id: 3 }], USDC(1));
  });

  it("needs two different cards and cards only", async () => {
    const np = makePasskey();
    await expect(proposeStrong(np, [C()])).to.be.revertedWithCustomError(wallet, "NotEnoughCards");
    await expect(proposeStrong(np, [C(), C()])).to.be.revertedWithCustomError(wallet, "SignaturesNotSorted");
    const exp = await expiry();
    const h = await wallet.strongRecoveryHash(np.x, np.y, exp);
    const asPhone = { id: 1, parts: strong(C(), h).parts }; // card pieces claimed under the phone's id
    await expect(wallet.proposePhoneRecoveryStrong(np.x, np.y, exp, [strong(C(), h), asPhone], coder.encode([PHONE_T], [np.sign(h)])))
      .to.be.revertedWithCustomError(wallet, "NotCard");
  });

  it("needs exactly three pieces per card", async () => {
    const np = makePasskey();
    const exp = await expiry();
    const h = await wallet.strongRecoveryHash(np.x, np.y, exp);
    const proof = coder.encode([PHONE_T], [np.sign(h)]);
    const full = [strong(C(), h), strong(C2(), h)];
    const two = [{ id: 0, parts: full[0].parts.slice(0, 2) }, full[1]];
    await expect(wallet.proposePhoneRecoveryStrong(np.x, np.y, exp, two, proof)).to.be.revertedWithCustomError(wallet, "WrongPartCount");
    const four = [{ id: 0, parts: [...full[0].parts, full[0].parts[0]] }, full[1]];
    await expect(wallet.proposePhoneRecoveryStrong(np.x, np.y, exp, four, proof)).to.be.revertedWithCustomError(wallet, "WrongPartCount");
  });

  it("a signature for one piece cannot stand in for the others (replaying one 4-byte signature)", async () => {
    const np = makePasskey();
    const exp = await expiry();
    const h = await wallet.strongRecoveryHash(np.x, np.y, exp);
    const proof = coder.encode([PHONE_T], [np.sign(h)]);
    const good = strong(C2(), h);
    const p0 = strong(C(), h).parts[0];
    // The first card only managed to produce a valid signature for the first piece and repeats it for the rest.
    await expect(wallet.proposePhoneRecoveryStrong(np.x, np.y, exp, [{ id: 0, parts: [p0, p0, p0] }, good], proof)).to.be.revertedWithCustomError(wallet, "BadSignature");
    // A card that signs pieces of a different hash does not pass either.
    const other = ethers.keccak256("0x1234");
    await expect(wallet.proposePhoneRecoveryStrong(np.x, np.y, exp, [strong(C(), other), good], proof)).to.be.revertedWithCustomError(wallet, "BadSignature");
  });

  it("signatures for one request cannot be reused for a different phone or expiry", async () => {
    const np = makePasskey();
    const evil = makePasskey();
    const exp = await expiry();
    const h = await wallet.strongRecoveryHash(np.x, np.y, exp);
    const cards = [strong(C(), h), strong(C2(), h)];
    await expect(wallet.proposePhoneRecoveryStrong(evil.x, evil.y, exp, cards, coder.encode([PHONE_T], [evil.sign(h)]))).to.be.revertedWithCustomError(wallet, "BadSignature");
  });

  it("the new phone must prove it holds its key", async () => {
    const np = makePasskey();
    const exp = await expiry();
    const h = await wallet.strongRecoveryHash(np.x, np.y, exp);
    await expect(wallet.proposePhoneRecoveryStrong(np.x, np.y, exp, [strong(C(), h), strong(C2(), h)], coder.encode([PHONE_T], [makePasskey().sign(h)])))
      .to.be.revertedWithCustomError(wallet, "BadSignature");
  });

  it("can be cancelled by the old phone alone, and only one replacement is pending at a time", async () => {
    await proposeStrong(makePasskey());
    await expect(proposeStrong(makePasskey())).to.be.revertedWithCustomError(wallet, "RecoveryPending");
    await act("cancelPhoneRecovery", "0x", [P()], (e, s) => wallet.cancelPhoneRecovery(e, s));
    await time.increase(3601);
    await expect(wallet.executePhoneRecovery()).to.be.revertedWithCustomError(wallet, "NoRecovery");
    await pay([C(), P()], USDC(1));
  });

  it("the lost-card recovery from v2 still works in v3", async () => {
    const nc = makeCard();
    const k = ethers.keccak256;
    await act("proposeRecovery", coder.encode(["uint256", "bytes32", "bytes32"], [0, k(nc.modulus), k(nc.exponent)]), [P()], (e, s, h) => wallet.proposeRecovery(0, nc.modulus, nc.exponent, e, s, cardSig(nc, h)));
    await time.increase(3601);
    await wallet.executeRecovery();
    await pay([{ kind: "card", obj: nc, id: 3 }, P()], USDC(1));
  });
});

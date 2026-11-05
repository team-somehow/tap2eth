const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("crypto");
const { makeCard, makePasskey } = require("./helpers");

const USDC = (x) => ethers.parseUnits(String(x), 6);

describe("Tap2ETH wallet", function () {
  let factory, token, wallet, card, phone, merchant, relayer;

  beforeEach(async () => {
    [relayer, merchant] = await ethers.getSigners();
    card = makeCard();
    phone = makePasskey();
    factory = await (await ethers.getContractFactory("Tap2EthFactory")).deploy();
    token = await (await ethers.getContractFactory("TestUSDC")).deploy();
    await factory.createWallet(card.modulus, card.exponent, phone.x, phone.y, USDC(50), USDC(80));
    wallet = await ethers.getContractAt("Tap2EthWallet", await factory.walletOf(ethers.keccak256(card.modulus)));
    await token.faucet(await wallet.getAddress(), USDC(1000));
  });

  async function expiry() {
    return (await ethers.provider.getBlock("latest")).timestamp + 300;
  }

  async function signPayment(amount, opts = {}) {
    const exp = await expiry();
    const nonce = await wallet.nonce();
    const h = await wallet.paymentHash(await token.getAddress(), merchant.address, amount, nonce, exp);
    const cardSig = (opts.card || card).sign(Buffer.from(h.slice(2, 10), "hex"));
    const phoneSig = (opts.phone || phone).sign(opts.phoneHash || h);
    return { exp, cardSig, phoneSig };
  }

  it("verifies an EMV-style card signature", async () => {
    const ch = crypto.randomBytes(4);
    expect(await wallet.verifyCard(ch, card.sign(ch))).to.equal(true);
    expect(await wallet.verifyCard(crypto.randomBytes(4), card.sign(ch))).to.equal(false);
  });

  it("pays when card + phone both sign", async () => {
    const { exp, cardSig, phoneSig } = await signPayment(USDC(20));
    const tx = await wallet.pay(await token.getAddress(), merchant.address, USDC(20), exp, cardSig, phoneSig);
    const rc = await tx.wait();
    console.log("      gas used for pay():", rc.gasUsed.toString());
    expect(await token.balanceOf(merchant.address)).to.equal(USDC(20));
    expect(await wallet.nonce()).to.equal(1n);
  });

  it("rejects a wrong card", async () => {
    const { exp, cardSig, phoneSig } = await signPayment(USDC(20), { card: makeCard() });
    await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(20), exp, cardSig, phoneSig))
      .to.be.revertedWithCustomError(wallet, "BadCardSignature");
  });

  it("rejects a wrong phone", async () => {
    const { exp, cardSig, phoneSig } = await signPayment(USDC(20), { phone: makePasskey() });
    await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(20), exp, cardSig, phoneSig))
      .to.be.revertedWithCustomError(wallet, "BadPhoneSignature");
  });

  it("rejects a tampered amount", async () => {
    const { exp, cardSig, phoneSig } = await signPayment(USDC(20));
    await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(30), exp, cardSig, phoneSig)).to.be.reverted;
  });

  it("rejects a replay", async () => {
    const { exp, cardSig, phoneSig } = await signPayment(USDC(10));
    await wallet.pay(await token.getAddress(), merchant.address, USDC(10), exp, cardSig, phoneSig);
    await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(10), exp, cardSig, phoneSig)).to.be.reverted;
  });

  it("enforces per-payment and daily limits", async () => {
    let p = await signPayment(USDC(60));
    await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(60), p.exp, p.cardSig, p.phoneSig))
      .to.be.revertedWithCustomError(wallet, "OverLimit");
    p = await signPayment(USDC(50));
    await wallet.pay(await token.getAddress(), merchant.address, USDC(50), p.exp, p.cardSig, p.phoneSig);
    p = await signPayment(USDC(40));
    await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(40), p.exp, p.cardSig, p.phoneSig))
      .to.be.revertedWithCustomError(wallet, "OverLimit");
  });

  it("freezes with the phone alone and blocks payments", async () => {
    const exp = await expiry();
    const h = await wallet.actionHash("freeze", "0x", await wallet.nonce(), exp);
    await wallet.freeze(exp, phone.sign(h));
    expect(await wallet.frozen()).to.equal(true);
    const p = await signPayment(USDC(5));
    await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(5), p.exp, p.cardSig, p.phoneSig))
      .to.be.revertedWithCustomError(wallet, "IsFrozen");
  });

  it("unfreezes with card + phone", async () => {
    let exp = await expiry();
    let h = await wallet.actionHash("freeze", "0x", await wallet.nonce(), exp);
    await wallet.freeze(exp, phone.sign(h));
    exp = await expiry();
    h = await wallet.actionHash("unfreeze", "0x", await wallet.nonce(), exp);
    await wallet.unfreeze(exp, card.sign(Buffer.from(h.slice(2, 10), "hex")), phone.sign(h));
    expect(await wallet.frozen()).to.equal(false);
  });

  it("replaces the card and keeps the wallet", async () => {
    const newCard = makeCard();
    const exp = await expiry();
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "bytes"], [newCard.modulus, newCard.exponent]);
    const h = await wallet.actionHash("replaceCard", params, await wallet.nonce(), exp);
    await wallet.replaceCard(newCard.modulus, newCard.exponent, exp, newCard.sign(Buffer.from(h.slice(2, 10), "hex")), phone.sign(h));
    expect(await factory.walletOf(ethers.keccak256(newCard.modulus))).to.equal(await wallet.getAddress());
    card = newCard;
    const p = await signPayment(USDC(5));
    await wallet.pay(await token.getAddress(), merchant.address, USDC(5), p.exp, p.cardSig, p.phoneSig);
  });
});

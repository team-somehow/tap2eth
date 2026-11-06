// Covers everything in the frame wallet that runs as ordinary EVM: the shared verifier and the SENDER-frame
// payment logic. The VERIFY fallback uses frame opcodes, which Hardhat cannot run, so that is tested on a devnet.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const crypto = require("crypto");
const { makeCard, makePasskey } = require("./helpers");

const USDC = (x) => ethers.parseUnits(String(x), 6);
const DAY = 86_400;
const MAX_FRAME_CONTRACT_BYTES = 9_500; // 16.7M tx cap at about 1,700 gas per byte on the frame devnet

describe("Tap2ETH frame wallet", function () {
  let verifier, paymaster, token, wallet, walletAddress, card, phone, merchant, terminal;

  beforeEach(async () => {
    [, merchant, terminal] = await ethers.getSigners();
    card = makeCard();
    phone = makePasskey();
    verifier = await (await ethers.getContractFactory("Tap2EthVerifier")).deploy();
    paymaster = await (await ethers.getContractFactory("QuotaPaymaster")).deploy(1_000n, 5_000n);
    token = await (await ethers.getContractFactory("TestUSDC")).deploy();
    wallet = await (await ethers.getContractFactory("Tap2EthFrameWallet")).deploy(
      card.modulus, card.exponent, phone.x, phone.y, USDC(50), USDC(80),
      await verifier.getAddress(), await paymaster.getAddress(), terminal.address,
    );
    walletAddress = await wallet.getAddress();
    await token.faucet(walletAddress, USDC(1000));
  });

  const expiry = async () => (await time.latest()) + 300;

  async function signPayment(amount, opts = {}) {
    const exp = opts.expiry ?? (await expiry());
    const h = await wallet.paymentHash(await token.getAddress(), merchant.address, amount, await wallet.nonce(), exp);
    const cardSig = (opts.card || card).sign(Buffer.from(h.slice(2, 10), "hex"));
    const phoneSig = (opts.phone || phone).sign(opts.phoneHash || h);
    return { exp, cardSig, phoneSig };
  }

  async function pay(amount, opts) {
    const { exp, cardSig, phoneSig } = await signPayment(amount, opts);
    return wallet.pay(await token.getAddress(), merchant.address, amount, exp, cardSig, phoneSig);
  }

  async function signAction(action, opts = {}) {
    const exp = await expiry();
    const h = await wallet.actionHash(action, "0x", await wallet.nonce(), exp);
    return { exp, h, phoneSig: phone.sign(h), cardSig: (opts.card || card).sign(Buffer.from(h.slice(2, 10), "hex")) };
  }

  describe("verifier", () => {
    it("accepts a card signature over the right challenge only", async () => {
      const challenge = crypto.randomBytes(4);
      const sig = card.sign(challenge);
      expect(await verifier.verifyCard(card.modulus, card.exponent, challenge, sig)).to.equal(true);
      expect(await verifier.verifyCard(card.modulus, card.exponent, crypto.randomBytes(4), sig)).to.equal(false);
    });

    it("rejects a card signature of the wrong length", async () => {
      expect(await verifier.verifyCard(card.modulus, card.exponent, "0x01020304", "0x1234")).to.equal(false);
    });

    it("accepts a phone signature over the right hash only", async () => {
      const h = ethers.keccak256("0x01");
      const sig = phone.sign(h);
      expect(await verifier.verifyPhone(h, sig, phone.x, phone.y)).to.equal(true);
      expect(await verifier.verifyPhone(ethers.keccak256("0x02"), sig, phone.x, phone.y)).to.equal(false);
    });

    it("rejects a phone signature from another key", async () => {
      const h = ethers.keccak256("0x01");
      expect(await verifier.verifyPhone(h, makePasskey().sign(h), phone.x, phone.y)).to.equal(false);
    });

    it("rejects an assertion without user verification", async () => {
      const h = ethers.keccak256("0x01");
      const sig = phone.sign(h);
      const noUv = "0x" + sig.authenticatorData.slice(2, 66) + "01" + sig.authenticatorData.slice(68);
      expect(await verifier.verifyPhone(h, { ...sig, authenticatorData: noUv }, phone.x, phone.y)).to.equal(false);
    });
  });

  describe("payments", () => {
    it("pays when card and phone both sign", async () => {
      await expect(pay(USDC(20))).to.emit(wallet, "Paid");
      expect(await token.balanceOf(merchant.address)).to.equal(USDC(20));
      expect(await wallet.nonce()).to.equal(1n);
    });

    it("rejects a wrong card", async () => {
      await expect(pay(USDC(20), { card: makeCard() })).to.be.revertedWithCustomError(wallet, "BadCardSignature");
    });

    it("rejects a phone signature for a different hash", async () => {
      await expect(pay(USDC(20), { phoneHash: ethers.keccak256("0x01") })).to.be.revertedWithCustomError(wallet, "BadPhoneSignature");
    });

    it("rejects a replay of the same signatures", async () => {
      const { exp, cardSig, phoneSig } = await signPayment(USDC(20));
      const args = [await token.getAddress(), merchant.address, USDC(20), exp, cardSig, phoneSig];
      await wallet.pay(...args);
      await expect(wallet.pay(...args)).to.be.reverted;
      expect(await token.balanceOf(merchant.address)).to.equal(USDC(20));
    });

    it("rejects an expired payment", async () => {
      await expect(pay(USDC(20), { expiry: (await time.latest()) - 1 })).to.be.revertedWithCustomError(wallet, "Expired");
    });

    it("rejects an amount over the per-payment limit", async () => {
      await expect(pay(USDC(51))).to.be.revertedWithCustomError(wallet, "OverLimit");
    });

    it("enforces the daily limit and resets it the next day", async () => {
      await pay(USDC(50));
      await expect(pay(USDC(31))).to.be.revertedWithCustomError(wallet, "OverLimit");
      await time.increase(DAY);
      await pay(USDC(31));
      expect(await token.balanceOf(merchant.address)).to.equal(USDC(81));
    });

    it("restarts the paymaster quota window after a day", async () => {
      await paymaster.enrol(walletAddress);
      const [, before] = await paymaster.quotas(walletAddress);
      await time.increase(DAY + 1);
      await pay(USDC(1));
      const [, after] = await paymaster.quotas(walletAddress);
      expect(after).to.be.greaterThan(before);
    });

    it("still pays when the paymaster cannot roll the quota, and says so", async () => {
      const noPaymaster = await (await ethers.getContractFactory("Tap2EthFrameWallet")).deploy(
        card.modulus, card.exponent, phone.x, phone.y, USDC(50), USDC(80),
        await verifier.getAddress(), await token.getAddress(), terminal.address,
      );
      await token.faucet(await noPaymaster.getAddress(), USDC(100));
      const exp = await expiry();
      const h = await noPaymaster.paymentHash(await token.getAddress(), merchant.address, USDC(5), 0n, exp);
      const tx = noPaymaster.pay(await token.getAddress(), merchant.address, USDC(5), exp, card.sign(Buffer.from(h.slice(2, 10), "hex")), phone.sign(h));
      await expect(tx).to.emit(noPaymaster, "QuotaRollFailed");
      expect(await token.balanceOf(merchant.address)).to.equal(USDC(5));
    });
  });

  describe("freeze", () => {
    it("freezes with the phone alone and blocks payments", async () => {
      const { exp, phoneSig } = await signAction("freeze");
      await wallet.freeze(exp, phoneSig);
      expect(await wallet.frozen()).to.equal(true);
      await expect(pay(USDC(5))).to.be.revertedWithCustomError(wallet, "IsFrozen");
    });

    it("rejects a freeze signed by another phone", async () => {
      const { exp, h } = await signAction("freeze");
      await expect(wallet.freeze(exp, makePasskey().sign(h))).to.be.revertedWithCustomError(wallet, "BadPhoneSignature");
    });

    it("needs card and phone to unfreeze", async () => {
      const frozen = await signAction("freeze");
      await wallet.freeze(frozen.exp, frozen.phoneSig);

      const bad = await signAction("unfreeze", { card: makeCard() });
      await expect(wallet.unfreeze(bad.exp, bad.cardSig, bad.phoneSig)).to.be.revertedWithCustomError(wallet, "BadCardSignature");

      const good = await signAction("unfreeze");
      await wallet.unfreeze(good.exp, good.cardSig, good.phoneSig);
      expect(await wallet.frozen()).to.equal(false);
      await pay(USDC(5));
    });
  });

  it("every frame contract fits the devnet's deploy cap", async () => {
    for (const name of ["Tap2EthVerifier", "Tap2EthFrameWallet", "QuotaPaymaster"]) {
      const { bytecode } = await ethers.getContractFactory(name);
      expect((bytecode.length - 2) / 2, `${name} creation code`).to.be.lessThan(MAX_FRAME_CONTRACT_BYTES);
    }
  });
});

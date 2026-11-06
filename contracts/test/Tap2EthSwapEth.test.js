// ETH send / receive / limits of the swap wallet. Runs on the local Hardhat chain (no Uniswap or network needed).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { makeCard, makePasskey } = require("./helpers");

const coder = ethers.AbiCoder.defaultAbiCoder();
const PHONE_T = "tuple(bytes authenticatorData,string clientDataJSON,uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s)";
const USDT = (x) => ethers.parseUnits(String(x), 6);
const cardSig = (card, h) => "0x" + card.sign(Buffer.from(h.slice(2, 10), "hex")).toString("hex");

describe("Tap2ETH swap wallet: ETH", function () {
  let wallet, card, phone, merchant;

  beforeEach(async () => {
    [, merchant] = await ethers.getSigners();
    // The router, WETH and token are only used by payWithSwap; these tests never call it.
    const dummy = ethers.Wallet.createRandom().address;
    const factory = await (await ethers.getContractFactory("Tap2EthFactorySwap")).deploy(dummy, dummy, dummy);
    card = makeCard();
    phone = makePasskey();
    const params = { cardModulus: card.modulus, cardExponent: card.exponent, phoneX: phone.x, phoneY: phone.y, perTxLimit: USDT(50), dailyLimit: USDT(80), recoveryDelay: 3600 };
    const h = await factory.createHash(params);
    await factory.createWallet(params, cardSig(card, h), phone.sign(h));
    wallet = await ethers.getContractAt("Tap2EthWalletSwap", await factory.walletOf(ethers.keccak256(card.modulus)));
    await ethers.provider.send("hardhat_setBalance", [await wallet.getAddress(), "0x" + ethers.parseEther("1").toString(16)]);
  });

    const ETH = (x) => ethers.parseEther(String(x));
    const sendHash = async (to, amount, exp) => wallet.sendEthHash(to, amount, await wallet.nonce(), exp);
    const sigsFor = (h, who = ["card", "phone"]) => {
      const out = [];
      if (who.includes("card")) out.push({ id: 0, data: cardSig(card, h) });
      if (who.includes("phone")) out.push({ id: 1, data: coder.encode([PHONE_T], [phone.sign(h)]) });
      return out;
    };

    it("emits EthReceived when ETH is sent to the wallet", async () => {
      const [funder] = await ethers.getSigners();
      await expect(funder.sendTransaction({ to: await wallet.getAddress(), value: ETH(0.01) }))
        .to.emit(wallet, "EthReceived").withArgs(funder.address, ETH(0.01));
    });

    it("sends ETH with card + phone", async () => {
      const exp = (await time.latest()) + 300;
      const h = await sendHash(merchant.address, ETH(0.01), exp);
      const before = await ethers.provider.getBalance(merchant.address);
      await expect(wallet.sendEth(merchant.address, ETH(0.01), exp, sigsFor(h))).to.emit(wallet, "EthSent");
      expect((await ethers.provider.getBalance(merchant.address)) - before).to.equal(ETH(0.01));
    });

    it("needs a phone signature, and a card alone is refused", async () => {
      const exp = (await time.latest()) + 300;
      const h = await sendHash(merchant.address, ETH(0.01), exp);
      await expect(wallet.sendEth(merchant.address, ETH(0.01), exp, sigsFor(h, ["card"]))).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
    });

    it("refuses over the default per-send limit (0.05 ETH) and over the daily limit (0.1 ETH)", async () => {
      let exp = (await time.latest()) + 300;
      let h = await sendHash(merchant.address, ETH(0.06), exp);
      await expect(wallet.sendEth(merchant.address, ETH(0.06), exp, sigsFor(h))).to.be.revertedWithCustomError(wallet, "OverLimit");
      for (let i = 0; i < 2; i++) { // 2 x 0.05 = the 0.1 daily limit
        exp = (await time.latest()) + 300;
        h = await sendHash(merchant.address, ETH(0.05), exp);
        await wallet.sendEth(merchant.address, ETH(0.05), exp, sigsFor(h));
      }
      exp = (await time.latest()) + 300;
      h = await sendHash(merchant.address, ETH(0.01), exp);
      await expect(wallet.sendEth(merchant.address, ETH(0.01), exp, sigsFor(h))).to.be.revertedWithCustomError(wallet, "OverLimit");
    });

    it("cannot change the amount or recipient after signing, cannot replay", async () => {
      const exp = (await time.latest()) + 300;
      const h = await sendHash(merchant.address, ETH(0.01), exp);
      const sg = sigsFor(h);
      await expect(wallet.sendEth(merchant.address, ETH(0.02), exp, sg)).to.be.reverted;
      await wallet.sendEth(merchant.address, ETH(0.01), exp, sg);
      await expect(wallet.sendEth(merchant.address, ETH(0.01), exp, sg)).to.be.reverted;
    });

    it("the owner can raise the ETH limits with card + phone", async () => {
      expect(await wallet.ethPerTxLimit()).to.equal(ETH(0.05));
      let exp = (await time.latest()) + 300;
      const ah = await wallet.actionHash("ethLimits", coder.encode(["uint256", "uint256"], [ETH(0.5), ETH(0.5)]), exp);
      await wallet.setEthLimits(ETH(0.5), ETH(0.5), exp, sigsFor(ah));
      expect(await wallet.ethPerTxLimit()).to.equal(ETH(0.5));
      exp = (await time.latest()) + 300;
      const h = await sendHash(merchant.address, ETH(0.3), exp);
      await wallet.sendEth(merchant.address, ETH(0.3), exp, sigsFor(h));
    });

    it("a frozen wallet cannot send ETH", async () => {
      let exp = (await time.latest()) + 300;
      const fh = await wallet.actionHash("freeze", "0x", exp);
      await wallet.freeze(exp, [{ id: 1, data: coder.encode([PHONE_T], [phone.sign(fh)]) }]);
      exp = (await time.latest()) + 300;
      const h = await sendHash(merchant.address, ETH(0.01), exp);
      await expect(wallet.sendEth(merchant.address, ETH(0.01), exp, sigsFor(h))).to.be.revertedWithCustomError(wallet, "IsFrozen");
    });
});

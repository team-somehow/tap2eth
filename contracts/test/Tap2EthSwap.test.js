// Tests the wallet's pay-in-ETH against the REAL Uniswap v3 on a fork of Ethereum Sepolia.
// Needs network access to a Sepolia RPC. Skipped if the fork cannot start.  Run: npx hardhat test test/Tap2EthSwap.test.js
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { makeCard, makePasskey } = require("./helpers");

const coder = ethers.AbiCoder.defaultAbiCoder();
const PHONE_T = "tuple(bytes authenticatorData,string clientDataJSON,uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s)";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const UNI = { // Uniswap v3 on Sepolia
  router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
  weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  usdt: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0",
};
// Pinned so Hardhat caches the forked state on disk: the first run downloads it, later runs are fast and repeatable.
const FORK_BLOCK = Number(process.env.FORK_BLOCK || 12077900);
const FEE = 10000; // the 1% WETH/USDT pool has the most liquidity
const USDT = (x) => ethers.parseUnits(String(x), 6);
const cardSig = (card, h) => "0x" + card.sign(Buffer.from(h.slice(2, 10), "hex")).toString("hex");

describe("Tap2ETH wallet: pay in ETH through Uniswap v3 (Sepolia fork)", function () {
  this.timeout(120000);
  let factory, wallet, card, phone, merchant, usdt, quoter;

  before(async function () {
    try {
      await network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: SEPOLIA_RPC, blockNumber: FORK_BLOCK } }] });
    } catch (e) {
      console.log("      (no Sepolia fork available, skipping:", e.message.slice(0, 80), ")");
      this.skip();
    }
  });
  after(async () => { await network.provider.request({ method: "hardhat_reset", params: [] }); });

  beforeEach(async () => {
    [, merchant] = await ethers.getSigners();
    usdt = await ethers.getContractAt("IERC20", UNI.usdt);
    quoter = new ethers.Contract(UNI.quoter, ["function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountIn,uint160,uint32,uint256)"], ethers.provider);
    factory = await (await ethers.getContractFactory("Tap2EthFactorySwap")).deploy(UNI.router, UNI.weth, UNI.usdt);
    card = makeCard();
    phone = makePasskey();
    const params = { cardModulus: card.modulus, cardExponent: card.exponent, phoneX: phone.x, phoneY: phone.y, perTxLimit: USDT(50), dailyLimit: USDT(80), recoveryDelay: 3600 };
    const h = await factory.createHash(params);
    await factory.createWallet(params, cardSig(card, h), phone.sign(h));
    wallet = await ethers.getContractAt("Tap2EthWalletSwap", await factory.walletOf(ethers.keccak256(card.modulus)));
    await ethers.provider.send("hardhat_setBalance", [await wallet.getAddress(), "0x" + ethers.parseEther("1").toString(16)]);
  });

  async function quote(out) {
    const [amountIn] = await quoter.quoteExactOutputSingle.staticCall({ tokenIn: UNI.weth, tokenOut: UNI.usdt, amount: out, fee: FEE, sqrtPriceLimitX96: 0 });
    return amountIn + amountIn / 100n; // 1% slippage allowance
  }

  async function paySwap({ out = USDT(0.1), signers = ["card", "phone"], maxIn, expiryOffset = 300 } = {}) {
    maxIn = maxIn ?? (await quote(out));
    const exp = (await time.latest()) + expiryOffset;
    const h = await wallet.swapPaymentHash(merchant.address, out, maxIn, FEE, await wallet.nonce(), exp);
    const sigs = [];
    if (signers.includes("card")) sigs.push({ id: 0, data: cardSig(card, h) });
    if (signers.includes("phone")) sigs.push({ id: 1, data: coder.encode([PHONE_T], [phone.sign(h)]) });
    return { call: () => wallet.payWithSwap(merchant.address, out, maxIn, FEE, exp, sigs), maxIn, out };
  }

  it("pays the merchant EXACTLY the USDT amount from the wallet's ETH and keeps the unused ETH", async () => {
    const { call, maxIn, out } = await paySwap({ out: USDT(0.1) });
    const ethBefore = await ethers.provider.getBalance(await wallet.getAddress());
    const usdtBefore = await usdt.balanceOf(merchant.address);
    const rc = await (await call()).wait();
    const usdtGot = (await usdt.balanceOf(merchant.address)) - usdtBefore;
    const ethSpent = ethBefore - (await ethers.provider.getBalance(await wallet.getAddress()));
    expect(usdtGot).to.equal(out);
    expect(ethSpent).to.be.gt(0n).and.lte(maxIn);
    expect(ethSpent).to.be.lt(maxIn); // the 1% allowance came back
    expect(await usdt.balanceOf(await wallet.getAddress())).to.equal(0n); // nothing left in the wallet
    const ev = rc.logs.map((l) => { try { return wallet.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "PaidWithSwap");
    expect(ev.args.stableOut).to.equal(out);
    expect(ev.args.ethIn).to.equal(ethSpent);
    console.log(`      0.1 USDT cost ${ethers.formatEther(ethSpent)} ETH, gas ${rc.gasUsed}`);
  });

  it("needs a phone signature (card alone is refused)", async () => {
    const { call } = await paySwap({ signers: ["card"] });
    await expect(call()).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
  });

  it("refuses over the per-payment limit", async () => {
    const { call } = await paySwap({ out: USDT(51), maxIn: ethers.parseEther("1") });
    await expect(call()).to.be.revertedWithCustomError(wallet, "OverLimit");
  });

  it("a relayer cannot change the amount or merchant: the signature stops matching", async () => {
    const { maxIn } = await paySwap();
    const exp = (await time.latest()) + 300;
    const h = await wallet.swapPaymentHash(merchant.address, USDT(0.1), maxIn, FEE, 0, exp);
    const sigs = [{ id: 0, data: cardSig(card, h) }, { id: 1, data: coder.encode([PHONE_T], [phone.sign(h)]) }];
    await expect(wallet.payWithSwap(merchant.address, USDT(5), maxIn, FEE, exp, sigs)).to.be.reverted;
  });

  it("cannot be replayed (nonce) or used after expiry", async () => {
    const first = await paySwap();
    await first.call();
    await expect(first.call()).to.be.reverted; // old nonce
    const late = await paySwap({ expiryOffset: 10 });
    await time.increase(60);
    await expect(late.call()).to.be.revertedWithCustomError(wallet, "Expired");
  });

  it("reverts and pays nothing when the price moves past the ETH cap", async () => {
    const { call } = await paySwap({ maxIn: 1n }); // cap far below the real cost
    const before = await usdt.balanceOf(merchant.address);
    await expect(call()).to.be.reverted;
    expect(await usdt.balanceOf(merchant.address)).to.equal(before);
  });
});

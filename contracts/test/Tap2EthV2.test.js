const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { makeCard, makePasskey } = require("./helpers");

const coder = ethers.AbiCoder.defaultAbiCoder();
const PHONE_T = "tuple(bytes authenticatorData,string clientDataJSON,uint256 challengeIndex,uint256 typeIndex,bytes32 r,bytes32 s)";
const USDC = (x) => ethers.parseUnits(String(x), 6);
const CARD = 0;
const PHONE = 1;

// A signer in the tests: { kind: "card" | "phone", obj, id }
const cardSig = (card, h) => "0x" + card.sign(Buffer.from(h.slice(2, 10), "hex")).toString("hex");
const sigOf = (s, h) => ({ id: s.id, data: s.kind === "card" ? cardSig(s.obj, h) : coder.encode([PHONE_T], [s.obj.sign(h)]) });
const sigs = (list, h) => list.slice().sort((a, b) => a.id - b.id).map((s) => sigOf(s, h));

describe("Tap2ETH wallet v2", function () {
  let factory, impl, token, wallet, merchant, relayer;
  let card, phone; // first card (id 0) and first phone (id 1)
  const C = () => ({ kind: "card", obj: card, id: 0 });
  const P = () => ({ kind: "phone", obj: phone, id: 1 });

  async function makeWallet(overrides = {}) {
    const c = overrides.card || makeCard();
    const p = overrides.phone || makePasskey();
    const params = {
      cardModulus: c.modulus,
      cardExponent: c.exponent,
      phoneX: p.x,
      phoneY: p.y,
      perTxLimit: USDC(50),
      dailyLimit: USDC(80),
      recoveryDelay: 3600,
      ...(overrides.params || {}),
    };
    const h = await factory.createHash(params);
    const signCard = overrides.signCard || c;
    const signPhone = overrides.signPhone || p;
    await factory.createWallet(params, cardSig(signCard, h), signPhone.sign(h));
    const addr = await factory.walletOf(ethers.keccak256(c.modulus));
    return { c, p, wallet: await ethers.getContractAt("Tap2EthWalletV2", addr) };
  }

  beforeEach(async () => {
    [relayer, merchant] = await ethers.getSigners();
    factory = await (await ethers.getContractFactory("Tap2EthFactoryV2")).deploy();
    impl = await ethers.getContractAt("Tap2EthWalletV2", await factory.implementation());
    token = await (await ethers.getContractFactory("TestUSDC")).deploy();
    const made = await makeWallet();
    card = made.c;
    phone = made.p;
    wallet = made.wallet;
    await token.faucet(await wallet.getAddress(), USDC(1000));
  });

  const expiry = async () => (await time.latest()) + 300;

  async function pay(list, amount, w = wallet) {
    const exp = await expiry();
    const h = await w.paymentHash(await token.getAddress(), merchant.address, amount, await w.nonce(), exp);
    return w.pay(await token.getAddress(), merchant.address, amount, exp, sigs(list, h));
  }

  /** Runs a management call: builds the action hash, signs it with `list`, and calls `send(exp, sigs, h)`. */
  async function act(name, params, list, send) {
    const exp = await expiry();
    const h = await wallet.actionHash(name, params, exp);
    return send(exp, sigs(list, h), h);
  }

  async function addCard(newCard, signers = [C(), P()]) {
    const k = ethers.keccak256;
    return act("addSigner", coder.encode(["uint8", "bytes32", "bytes32"], [CARD, k(newCard.modulus), k(newCard.exponent)]), signers, (exp, s, h) =>
      wallet.addSigner(CARD, newCard.modulus, newCard.exponent, exp, s, cardSig(newCard, h)),
    );
  }

  describe("creation", () => {
    it("creates a wallet with card + phone and a 2-signature threshold", async () => {
      expect(await wallet.threshold()).to.equal(2);
      expect(await wallet.activeCount()).to.equal(2);
      expect(await wallet.phoneCount()).to.equal(1);
      expect(await factory.walletOf(ethers.keccak256(card.modulus))).to.equal(await wallet.getAddress());
    });

    it("rejects a creation signed by a card the creator does not hold (squatting)", async () => {
      const victim = makeCard();
      const attacker = makeCard();
      const p = makePasskey();
      await expect(makeWallet({ card: victim, phone: p, signCard: attacker })).to.be.revertedWithCustomError(impl, "BadSignature");
    });

    it("rejects a creation with the wrong phone signature", async () => {
      await expect(makeWallet({ signPhone: makePasskey() })).to.be.revertedWithCustomError(impl, "BadSignature");
    });

    it("cannot register the same card twice", async () => {
      await expect(makeWallet({ card })).to.be.revertedWith("card already registered");
    });

    it("the implementation contract itself cannot be initialized", async () => {
      const params = { cardModulus: card.modulus, cardExponent: card.exponent, phoneX: phone.x, phoneY: phone.y, perTxLimit: 1, dailyLimit: 1, recoveryDelay: 0 };
      await expect(impl.initialize(params, "0x", phone.sign(ethers.ZeroHash))).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    });
  });

  describe("payments (2 of N, at least one phone)", () => {
    it("pays when card + phone both sign", async () => {
      const tx = await pay([C(), P()], USDC(10));
      const rc = await tx.wait();
      console.log("      gas used for pay() with 2 signatures:", rc.gasUsed.toString());
      expect(await token.balanceOf(merchant.address)).to.equal(USDC(10));
    });

    it("rejects a single signature", async () => {
      await expect(pay([P()], USDC(10))).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
      await expect(pay([C()], USDC(10))).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
    });

    it("rejects the same signer twice", async () => {
      await expect(pay([P(), P()], USDC(10))).to.be.revertedWithCustomError(wallet, "SignaturesNotSorted");
    });

    it("rejects a replay and a tampered amount", async () => {
      const exp = await expiry();
      const h = await wallet.paymentHash(await token.getAddress(), merchant.address, USDC(10), await wallet.nonce(), exp);
      const s = sigs([C(), P()], h);
      await wallet.pay(await token.getAddress(), merchant.address, USDC(10), exp, s);
      await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(10), exp, s)).to.be.revertedWithCustomError(wallet, "BadSignature");
      const h2 = await wallet.paymentHash(await token.getAddress(), merchant.address, USDC(10), await wallet.nonce(), exp);
      await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(11), exp, sigs([C(), P()], h2))).to.be.revertedWithCustomError(wallet, "BadSignature");
    });

    it("rejects an expired payment", async () => {
      const exp = await expiry();
      const h = await wallet.paymentHash(await token.getAddress(), merchant.address, USDC(1), await wallet.nonce(), exp);
      const s = sigs([C(), P()], h);
      await time.increase(1000);
      await expect(wallet.pay(await token.getAddress(), merchant.address, USDC(1), exp, s)).to.be.revertedWithCustomError(wallet, "Expired");
    });
  });

  describe("daily and per-payment limits (set with both signatures)", () => {
    it("enforces the limits", async () => {
      await expect(pay([C(), P()], USDC(51))).to.be.revertedWithCustomError(wallet, "OverLimit");
      await pay([C(), P()], USDC(50));
      await expect(pay([C(), P()], USDC(40))).to.be.revertedWithCustomError(wallet, "OverLimit"); // 90 > 80 a day
      await time.increase(24 * 3600);
      await pay([C(), P()], USDC(40)); // new day
    });

    it("changes limits with card + phone, not with one signature", async () => {
      const set = (list) => act("limits", coder.encode(["uint256", "uint256"], [USDC(100), USDC(300)]), list, (e, s) => wallet.setLimits(USDC(100), USDC(300), e, s));
      await expect(set([P()])).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
      await set([C(), P()]);
      expect(await wallet.perTxLimit()).to.equal(USDC(100));
      expect(await wallet.dailyLimit()).to.equal(USDC(300));
      await pay([C(), P()], USDC(100));
    });
  });

  describe("optional 1-of-2 threshold for small payments", () => {
    const setSoft = (amount, cardOnly) =>
      act("softLimit", coder.encode(["uint256", "bool"], [amount, cardOnly]), [C(), P()], (e, s) => wallet.setSoftLimit(amount, cardOnly, e, s));

    it("is off by default", async () => {
      expect(await wallet.softLimit()).to.equal(0);
      await expect(pay([P()], USDC(1))).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
    });

    it("lets a phone alone pay up to the amount, but not above it", async () => {
      await setSoft(USDC(10), false);
      await pay([P()], USDC(5));
      await expect(pay([P()], USDC(20))).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
      await pay([C(), P()], USDC(20)); // bigger still works with both
    });

    it("does not accept a card alone unless card-only is switched on", async () => {
      await setSoft(USDC(10), false);
      await expect(pay([C()], USDC(5))).to.be.revertedWithCustomError(wallet, "PhoneRequired");
      await setSoft(USDC(10), true);
      await pay([C()], USDC(5));
    });

    it("still counts against the daily limit and cannot exceed the per-payment limit", async () => {
      await expect(setSoft(USDC(60), false)).to.be.revertedWithCustomError(wallet, "OverLimit");
      await setSoft(USDC(50), false);
      await pay([P()], USDC(50));
      await expect(pay([P()], USDC(40))).to.be.revertedWithCustomError(wallet, "OverLimit");
    });
  });

  describe("more signers, still 2 of N", () => {
    it("adds a second card with 2 signatures plus the new card's own proof", async () => {
      const card2 = makeCard();
      await addCard(card2);
      expect(await wallet.activeCount()).to.equal(3);
      expect(await factory.walletOf(ethers.keccak256(card2.modulus))).to.equal(await wallet.getAddress());
      const C2 = { kind: "card", obj: card2, id: 2 };
      await pay([C2, P()], USDC(10)); // new card + phone
      await pay([C(), P()], USDC(10)); // original card + phone
    });

    it("never accepts two cards without a phone", async () => {
      const card2 = makeCard();
      await addCard(card2);
      await expect(pay([C(), { kind: "card", obj: card2, id: 2 }], USDC(10))).to.be.revertedWithCustomError(wallet, "PhoneRequired");
    });

    it("needs the existing threshold to add, and the new key's proof", async () => {
      const card2 = makeCard();
      await expect(addCard(card2, [P()])).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
      const k = ethers.keccak256;
      const bad = act("addSigner", coder.encode(["uint8", "bytes32", "bytes32"], [CARD, k(card2.modulus), k(card2.exponent)]), [C(), P()], (exp, s, h) =>
        wallet.addSigner(CARD, card2.modulus, card2.exponent, exp, s, cardSig(makeCard(), h)),
      );
      await expect(bad).to.be.revertedWithCustomError(wallet, "BadSignature");
    });

    it("cannot add a card that already belongs to another wallet", async () => {
      const other = await makeWallet();
      await expect(addCard(other.c)).to.be.revertedWith("card already registered");
    });

    it("adds a second phone", async () => {
      const phone2 = makePasskey();
      const k = ethers.keccak256;
      const x = coder.encode(["bytes32"], [phone2.x]);
      const y = coder.encode(["bytes32"], [phone2.y]);
      await act("addSigner", coder.encode(["uint8", "bytes32", "bytes32"], [PHONE, k(x), k(y)]), [C(), P()], (exp, s, h) =>
        wallet.addSigner(PHONE, x, y, exp, s, coder.encode([PHONE_T], [phone2.sign(h)])),
      );
      expect(await wallet.phoneCount()).to.equal(2);
      await pay([C(), { kind: "phone", obj: phone2, id: 2 }], USDC(10));
    });

    it("raises the threshold to 3 of 3, and rejects 4 of 3", async () => {
      const card2 = makeCard();
      await addCard(card2);
      const C2 = { kind: "card", obj: card2, id: 2 };
      const setT = (m, list) => act("threshold", coder.encode(["uint256"], [m]), list, (e, s) => wallet.setThreshold(m, e, s));
      await expect(setT(4, [C(), P()])).to.be.revertedWithCustomError(wallet, "BadThreshold");
      await setT(3, [C(), P()]);
      await expect(pay([C(), P()], USDC(10))).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
      await pay([C(), C2, P()], USDC(10));
    });

    it("removes a card, but never below the threshold or the last phone", async () => {
      const card2 = makeCard();
      await addCard(card2);
      const rm = (id, list) => act("removeSigner", coder.encode(["uint256"], [id]), list, (e, s) => wallet.removeSigner(id, e, s));
      await expect(rm(1, [C(), P()])).to.be.revertedWithCustomError(wallet, "LastPhone");
      await rm(2, [C(), P()]);
      expect(await wallet.activeCount()).to.equal(2);
      expect(await factory.walletOf(ethers.keccak256(card2.modulus))).to.equal(ethers.ZeroAddress);
      await expect(rm(0, [C(), P()])).to.be.revertedWithCustomError(wallet, "BelowThreshold");
      await expect(pay([{ kind: "card", obj: card2, id: 2 }, P()], USDC(1))).to.be.revertedWithCustomError(wallet, "UnknownSigner");
    });
  });

  describe("freeze", () => {
    const freeze = (list) => act("freeze", "0x", list, (e, s) => wallet.freeze(e, s));
    const unfreeze = (list) => act("unfreeze", "0x", list, (e, s) => wallet.unfreeze(e, s));

    it("freezes with a phone alone, and a card alone cannot", async () => {
      await expect(freeze([C()])).to.be.revertedWithCustomError(wallet, "PhoneRequired");
      await freeze([P()]);
      await expect(pay([C(), P()], USDC(1))).to.be.revertedWithCustomError(wallet, "IsFrozen");
    });

    it("unfreezes only with the full threshold", async () => {
      await freeze([P()]);
      await expect(unfreeze([P()])).to.be.revertedWithCustomError(wallet, "NotEnoughSignatures");
      await unfreeze([C(), P()]);
      await pay([C(), P()], USDC(1));
    });
  });

  describe("lost card recovery (time-locked)", () => {
    const newCard = makeCard();
    const k = ethers.keccak256;
    const propose = (oldId, list, nc = newCard) =>
      act("proposeRecovery", coder.encode(["uint256", "bytes32", "bytes32"], [oldId, k(nc.modulus), k(nc.exponent)]), list, (e, s, h) =>
        wallet.proposeRecovery(oldId, nc.modulus, nc.exponent, e, s, cardSig(nc, h)),
      );

    it("replaces a card only after the delay", async () => {
      await propose(0, [P()]); // lost the card: phone + the new card's proof
      await expect(wallet.executeRecovery()).to.be.revertedWithCustomError(wallet, "RecoveryNotReady");
      await expect(pay([C(), P()], USDC(1))).to.not.be.reverted; // old card still works until then
      await time.increase(3601);
      await wallet.executeRecovery();
      await expect(pay([C(), P()], USDC(1))).to.be.revertedWithCustomError(wallet, "UnknownSigner");
      await pay([{ kind: "card", obj: newCard, id: 2 }, P()], USDC(1));
      expect(await factory.walletOf(k(card.modulus))).to.equal(ethers.ZeroAddress);
      expect(await factory.walletOf(k(newCard.modulus))).to.equal(await wallet.getAddress());
    });

    it("can be cancelled by the old card before it takes effect", async () => {
      await propose(0, [P()]);
      await act("cancelRecovery", "0x", [C()], (e, s) => wallet.cancelRecovery(e, s));
      await time.increase(3601);
      await expect(wallet.executeRecovery()).to.be.revertedWithCustomError(wallet, "NoRecovery");
      await pay([C(), P()], USDC(1)); // original card unaffected
    });

    it("needs a phone signature and only works on a card", async () => {
      await expect(propose(0, [C()])).to.be.revertedWithCustomError(wallet, "PhoneRequired");
      await expect(propose(1, [P()])).to.be.revertedWithCustomError(wallet, "NotCard");
    });
  });

  describe("lost phone recovery by two cards (one 4-byte piece per card)", () => {
    let card2, C2;
    beforeEach(async () => {
      card2 = makeCard();
      await addCard(card2); // card ids: 0 and 2; phone id: 1
      C2 = { kind: "card", obj: card2, id: 2 };
    });

    /** Two cards (no phone) plus the new phone start the replacement. `cards` are signers, `cardSigner` can override who signs. */
    async function proposePhone(newPhone, cards = [C(), C2], exp) {
      exp = exp || (await expiry());
      const h = await wallet.phoneRecoveryHash(newPhone.x, newPhone.y, exp);
      return wallet.proposePhoneRecovery(newPhone.x, newPhone.y, exp, sigs(cards, h), coder.encode([PHONE_T], [newPhone.sign(h)]));
    }

    it("replaces the phone after the delay with two cards and no phone signature", async () => {
      const np = makePasskey();
      await proposePhone(np);
      await expect(wallet.executePhoneRecovery()).to.be.revertedWithCustomError(wallet, "RecoveryNotReady");
      await pay([C(), P()], USDC(1)); // the old phone keeps working until then
      await time.increase(3601);
      await wallet.executePhoneRecovery();
      expect(await wallet.phoneCount()).to.equal(1);
      expect(await wallet.activeCount()).to.equal(3);
      await expect(pay([C(), P()], USDC(1))).to.be.revertedWithCustomError(wallet, "UnknownSigner"); // old phone is gone
      await pay([C(), { kind: "phone", obj: np, id: 3 }], USDC(1)); // new phone works with a card
    });

    it("needs two different cards", async () => {
      const np = makePasskey();
      await expect(proposePhone(np, [C()])).to.be.revertedWithCustomError(wallet, "NotEnoughCards");
      await expect(proposePhone(np, [])).to.be.revertedWithCustomError(wallet, "NotEnoughCards");
      await expect(proposePhone(np, [C(), C()])).to.be.revertedWithCustomError(wallet, "SignaturesNotSorted");
    });

    it("rejects a phone among the signers, a wrong card signature and unknown ids", async () => {
      const np = makePasskey();
      await expect(proposePhone(np, [C(), P()])).to.be.revertedWithCustomError(wallet, "NotCard");
      await expect(proposePhone(np, [C(), { ...C2, obj: makeCard() }])).to.be.revertedWithCustomError(wallet, "BadSignature");
      await expect(proposePhone(np, [C(), { ...C2, id: 7 }])).to.be.revertedWithCustomError(wallet, "UnknownSigner");
    });

    it("the new phone must prove it holds its key", async () => {
      const np = makePasskey();
      const exp = await expiry();
      const h = await wallet.phoneRecoveryHash(np.x, np.y, exp);
      await expect(wallet.proposePhoneRecovery(np.x, np.y, exp, sigs([C(), C2], h), coder.encode([PHONE_T], [makePasskey().sign(h)])))
        .to.be.revertedWithCustomError(wallet, "BadSignature");
    });

    it("rejects a request signed for a different phone or an expired one", async () => {
      const np = makePasskey();
      const other = makePasskey();
      const exp = await expiry();
      const h = await wallet.phoneRecoveryHash(np.x, np.y, exp);
      await expect(wallet.proposePhoneRecovery(other.x, other.y, exp, sigs([C(), C2], h), coder.encode([PHONE_T], [other.sign(h)])))
        .to.be.revertedWithCustomError(wallet, "BadSignature");
      await time.increase(1000);
      await expect(wallet.proposePhoneRecovery(np.x, np.y, exp, sigs([C(), C2], h), coder.encode([PHONE_T], [np.sign(h)])))
        .to.be.revertedWithCustomError(wallet, "Expired");
    });

    it("cannot start a second replacement while one is pending, or re-add a current phone", async () => {
      await expect(proposePhone(phone)).to.be.revertedWithCustomError(wallet, "DuplicateKey");
      await proposePhone(makePasskey());
      await expect(proposePhone(makePasskey())).to.be.revertedWithCustomError(wallet, "RecoveryPending");
    });

    it("can be cancelled by the old phone alone or by a single card", async () => {
      const cancel = (list) => act("cancelPhoneRecovery", "0x", list, (e, s) => wallet.cancelPhoneRecovery(e, s));
      await proposePhone(makePasskey());
      await cancel([P()]);
      await time.increase(3601);
      await expect(wallet.executePhoneRecovery()).to.be.revertedWithCustomError(wallet, "NoRecovery");
      await pay([C(), P()], USDC(1)); // old phone unaffected
      await proposePhone(makePasskey());
      await cancel([C2]);
      await expect(wallet.executePhoneRecovery()).to.be.revertedWithCustomError(wallet, "NoRecovery");
      await expect(cancel([P()])).to.be.revertedWithCustomError(wallet, "NoRecovery");
    });

    it("replaces every old phone and lowers the threshold if it no longer fits", async () => {
      const phone2 = makePasskey();
      const k = ethers.keccak256;
      const x = coder.encode(["bytes32"], [phone2.x]);
      const y = coder.encode(["bytes32"], [phone2.y]);
      await act("addSigner", coder.encode(["uint8", "bytes32", "bytes32"], [PHONE, k(x), k(y)]), [C(), P()], (exp, s, h) =>
        wallet.addSigner(PHONE, x, y, exp, s, coder.encode([PHONE_T], [phone2.sign(h)])),
      ); // phone id 3: now 2 cards + 2 phones
      await act("threshold", coder.encode(["uint256"], [4]), [C(), P()], (e, s) => wallet.setThreshold(4, e, s));
      expect(await wallet.threshold()).to.equal(4);
      const np = makePasskey();
      await proposePhone(np);
      await time.increase(3601);
      await wallet.executePhoneRecovery();
      expect(await wallet.phoneCount()).to.equal(1);
      expect(await wallet.activeCount()).to.equal(3);
      expect(await wallet.threshold()).to.equal(3);
      await pay([C(), C2, { kind: "phone", obj: np, id: 4 }], USDC(1));
    });

    it("a wallet with a single card cannot start it", async () => {
      const lone = await makeWallet();
      const np = makePasskey();
      const exp = await expiry();
      const h = await lone.wallet.phoneRecoveryHash(np.x, np.y, exp);
      const one = [{ id: 0, data: cardSig(lone.c, h) }];
      await expect(lone.wallet.proposePhoneRecovery(np.x, np.y, exp, one, coder.encode([PHONE_T], [np.sign(h)])))
        .to.be.revertedWithCustomError(lone.wallet, "NotEnoughCards");
    });
  });
});

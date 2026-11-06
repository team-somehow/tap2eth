// Demo mode: lets the app's real screens run on a phone with no NFC and no native key module
// (for example Expo Go), so the UI and UX can be tested. It turns on only when the native
// KeystoreSigner module is missing. A real build never uses any of this.
//
// What is faked: the bank card, the phone key, and the relayer. Nothing leaves the phone.
import { requireOptionalNativeModule } from "expo";

export const DEMO = !requireOptionalNativeModule("KeystoreSigner");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");

const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const WALLET = "0x" + rand(20);

const db = {
  balance: 100,
  perTx: 50,
  daily: 200,
  spent: 0,
  frozen: false,
  pending: [],
  history: [],
  actions: new Map(),
};

// ------------------------------------------------------------------ fake card + phone key

/** Stands in for tapping a bank card: waits like a real scan, then hands back a fake key and signature. */
export async function demoCard(getChallenge) {
  await wait(1800);
  const key = { modulus: rand(128), exponent: "03" };
  const challenge = await getChallenge(key);
  return { ...key, signature: challenge ? rand(128) : null };
}

export const demoPhone = {
  createKey: () => ({ phoneX: "0x" + rand(32), phoneY: "0x" + rand(32) }),
  async sign(hashHex) {
    await wait(700); // like the fingerprint prompt
    return {
      authenticatorData: "0x" + rand(37),
      clientDataJSON: JSON.stringify({ type: "webauthn.get", challenge: hashHex }),
      challengeIndex: 0,
      typeIndex: 0,
      r: "0x" + rand(32),
      s: "0x" + rand(32),
    };
  },
};

// ------------------------------------------------------------------ fake relayer

const publicPayment = (p) => ({ ...p, merchant: MERCHANT, merchantName: p.merchantName || "Demo Café" });

/** Pretend a merchant terminal just charged this wallet (adds a pending payment the app will show). */
export function demoCharge(amount) {
  db.pending.push({
    id: "demo-" + rand(6),
    wallet: WALLET,
    amount: String(amount),
    expiry: Math.floor(Date.now() / 1000) + 300,
    hash: "0x" + rand(32),
    status: "waiting_for_phone",
    merchantName: "Demo Café",
  });
}

export async function demoApi(path, body) {
  await wait(250);
  let m;
  if (path === "/api/signup/challenge") return { id: rand(6), challenge: rand(4) };
  if (path === "/api/signup") return { wallet: WALLET };

  if ((m = path.match(/^\/api\/wallet\//))) {
    const f = (n) => String(n);
    return {
      wallet: WALLET,
      balance: f(db.balance),
      perTxLimit: f(db.perTx),
      dailyLimit: f(db.daily),
      spentToday: f(db.spent),
      frozen: db.frozen,
      pending: db.pending.map(publicPayment),
      history: db.history.slice(0, 10).map(publicPayment),
      merchant: MERCHANT,
    };
  }

  if ((m = path.match(/^\/api\/pay\/([^/]+)\/phone$/))) {
    const p = db.pending.find((q) => q.id === m[1]);
    if (!p) throw new Error("unknown payment");
    db.pending = db.pending.filter((q) => q !== p);
    const amt = Number(p.amount);
    let error;
    if (db.frozen) error = "IsFrozen";
    else if (amt > db.perTx || db.spent + amt > db.daily) error = "OverLimit";
    else if (amt > db.balance) error = "Not enough balance";
    if (error) {
      db.history.unshift({ ...p, status: "failed", error });
      return publicPayment({ ...p, status: "failed", error });
    }
    db.balance -= amt;
    db.spent += amt;
    const paid = { ...p, status: "paid", txHash: "0x" + rand(32) };
    db.history.unshift(paid);
    return publicPayment(paid);
  }

  if ((m = path.match(/^\/api\/pay\/([^/]+)\/reject$/))) {
    const p = db.pending.find((q) => q.id === m[1]);
    if (p) {
      db.pending = db.pending.filter((q) => q !== p);
      db.history.unshift({ ...p, status: "rejected" });
    }
    return { status: "rejected" };
  }

  if (path === "/api/freeze/start") {
    const id = rand(6);
    db.actions.set(id, "freeze");
    return { id, hash: "0x" + rand(32) };
  }
  if ((m = path.match(/^\/api\/freeze\/([^/]+)$/))) {
    db.frozen = true;
    return { status: "frozen", txHash: "0x" + rand(32) };
  }
  if (path === "/api/unfreeze/start") {
    const id = rand(6);
    return { id, hash: "0x" + rand(32), challenge: rand(4) };
  }
  if ((m = path.match(/^\/api\/unfreeze\/([^/]+)$/))) {
    db.frozen = false;
    return { status: "active", txHash: "0x" + rand(32) };
  }

  throw new Error(`demo: no handler for ${path}`);
}

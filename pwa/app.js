// Tap2ETH PWA: owns the phone passkey (P-256, WebAuthn). Signs payment hashes after biometrics.
const $ = (id) => document.getElementById(id);
const store = {
  get: () => JSON.parse(localStorage.getItem("tap2eth") || "{}"),
  set: (v) => localStorage.setItem("tap2eth", JSON.stringify({ ...store.get(), ...v })),
  clear: () => localStorage.removeItem("tap2eth"),
};
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toHex = (buf) => "0x" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g).map((b) => parseInt(b, 16)));

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

function show(view) {
  for (const v of ["welcome", "link", "home"]) $("view-" + v).classList.toggle("hidden", v !== view);
}
function err(e) { $("err").textContent = e ? String(e.message || e) : ""; }

// ---------------------------------------------------------------- passkey

async function createPasskey() {
  if (!window.PublicKeyCredential) throw new Error("Passkeys need HTTPS and a modern browser.");
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: "Tap2ETH" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "tap2eth-user", displayName: "Tap2ETH wallet" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 = P-256
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      timeout: 60000,
    },
  });
  const spki = new Uint8Array(cred.response.getPublicKey()); // SPKI DER, ends with 04 || X || Y
  const xy = spki.slice(spki.length - 64);
  return { credentialId: b64u(cred.rawId), phoneX: toHex(xy.slice(0, 32)), phoneY: toHex(xy.slice(32)) };
}

/** Sign a 32-byte hash with the passkey; returns the struct the contract expects. */
async function signHash(hashHex) {
  const { credentialId } = store.get();
  const a = await navigator.credentials.get({
    publicKey: {
      challenge: fromHex(hashHex),
      allowCredentials: [{ type: "public-key", id: fromB64u(credentialId) }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  const clientDataJSON = new TextDecoder().decode(a.response.clientDataJSON);
  const { r, s } = derToRS(new Uint8Array(a.response.signature));
  return {
    authenticatorData: toHex(a.response.authenticatorData),
    clientDataJSON,
    challengeIndex: clientDataJSON.indexOf('"challenge":"'),
    typeIndex: clientDataJSON.indexOf('"type":"webauthn.get"'),
    r, s,
  };
}

function derToRS(der) {
  // SEQUENCE { INTEGER r, INTEGER s }
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const read = () => { i++; const len = der[i++]; const v = der.slice(i, i + len); i += len; return v; };
  const big = (b) => BigInt(toHex(b));
  let r = big(read()), s = big(read());
  if (s > P256_N / 2n) s = P256_N - s; // low-s, as the contract's P256 check expects
  const h = (x) => "0x" + x.toString(16).padStart(64, "0");
  return { r: h(r), s: h(s) };
}

// ---------------------------------------------------------------- flows

$("btn-create").onclick = async () => {
  err();
  try {
    const pk = await createPasskey();
    const { code } = await api("/api/register/start", pk);
    store.set({ ...pk, code });
    startLinking();
  } catch (e) { err(e); }
};

function startLinking() {
  show("link");
  $("link-code").textContent = store.get().code;
  const t = setInterval(async () => {
    try {
      const r = await api("/api/register/" + store.get().code);
      if (r.status === "creating_wallet") $("link-status").textContent = "Card found, creating your wallet…";
      if (r.status === "failed") $("link-status").textContent = "Failed: " + r.error;
      if (r.status === "done") { clearInterval(t); store.set({ wallet: r.wallet }); home(); }
    } catch (e) { $("link-status").textContent = String(e.message); }
  }, 1500);
}

let busy = false;
async function refresh() {
  const { wallet } = store.get();
  const w = await api("/api/wallet/" + wallet);
  $("addr").textContent = wallet;
  $("balance").textContent = Number(w.balance).toFixed(2);
  $("limit-tx").textContent = w.perTxLimit + " tUSDC";
  $("limit-day").textContent = w.dailyLimit + " tUSDC";
  $("spent").textContent = w.spentToday + " tUSDC";
  $("status-pill").textContent = w.frozen ? "Frozen" : "Active";
  $("status-pill").className = "pill " + (w.frozen ? "frozen" : "ok");
  $("btn-freeze").classList.toggle("hidden", w.frozen);
  $("history").innerHTML = w.history.length
    ? w.history.map((p) => `<div class="row"><span>${p.merchantName}</span><span>${p.status === "paid" ? "−" + p.amount : p.status}</span></div>`).join("")
    : "None yet.";
  if (!busy) {
    $("pending").innerHTML = w.pending.map((p) => `
      <div class="box pay">
        <div class="muted">Payment request</div>
        <div class="big">${p.amount} tUSDC</div>
        <div>to <b>${p.merchantName}</b></div>
        <button class="primary" data-approve="${p.id}" data-hash="${p.hash}">Approve with fingerprint</button>
        <button class="secondary" data-reject="${p.id}">Decline</button>
      </div>`).join("");
    if (w.pending.length && navigator.vibrate) navigator.vibrate(200);
  }
}

$("pending").onclick = async (ev) => {
  const t = ev.target;
  err();
  if (t.dataset.approve) {
    busy = true;
    t.textContent = "Waiting for fingerprint…";
    try {
      const phoneSig = await signHash(t.dataset.hash);
      t.textContent = "Sending…";
      const r = await api(`/api/pay/${t.dataset.approve}/phone`, { phoneSig });
      if (r.status !== "paid") throw new Error("Payment failed: " + r.error);
      $("pending").innerHTML = `<div class="box">✅ Paid ${r.amount} tUSDC</div>`;
    } catch (e) { err(e); }
    busy = false;
    setTimeout(refresh, 1500);
  } else if (t.dataset.reject) {
    await api(`/api/pay/${t.dataset.reject}/reject`, {});
    refresh();
  }
};

$("btn-freeze").onclick = async () => {
  err();
  if (!confirm("Freeze the wallet? Payments will be blocked until you unfreeze with card + phone.")) return;
  try {
    const { id, hash } = await api("/api/freeze/start", { wallet: store.get().wallet });
    const phoneSig = await signHash(hash);
    await api("/api/freeze/" + id, { phoneSig });
    refresh();
  } catch (e) { err(e); }
};

$("btn-reset").onclick = () => {
  if (confirm("Remove this wallet from this phone? (Funds stay on-chain.)")) { store.clear(); location.reload(); }
};

function home() {
  show("home");
  refresh().catch(err);
  setInterval(() => refresh().catch(() => {}), 2000);
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
const s = store.get();
if (s.wallet) home();
else if (s.code) startLinking();
else show("welcome");

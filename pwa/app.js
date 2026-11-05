// Tap2ETH PWA: owns the phone passkey (P-256, WebAuthn) and signs payment hashes after biometrics.
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
const short = (a) => (a ? a.slice(0, 6) + " " + a.slice(6, 10) + " … " + a.slice(-4) : "");
const fmt = (n) => Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Server error (${res.status})`);
  return j;
}

function show(view) {
  for (const v of ["welcome", "link", "home"]) $("view-" + v).hidden = v !== view;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// Turn WebAuthn / server errors into something a person can act on.
function explain(e) {
  const m = String(e?.message || e);
  if (e?.name === "NotAllowedError") return "Fingerprint check was cancelled. Try again.";
  if (m.includes("HTTPS") || !window.isSecureContext) return "Open this app over HTTPS to use passkeys.";
  if (m.includes("OverLimit")) return "Declined: this payment is over your spending limit.";
  if (m.includes("IsFrozen")) return "Declined: your wallet is frozen.";
  if (m.includes("Expired")) return "This payment request expired. Ask the merchant to charge again.";
  return m;
}

// ------------------------------------------------------------------- passkey

async function createPasskey() {
  if (!window.PublicKeyCredential || !window.isSecureContext) throw new Error("Passkeys need HTTPS.");
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: "Tap2ETH" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Tap2ETH wallet", displayName: "Tap2ETH wallet" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 = P-256
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      timeout: 60000,
    },
  });
  const spki = new Uint8Array(cred.response.getPublicKey()); // SPKI DER ends with 04 || X || Y
  const xy = spki.slice(spki.length - 64);
  return { credentialId: b64u(cred.rawId), phoneX: toHex(xy.slice(0, 32)), phoneY: toHex(xy.slice(32)) };
}

/** Sign a 32-byte hash with the passkey; returns the struct the contract expects. */
async function signHash(hashHex) {
  const a = await navigator.credentials.get({
    publicKey: {
      challenge: fromHex(hashHex),
      allowCredentials: [{ type: "public-key", id: fromB64u(store.get().credentialId) }],
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
    r,
    s,
  };
}

function derToRS(der) {
  let i = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const read = () => { i++; const len = der[i++]; const v = der.slice(i, i + len); i += len; return BigInt(toHex(v)); };
  const r = read();
  let s = read();
  if (s > P256_N / 2n) s = P256_N - s; // low-s, as the contract's P-256 check expects
  const h = (x) => "0x" + x.toString(16).padStart(64, "0");
  return { r: h(r), s: h(s) };
}

// ------------------------------------------------------------------- onboarding

$("btn-create").onclick = async () => {
  const btn = $("btn-create");
  btn.disabled = true;
  btn.textContent = "Waiting for fingerprint…";
  try {
    const pk = await createPasskey();
    const { code } = await api("/api/register/start", pk);
    store.set({ ...pk, code });
    startLinking();
  } catch (e) {
    toast(explain(e), true);
  }
  btn.disabled = false;
  btn.textContent = "Create wallet";
};

let linkTimer;
function setLinkStatus(text, kind) {
  const s = $("link-status");
  s.className = "status" + (kind ? " " + kind : "");
  s.innerHTML = (kind ? "" : '<span class="spinner"></span>') + `<span>${text}</span>`;
}
function startLinking() {
  show("link");
  $("link-code").innerHTML = [...store.get().code].map((d) => `<span>${d}</span>`).join("");
  setLinkStatus("Waiting for your card");
  clearInterval(linkTimer);
  linkTimer = setInterval(async () => {
    try {
      const r = await api("/api/register/" + store.get().code);
      if (r.status === "creating_wallet") setLinkStatus("Card read. Creating your wallet…");
      if (r.status === "failed") setLinkStatus(r.error + ". Tap the card again.", "bad");
      if (r.status === "done") {
        clearInterval(linkTimer);
        store.set({ wallet: r.wallet, code: undefined });
        setLinkStatus("Card linked", "good");
        setTimeout(home, 700);
      }
    } catch (e) {
      if (String(e.message).includes("unknown code")) {
        clearInterval(linkTimer);
        setLinkStatus("This code expired. Start over to get a new one.", "bad");
      }
    }
  }, 1500);
}
$("btn-restart").onclick = () => { clearInterval(linkTimer); store.clear(); show("welcome"); };

// ------------------------------------------------------------------- home

let current = null; // payment shown in the sheet
let sheetBusy = false;
const seen = new Set();

async function refresh() {
  const { wallet } = store.get();
  const w = await api("/api/wallet/" + wallet);
  $("card-addr").textContent = short(wallet);
  $("card").classList.toggle("frozen", w.frozen);
  $("state-tag").textContent = w.frozen ? "Frozen" : "Active";
  $("state-tag").className = "state-tag" + (w.frozen ? " frozen" : "");
  $("btn-freeze").hidden = w.frozen;
  $("frozen-note").hidden = !w.frozen;
  $("balance").textContent = fmt(w.balance);
  $("spent").textContent = fmt(w.spentToday);
  $("daily").textContent = fmt(w.dailyLimit);
  $("pertx").textContent = fmt(w.perTxLimit);
  $("meter-fill").style.width = Math.min(100, (100 * Number(w.spentToday)) / Number(w.dailyLimit || 1)) + "%";

  $("activity").innerHTML = w.history.length
    ? w.history.map((p) => `<li><div><div class="who">${esc(p.merchantName)}</div><div class="when">${p.status === "paid" ? "Paid" : p.status === "rejected" ? "You declined" : explain(p.error || "Failed")}</div></div>
        <div class="amt ${p.status === "paid" ? "" : "declined"}">${p.status === "paid" ? "−" + fmt(p.amount) : "Not paid"}</div></li>`).join("")
    : '<li class="empty">Tap your card at a terminal to make your first payment.</li>';

  const next = w.pending.find((p) => !seen.has(p.id));
  if (next && !sheetBusy && !current) openPaySheet(next);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function openPaySheet(p) {
  current = p;
  $("pay-merchant").textContent = p.merchantName;
  $("pay-amount").textContent = fmt(p.amount);
  $("pay-note").textContent = "Only confirm if you just tapped your card here.";
  $("btn-approve").disabled = false;
  $("btn-approve").lastChild.textContent = "Confirm with fingerprint";
  $("pay-sheet").hidden = false;
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
}
function closePaySheet() {
  if (current) seen.add(current.id);
  current = null;
  $("pay-sheet").hidden = true;
}

$("btn-approve").onclick = async () => {
  if (!current) return;
  sheetBusy = true;
  const btn = $("btn-approve");
  btn.disabled = true;
  btn.lastChild.textContent = "Waiting for fingerprint…";
  try {
    const phoneSig = await signHash(current.hash);
    btn.lastChild.textContent = "Sending payment…";
    const r = await api(`/api/pay/${current.id}/phone`, { phoneSig });
    if (r.status !== "paid") throw new Error(r.error || "Payment failed");
    closePaySheet();
    toast(`Paid ${fmt(r.amount)} tUSDC to ${r.merchantName}`);
  } catch (e) {
    if (e?.name === "NotAllowedError") {
      btn.disabled = false;
      btn.lastChild.textContent = "Confirm with fingerprint";
      $("pay-note").textContent = "Fingerprint check was cancelled. Try again or decline.";
    } else {
      closePaySheet();
      toast(explain(e), true);
    }
  }
  sheetBusy = false;
  refresh().catch(() => {});
};

$("btn-decline").onclick = async () => {
  if (!current) return;
  const id = current.id;
  closePaySheet();
  await api(`/api/pay/${id}/reject`, {}).catch(() => {});
  toast("Payment declined");
  refresh().catch(() => {});
};

$("btn-freeze").onclick = () => ($("freeze-sheet").hidden = false);
$("btn-freeze-cancel").onclick = () => ($("freeze-sheet").hidden = true);
$("btn-freeze-confirm").onclick = async () => {
  const btn = $("btn-freeze-confirm");
  btn.disabled = true;
  btn.textContent = "Waiting for fingerprint…";
  try {
    const { id, hash } = await api("/api/freeze/start", { wallet: store.get().wallet });
    const phoneSig = await signHash(hash);
    btn.textContent = "Freezing…";
    await api("/api/freeze/" + id, { phoneSig });
    $("freeze-sheet").hidden = true;
    toast("Wallet frozen. All payments are blocked.");
  } catch (e) {
    toast(explain(e), true);
  }
  btn.disabled = false;
  btn.textContent = "Freeze wallet";
  refresh().catch(() => {});
};

$("btn-forget").onclick = () => {
  if (confirm("Remove this wallet from this phone? Your funds stay on-chain, but this phone's passkey is needed to spend them.")) {
    store.clear();
    location.reload();
  }
};

let homeTimer;
function home() {
  show("home");
  refresh().catch((e) => toast(explain(e), true));
  clearInterval(homeTimer);
  homeTimer = setInterval(() => refresh().catch(() => {}), 1500);
}

// ------------------------------------------------------------------- boot
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
const s = store.get();
if (s.wallet) home();
else if (s.code) startLinking();
else show("welcome");

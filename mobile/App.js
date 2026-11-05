import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Modal, Pressable, ScrollView, StyleSheet, Text, Vibration, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { withCard, cancelCard } from "./lib/emv";
import { biometricsReady, createPhoneKey, forgetPhoneKey, signWithPhone } from "./lib/phone";

// The relayer runs on the laptop; `adb reverse tcp:8787 tcp:8787` makes it localhost on the phone.
const RELAYER = "http://localhost:8787";

const C = { paper: "#EEF1F5", surface: "#FFFFFF", ink: "#14213D", soft: "#4B5872", line: "#D7DDE6", gold: "#C9A14A", blue: "#2457F5", green: "#178A55", red: "#C0392B", ice: "#BFD8EE" };

async function api(path, body) {
  const res = await fetch(RELAYER + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Server error (${res.status})`);
  return j;
}
const fmt = (n) => Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (a) => (a ? `${a.slice(0, 6)} ${a.slice(6, 10)} … ${a.slice(-4)}` : "");
function explain(e) {
  const m = String(e?.message || e);
  if (/cancel/i.test(m)) return "Cancelled.";
  if (m.includes("OverLimit")) return "Declined: this payment is over your spending limit.";
  if (m.includes("IsFrozen")) return "Declined: your wallet is frozen.";
  if (m.includes("Expired")) return "This request expired. Ask the merchant to charge again.";
  if (/Network request failed/.test(m)) return "Can't reach the Tap2ETH server.";
  if (/Tag was lost|transceive/i.test(m)) return "The card moved away. Hold it still against the phone and try again.";
  return m;
}

// ------------------------------------------------------------------ small pieces

function Chip() {
  return <View style={s.chip}><View style={s.chipInner} /></View>;
}
function Waves({ color = "rgba(255,255,255,.85)" }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      {[10, 16, 22].map((h) => <View key={h} style={{ width: 6, height: h, borderColor: color, borderRightWidth: 2.5, borderRadius: 12 }} />)}
    </View>
  );
}
function Button({ title, onPress, kind = "primary", disabled, big }) {
  const st = { primary: [s.btnPrimary, s.btnTextLight], danger: [s.btnDanger, s.btnTextLight], ghost: [s.btnGhost, s.btnTextSoft], outline: [s.btnOutline, s.btnTextRed] }[kind];
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [s.btn, st[0], big && { paddingVertical: 18 }, (pressed || disabled) && { opacity: 0.6 }]}>
      <Text style={[s.btnText, st[1]]}>{title}</Text>
    </Pressable>
  );
}
function Sheet({ visible, onClose, children }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} />
      <View style={s.sheet}><View style={s.grabber} />{children}</View>
    </Modal>
  );
}
/** Pulsing "hold card here" illustration shown while scanning. */
function ScanArt() {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([Animated.timing(a, { toValue: 1, duration: 900, useNativeDriver: true }), Animated.timing(a, { toValue: 0, duration: 900, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [a]);
  return (
    <View style={s.scanArt}>
      <View style={s.phoneOutline}><Waves color={C.blue} /></View>
      <Animated.View style={[s.miniCard, { transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [0, -14] }) }] }]}>
        <Chip />
      </Animated.View>
    </View>
  );
}

// ------------------------------------------------------------------ screens

function Welcome({ onDone }) {
  const [step, setStep] = useState("intro"); // intro | scanning | creating
  const [err, setErr] = useState("");

  async function start() {
    setErr("");
    if (!biometricsReady()) return setErr("Set up a fingerprint on this phone first (Settings → Biometrics).");
    setStep("scanning");
    try {
      let ch;
      const card = await withCard(async () => {
        ch = await api("/api/signup/challenge");
        return ch.challenge;
      });
      setStep("creating");
      const phone = createPhoneKey();
      // Prove the new phone key works (and that the person is present) before creating the wallet.
      await signWithPhone("0x" + "00".repeat(32), "Create your Tap2ETH wallet", "Confirm with your fingerprint");
      const r = await api("/api/signup", { id: ch.id, ...phone, cardModulus: card.modulus, cardExponent: card.exponent, cardSig: card.signature });
      await AsyncStorage.setItem("wallet", r.wallet);
      onDone(r.wallet);
    } catch (e) {
      setErr(explain(e));
      setStep("intro");
    }
  }

  if (step !== "intro") {
    return (
      <View style={s.center}>
        {step === "scanning" ? <ScanArt /> : <ActivityIndicator size="large" color={C.blue} />}
        <Text style={s.h2}>{step === "scanning" ? "Hold your card to the back of the phone" : "Creating your wallet"}</Text>
        <Text style={s.lede}>{step === "scanning" ? "Keep it still for a couple of seconds. We read your card's public key and it signs a test message." : "Confirm with your fingerprint when asked."}</Text>
        {step === "scanning" && <Button kind="ghost" title="Cancel" onPress={() => { cancelCard(); setStep("intro"); }} />}
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={s.page}>
      <View style={s.heroArt}>
        <View style={s.miniCardStatic}><Chip /><Waves /></View>
        <Text style={s.plus}>+</Text>
        <View style={s.phoneOutline}><View style={s.print} /></View>
      </View>
      <Text style={s.display}>Your bank card is now your crypto wallet</Text>
      <Text style={s.lede}>Pay in stablecoins by tapping the card you already carry. No seed phrase, no new card.</Text>
      {[["Tap your card", " at the merchant terminal to start a payment."], ["Confirm with your fingerprint", " on this phone to send it."], ["Neither works alone.", " A lost card or a lost phone can't spend your money."]].map(([b, t]) => (
        <View key={b} style={s.fact}><Text style={s.factText}><Text style={s.bold}>{b}</Text>{t}</Text></View>
      ))}
      <Button title="Create wallet" onPress={start} />
      <Text style={s.fine}>You'll hold your bank card to the phone, then use your fingerprint. Your card number never leaves this phone.</Text>
      {!!err && <Text style={s.err}>{err}</Text>}
    </ScrollView>
  );
}

function Home({ wallet, onForget }) {
  const [w, setW] = useState(null);
  const [pay, setPay] = useState(null);
  const [payBusy, setPayBusy] = useState("");
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [unfreezeOpen, setUnfreezeOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState(null);
  const seen = useRef(new Set());

  const say = (text, bad) => { setToast({ text, bad }); setTimeout(() => setToast(null), 4000); };

  const refresh = useCallback(async () => {
    const d = await api("/api/wallet/" + wallet);
    setW(d);
    const next = d.pending.find((p) => !seen.current.has(p.id));
    setPay((cur) => {
      if (!cur && next) { Vibration.vibrate([0, 60, 40, 60]); return next; }
      return cur;
    });
  }, [wallet]);

  useEffect(() => {
    refresh().catch((e) => say(explain(e), true));
    const t = setInterval(() => refresh().catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [refresh]);

  async function approve() {
    setPayBusy("Waiting for fingerprint…");
    try {
      const phoneSig = await signWithPhone(pay.hash, `Pay ${fmt(pay.amount)} tUSDC`, `to ${pay.merchantName}`);
      setPayBusy("Sending payment…");
      const r = await api(`/api/pay/${pay.id}/phone`, { phoneSig });
      if (r.status !== "paid") throw new Error(r.error || "Payment failed");
      say(`Paid ${fmt(r.amount)} tUSDC to ${r.merchantName}`);
    } catch (e) {
      if (/cancel/i.test(String(e.message))) { setPayBusy(""); return; }
      say(explain(e), true);
    }
    seen.current.add(pay.id);
    setPay(null);
    setPayBusy("");
    refresh().catch(() => {});
  }
  async function decline() {
    seen.current.add(pay.id);
    const id = pay.id;
    setPay(null);
    await api(`/api/pay/${id}/reject`, {}).catch(() => {});
    say("Payment declined");
  }
  async function freeze() {
    setBusy("freeze");
    try {
      const { id, hash } = await api("/api/freeze/start", { wallet });
      const phoneSig = await signWithPhone(hash, "Freeze your wallet", "Blocks all payments");
      await api("/api/freeze/" + id, { phoneSig });
      setFreezeOpen(false);
      say("Wallet frozen. All payments are blocked.");
    } catch (e) { say(explain(e), true); }
    setBusy("");
    refresh().catch(() => {});
  }
  async function unfreeze() {
    setBusy("scan");
    try {
      let req;
      const card = await withCard(async () => {
        req = await api("/api/unfreeze/start", { wallet });
        return req.challenge;
      });
      setBusy("unfreeze");
      const phoneSig = await signWithPhone(req.hash, "Unfreeze your wallet", "Payments will work again");
      await api("/api/unfreeze/" + req.id, { cardSig: card.signature, phoneSig });
      setUnfreezeOpen(false);
      say("Wallet active again.");
    } catch (e) { say(explain(e), true); }
    setBusy("");
    refresh().catch(() => {});
  }

  const frozen = !!w?.frozen;
  const pct = w ? Math.min(100, (100 * Number(w.spentToday)) / Number(w.dailyLimit || 1)) : 0;
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.page}>
        <View style={s.top}>
          <Text style={s.brand}>Tap2ETH</Text>
          <Text style={[s.tag, frozen && s.tagFrozen]}>{frozen ? "Frozen" : "Active"}</Text>
        </View>

        <View style={s.card}>
          <View style={s.cardRow}><Chip /><Waves /></View>
          <View>
            <Text style={s.cardLabel}>Linked bank card</Text>
            <Text style={s.cardAddr}>{short(wallet)}</Text>
          </View>
          {frozen && <View style={s.frost}><Text style={s.frostText}>🔒 Frozen</Text></View>}
        </View>

        <View style={s.balanceRow}>
          <Text style={s.amount}>{w ? fmt(w.balance) : "–"}</Text>
          <Text style={s.unit}>tUSDC</Text>
        </View>
        <View style={s.meter}><View style={[s.meterFill, { width: `${pct}%` }]} /></View>
        <Text style={s.meterText}>{w ? `${fmt(w.spentToday)} of ${fmt(w.dailyLimit)} spent today · up to ${fmt(w.perTxLimit)} per payment` : " "}</Text>

        <Text style={s.sectionTitle}>Activity</Text>
        <View style={s.activity}>
          {!w?.history?.length ? (
            <Text style={[s.soft, { padding: 16 }]}>Tap your card at a terminal to make your first payment.</Text>
          ) : (
            w.history.map((p, i) => (
              <View key={p.id} style={[s.actRow, i > 0 && s.actBorder]}>
                <View>
                  <Text style={s.bold}>{p.merchantName}</Text>
                  <Text style={s.small}>{p.status === "paid" ? "Paid" : p.status === "rejected" ? "You declined" : explain(p.error || "Failed")}</Text>
                </View>
                <Text style={p.status === "paid" ? s.actAmt : s.actFail}>{p.status === "paid" ? "−" + fmt(p.amount) : "Not paid"}</Text>
              </View>
            ))
          )}
        </View>

        {frozen ? (
          <>
            <Button title="Unfreeze with your card" onPress={() => setUnfreezeOpen(true)} />
            <Text style={s.fine}>Payments are blocked. Unfreezing needs your card and your fingerprint.</Text>
          </>
        ) : (
          <View style={{ marginTop: 22 }}><Button kind="outline" title="Freeze wallet" onPress={() => setFreezeOpen(true)} /></View>
        )}
        <Pressable onPress={onForget}><Text style={s.link}>Remove wallet from this phone</Text></Pressable>
      </ScrollView>

      {toast && <View style={[s.toast, toast.bad && { backgroundColor: C.red }]}><Text style={s.toastText}>{toast.text}</Text></View>}

      <Sheet visible={!!pay} onClose={() => !payBusy && decline()}>
        {pay && (
          <>
            <Text style={s.soft}>Card tapped at</Text>
            <Text style={s.merchant}>{pay.merchantName}</Text>
            <View style={s.balanceRow}><Text style={s.sheetAmount}>{fmt(pay.amount)}</Text><Text style={s.unit}>tUSDC</Text></View>
            <Text style={[s.soft, { marginBottom: 18 }]}>Only confirm if you just tapped your card here.</Text>
            <Button big title={payBusy || "Confirm with fingerprint"} disabled={!!payBusy} onPress={approve} />
            {!payBusy && <Button kind="ghost" title="Decline" onPress={decline} />}
          </>
        )}
      </Sheet>

      <Sheet visible={freezeOpen} onClose={() => !busy && setFreezeOpen(false)}>
        <Text style={s.sheetTitle}>Freeze this wallet?</Text>
        <Text style={[s.soft, { marginBottom: 18 }]}>All payments stop right away, even if someone has your card. Unfreezing needs this phone and your card together.</Text>
        <Button big kind="danger" title={busy ? "Waiting for fingerprint…" : "Freeze wallet"} disabled={!!busy} onPress={freeze} />
        <Button kind="ghost" title="Keep it active" onPress={() => setFreezeOpen(false)} />
      </Sheet>

      <Sheet visible={unfreezeOpen} onClose={() => { if (busy !== "unfreeze") { cancelCard(); setBusy(""); setUnfreezeOpen(false); } }}>
        <Text style={s.sheetTitle}>Unfreeze your wallet</Text>
        {busy === "scan" ? (
          <><ScanArt /><Text style={[s.soft, { textAlign: "center", marginBottom: 12 }]}>Hold your bank card to the back of the phone.</Text></>
        ) : (
          <Text style={[s.soft, { marginBottom: 18 }]}>Hold your bank card to the phone, then confirm with your fingerprint.</Text>
        )}
        {!busy && <Button big title="Scan my card" onPress={unfreeze} />}
        {busy === "unfreeze" && <ActivityIndicator color={C.blue} style={{ marginVertical: 12 }} />}
        <Button kind="ghost" title="Not now" onPress={() => { cancelCard(); setBusy(""); setUnfreezeOpen(false); }} />
      </Sheet>
    </View>
  );
}

export default function App() {
  const [wallet, setWallet] = useState(undefined);
  useEffect(() => { AsyncStorage.getItem("wallet").then((w) => setWallet(w || null)); }, []);
  const forget = () =>
    Alert.alert("Remove wallet from this phone?", "This deletes the phone's key. Without it, the funds can't be spent from this phone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => { await AsyncStorage.removeItem("wallet"); try { forgetPhoneKey(); } catch {} setWallet(null); } },
    ]);
  return (
    <View style={s.root}>
      <StatusBar style="dark" />
      {wallet === undefined ? null : wallet ? <Home wallet={wallet} onForget={forget} /> : <Welcome onDone={setWallet} />}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.paper, paddingTop: 36 },
  page: { padding: 20, paddingBottom: 48 },
  center: { flex: 1, padding: 24, justifyContent: "center", alignItems: "center" },
  display: { fontSize: 34, fontWeight: "800", color: C.ink, letterSpacing: -0.6, lineHeight: 38, marginTop: 6, marginBottom: 12 },
  h2: { fontSize: 24, fontWeight: "800", color: C.ink, textAlign: "center", marginTop: 26, marginBottom: 8 },
  lede: { fontSize: 17, color: C.soft, lineHeight: 24, marginBottom: 18, textAlign: "left" },
  fine: { fontSize: 13, color: C.soft, marginTop: 10, lineHeight: 18 },
  err: { color: C.red, marginTop: 14, fontSize: 15, fontWeight: "500" },
  bold: { fontWeight: "700", color: C.ink, fontSize: 15 },
  soft: { color: C.soft, fontSize: 15, lineHeight: 21 },
  small: { color: C.soft, fontSize: 13 },
  heroArt: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 8, marginBottom: 14 },
  miniCardStatic: { width: 132, height: 84, borderRadius: 12, backgroundColor: C.ink, padding: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  plus: { fontSize: 26, fontWeight: "700", color: C.soft },
  phoneOutline: { width: 56, height: 96, borderRadius: 12, borderWidth: 3, borderColor: C.ink, backgroundColor: C.surface, alignItems: "center", justifyContent: "center" },
  print: { width: 24, height: 28, borderRadius: 12, borderWidth: 2.5, borderColor: C.blue },
  fact: { borderTopWidth: 1, borderColor: C.line, paddingVertical: 12 },
  factText: { color: C.soft, fontSize: 15, lineHeight: 21 },
  chip: { width: 38, height: 28, borderRadius: 6, backgroundColor: C.gold, alignItems: "center", justifyContent: "center" },
  chipInner: { width: 20, height: 14, borderRadius: 3, borderWidth: 1.5, borderColor: "rgba(80,58,15,.45)" },
  btn: { borderRadius: 14, paddingVertical: 15, paddingHorizontal: 18, alignItems: "center", marginTop: 8 },
  btnPrimary: { backgroundColor: C.blue },
  btnDanger: { backgroundColor: C.red },
  btnGhost: { backgroundColor: "transparent" },
  btnOutline: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: "#E6B8B2" },
  btnText: { fontSize: 17, fontWeight: "600" },
  btnTextLight: { color: "#fff" },
  btnTextSoft: { color: C.soft },
  btnTextRed: { color: C.red },
  scanArt: { height: 150, width: 160, alignItems: "center", justifyContent: "flex-end", marginBottom: 6 },
  miniCard: { position: "absolute", top: 0, width: 120, height: 76, borderRadius: 12, backgroundColor: C.ink, padding: 12, justifyContent: "center" },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  brand: { fontSize: 20, fontWeight: "800", color: C.ink },
  tag: { fontSize: 13, fontWeight: "600", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, backgroundColor: "#D9EFE4", color: C.green, overflow: "hidden" },
  tagFrozen: { backgroundColor: C.ice, color: "#1C4F7A" },
  card: { aspectRatio: 1.586, borderRadius: 18, padding: 20, backgroundColor: C.ink, justifyContent: "space-between", overflow: "hidden", elevation: 8 },
  cardRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardLabel: { color: "rgba(255,255,255,.65)", fontSize: 13 },
  cardAddr: { color: "#fff", fontSize: 21, fontWeight: "700", letterSpacing: 1.2, marginTop: 4 },
  frost: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(214,232,247,.9)", alignItems: "center", justifyContent: "center" },
  frostText: { fontSize: 26, fontWeight: "800", color: "#1C4F7A" },
  balanceRow: { flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 22, marginBottom: 6 },
  amount: { fontSize: 46, fontWeight: "800", color: C.ink, letterSpacing: -1.2 },
  unit: { color: C.soft, fontWeight: "600", fontSize: 16 },
  meter: { height: 8, borderRadius: 99, backgroundColor: C.line, overflow: "hidden", marginTop: 6 },
  meterFill: { height: 8, backgroundColor: C.blue, borderRadius: 99 },
  meterText: { fontSize: 13, color: C.soft, marginTop: 8, marginBottom: 24 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: C.ink, marginBottom: 6 },
  activity: { backgroundColor: C.surface, borderRadius: 16 },
  actRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 14 },
  actBorder: { borderTopWidth: 1, borderColor: C.line },
  actAmt: { fontSize: 17, fontWeight: "700", color: C.ink },
  actFail: { fontSize: 14, color: C.red, fontWeight: "500" },
  link: { textAlign: "center", color: C.soft, textDecorationLine: "underline", marginTop: 16, fontSize: 14 },
  scrim: { flex: 1, backgroundColor: "rgba(20,33,61,.45)" },
  sheet: { backgroundColor: C.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, paddingTop: 10, paddingBottom: 30 },
  grabber: { width: 40, height: 5, borderRadius: 9, backgroundColor: C.line, alignSelf: "center", marginBottom: 18 },
  merchant: { fontSize: 22, fontWeight: "700", color: C.ink, marginTop: 2 },
  sheetAmount: { fontSize: 54, fontWeight: "800", color: C.ink, letterSpacing: -1.4 },
  sheetTitle: { fontSize: 26, fontWeight: "800", color: C.ink, marginBottom: 8 },
  toast: { position: "absolute", left: 20, right: 20, bottom: 30, backgroundColor: C.ink, padding: 14, borderRadius: 12 },
  toastText: { color: "#fff", fontWeight: "500", fontSize: 15, textAlign: "center" },
});

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Linking, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, Vibration, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Clipboard from "expo-clipboard";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { withCard, cancelCard } from "./lib/emv";
import { biometricsReady, createPhoneKey, forgetPhoneKey, signWithPhone } from "./lib/phone";

// The relayer runs on the laptop; `adb reverse tcp:8787 tcp:8787` makes it localhost on the phone.
const RELAYER = "http://localhost:8787";

const C = { paper: "#EEF1F5", surface: "#FFFFFF", ink: "#14213D", soft: "#4B5872", line: "#D7DDE6", gold: "#C9A14A", blue: "#2457F5", green: "#178A55", red: "#C0392B", ice: "#BFD8EE", warn: "#FFF3D6", chip: "#E3E8F0" };

async function api(path, body) {
  const res = await fetch(RELAYER + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Server error (${res.status})`);
  return j;
}

// Amounts are shown as plain dollars (the token is a dollar stablecoin).
const usd = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdShort = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const MASK = "••••";

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

/** One line for the activity list: who, what happened, and how to draw the amount. */
function rowMeta(p) {
  if (p.kind === "received") return { title: "Received", sub: p.from ? `From ${p.from}` : "Money in", tone: "in" };
  if (p.status === "paid") return { title: p.merchantName, sub: p.cardOnly ? "Paid with card only" : "Paid", tone: "out" };
  if (p.status === "rejected") return { title: p.merchantName, sub: "You declined", tone: "dead" };
  const e = String(p.error || "");
  const sub = e.includes("OverLimit") ? "Declined: over your limit" : e.includes("IsFrozen") ? "Blocked, wallet was frozen" : "Didn't go through";
  return { title: p.merchantName, sub, tone: "dead", bad: true };
}
const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
function dayLabel(ms) {
  const d = new Date(ms), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, t)) return "TODAY";
  if (same(d, new Date(t.getTime() - 86400000))) return "YESTERDAY";
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" }).toUpperCase();
}

// ------------------------------------------------------------------ small pieces

/** Small icon set (Feather-style strokes). */
function Icon({ name, size = 22, color = C.ink, sw = 2 }) {
  const p = { stroke: color, strokeWidth: sw, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "home" && (<><Path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...p} /><Path d="M9 22V12h6v10" {...p} /></>)}
      {name === "list" && <Path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" {...p} />}
      {name === "card" && (<><Rect x="1.5" y="4" width="21" height="16" rx="3" {...p} /><Path d="M1.5 10h21" {...p} /></>)}
      {name === "eye" && (<><Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" {...p} /><Circle cx="12" cy="12" r="3" {...p} /></>)}
      {name === "eyeOff" && (<><Path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" {...p} /><Path d="M1 1l22 22" {...p} /></>)}
      {name === "copy" && (<><Rect x="9" y="9" width="12" height="12" rx="2" {...p} /><Path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" {...p} /></>)}
      {name === "check" && <Path d="M20 6L9 17l-5-5" {...p} />}
      {name === "phone" && (<><Rect x="6" y="2" width="12" height="20" rx="3" {...p} /><Path d="M12 18h.01" {...p} /></>)}
      {name === "clock" && (<><Circle cx="12" cy="12" r="10" {...p} /><Path d="M12 6v6l4 2" {...p} /></>)}
    </Svg>
  );
}

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
  const st = { primary: [s.btnPrimary, s.btnTextLight], danger: [s.btnDanger, s.btnTextLight], ghost: [s.btnGhost, s.btnTextSoft], outline: [s.btnOutline, s.btnTextRed], soft: [s.btnSoft, s.btnTextInk] }[kind];
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
/** Eye button that hides every amount in the app (balance, spent today, transaction amounts). */
function Eye({ hidden, onPress }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} style={s.eye} accessibilityLabel={hidden ? "Show amounts" : "Hide amounts"}>
      <Icon name={hidden ? "eyeOff" : "eye"} size={20} color={C.soft} />
    </Pressable>
  );
}
function Stepper({ value, onChange, step = 1, min = 1, max = 100000 }) {
  return (
    <View style={s.stepper}>
      <Pressable style={s.stepBtn} onPress={() => onChange(Math.max(min, value - step))}><Text style={s.stepTxt}>−</Text></Pressable>
      <Text style={s.stepVal}>{usdShort(value)}</Text>
      <Pressable style={s.stepBtn} onPress={() => onChange(Math.min(max, value + step))}><Text style={s.stepTxt}>+</Text></Pressable>
    </View>
  );
}
function Steps({ at }) {
  return <View style={s.steps}>{[1, 2, 3].map((n) => <View key={n} style={[s.stepBar, n <= at && { backgroundColor: C.blue }]} />)}</View>;
}
function Back({ title, onPress }) {
  return <Pressable onPress={onPress} hitSlop={10}><Text style={s.back}>‹ {title}</Text></Pressable>;
}
function CardTile({ name, label, frozen, alt }) {
  return (
    <View style={[s.tile, alt && { backgroundColor: "#2B3A67" }]}>
      <Chip />
      <View style={{ flex: 1 }}><Text style={s.tileName}>{name}</Text><Text style={s.cardLabel}>{frozen ? "Frozen" : label}</Text></View>
      {frozen && <View style={s.frostSm}><Text style={s.frostSmText}>🔒</Text></View>}
    </View>
  );
}
function ActivityRow({ p, hidden, onOpen }) {
  const m = rowMeta(p);
  const amount = hidden ? MASK : (m.tone === "in" ? "+" : m.tone === "out" ? "−" : "") + usd(p.amount);
  return (
    <Pressable style={({ pressed }) => [s.actRow, pressed && { backgroundColor: "#F5F7FA" }]} onPress={() => onOpen && onOpen(p)}>
      <View style={{ flex: 1, paddingRight: 8 }}>
        <Text style={s.bold}>{m.title}</Text>
        <Text style={[s.small, m.bad && { color: C.red }, m.tone === "out" && { color: C.green }]}>{m.sub}{p.time ? ` · ${clock(p.time)}` : ""}</Text>
      </View>
      <Text style={[s.actAmt, m.tone === "in" && { color: C.green }, m.tone === "dead" && !hidden && s.actDead]}>{amount}</Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------ welcome (unchanged flow)

function Welcome({ onDone }) {
  const [step, setStep] = useState("intro"); // intro | scanning | creating
  const [err, setErr] = useState("");

  async function start() {
    setErr("");
    if (!biometricsReady()) return setErr("Set up a fingerprint on this phone first (Settings → Biometrics).");
    setStep("scanning");
    try {
      // The phone key comes first: the card and the phone both sign a hash that covers both keys.
      const phone = createPhoneKey();
      let st;
      const card = await withCard(async (key) => {
        st = await api("/api/signup/start", { ...phone, cardModulus: key.modulus, cardExponent: key.exponent });
        return st.existing ? null : st.challenge;
      });
      if (st.existing) { await AsyncStorage.setItem("wallet", st.wallet); return onDone(st.wallet); }
      setStep("creating");
      const phoneSig = await signWithPhone(st.hash, "Create your Tap2ETH wallet", "Confirm with your fingerprint");
      const r = await api("/api/signup/" + st.id, { cardSig: card.signature, phoneSig });
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
        <Text style={s.lede}>{step === "scanning" ? "Keep it still for a couple of seconds. We don't store your card number. The card is only used for signing your payments." : "Confirm with your fingerprint when asked."}</Text>
        {step === "scanning" && <Button kind="ghost" title="Cancel" onPress={() => { cancelCard(); setStep("intro"); }} />}
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={[s.display, { marginTop: 40 }]}>Pay with the bank card you already have</Text>
      <Text style={s.lede}>Here's how it works:</Text>
      {[["1", "The shop enters the amount"], ["2", "You tap your card"], ["3", "This phone shows the amount. You approve it here. Your card and phone both complete the multi-sign, and the shop is paid."]].map(([n, t]) => (
        <View key={n} style={s.howRow}>
          <View style={s.howNum}><Text style={s.howNumTxt}>{n}</Text></View>
          <Text style={s.howTxt}>{t}</Text>
        </View>
      ))}
      <Text style={s.caption}>Your balance is crypto tokens that you own.</Text>
      <Button title="Create wallet" onPress={start} />
      {!!err && <Text style={s.err}>{err}</Text>}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ tabs

function HomeTab({ w, wallet, hidden, toggleHidden, goActivity, onCopy, onOpen, refreshControl }) {
  const frozen = !!w?.frozen;
  const pct = w ? Math.min(100, (100 * Number(w.spentToday)) / Number(w.dailyLimit || 1)) : 0;
  const recent = (w?.history || []).slice(0, 5);
  const addr = wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "";
  return (
    <ScrollView contentContainerStyle={s.page} refreshControl={refreshControl}>
      <View style={s.card}>
        <View style={s.cardRow}><Chip /><View style={{ alignItems: "flex-end", gap: 6 }}><Waves /><Text style={[s.pillText, frozen && { color: "#1C4F7A" }]}>{frozen ? "FROZEN" : "ACTIVE"}</Text></View></View>
        <View>
          <Text style={s.cardLabel}>Wallet address</Text>
          <View style={s.addrRow}>
            <Text style={s.cardName}>{addr}</Text>
            <Pressable onPress={onCopy} hitSlop={8} style={s.copyBtn} accessibilityLabel="Copy wallet address">
              <Icon name="copy" size={16} color="#fff" /><Text style={s.copyTxt}>Copy</Text>
            </Pressable>
          </View>
        </View>
        {frozen && <View style={s.frost}><Text style={s.frostText}>🔒 Frozen</Text></View>}
      </View>

      <Text style={[s.small, { marginTop: 22 }]}>Wallet balance</Text>
      <View style={s.balanceLine}>
        <Text style={s.amount}>{w ? (hidden ? "••••••" : usd(w.balance)) : "–"}</Text>
        <Eye hidden={hidden} onPress={toggleHidden} />
      </View>
      {w && (
        <>
          <Text style={s.meterText}>{hidden ? "Spent today ••••" : `${usd(w.spentToday)} of ${usd(w.dailyLimit)} spent today`}</Text>
          <View style={s.meter}><View style={[s.meterFill, { width: `${pct}%` }]} /></View>
        </>
      )}

      <View style={s.sectionHead}>
        <Text style={s.sectionTitle}>Recent activity</Text>
        <Pressable onPress={goActivity} hitSlop={10}><Text style={s.link2}>See all ›</Text></Pressable>
      </View>
      <View style={s.activity}>
        {!recent.length ? <Text style={[s.soft, { padding: 16 }]}>Tap your card at a terminal to make your first payment.</Text> : recent.map((p, i) => (
          <View key={p.id} style={i > 0 && s.actBorder}><ActivityRow p={p} hidden={hidden} onOpen={onOpen} /></View>
        ))}
      </View>

    </ScrollView>
  );
}

function ActivityTab({ w, hidden, toggleHidden, onOpen, refreshControl }) {
  const items = w?.history || [];
  const timed = items.length > 0 && items.every((p) => p.time);
  const groups = [];
  if (timed) {
    for (const p of items) {
      const label = dayLabel(p.time);
      const g = groups[groups.length - 1];
      if (g && g.label === label) g.items.push(p); else groups.push({ label, items: [p] });
    }
  } else if (items.length) groups.push({ label: "RECENT", items });
  return (
    <ScrollView contentContainerStyle={s.page} refreshControl={refreshControl}>
      <View style={s.titleLine}><Text style={s.pageTitle}>Activity</Text><Eye hidden={hidden} onPress={toggleHidden} /></View>
      {!items.length && <Text style={[s.soft, { marginTop: 12 }]}>No payments yet. Every payment, declined request and blocked attempt will show up here.</Text>}
      {groups.map((g) => (
        <View key={g.label}>
          <Text style={s.day}>{g.label}</Text>
          <View style={s.activity}>
            {g.items.map((p, i) => <View key={p.id} style={i > 0 && s.actBorder}><ActivityRow p={p} hidden={hidden} onOpen={onOpen} /></View>)}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function CardsTab({ w, openSub, setFreezeOpen, setUnfreezeOpen, onForget }) {
  const frozen = !!w?.frozen;
  const cards = w?.cards?.length ? w.cards : [{ id: 0, name: "Your bank card" }];
  const soft = w && Number(w.softLimit) > 0 ? `Up to ${usdShort(w.softLimit)}` : "Off";
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.pageTitle}>Cards</Text>
      <View style={{ gap: 10, marginTop: 10 }}>
        {cards.map((c, i) => <CardTile key={c.id} name={c.name} label={c.addedAt ? "Active" : "Linked bank card"} frozen={frozen} alt={i % 2 === 1} />)}
      </View>
      {w?.v2 && <Button kind="soft" title="+ Add a card" onPress={() => openSub("add")} />}

      <Text style={s.sec}>CONTROLS</Text>
      <View style={s.activity}>
        {w?.v2 ? (
          <>
            <Pressable style={s.ctlRow} onPress={() => openSub("limits")}><Text style={s.bold}>Spending limits</Text><Text style={s.ctlVal}>{usdShort(w.perTxLimit)} each · {usdShort(w.dailyLimit)} a day  ›</Text></Pressable>
            <Pressable style={[s.ctlRow, s.actBorder]} onPress={() => openSub("small")}><Text style={s.bold}>Tap to pay, card only</Text><Text style={s.ctlVal}>{soft}  ›</Text></Pressable>
          </>
        ) : (
          <View style={s.ctlRow}><Text style={s.bold}>Spending limits</Text><Text style={s.ctlVal}>{w ? `${usdShort(w.perTxLimit)} each · ${usdShort(w.dailyLimit)} a day` : ""}</Text></View>
        )}
      </View>

      {frozen ? (
        <>
          <Button title="Unfreeze with your card" onPress={() => setUnfreezeOpen(true)} />
          <Text style={s.fine}>Payments are blocked. Unfreezing needs your card and your fingerprint.</Text>
        </>
      ) : (
        <View style={{ marginTop: 14 }}><Button kind="outline" title="Freeze wallet" onPress={() => setFreezeOpen(true)} /></View>
      )}
      <Pressable onPress={onForget}><Text style={s.link}>Remove wallet from this phone</Text></Pressable>
    </ScrollView>
  );
}

// ------------------------------------------------------------------ settings screens (reached from Cards)

function LimitsScreen({ w, onBack, secure }) {
  const [perTx, setPerTx] = useState(Number(w.perTxLimit));
  const [daily, setDaily] = useState(Number(w.dailyLimit));
  const [busy, setBusy] = useState("");
  const bad = perTx > daily;
  async function save() {
    try { await secure("limits", { perTx, daily }, "Change spending limits", `${usdShort(perTx)} each, ${usdShort(daily)} a day`, setBusy, "Limits saved"); onBack(); } catch {}
    setBusy("");
  }
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Back title="Cards" onPress={() => !busy && onBack()} />
      <Text style={s.pageTitle}>Spending limits</Text>
      <Text style={s.soft}>Stop big payments, even if someone has your card and phone.</Text>
      <View style={[s.activity, { marginTop: 14 }]}>
        <View style={s.ctlRow}><Text style={s.bold}>Each payment</Text><Stepper value={perTx} onChange={setPerTx} step={5} /></View>
        <View style={[s.ctlRow, s.actBorder]}><Text style={s.bold}>Each day</Text><Stepper value={daily} onChange={setDaily} step={10} /></View>
      </View>
      <Text style={s.small}>{usd(w.spentToday)} spent today</Text>
      {bad && <Text style={s.err}>A single payment can't be more than the daily limit.</Text>}
      <View style={s.warn}><Text style={s.warnText}>Changing limits needs <Text style={s.bold}>both</Text> your card and your fingerprint.</Text></View>
      <SecureStatus busy={busy} />
      <Button title="Save limits" disabled={!!busy || bad} onPress={save} />
    </ScrollView>
  );
}

function SmallScreen({ w, onBack, secure }) {
  const [on, setOn] = useState(Number(w.softLimit) > 0);
  const [amt, setAmt] = useState(Number(w.softLimit) > 0 ? Number(w.softLimit) : 10);
  const [busy, setBusy] = useState("");
  const max = Number(w.perTxLimit);
  async function save() {
    try { await secure("soft", { amount: on ? amt : 0, cardOnly: true }, "Tap to pay, card only", on ? `Up to ${usdShort(amt)}` : "Turn off", setBusy, "Saved"); onBack(); } catch {}
    setBusy("");
  }
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Back title="Cards" onPress={() => !busy && onBack()} />
      <Text style={s.pageTitle}>Tap to pay, card only</Text>
      <Text style={s.soft}>Tap your card and you're done. No phone approval for small payments.</Text>
      <View style={[s.activity, { marginTop: 14 }]}>
        <View style={s.ctlRow}><Text style={s.bold}>Turn on</Text><Switch value={on} onValueChange={setOn} trackColor={{ true: C.green }} /></View>
      </View>
      {on && (
        <>
          <Text style={[s.small, { marginTop: 14 }]}>Up to</Text>
          <View style={{ alignSelf: "flex-start", marginVertical: 8 }}><Stepper value={amt} onChange={setAmt} step={1} max={max} /></View>
          <View style={s.warn}><Text style={s.warnText}><Text style={s.bold}>Less secure.</Text> Anyone with your card can pay up to {usdShort(amt)} at a time, within your daily limit. Keep this amount small.</Text></View>
        </>
      )}
      <Text style={s.note}>Turning this on or off needs your card and your fingerprint.</Text>
      <SecureStatus busy={busy} />
      <Button title="Save" disabled={!!busy} onPress={save} />
    </ScrollView>
  );
}

function AddCardScreen({ wallet, onBack, refresh, say }) {
  const [name, setName] = useState("");
  const [stage, setStage] = useState("intro"); // intro | tap1 | tap2 | sign
  async function start() {
    try {
      let st;
      setStage("tap1");
      const fresh = await withCard(async (key) => {
        st = await api("/api/action/start", { wallet, action: "addCard", params: { name: name.trim() || "New card", cardModulus: key.modulus, cardExponent: key.exponent } });
        return st.challenge;
      });
      setStage("tap2");
      const existing = await withCard(async () => st.challenge);
      setStage("sign");
      const phoneSig = await signWithPhone(st.hash, "Add a card", name.trim() || "New card");
      await api("/api/action/" + st.id, { cardModulus: existing.modulus, cardSig: existing.signature, newCardSig: fresh.signature, phoneSig });
      await refresh();
      say("Card added");
      onBack();
    } catch (e) {
      say(explain(e), true);
      setStage("intro");
    }
  }
  if (stage === "intro") {
    return (
      <ScrollView contentContainerStyle={s.page}>
        <Back title="Cards" onPress={onBack} />
        <Text style={s.pageTitle}>Add a card</Text>
        <Text style={s.soft}>Tap the new card, then one of your current cards, then confirm with your fingerprint.</Text>
        <Text style={[s.small, { marginTop: 18 }]}>Name this card (optional)</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Dad's Visa" placeholderTextColor="#98A2B6" style={s.input} maxLength={24} />
        <Button title="Start" onPress={start} />
      </ScrollView>
    );
  }
  const at = stage === "tap1" ? 1 : stage === "tap2" ? 2 : 3;
  return (
    <View style={s.center}>
      <View style={{ alignSelf: "stretch" }}><Steps at={at} /></View>
      {stage === "sign" ? <ActivityIndicator size="large" color={C.blue} /> : <ScanArt />}
      <Text style={s.h2}>{stage === "tap1" ? "Tap the new card" : stage === "tap2" ? "Now tap one of your current cards" : "Confirm it's you"}</Text>
      <Text style={s.lede}>{stage === "tap1" ? "Hold the card you want to add to the back of the phone. We don't store the card number." : stage === "tap2" ? "One of your existing cards must agree to the new one." : "Use your fingerprint when asked."}</Text>
      {stage !== "sign" && <Button kind="ghost" title="Cancel" onPress={() => { cancelCard(); setStage("intro"); }} />}
    </View>
  );
}

function SecureStatus({ busy }) {
  if (!busy) return null;
  return (
    <View style={{ alignItems: "center", marginVertical: 10 }}>
      {busy === "scan" ? <ScanArt /> : <ActivityIndicator color={C.blue} />}
      <Text style={s.soft}>{busy === "scan" ? "Hold your bank card to the back of the phone." : "Confirm with your fingerprint."}</Text>
    </View>
  );
}

// ------------------------------------------------------------------ payment sheets

function useCountdown(expirySec) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const secs = Math.max(0, Math.ceil((expirySec * 1000 - now) / 1000));
  return { secs, label: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` };
}

/** The approval sheet: what you are paying, who has already agreed, and how long it stays open. */
function PaySheetBody({ pay, payBusy, approve, decline }) {
  const { secs, label } = useCountdown(Number(pay.expiry) || 0);
  const sending = !!payBusy && payBusy !== "Waiting for fingerprint…";
  return (
    <>
      <Text style={s.soft}>Card tapped at</Text>
      <Text style={s.merchant}>{pay.merchantName}</Text>
      <View style={s.balanceRow}><Text style={s.sheetAmount}>{usd(pay.amount)}</Text></View>

      <View style={s.agree}>
        <View style={s.agreeRow}>
          <View style={[s.agreeDot, { backgroundColor: "#D9EFE4" }]}><Icon name="check" size={16} color={C.green} sw={2.6} /></View>
          <Text style={s.bold}>Your card</Text><Text style={s.agreeState}>tapped</Text>
        </View>
        <View style={[s.agreeRow, { marginTop: 10 }]}>
          <View style={[s.agreeDot, { backgroundColor: sending ? "#D9EFE4" : "#FFF1D2" }]}><Icon name={sending ? "check" : "phone"} size={16} color={sending ? C.green : "#B7791F"} sw={2.4} /></View>
          <Text style={s.bold}>You</Text><Text style={s.agreeState}>{sending ? "approved" : "approve now"}</Text>
        </View>
      </View>

      {Number(pay.expiry) > 0 && (
        <View style={s.metaRow}>
          <Icon name="clock" size={14} color={secs < 30 ? C.red : C.soft} />
          <Text style={[s.small, secs < 30 && { color: C.red }]}>{secs > 0 ? `Expires in ${label}` : "Expired"}</Text>
        </View>
      )}
      <Text style={[s.soft, { marginBottom: 14, marginTop: 4 }]}>Only confirm if you just tapped your card here.</Text>
      <Button big title={payBusy || "Confirm with fingerprint"} disabled={!!payBusy} onPress={approve} />
      {!payBusy && <Button kind="ghost" title="Decline" onPress={decline} />}
    </>
  );
}

/** Details of one activity row: what happened, when, how it was approved. */
function DetailBody({ p, hidden, onClose }) {
  const m = rowMeta(p);
  const amount = hidden ? MASK : (m.tone === "in" ? "+" : m.tone === "out" ? "−" : "") + usd(p.amount);
  const approved = p.kind === "received" ? "" : p.status !== "paid" ? "" : p.cardOnly ? "Your card (small payment)" : "Your card and your fingerprint";
  const when = p.time ? new Date(p.time).toLocaleString("en-US", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
  const line = (k, v) => !!v && (<View style={s.detailRow}><Text style={s.small}>{k}</Text><Text style={[s.bold, { maxWidth: "62%", textAlign: "right" }]}>{v}</Text></View>);
  return (
    <>
      <Text style={s.soft}>{m.title}</Text>
      <Text style={[s.sheetAmount, m.tone === "dead" && !hidden && { color: "#8793A8" }]}>{amount}</Text>
      <Text style={[s.soft, m.bad && { color: C.red }, m.tone === "out" && { color: C.green }, { marginBottom: 10 }]}>{m.sub}</Text>
      <View style={s.activity}>
        {line("When", when)}
        {line("Approved with", approved)}
        {p.kind === "received" && line("From", p.from)}
      </View>
      {!!p.txHash && (
        <Button kind="soft" title="View receipt" onPress={() => Linking.openURL(`https://explorer.testnet.whitechain.io/tx/${p.txHash}`)} />
      )}
      <Button kind="ghost" title="Close" onPress={onClose} />
    </>
  );
}

// ------------------------------------------------------------------ main (tabs + shared payment/freeze flows)

function TabBar({ tab, setTab }) {
  const tabs = [["home", "Home", "home"], ["activity", "Activity", "list"], ["cards", "Cards", "card"]];
  return (
    <View style={s.tabbar}>
      {tabs.map(([id, label, icon]) => (
        <Pressable key={id} style={s.tab} onPress={() => setTab(id)} accessibilityLabel={label}>
          <Icon name={icon} size={24} color={tab === id ? C.blue : "#8793A8"} />
          <Text style={[s.tabLabel, tab === id && { color: C.blue }]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Main({ wallet, onForget }) {
  const [w, setW] = useState(null);
  const [tab, setTab] = useState("home");
  const [sub, setSub] = useState(null); // null | "limits" | "small" | "add"
  const [hidden, setHidden] = useState(false);
  const [pay, setPay] = useState(null);
  const [payBusy, setPayBusy] = useState("");
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [unfreezeOpen, setUnfreezeOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState(null);
  const [paid, setPaid] = useState(null); // { amount, merchantName } after a successful approval
  const [detail, setDetail] = useState(null); // an activity item opened for details
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const seen = useRef(new Set());

  const say = (text, bad) => { setToast({ text, bad }); setTimeout(() => setToast(null), 4000); };
  const copyAddress = async () => { await Clipboard.setStringAsync(wallet); Vibration.vibrate(30); say("Wallet address copied"); };
  const onRefresh = async () => {
    setRefreshing(true);
    try { await refresh(); setOffline(false); } catch { setOffline(true); }
    setRefreshing(false);
  };
  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.blue} />;

  useEffect(() => { AsyncStorage.getItem("hideAmounts").then((v) => setHidden(v === "1")); }, []);
  const toggleHidden = () => setHidden((h) => { AsyncStorage.setItem("hideAmounts", h ? "0" : "1"); return !h; });

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
    refresh().catch((e) => { setOffline(true); say(explain(e), true); });
    const t = setInterval(() => refresh().then(() => setOffline(false)).catch(() => setOffline(true)), 1500);
    return () => clearInterval(t);
  }, [refresh]);

  async function approve() {
    setPayBusy("Waiting for fingerprint…");
    try {
      const phoneSig = await signWithPhone(pay.hash, `Pay ${usd(pay.amount)}`, `to ${pay.merchantName}`);
      setPayBusy("Sending payment…");
      const r = await api(`/api/pay/${pay.id}/phone`, { phoneSig });
      if (r.status !== "paid") throw new Error(r.error || "Payment failed");
      Vibration.vibrate([0, 40, 60, 40]);
      setPaid({ amount: r.amount, merchantName: r.merchantName });
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
      await api("/api/unfreeze/" + req.id, { cardModulus: card.modulus, cardSig: card.signature, phoneSig });
      setUnfreezeOpen(false);
      say("Wallet active again.");
    } catch (e) { say(explain(e), true); }
    setBusy("");
    refresh().catch(() => {});
  }

  /** A wallet change that needs the card and the fingerprint: tap, sign, send. `onStage` shows progress. */
  async function secure(action, params, title, subtitle, onStage, doneText) {
    try {
      onStage("scan");
      let st;
      const card = await withCard(async () => {
        st = await api("/api/action/start", { wallet, action, params });
        return st.challenge;
      });
      onStage("sign");
      const phoneSig = await signWithPhone(st.hash, title, subtitle);
      await api("/api/action/" + st.id, { cardModulus: card.modulus, cardSig: card.signature, phoneSig });
      await refresh();
      if (doneText) say(doneText);
    } catch (e) {
      say(explain(e), true);
      throw e;
    }
  }

  const goSub = (x) => setSub(x);
  const back = () => setSub(null);
  const frozen = !!w?.frozen;

  return (
    <View style={{ flex: 1 }}>
      {offline && <View style={s.offline}><Text style={s.offlineTxt}>Can't reach the server. Retrying…</Text></View>}
      {sub === "limits" && w ? <LimitsScreen w={w} onBack={back} secure={secure} />
        : sub === "small" && w ? <SmallScreen w={w} onBack={back} secure={secure} />
        : sub === "add" ? <AddCardScreen wallet={wallet} onBack={back} refresh={refresh} say={say} />
        : tab === "home" ? <HomeTab w={w} wallet={wallet} hidden={hidden} toggleHidden={toggleHidden} goActivity={() => setTab("activity")} onCopy={copyAddress} onOpen={setDetail} refreshControl={refreshControl} />
        : tab === "activity" ? <ActivityTab w={w} hidden={hidden} toggleHidden={toggleHidden} onOpen={setDetail} refreshControl={refreshControl} />
        : <CardsTab w={w} openSub={goSub} setFreezeOpen={setFreezeOpen} setUnfreezeOpen={setUnfreezeOpen} onForget={onForget} />}

      {!sub && <TabBar tab={tab} setTab={setTab} />}
      {toast && <View style={[s.toast, toast.bad && { backgroundColor: C.red }]}><Text style={s.toastText}>{toast.text}</Text></View>}

      {/* Closing the sheet (back button, tapping outside, or the fingerprint dialog taking focus)
          must never decline the payment: only the Decline button does. Amounts here are never hidden. */}
      <Sheet visible={!!pay} onClose={() => {}}>
        {pay && <PaySheetBody pay={pay} payBusy={payBusy} approve={approve} decline={decline} />}
      </Sheet>

      <Sheet visible={!!paid} onClose={() => setPaid(null)}>
        {paid && (
          <View style={{ alignItems: "center", paddingTop: 6 }}>
            <View style={s.bigCheck}><Icon name="check" size={44} color={C.green} sw={2.6} /></View>
            <Text style={s.paidTitle}>Paid</Text>
            <Text style={s.sheetAmount}>{usd(paid.amount)}</Text>
            <Text style={[s.soft, { marginTop: 2, marginBottom: 18 }]}>to {paid.merchantName}</Text>
            <View style={{ alignSelf: "stretch" }}><Button big title="Done" onPress={() => setPaid(null)} /></View>
          </View>
        )}
      </Sheet>

      <Sheet visible={!!detail} onClose={() => setDetail(null)}>
        {detail && <DetailBody p={detail} hidden={hidden} onClose={() => setDetail(null)} />}
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
      {wallet === undefined ? null : wallet ? <Main wallet={wallet} onForget={forget} /> : <Welcome onDone={setWallet} />}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.paper, paddingTop: 36 },
  page: { padding: 20, paddingBottom: 48 },
  center: { flex: 1, padding: 24, justifyContent: "center", alignItems: "center" },
  display: { fontSize: 34, fontWeight: "800", color: C.ink, letterSpacing: -0.6, lineHeight: 38, marginTop: 6, marginBottom: 12 },
  h2: { fontSize: 24, fontWeight: "800", color: C.ink, textAlign: "center", marginTop: 26, marginBottom: 8 },
  pageTitle: { fontSize: 30, fontWeight: "800", color: C.ink, letterSpacing: -0.6, marginBottom: 6 },
  titleLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  lede: { fontSize: 17, color: C.soft, lineHeight: 24, marginBottom: 18, textAlign: "left" },
  fine: { fontSize: 13, color: C.soft, marginTop: 10, lineHeight: 18 },
  note: { fontSize: 12, color: C.soft, textAlign: "center", marginTop: 10, marginBottom: 4 },
  err: { color: C.red, marginTop: 14, fontSize: 15, fontWeight: "500" },
  bold: { fontWeight: "700", color: C.ink, fontSize: 15 },
  soft: { color: C.soft, fontSize: 15, lineHeight: 21 },
  small: { color: C.soft, fontSize: 13 },
  phoneOutline: { width: 56, height: 96, borderRadius: 12, borderWidth: 3, borderColor: C.ink, backgroundColor: C.surface, alignItems: "center", justifyContent: "center" },
  chip: { width: 38, height: 28, borderRadius: 6, backgroundColor: C.gold, alignItems: "center", justifyContent: "center" },
  chipInner: { width: 20, height: 14, borderRadius: 3, borderWidth: 1.5, borderColor: "rgba(80,58,15,.45)" },
  btn: { borderRadius: 14, paddingVertical: 15, paddingHorizontal: 18, alignItems: "center", marginTop: 8 },
  btnPrimary: { backgroundColor: C.blue },
  btnDanger: { backgroundColor: C.red },
  btnGhost: { backgroundColor: "transparent" },
  btnSoft: { backgroundColor: C.chip },
  btnOutline: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: "#E6B8B2" },
  btnText: { fontSize: 17, fontWeight: "600" },
  btnTextLight: { color: "#fff" },
  btnTextSoft: { color: C.soft },
  btnTextInk: { color: C.ink },
  btnTextRed: { color: C.red },
  scanArt: { height: 150, width: 160, alignItems: "center", justifyContent: "flex-end", marginBottom: 6 },
  miniCard: { position: "absolute", top: 0, width: 120, height: 76, borderRadius: 12, backgroundColor: C.ink, padding: 12, justifyContent: "center" },
  // home card
  card: { aspectRatio: 1.586, borderRadius: 18, padding: 20, backgroundColor: C.ink, justifyContent: "space-between", overflow: "hidden", elevation: 8 },
  cardRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardLabel: { color: "rgba(255,255,255,.65)", fontSize: 13 },
  cardName: { color: "#fff", fontSize: 22, fontWeight: "700", marginTop: 4 },
  pillText: { color: "#fff", fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  frost: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(214,232,247,.93)", alignItems: "center", justifyContent: "center" },
  frostText: { fontSize: 26, fontWeight: "800", color: "#1C4F7A" },
  tile: { height: 82, borderRadius: 16, backgroundColor: C.ink, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 14, overflow: "hidden" },
  tileName: { color: "#fff", fontSize: 17, fontWeight: "700" },
  frostSm: { position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center" },
  frostSmText: { fontSize: 20 },
  // balance
  balanceLine: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4, marginBottom: 4 },
  balanceRow: { flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 22, marginBottom: 6 },
  amount: { fontSize: 44, fontWeight: "800", color: C.ink, letterSpacing: -1.2 },
  meter: { height: 8, borderRadius: 99, backgroundColor: C.line, overflow: "hidden", marginTop: 6 },
  meterFill: { height: 8, backgroundColor: C.blue, borderRadius: 99 },
  meterText: { fontSize: 13, color: C.soft, marginTop: 2 },
  eye: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.chip, alignItems: "center", justifyContent: "center" },
  // lists
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: 26, marginBottom: 6 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: C.ink },
  link2: { fontSize: 14, fontWeight: "600", color: C.blue },
  day: { fontSize: 12, fontWeight: "700", color: C.soft, letterSpacing: 0.5, marginTop: 18, marginBottom: 6 },
  sec: { fontSize: 13, fontWeight: "700", color: C.soft, letterSpacing: 0.5, marginTop: 24, marginBottom: 6 },
  activity: { backgroundColor: C.surface, borderRadius: 16 },
  actRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 14 },
  actBorder: { borderTopWidth: 1, borderColor: C.line },
  actAmt: { fontSize: 16, fontWeight: "700", color: C.ink },
  actDead: { color: "#8793A8", textDecorationLine: "line-through" },
  ctlRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 14 },
  ctlVal: { fontSize: 14, color: C.soft },
  link: { textAlign: "center", color: C.soft, textDecorationLine: "underline", marginTop: 16, fontSize: 14 },
  // tab bar
  tabbar: { flexDirection: "row", backgroundColor: "#fff", borderTopWidth: 1, borderColor: C.line, paddingTop: 8, paddingBottom: 14 },
  tab: { flex: 1, alignItems: "center" },
  tabLabel: { fontSize: 11, fontWeight: "600", color: "#8793A8", marginTop: 2 },
  // settings screens
  back: { color: C.blue, fontSize: 15, fontWeight: "600", marginBottom: 8 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: { width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, borderColor: C.line, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  stepTxt: { fontSize: 20, color: C.ink },
  stepVal: { minWidth: 56, textAlign: "center", fontWeight: "700", fontSize: 17, color: C.ink },
  steps: { flexDirection: "row", gap: 6, marginBottom: 12 },
  stepBar: { flex: 1, height: 4, borderRadius: 9, backgroundColor: C.line },
  warn: { backgroundColor: C.warn, borderRadius: 12, padding: 12, marginTop: 12, marginBottom: 6 },
  warnText: { fontSize: 13, lineHeight: 19, color: "#6B4E00" },
  input: { height: 52, borderRadius: 12, borderWidth: 1.5, borderColor: C.line, backgroundColor: "#fff", paddingHorizontal: 14, fontSize: 17, color: C.ink, marginTop: 6, marginBottom: 6 },
  // wallet address on the card
  addrRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  copyBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(255,255,255,.18)", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 99 },
  copyTxt: { color: "#fff", fontSize: 13, fontWeight: "600" },
  // welcome steps
  howRow: { flexDirection: "row", alignItems: "flex-start", gap: 14, marginBottom: 16 },
  howNum: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#FFF1D2", alignItems: "center", justifyContent: "center", marginTop: 1 },
  howNumTxt: { fontWeight: "800", color: C.ink, fontSize: 15 },
  howTxt: { flex: 1, fontSize: 16, lineHeight: 23, color: C.ink },
  caption: { fontSize: 13, color: C.soft, textAlign: "center", marginTop: 6, marginBottom: 8 },
  // approval sheet, success, details
  agree: { backgroundColor: C.paper, borderRadius: 14, padding: 14, marginBottom: 12 },
  agreeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  agreeDot: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  agreeState: { marginLeft: "auto", color: C.soft, fontSize: 13, fontWeight: "600" },
  metaRow: { flexDirection: "row", justifyContent: "flex-start", alignItems: "center", gap: 5, marginBottom: 4 },
  bigCheck: { width: 84, height: 84, borderRadius: 42, backgroundColor: "#D9EFE4", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  paidTitle: { fontSize: 22, fontWeight: "800", color: C.ink, marginBottom: 2 },
  detailRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14, borderTopWidth: 1, borderColor: C.line },
  offline: { backgroundColor: C.red, paddingVertical: 6, alignItems: "center" },
  offlineTxt: { color: "#fff", fontSize: 12, fontWeight: "600" },
  // sheets and toast
  scrim: { flex: 1, backgroundColor: "rgba(20,33,61,.45)" },
  sheet: { backgroundColor: C.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, paddingTop: 10, paddingBottom: 30 },
  grabber: { width: 40, height: 5, borderRadius: 9, backgroundColor: C.line, alignSelf: "center", marginBottom: 18 },
  merchant: { fontSize: 22, fontWeight: "700", color: C.ink, marginTop: 2 },
  sheetAmount: { fontSize: 54, fontWeight: "800", color: C.ink, letterSpacing: -1.4 },
  sheetTitle: { fontSize: 26, fontWeight: "800", color: C.ink, marginBottom: 8 },
  toast: { position: "absolute", left: 20, right: 20, bottom: 90, backgroundColor: C.ink, padding: 14, borderRadius: 12 },
  toastText: { color: "#fff", fontWeight: "500", fontSize: 15, textAlign: "center" },
});

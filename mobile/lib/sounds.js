// The app's card-touch cues: the same short 8-bit melodies the Pi terminal plays (see terminal/melodies.py), plus a
// vibration for the ones that need to be felt. Sound can be switched off in the secret settings.
import { Vibration } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";

const FILES = {
  prompt: require("../assets/sounds/prompt.wav"),
  tap: require("../assets/sounds/tap.wav"),
  retry: require("../assets/sounds/retry.wav"),
  card_ok: require("../assets/sounds/card_ok.wav"),
  paid: require("../assets/sounds/paid.wav"),
  declined: require("../assets/sounds/declined.wav"),
  cancel: require("../assets/sounds/cancel.wav"),
  swap_step: require("../assets/sounds/swap_step.wav"),
};
const BUZZ = { tap: 25, card_ok: [0, 40, 50, 40], retry: [0, 60, 40, 90], paid: [0, 40, 60, 40], declined: [0, 90, 60, 90] };

let enabled = true;
let players = null;
AsyncStorage.getItem("sound").then((v) => { enabled = v !== "0"; }).catch(() => {});
export const soundOn = () => enabled;
export function setSoundOn(on) { enabled = !!on; AsyncStorage.setItem("sound", on ? "1" : "0").catch(() => {}); }

function load() {
  if (players) return players;
  try { setAudioModeAsync({ playsInSilentMode: false }).catch(() => {}); } catch {} // follow the phone's silent mode
  players = {};
  for (const [name, src] of Object.entries(FILES)) {
    try { players[name] = createAudioPlayer(src); } catch { /* a missing sound never breaks a payment */ }
  }
  return players;
}

/** Play one cue by name ("tap", "card_ok", "paid"...). Never throws. */
export function cue(name) {
  try {
    if (BUZZ[name] !== undefined) Vibration.vibrate(BUZZ[name]);
    if (!enabled) return;
    const p = load()[name];
    if (!p) return;
    p.seekTo(0);
    p.play();
  } catch { /* ignore */ }
}

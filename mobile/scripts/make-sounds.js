// Writes the app's short 8-bit cues (assets/sounds/*.wav) from the same notes the Pi terminal plays
// (terminal/melodies.py), so a tap sounds the same on the phone as on the terminal. Run: node scripts/make-sounds.js
const fs = require("fs");
const path = require("path");

const REST = 0;
const C4 = 262, G4 = 392;
const C5 = 523, E5 = 659, G5 = 784, A5 = 880;
const C6 = 1047, E6 = 1319, G6 = 1568, A6 = 1760;
const C7 = 2093, E7 = 2637;

// (frequency Hz, milliseconds); 0 = rest.
const MELODIES = {
  prompt: [[E6, 60], [REST, 50], [A6, 120]],
  tap: [[A6, 35], [E7, 55]],
  retry: [[G4, 70], [REST, 40], [C4, 140]],
  card_ok: [[C6, 45], [E6, 45], [G6, 45], [C7, 45], [E7, 140]],
  paid: [[A5, 50], [E6, 220], [REST, 60], [C6, 70], [E6, 70], [G6, 70], [C7, 120], [REST, 40], [G6, 70], [C7, 360]],
  declined: [[G5, 140], [E5, 140], [C5, 140], [REST, 40], [G4, 160], [C4, 380]],
  cancel: [[E5, 50], [C5, 120]],
  swap_step: [[E6, 40], [A6, 70]],
};

const RATE = 22050;
function wav(notes) {
  const samples = [];
  for (const [hz, ms] of notes) {
    const n = Math.floor((RATE * ms) / 1000);
    for (let i = 0; i < n; i++) {
      if (!hz) { samples.push(0); continue; }
      const square = Math.floor((i * hz * 2) / RATE) % 2 ? -1 : 1; // 8-bit console square wave
      const fade = Math.min(1, i / 60, (n - i) / 60); // short fade avoids clicks between notes
      samples.push(Math.round(square * fade * 0.28 * 32767));
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const dir = path.join(__dirname, "..", "assets", "sounds");
fs.mkdirSync(dir, { recursive: true });
for (const [name, notes] of Object.entries(MELODIES)) fs.writeFileSync(path.join(dir, `${name}.wav`), wav(notes));
console.log("wrote", Object.keys(MELODIES).join(", "));

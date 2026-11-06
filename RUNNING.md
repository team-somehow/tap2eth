# Running the Tap2ETH demo

## Quick start (from the repo root)

One-time: `cp .env.example .env`, then set `RELAYER_URL` / `NGROK_DOMAIN` (your static ngrok domain) and
`TOKEN_ADDRESS`. `.env` is git-ignored.

```bash
./backend.sh        # relayer on :8787 + ngrok tunnel to RELAYER_URL (Ctrl-C stops both)
./pi.sh url         # point the Pi terminal at RELAYER_URL (no restart needed)
./pi.sh deploy      # after changing terminal code: copy to the Pi, restart, set the URL
./pi.sh logs        # follow the Pi terminal's log      ./pi.sh ssh   # shell on the Pi
./apk.sh            # build ./tap2eth.apk with RELAYER_URL built in; share it to the phones
./apk.sh install    # same, then install on the phone connected over USB
```

**Network.** `NETWORK` in `.env` picks the chain: `whitechain` (Whitechain testnet, needs `TOKEN_ADDRESS`) or
`arc` (Arc testnet, 5042002). On Arc the token is Arc's built-in USDC and the relayer pays gas in USDC from
`ARC_RELAYER_KEY` (in `relayer/.env`, git-ignored). The single `Tap2Eth` contract is deployed on Arc at
`0xd7783c67607704a19018015E184fFd008392A363` (`contracts/deployments/5042002.json`). `POWERED_BY=on|off` shows or hides the "Powered by Arc/Whitechain" badge in the app and on the Pi. To switch: edit `NETWORK`,
restart `./backend.sh`, then `./pi.sh deploy`. The app and the Pi read the network name, explorer and currency
from the backend, so the APK needs no rebuild. Wallets live on one chain each, so phones create a new wallet on
the new network. Arc wallets need USDC sent to them (there is no test-token faucet like on Whitechain).

The URL is built into the APK, so keep it fixed (a static ngrok domain) or rebuild and re-share after
changing it. The Pi re-reads its URL on every request (`~/.tap2eth-relayer`); `PI_RELAYER_URL` in
`.env` can give it a different one, such as `http://<laptop-name>.local:8787` on the same Wi-Fi.

---

**Verified end to end (6 Nov 2026):** wallet created on a Samsung S22 Ultra by scanning a real
Mastercard over the phone's NFC plus fingerprint; then a 12 tUSDC payment at the M5Stick terminal
(card tap) approved with the fingerprint, settled on-chain.

## Native app (recommended): `mobile/`

```bash
cd mobile && npm install
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=$HOME/Library/Android/sdk
npx expo prebuild -p android && (cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a)
adb install -r android/app/build/outputs/apk/release/app-release.apk
adb reverse tcp:8787 tcp:8787    # phone reaches the relayer at localhost:8787 over USB
```

Signup happens on the phone: tap **Create wallet**, hold the bank card to the back of the phone,
then use your fingerprint. Payment approvals, freeze, and unfreeze (card scan + fingerprint) are in
the app too. The PWA below is the browser fallback (it can't read bank cards, so its signup links the
card at the terminal instead).

---

Five pieces run together:

| Piece | Where | Port |
|---|---|---|
| Local chain (Hardhat) | laptop | 8545 |
| Relayer + PWA (`relayer/`, serves `pwa/`) | laptop | 8787 |
| HTTPS tunnel for the PWA (passkeys need HTTPS) | laptop | → public `https://….trycloudflare.com` |
| Merchant terminal (`terminal/`) | laptop now, Raspberry Pi later | 8080 |
| Card reader (`reader/firmware`) | M5StickS3 + RFID 2, USB to the terminal machine | serial |

## One-time setup

```bash
cd contracts && npm install && npx hardhat compile && cd ..
cd relayer && npm install && cd ..
curl -sL -o reader/tools/capk.txt https://raw.githubusercontent.com/RfidResearchGroup/proxmark3/master/client/resources/capk.txt
python3 -m pip install pyserial        # on the terminal machine
```

## Start everything (four terminals)

```bash
cd contracts && npx hardhat node --hostname 0.0.0.0     # 1. chain
```

```bash
cd relayer && npm start                                  # 2. relayer + PWA on :8787 (deploys contracts on first run)
```

```bash
cloudflared tunnel --url http://localhost:8787           # 3. prints the https URL to open on the phone
```

```bash
python3 terminal/terminal.py --serial /dev/cu.usbmodem1101 --relayer http://localhost:8787   # 4. open http://localhost:8080
```

## Demo flow

1. **Sign up:** on the phone, open the tunnel URL (Chrome on Android), tap **Create wallet**, and
   approve the passkey with your fingerprint. A 4-digit code appears.
2. On the terminal, choose **Register a card**, type the code, and tap the card on the reader.
   The terminal reads the card's public key, has the card sign a challenge, and the relayer
   creates the wallet and gives it 100 test USDC.
3. **Pay:** on the terminal, type an amount, press **Charge**, and tap the card. The phone shows
   the request; approve with your fingerprint, and the terminal shows **Paid ✓**.
4. **Limits:** charge more than 50 tUSDC and the payment is declined (OverLimit).
5. **Freeze:** press **Freeze wallet** in the PWA, then charge again: declined (IsFrozen).

Notes:
- If the tunnel restarts, its URL changes, and passkeys are tied to the domain, so you'd need to
  sign up again. For a stable URL, use a named Cloudflare tunnel, or host `pwa/` on a fixed
  HTTPS domain and point it at the relayer.
- The chain is local and the token is test-only. To use Base Sepolia, set `RPC_URL` and
  `RELAYER_KEY` for the relayer (a funded testnet key), then restart it.

# Tap2ETH

**The bank card already in your wallet is your crypto wallet.**

Tap2ETH turns any contactless Visa or Mastercard into one key of a self-custodial smart-contract wallet. No seed phrase, no new hardware, no bank partnership: tap your card, confirm with your fingerprint, and stablecoins move on-chain. The card is used only as a key. No card payment is made and the bank account is never charged.

Runs on **Whitechain** testnet with USDT. Through **Uniswap v3** on Ethereum Sepolia, a wallet can also pay in ETH while the merchant receives the exact USDT amount.

Built at ETHGlobal Mumbai 2026 by team-somehow · [tap2eth.web.app](https://tap2eth.web.app)

## How it works

1. **The card is a signer.** A contactless bank card's chip holds an RSA key the bank put there. The key can't be read out, but the card signs a 4-byte challenge for any reader, with no PIN (EMV `INTERNAL AUTHENTICATE`). Its public key comes with a certificate chain: Visa or Mastercard → bank → card.
2. **Sign up on the phone.** The Android app reads the card over NFC, checks that chain, and creates a wallet with two signers: the card's key and a fingerprint-locked P-256 key in the phone's secure hardware.
3. **Pay.** At the terminal, the card signs the first 4 bytes of the payment hash. The phone shows the payment and, after your fingerprint, signs the full hash.
4. **The wallet checks everything on-chain:** both signatures (RSA through the modexp precompile, P-256 through its precompile), the limits and the freeze switch. Then it pays. A relayer submits the transaction and pays the gas, but it can't move funds.

## What the wallet can do

- **2 of N signers:** cards and phones, up to 8. Every normal approval needs a phone.
- **Limits:** per payment and per day. Changing them needs the full threshold.
- **Tiny payments with a tap alone** (optional, below a small limit).
- **Freeze** with the phone alone. Unfreezing needs card + phone.
- **Send and receive** from the app: scan or paste an address, tap the card, confirm with your fingerprint.
- **Recovery:** a lost card is replaced after a time lock. A lost phone is replaced by two enrolled cards after a delay. Any signer can cancel either.
- **Pay in ETH** (Sepolia): the wallet swaps its ETH on Uniswap v3 so the merchant gets the exact USDT amount, in one transaction. The wallet can also send and receive ETH, with its own ETH limits.

## Live on testnet

| Chain | Contract | Settles in | Source |
|---|---|---|---|
| Whitechain testnet (1874) | `Tap2EthFactoryV2` [`0xb413…557A`](https://explorer.testnet.whitechain.io/address/0xb413D6AA35c3901Bac6D441e8f1b38640416557A#code) | Track USDT | Verified |
| Ethereum Sepolia (11155111) | `Tap2EthFactorySwap` [`0xbE33…9a0B`](https://sepolia.etherscan.io/address/0xbE33a5f63dC26F6D0131Cf1186eDa781DB879a0B) | ETH, swapped to USDT on Uniswap v3 | Not verified yet |

All addresses are in [`contracts/deployments/`](contracts/deployments/). To check them against this repo yourself, see [`contracts/README.md`](contracts/README.md).

### Proof it works

- **Day 1:** a real Indian-issued Mastercard signed our challenge, and the signature verified end to end: Mastercard CA → bank → card key (1024-bit RSA) → signature.
- **Real card + real phone (Whitechain):** a smart wallet received [0.2](https://explorer.testnet.whitechain.io/tx/0x38328f5a536c14063e6cf9a3a202f0febc4359e6b97b00e132bcba17d12248d8) and [0.1 USDT](https://explorer.testnet.whitechain.io/tx/0xe0855dc48cd9b18c596bb3068a7975390eeeed133aae41db510785e3a72a6650), then [sent 0.3 USDT](https://explorer.testnet.whitechain.io/tx/0x31945fb2ff21ecd3f123011690a0481a6f8fcf0f0a46db9fb27fd2a84e7d2eea).
- **Café payments (Whitechain):** [0.01](https://explorer.testnet.whitechain.io/tx/0x9238e66b4209f0dec8c81420d3ae67a58d6933fafa36a4c5d4cd155e76543e77), [0.01](https://explorer.testnet.whitechain.io/tx/0xe247de6cbb62d68009ffdf6326f112477a4fd1a75783a030031582848cef97ba) and [0.1 USDT](https://explorer.testnet.whitechain.io/tx/0xf4bf2ead31a3f49bbe51aaa9888b79abe04cf9d2adb5bf19dc2f5fabf6956e0b), each with card + phone signatures checked by the wallet.
- **Uniswap (Sepolia):** [0.1 USDT paid](https://sepolia.etherscan.io/tx/0xd016de02bdf9d914881f24cd947f6d63574dfdc0041c5b00a132249576027fdf) from the wallet's ETH in one transaction (test card and passkey).

These ran on earlier deployments of the factories above; older addresses are kept under `v2History` and `swapHistory` in [`contracts/deployments/`](contracts/deployments/).

## Repository

| Folder | What's inside |
|---|---|
| [`contracts/`](contracts/) | Solidity (Hardhat): the v2 multi-signer wallet, the Uniswap swap wallet, v3 recovery (tested, not deployed) and an EIP-8141 frame-transaction experiment |
| [`relayer/`](relayer/) | Node server between the terminal, the phone and the chain. It collects signatures, submits transactions and pays gas (`server.v2.js`) |
| [`mobile/`](mobile/) | Android app (React Native / Expo): reads the card over NFC, fingerprint-locked key, pay, send, receive, limits, freeze, recovery |
| [`terminal/`](terminal/) | Merchant terminal (Python, touch UI). It checks the wallet on-chain before the card signs. Runs on a Raspberry Pi with a 3.5″ screen and the RFID reader on I2C |
| [`pi/`](pi/) | Raspberry Pi service and full-screen kiosk setup |
| [`reader/`](reader/) | M5StickS3 card-reader firmware and the day-1 signature verifier |
| [`landing/`](landing/) | Landing page (React, Vite, Three.js) |
| [`docs/`](docs/) | [White paper](docs/WHITEPAPER.md), [protocol spec](docs/PROTOCOL.md) and the day-1 [spec](docs/SPEC.md) |

`pwa/` and `uniswap-poc/` are early prototypes.

## Run it

One-time setup:

```bash
cp .env.example .env                    # then fill it in (below)
(cd contracts && npm install && npx hardhat compile)
(cd relayer && npm install)
(cd mobile && npm install && npx expo prebuild -p android)
pi/deploy.sh <relayer-url> <pi-host>    # install the terminal service and kiosk on the Pi
```

Then:

```bash
./backend.sh both   # Whitechain and Sepolia relayers behind one ngrok URL (or ./backend.sh for one chain)
./apk.sh install    # build the Android app with RELAYER_URL inside, install it over USB
./pi.sh deploy      # copy the terminal code to the Pi, restart it, point it at the relayer
```

- **`.env`:** `RELAYER_URL` and `NGROK_DOMAIN` (a static ngrok domain), `TOKEN_ADDRESS` (the track USDT, `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`) and `DEFAULT_NETWORK` (`whitechain`).
- **`relayer/.env`** (git-ignored): `RELAYER_KEY` (pays gas on Whitechain and Sepolia) and `CAFE_OWNER_ADDRESS`, where terminal payments go.
- **Two chains, one URL:** with `both`, the routes are `RELAYER_URL/whitechain` and `RELAYER_URL/sepolia`; the app and the Pi pick the network in their settings.
- Full walkthrough: [`RUNNING.md`](RUNNING.md) and [`pi/README.md`](pi/README.md).

### Tests

```bash
cd contracts && npx hardhat test   # 127 tests; the Uniswap ones fork Sepolia and are skipped offline
cd relayer && npm run e2e:v2       # 54 checks over HTTP against a running relayer (see the script header)
```

## Security notes

- A card signs only 4 bytes and has no screen, so every normal payment also needs the phone, which shows the payment and signs the full hash.
- The bank generated the card's key. Requiring the phone means no single party (bank, thief or us) can move funds.
- Two-card phone recovery on the deployed v2 contracts is demo-strength: each card signs one 4-byte piece. v3 has each card sign three pieces; it is written and tested, not deployed.
- The relayer doesn't yet check that a new card's key comes from a real bank. The app checks the certificate chain.
- Testnet only. Not audited.

Details: [white paper](docs/WHITEPAPER.md) (security model, gas costs, limitations).

## Compared with

- **Gnosis Pay, MetaMask Card:** they issue you a new card, with new KYC. Tap2ETH uses the card you already have.
- **HaLo, Tangem:** they need new hardware. Over a billion people already carry an EMV card.
- **zkEMV:** proves you hold a card. Tap2ETH is a full wallet with limits, a merchant terminal and recovery.

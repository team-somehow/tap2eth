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

## Uniswap integration (Ethereum Sepolia)

A Tap2ETH wallet can hold ETH and pay a shop that only wants USDT. The wallet swaps its own ETH on **Uniswap v3** and makes the merchant the swap's recipient, so the merchant receives exactly the USDT amount, in one transaction, approved by card and fingerprint like any other payment.

### Where to look

| What | Where |
|---|---|
| The Uniswap router interface we call (`exactOutputSingle`, `refundETH`) | [`Tap2EthSwap.sol` L8–21](contracts/contracts/swap/Tap2EthSwap.sol#L8-L21) |
| `payWithSwap`: checks the card and phone signatures and the limits, then swaps | [`Tap2EthSwap.sol` L121](contracts/contracts/swap/Tap2EthSwap.sol#L121) |
| **The Uniswap call:** `router.exactOutputSingle{value: maxEthIn}(…)` with the merchant as recipient, then `router.refundETH()` for the unused ETH | [`Tap2EthSwap.sol` L146–152](contracts/contracts/swap/Tap2EthSwap.sol#L146-L152) |
| The hash the signers approve: it binds the merchant, the USDT amount, the most ETH to spend and the pool fee | [`Tap2EthSwap.sol` L109](contracts/contracts/swap/Tap2EthSwap.sol#L109) |
| The swap wallet and its factory | [L28](contracts/contracts/swap/Tap2EthSwap.sol#L28) and [L159](contracts/contracts/swap/Tap2EthSwap.sol#L159) |
| **The price quote:** Uniswap `QuoterV2.quoteExactOutputSingle` for every fee tier at once, cheapest wins, 1% slippage cap | [`server.v2.js` L118–141](relayer/server.v2.js#L118-L141) (`quoteSwap`, L124) |
| Quote before the tap, and the swap setup | [`/api/quote` L497](relayer/server.v2.js#L497), [`/api/swap/start` L505](relayer/server.v2.js#L505) |
| When a payment swaps: USDT from the wallet if it has enough, otherwise the ETH is swapped | [`server.v2.js` L378–395](relayer/server.v2.js#L378-L395) and the `payWithSwap` call at [L517](relayer/server.v2.js#L517) |
| Deployment of the swap factory on Sepolia | [`deploySwap.js`](contracts/scripts/deploySwap.js), result in [`deployments/11155111.json`](contracts/deployments/11155111.json) |
| The first proof of concept, a plain script | [`uniswap-poc/swap.mjs`](uniswap-poc/swap.mjs) |

### Uniswap contracts used (Ethereum Sepolia)

| Contract | Address |
|---|---|
| SwapRouter02 | [`0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E`](https://sepolia.etherscan.io/address/0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E) |
| QuoterV2 | [`0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3`](https://sepolia.etherscan.io/address/0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3) |
| WETH | [`0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`](https://sepolia.etherscan.io/address/0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14) |
| USDT (Uniswap's Sepolia test token, 6 decimals) | [`0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0`](https://sepolia.etherscan.io/address/0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0) |

The WETH/USDT pools at the 0.05%, 0.3% and 1% fee tiers all exist on Sepolia; the code asks all three and takes the cheapest for the payer.

### How a payment runs

1. The shop asks for an amount in USDT. The relayer asks Uniswap's QuoterV2 how much ETH that exact USDT costs.
2. The customer taps the card. The card signs the first 4 bytes of a hash that includes the merchant, the USDT amount, the maximum ETH and the fee tier.
3. The phone shows "You pay about X ETH, swapped on Uniswap" and signs the full hash with the fingerprint.
4. `payWithSwap` verifies both signatures and the limits (counted in USDT), then calls `exactOutputSingle` with the merchant as recipient and `refundETH`. The merchant gets exactly the USDT amount; the customer pays at most the quoted ETH plus 1%.

### Evidence

- A plain-script swap, 0.1 USDT for ETH, merchant as recipient: [tx](https://sepolia.etherscan.io/tx/0xc2d7ba5aa333bbfbc9c99ac462c2db9bf45c48f7b2b36f4adc054ccbfd38e13c).
- The same swap done by a Tap2ETH smart wallet through `payWithSwap`: [0.5 USDT for 0.000000252 ETH](https://sepolia.etherscan.io/tx/0xb31ce1ac31f322d57bca03fa51646e81a7068a132f29595478f6b6518d0da29e).
- Contract tests against the real Sepolia pool on a fork: [`Tap2EthSwap.test.js`](contracts/test/Tap2EthSwap.test.js) (exact USDT out, ETH refund, signatures, limits, replay, expiry, slippage). ETH send, receive and limits: [`Tap2EthSwapEth.test.js`](contracts/test/Tap2EthSwapEth.test.js).
- [`relayer/scripts/e2e-swap.js`](relayer/scripts/e2e-swap.js): 28 checks on real Sepolia with a fake card and phone. It covers shop payments paid by swap and from USDT, the Swap button, ETH and USDT sends, the progress steps and the limits.

### Limits, honestly

- Sepolia's test pools are thin and priced oddly (0.1 USDT costs about 0.00000005 ETH), so demo amounts are small.
- We call the v3 contracts directly (SwapRouter02 and QuoterV2) because the swap has to run inside a smart-contract wallet. We did not use the Uniswap Trading API, v4 or hooks.
- The Sepolia swap factory's source is not verified on Etherscan yet.
- The swap-progress screen on the Pi terminal was checked in a browser against a mock, not yet with a real swap on the hardware.

See [`FEEDBACK.md`](FEEDBACK.md) for what building this was like.

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

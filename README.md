# Tap2ETH

**The bank card already in your wallet is your crypto wallet.**

Tap2ETH turns any existing contactless Visa or Mastercard into a key for a self-custodial
smart-contract wallet. There's no seed phrase, no new hardware and no bank partnership. You tap
your card at a merchant terminal, approve on your phone with your fingerprint, and stablecoins
move on-chain.

Built at ETHGlobal Mumbai 2026.

## The idea in one minute

- Every modern chip card holds a private key the bank put there, locked inside the chip. It can
  never be read out.
- The card will sign a random challenge for anyone who taps it (EMV "offline data
  authentication"). The signature can be checked with the card's public key.
- The card's public key is on the card itself, inside certificates signed by the bank, whose
  key is signed by Mastercard or Visa. So anyone can check that it's a real bank-issued card.
- Tap2ETH stores that public key in a smart contract wallet. Every payment needs:
  1. **a signature from the card**, proving the physical card was tapped, and
  2. **a signature from the owner's phone passkey** (fingerprint or face), proving the owner saw
     and approved exactly this payment.
- The contract checks both, plus spending limits and a freeze switch, then pays.

## Proof it works (day 1)

Using our own M5StickS3 and an M5Stack RFID 2 reader, a real Indian-issued Mastercard:

- answered the payment commands (selected the Mastercard app `A0000000041010`);
- signed a random 4-byte challenge we chose (INTERNAL AUTHENTICATE, DDA);
- and the signature **verified end to end**: Mastercard CA key → bank's key → card's key
  (1024-bit RSA, exponent 3) → signature over our challenge.

No PIN was needed, and no bank or network was involved. The card number never left the
reader's memory.

## What works on Whitechain Sepolia (smart wallets, chain ID 1874)

Every user gets a smart-contract wallet (a cheap clone) that is controlled by their bank card and their phone. The wallet, not the relayer, checks every signature.

| Feature | Status | Evidence |
|---|---|---|
| **Smart wallet per user, card + phone multisig (2 of N)** | Deployed, source verified | Latest factory [`0x15571a05…7dcB`](https://explorer.testnet.whitechain.io/address/0x15571a053040dB029958Ee5527B72652964E7dcB?tab=txs) |
| **More cards, 2 of 3 and 3 of 3, daily and per-payment limits, card-only tiny payments, freeze** | Tested live on the latest factory | Live smoke test `contracts/scripts/smokeV2.js`: 36 of 36 checks |
| **Receive USDT** | Done with the track USDT | 0.2 USDT and 0.1 USDT arrived in a real wallet: [tx 1](https://explorer.testnet.whitechain.io/tx/0x38328f5a536c14063e6cf9a3a202f0febc4359e6b97b00e132bcba17d12248d8), [tx 2](https://explorer.testnet.whitechain.io/tx/0xe0855dc48cd9b18c596bb3068a7975390eeeed133aae41db510785e3a72a6650). The app shows them under Activity as "Received". |
| **Send USDT to any address, card + fingerprint** | Done with a real bank card and a real phone, with the track USDT | 0.3 USDT sent from a smart wallet: [tx](https://explorer.testnet.whitechain.io/tx/0x31945fb2ff21ecd3f123011690a0481a6f8fcf0f0a46db9fb27fd2a84e7d2eea). That wallet came from the earlier v2 factory (`0xFB39…5A61`). On the latest factory, Send passes the relayer test (37 of 37 on Whitechain, with a throwaway token). |
| **Lost-phone recovery with two cards** | Contract tested live; relayer tested locally; app screens built | Latest factory, smoke test section 9: one card refused, two cards start it with no phone signature, it cannot finish before the delay, then the old phone is rejected and the new phone pays. Relayer: 54 of 54 on a local chain. The app's "I already have a wallet" flow has not yet been tried on a phone. |


## Deployed on Whitechain Sepolia (chain ID 1874)

Explorer: https://explorer.testnet.whitechain.io · RPC: `https://rpc.testnet.whitechain.io`

| Contract | Address | Source verified |
|---|---|---|
| `Tap2EthFactory` | [`0xBeC6E6382477263f17A90145a5c569264C153A76`](https://explorer.testnet.whitechain.io/address/0xBeC6E6382477263f17A90145a5c569264C153A76#code) | Yes |
| `Tap2EthWallet` (smoke-test instance, throwaway fake card and passkey) | [`0x664BC373618b1c37ee0DF43903Fe7C871f62A076`](https://explorer.testnet.whitechain.io/address/0x664BC373618b1c37ee0DF43903Fe7C871f62A076#code) | Yes |
| Relayer / deployer account (pays gas) | [`0x68d076aBe0E116856C0cB60f4f58ce59ccDaA265`](https://explorer.testnet.whitechain.io/address/0x68d076aBe0E116856C0cB60f4f58ce59ccDaA265) | n/a |

Transactions: [factory deploy](https://explorer.testnet.whitechain.io/tx/0xf318d50013e7cb7282bf7fcc29ae3783cf42e0aacc5f5b6ee9f4d73d7b4cb114), [wallet creation](https://explorer.testnet.whitechain.io/tx/0x107a4363e2f0da284e28d5f29d95db572bec28b8dbe1d1e0fa8424a025fcadd4).

Smoke test on the live chain (`contracts/scripts/smoke.js`): the on-chain card check (RSA via the modexp
precompile plus SHA-1) and the phone check (WebAuthn P-256 via the P-256 precompile) both return true for
valid signatures and false for wrong ones.

| Measured on Whitechain Sepolia | Gas |
|---|---|
| Deploy factory | 2,902,062 |
| Create a wallet | 2,566,689 |
| `verifyCard` (RSA + SHA-1) | 151,139 |
| `verifyPhone` (P-256) | 62,716 |

### v2 contracts (multi-signer wallet)

`contracts/contracts/v2/Tap2EthV2.sol`. v1 above is unchanged. v2 adds, with 37 tests (`contracts/test/Tap2EthV2.test.js`):

- **Daily and per-payment limits** on-chain, changed only with the full threshold of signatures (card + phone).
- **Optional 1-of-2 for small payments:** payments up to `softLimit` need one signature. By default it must be the phone; a card alone is accepted only if `softCardOnly` is switched on.
- **More signers, still 2 of N:** add cards or phones (up to 8). Adding needs `threshold` signatures from the existing signers *and* a signature from the new key. Threshold can be raised (2 to N), signers removed (never below the threshold or the last phone).
- **At least one phone signature on every normal approval.** A card signs only 4 bytes of the payment hash, so two cards alone are never accepted.
- **Time-locked card recovery** instead of v1's instant phone-only swap: the phone plus the new card start a replacement that takes effect after `recoveryDelay`, and any single signer can cancel it.
- **Lost phone, recovered with two cards:** at least two different cards and the new phone start a replacement of the phone signer with no phone signature. It takes effect after `recoveryDelay`, any single signer can cancel it, and finishing it adds the new phone and removes the old ones. Each card signs one 4-byte piece of the request, so this is the demo-strength version; see the note below.
- **Proof of possession at creation:** the card and the phone both sign the creation parameters, so nobody can register a card they don't hold. Wallets are cheap clones.

| v2 on Whitechain Sepolia (latest, with two-card phone recovery) | Address | Source verified |
|---|---|---|
| `Tap2EthFactoryV2` | [`0x15571a053040dB029958Ee5527B72652964E7dcB`](https://explorer.testnet.whitechain.io/address/0x15571a053040dB029958Ee5527B72652964E7dcB#code) | Yes |
| `Tap2EthWalletV2` (implementation) | [`0x1E82f6FF110A43492f1ed2FaE0A1600d8D8314F1`](https://explorer.testnet.whitechain.io/address/0x1E82f6FF110A43492f1ed2FaE0A1600d8D8314F1#code) | Yes |
| Smoke-test wallet (fake cards, throwaway token), latest run | [`0x14d0617f1c7AEC1a848a3698045f4726BC3Fe2Ec`](https://explorer.testnet.whitechain.io/address/0x14d0617f1c7AEC1a848a3698045f4726BC3Fe2Ec) | Clone of the implementation |

The earlier v2 deployment (without phone recovery, factory `0xFB395D511b5dc33DE8488D936Ac8814166D95A61`) is kept in `contracts/deployments/1874.json` under `v2History`.

**v3 (written, tested, not deployed):** `contracts/contracts/v3/Tap2EthV3.sol` makes the same phone recovery stronger. Each card signs three 4-byte pieces of the request hash (12 bytes instead of 4) and the one-piece route is switched off. Reason: a card signs only 4 bytes, and the signatures a card made earlier (for example when it was added) are public on-chain. Someone holding one stolen card could look for a recovery request whose hash starts with the same 4 bytes as an old signature of the other card (about 2^32 tries) and sign it with the stolen card, so the second card never has to be present. Only the delay and the old phone's cancel would stop that. With three pieces that replay is not realistic. This analysis has not been independently reviewed.

Live smoke test (`contracts/scripts/smokeV2.js`, run on Whitechain Sepolia, **36 of 36 checks passed** on the latest deployment). It uses throwaway fake cards and a throwaway `TestUSDC`, not the track USDT. It covers:
- receiving two small random deposits (1 to 5) and sending them out with card + phone
- adding a second card (2 of 3) and paying with card 2 + phone
- one signature refused, two cards without the phone refused
- raising the requirement to 3 of 3 and lowering it again
- hitting the per-payment and daily limits, then raising them with both signatures
- card-alone payments for tiny amounts (up to 10), and 11 with the card alone refused
- freeze with the phone alone, payments blocked while frozen, unfreeze with card + phone
- lost phone: one card alone cannot start a replacement, two cards can without a phone signature, it cannot finish before the delay, then the old phone is rejected and the new phone with a card pays

| Measured on Whitechain Sepolia | Gas |
|---|---|
| Deploy v2 factory (latest) | 5,060,414 |
| Create a wallet (clone + 2 proofs) | 765,960 (v1: 2,566,689) |
| Add a second card (2 of 3) | 555,553 |
| `pay`, card + phone | 320,193 |
| `pay`, card 2 + phone | 243,947 |
| `pay`, card + card 2 + phone (3 of 3) | 379,953 |
| `pay`, card alone (tiny amount) | 199,028 |
| Change limits (card + phone) | 228,084 |
| Freeze with the phone alone | 104,422 |
| Unfreeze (card + phone) | 215,810 |
| Start a phone replacement (2 cards, no phone) | 404,897 |
| Finish a phone replacement | 203,115 |

### v2 relayer (`relayer/server.v2.js`)

The relayer is the small server between the merchant terminal, the phone app and the contract. It passes payment requests to the phone, collects the signatures, submits the transaction and pays the gas, so the customer never holds the network's coin. `server.js` (v1) is unchanged; v2 is a separate file for the v2 contracts. The old PWA is not served by v2 and is left as it was.

```bash
cd relayer && npm install
npm run start:v2          # reads relayer/.env: RELAYER_KEY, RPC_URL (and optionally TOKEN_ADDRESS)
npm run e2e:v2            # plays app + terminal + card + phone over HTTP (37 checks)
```

| Setting (env) | Meaning |
|---|---|
| `RELAYER_KEY` | The account that pays gas. Required on a real network; the relayer refuses to start with the public Hardhat key anywhere except a local chain. |
| `RPC_URL` | Defaults to a local chain. For Whitechain Sepolia: `https://rpc.ankr.com/whitechain_testnet`. |
| `TOKEN_ADDRESS` | The stablecoin to use (the track USDT). If unset, it deploys a throwaway test token with a faucet. That mode does not count for the track. |
| `FACTORY_V2` | Defaults to `factoryV2` in `contracts/deployments/<chainId>.json`. |
| `DAILY_GAS_BUDGET`, `MAX_GAS_PRICE_GWEI` | Gas protection, below. |
| `PER_TX_LIMIT`, `DAILY_LIMIT`, `RECOVERY_DELAY` | Starting limits for new wallets, and the waiting period (seconds, default 86400) for lost-card and lost-phone replacements. Use a short value such as 120 to try recovery on a phone. |
| `SIGNUP_LIMIT`, `POLL_MS` | Sign-ups and recoveries per IP per hour (default 1000), and how often the relayer reads new deposits (default 10,000 ms). |

**What stops someone draining the relayer**
1. Every call is simulated first, so a bad signature costs no gas.
2. It only calls our own factory and wallet contracts, and they need valid card and phone signatures.
3. Per-IP rate limits on every write endpoint. Wallet creation and recovery are allowed `SIGNUP_LIMIT` times an hour per IP (default 1000, so a hackathon demo never hits it; set it to 10 on a public deployment).
4. A daily gas budget (default 0.5 of the native coin) and a gas price cap (default 100 gwei).
5. It refuses to run on a real network without its own key.

Not covered yet: it does not check that a new card's key comes from a real bank (the certificate chain is only checked on the phone), so someone could create many wallets with fake cards until the rate limit or budget stops them.

**How the relayer gets its coin:** on testnet from the Whitechain faucet (WBT). One full flow (sign up, pay, change limits, add a card, freeze, unfreeze) cost about 0.0148 WBT on Whitechain Sepolia.

**Verified:** the relayer end-to-end test passes 37 of 37 on Whitechain Sepolia against the latest factory (throwaway test token), and 54 of 54 on a local chain with the recovery steps added. On a real Android phone (Galaxy A52s) with a real bank card, signing up, adding a second card, receiving the track USDT and sending 0.3 USDT worked on Whitechain Sepolia (earlier v2 factory). Not yet verified: recovery from the phone app, and the terminal hardware against this relayer.

**Recover a wallet on a new phone (app and relayer):** on the first screen, "I already have a wallet". Tap two different cards of the wallet, then confirm with the fingerprint; the phone's new key is registered after the waiting period, and "Finish" then moves the wallet to this phone. The relayer endpoints are `/api/recover/start`, `/api/recover/:id`, `/api/recover/status/:wallet` and `/api/recover/finish`. The old phone, if it still works, sees a warning on Home and can cancel with its fingerprint (`/api/recovery-cancel/*`). It needs a wallet with at least two cards. The relayer end-to-end test covers it (54 checks).

**Send and Receive (app):** the owner can pay any address, not only a shop. In the app: scan a QR code or paste an address, enter an amount, review it, tap the card on the back of the phone, confirm with the fingerprint. The contract needs no change, because `pay` already takes any recipient and the recipient is inside the hash the phone signs. The relayer endpoint is `POST /api/send/start`, followed by `/api/pay/:id/card` and `/api/pay/:id/phone`. A send always needs the phone's fingerprint, never the card-only shortcut. Receive shows the wallet address as a QR code with copy and share. The app checks the address format and its checksum, warns on a first-time recipient, and refuses amounts over the balance or the limits before the card is tapped.

**Phone key and fingerprints:** the phone's signing key no longer becomes invalid when a fingerprint is added or removed (`setInvalidatedByBiometricEnrollment(false)`). With the old setting, enrolling a new fingerprint permanently killed the key, and recovery needs a phone signature. The key still needs a strong biometric for every signature.

**For the app and terminal:** small card-only payments are paid right after the card tap with no phone prompt, so the terminal needs no change. Its on-screen text still says "tUSDC".

Status and limits:
- A real transaction in the track USDT (`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`) has been made: 0.2 and 0.1 USDT received and 0.3 USDT sent by a smart wallet (links in the table at the top). That token can only be minted by its owner, so the relayer's built-in `TestUSDC` faucet is used only for local tests and smoke tests. Run the relayer with `TOKEN_ADDRESS` set to use the track USDT.
- The smoke-test wallet uses a generated fake card, not a real bank card.

Deploy it yourself (needs a funded key in `relayer/.env`, git-ignored; see `WALLETS.md`):
```bash
cd contracts && npm install
npx hardhat run scripts/deploy.js --network whitechainSepolia      # writes deployments/1874.json
npx hardhat run scripts/smoke.js --network whitechainSepolia
npx hardhat verify --network whitechainSepolia <factory address>
```

## What we're building

| Part | Hardware / stack | Job |
|---|---|---|
| **Merchant terminal** | Raspberry Pi + screen, with the M5Stick + RFID reader over USB | Merchant types the amount, customer taps the card, screen shows the status |
| **Phone app** | Android (iPhone can't talk to payment cards) | Sign up by tapping the card, approve payments with your fingerprint, set limits, freeze |
| **Relayer / backend** | Small server | Passes payment requests from the terminal to the phone, then submits the transaction with sponsored gas |
| **Smart contract wallet** | Solidity, ERC-4337 account on an L2 | Holds the funds and checks the card signature, the phone signature, the limits and the freeze flag |

See [docs/SPEC.md](docs/SPEC.md) for the full spec.

## Why it's different

- **Gnosis Pay, MetaMask Card, crypto debit cards:** those issue you a *new* card through a
  card issuer, with new KYC. Tap2ETH uses the card you already have.
- **HaLo, Burner and other NFC crypto cards:** those need new hardware. Over a billion people
  already carry an EMV card.
- **zkEMV:** proves card possession in zero knowledge. Tap2ETH is a full payment wallet with
  limits, a merchant terminal, two-factor approval and recovery.

## Honest limits

- The card has no screen and signs for any reader within a few centimetres. That's why every
  payment also needs the phone.
- The bank generated the card's key, so the card alone isn't full self-custody. Requiring the
  phone means no single party (bank, thief or us) can move funds.
- Each card signature only covers 4 bytes of our challenge. The phone signs the full payment
  hash.
- A reissued card has a new key, so the wallet supports swapping in a new card.

## Team

team-somehow

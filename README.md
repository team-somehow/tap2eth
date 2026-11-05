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

Status and limits:
- A real payment in the track USDT (`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`) has **not** been made yet. That token can only be minted by its owner, so we need test USDT from the organisers. The relayer and app still point at our own `TestUSDC`, which does not count for the track.
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

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

### v2 contracts (multi-signer wallet)

`contracts/contracts/v2/Tap2EthV2.sol`. v1 above is unchanged. v2 adds, with 28 tests (`contracts/test/Tap2EthV2.test.js`):

- **Daily and per-payment limits** on-chain, changed only with the full threshold of signatures (card + phone).
- **Optional 1-of-2 for small payments:** payments up to `softLimit` need one signature. By default it must be the phone; a card alone is accepted only if `softCardOnly` is switched on.
- **More signers, still 2 of N:** add cards or phones (up to 8). Adding needs `threshold` signatures from the existing signers *and* a signature from the new key. Threshold can be raised (2 to N), signers removed (never below the threshold or the last phone).
- **At least one phone signature on every normal approval.** A card signs only 4 bytes of the payment hash, so two cards alone are never accepted.
- **Time-locked card recovery** instead of v1's instant phone-only swap: the phone plus the new card start a replacement that takes effect after `recoveryDelay`, and any single signer can cancel it.
- **Proof of possession at creation:** the card and the phone both sign the creation parameters, so nobody can register a card they don't hold. Wallets are cheap clones.

| v2 on Whitechain Sepolia | Address | Source verified |
|---|---|---|
| `Tap2EthFactoryV2` | [`0xFB395D511b5dc33DE8488D936Ac8814166D95A61`](https://explorer.testnet.whitechain.io/address/0xFB395D511b5dc33DE8488D936Ac8814166D95A61#code) | Yes |
| `Tap2EthWalletV2` (implementation) | [`0x76FDa4413bc97b338c6393C1621DFE4aab89f45C`](https://explorer.testnet.whitechain.io/address/0x76FDa4413bc97b338c6393C1621DFE4aab89f45C#code) | Yes |
| Smoke-test wallet (fake cards, throwaway token), latest run | [`0xe6536C9C02A3f9EF2efb6C73772cd94D6C6E14f9`](https://explorer.testnet.whitechain.io/address/0xe6536C9C02A3f9EF2efb6C73772cd94D6C6E14f9) | Clone of the implementation |

Live smoke test (`contracts/scripts/smokeV2.js`, run on Whitechain Sepolia, **29 of 29 checks passed**). It uses throwaway fake cards and a throwaway `TestUSDC`, not the track USDT. It covers:
- receiving two small random deposits (1 to 5) and sending them out with card + phone
- adding a second card (2 of 3) and paying with card 2 + phone
- one signature refused, two cards without the phone refused
- raising the requirement to 3 of 3 and lowering it again
- hitting the per-payment and daily limits, then raising them with both signatures
- card-alone payments for tiny amounts (up to 10), and 11 with the card alone refused
- freeze with the phone alone, payments blocked while frozen, unfreeze with card + phone

| Measured on Whitechain Sepolia | Gas |
|---|---|
| Deploy v2 factory | 4,558,406 |
| Create a wallet (clone + 2 proofs) | 765,960 (v1: 2,566,689) |
| Add a second card (2 of 3) | 555,553 |
| `pay`, card + phone | 320,193 |
| `pay`, card 2 + phone | 243,947 |
| `pay`, card + card 2 + phone (3 of 3) | 379,953 |
| `pay`, card alone (tiny amount) | 199,028 |
| Change limits (card + phone) | 228,084 |
| Freeze with the phone alone | 104,422 |
| Unfreeze (card + phone) | 215,787 |

The relayer, PWA and app still use v1. Moving them to v2 is not done yet.

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

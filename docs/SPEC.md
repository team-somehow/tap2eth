# Tap2ETH: spec

Status: draft v0.1 (ETHGlobal Mumbai, day 1)

## 1. Goal

A user pays a merchant in stablecoins by tapping their existing contactless bank card on a
merchant terminal and approving on their phone. Funds sit in a smart-contract wallet that only
moves money when **both** the card and the phone have signed the exact payment.

### In scope for the hackathon

- Sign-up: register a card and a phone passkey, which creates the wallet.
- Pay at a merchant terminal: card tap plus phone approval.
- Spending limits (per payment and per day).
- Freeze and unfreeze.
- Replace the card (for example when the bank reissues it).

### Stretch goals

- **"Chip In":** large payments need cards from several people, for a family or team treasury.
- Small card-only payments below a tiny limit, with no phone step.
- ENS names for wallets, e.g. `name.tap2eth.eth`.
- Proving "this is a genuine bank card" in zero knowledge (sybil resistance).

## 2. Components

```
┌──────────────── Merchant terminal ────────────────┐
│  Raspberry Pi + screen          M5Stick + RFID     │
│  - merchant types amount   ◄──USB──►  - reads card │
│  - shows "Tap card"                   - asks card  │
│  - shows "Waiting for phone…"           to sign    │
│  - shows "Paid ✓"                                  │
└───────────────────────┬────────────────────────────┘
                        │ HTTPS
                        ▼
                 Relayer / backend ──push──► Customer's phone (fingerprint approval)
                        │
                        ▼
                 Smart contract wallet (L2)
```

### 2.1 Card reader (M5StickS3 + M5Stack RFID 2, WS1850S)

- The firmware already works; we proved it on day 1. It handles ISO 14443-A, ISO-DEP (RATS,
  chaining, WTX), SELECT PPSE, SELECT AID, GPO, READ RECORD and INTERNAL AUTHENTICATE.
- Hardware notes:
  - The Grove port is SDA=GPIO9 and SCL=GPIO10. Its 5V supply must be switched on through the
    power chip (M5PM1 at 0x6E, register 0x06, bit 3).
  - Poll for cards at normal antenna strength. Raise the transmitter conductance (CWGsPReg and
    ModGsPReg = 0x3F) only after a card is selected, otherwise the card browns out during
    payment commands.
  - Range is very short, so use a card cradle and hold the card for about 3 seconds.
- Interface to the Pi, over USB serial:
  - Pi → reader: `SIGN <8-hex-char challenge>`
  - Reader → Pi: `CARD <public-key data>`, `SIG <hex>`, or `ERR <reason>`
- **It must never send the PAN, track data or certificates in clear text to the Pi or logs**,
  except where signup needs the certificates (on the phone, not the terminal).

### 2.2 Merchant terminal (Raspberry Pi + screen)

- Merchant UI: type the amount, then show "Tap card", "Waiting for customer's phone…", and
  finally "Paid ✓" with the transaction link, or "Declined".
- Builds the payment intent and its hash **H** (section 3), sends the challenge to the reader,
  and posts the intent and card signature to the relayer.

### 2.3 Phone app (Android)

- **Sign-up:**
  1. Read the card over NFC (IsoDep).
  2. Verify the certificate chain locally: CA key → issuer key → card key.
  3. Extract the card's public key.
  4. Create a passkey (P-256, in Android Keystore, unlocked by biometrics).
  5. Deploy or register the wallet with both public keys.
- **Approve:**
  1. Receive a push notification and show "Pay X to Merchant?".
  2. On fingerprint, sign the full H with the passkey.
  3. Send the signature to the relayer.
- **Manage:** balance and history, limits, freeze, replace card.
- **Never** ask for the card PIN. That's exactly how NFC-relay malware works.

### 2.4 Relayer / backend

- Holds pending payments, matched by H.
- Notifies the phone.
- Once both signatures are in, submits the UserOperation to a bundler, with gas sponsored by a
  paymaster.
- It can't steal funds: the contract checks everything itself.

### 2.5 Smart contract wallet

An ERC-4337 account (EntryPoint v0.8). It stores:

| Field | Meaning |
|---|---|
| `cardKey` | The card's RSA public key, read from the card at signup |
| `phoneKey` | The phone passkey's public key (P-256) |
| `perTxLimit`, `dailyLimit`, `spentToday`, `day` | Spending rules |
| `nonce` | Payment counter, so a payment can't be submitted twice |
| `frozen` | Freeze switch |

## 3. What is hashed, what is signed, who holds which key

| | Where it lives | Notes |
|---|---|---|
| Card private key | Inside the card's chip | Never leaves the chip. The bank created it. |
| Card public key | On the card, in a certificate signed by the bank (bank key signed by Mastercard/Visa) | Read and checked by the phone at signup, then stored in the contract |
| Phone private key | The phone's secure hardware (passkey) | Unlocked by fingerprint or face |
| Phone public key | Created at signup | Stored in the contract |

### Payment

1. **Hash.** The terminal builds the payment intent and hashes it:
   `H = keccak256(wallet, merchant, token, amount, nonce, expiry, chainId)`
2. **Card signs.** The terminal sends the first 4 bytes of H to the card as the challenge. The
   card signs it with its private key. This proves the physical card was tapped for this payment.
3. **Phone signs.** The phone shows the payment and, after the fingerprint, signs the full H
   with the passkey. This proves the owner agreed to exactly this payment.
4. **Contract checks:**
   1. it rebuilds H from the payment details;
   2. it checks the card's signature with `cardKey` (RSA via the modexp precompile, plus SHA-1);
   3. it checks the phone's signature with `phoneKey` (via the P-256 precompile);
   4. it checks the nonce, the expiry, the limits and the frozen flag;
   5. it transfers the tokens, then updates the nonce and the spent amount.

Why both: the card signs only 4 bytes and has no screen, so a card signature alone could be
skimmed or matched to another payment. The phone signs all 32 bytes after showing the user what
they're paying, which binds the exact payment.

## 4. Other operations

| Operation | Needs | Notes |
|---|---|---|
| Freeze | Phone alone (or the card alone) | Freezing can't move funds, so one factor is enough |
| Unfreeze | Card + phone | Plus a short delay (stretch goal) |
| Change limits | Card + phone | |
| Replace card | Phone + new card, with a delay | For lost or reissued cards. The wallet address stays the same. |
| Recover the phone | Card + guardian or delay | Stretch goal |

## 5. Security rules

- The card number (PAN), track data and certificates must never go on-chain, into logs or onto
  the backend. Only the card's public key leaves the phone.
- The contract builds H itself from the payment fields, so there are no free fields an attacker
  could vary.
- Payments expire after a few minutes.
- Treat the 1024-bit card key as legacy-grade; the phone factor is mandatory for real value.
- Demo safety: use testnet, our own cards and small limits.

## 6. Demo script

1. Sign up: tap the card on the phone, which creates the wallet; then fund it with test USDC.
2. The merchant types ₹200 / 2 USDC, the customer taps, the phone pings, the customer approves
   with a fingerprint, and the terminal shows "Paid ✓" with the transaction link.
3. Try an amount over the limit: the payment is declined.
4. Freeze from the phone, tap again: the payment is declined.
5. (Stretch) "Chip In": two cards approve a big payment.

## 7. Open decisions

- Which chain: Arc (stablecoin prize) or Base / Base Sepolia (best tooling)?
- Whether card-only small payments are in the demo.
- Phone app stack: Kotlin or React Native (the NFC side needs IsoDep transceive).

## 8. Known issues from the POC

- GENERATE AC with CDA (which could carry 20 more bytes in tag 9F7C) currently times out on our
  reader. INTERNAL AUTHENTICATE works and is enough.
- The RFID 2 reader is marginal on power and range. A PN532 or ACR122U is the fallback for the
  terminal.

# Running the Tap2ETH demo

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

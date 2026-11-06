# Tap2ETH contracts

A Tap2ETH wallet is a small smart contract owned by **a bank card and a phone**. To move money, the wallet
itself checks both signatures on-chain. The relayer only submits the transaction and pays gas; it cannot
move anyone's money.

**One contract on Arc: [`Tap2Eth`](contracts/v2/Tap2Eth.sol).** Deploy it once. That one address is the registry
(`walletOf(keccak256(card public key))` finds a card's wallet) and the wallet logic. Each user's wallet is a tiny
clone of it with its own storage and funds, so creating a wallet stays cheap. The deployed copy is locked and can
never act as a wallet, and clones can never act as the registry. The wallet rules themselves (`pay`, `freeze`,
`setLimits`, signers, recovery) are in [`Tap2EthV2.sol`](contracts/v2/Tap2EthV2.sol) as `Tap2EthWalletV2`, which
`Tap2Eth` extends. Whitechain still runs the earlier two-contract version of the same wallet (a separate factory
and implementation).

## Deployments

### Arc testnet (chain ID 5042002) — gas is paid in USDC

| | Address | Source |
|---|---|---|
| `Tap2Eth` (registry + wallet logic) | [`0xd7783c67607704a19018015E184fFd008392A363`](https://explorer.testnet.arc.io/address/0xd7783c67607704a19018015E184fFd008392A363?tab=contract) | Verified |
| Token: USDC (Arc's built-in, 6 decimals) | [`0x3600000000000000000000000000000000000000`](https://explorer.testnet.arc.io/address/0x3600000000000000000000000000000000000000) | System contract |
| Deployer / relayer (pays gas in USDC) | [`0x7ee85B080701330bf53Be62B7E72fcDD034eCCac`](https://explorer.testnet.arc.io/address/0x7ee85B080701330bf53Be62B7E72fcDD034eCCac) | n/a |
| Cafe (receives terminal payments) | [`0x0eD4ddc707454590673609975578782046ac7D44`](https://explorer.testnet.arc.io/address/0x0eD4ddc707454590673609975578782046ac7D44) | n/a |

Deploy transaction: [`0xa0f864a8…aca7`](https://explorer.testnet.arc.io/tx/0xa0f864a8a3acf12cb80130c594c6db245a702c416b2140b948b146b825d7aca7).
An earlier two-contract Arc deploy (`0x5F9b…8392` and `0xd704…eD8`, verified, now unused) is kept in `deployments/5042002.json` under `v2History`.

**Live test on Arc.** A test wallet with a fake card and passkey ([`0xB3Fb…8594`](https://explorer.testnet.arc.io/address/0xB3Fb9dE6F7297fA813a19aEB5d6A5c53cfB58594))
was created through the relayer, funded with 0.5 USDC, and paid 0.01 USDC to the cafe with card + phone
signatures checked by the wallet on-chain: [payment tx](https://explorer.testnet.arc.io/tx/0x7cbb741be0aa18738188bc204898fba6707c22557bcabd51e148e4d478002c8b).
Arc runs the card check (RSA through the modexp precompile) and the phone check (WebAuthn / P-256) without changes.

### Whitechain testnet (chain ID 1874)

| | Address | Source |
|---|---|---|
| `Tap2EthFactoryV2` | [`0xb413D6AA35c3901Bac6D441e8f1b38640416557A`](https://explorer.testnet.whitechain.io/address/0xb413D6AA35c3901Bac6D441e8f1b38640416557A#code) | Verified |
| `Tap2EthWalletV2` (implementation) | [`0x75572741C89B0665fB3A30473B831f0e83153b88`](https://explorer.testnet.whitechain.io/address/0x75572741C89B0665fB3A30473B831f0e83153b88#code) | Verified |
| Token (track USDT) | [`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`](https://explorer.testnet.whitechain.io/address/0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7) | n/a |

Both lists are also in [`deployments/`](deployments/) (`5042002.json`, `1874.json`). The backend picks the
chain with `NETWORK=arc` or `NETWORK=whitechain` in the repo's `.env` (see [`../RUNNING.md`](../RUNNING.md)).

## View and verify it yourself

1. **Read the source on the explorer.** Open a link above and go to the **Contract** tab: the code shown is
   the code that runs, because it was compiled from this repo and matched byte for byte against the chain.
2. **Check that the deployment matches this repo.** Compile with the pinned settings (Solidity 0.8.28,
   optimizer on with 200 runs, EVM `cancun`, set in [`hardhat.config.js`](hardhat.config.js)) and compare:

   ```sh
   npm install && npx hardhat compile
   cast code 0xd7783c67607704a19018015E184fFd008392A363 --rpc-url https://rpc.testnet.arc.network
   # compare with artifacts/contracts/v2/Tap2Eth.sol/Tap2Eth.json → deployedBytecode
   # (the last ~50 bytes are a compiler metadata hash and may differ)
   ```
3. **Publish source for a new deployment:** `./verify-arc.sh` (Arc) or
   `npx hardhat verify --network whitechainSepolia <address>` (Whitechain).
4. **Look up a card's wallet without trusting anyone:**
   `cast call 0xd7783c67607704a19018015E184fFd008392A363 "walletOf(bytes32)(address)" <keccak256 of the card's RSA modulus>`.
5. **Read a wallet's rules:** `cast call <wallet> "perTxLimit()(uint256)"`, `dailyLimit()`, `threshold()`,
   `frozen()`, `nonce()`, `signerCount()`. These are the same numbers the Pi terminal checks before it
   asks a customer to pay.
6. **Run the tests:** `npx hardhat test` (37 tests for the wallet rules, run against both the two-contract and the single-contract versions, plus a test that the master and clones cannot swap roles).

## How a payment is checked

`pay(token, merchant, amount, expiry, sigs)` pays only if all of this holds:

1. Not expired and not frozen; the amount is within the per-payment and daily limits.
2. The signed message is `keccak256(abi.encode("TAP2ETH_V2_PAY", chainid, wallet, token, merchant, amount, nonce, expiry))`
   (see `paymentHash`). It names the chain, this wallet, the merchant and the amount, so a signature cannot be
   reused elsewhere, and `nonce` goes up after each payment so it cannot be replayed.
3. **Card signature:** the card (EMV bank card, RSA) signs the first 4 bytes of that hash as its challenge. The
   wallet verifies it against the card's stored public key (`verifyRsa`, using the modexp precompile).
4. **Phone signature:** the phone's secure hardware signs the full hash with a fingerprint (WebAuthn / P-256,
   `verifyWebAuthn`). Every normal payment needs the phone. Small payments up to `softLimit` can allow card-only
   if the owner switched `softCardOnly` on.
5. Signatures must be from different, active signers, sorted, and at least `threshold` of them (2 by default).

Then the wallet sends the token to the merchant (`SafeERC20.safeTransfer`) and emits `Paid`.

The wallet also supports more cards or phones (up to 8), time-locked card replacement, lost-phone recovery with
two cards, a freeze switch, and limit changes that need the full threshold of signatures.

## What to trust

- The **relayer** and the **Pi terminal** cannot take money: the terminal's checks are for a good customer
  experience, and the wallet checks everything again on-chain. The merchant address comes from the relayer, never
  from the terminal.
- A card signs only 4 bytes, which is why the phone's full signature is always required for normal payments.
  See the repository README for the analysis of the card-only and recovery paths. It has not been independently audited.
- These are testnet contracts. Do not use them with real money.

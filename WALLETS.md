# Wallets

Public addresses only. **Never put private keys in this repo.**

## Relayer / deployer (testnet)

| | |
|---|---|
| Address | `0x836cB33aE5dd930Bcf91d86647C5fcb87E030c76` |
| Purpose | Deploys the Tap2ETH contracts and pays gas for users' transactions (the relayer) |
| Networks | Testnets only (e.g. Base Sepolia). Fund it from a faucet. |
| Private key | `relayer/.env` on the laptop that created it (`RELAYER_KEY=…`), git-ignored. Not shared anywhere. |
| Created | 2026-11-06 |

Explorer: https://sepolia.basescan.org/address/0x836cB33aE5dd930Bcf91d86647C5fcb87E030c76

## Cafe owner (terminal receiver)

| | |
|---|---|
| Address | `0x0eD4ddc707454590673609975578782046ac7D44` |
| Purpose | Receives every payment made at the merchant terminal (POS). The relayer sets the receiver, so the terminal cannot change it. |
| Networks | Whitechain Sepolia (chain ID 1874), track USDT |
| Private key | `relayer/.env` on the laptop that created it (`CAFE_OWNER_KEY=…`), git-ignored. The server only reads `CAFE_OWNER_ADDRESS`. |
| Created | 2026-11-06 |

Explorer: https://explorer.testnet.whitechain.io/address/0x0eD4ddc707454590673609975578782046ac7D44

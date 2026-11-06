# Feedback on building with Uniswap

**Project:** Tap2ETH, a smart-contract wallet controlled by a bank card and a phone fingerprint.
**What we built with Uniswap:** the wallet holds ETH and pays a USDT-only merchant by swapping its own ETH on **Uniswap v3** (Ethereum Sepolia). The merchant is the swap's recipient and receives *exactly* the USDT amount, in one transaction, approved by card and fingerprint.
**What we used:** `SwapRouter02.exactOutputSingle` (with native ETH and `refundETH`) and `QuoterV2.quoteExactOutputSingle`. Where it is in the code: the "Uniswap integration" section of [`README.md`](README.md).

## What worked well

- **Exact-output swaps fit our case perfectly.** A merchant asks for "0.10 USDT", not "whatever my ETH buys". `exactOutputSingle` with `amountInMaximum` gave us "the merchant gets exactly X, the customer pays at most Y" with no extra logic.
- **Real pools on Sepolia.** The v3 router, quoter, WETH and a WETH/USDT pool at all three fee tiers (0.05%, 0.3%, 1%) already exist there, so we could build and test against real Uniswap without deploying our own pools.
- **Forking Sepolia in Hardhat** let us test the wallet against the real router and pool (exact USDT out, ETH refund, replay, expiry, slippage reverts) instead of mocks.
- **Paying with native ETH** (send `msg.value` to the router, let it wrap, call `refundETH`) means the wallet never has to hold WETH or give an approval.

## Friction we ran into

1. **Testnet pool health varies a lot.** The Sepolia WETH/USDT pools exist at three tiers, but their prices are far from reality (0.1 USDT costs about 0.00000005 ETH, so ETH looks like it is worth about $2 million) and liquidity differs by orders of magnitude between tiers (the 0.3% pool is tiny; the 1% pool is much deeper). Picking the wrong tier gives either a failed quote or a bad price. We now ask the quoter for all three tiers and take the cheapest. A short list of testnet pools with their liquidity, or seeded pools with realistic prices, would help.
2. **`SwapRouter02` has no `deadline` in `ExactOutputSingleParams`.** The original `SwapRouter` does, and many examples are written for it. The two structs differ, which is easy to miss. Our wallet signs its own expiry into the payment hash instead.
3. **Exact-output with native ETH needs `refundETH`.** If you send `msg.value` equal to `amountInMaximum` and forget `refundETH()`, the unused ETH stays in the router. We only got this right by writing a test that checks the wallet keeps the unused ETH. An example of a smart-contract wallet doing this would have saved time.

## Suggestions

- A testnet page listing the pools that have real liquidity and a sane price.
- An example of a **smart-contract wallet paying in native ETH with an exact output**, including the `refundETH` step.
- A note on the `SwapRouter` vs `SwapRouter02` struct differences.

## What we did not try

- The Uniswap Trading API, Universal Router, Permit2, v4 and hooks. We called the v3 contracts directly because the swap has to execute inside our own smart-contract wallet after card and phone signatures are checked on-chain.

## Numbers

- A plain-script swap of 0.1 USDT used 161,147 gas.
- The same payment through our wallet's `payWithSwap`, including the on-chain card (RSA) and phone (P-256) signature checks, used about 394,000 gas on a Sepolia fork.
- 0.1 USDT cost about 0.00000005 ETH on the 1% pool.
- Evidence and links to the transactions are in the "Uniswap integration" section of [`README.md`](README.md).

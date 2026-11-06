// The frame-transaction payment path: wallets deployed one by one, payments sent through the alt mempool.
// Loaded only when PAYMENT_PATH=frame, so the Whitechain path never touches these ESM dependencies.
import { ethers } from "ethers";
import { encodeTx, frame, newTx, secp256k1Placeholder, signTx } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { toWire } from "@forshtat/hegota-support/rpc";

const profile = getProfile("ethrex-eip8141-tracer");

export const GAS_PRICE = 2_000_000_000n;
const DEPLOY_GAS = 16_000_000n; // just under the devnet's 16.7M transaction cap
const CALL_GAS = 1_500_000n; // freeze and unfreeze run the card and phone checks from an EOA
const CONSUME = new ethers.Interface(["function consume()"]).encodeFunctionData("consume");

// Everything before the SENDER frame, plus the 2,800 signature cost, must stay under the mempool's 100k cap.
export const FRAME_LIMITS = { walletVerify: 46_000n, preVerify: 34_000n, pay: 14_000n, sender: 900_000n };
// Each new storage slot costs 73,440 state gas. A wallet's first payment to a new merchant creates 5.
const SENDER_STATE_GAS = 450_000n;
const SENDER_FRAME = 3;

const POLL_MS = 2_000;
const MAX_POLLS = 60;
const FINISHED = new Set(["OnChain", "Finalized", "Reverted", "Cancelled"]);

export async function rpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${body.error.message}${body.error.data ? ` ${JSON.stringify(body.error.data)}` : ""}`);
  return body.result;
}

/** The four frames: wallet validation, quota deduction, paymaster approval, then pay() itself. */
export function paymentFrames({ paymaster, payCalldata, limits = FRAME_LIMITS }) {
  return [
    frame(profile, "VERIFY", { scope: "EXECUTION", target: null, execution: limits.walletVerify }),
    frame(profile, "DEFAULT", { target: paymaster, execution: limits.preVerify, data: CONSUME }),
    frame(profile, "VERIFY", { scope: "PAYMENT", target: paymaster, execution: limits.pay }),
    frame(profile, "SENDER", { target: null, execution: limits.sender, state: SENDER_STATE_GAS, data: payCalldata }),
  ];
}

/** Builds the transaction and signs it with the POS key, the single signature the wallet's validation accepts. */
export function signPaymentTx({ chainId, wallet, nonce, frames, posKey, maxFeePerGas = GAS_PRICE }) {
  const pos = new ethers.Wallet(posKey);
  const tx = newTx({ chainId, sender: wallet, nonceSeq: nonce, frames, signatures: [secp256k1Placeholder(profile, pos.address)], fees: { maxFeePerGas } });
  return signTx(profile, tx, posKey, 0);
}

export const rawFrameTx = (tx) => encodeTx(profile, tx);
export const submitToAltMempool = (mempoolUrl, tx) => rpc(mempoolUrl, "eth_sendFrameTransaction", [toWire(tx)]);

async function waitForStatus(mempoolUrl, hash) {
  for (let i = 0; i < MAX_POLLS; i++) {
    const { status } = await rpc(mempoolUrl, "skandha_frameTransactionStatus", [hash]);
    if (FINISHED.has(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`admitted but not mined after ${(MAX_POLLS * POLL_MS) / 1000}s, the devnet may be stalled: ${hash}`);
}

/** Waits for the transaction to finish and reads per-frame results from the node. */
export async function finish({ rpcUrl, mempoolUrl }, hash) {
  const status = await waitForStatus(mempoolUrl, hash);
  const receipt = await rpc(rpcUrl, "eth_getTransactionReceipt", [hash]);
  const frames = (receipt?.frameReceipts ?? []).map((f) => ({ status: Number(f.status), gasUsed: Number(f.gasUsed ?? 0) }));
  return { status, frames, paymentSucceeded: frames[SENDER_FRAME]?.status === 1 };
}

/**
 * Same shape as the direct path in server.js, so the HTTP API does not change.
 * @param {{ relayer: ethers.Signer, provider: ethers.Provider, walletArt: { abi: object[], bytecode: string },
 *   paymasterAbi: object[], deployment: { verifier: string, paymaster: string }, chainId: number,
 *   rpcUrl: string, mempoolUrl: string, explorerUrl?: string, posKey: string,
 *   limits: { perTx: bigint, daily: bigint },
 *   walletIndex: { get: (key: string) => string | undefined, set: (key: string, wallet: string) => void } }} ctx
 */
export function createFramePath(ctx) {
  const { relayer, provider, walletArt, paymasterAbi, deployment, chainId, rpcUrl, mempoolUrl, explorerUrl, posKey, limits, walletIndex } = ctx;
  const pos = new ethers.Wallet(posKey).address;
  const txOverrides = { type: 0, gasPrice: GAS_PRICE, gasLimit: CALL_GAS };
  const paymaster = new ethers.Contract(deployment.paymaster, paymasterAbi, relayer);
  const walletAt = (address) => new ethers.Contract(address, walletArt.abi, relayer);

  async function pay(p, phoneSig, { token, merchant, onAdmitted }) {
    const wallet = walletAt(p.wallet);
    const args = [token, merchant, p.value, p.expiry, p.cardSig, phoneSig];
    // A failure in the SENDER frame still costs quota, so refuse here anything that cannot succeed.
    await wallet.pay.staticCall(...args);
    const tx = await signPaymentTx({
      chainId, wallet: p.wallet, posKey,
      nonce: BigInt(await provider.getTransactionCount(p.wallet, "latest")),
      frames: paymentFrames({ paymaster: deployment.paymaster, payCalldata: wallet.interface.encodeFunctionData("pay", args) }),
    });
    const hash = await submitToAltMempool(mempoolUrl, tx);
    onAdmitted(hash);
    const { status, frames, paymentSucceeded } = await finish({ rpcUrl, mempoolUrl }, hash);
    if (!paymentSucceeded) throw new Error(`payment frame failed (${status}): ${hash}`);
    return { txHash: hash, gasUsed: frames.reduce((sum, f) => sum + f.gasUsed, 0).toString() };
  }

  return {
    txOverrides,
    findWallet: async (key) => walletIndex.get(key) ?? null,

    async createWallet({ key, cardModulus, cardExponent, phoneX, phoneY }) {
      const factory = new ethers.ContractFactory(walletArt.abi, walletArt.bytecode, relayer);
      const wallet = await factory.deploy(cardModulus, cardExponent, phoneX, phoneY, limits.perTx, limits.daily, deployment.verifier, deployment.paymaster, pos, { ...txOverrides, gasLimit: DEPLOY_GAS });
      await wallet.waitForDeployment();
      const address = await wallet.getAddress();
      await (await paymaster.enrol(address, txOverrides)).wait();
      walletIndex.set(key, address);
      return address;
    },

    pay,
    explorerLink: (hash) => (explorerUrl && hash ? `${explorerUrl}/tx/${hash}` : undefined),
  };
}

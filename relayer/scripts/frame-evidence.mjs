// Proves how the mempools treat our payment transaction, using a fake card and passkey on a fresh wallet. Each refusal
// only passes for its stated reason, so an unrelated rule cannot hide a failure. Run with the frame env file:
//   node --env-file=.env.frames.local scripts/frame-evidence.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { frame } from "@forshtat/hegota-support/tx";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { finish, FRAME_LIMITS, GAS_PRICE, paymentFrames, rawFrameTx, rpc, signPaymentTx, submitToAltMempool } from "../frames.mjs";

const require = createRequire(import.meta.url);
const { makeCard, makePasskey } = require("../../contracts/test/helpers");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, "..", "..", "contracts", "artifacts", "contracts");
const load = (file, name) => JSON.parse(fs.readFileSync(path.join(ARTIFACTS, file, `${name}.json`)));

const { RPC_URL, MEMPOOL_URL, EXPLORER_URL, RELAYER_KEY, POS_KEY, FRAME_DEPLOYMENT } = process.env;
if (!RPC_URL || !MEMPOOL_URL || !RELAYER_KEY || !POS_KEY || !FRAME_DEPLOYMENT) throw new Error("run with --env-file=.env.frames.<devnet>");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const PER_TX = USDC(50), DAILY = USDC(80), GIFT = USDC(1000), TTL = 300;
const CALL = { type: 0, gasPrice: GAS_PRICE, gasLimit: 1_500_000n };
const DEPLOY = { ...CALL, gasLimit: 16_000_000n };
const selector = (error) => ethers.id(error).slice(0, 10);

const deployment = JSON.parse(fs.readFileSync(FRAME_DEPLOYMENT));
const provider = new ethers.JsonRpcProvider(RPC_URL);
const relayer = new ethers.NonceManager(new ethers.Wallet(RELAYER_KEY, provider));
const merchant = ethers.Wallet.createRandom().address;
const walletArt = load("frames/Tap2EthFrameWallet.sol", "Tap2EthFrameWallet");
const paymasterArt = load("frames/QuotaPaymaster.sol", "QuotaPaymaster");
const token = new ethers.Contract(deployment.token, load("TestUSDC.sol", "TestUSDC").abi, relayer);
const paymaster = new ethers.Contract(deployment.paymaster, paymasterArt.abi, relayer);
const unstaked = new ethers.Contract(deployment.unstakedPaymaster, paymasterArt.abi, relayer);
const card = makeCard();
const phone = makePasskey();
const pos = new ethers.Wallet(POS_KEY).address;

const rows = [];
function record(scenario, pass, detail) {
  rows.push({ scenario, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${scenario}\n      ${String(detail).slice(0, 170)}`);
}

async function createWallet() {
  const factory = new ethers.ContractFactory(walletArt.abi, walletArt.bytecode, relayer);
  const wallet = await factory.deploy(card.modulus, card.exponent, phone.x, phone.y, PER_TX, DAILY, deployment.verifier, deployment.paymaster, pos, DEPLOY);
  await wallet.waitForDeployment();
  const address = await wallet.getAddress();
  const gas = (await wallet.deploymentTransaction().wait()).gasUsed;
  console.log(`wallet ${address}, deployed for ${gas} gas`);
  await (await paymaster.enrol(address, CALL)).wait();
  await (await unstaked.enrol(address, CALL)).wait();
  await (await token.faucet(address, GIFT, CALL)).wait();
  return wallet;
}

const now = async () => Math.max((await provider.getBlock("latest")).timestamp, Math.floor(Date.now() / 1000));

/** Options change one thing about an otherwise valid payment. */
async function payment(wallet, amount, opts = {}) {
  const address = await wallet.getAddress();
  const expiry = opts.expiry ?? (await now()) + TTL;
  const h = await wallet.paymentHash(deployment.token, merchant, amount, await wallet.nonce(), expiry);
  const cardSig = (opts.card ?? card).sign(Buffer.from(h.slice(2, 10), "hex"));
  const phoneSig = (opts.phone ?? phone).sign(h);
  const payCalldata = opts.calldata ?? wallet.interface.encodeFunctionData("pay", [deployment.token, merchant, amount, expiry, cardSig, phoneSig]);
  const frames = paymentFrames({ paymaster: opts.paymaster ?? deployment.paymaster, payCalldata });
  return signPaymentTx({
    chainId: deployment.chainId, wallet: address, posKey: opts.posKey ?? POS_KEY,
    nonce: BigInt(await provider.getTransactionCount(address, "latest")),
    frames: opts.tamperFrames ? opts.tamperFrames(frames) : frames,
  });
}

async function refused(scenario, reason, tx, send = () => submitToAltMempool(MEMPOOL_URL, tx)) {
  try {
    record(scenario, false, `admitted ${await send()}`);
  } catch (e) {
    record(scenario, e.message.toLowerCase().includes(reason.toLowerCase()), e.message);
  }
}

async function paid(scenario, tx, amount) {
  const before = await token.balanceOf(merchant);
  const hash = await submitToAltMempool(MEMPOOL_URL, tx);
  const { status, frames } = await finish({ rpcUrl: RPC_URL, mempoolUrl: MEMPOOL_URL }, hash);
  const moved = (await token.balanceOf(merchant)) - before;
  const prefix = frames.slice(0, 3).reduce((sum, f) => sum + f.gasUsed, 0);
  const link = EXPLORER_URL ? `${EXPLORER_URL}/tx/${hash}` : hash;
  record(scenario, moved === amount && frames.every((f) => f.status === 1), `${status}, frame gas ${frames.map((f) => f.gasUsed).join(" / ")}, validation ${prefix}, ${link}`);
  return { hash, frames, prefix };
}

async function failsInPaymentFrame(wallet, scenario, tx) {
  const address = await wallet.getAddress();
  const before = await token.balanceOf(merchant);
  const quotaBefore = (await paymaster.quotas(address))[0];
  try {
    const hash = await submitToAltMempool(MEMPOOL_URL, tx);
    const { frames } = await finish({ rpcUrl: RPC_URL, mempoolUrl: MEMPOOL_URL }, hash);
    const moved = (await token.balanceOf(merchant)) - before;
    const charged = quotaBefore - (await paymaster.quotas(address))[0];
    record(scenario, frames[3]?.status === 0 && moved === 0n && charged > 0n, `frames ${frames.map((f) => f.status)}, moved ${moved}, quota charged ${charged} wei`);
  } catch (e) {
    record(scenario, false, `refused: ${e.message}`);
  }
}

async function main() {
  const wallet = await createWallet();

  console.log("\n-- why this needs the alt mempool");
  const canonicalTx = await payment(wallet, USDC(5));
  const sim = await rpc(RPC_URL, "ethrex_simulateFrameTransaction", [rawFrameTx(canonicalTx)]);
  record("Canonical mempool rules refuse it (node simulation)", sim.canonicalMempoolValid === false, sim.canonicalMempoolViolation);
  await refused("Canonical mempool refuses it (real submission)", "", canonicalTx, () => rpc(RPC_URL, "eth_sendRawTransaction", [rawFrameTx(canonicalTx)]));
  await refused("Unstaked paymaster refused", "unstaked payer", await payment(wallet, USDC(5), { paymaster: deployment.unstakedPaymaster }));
  const first = await paid("Staked paymaster admitted and paid", await payment(wallet, USDC(5)), USDC(5));
  record("Validation stays under the 100k cap", first.prefix + 2_800 < 100_000, `${first.prefix} + 2800 signature gas`);

  console.log("\n-- refused at admission, costing nothing");
  await refused("Over the per-payment limit", selector("OverLimit()"), await payment(wallet, USDC(51)));
  await refused("Unknown POS key", selector("UnknownPos()"), await payment(wallet, USDC(5), { posKey: ethers.Wallet.createRandom().privateKey }));
  const drain = frame(getProfile("ethrex-eip8141-tracer"), "SENDER", { target: deployment.token, execution: 100_000n, data: token.interface.encodeFunctionData("transfer", [merchant, USDC(500)]) });
  await refused("Extra SENDER frame tries to drain", selector("BadFrames()"), await payment(wallet, USDC(5), { tamperFrames: (f) => [...f.slice(0, 3), drain, f[3]] }));
  const freezeExpiry = (await now()) + TTL;
  await (await wallet.freeze(freezeExpiry, phone.sign(await wallet.actionHash("freeze", "0x", await wallet.nonce(), freezeExpiry)), CALL)).wait();
  await refused("Frozen wallet", selector("IsFrozen()"), await payment(wallet, USDC(5)));
  const unfreezeExpiry = (await now()) + TTL;
  const unfreezeHash = await wallet.actionHash("unfreeze", "0x", await wallet.nonce(), unfreezeExpiry);
  await (await wallet.unfreeze(unfreezeExpiry, card.sign(Buffer.from(unfreezeHash.slice(2, 10), "hex")), phone.sign(unfreezeHash), CALL)).wait();

  console.log("\n-- mined, no funds move, charged to this wallet's quota");
  await failsInPaymentFrame(wallet, "Forged card signature", await payment(wallet, USDC(5), { card: makeCard() }));
  await failsInPaymentFrame(wallet, "Forged phone signature", await payment(wallet, USDC(5), { phone: makePasskey() }));
  await failsInPaymentFrame(wallet, "Expired payment", await payment(wallet, USDC(5), { expiry: (await now()) - 1 }));
  const replay = await payment(wallet, USDC(5));
  await paid("Payment before the replay", replay, USDC(5));
  const replayData = replay.frames.at(-1).data;
  await failsInPaymentFrame(wallet, "Replay of old card and phone signatures", await payment(wallet, USDC(5), { calldata: replayData }));
  await paid("Spend up to the daily limit", await payment(wallet, USDC(50)), USDC(50));
  await failsInPaymentFrame(wallet, "Over the daily limit", await payment(wallet, USDC(25)));

  const failed = rows.filter((r) => !r.pass).length;
  console.log(`\n${rows.length - failed} of ${rows.length} passed`);
  fs.writeFileSync(path.join(HERE, "..", "..", "docs", `frame-evidence-${deployment.chainId}-${new URL(RPC_URL).hostname}.json`), JSON.stringify({ wallet: await wallet.getAddress(), rows }, null, 2) + "\n");
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`evidence run aborted: ${e.shortMessage || e.message}`);
  process.exit(1);
});

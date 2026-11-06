// Prepares a frame devnet for the relayer: funds an account, deploys the shared contracts, stakes the paymaster, and
// writes .env.frames.<devnet>. Safe to rerun: keys are kept, and contracts are redeployed only if the chain lost them.
//   DEVNET=local  node scripts/deploy-frames.mjs     (needs STAKING_REGISTRY from poc/infra/bootstrap.sh)
//   DEVNET=public node scripts/deploy-frames.mjs     (funds from the faucet: 1 ETH per address per hour)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { GAS_PRICE, rpc } from "../frames.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ARTIFACTS = path.join(ROOT, "..", "contracts", "artifacts", "contracts");
const GATEWAY = "https://altmempoolgateway.forshtat.com/rpc";

// This key is published in the genesis config. It is used on our own local chain only, never on the public devnet.
const LOCAL_FUNDER = "0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15";

const DEVNETS = {
  local: { rpcUrl: "http://127.0.0.1:8545", mempoolUrl: "http://127.0.0.1:14337/rpc", explorerUrl: "", registry: process.env.STAKING_REGISTRY },
  public: { rpcUrl: GATEWAY, mempoolUrl: GATEWAY, explorerUrl: "https://explorer.altmempool.wtf", registry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f" },
};

const DEPLOY = { type: 0, gasPrice: GAS_PRICE, gasLimit: 16_000_000n };
const CALL = { type: 0, gasPrice: GAS_PRICE, gasLimit: 500_000n };
const TRANSFER = { type: 0, gasPrice: GAS_PRICE, gasLimit: 250_000n }; // a transfer to a new account costs state gas
const STAKE = ethers.parseEther("0.012");
const UNSTAKE_DELAY = 86_400;
const PAYMASTER_FUNDS = ethers.parseEther("0.3");
const UNSTAKED_PAYMASTER_FUNDS = ethers.parseEther("0.05");
const DAILY_QUOTA = ethers.parseEther("0.1"); // about 38 payments a day per wallet at the current fee cap
const DAILY_BUDGET = ethers.parseEther("0.25");
const MIN_RELAYER_BALANCE = ethers.parseEther("0.5");

const load = (file, name) => JSON.parse(fs.readFileSync(path.join(ARTIFACTS, file, `${name}.json`)));
const readEnv = (file) => (fs.existsSync(file) ? Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))) : {});

async function fund(provider, address, name) {
  const balance = await provider.getBalance(address);
  if (balance >= MIN_RELAYER_BALANCE) return;
  if (name === "local") {
    const funder = new ethers.Wallet(LOCAL_FUNDER, provider);
    await (await funder.sendTransaction({ to: address, value: ethers.parseEther("20"), ...TRANSFER })).wait();
    return;
  }
  const { txHash } = await rpc(GATEWAY, "skandha_explorer_faucet", [address]);
  await provider.waitForTransaction(txHash, 1, 120_000);
}

async function deployed(provider, address) {
  return Boolean(address) && (await provider.getCode(address)) !== "0x";
}

async function main() {
  const name = process.env.DEVNET;
  const net = DEVNETS[name];
  if (!net) throw new Error("set DEVNET to local or public");
  if (!net.registry) throw new Error("set STAKING_REGISTRY to the registry address printed by poc/infra/bootstrap.sh");

  const envFile = path.join(ROOT, `.env.frames.${name}`);
  const deploymentFile = path.join(ROOT, "..", "contracts", "deployments", `frames-${name}.json`);
  const previous = readEnv(envFile);
  const relayerKey = previous.RELAYER_KEY ?? ethers.Wallet.createRandom().privateKey;
  const posKey = previous.POS_KEY ?? ethers.Wallet.createRandom().privateKey;
  fs.writeFileSync(envFile, Object.entries({
    PAYMENT_PATH: "frame", RPC_URL: net.rpcUrl, MEMPOOL_URL: net.mempoolUrl, EXPLORER_URL: net.explorerUrl,
    RELAYER_KEY: relayerKey, POS_KEY: posKey,
    STATE_FILE: path.join(ROOT, `state.frames.${name}.json`), FRAME_DEPLOYMENT: deploymentFile,
  }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });

  const provider = new ethers.JsonRpcProvider(net.rpcUrl);
  const relayer = new ethers.NonceManager(new ethers.Wallet(relayerKey, provider));
  const address = await relayer.getAddress();
  console.log(`relayer ${address}`);
  await fund(provider, address, name);

  const previousDeployment = fs.existsSync(deploymentFile) ? JSON.parse(fs.readFileSync(deploymentFile)) : {};
  const artifact = {
    verifier: load("frames/Tap2EthVerifier.sol", "Tap2EthVerifier"),
    token: load("TestUSDC.sol", "TestUSDC"),
    paymaster: load("frames/QuotaPaymaster.sol", "QuotaPaymaster"),
  };

  async function ensure(key, art, args, overrides) {
    if (await deployed(provider, previousDeployment[key])) return previousDeployment[key];
    const contract = await new ethers.ContractFactory(art.abi, art.bytecode, relayer).deploy(...args, overrides);
    await contract.waitForDeployment();
    const at = await contract.getAddress();
    console.log(`${key} ${at}`);
    return at;
  }

  const result = { chainId: Number((await provider.getNetwork()).chainId), registry: net.registry };
  result.verifier = await ensure("verifier", artifact.verifier, [], DEPLOY);
  result.token = await ensure("token", artifact.token, [], DEPLOY);
  const paymasterArgs = [DAILY_QUOTA, DAILY_BUDGET];
  result.paymaster = await ensure("paymaster", artifact.paymaster, paymasterArgs, { ...DEPLOY, value: PAYMASTER_FUNDS });
  result.unstakedPaymaster = await ensure("unstakedPaymaster", artifact.paymaster, paymasterArgs, { ...DEPLOY, value: UNSTAKED_PAYMASTER_FUNDS });

  if (result.paymaster !== previousDeployment.paymaster) {
    const paymaster = new ethers.Contract(result.paymaster, artifact.paymaster.abi, relayer);
    await (await paymaster.stake(net.registry, UNSTAKE_DELAY, STAKE, CALL)).wait();
    console.log("paymaster staked");
  }
  fs.writeFileSync(deploymentFile, JSON.stringify(result, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), deploymentFile)} and ${path.relative(process.cwd(), envFile)}`);
}

main().catch((e) => {
  console.error(`deploy failed: ${e.shortMessage || e.message}`);
  process.exit(1);
});

// Deploys Tap2Eth, the single v2 contract (registry + wallet logic; every wallet is a clone of it).
// Usage: npx hardhat run scripts/deployOne.js --network arcTestnet
// Saves it as `factoryV2` in deployments/<chainId>.json, so the relayer and the terminal find it like before,
// and as `tap2eth`. A previous v2 entry is kept in `v2History`.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  console.log(`network ${network.name} (chain ${chainId})  deployer ${deployer.address}`);
  const c = await (await ethers.getContractFactory("Tap2Eth")).deploy();
  const rc = await c.deploymentTransaction().wait();
  const addr = await c.getAddress();
  console.log(`Tap2Eth ${addr}\n  tx ${rc.hash}  gas ${rc.gasUsed}`);

  const file = path.join(__dirname, "..", "deployments", `${chainId}.json`);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  const history = prev.v2History || [];
  if (prev.factoryV2) history.push({ factoryV2: prev.factoryV2, walletImplementationV2: prev.walletImplementationV2, factoryV2Tx: prev.factoryV2Tx, deployedAt: prev.v2DeployedAt });
  const { walletImplementationV2, ...rest } = prev;
  fs.writeFileSync(file, JSON.stringify({ ...rest, factoryV2: addr, tap2eth: addr, factoryV2Tx: rc.hash, v2DeployedAt: new Date().toISOString(), v2History: history }, null, 2) + "\n");
  console.log(`saved ${path.relative(process.cwd(), file)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

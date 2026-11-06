// Deploys the Tap2ETH v2 factory (it deploys the wallet implementation in its constructor).
// Usage: npx hardhat run scripts/deployV2.js --network whitechainSepolia
// Adds factoryV2 / walletImplementationV2 to deployments/<chainId>.json (v1 entries are kept).
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  console.log(`network ${network.name} (chain ${chainId})  deployer ${deployer.address}`);
  console.log(`balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);

  const factory = await (await ethers.getContractFactory("Tap2EthFactoryV2")).deploy();
  const rc = await factory.deploymentTransaction().wait();
  const factoryAddr = await factory.getAddress();
  const implAddr = await factory.implementation();
  console.log(`Tap2EthFactoryV2   ${factoryAddr}\n  tx ${rc.hash}  gas ${rc.gasUsed}`);
  console.log(`Tap2EthWalletV2 (implementation) ${implAddr}`);

  const file = path.join(__dirname, "..", "deployments", `${chainId}.json`);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  // Keep the previous v2 deployment in a history list instead of overwriting it.
  const history = prev.v2History || [];
  if (prev.factoryV2) history.push({ factoryV2: prev.factoryV2, walletImplementationV2: prev.walletImplementationV2, factoryV2Tx: prev.factoryV2Tx, deployedAt: prev.v2DeployedAt });
  fs.writeFileSync(
    file,
    JSON.stringify({ ...prev, factoryV2: factoryAddr, walletImplementationV2: implAddr, factoryV2Tx: rc.hash, v2DeployedAt: new Date().toISOString(), v2History: history }, null, 2) + "\n",
  );
  console.log(`saved ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

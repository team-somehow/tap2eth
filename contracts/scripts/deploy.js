// Deploys the Tap2ETH factory. Wallets are created per card by the factory.
// Usage: npx hardhat run scripts/deploy.js --network whitechainSepolia
// Writes the address to deployments/<chainId>.json so the relayer and README can use it.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`network ${network.name} (chain ${chainId})`);
  console.log(`deployer ${deployer.address}  balance ${ethers.formatEther(balance)}`);

  const factory = await (await ethers.getContractFactory("Tap2EthFactory")).deploy();
  const receipt = await factory.deploymentTransaction().wait();
  const address = await factory.getAddress();
  console.log(`Tap2EthFactory ${address}`);
  console.log(`  tx ${receipt.hash}  gas ${receipt.gasUsed}  block ${receipt.blockNumber}`);

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${chainId}.json`);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  fs.writeFileSync(
    file,
    JSON.stringify({ ...prev, chainId, deployer: deployer.address, factory: address, factoryTx: receipt.hash, deployedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log(`saved ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

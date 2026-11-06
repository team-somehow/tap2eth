// Deploys the Tap2ETH swap factory (wallets that pay merchants in USDT by swapping their ETH on Uniswap v3).
// Usage: npx hardhat run scripts/deploySwap.js --network sepolia
// Saves to deployments/11155111.json.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

// Uniswap v3 on Ethereum Sepolia: https://docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments
const UNISWAP = {
  11155111: {
    router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E", // SwapRouter02
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    usdt: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0",
  },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const u = UNISWAP[chainId];
  if (!u) throw new Error(`No Uniswap addresses for chain ${chainId}`);
  console.log(`network ${network.name} (chain ${chainId})  deployer ${deployer.address}`);

  const factory = await (await ethers.getContractFactory("Tap2EthFactorySwap")).deploy(u.router, u.weth, u.usdt, {
    gasLimit: 42_000_000,
    // Sepolia gas is nearly free; a low cap keeps the balance check (gasLimit x maxFee) small.
    maxFeePerGas: ethers.parseUnits("0.1", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("0.01", "gwei"),
  });
  const rc = await factory.deploymentTransaction().wait();
  const factoryAddr = await factory.getAddress();
  // A load-balanced public RPC can answer from a node that has not seen the new block yet: retry the read.
  let implAddr;
  for (let i = 0; i < 10 && !implAddr; i++) {
    try { implAddr = await factory.implementation(); } catch { await new Promise((r) => setTimeout(r, 3000)); }
  }
  if (!implAddr) throw new Error(`Deployed ${factoryAddr} (tx ${rc.hash}) but could not read it back yet. Check the explorer.`);
  console.log(`Tap2EthFactorySwap ${factoryAddr}\n  tx ${rc.hash}  gas ${rc.gasUsed}`);
  console.log(`Tap2EthWalletSwap (implementation) ${implAddr}`);

  const file = path.join(__dirname, "..", "deployments", `${chainId}.json`);
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  fs.writeFileSync(file, JSON.stringify({ ...prev, chainId, deployer: deployer.address, factorySwap: factoryAddr, walletImplementationSwap: implAddr, factorySwapTx: rc.hash, uniswap: u, swapDeployedAt: new Date().toISOString() }, null, 2) + "\n");
  console.log(`saved ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

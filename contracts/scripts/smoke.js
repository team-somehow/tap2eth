// Live smoke test on a real network: creates a wallet for a THROWAWAY fake card + fake passkey,
// then checks the on-chain card (RSA + SHA-1) and phone (WebAuthn P-256) verification and prints their gas.
// Usage: npx hardhat run scripts/smoke.js --network whitechainSepolia
// Needs contracts/deployments/<chainId>.json from scripts/deploy.js.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { makeCard, makePasskey } = require("../test/helpers");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${chainId}.json`)));
  const factory = await ethers.getContractAt("Tap2EthFactory", dep.factory);

  const card = makeCard();
  const phone = makePasskey();
  const tx = await factory.createWallet(card.modulus, card.exponent, phone.x, phone.y, 50_000_000n, 200_000_000n);
  const rc = await tx.wait();
  const walletAddr = await factory.walletOf(ethers.keccak256(card.modulus));
  console.log(`createWallet  gas ${rc.gasUsed}  wallet ${walletAddr}  tx ${rc.hash}`);

  const wallet = await ethers.getContractAt("Tap2EthWallet", walletAddr);

  const ch = crypto.randomBytes(4);
  const sig = card.sign(ch);
  console.log("verifyCard(valid)    :", await wallet.verifyCard(ch, sig), " gas", (await wallet.verifyCard.estimateGas(ch, sig)).toString());
  console.log("verifyCard(wrong ch) :", await wallet.verifyCard(crypto.randomBytes(4), sig));

  const exp = (await ethers.provider.getBlock("latest")).timestamp + 300;
  const h = await wallet.paymentHash(ethers.ZeroAddress, ethers.ZeroAddress, 1n, 0n, exp);
  const ps = phone.sign(h);
  console.log("verifyPhone(valid)   :", await wallet.verifyPhone(h, ps), " gas", (await wallet.verifyPhone.estimateGas(h, ps)).toString());
  console.log("verifyPhone(wrong h) :", await wallet.verifyPhone(ethers.keccak256("0x01"), ps));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

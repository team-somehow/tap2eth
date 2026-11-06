// PoC: pay a merchant an exact amount of USDT by swapping the payer's ETH on Uniswap v3 (Sepolia).
// Usage: PRIVATE_KEY=0x.. node swap.mjs <merchantAddress> <usdtAmount> [--dry]
import { ethers } from "../relayer/node_modules/ethers/lib.esm/index.js";

const RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const A = { // Uniswap v3 deployments on Sepolia (https://docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments)
  router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E", // SwapRouter02
  quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3", // QuoterV2
  weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  usdt: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0",
};
const FEES = [500, 3000, 10000];
const SLIPPAGE_BPS = 100n; // pay at most 1% above the quote

const [merchant, amountStr] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dry = process.argv.includes("--dry");
if (!ethers.isAddress(merchant) || !amountStr) { console.error("usage: node swap.mjs <merchant> <usdtAmount> [--dry]"); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const wallet = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY, provider) : null;
const usdt = new ethers.Contract(A.usdt, ["function balanceOf(address) view returns(uint256)"], provider);
const quoter = new ethers.Contract(A.quoter, ["function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256 amountIn,uint160,uint32,uint256)"], provider);
const routerIface = new ethers.Interface([
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns(uint256)",
  "function refundETH() payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns(bytes[])",
]);

const out = ethers.parseUnits(amountStr, 6);

// 1. Quote every fee tier, take the cheapest for the payer.
let best;
for (const fee of FEES) {
  try {
    const [amountIn] = await quoter.quoteExactOutputSingle.staticCall({ tokenIn: A.weth, tokenOut: A.usdt, amount: out, fee, sqrtPriceLimitX96: 0 });
    console.log(`fee ${fee / 10000}%  ->  ${ethers.formatEther(amountIn)} ETH`);
    if (!best || amountIn < best.amountIn) best = { fee, amountIn };
  } catch { console.log(`fee ${fee / 10000}%  ->  no route`); }
}
if (!best) { console.error("No pool can fill this amount."); process.exit(1); }
const maxIn = best.amountIn + (best.amountIn * SLIPPAGE_BPS) / 10000n;
console.log(`best: ${best.fee / 10000}% pool. Payer sends at most ${ethers.formatEther(maxIn)} ETH, merchant gets exactly ${amountStr} USDT`);

// 2. Build: exactOutputSingle (ETH wrapped by the router) + refundETH (unused ETH comes back), in one multicall.
const data = routerIface.encodeFunctionData("multicall", [Math.floor(Date.now() / 1000) + 300, [
  routerIface.encodeFunctionData("exactOutputSingle", [{ tokenIn: A.weth, tokenOut: A.usdt, fee: best.fee, recipient: merchant, amountOut: out, amountInMaximum: maxIn, sqrtPriceLimitX96: 0 }]),
  routerIface.encodeFunctionData("refundETH", []),
]]);

if (!wallet) { console.log("No PRIVATE_KEY set: quote only."); process.exit(0); }
console.log("payer", wallet.address, "balance", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH");
const tx = { to: A.router, data, value: maxIn };
if (dry) { // simulate without sending
  const gas = await provider.estimateGas({ ...tx, from: wallet.address });
  console.log("dry run OK, gas", gas.toString());
  process.exit(0);
}
const before = await usdt.balanceOf(merchant);
const sent = await wallet.sendTransaction(tx);
console.log("tx", sent.hash);
const rc = await sent.wait();
console.log("status", rc.status, "gas", rc.gasUsed.toString());
console.log("merchant USDT +", ethers.formatUnits((await usdt.balanceOf(merchant)) - before, 6));
console.log(`https://sepolia.etherscan.io/tx/${sent.hash}`);

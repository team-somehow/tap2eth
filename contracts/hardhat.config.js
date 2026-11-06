require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the solc-js compiler from node_modules (no 77 MB native download on slow hackathon Wi-Fi).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.28") {
    return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: "0.8.28", longVersion: "0.8.28+commit.7893614a" };
  }
  return runSuper();
});

// Load the relayer's testnet key (git-ignored) so deploys use the same account that pays gas.
try {
  process.loadEnvFile(require("path").join(__dirname, "..", "relayer", ".env"));
} catch {}

const BASE_SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" };
const FRAME_SOURCES = [
  "contracts/frames/Tap2EthVerifier.sol",
  "contracts/frames/Tap2EthFrameWallet.sol",
  "contracts/frames/QuotaPaymaster.sol",
  "@forshtat/hegota-support/contracts/HegotaSupport.sol",
];

module.exports = {
  solidity: {
    compilers: [{ version: "0.8.28", settings: BASE_SETTINGS }],
    // Only the frame contracts need the IR pipeline, so the deployed Whitechain contracts compile exactly as before.
    overrides: Object.fromEntries(
      FRAME_SOURCES.map((source) => [source, { version: "0.8.28", settings: { ...BASE_SETTINGS, viaIR: true } }]),
    ),
  },
  // Contract source verification on the Whitechain Blockscout explorer (the API key can be any non-empty string).
  etherscan: {
    apiKey: { whitechainSepolia: "blockscout", arcTestnet: "blockscout" },
    customChains: [
      {
        network: "whitechainSepolia",
        chainId: 1874,
        urls: {
          apiURL: "https://explorer.testnet.whitechain.io/api",
          browserURL: "https://explorer.testnet.whitechain.io",
        },
      },
      {
        network: "arcTestnet",
        chainId: 5042002,
        urls: { apiURL: "https://explorer.testnet.arc.io/api", browserURL: "https://explorer.testnet.arc.io" },
      },
    ],
  },
  sourcify: { enabled: false },
  networks: {
    // The frame verifier uses the P-256 precompile only, which frame devnets have and Hardhat enables with this flag.
    hardhat: { enableRip7212: true },
    localhost: { url: "http://127.0.0.1:8545" },
    // Whitechain Sepolia (chain ID 1874), the network for the sponsor track.
    whitechainSepolia: {
      url: process.env.RPC_URL || "https://rpc.ankr.com/whitechain_testnet",
      chainId: 1874,
      accounts: process.env.RELAYER_KEY ? [process.env.RELAYER_KEY] : [],
    },
    // Arc testnet (chain ID 5042002). USDC is the gas token, so the relayer pays fees in USDC.
    arcTestnet: {
      url: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
      chainId: 5042002,
      accounts: process.env.ARC_RELAYER_KEY ? [process.env.ARC_RELAYER_KEY] : [],
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
};

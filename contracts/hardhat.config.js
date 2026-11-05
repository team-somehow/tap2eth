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

module.exports = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" } },
  // Contract source verification on the Whitechain Blockscout explorer (the API key can be any non-empty string).
  etherscan: {
    apiKey: { whitechainSepolia: "blockscout" },
    customChains: [
      {
        network: "whitechainSepolia",
        chainId: 1874,
        urls: {
          apiURL: "https://explorer.testnet.whitechain.io/api",
          browserURL: "https://explorer.testnet.whitechain.io",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    // Whitechain Sepolia (chain ID 1874), the network for the sponsor track.
    whitechainSepolia: {
      url: process.env.RPC_URL || "https://rpc.ankr.com/whitechain_testnet",
      chainId: 1874,
      accounts: process.env.RELAYER_KEY ? [process.env.RELAYER_KEY] : [],
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
};

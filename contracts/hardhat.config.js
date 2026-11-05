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

module.exports = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" } },
  networks: {
    localhost: { url: "http://127.0.0.1:8545" },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
};

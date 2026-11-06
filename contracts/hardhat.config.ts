import "dotenv/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
      production: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    },
  },
  networks: {
    hardhatSepolia: { type: "edr-simulated", chainType: "l1", chainId: 11155111 },
    hardhatBase: { type: "edr-simulated", chainType: "op", chainId: 84532 },
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: configVariable("ETHEREUM_SEPOLIA_RPC_URL"),
      accounts: [configVariable("ETHEREUM_SEPOLIA_PRIVATE_KEY")],
    },
    baseSepolia: {
      type: "http",
      chainType: "op",
      chainId: 84532,
      url: configVariable("BASE_SEPOLIA_RPC_URL"),
      accounts: [configVariable("BASE_SEPOLIA_PRIVATE_KEY")],
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
});

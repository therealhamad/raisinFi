import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { network } from "hardhat";
import { MockERC20__factory } from "../types/ethers-contracts/index.js";

const name = process.env.TEST_TOKEN_NAME;
const symbol = process.env.TEST_TOKEN_SYMBOL;
const supply = process.env.TEST_TOKEN_INITIAL_SUPPLY;
if (!name || !symbol || !supply) {
  throw new Error("Set TEST_TOKEN_NAME, TEST_TOKEN_SYMBOL, and TEST_TOKEN_INITIAL_SUPPLY");
}
if (!/^[1-9][0-9]*$/.test(supply)) {
  throw new Error("TEST_TOKEN_INITIAL_SUPPLY must be a positive integer in base units");
}

const { ethers } = await network.create();
const [deployer] = await ethers.getSigners();
if (!deployer) throw new Error("No deployment signer is configured for this network");

const token = await new MockERC20__factory(deployer).deploy(
  name,
  symbol,
  deployer.address,
  BigInt(supply),
);
const receipt = await token.deploymentTransaction()?.wait();
if (!receipt) throw new Error("Test token deployment did not return a transaction receipt");

const chainId = Number((await ethers.provider.getNetwork()).chainId);
const deployment = {
  contractName: "MockERC20",
  name,
  symbol,
  chainId,
  address: await token.getAddress(),
  initialRecipient: deployer.address,
  initialSupply: supply,
  transactionHash: receipt.hash,
  blockNumber: receipt.blockNumber,
};
const outputDirectory = resolve("deployments");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, `${symbol.toLowerCase()}-${chainId}.json`),
  `${JSON.stringify(deployment, null, 2)}\n`,
);
console.log(JSON.stringify(deployment, null, 2));

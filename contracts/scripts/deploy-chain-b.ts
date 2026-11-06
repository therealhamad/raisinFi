import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { network } from "hardhat";
import { AssetSettlement__factory } from "../types/ethers-contracts/index.js";

const forwarder = process.env.CRE_BASE_FORWARDER_ADDRESS;
const paymentContract = process.env.PAYMENT_CONTRACT_ADDRESS;
if (!forwarder) throw new Error("CRE_BASE_FORWARDER_ADDRESS is required");
if (!paymentContract) throw new Error("PAYMENT_CONTRACT_ADDRESS is required");

const { ethers } = await network.create();
for (const [name, address] of [
  ["CRE_BASE_FORWARDER_ADDRESS", forwarder],
  ["PAYMENT_CONTRACT_ADDRESS", paymentContract],
]) {
  if (!ethers.isAddress(address) || address === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero EVM address`);
  }
}

const [deployer] = await ethers.getSigners();
if (!deployer) throw new Error("No deployment signer is configured for this network");

const contract = await new AssetSettlement__factory(deployer).deploy(
  forwarder,
  11155111n,
  paymentContract,
);
const receipt = await contract.deploymentTransaction()?.wait();
if (!receipt) throw new Error("Chain B deployment did not return a transaction receipt");

const chainId = Number((await ethers.provider.getNetwork()).chainId);
if (chainId !== 84532) throw new Error(`Expected Base Sepolia (84532), got ${chainId}`);

const deployment = {
  contractName: "AssetSettlement",
  chainId,
  address: await contract.getAddress(),
  trustedForwarder: forwarder,
  paymentChainId: 11155111,
  paymentContract,
  deployer: deployer.address,
  transactionHash: receipt.hash,
  blockNumber: receipt.blockNumber,
};
const outputDirectory = resolve("deployments");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, `asset-settlement-${chainId}.json`),
  `${JSON.stringify(deployment, null, 2)}\n`,
);
console.log(JSON.stringify(deployment, null, 2));

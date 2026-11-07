import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { network } from "hardhat";
import { DecisionPaymentSettlement__factory } from "../types/ethers-contracts/index.js";

const forwarder = process.env.CRE_ETHEREUM_FORWARDER_ADDRESS;
if (!forwarder) throw new Error("CRE_ETHEREUM_FORWARDER_ADDRESS is required");

const { ethers } = await network.create();
if (!ethers.isAddress(forwarder) || forwarder === ethers.ZeroAddress) {
  throw new Error("CRE_ETHEREUM_FORWARDER_ADDRESS must be a non-zero EVM address");
}

const chainId = Number((await ethers.provider.getNetwork()).chainId);
if (chainId !== 11155111) throw new Error(`Expected Ethereum Sepolia (11155111), got ${chainId}`);

const [deployer] = await ethers.getSigners();
if (!deployer) throw new Error("No deployment signer is configured for this network");

const contract = await new DecisionPaymentSettlement__factory(deployer).deploy(forwarder);
const receipt = await contract.deploymentTransaction()?.wait();
if (!receipt) throw new Error("Chain A deployment did not return a transaction receipt");

const deployment = {
  contractName: "DecisionPaymentSettlement",
  chainId,
  address: await contract.getAddress(),
  trustedForwarder: forwarder,
  deployer: deployer.address,
  transactionHash: receipt.hash,
  blockNumber: receipt.blockNumber,
};
const outputDirectory = resolve("deployments");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, `decision-payment-${chainId}.json`),
  `${JSON.stringify(deployment, null, 2)}\n`,
);
console.log(JSON.stringify(deployment, null, 2));

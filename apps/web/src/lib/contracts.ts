import { isAddress, type Address } from "viem";

function configuredAddress(value: string | undefined, name: string): Address {
  if (!value || !isAddress(value) || value.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${name} is missing or is not a configured EVM address`);
  }
  return value;
}

export function getContractAddresses() {
  return {
    payment: configuredAddress(
      process.env.NEXT_PUBLIC_PAYMENT_CONTRACT_ADDRESS,
      "NEXT_PUBLIC_PAYMENT_CONTRACT_ADDRESS",
    ),
    asset: configuredAddress(
      process.env.NEXT_PUBLIC_ASSET_CONTRACT_ADDRESS,
      "NEXT_PUBLIC_ASSET_CONTRACT_ADDRESS",
    ),
    paymentToken: configuredAddress(
      process.env.NEXT_PUBLIC_PAYMENT_TOKEN_ADDRESS,
      "NEXT_PUBLIC_PAYMENT_TOKEN_ADDRESS",
    ),
    assetToken: configuredAddress(
      process.env.NEXT_PUBLIC_ASSET_TOKEN_ADDRESS,
      "NEXT_PUBLIC_ASSET_TOKEN_ADDRESS",
    ),
  };
}

export function parseAddress(value: string): Address {
  if (!isAddress(value)) throw new Error("Enter a valid EVM address");
  return value;
}

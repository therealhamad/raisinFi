import { isAddress, parseUnits, type Address, type Hex } from "viem";

const SEPOLIA_CHAIN_ID = 11155111n;
const BASE_SEPOLIA_CHAIN_ID = 84532n;
import { createTransactionId, hashTerms, type Terms } from "./protocol.ts";

function parseAddress(value: string): Address {
  if (!isAddress(value)) throw new Error("Enter a valid EVM address");
  return value as Address;
}

export type AgreementDraft = {
  terms: Terms;
  termsHash: Hex;
  paymentDecimals: number;
  assetDecimals: number;
};

export type AgreementDraftInput = {
  buyerInput: string;
  sellerInput: string;
  paymentChainInput: string;
  assetChainInput: string;
  paymentTokenInput: string;
  assetTokenInput: string;
  paymentAmountInput: string;
  assetAmountInput: string;
  expiryMinutesInput: string;
  paymentDecimals: number;
  assetDecimals: number;
  paymentContract: Address;
  assetSettlement: Address;
  transactionId?: Hex;
  nowMs?: number;
};

export function buildAgreementDraft(input: AgreementDraftInput): AgreementDraft {
  if (!/^\d+$/.test(input.paymentChainInput.trim()) || !/^\d+$/.test(input.assetChainInput.trim())) {
    throw new Error("Chain IDs must be positive whole numbers");
  }
  const buyer = parseAddress(input.buyerInput.trim());
  const seller = parseAddress(input.sellerInput.trim());
  if (buyer === "0x0000000000000000000000000000000000000000" || seller === "0x0000000000000000000000000000000000000000") {
    throw new Error("Buyer and seller must be non-zero addresses");
  }
  if (buyer.toLowerCase() === seller.toLowerCase()) throw new Error("Buyer and seller must be different addresses");
  if (BigInt(input.paymentChainInput) !== SEPOLIA_CHAIN_ID) {
    throw new Error(`The configured payment settlement supports Ethereum Sepolia only (${SEPOLIA_CHAIN_ID})`);
  }
  if (BigInt(input.assetChainInput) !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`The configured asset settlement supports Base Sepolia only (${BASE_SEPOLIA_CHAIN_ID})`);
  }
  const paymentToken = parseAddress(input.paymentTokenInput.trim());
  const assetToken = parseAddress(input.assetTokenInput.trim());
  if (paymentToken === "0x0000000000000000000000000000000000000000" || assetToken === "0x0000000000000000000000000000000000000000") {
    throw new Error("Token addresses must be non-zero");
  }
  if (!Number.isInteger(input.paymentDecimals) || input.paymentDecimals < 0 || input.paymentDecimals > 18 ||
      !Number.isInteger(input.assetDecimals) || input.assetDecimals < 0 || input.assetDecimals > 18) {
    throw new Error("Tokens must use between 0 and 18 decimals to fit the agreement amount inputs");
  }
  const exceedsPrecision = (amount: string, decimals: number) => {
    const normalized = amount.trim();
    if (!/^\d+(\.\d+)?$/.test(normalized)) return false;
    return (normalized.split(".")[1]?.length ?? 0) > decimals;
  };
  if (exceedsPrecision(input.paymentAmountInput, input.paymentDecimals)) {
    throw new Error(`Payment amount exceeds the token's ${input.paymentDecimals} decimals`);
  }
  if (exceedsPrecision(input.assetAmountInput, input.assetDecimals)) {
    throw new Error(`Asset amount exceeds the token's ${input.assetDecimals} decimals`);
  }
  let paymentAmount: bigint;
  let assetAmount: bigint;
  try {
    paymentAmount = parseUnits(input.paymentAmountInput.trim(), input.paymentDecimals);
  } catch {
    throw new Error(`Payment amount is invalid or exceeds the token's ${input.paymentDecimals} decimals`);
  }
  try {
    assetAmount = parseUnits(input.assetAmountInput.trim(), input.assetDecimals);
  } catch {
    throw new Error(`Asset amount is invalid or exceeds the token's ${input.assetDecimals} decimals`);
  }
  if (paymentAmount <= 0n || assetAmount <= 0n) throw new Error("Payment and asset amounts must be greater than zero");
  const expiryMinutes = Number(input.expiryMinutesInput);
  if (!Number.isSafeInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 1440) {
    throw new Error("Expiry must be between 1 and 1440 minutes");
  }
  const terms: Terms = {
    transactionId: input.transactionId ?? createTransactionId(buyer),
    buyer,
    seller,
    paymentChainId: SEPOLIA_CHAIN_ID,
    paymentContract: input.paymentContract,
    paymentInputToken: paymentToken,
    paymentInputAmount: paymentAmount,
    paymentToken,
    paymentAmount,
    amountOutMin: 0n,
    assetChainId: BASE_SEPOLIA_CHAIN_ID,
    assetSettlement: input.assetSettlement,
    assetToken,
    assetAmount,
    expiresAt: BigInt(Math.floor((input.nowMs ?? Date.now()) / 1000) + expiryMinutes * 60),
    schemaVersion: 1,
  };
  return { terms, termsHash: hashTerms(terms), paymentDecimals: input.paymentDecimals, assetDecimals: input.assetDecimals };
}

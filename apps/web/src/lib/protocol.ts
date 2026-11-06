import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toBytes,
  type Address,
  type Hex,
} from "viem";

const TERMS_TYPEHASH = keccak256(
  toBytes(
    "RaisinFiTerms(bytes32 transactionId,address buyer,address seller,uint256 paymentChainId,address paymentContract,address paymentInputToken,uint256 paymentInputAmount,address paymentToken,uint256 paymentAmount,uint256 amountOutMin,uint256 assetChainId,address assetSettlement,address assetToken,uint256 assetAmount,uint256 expiresAt,uint32 schemaVersion)",
  ),
);

export type Terms = {
  transactionId: Hex;
  buyer: Address;
  seller: Address;
  paymentChainId: bigint;
  paymentContract: Address;
  paymentInputToken: Address;
  paymentInputAmount: bigint;
  paymentToken: Address;
  paymentAmount: bigint;
  amountOutMin: bigint;
  assetChainId: bigint;
  assetSettlement: Address;
  assetToken: Address;
  assetAmount: bigint;
  expiresAt: bigint;
  schemaVersion: number;
};

export function hashTerms(terms: Terms): Hex {
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "bytes32, bytes32, address, address, uint256, address, address, uint256, address, uint256, uint256, uint256, address, address, uint256, uint256, uint32",
    ),
    [
      TERMS_TYPEHASH,
      terms.transactionId,
      terms.buyer,
      terms.seller,
      terms.paymentChainId,
      terms.paymentContract,
      terms.paymentInputToken,
      terms.paymentInputAmount,
      terms.paymentToken,
      terms.paymentAmount,
      terms.amountOutMin,
      terms.assetChainId,
      terms.assetSettlement,
      terms.assetToken,
      terms.assetAmount,
      terms.expiresAt,
      terms.schemaVersion,
    ],
  );
  return keccak256(encoded);
}

export function createTransactionId(account: Address): Hex {
  return keccak256(toBytes(`${account}:${Date.now()}:${crypto.randomUUID()}`));
}

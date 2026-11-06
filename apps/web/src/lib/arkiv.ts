import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
} from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, eq } from "@arkiv-network/sdk/query";
import { addr, defineSchema, i32, str, u64 } from "@arkiv-network/sdk/schema";
import {
  custom,
  http,
  type Address,
  type Hex,
} from "viem";
import type { InjectedProvider } from "./wallet";

const chain = rabdi({
  accessKey: process.env.NEXT_PUBLIC_ARKIV_ACCESS_KEY ?? "",
});

export const arkivPublicClient = createPublicClient({
  chain,
  transport: http(),
});

const transactionEvidenceSchema = defineSchema("raisinfi.transaction_record.v1", {
  transactionId: str().indexed(),
  termsHash: str().indexed(),
  buyer: addr(),
  seller: addr(),
  paymentChainId: i32(),
  paymentContract: addr(),
  assetChainId: i32(),
  assetContract: addr(),
  decision: str(),
  decisionRecordId: str(),
  status: str(),
  paymentTxHash: str().optional(),
  assetTxHash: str().optional(),
  updatedAt: u64(),
});

export type EvidenceInput = {
  transactionId: Hex;
  termsHash: Hex;
  buyer: Address;
  seller: Address;
  paymentChainId: number;
  paymentContract: Address;
  assetChainId: number;
  assetContract: Address;
  decision: string;
  decisionRecordId: Hex;
  status: string;
  paymentTxHash?: Hex;
  assetTxHash?: Hex;
  updatedAt: bigint;
};

export type EvidenceResult = {
  entityKey: Hex;
  transactionId: string;
  termsHash: string;
  decision: string;
  decisionRecordId: string;
  status: string;
  createdAtBlock: bigint | null;
  createdAtTimestamp: bigint | null;
  txHash?: Hex | null;
  created?: boolean;
};

export type EvidenceWriteResult = EvidenceResult & {
  txHash: Hex | null;
  created: boolean;
};

export async function findEvidence(
  transactionId: Hex,
  termsHash: Hex,
): Promise<EvidenceResult | null> {
  const rows = await arkivPublicClient
    .select({ $key: true, $createdAt: true })
    .from(transactionEvidenceSchema)
    .where(and(eq("transactionId", transactionId), eq("termsHash", termsHash)))
    .fetch();
  const row = rows.entities[0];
  if (!row) return null;

  const record = await arkivPublicClient.getEntity(row.$key, transactionEvidenceSchema);
  if (
    record.transactionId.value.toLowerCase() !== transactionId.toLowerCase() ||
    record.termsHash.value.toLowerCase() !== termsHash.toLowerCase()
  ) {
    throw new Error("Arkiv returned an entity misbound to a different transaction or terms hash");
  }
  const createdAtBlock = row.$createdAt ?? null;
  const createdAtTimestamp = createdAtBlock === null
    ? null
    : (await arkivPublicClient.getBlock({ blockNumber: createdAtBlock })).timestamp;
  return {
    entityKey: row.$key,
    transactionId: record.transactionId.value,
    termsHash: record.termsHash.value,
    decision: record.decision.value,
    decisionRecordId: record.decisionRecordId.value,
    status: record.status.value,
    createdAtBlock,
    createdAtTimestamp,
  };
}

export async function createEvidence(
  provider: InjectedProvider,
  account: Address,
  evidence: EvidenceInput,
): Promise<EvidenceWriteResult> {
  const existing = await findEvidence(evidence.transactionId, evidence.termsHash);
  if (existing) return { ...existing, txHash: null, created: false };

  const walletClient = createWalletClient({
    account,
    chain,
    transport: custom(provider),
  });
  const values = {
    transactionId: evidence.transactionId,
    termsHash: evidence.termsHash,
    buyer: addr(evidence.buyer),
    seller: addr(evidence.seller),
    paymentChainId: i32(evidence.paymentChainId),
    paymentContract: addr(evidence.paymentContract),
    assetChainId: i32(evidence.assetChainId),
    assetContract: addr(evidence.assetContract),
    decision: evidence.decision,
    decisionRecordId: evidence.decisionRecordId,
    status: evidence.status,
    ...(evidence.paymentTxHash ? { paymentTxHash: evidence.paymentTxHash } : {}),
    ...(evidence.assetTxHash ? { assetTxHash: evidence.assetTxHash } : {}),
    updatedAt: u64(evidence.updatedAt),
  };
  const { entityKey, txHash } = await walletClient.createEntity(
    transactionEvidenceSchema,
    values,
    { expiration: ExpirationTime.fromDays(30) },
  );
  const result = await arkivPublicClient.getEntity(entityKey, transactionEvidenceSchema);
  const createdAtBlock = result.$createdAt ?? null;
  const createdAtTimestamp = createdAtBlock === null
    ? null
    : (await arkivPublicClient.getBlock({ blockNumber: createdAtBlock })).timestamp;

  return {
    entityKey,
    transactionId: result.transactionId.value,
    termsHash: result.termsHash.value,
    decision: result.decision.value,
    decisionRecordId: result.decisionRecordId.value,
    status: result.status.value,
    createdAtBlock,
    createdAtTimestamp,
    txHash,
    created: true,
  };
}

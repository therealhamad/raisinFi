"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  HttpRequestError,
  parseAbiItem,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import {
  assetSettlementAbi,
  decisionPaymentSettlementAbi,
  mockErc20Abi,
} from "@/generated/contract-abis";
import { arkivPublicClient, createEvidence, findEvidence, type EvidenceResult } from "@/lib/arkiv";
import { getContractAddresses } from "@/lib/contracts";
import { buildAgreementDraft, type AgreementDraft } from "@/lib/agreement-draft.ts";
import { deduplicateFinalizedLogs, scanSepoliaFinalizedLogs, SEPOLIA_LOG_CHUNK_SIZE } from "@/lib/finalized-logs";
import { createTransactionId, hashTerms, type Terms } from "@/lib/protocol";
import { ThemeToggle } from "./ThemeToggle";
import {
  arkivChain,
  createTransactionWalletClient,
  getInjectedProvider,
  readWalletState,
  switchWalletChain,
} from "@/lib/wallet";

type Snapshot = {
  terms: Terms;
  termsHash: Hex;
  decision: bigint;
  paymentStatus: bigint;
  assetStatus: bigint | null;
  assetDecision: bigint | null;
  assetReadError: string | null;
  finalizedTimestamp: bigint;
  lifecycle: {
    agreement: VerifiedReceipt | null;
    paymentLock: VerifiedReceipt | null;
    assetLock: VerifiedReceipt | null;
    sourceDecision: VerifiedReceipt | null;
    destinationDecision: VerifiedReceipt | null;
    paymentOutcome: VerifiedReceipt | null;
    assetOutcome: VerifiedReceipt | null;
  };
  lifecycleReadError: string | null;
};

type VerifiedReceipt = {
  hash: Hex;
  blockNumber: bigint;
  status: "success";
};

type RegistrationConfirmation = {
  transactionId: Hex;
  termsHash: Hex;
  buyer: Address;
  receipt: VerifiedReceipt;
  eventVerified: boolean;
  eventError: string | null;
  finalized: boolean;
};

type TransactionReference = {
  chainId: number;
  hash: Hex;
  label: string;
  transactionId: Hex;
  contractAddress: Address;
  blockNumber: bigint;
  status: "success" | "reverted";
};

type ChainReceiptEntry = {
  hash: Hex;
  contractAddress: Address;
  blockNumber: bigint;
  label: string;
  status: "success" | "reverted";
  finalized: boolean;
};

type AgreementSubmission = {
  terms: Terms;
  termsHash: Hex;
  transactionHash: Hex | null;
  status: "pending" | "included" | "finalized" | "failed";
  receipt: VerifiedReceipt | null;
  error: string | null;
};

type VerificationEntry = {
  transactionId: Hex;
  status: string;
  paymentStatus: string;
  assetStatus: string;
  assetReadError: string | null;
  blockNumber: bigint;
};

type LifecycleLog = {
  transactionHash: Hex | null;
  blockHash: Hex | null;
  blockNumber: bigint | null;
  logIndex: number | null;
  address: Address;
  topics: readonly Hex[];
  data: Hex;
};

const PREPARED_DEMO_TERMS: Terms = {
  transactionId: "0x8f5348a3dbe6899a030bd996c3d6a120a483d7b2b904aa69c6d2f32ad19946fe",
  buyer: "0xAd60D772BC548Aa250468889C4D58a7D65cAec53",
  seller: "0x9d0a5005D7d22471750E18996bDeD66B2CaFe5f3",
  paymentChainId: 11155111n,
  paymentContract: "0x46474063C039f76111d0a393B8266E377dF7b8e8",
  paymentInputToken: "0x94420ff404238419452Eb8f25Ddb002e7Aa2a7e5",
  paymentInputAmount: 1000n * 10n ** 18n,
  paymentToken: "0x94420ff404238419452Eb8f25Ddb002e7Aa2a7e5",
  paymentAmount: 1000n * 10n ** 18n,
  amountOutMin: 0n,
  assetChainId: 84532n,
  assetSettlement: "0x9DbFA23d09deb3A66a7261de9E7e708A1b9bBc1A",
  assetToken: "0x5050Badc7279A059AFC0CDb04d1a63cEFfa0CAaF",
  assetAmount: 100n * 10n ** 18n,
  expiresAt: 1794005975n,
  schemaVersion: 1,
};
const PREPARED_DEMO_TERMS_HASH: Hex = "0xd0f6b8ed86de8431953afe99f0f8f93805f21ecfc5c46e70eef115cfaf1026e5";
const PREPARED_DEMO_BUYER = "0xAd60D772BC548Aa250468889C4D58a7D65cAec53" as Address;

// Prefer the dedicated provider, but keep the previous variable as a deployment fallback.
// Every Sepolia public read/simulation uses this same resolved endpoint.
const sepoliaRpcUrl = process.env.NEXT_PUBLIC_ETHEREUM_SEPOLIA_DISCOVERY_RPC_URL
  || process.env.NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URL
  || undefined;
const paymentClient = createPublicClient({
  chain: sepolia,
  transport: http(sepoliaRpcUrl),
});
const discoveryClient = createPublicClient({
  chain: sepolia,
  transport: http(sepoliaRpcUrl, { retryCount: 0 }),
});
const assetClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || undefined),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected transaction error";
}

function findHttpRequestError(error: unknown): HttpRequestError | null {
  if (error instanceof HttpRequestError) return error;
  if (!(error instanceof BaseError)) return null;
  const found = error.walk((cause) => cause instanceof HttpRequestError);
  return found instanceof HttpRequestError ? found : null;
}

function errorReasonFromBody(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = errorReasonFromBody(item, depth + 1);
      if (reason) return reason;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  for (const key of ["reason", "shortMessage", "message", "error", "data"]) {
    if (!(key in body)) continue;
    const reason = errorReasonFromBody(body[key], depth + 1);
    if (reason) return reason;
  }
  return null;
}

function transactionErrorMessage(error: unknown): string {
  const safeText = (value: string) => value.replace(/https?:\/\/[^\s)]+/gi, "[RPC endpoint]");
  if (error instanceof BaseError) {
    const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const reason = revert.reason || revert.data?.errorName || revert.shortMessage;
      return `Contract simulation reverted: ${safeText(reason)}`;
    }
    const httpError = findHttpRequestError(error);
    if (httpError) {
      const reason = errorReasonFromBody(httpError.body);
      const status = httpError.status ? `HTTP ${httpError.status}` : "HTTP request";
      return `${status}: ${safeText(reason || httpError.shortMessage)}`;
    }
    return safeText([error.shortMessage, error.details].filter(Boolean).join(" — "));
  }
  return error instanceof Error ? safeText(error.message) : "Unexpected transaction error";
}

function rpcErrorStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    if ("status" in current && typeof current.status === "number") return current.status;
    current = "cause" in current ? current.cause : null;
  }
  if (!(error instanceof BaseError)) return undefined;
  const cause = error.walk((item) =>
    typeof item === "object" && item !== null && "status" in item && typeof item.status === "number",
  );
  return typeof cause === "object" && cause !== null && "status" in cause && typeof cause.status === "number"
    ? cause.status
    : undefined;
}

function isRetryableDiscoveryError(error: unknown): boolean {
  const status = rpcErrorStatus(error);
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

function safeRpcText(value: string): string {
  return value.replace(/https?:\/\/[^\s)]+/gi, "[RPC endpoint]");
}

function discoveryErrorMessage(error: unknown): string {
  const httpError = findHttpRequestError(error);
  const status = rpcErrorStatus(error);
  if (status === 429) return "Sepolia discovery RPC remained rate-limited after retries. Retry the scan or configure a dedicated discovery RPC endpoint.";
  if (status !== undefined) {
    const reason = errorReasonFromBody(httpError?.body)
      || (error instanceof BaseError ? error.details : null)
      || (error instanceof BaseError ? error.shortMessage : null)
      || httpError?.shortMessage
      || errorMessage(error);
    return `Sepolia discovery RPC HTTP ${status}: ${safeRpcText(reason)}`;
  }
  return safeRpcText(errorMessage(error));
}

function discoveryLogRangeLimit(error: unknown): bigint | null {
  if (rpcErrorStatus(error) !== 400) return null;
  const httpError = findHttpRequestError(error);
  const message = [
    httpError?.shortMessage,
    httpError?.details,
    error instanceof BaseError ? error.shortMessage : null,
    error instanceof BaseError ? error.details : null,
  ].filter(Boolean).join(" ").toLowerCase();
  if (!/eth_getlogs|block range|range.{0,24}block|block.{0,24}range/.test(message)) return null;
  const explicitLimit = message.match(/up to\s+(?:a\s+)?(\d+)\s+block/i)
    || message.match(/maximum(?: of)?\s+(\d+)\s+block/i);
  return explicitLimit ? BigInt(explicitLimit[1]) : 0n;
}

function retryDelay(error: unknown, attempt: number): number {
  const retryAfter = findHttpRequestError(error)?.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(8000, seconds * 1000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(8000, dateDelay);
  }
  return Math.min(8000, 500 * 2 ** attempt);
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

const DISCOVERY_MAX_RETRIES = 5;

async function withDiscoveryRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (!isRetryableDiscoveryError(error)) throw new Error(discoveryErrorMessage(error));
      if (attempt >= DISCOVERY_MAX_RETRIES) throw new Error(discoveryErrorMessage(error));
      await waitForRetry(retryDelay(error, attempt));
    }
  }
}

const DISCOVERY_INITIAL_CHUNK = SEPOLIA_LOG_CHUNK_SIZE;
const DISCOVERY_MIN_CHUNK = 1n;
let adaptiveDiscoveryChunkSize = DISCOVERY_INITIAL_CHUNK;
type RegistrationEventLog = {
  args?: { transactionId?: Hex };
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  logIndex: number | null;
  address: Address;
  data: Hex;
  topics: readonly Hex[];
};

async function getRegistrationLogs(address: Address, fromBlock: bigint, toBlock: bigint) {
  let chunkSize = adaptiveDiscoveryChunkSize;
  let retryAttempt = 0;
  const logs: RegistrationEventLog[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const chunkEnd = cursor + chunkSize - 1n < toBlock ? cursor + chunkSize - 1n : toBlock;
    try {
      const chunkLogs = await discoveryClient.getLogs({
        address,
        event: parseAbiItem("event TransactionRegistered(bytes32 indexed transactionId, bytes32 termsHash, address buyer)"),
        fromBlock: cursor,
        toBlock: chunkEnd,
      });
      logs.push(...chunkLogs as unknown as RegistrationEventLog[]);
      cursor = chunkEnd + 1n;
      retryAttempt = 0;
    } catch (error) {
      const rangeLimit = discoveryLogRangeLimit(error);
      if (rangeLimit !== null) {
        if (chunkSize <= DISCOVERY_MIN_CHUNK) throw new Error(discoveryErrorMessage(error));
        const halvedChunk = chunkSize / 2n < DISCOVERY_MIN_CHUNK ? DISCOVERY_MIN_CHUNK : chunkSize / 2n;
        chunkSize = rangeLimit > 0n && rangeLimit < halvedChunk ? rangeLimit : halvedChunk;
        adaptiveDiscoveryChunkSize = chunkSize;
        retryAttempt = 0;
        continue;
      }
      if (!isRetryableDiscoveryError(error)) throw new Error(discoveryErrorMessage(error));
      if (rpcErrorStatus(error) === 429 && chunkSize > DISCOVERY_MIN_CHUNK) {
        chunkSize = chunkSize / 2n < DISCOVERY_MIN_CHUNK ? DISCOVERY_MIN_CHUNK : chunkSize / 2n;
        adaptiveDiscoveryChunkSize = chunkSize;
      }
      if (retryAttempt >= DISCOVERY_MAX_RETRIES) throw new Error(discoveryErrorMessage(error));
      await waitForRetry(retryDelay(error, retryAttempt));
      retryAttempt += 1;
    }
  }
  return deduplicateFinalizedLogs(logs);
}

function isTransactionNotFound(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revertError = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return revertError instanceof ContractFunctionRevertedError && revertError.data?.errorName === "TransactionNotFound";
}

async function verifyEventReceipt(
  client: typeof paymentClient | typeof assetClient,
  log: LifecycleLog | undefined,
  eventName: string,
): Promise<VerifiedReceipt> {
  if (!log?.transactionHash || !log.blockHash || log.blockNumber === null || log.logIndex === null) {
    throw new Error(`${eventName} event is missing its transaction receipt reference`);
  }
  const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
  if (
    receipt.status !== "success" ||
    receipt.blockHash !== log.blockHash ||
    receipt.blockNumber !== log.blockNumber ||
    !receipt.logs.some(
      (receiptLog) =>
        receiptLog.logIndex === log.logIndex &&
        receiptLog.address.toLowerCase() === log.address.toLowerCase() &&
        receiptLog.data.toLowerCase() === log.data.toLowerCase() &&
        receiptLog.topics.length === log.topics.length &&
        receiptLog.topics.every((topic, index) => topic.toLowerCase() === log.topics[index]?.toLowerCase()),
    )
  ) {
    throw new Error(`${eventName} does not match a successful transaction receipt`);
  }
  return { hash: log.transactionHash, blockNumber: receipt.blockNumber, status: "success" };
}

async function verifyRegistrationReceipt(terms: Terms, termsHash: Hex, receipt: VerifiedReceipt) {
  const onchainReceipt = await paymentClient.getTransactionReceipt({ hash: receipt.hash });
  if (onchainReceipt.status !== "success" || onchainReceipt.blockNumber !== receipt.blockNumber) {
    throw new Error("Registration receipt no longer matches the successful included receipt");
  }
  const registrationLog = parseEventLogs({
    abi: decisionPaymentSettlementAbi,
    logs: onchainReceipt.logs,
    eventName: "TransactionRegistered",
    strict: true,
  }).find((log) =>
    log.address.toLowerCase() === terms.paymentContract.toLowerCase() &&
    log.args.transactionId.toLowerCase() === terms.transactionId.toLowerCase(),
  );
  if (
    !registrationLog ||
    registrationLog.args.termsHash.toLowerCase() !== termsHash.toLowerCase() ||
    registrationLog.args.buyer.toLowerCase() !== terms.buyer.toLowerCase()
  ) {
    throw new Error("Successful receipt is missing the matching TransactionRegistered event");
  }
  return {
    transactionId: registrationLog.args.transactionId,
    termsHash: registrationLog.args.termsHash,
    buyer: registrationLog.args.buyer,
  };
}

function RegistrationConfirmationNotice({ confirmation }: { confirmation: RegistrationConfirmation }) {
  return (
    <div className={`notice ${confirmation.finalized ? "success" : "warning"}`} role="status" aria-live="polite">
      <strong>{confirmation.finalized ? "Registration finalized" : "Registration included — awaiting finality"}</strong>
      <p>Sepolia receipt block {confirmation.receipt.blockNumber.toString()} · Transaction ID <code>{confirmation.transactionId}</code></p>
      {confirmation.eventVerified && <p>Receipt event confirms termsHash <code>{confirmation.termsHash}</code> for buyer <code>{confirmation.buyer}</code>.</p>}
      {confirmation.eventError && <p>Receipt event verification is still pending: {confirmation.eventError}</p>}
      <a href={`https://sepolia.etherscan.io/tx/${confirmation.receipt.hash}`} target="_blank" rel="noreferrer">View registration receipt {confirmation.receipt.hash} ↗</a>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyError(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <span className="copy-control">
      <button type="button" className="copy-button" onClick={() => void copyValue()} aria-label={`Copy ${label}`}>
        {copied ? "Copied" : copyError ? "Copy failed" : "Copy"}
      </button>
      {copyError && <span className="copy-error" role="status">Clipboard unavailable</span>}
    </span>
  );
}

function LifecycleReceipt({ chainId, receipt, label }: { chainId: number; receipt: VerifiedReceipt | null; label: string }) {
  const explorer = chainId === sepolia.id ? "https://sepolia.etherscan.io" : "https://sepolia.basescan.org";
  return (
    <div className={`lifecycle-receipt${receipt ? " verified" : ""}`}>
      <span>{label}</span>
      {receipt ? (
        <a href={`${explorer}/tx/${receipt.hash}`} target="_blank" rel="noreferrer" title={receipt.hash}>
          {receipt.hash.slice(0, 10)}… ↗
        </a>
      ) : (
        <span className="receipt-pending">Not confirmed</span>
      )}
    </div>
  );
}

function statusLabel(decision: bigint, paymentStatus: bigint, assetStatus: bigint | null) {
  if (decision === 1n && paymentStatus === 2n && assetStatus === 2n) return "SETTLED";
  if (decision === 1n) return "COMMIT_PENDING";
  if (
    decision === 2n &&
    (paymentStatus === 0n || paymentStatus === 3n) &&
    (assetStatus === 0n || assetStatus === 3n)
  ) return "RELEASED";
  if (decision === 2n) return "ABORT_PENDING";
  return "UNDECIDED";
}

function FailedReceipt({ references, chainId, transactionId }: { references: TransactionReference[]; chainId: number; transactionId: Hex }) {
  const reference = [...references].reverse().find(
    (item) => item.status === "reverted" && item.chainId === chainId && item.transactionId.toLowerCase() === transactionId.toLowerCase(),
  );
  if (!reference) return null;
  const explorer = chainId === sepolia.id ? "https://sepolia.etherscan.io" : "https://sepolia.basescan.org";
  return (
    <div className="lifecycle-receipt failed">
      <span>Verified reverted receipt</span>
      <a href={`${explorer}/tx/${reference.hash}`} target="_blank" rel="noreferrer" title={reference.hash}>
        {reference.hash.slice(0, 10)}… ↗
      </a>
    </div>
  );
}

function getChainReceiptEntries(
  references: TransactionReference[],
  snapshot: Snapshot | null,
  chainId: number,
): ChainReceiptEntry[] {
  const entries = references
    .filter((reference) => snapshot && reference.transactionId.toLowerCase() === snapshot.terms.transactionId.toLowerCase() && reference.chainId === chainId)
    .map((reference) => ({
      hash: reference.hash,
      contractAddress: reference.contractAddress,
      blockNumber: reference.blockNumber,
      label: reference.label,
      status: reference.status,
      finalized: false,
    }));

  if (!snapshot) return entries;
  const lifecycleEntries = chainId === sepolia.id
    ? [
        ["Agreement registered", snapshot.lifecycle.agreement, snapshot.terms.paymentContract],
        ["Payment locked", snapshot.lifecycle.paymentLock, snapshot.terms.paymentContract],
        ["Source decision", snapshot.lifecycle.sourceDecision, snapshot.terms.paymentContract],
        ["Payment outcome", snapshot.lifecycle.paymentOutcome, snapshot.terms.paymentContract],
      ] as const
    : [
        ["Asset locked", snapshot.lifecycle.assetLock, snapshot.terms.assetSettlement],
        ["Destination decision", snapshot.lifecycle.destinationDecision, snapshot.terms.assetSettlement],
        ["Asset outcome", snapshot.lifecycle.assetOutcome, snapshot.terms.assetSettlement],
      ] as const;

  for (const [label, receipt, contractAddress] of lifecycleEntries) {
    if (receipt) {
      const existingIndex = entries.findIndex((entry) => entry.hash.toLowerCase() === receipt.hash.toLowerCase());
      const verifiedEntry: ChainReceiptEntry = {
        hash: receipt.hash,
        contractAddress,
        blockNumber: receipt.blockNumber,
        label,
        status: "success",
        finalized: true,
      };
      if (existingIndex < 0) entries.push(verifiedEntry);
      else entries[existingIndex] = verifiedEntry;
    }
  }
  return entries.sort((left, right) => left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : 0);
}

async function readVerificationEntry(
  candidate: { transactionId: Hex; blockNumber: bigint },
  addresses: { payment: Address; asset: Address },
): Promise<VerificationEntry> {
  const [payment, assetResult] = await Promise.all([
    paymentClient.readContract({
      address: addresses.payment,
      abi: decisionPaymentSettlementAbi,
      functionName: "getTransaction",
      args: [candidate.transactionId],
      blockTag: "finalized",
    }),
    assetClient.readContract({
      address: addresses.asset,
      abi: assetSettlementAbi,
      functionName: "getAssetReservation",
      args: [candidate.transactionId],
      blockTag: "finalized",
    }).then((value) => ({ value, error: null as string | null }))
      .catch((error: unknown) => ({ value: null, error: errorMessage(error) })),
  ]);
  if (
    payment[0].transactionId.toLowerCase() !== candidate.transactionId.toLowerCase() ||
    hashTerms(payment[0]).toLowerCase() !== payment[1].toLowerCase()
  ) {
    throw new Error(`Finalized state for ${candidate.transactionId} failed terms verification`);
  }
  const asset = assetResult.value;
  let assetReadError = assetResult.error;
  let assetStatus: bigint | null = null;
  if (asset) {
    assetStatus = BigInt(asset[2]);
    if (
      assetStatus > 0n &&
      (asset[0].transactionId.toLowerCase() !== candidate.transactionId.toLowerCase() ||
        asset[1].toLowerCase() !== payment[1].toLowerCase())
    ) {
      assetStatus = null;
      assetReadError = "Asset reservation transaction ID or terms hash did not match";
    }
  }
  const decision = BigInt(payment[2]);
  const paymentStatus = BigInt(payment[3]);
  return {
    transactionId: candidate.transactionId,
    status: statusLabel(decision, paymentStatus, assetStatus),
    paymentStatus: ["NOT LOCKED", "LOCKED", "PAID", "REFUNDED"][Number(paymentStatus)] ?? "UNKNOWN",
    assetStatus: assetStatus === null ? "UNAVAILABLE" : ["NOT LOCKED", "LOCKED", "DELIVERED", "RELEASED"][Number(assetStatus)] ?? "UNKNOWN",
    assetReadError,
    blockNumber: candidate.blockNumber,
  };
}

export function TransactionConsole() {
  const actionDialogRef = useRef<HTMLDialogElement>(null);
  const verificationCursorRef = useRef<bigint | null>(null);
  const verificationFloorRef = useRef(0n);
  const verificationCandidatesRef = useRef<{ transactionId: Hex; blockNumber: bigint }[]>([]);
  const verificationHasMoreRef = useRef(false);
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [sellerInput, setSellerInput] = useState("");
  const [paymentAmountInput, setPaymentAmountInput] = useState("1000");
  const [assetAmountInput, setAssetAmountInput] = useState("100");
  const [expiryMinutesInput, setExpiryMinutesInput] = useState("15");
  const [agreementDraft, setAgreementDraft] = useState<AgreementDraft | null>(null);
  const [agreementSubmission, setAgreementSubmission] = useState<AgreementSubmission | null>(null);
  const [transactionIdInput, setTransactionIdInput] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [activeGuideStep, setActiveGuideStep] = useState(0);
  const [activeActionPanel, setActiveActionPanel] = useState<"create" | "prepared" | "open" | null>(null);
  const [verificationEntries, setVerificationEntries] = useState<VerificationEntry[]>([]);
  const [verificationVisibleCount, setVerificationVisibleCount] = useState(2);
  const [verificationHasMore, setVerificationHasMore] = useState(false);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [references, setReferences] = useState<TransactionReference[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [arkivResult, setArkivResult] = useState<EvidenceResult | null>(null);
  const [arkivBusy, setArkivBusy] = useState(false);
  const [arkivError, setArkivError] = useState<string | null>(null);
  const [preparedDemoReady, setPreparedDemoReady] = useState(false);
  const [preparedDemoCheckBusy, setPreparedDemoCheckBusy] = useState(false);
  const [preparedDemoCheckError, setPreparedDemoCheckError] = useState<string | null>(null);
  const [preparedDemoVerification, setPreparedDemoVerification] = useState<{ checkedAt: number; blockNumber: bigint; blockTimestamp: bigint } | null>(null);
  const [preparedDemoSubmission, setPreparedDemoSubmission] = useState<{ hash: Hex; status: "pending" | "included" | "success" | "failure" } | null>(null);
  const [registrationConfirmation, setRegistrationConfirmation] = useState<RegistrationConfirmation | null>(null);

  useEffect(() => {
    if (!window.ethereum) return;
    const provider = window.ethereum;
    const syncWallet = async () => {
      try {
        const walletState = await readWalletState(provider);
        setAddress(walletState.address);
        setChainId(walletState.chainId);
        setIsConnected(walletState.address !== null);
      } catch (error) {
        setActionError(`Could not read wallet state: ${errorMessage(error)}`);
      }
    };
    const onAccountsChanged = (accounts: string[]) => {
      const currentAddress = accounts[0];
      if (currentAddress && isAddress(currentAddress)) {
        setAddress(getAddress(currentAddress));
        setIsConnected(true);
      } else {
        setAddress(null);
        setIsConnected(false);
      }
    };
    const onChainChanged = (newChainId: string) => {
      try {
        setChainId(Number(BigInt(newChainId)));
      } catch (error) {
        setActionError(`Wallet returned an invalid chain ID: ${errorMessage(error)}`);
      }
    };

    void syncWallet();
    provider.on("accountsChanged", onAccountsChanged);
    provider.on("chainChanged", onChainChanged);
    return () => {
      provider.removeListener("accountsChanged", onAccountsChanged);
      provider.removeListener("chainChanged", onChainChanged);
    };
  }, []);

  const { addresses, configurationError } = useMemo(() => {
    try {
      return { addresses: getContractAddresses(), configurationError: null };
    } catch (error) {
      return { addresses: null, configurationError: errorMessage(error) };
    }
  }, []);
  const [paymentInputToken, setPaymentInputToken] = useState<string>("");
  const [paymentOutputToken, setPaymentOutputToken] = useState<string>("");
  const [assetTokenInput, setAssetTokenInput] = useState<string>("");
  const [paymentChainInput, setPaymentChainInput] = useState(String(sepolia.id));
  const [assetChainInput, setAssetChainInput] = useState(String(baseSepolia.id));
  const [paymentTokenDecimals, setPaymentTokenDecimals] = useState(18);
  const [assetTokenDecimals, setAssetTokenDecimals] = useState(18);
  const [agreementFormError, setAgreementFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!addresses) return;
    setPaymentInputToken((current) => current || addresses.paymentToken);
    setPaymentOutputToken((current) => current || addresses.paymentToken);
    setAssetTokenInput((current) => current || addresses.assetToken);
  }, [addresses]);

  useEffect(() => {
    setAgreementDraft(null);
    setAgreementSubmission(null);
  }, [address, sellerInput, paymentChainInput, assetChainInput, paymentInputToken, paymentOutputToken, assetTokenInput, paymentAmountInput, assetAmountInput, expiryMinutesInput, paymentTokenDecimals, assetTokenDecimals]);

  const agreementPreview = useMemo(() => {
    if (!address || !addresses || !sellerInput || !paymentInputToken || !paymentOutputToken || !assetTokenInput) {
      return { draft: null, error: "Connect the buyer wallet and enter the seller and token addresses to preview Terms." };
    }
    try {
      if (paymentInputToken.trim().toLowerCase() !== paymentOutputToken.trim().toLowerCase()) {
        throw new Error("Swaps are not enabled; payment input and output token must match.");
      }
      return { draft: buildAgreementDraft({
        buyerInput: address,
        sellerInput,
        paymentChainInput,
        assetChainInput,
        paymentTokenInput: paymentInputToken,
        assetTokenInput,
        paymentAmountInput,
        assetAmountInput,
        expiryMinutesInput,
        paymentDecimals: paymentTokenDecimals,
        assetDecimals: assetTokenDecimals,
        paymentContract: addresses.payment,
        assetSettlement: addresses.asset,
      }), error: null };
    } catch (error) {
      return { draft: null, error: errorMessage(error) };
    }
  }, [address, addresses, sellerInput, paymentChainInput, assetChainInput, paymentInputToken, paymentOutputToken, assetTokenInput, paymentAmountInput, assetAmountInput, expiryMinutesInput, paymentTokenDecimals, assetTokenDecimals]);

  useEffect(() => {
    const dialog = actionDialogRef.current;
    if (!activeActionPanel || !dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-dialog-autofocus]")?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [activeActionPanel]);

  useEffect(() => {
    if (!activeActionPanel) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveActionPanel(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [activeActionPanel]);

  const refreshTransaction = useCallback(async (transactionId: Hex, includedReceipt?: VerifiedReceipt) => {
    if (!addresses) return;
    setReadError(null);
    try {
      const finalizedBlock = await paymentClient.getBlock({ blockTag: "finalized" });
      if (includedReceipt && finalizedBlock.number < includedReceipt.blockNumber) {
        setSnapshot((current) => current?.terms.transactionId.toLowerCase() === transactionId.toLowerCase() ? current : null);
        return;
      }
      const paymentResult = await paymentClient.readContract({
        address: addresses.payment,
        abi: decisionPaymentSettlementAbi,
        functionName: "getTransaction",
        args: [transactionId],
        blockNumber: finalizedBlock.number,
      });
      const terms = paymentResult[0];
      if (terms.transactionId.toLowerCase() !== transactionId.toLowerCase()) {
        throw new Error("Transaction ID was not found in the finalized Chain A state");
      }
      const termsHash = paymentResult[1];
      if (hashTerms(terms).toLowerCase() !== termsHash.toLowerCase()) {
        throw new Error("Finalized Chain A terms do not match their recorded terms hash");
      }
      const decision = BigInt(paymentResult[2]);
      const paymentStatus = BigInt(paymentResult[3]);
      let assetStatus: bigint | null = null;
      let assetDecision: bigint | null = null;
      let assetDecisionRecordId: Hex | null = null;
      let assetReadError: string | null = null;

      try {
        const assetResult = await assetClient.readContract({
          address: addresses.asset,
          abi: assetSettlementAbi,
          functionName: "getAssetReservation",
          args: [transactionId],
          blockTag: "finalized",
        });
        assetStatus = BigInt(assetResult[2]);
        assetDecision = BigInt(assetResult[3]);
        assetDecisionRecordId = assetResult[4];
        if (
          assetStatus > 0n &&
          (assetResult[0].transactionId.toLowerCase() !== transactionId.toLowerCase() ||
            assetResult[1].toLowerCase() !== termsHash.toLowerCase())
        ) {
          throw new Error("Finalized Chain B reservation is bound to a different transaction or terms hash");
        }
      } catch (error) {
        assetReadError = errorMessage(error);
      }

      const lifecycle = {
        agreement: null as VerifiedReceipt | null,
        paymentLock: null as VerifiedReceipt | null,
        assetLock: null as VerifiedReceipt | null,
        sourceDecision: null as VerifiedReceipt | null,
        destinationDecision: null as VerifiedReceipt | null,
        paymentOutcome: null as VerifiedReceipt | null,
        assetOutcome: null as VerifiedReceipt | null,
      };
      let lifecycleReadError: string | null = null;
      try {
        const paymentFromBlock = process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK
          ? BigInt(process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK)
          : 0n;
        const assetFromBlock = process.env.NEXT_PUBLIC_ASSET_DEPLOYMENT_BLOCK
          ? BigInt(process.env.NEXT_PUBLIC_ASSET_DEPLOYMENT_BLOCK)
          : 0n;
        const registeredLogs = await scanSepoliaFinalizedLogs(paymentFromBlock, finalizedBlock.number, (fromBlock, toBlock) =>
          withDiscoveryRetry(() => paymentClient.getLogs({
            address: addresses.payment,
            event: parseAbiItem("event TransactionRegistered(bytes32 indexed transactionId, bytes32 termsHash, address buyer)"),
            args: { transactionId },
            fromBlock,
            toBlock,
          })),
        );
        const registeredLog = registeredLogs.find(
          (log) =>
            log.args.termsHash?.toLowerCase() === termsHash.toLowerCase() &&
            log.args.buyer?.toLowerCase() === terms.buyer.toLowerCase(),
        );
        if (!registeredLog) throw new Error("Matching finalized TransactionRegistered event was not found");
        lifecycle.agreement = await verifyEventReceipt(paymentClient, registeredLog, "TransactionRegistered");

        if (paymentStatus > 0n) {
          const logs = await scanSepoliaFinalizedLogs(paymentFromBlock, finalizedBlock.number, (fromBlock, toBlock) =>
            withDiscoveryRetry(() => paymentClient.getLogs({
              address: addresses.payment,
              event: parseAbiItem("event PaymentLocked(bytes32 indexed transactionId, bytes32 termsHash, address payer, uint256 amount)"),
              args: { transactionId },
              fromBlock,
              toBlock,
            })),
          );
          const log = logs.find(
            (entry) =>
              entry.args.termsHash?.toLowerCase() === termsHash.toLowerCase() &&
              entry.args.payer?.toLowerCase() === terms.buyer.toLowerCase() &&
              entry.args.amount === terms.paymentInputAmount,
          );
          if (!log) throw new Error("Matching finalized PaymentLocked event was not found");
          lifecycle.paymentLock = await verifyEventReceipt(paymentClient, log, "PaymentLocked");
        }

        if (decision !== 0n) {
          const logs = await scanSepoliaFinalizedLogs(paymentFromBlock, finalizedBlock.number, (fromBlock, toBlock) =>
            withDiscoveryRetry(() => paymentClient.getLogs({
              address: addresses.payment,
              event: parseAbiItem("event DecisionRecorded(bytes32 indexed transactionId, bytes32 termsHash, uint8 decision)"),
              args: { transactionId },
              fromBlock,
              toBlock,
            })),
          );
          const log = logs.find(
            (entry) =>
              entry.args.termsHash?.toLowerCase() === termsHash.toLowerCase() &&
              entry.args.decision !== undefined &&
              BigInt(entry.args.decision) === decision,
          );
          if (!log) throw new Error("Matching finalized source decision event was not found");
          lifecycle.sourceDecision = await verifyEventReceipt(paymentClient, log, "DecisionRecorded");
        }

        if (paymentStatus === 2n || paymentStatus === 3n) {
          const event = paymentStatus === 2n
            ? parseAbiItem("event PaymentExecuted(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount)")
            : parseAbiItem("event PaymentReleased(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount)");
          const logs = await scanSepoliaFinalizedLogs(paymentFromBlock, finalizedBlock.number, (fromBlock, toBlock) =>
            withDiscoveryRetry(() => paymentClient.getLogs({
              address: addresses.payment,
              event,
              args: { transactionId },
              fromBlock,
              toBlock,
            })),
          );
          const recipient = paymentStatus === 2n ? terms.seller : terms.buyer;
          const amount = paymentStatus === 2n ? terms.paymentAmount : terms.paymentInputAmount;
          const log = logs.find(
            (entry) =>
              entry.args.termsHash?.toLowerCase() === termsHash.toLowerCase() &&
              entry.args.recipient?.toLowerCase() === recipient.toLowerCase() &&
              entry.args.amount === amount,
          );
          if (!log) throw new Error("Matching finalized Chain A payment outcome event was not found");
          lifecycle.paymentOutcome = await verifyEventReceipt(paymentClient, log, "Payment outcome");
        }

        if (assetStatus !== null && assetStatus > 0n) {
          const logs = await assetClient.getLogs({
            address: addresses.asset,
            event: parseAbiItem("event AssetLocked(bytes32 indexed transactionId, bytes32 termsHash, address seller, uint256 amount)"),
            args: { transactionId },
            fromBlock: assetFromBlock,
            toBlock: "finalized",
          });
          const log = logs.find(
            (entry) =>
              entry.args.termsHash?.toLowerCase() === termsHash.toLowerCase() &&
              entry.args.seller?.toLowerCase() === terms.seller.toLowerCase() &&
              entry.args.amount === terms.assetAmount,
          );
          if (!log) throw new Error("Matching finalized AssetLocked event was not found");
          lifecycle.assetLock = await verifyEventReceipt(assetClient, log, "AssetLocked");
        }

        if (assetDecision !== null && assetDecision !== 0n) {
          const logs = await assetClient.getLogs({
            address: addresses.asset,
            event: parseAbiItem("event DecisionReceived(bytes32 indexed transactionId, bytes32 termsHash, uint8 decision, bytes32 decisionRecordId)"),
            args: { transactionId },
            fromBlock: assetFromBlock,
            toBlock: "finalized",
          });
          const log = logs.find(
            (entry) =>
              entry.args.termsHash?.toLowerCase() === termsHash.toLowerCase() &&
              entry.args.decision !== undefined &&
              BigInt(entry.args.decision) === assetDecision &&
              entry.args.decisionRecordId?.toLowerCase() === assetDecisionRecordId?.toLowerCase(),
          );
          if (!log) throw new Error("Matching finalized authenticated DecisionReceived event was not found");
          lifecycle.destinationDecision = await verifyEventReceipt(assetClient, log, "DecisionReceived");
        }

        if (assetStatus === 2n || assetStatus === 3n) {
          const event = assetStatus === 2n
            ? parseAbiItem("event AssetDelivered(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount)")
            : parseAbiItem("event AssetReleased(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount)");
          const logs = await assetClient.getLogs({
            address: addresses.asset,
            event,
            args: { transactionId },
            fromBlock: assetFromBlock,
            toBlock: "finalized",
          });
          const recipient = assetStatus === 2n ? terms.buyer : terms.seller;
          const log = logs.find(
            (entry) =>
              entry.args.termsHash?.toLowerCase() === termsHash.toLowerCase() &&
              entry.args.recipient?.toLowerCase() === recipient.toLowerCase() &&
              entry.args.amount === terms.assetAmount,
          );
          if (!log) throw new Error("Matching finalized Chain B asset outcome event was not found");
          lifecycle.assetOutcome = await verifyEventReceipt(assetClient, log, "Asset outcome");
        }
      } catch (error) {
        lifecycleReadError = errorMessage(error);
      }

      setSnapshot({
        terms,
        termsHash,
        decision,
        paymentStatus,
        assetStatus,
        assetDecision,
        assetReadError,
        finalizedTimestamp: finalizedBlock.timestamp,
        lifecycle,
        lifecycleReadError,
      });
      if (
        includedReceipt &&
        lifecycle.agreement?.hash.toLowerCase() === includedReceipt.hash.toLowerCase() &&
        lifecycle.agreement.blockNumber === includedReceipt.blockNumber
      ) {
        setRegistrationConfirmation((current) => current?.receipt.hash.toLowerCase() === includedReceipt.hash.toLowerCase()
          ? { ...current, eventVerified: true, eventError: null, finalized: true }
          : current);
        setPreparedDemoSubmission((current) => current?.hash.toLowerCase() === includedReceipt.hash.toLowerCase()
          ? { ...current, status: "success" }
          : current);
      }
      setTransactionIdInput(transactionId);
      if (assetReadError) {
        setReadError(`Chain A read succeeded; Chain B reservation read failed: ${assetReadError}`);
      } else if (lifecycleReadError) {
        setReadError(`Contract state was read, but lifecycle event verification failed: ${lifecycleReadError}`);
      }
    } catch (error) {
      if (includedReceipt && isTransactionNotFound(error)) return;
      setSnapshot(null);
      setReadError(`Could not read the Chain A transaction: ${errorMessage(error)}`);
    }
  }, [addresses]);

  useEffect(() => {
    if (!registrationConfirmation || registrationConfirmation.finalized) return;
    const timer = window.setInterval(() => {
      void refreshTransaction(registrationConfirmation.transactionId, registrationConfirmation.receipt);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [registrationConfirmation, refreshTransaction]);

  async function loadVerificationBatch(targetCount: number) {
    if (!addresses || verificationBusy) return;
    setVerificationBusy(true);
    setVerificationError(null);
    try {
      let candidates = verificationCandidatesRef.current;
      let cursor = verificationCursorRef.current;
      let hasMore = verificationHasMoreRef.current;
      let scans = 0;
      const desiredCount = verificationEntries.length + targetCount;

      while (candidates.length < desiredCount && hasMore && scans < 5) {
        if (cursor === null) throw new Error("Transaction discovery has not been initialized");
        const fromBlock = cursor > verificationFloorRef.current + 1999n
          ? cursor - 1999n
          : verificationFloorRef.current;
        const toBlock = cursor;
        const logs = await getRegistrationLogs(addresses.payment, fromBlock, toBlock);
        const discovered = logs
          .filter((log): log is RegistrationEventLog & { args: { transactionId: Hex }; blockNumber: bigint } => Boolean(log.args?.transactionId) && log.blockNumber !== null)
          .map((log) => ({ transactionId: log.args.transactionId, blockNumber: log.blockNumber }))
          .sort((left, right) => left.blockNumber > right.blockNumber ? -1 : left.blockNumber < right.blockNumber ? 1 : 0);
        const knownIds = new Set(candidates.map((candidate) => candidate.transactionId.toLowerCase()));
        candidates = [
          ...candidates,
          ...discovered.filter((candidate) => !knownIds.has(candidate.transactionId.toLowerCase())),
        ];
        cursor = fromBlock > verificationFloorRef.current ? fromBlock - 1n : verificationFloorRef.current;
        hasMore = fromBlock > verificationFloorRef.current;
        scans += 1;
      }

      const nextCandidates = candidates.slice(verificationEntries.length, desiredCount);
      const summaries = await Promise.all(nextCandidates.map((candidate) => readVerificationEntry(candidate, addresses)));

      verificationCandidatesRef.current = candidates;
      verificationCursorRef.current = cursor;
      verificationHasMoreRef.current = hasMore;
      setVerificationHasMore(hasMore);
      setVerificationEntries((current) => {
        const combined = [...current, ...summaries];
        const seen = new Set<string>();
        return combined.filter((entry) => {
          const key = entry.transactionId.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
    } catch (error) {
      setVerificationError(errorMessage(error));
    } finally {
      setVerificationBusy(false);
    }
  }

  async function initializeVerificationCursor() {
    const [chainId, finalizedBlock] = await Promise.all([
      withDiscoveryRetry(() => discoveryClient.getChainId()),
      withDiscoveryRetry(() => discoveryClient.getBlock({ blockTag: "finalized" })),
    ]);
    if (chainId !== sepolia.id) throw new Error(`Configured discovery RPC is on chain ${chainId}, not Sepolia.`);
    const deploymentBlock = process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK
      ? BigInt(process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK)
      : 0n;
    const endBlock = finalizedBlock.number;
    verificationFloorRef.current = deploymentBlock;
    verificationCursorRef.current = endBlock;
    verificationCandidatesRef.current = [];
    verificationHasMoreRef.current = endBlock >= deploymentBlock;
    setVerificationHasMore(endBlock >= deploymentBlock);
  }

  useEffect(() => {
    if (!addresses) return;
    let cancelled = false;
    async function initializeVerification() {
      setVerificationBusy(true);
      setVerificationError(null);
      try {
        await initializeVerificationCursor();
        if (!cancelled) {
          setVerificationEntries([]);
          await loadVerificationBatch(2);
        }
      } catch (error) {
        if (!cancelled) {
          setVerificationError(discoveryErrorMessage(error));
          setVerificationBusy(false);
        }
      }
    }
    void initializeVerification();
    return () => { cancelled = true; };
  }, [addresses]);

  async function retryVerificationScan() {
    if (!addresses || verificationBusy) return;
    setVerificationBusy(true);
    setVerificationError(null);
    try {
      await initializeVerificationCursor();
      setVerificationEntries([]);
      await loadVerificationBatch(2);
    } catch (error) {
      setVerificationError(discoveryErrorMessage(error));
    } finally {
      setVerificationBusy(false);
    }
  }

  async function loadMoreVerification() {
    await loadVerificationBatch(2);
  }

  async function connectWallet() {
    setActionError(null);
    setIsConnecting(true);
    try {
      const provider = getInjectedProvider();
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !isAddress(accounts[0])) {
        throw new Error("Wallet did not return a valid account");
      }
      const walletState = await readWalletState(provider);
      setAddress(walletState.address);
      setChainId(walletState.chainId);
      setIsConnected(walletState.address !== null);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setIsConnecting(false);
    }
  }

  function forgetWallet() {
    setAddress(null);
    setIsConnected(false);
  }

  async function changeWalletChain(requiredChainId: number): Promise<boolean> {
    setActionError(null);
    setIsSwitching(true);
    try {
      const provider = getInjectedProvider();
      await switchWalletChain(provider, requiredChainId);
      const walletState = await readWalletState(provider);
      setAddress(walletState.address);
      setChainId(walletState.chainId);
      return true;
    } catch (error) {
      setActionError(`Could not switch wallet chain: ${errorMessage(error)}`);
      return false;
    } finally {
      setIsSwitching(false);
    }
  }

  useEffect(() => {
    if (activeActionPanel !== "prepared") return;
    let cancelled = false;
    async function checkPreparedDemoReadiness() {
      setPreparedDemoReady(false);
      setPreparedDemoVerification(null);
      setPreparedDemoCheckError(null);
      setPreparedDemoCheckBusy(false);
      if (!addresses) {
        setPreparedDemoCheckError("Configure the deployed contract addresses before registration.");
        return;
      }
      if (!address || address.toLowerCase() !== PREPARED_DEMO_BUYER.toLowerCase()) {
        setPreparedDemoCheckError("Connect Alice’s wallet to enable this registration.");
        return;
      }
      if (chainId !== sepolia.id) {
        setPreparedDemoCheckError("Select Ethereum Sepolia (chain ID 11155111) in Coinbase Wallet.");
        return;
      }

      setPreparedDemoCheckBusy(true);
      try {
        const liveWalletState = await readWalletState(getInjectedProvider());
        if (!liveWalletState.address || liveWalletState.address.toLowerCase() !== PREPARED_DEMO_BUYER.toLowerCase()) {
          throw new Error("The connected wallet account is not Alice.");
        }
        if (liveWalletState.chainId !== sepolia.id) throw new Error("Connect Alice’s wallet to Ethereum Sepolia (11155111).");
        if (
          addresses.payment.toLowerCase() !== PREPARED_DEMO_TERMS.paymentContract.toLowerCase() ||
          addresses.asset.toLowerCase() !== PREPARED_DEMO_TERMS.assetSettlement.toLowerCase() ||
          addresses.paymentToken.toLowerCase() !== PREPARED_DEMO_TERMS.paymentInputToken.toLowerCase() ||
          addresses.paymentToken.toLowerCase() !== PREPARED_DEMO_TERMS.paymentToken.toLowerCase() ||
          addresses.assetToken.toLowerCase() !== PREPARED_DEMO_TERMS.assetToken.toLowerCase()
        ) throw new Error("Configured deployment addresses do not match the prepared demo Terms.");

        const [latestBlock, onChainTermsHash] = await Promise.all([
          paymentClient.getBlock({ blockTag: "latest" }),
          paymentClient.readContract({
            address: PREPARED_DEMO_TERMS.paymentContract,
            abi: decisionPaymentSettlementAbi,
            functionName: "computeTermsHash",
            args: [PREPARED_DEMO_TERMS],
          }),
        ]);
        if (cancelled) return;
        if (hashTerms(PREPARED_DEMO_TERMS).toLowerCase() !== PREPARED_DEMO_TERMS_HASH.toLowerCase()) {
          throw new Error("Prepared Terms do not match the expected termsHash.");
        }
        if (onChainTermsHash.toLowerCase() !== PREPARED_DEMO_TERMS_HASH.toLowerCase()) {
          throw new Error("Sepolia computeTermsHash did not match the expected termsHash.");
        }
        const safetyWindow = 5n * 60n;
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (now + safetyWindow >= PREPARED_DEMO_TERMS.expiresAt) {
          throw new Error("Prepared Terms are expired or within the five-minute signing safety window.");
        }
        if (latestBlock.timestamp + safetyWindow >= PREPARED_DEMO_TERMS.expiresAt) {
          throw new Error("Latest Sepolia block is expired or within the five-minute signing safety window.");
        }

        let transactionIsRegistered = false;
        try {
          await paymentClient.readContract({
            address: PREPARED_DEMO_TERMS.paymentContract,
            abi: decisionPaymentSettlementAbi,
            functionName: "getTransaction",
            args: [PREPARED_DEMO_TERMS.transactionId],
          });
          transactionIsRegistered = true;
        } catch (error) {
          if (!isTransactionNotFound(error)) throw error;
        }
        if (transactionIsRegistered) throw new Error("This prepared transaction ID is already registered.");

        await paymentClient.simulateContract({
          address: PREPARED_DEMO_TERMS.paymentContract,
          abi: decisionPaymentSettlementAbi,
          functionName: "registerTransaction",
          args: [PREPARED_DEMO_TERMS],
          account: PREPARED_DEMO_BUYER,
        });
        const verifiedBlock = await paymentClient.getBlock({ blockTag: "latest" });
        const verifiedNow = BigInt(Math.floor(Date.now() / 1000));
        if (verifiedNow + safetyWindow >= PREPARED_DEMO_TERMS.expiresAt || verifiedBlock.timestamp + safetyWindow >= PREPARED_DEMO_TERMS.expiresAt) {
          throw new Error("Prepared Terms entered the five-minute signing safety window during verification.");
        }
        if (!cancelled) {
          setPreparedDemoVerification({
            checkedAt: Date.now(),
            blockNumber: verifiedBlock.number ?? 0n,
            blockTimestamp: verifiedBlock.timestamp,
          });
          setPreparedDemoReady(true);
        }
      } catch (error) {
        if (!cancelled) setPreparedDemoCheckError(`Prepared registration is not ready: ${errorMessage(error)}`);
      } finally {
        if (!cancelled) setPreparedDemoCheckBusy(false);
      }
    }
    void checkPreparedDemoReadiness();
    return () => { cancelled = true; };
  }, [activeActionPanel, address, addresses, chainId]);

  async function registerPreparedDemo() {
    let submittedHash: Hex | null = null;
    let receiptReverted = false;
    let receiptIncluded = false;
    setActionError(null);
    setSuccessMessage(null);
    setPreparedDemoCheckError(null);
    setPreparedDemoReady(false);
    setPreparedDemoVerification(null);
    setPreparedDemoSubmission(null);
    setAgreementDraft(null);
    setAgreementSubmission(null);
    setBusyAction("prepared-demo");
    try {
      if (!addresses) throw new Error("Contract configuration is unavailable.");
      if (
        addresses.payment.toLowerCase() !== PREPARED_DEMO_TERMS.paymentContract.toLowerCase() ||
        addresses.asset.toLowerCase() !== PREPARED_DEMO_TERMS.assetSettlement.toLowerCase() ||
        addresses.paymentToken.toLowerCase() !== PREPARED_DEMO_TERMS.paymentToken.toLowerCase() ||
        addresses.assetToken.toLowerCase() !== PREPARED_DEMO_TERMS.assetToken.toLowerCase()
      ) throw new Error("Configured deployment addresses do not match the prepared demo Terms.");
      const provider = getInjectedProvider();
      const walletState = await readWalletState(provider);
      if (!walletState.address || walletState.address.toLowerCase() !== PREPARED_DEMO_BUYER.toLowerCase()) {
        throw new Error("Coinbase Wallet account changed. Reconnect Alice’s wallet and recheck readiness.");
      }
      if (walletState.chainId !== sepolia.id) throw new Error("Select Ethereum Sepolia (chain ID 11155111) before signing.");

      setPreparedDemoCheckBusy(true);
      const latestBlock = await paymentClient.getBlock({ blockTag: "latest" });
      const now = BigInt(Math.floor(Date.now() / 1000));
      const safetyWindow = 5n * 60n;
      if (now + safetyWindow >= PREPARED_DEMO_TERMS.expiresAt || latestBlock.timestamp + safetyWindow >= PREPARED_DEMO_TERMS.expiresAt) {
        throw new Error("Prepared Terms are expired or within the five-minute signing safety window. Do not sign.");
      }
      const [onChainTermsHash, computedTermsHash] = await Promise.all([
        paymentClient.readContract({
          address: PREPARED_DEMO_TERMS.paymentContract,
          abi: decisionPaymentSettlementAbi,
          functionName: "computeTermsHash",
          args: [PREPARED_DEMO_TERMS],
        }),
        Promise.resolve(hashTerms(PREPARED_DEMO_TERMS)),
      ]);
      if (onChainTermsHash.toLowerCase() !== PREPARED_DEMO_TERMS_HASH.toLowerCase() || computedTermsHash.toLowerCase() !== PREPARED_DEMO_TERMS_HASH.toLowerCase()) {
        throw new Error("Prepared Terms hash verification failed.");
      }
      let transactionIsRegistered = false;
      try {
        await paymentClient.readContract({
          address: PREPARED_DEMO_TERMS.paymentContract,
          abi: decisionPaymentSettlementAbi,
          functionName: "getTransaction",
          args: [PREPARED_DEMO_TERMS.transactionId],
        });
        transactionIsRegistered = true;
      } catch (error) {
        if (!isTransactionNotFound(error)) throw error;
      }
      if (transactionIsRegistered) throw new Error("This prepared transaction ID is already registered.");
      await paymentClient.simulateContract({
        address: PREPARED_DEMO_TERMS.paymentContract,
        abi: decisionPaymentSettlementAbi,
        functionName: "registerTransaction",
        args: [PREPARED_DEMO_TERMS],
        account: PREPARED_DEMO_BUYER,
      });
      const verifiedBlock = await paymentClient.getBlock({ blockTag: "latest" });
      const verifiedNow = BigInt(Math.floor(Date.now() / 1000));
      if (verifiedNow + safetyWindow >= PREPARED_DEMO_TERMS.expiresAt || verifiedBlock.timestamp + safetyWindow >= PREPARED_DEMO_TERMS.expiresAt) {
        throw new Error("Prepared Terms entered the five-minute signing safety window during verification. Do not sign.");
      }
      const verifiedWalletState = await readWalletState(provider);
      if (!verifiedWalletState.address || verifiedWalletState.address.toLowerCase() !== PREPARED_DEMO_BUYER.toLowerCase() || verifiedWalletState.chainId !== sepolia.id) {
        throw new Error("Coinbase Wallet account or network changed during verification. Reconnect Alice on Ethereum Sepolia.");
      }
      setPreparedDemoVerification({ checkedAt: Date.now(), blockNumber: verifiedBlock.number ?? 0n, blockTimestamp: verifiedBlock.timestamp });
      setPreparedDemoReady(true);
      setPreparedDemoCheckBusy(false);

      const walletClient = createTransactionWalletClient(provider, PREPARED_DEMO_BUYER, sepolia.id);
      const hash = await walletClient.writeContract({
        address: PREPARED_DEMO_TERMS.paymentContract,
        abi: decisionPaymentSettlementAbi,
        functionName: "registerTransaction",
        args: [PREPARED_DEMO_TERMS],
        gas: await paymentClient.estimateContractGas({
          address: PREPARED_DEMO_TERMS.paymentContract,
          abi: decisionPaymentSettlementAbi,
          functionName: "registerTransaction",
          args: [PREPARED_DEMO_TERMS],
          account: PREPARED_DEMO_BUYER,
        }),
      });
      submittedHash = hash;
      setPreparedDemoSubmission({ hash, status: "pending" });
      let receipt: VerifiedReceipt;
      try {
        receipt = await waitForSuccess(sepolia.id, hash, PREPARED_DEMO_TERMS.transactionId, PREPARED_DEMO_TERMS.paymentContract);
      } catch (error) {
        receiptReverted = errorMessage(error).includes("reverted");
        throw error;
      }
      receiptIncluded = true;
      recordReceipt(sepolia.id, PREPARED_DEMO_TERMS.transactionId, PREPARED_DEMO_TERMS.paymentContract, "Agreement registered", receipt);
      setPreparedDemoSubmission({ hash, status: "included" });
      await recordRegistrationInclusion(PREPARED_DEMO_TERMS, PREPARED_DEMO_TERMS_HASH, receipt);
      await refreshTransaction(PREPARED_DEMO_TERMS.transactionId, receipt);
      window.history.replaceState(null, "", `/?id=${PREPARED_DEMO_TERMS.transactionId}`);
      setPreparedDemoReady(false);
    } catch (error) {
      setPreparedDemoCheckBusy(false);
      const message = errorMessage(error);
      if (!submittedHash) {
        setPreparedDemoReady(false);
        setPreparedDemoCheckError(`Prepared registration could not continue: ${message}`);
      }
      if (receiptIncluded) {
        setActionError(null);
      } else {
        setActionError(submittedHash && !receiptReverted
          ? `Transaction submitted; receipt is still pending. ${message}`
          : message);
      }
      if (submittedHash) setPreparedDemoSubmission({ hash: submittedHash, status: receiptReverted ? "failure" : receiptIncluded ? "included" : "pending" });
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    const sharedTransactionId = new URLSearchParams(window.location.search).get("id");
    if (sharedTransactionId && /^0x[0-9a-fA-F]{64}$/.test(sharedTransactionId)) {
      void refreshTransaction(sharedTransactionId as Hex);
    }
  }, [refreshTransaction]);

  useEffect(() => {
    if (!snapshot) return;
    const timer = window.setInterval(() => {
      void refreshTransaction(snapshot.terms.transactionId);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [refreshTransaction, snapshot]);

  async function waitForSuccess(
    chainIdToRead: number,
    hash: Hex,
    transactionId: Hex,
    contractAddress: Address,
  ): Promise<VerifiedReceipt> {
    const client = chainIdToRead === sepolia.id ? paymentClient : assetClient;
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      setReferences((current) => [
        ...current,
        {
          chainId: chainIdToRead,
          hash,
          transactionId,
          contractAddress,
          blockNumber: receipt.blockNumber,
          label: "Reverted transaction",
          status: "reverted",
        },
      ]);
      throw new Error(`Transaction ${hash} reverted; the failed receipt is shown in lifecycle evidence`);
    }
    return { hash, blockNumber: receipt.blockNumber, status: "success" };
  }

  async function recordRegistrationInclusion(terms: Terms, termsHash: Hex, receipt: VerifiedReceipt) {
    setRegistrationConfirmation({
      transactionId: terms.transactionId,
      termsHash,
      buyer: terms.buyer,
      receipt,
      eventVerified: false,
      eventError: null,
      finalized: false,
    });
    try {
      const event = await verifyRegistrationReceipt(terms, termsHash, receipt);
      setRegistrationConfirmation((current) => current?.receipt.hash.toLowerCase() === receipt.hash.toLowerCase()
        ? { ...current, ...event, eventVerified: true, eventError: null }
        : current);
    } catch (error) {
      setRegistrationConfirmation((current) => current?.receipt.hash.toLowerCase() === receipt.hash.toLowerCase()
        ? { ...current, eventError: errorMessage(error) }
        : current);
    }
  }

  function recordReceipt(
    chainId: number,
    transactionId: Hex,
    contractAddress: Address,
    label: string,
    receipt: VerifiedReceipt,
  ) {
    setReferences((current) => [
      ...current,
      {
        chainId,
        transactionId,
        contractAddress,
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        label,
        status: receipt.status,
      },
    ]);
  }

  async function requireWalletOnChain(requiredChainId: number): Promise<boolean> {
    if (!address) throw new Error("Connect a wallet before sending a transaction");
    if (chainId !== requiredChainId) {
      if (!(await changeWalletChain(requiredChainId))) return false;
      setSuccessMessage("Wallet switched. Submit the action again to confirm it on the selected chain.");
      return false;
    }
    return true;
  }

  async function createTransaction(event: FormEvent<HTMLFormElement>, preparedDraft?: AgreementDraft) {
    event.preventDefault();
    if (!address || !addresses) return;
    setActionError(null);
    setSuccessMessage(null);
    setBusyAction("create");

    try {
      if (!(await requireWalletOnChain(sepolia.id))) {
        return;
      }

      const walletClient = createTransactionWalletClient(getInjectedProvider(), address, sepolia.id);
      const draft = preparedDraft ?? agreementDraft ?? buildAgreementDraft({
        buyerInput: address,
        sellerInput,
        paymentChainInput,
        assetChainInput,
        paymentTokenInput: paymentInputToken,
        assetTokenInput,
        paymentAmountInput,
        assetAmountInput,
        expiryMinutesInput,
        paymentDecimals: paymentTokenDecimals,
        assetDecimals: assetTokenDecimals,
        paymentContract: addresses.payment,
        assetSettlement: addresses.asset,
      });
      const { terms, termsHash } = draft;
      setAgreementSubmission({ terms, termsHash, transactionHash: null, status: "pending", receipt: null, error: null });
      if (terms.buyer.toLowerCase() !== address.toLowerCase()) {
        throw new Error("The connected buyer account changed after preview. Review the updated Terms.");
      }
      if (terms.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) {
        throw new Error("The agreement expired before submission. Generate a fresh preview.");
      }
      await paymentClient.simulateContract({
        address: terms.paymentContract,
        abi: decisionPaymentSettlementAbi,
        functionName: "registerTransaction",
        args: [terms],
        account: address,
      });
      const hash = await walletClient.writeContract({
        address: terms.paymentContract,
        abi: decisionPaymentSettlementAbi,
        functionName: "registerTransaction",
        args: [terms],
        gas: await paymentClient.estimateContractGas({
          address: terms.paymentContract,
          abi: decisionPaymentSettlementAbi,
          functionName: "registerTransaction",
          args: [terms],
          account: address,
        }),
      });
      setAgreementSubmission({ terms, termsHash, transactionHash: hash, status: "pending", receipt: null, error: null });
      const receipt = await waitForSuccess(sepolia.id, hash, terms.transactionId, terms.paymentContract);
      recordReceipt(sepolia.id, terms.transactionId, terms.paymentContract, "Agreement registered", receipt);
      setAgreementSubmission({ terms, termsHash, transactionHash: hash, status: "included", receipt, error: null });
      setTransactionIdInput(terms.transactionId);
      setSnapshot(null);
      window.history.replaceState(null, "", `/?id=${terms.transactionId}`);
      await recordRegistrationInclusion(terms, termsHash, receipt);
      await refreshTransaction(terms.transactionId, receipt);
      setAgreementSubmission({ terms, termsHash, transactionHash: hash, status: "finalized", receipt, error: null });
    } catch (error) {
      const message = error instanceof Error && (error.name === "UserRejectedRequestError" || /user rejected|user denied|request rejected/i.test(error.message))
        ? "Registration was rejected in the wallet. No agreement was registered."
        : errorMessage(error);
      setAgreementSubmission((current) => current && current.status !== "finalized"
        ? { ...current, status: /reverted|failed receipt/i.test(message) ? "failed" : current.status, error: message }
        : current);
      setAgreementFormError(message);
      setActionError(message);
    } finally {
      setBusyAction(null);
    }
  }

  async function lockPayment() {
    if (!snapshot || !addresses || !address) return;
    setActionError(null);
    setSuccessMessage(null);
    setBusyAction("payment");
    try {
      if (!(await requireWalletOnChain(sepolia.id))) {
        return;
      }
      if (address.toLowerCase() !== snapshot.terms.buyer.toLowerCase()) {
        throw new Error("Only the agreed buyer wallet can lock this payment");
      }

      // Latest is a duplicate/expiry safety guard only; displayed lifecycle state stays finalized-only.
      const [latestBlock, latestPayment] = await Promise.all([
        paymentClient.getBlock({ blockTag: "latest" }),
        paymentClient.readContract({
          address: addresses.payment,
          abi: decisionPaymentSettlementAbi,
          functionName: "getTransaction",
          args: [snapshot.terms.transactionId],
          blockTag: "latest",
        }),
      ]);
      if (
        latestPayment[0].transactionId.toLowerCase() !== snapshot.terms.transactionId.toLowerCase() ||
        latestPayment[1].toLowerCase() !== snapshot.termsHash.toLowerCase()
      ) {
        throw new Error("Latest Sepolia Terms do not match the finalized agreement. No approval was sent.");
      }
      if (latestPayment[3] !== 0) {
        throw new Error("Payment is already locked in Sepolia latest state; finalized state may still be catching up. Do not retry while awaiting finality.");
      }
      if (latestPayment[2] !== 0) {
        throw new Error("A decision is already recorded in Sepolia latest state. No approval was sent.");
      }
      if (latestBlock.timestamp >= snapshot.terms.expiresAt) {
        throw new Error("The agreement has expired at latest Sepolia block time. No approval was sent.");
      }
      const buyerBalance = await paymentClient.readContract({
        address: snapshot.terms.paymentInputToken,
        abi: mockErc20Abi,
        functionName: "balanceOf",
        args: [address],
        blockTag: "latest",
      });
      if (buyerBalance < snapshot.terms.paymentInputAmount) {
        throw new Error(`Insufficient Sepolia RDT: need ${formatUnits(snapshot.terms.paymentInputAmount, 18)}, have ${formatUnits(buyerBalance, 18)}. No approval was sent.`);
      }

      const walletClient = createTransactionWalletClient(getInjectedProvider(), address, sepolia.id);
      const approvalHash = await walletClient.writeContract({
        address: snapshot.terms.paymentInputToken,
        abi: mockErc20Abi,
        functionName: "approve",
        args: [addresses.payment, snapshot.terms.paymentInputAmount],
        gas: await paymentClient.estimateContractGas({
          address: snapshot.terms.paymentInputToken,
          abi: mockErc20Abi,
          functionName: "approve",
          args: [addresses.payment, snapshot.terms.paymentInputAmount],
          account: address,
        }),
      });
      const approvalReceipt = await waitForSuccess(
        sepolia.id,
        approvalHash,
        snapshot.terms.transactionId,
        snapshot.terms.paymentInputToken,
      );
      recordReceipt(sepolia.id, snapshot.terms.transactionId, snapshot.terms.paymentInputToken, "Payment approval", approvalReceipt);
      const verifiedAllowance = await paymentClient.readContract({
        address: snapshot.terms.paymentInputToken,
        abi: mockErc20Abi,
        functionName: "allowance",
        args: [address, addresses.payment],
        blockTag: "latest",
      });
      if (verifiedAllowance !== snapshot.terms.paymentInputAmount) {
        throw new Error(`Approval did not set an exact ${formatUnits(snapshot.terms.paymentInputAmount, 18)} RDT allowance. Lock was not submitted.`);
      }
      const lockPreflightBlock = await paymentClient.getBlock({ blockTag: "latest" });
      const lockPreflightState = await paymentClient.readContract({
        address: addresses.payment,
        abi: decisionPaymentSettlementAbi,
        functionName: "getTransaction",
        args: [snapshot.terms.transactionId],
        blockTag: "latest",
      });
      if (
        lockPreflightState[1].toLowerCase() !== snapshot.termsHash.toLowerCase() ||
        lockPreflightState[2] !== 0 ||
        lockPreflightState[3] !== 0 ||
        lockPreflightBlock.timestamp >= snapshot.terms.expiresAt
      ) {
        throw new Error("Latest Sepolia lock preflight changed after approval. Lock was not submitted.");
      }

      await paymentClient.simulateContract({
        address: addresses.payment,
        abi: decisionPaymentSettlementAbi,
        functionName: "lockPayment",
        args: [snapshot.terms.transactionId, snapshot.termsHash],
        account: address,
      });
      const lockHash = await walletClient.writeContract({
        address: addresses.payment,
        abi: decisionPaymentSettlementAbi,
        functionName: "lockPayment",
        args: [snapshot.terms.transactionId, snapshot.termsHash],
        gas: await paymentClient.estimateContractGas({
          address: addresses.payment,
          abi: decisionPaymentSettlementAbi,
          functionName: "lockPayment",
          args: [snapshot.terms.transactionId, snapshot.termsHash],
          account: address,
        }),
      });
      const lockReceipt = await waitForSuccess(sepolia.id, lockHash, snapshot.terms.transactionId, addresses.payment);
      recordReceipt(sepolia.id, snapshot.terms.transactionId, addresses.payment, "Payment locked", lockReceipt);
      await refreshTransaction(snapshot.terms.transactionId);
      setSuccessMessage("Payment reservation confirmed on Ethereum Sepolia.");
    } catch (error) {
      setActionError(transactionErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function lockAsset() {
    if (!snapshot || !addresses || !address) return;
    setActionError(null);
    setSuccessMessage(null);
    setBusyAction("asset");
    try {
      if (!(await requireWalletOnChain(baseSepolia.id))) {
        return;
      }
      if (address.toLowerCase() !== snapshot.terms.seller.toLowerCase()) {
        throw new Error("Only the agreed seller wallet can lock this asset");
      }

      const walletClient = createTransactionWalletClient(
        getInjectedProvider(),
        address,
        baseSepolia.id,
      );
      const approvalHash = await walletClient.writeContract({
        address: snapshot.terms.assetToken,
        abi: mockErc20Abi,
        functionName: "approve",
        args: [addresses.asset, snapshot.terms.assetAmount],
      });
      const approvalReceipt = await waitForSuccess(
        baseSepolia.id,
        approvalHash,
        snapshot.terms.transactionId,
        snapshot.terms.assetToken,
      );
      recordReceipt(baseSepolia.id, snapshot.terms.transactionId, snapshot.terms.assetToken, "Asset approval", approvalReceipt);

      const lockHash = await walletClient.writeContract({
        address: addresses.asset,
        abi: assetSettlementAbi,
        functionName: "lockAsset",
        args: [snapshot.terms, snapshot.termsHash],
      });
      const lockReceipt = await waitForSuccess(baseSepolia.id, lockHash, snapshot.terms.transactionId, addresses.asset);
      recordReceipt(baseSepolia.id, snapshot.terms.transactionId, addresses.asset, "Asset locked", lockReceipt);
      await refreshTransaction(snapshot.terms.transactionId);
      setSuccessMessage("Asset reservation confirmed on Base Sepolia.");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function abortTransaction() {
    if (!snapshot || !addresses || !address) return;
    setActionError(null);
    setSuccessMessage(null);
    setBusyAction("abort");
    try {
      if (!(await requireWalletOnChain(sepolia.id))) {
        return;
      }
      const walletClient = createTransactionWalletClient(getInjectedProvider(), address, sepolia.id);
      const hash = await walletClient.writeContract({
        address: addresses.payment,
        abi: decisionPaymentSettlementAbi,
        functionName: "abort",
        args: [snapshot.terms.transactionId],
        gas: await paymentClient.estimateContractGas({
          address: addresses.payment,
          abi: decisionPaymentSettlementAbi,
          functionName: "abort",
          args: [snapshot.terms.transactionId],
          account: address,
        }),
      });
      const receipt = await waitForSuccess(sepolia.id, hash, snapshot.terms.transactionId, addresses.payment);
      recordReceipt(sepolia.id, snapshot.terms.transactionId, addresses.payment, "Chain A abort", receipt);
      await refreshTransaction(snapshot.terms.transactionId);
      setSuccessMessage("Chain A recorded ABORT. Any locked Base asset remains reserved until CRE relays ABORT.");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function publishArkivEvidence() {
    if (!snapshot || !addresses || !address) return;
    setArkivError(null);
    setArkivBusy(true);
    try {
      if (chainId !== arkivChain.id) {
        if (await changeWalletChain(arkivChain.id)) {
          setSuccessMessage("Wallet switched to Rabdi. Submit the Arkiv action again.");
        }
        return;
      }

      const paymentFinalizedBlock = await paymentClient.getBlock({ blockTag: "finalized" });
      const [currentDecision, currentPayment, currentAsset] = await Promise.all([
        paymentClient.readContract({
          address: addresses.payment,
          abi: decisionPaymentSettlementAbi,
          functionName: "getDecision",
          args: [snapshot.terms.transactionId],
          blockNumber: paymentFinalizedBlock.number,
        }),
        paymentClient.readContract({
          address: addresses.payment,
          abi: decisionPaymentSettlementAbi,
          functionName: "getTransaction",
          args: [snapshot.terms.transactionId],
          blockNumber: paymentFinalizedBlock.number,
        }),
        assetClient.readContract({
          address: addresses.asset,
          abi: assetSettlementAbi,
          functionName: "getAssetReservation",
          args: [snapshot.terms.transactionId],
          blockTag: "finalized",
        }),
      ]);
      const decision = BigInt(currentDecision[0]);
      const paymentStatus = BigInt(currentPayment[3]);
      const assetStatus = BigInt(currentAsset[2]);
      if (
        currentDecision[1].toLowerCase() !== snapshot.termsHash.toLowerCase() ||
        currentPayment[1].toLowerCase() !== snapshot.termsHash.toLowerCase() ||
        (assetStatus > 0n && currentAsset[1].toLowerCase() !== snapshot.termsHash.toLowerCase())
      ) {
        throw new Error("Finalized chain state is bound to a different terms hash");
      }
      const finalStatus = statusLabel(decision, paymentStatus, assetStatus);
      if (finalStatus !== "SETTLED" && finalStatus !== "RELEASED") {
        throw new Error("Publish evidence only after both obligations have a finalized outcome");
      }

      const paymentEvent = decision === 1n
        ? parseAbiItem("event PaymentExecuted(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount)")
        : parseAbiItem("event PaymentReleased(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount)");
      const paymentLogs = await scanSepoliaFinalizedLogs(
        process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK
          ? BigInt(process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK)
          : 0n,
        paymentFinalizedBlock.number,
        (fromBlock, toBlock) => withDiscoveryRetry(() => paymentClient.getLogs({
          address: addresses.payment,
          event: paymentEvent,
          args: { transactionId: snapshot.terms.transactionId },
          fromBlock,
          toBlock,
        })),
      );
      const assetLogs = assetStatus === 2n
        ? await assetClient.getLogs({
            address: addresses.asset,
            event: parseAbiItem("event AssetDelivered(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount)"),
            args: { transactionId: snapshot.terms.transactionId },
            fromBlock: process.env.NEXT_PUBLIC_ASSET_DEPLOYMENT_BLOCK
              ? BigInt(process.env.NEXT_PUBLIC_ASSET_DEPLOYMENT_BLOCK)
              : 0n,
            toBlock: "finalized",
          })
        : assetStatus === 3n
          ? await assetClient.getLogs({
              address: addresses.asset,
              event: parseAbiItem("event AssetReleased(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount)"),
              args: { transactionId: snapshot.terms.transactionId },
              fromBlock: process.env.NEXT_PUBLIC_ASSET_DEPLOYMENT_BLOCK
                ? BigInt(process.env.NEXT_PUBLIC_ASSET_DEPLOYMENT_BLOCK)
                : 0n,
              toBlock: "finalized",
            })
          : [];

      const paymentLog = paymentLogs[0];
      if (paymentStatus > 0n && !paymentLog) {
        throw new Error("Finalized Chain A payment event was not found; evidence was not published");
      }
      if (paymentLog) {
        const expectedRecipient = decision === 1n ? snapshot.terms.seller : snapshot.terms.buyer;
        const expectedAmount = decision === 1n
          ? snapshot.terms.paymentAmount
          : snapshot.terms.paymentInputAmount;
        const eventTermsHash = paymentLog.args.termsHash;
        const eventRecipient = paymentLog.args.recipient;
        if (
          !eventTermsHash ||
          !eventRecipient ||
          eventTermsHash.toLowerCase() !== snapshot.termsHash.toLowerCase() ||
          eventRecipient.toLowerCase() !== expectedRecipient.toLowerCase() ||
          paymentLog.args.amount !== expectedAmount
        ) {
          throw new Error("Finalized Chain A payment event does not match the agreed terms");
        }
      }

      const assetLog = assetLogs[0];
      if ((assetStatus === 2n || assetStatus === 3n) && !assetLog) {
        throw new Error("Finalized Chain B execution event was not found; evidence was not published");
      }
      if (assetLog) {
        const expectedRecipient = decision === 1n ? snapshot.terms.buyer : snapshot.terms.seller;
        const eventTermsHash = assetLog.args.termsHash;
        const eventRecipient = assetLog.args.recipient;
        if (
          !eventTermsHash ||
          !eventRecipient ||
          eventTermsHash.toLowerCase() !== snapshot.termsHash.toLowerCase() ||
          eventRecipient.toLowerCase() !== expectedRecipient.toLowerCase() ||
          assetLog.args.amount !== snapshot.terms.assetAmount
        ) {
          throw new Error("Finalized Chain B execution event does not match the agreed terms");
        }
      }

      const walletProvider = getInjectedProvider();
      const record = await createEvidence(walletProvider, address, {
        transactionId: snapshot.terms.transactionId,
        termsHash: snapshot.termsHash,
        buyer: snapshot.terms.buyer,
        seller: snapshot.terms.seller,
        paymentChainId: 11155111,
        paymentContract: snapshot.terms.paymentContract,
        assetChainId: 84532,
        assetContract: snapshot.terms.assetSettlement,
        decision: decision === 1n ? "COMMIT" : "ABORT",
        decisionRecordId: currentDecision[4],
        status: finalStatus,
        ...(paymentLog?.transactionHash ? { paymentTxHash: paymentLog.transactionHash } : {}),
        ...(assetLog?.transactionHash ? { assetTxHash: assetLog.transactionHash } : {}),
        updatedAt: BigInt(Math.floor(Date.now() / 1000)),
      });

      const arkivTxHash = record.txHash;
      if (arkivTxHash) {
        await arkivPublicClient.waitForTransactionReceipt({ hash: arkivTxHash });
      }
      setArkivResult(record);
      setSuccessMessage(
        record.created ? "Public Arkiv evidence created and retrieved." : "Existing Arkiv evidence retrieved.",
      );
    } catch (error) {
      setArkivError(errorMessage(error));
    } finally {
      setArkivBusy(false);
    }
  }

  async function retrieveArkivEvidence() {
    if (!snapshot) return;
    setArkivError(null);
    setArkivBusy(true);
    try {
      const result = await findEvidence(snapshot.terms.transactionId, snapshot.termsHash);
      if (!result) throw new Error("No Arkiv entity matches this transaction ID");
      setArkivResult(result);
    } catch (error) {
      setArkivError(errorMessage(error));
    } finally {
      setArkivBusy(false);
    }
  }

  async function loadTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionIdInput)) {
      setReadError("Transaction ID must be a 32-byte hex value");
      return;
    }
    setReadError(null);
    setBusyAction("read");
    try {
      await refreshTransaction(transactionIdInput as Hex);
    } finally {
      setBusyAction(null);
    }
  }

  const expired = snapshot !== null && snapshot.finalizedTimestamp >= snapshot.terms.expiresAt;
  const currentStatus = snapshot
    ? snapshot.decision === 0n && expired
      ? "EXPIRED_UNDECIDED"
      : statusLabel(snapshot.decision, snapshot.paymentStatus, snapshot.assetStatus)
    : null;
  const paymentLocked = snapshot !== null && snapshot.paymentStatus > 0n;
  const assetLocked = snapshot !== null && snapshot.assetStatus !== null && snapshot.assetStatus > 0n;
  const reservationCount = Number(paymentLocked) + Number(assetLocked);
  const decisionRecorded = snapshot !== null && snapshot.decision !== 0n;
  const activeLifecycleStage = !snapshot ? 0 : decisionRecorded ? 2 : 1;
  const paymentFailed = snapshot?.paymentStatus === 0n &&
    references.some((reference) => reference.status === "reverted" && reference.chainId === sepolia.id);
  const assetFailed = (snapshot?.assetStatus === 0n || snapshot?.assetStatus === null) &&
    references.some((reference) => reference.status === "reverted" && reference.chainId === baseSepolia.id);
  const ethereumReceiptEntries = getChainReceiptEntries(references, snapshot, sepolia.id);
  const baseReceiptEntries = getChainReceiptEntries(references, snapshot, baseSepolia.id);
  const currentArkivResult = arkivResult && snapshot &&
    arkivResult.transactionId.toLowerCase() === snapshot.terms.transactionId.toLowerCase() &&
    arkivResult.termsHash.toLowerCase() === snapshot.termsHash.toLowerCase()
    ? arkivResult
    : null;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="hero-copy">
          <p className="eyebrow">Ethereum Sepolia ↔ Base Sepolia</p>
          <h1>RaisinFi settlement workspace</h1>
          <p className="hero-description">
            Coordinate a payment and an asset across independent networks with one shared decision.
          </p>
        </div>
        <div className="network-art" role="img" aria-label="Ethereum Sepolia and Base Sepolia connected through RaisinFi decision coordination">
          <span className="network-endpoint endpoint-ethereum">
            <span className="endpoint-mark" aria-hidden="true"><span /></span>
            <span className="endpoint-copy"><strong>Ethereum Sepolia</strong><small>Chain A · decision register</small></span>
          </span>
          <span className="network-endpoint endpoint-base">
            <span className="endpoint-mark" aria-hidden="true"><span /></span>
            <span className="endpoint-copy"><strong>Base Sepolia</strong><small>Chain B · asset settlement</small></span>
          </span>
          <span className="coordination-label"><span />RAISINFI COORDINATION</span>
          <svg viewBox="0 0 600 220" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="route-warm" x1="85" y1="110" x2="300" y2="110" gradientUnits="userSpaceOnUse">
                <stop stopColor="#C8755E" stopOpacity=".25" />
                <stop offset="1" stopColor="#C8755E" stopOpacity=".9" />
              </linearGradient>
              <linearGradient id="route-sage" x1="300" y1="110" x2="515" y2="110" gradientUnits="userSpaceOnUse">
                <stop stopColor="#A5B095" stopOpacity=".9" />
                <stop offset="1" stopColor="#A5B095" stopOpacity=".25" />
              </linearGradient>
            </defs>
            <path className="network-branch" d="M160 110 225 55 300 110 375 55 440 110" />
            <path className="network-branch" d="m160 110 65 55 75-55 75 55 65-55" />
            <path className="network-route route-left" d="M83 110h85c50 0 71-55 132-55" />
            <path className="network-route route-left-low" d="M83 110h85c50 0 71 55 132 55" />
            <path className="network-route route-right" d="M300 55c61 0 82 55 132 55h85" />
            <path className="network-route route-right-low" d="M300 165c61 0 82-55 132-55h85" />
            <path className="network-signal signal-left" d="M83 110h85c50 0 71-55 132-55" />
            <path className="network-signal signal-right" d="M300 55c61 0 82 55 132 55h85" />
            <circle className="network-node node-edge node-origin" cx="83" cy="110" r="7" />
            <circle className="network-node node-branch node-copper" cx="168" cy="110" r="4" />
            <circle className="network-node node-branch node-sage" cx="225" cy="55" r="5" />
            <circle className="network-node node-branch node-sage" cx="225" cy="165" r="5" />
            <circle className="network-node node-center" cx="300" cy="110" r="11" />
            <circle className="network-node node-branch node-sage" cx="375" cy="55" r="5" />
            <circle className="network-node node-branch node-sage" cx="375" cy="165" r="5" />
            <circle className="network-node node-branch node-copper" cx="432" cy="110" r="4" />
            <circle className="network-node node-edge node-destination" cx="517" cy="110" r="7" />
            <circle className="network-ring" cx="300" cy="110" r="24" />
          </svg>
        </div>
        <div className="wallet">
          {isConnected && address ? (
            <>
              <span className="wallet-address">{address.slice(0, 6)}…{address.slice(-4)}</span>
              <button className="button secondary" onClick={forgetWallet}>Forget wallet</button>
            </>
          ) : (
            <button
              className="button"
              disabled={isConnecting}
              onClick={() => void connectWallet()}
            >
              {isConnecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>

      <section className="lifecycle-panel" aria-label="Transaction lifecycle canvas">
        <div className="lifecycle-heading">
          <div>
            <p className="eyebrow">Cross-chain coordination</p>
            <h2>Transaction lifecycle</h2>
            <p>Follow finalized agreement, reservation, and decision evidence across both networks.</p>
          </div>
          <span className="lifecycle-overall" data-state={snapshot ? currentStatus?.toLowerCase() : "pending"}>
            {snapshot ? currentStatus : "No transaction loaded"}
          </span>
        </div>

        <div className="lifecycle-stages">
          <article className={`lifecycle-stage${activeGuideStep === 0 ? " selected" : ""}${activeLifecycleStage === 0 && snapshot ? " current" : ""}`}>
            <button className="lifecycle-stage-heading" type="button" aria-expanded={activeGuideStep === 0} onClick={() => setActiveGuideStep(0)}>
              <span className="lifecycle-stage-number">01</span>
              <span className="lifecycle-stage-title"><small>AGREEMENT · ETHEREUM SEPOLIA</small><strong>Terms registered</strong></span>
              <span className="lifecycle-status" data-state={snapshot?.lifecycle.agreement ? "confirmed" : "pending"}>
                {snapshot?.lifecycle.agreement ? "CONFIRMED" : snapshot ? "VERIFYING" : "WAITING"}
              </span>
            </button>
            {activeGuideStep === 0 && (
              <div className="lifecycle-stage-content">
                {snapshot ? (
                  <>
                    <div className="lifecycle-parties">
                      <div><span>Buyer</span><code title={snapshot.terms.buyer}>{snapshot.terms.buyer}</code></div>
                      <div><span>Seller</span><code title={snapshot.terms.seller}>{snapshot.terms.seller}</code></div>
                    </div>
                    <dl className="lifecycle-facts">
                      <div><dt>Payment terms</dt><dd>{formatUnits(snapshot.terms.paymentAmount, 18)} · <code title={snapshot.terms.paymentToken}>{snapshot.terms.paymentToken}</code></dd></div>
                      <div><dt>Asset terms</dt><dd>{formatUnits(snapshot.terms.assetAmount, 18)} · <code title={snapshot.terms.assetToken}>{snapshot.terms.assetToken}</code></dd></div>
                      <div><dt>Expires</dt><dd>{new Date(Number(snapshot.terms.expiresAt) * 1000).toLocaleString()}</dd></div>
                      <div><dt>Transaction ID</dt><dd><code>{snapshot.terms.transactionId}</code></dd></div>
                      <div><dt>Terms hash</dt><dd><code>{snapshot.termsHash}</code></dd></div>
                    </dl>
                    <LifecycleReceipt chainId={sepolia.id} receipt={snapshot.lifecycle.agreement} label="Registration receipt" />
                  </>
                ) : (
                  <p className="lifecycle-empty">Create an agreement or load a transaction ID to inspect its finalized terms.</p>
                )}
              </div>
            )}
          </article>

          <article className={`lifecycle-stage${activeGuideStep === 1 ? " selected" : ""}${activeLifecycleStage === 1 && snapshot ? " current" : ""}`}>
            <button className="lifecycle-stage-heading" type="button" aria-expanded={activeGuideStep === 1} onClick={() => setActiveGuideStep(1)}>
              <span className="lifecycle-stage-number">02</span>
              <span className="lifecycle-stage-title"><small>INDEPENDENT RESERVATIONS</small><strong>Both sides lock</strong></span>
              <span className="lifecycle-status" data-state={reservationCount === 2 ? "confirmed" : expired ? "expired" : "pending"}>
                {snapshot ? `${reservationCount}/2 CONFIRMED` : "WAITING"}
              </span>
            </button>
            {activeGuideStep === 1 && (
              <div className="lifecycle-stage-content">
                {snapshot ? (
                  <div className="lifecycle-lanes">
                    <article className="lifecycle-lane">
                      <div className="lifecycle-lane-heading">
                        <div><small>CHAIN A · ETHEREUM SEPOLIA</small><strong>Payment reservation</strong></div>
                        <span className="lifecycle-status" data-state={paymentFailed ? "failed" : snapshot.paymentStatus > 0n ? "confirmed" : expired ? "expired" : "pending"}>
                          {paymentFailed ? "REVERTED ATTEMPT" : ["NOT LOCKED", "LOCKED", "PAID", "REFUNDED"][Number(snapshot.paymentStatus)] ?? "UNKNOWN"}
                        </span>
                      </div>
                      <dl className="lifecycle-facts compact">
                        <div><dt>Participant</dt><dd><code>{snapshot.terms.buyer}</code></dd></div>
                        <div><dt>Contract</dt><dd><code>{snapshot.terms.paymentContract}</code></dd></div>
                        <div><dt>Reserved token / amount</dt><dd>{formatUnits(snapshot.terms.paymentInputAmount, 18)} · <code>{snapshot.terms.paymentInputToken}</code></dd></div>
                      </dl>
                      <LifecycleReceipt chainId={sepolia.id} receipt={snapshot.lifecycle.paymentLock} label="Payment lock receipt" />
                      {paymentFailed && <FailedReceipt references={references} chainId={sepolia.id} transactionId={snapshot.terms.transactionId} />}
                    </article>
                    <article className="lifecycle-lane">
                      <div className="lifecycle-lane-heading">
                        <div><small>CHAIN B · BASE SEPOLIA</small><strong>Asset reservation</strong></div>
                        <span className="lifecycle-status" data-state={snapshot.assetStatus === null ? "unavailable" : assetFailed ? "failed" : snapshot.assetStatus > 0n ? "confirmed" : expired ? "expired" : "pending"}>
                          {snapshot.assetStatus === null ? "READ UNAVAILABLE" : assetFailed ? "REVERTED ATTEMPT" : ["NOT LOCKED", "LOCKED", "DELIVERED", "RELEASED"][Number(snapshot.assetStatus)] ?? "UNKNOWN"}
                        </span>
                      </div>
                      <dl className="lifecycle-facts compact">
                        <div><dt>Participant</dt><dd><code>{snapshot.terms.seller}</code></dd></div>
                        <div><dt>Contract</dt><dd><code>{snapshot.terms.assetSettlement}</code></dd></div>
                        <div><dt>Reserved token / amount</dt><dd>{formatUnits(snapshot.terms.assetAmount, 18)} · <code>{snapshot.terms.assetToken}</code></dd></div>
                      </dl>
                      <LifecycleReceipt chainId={baseSepolia.id} receipt={snapshot.lifecycle.assetLock} label="Asset lock receipt" />
                      {assetFailed && <FailedReceipt references={references} chainId={baseSepolia.id} transactionId={snapshot.terms.transactionId} />}
                      {snapshot.assetReadError && <p className="lifecycle-error">Chain B read failed: {snapshot.assetReadError}</p>}
                    </article>
                  </div>
                ) : (
                  <p className="lifecycle-empty">Reservation status and receipts appear after a transaction is loaded.</p>
                )}
              </div>
            )}
          </article>

          <article className={`lifecycle-stage${activeGuideStep === 2 ? " selected" : ""}${activeLifecycleStage === 2 && snapshot ? " current" : ""}`}>
            <button className="lifecycle-stage-heading" type="button" aria-expanded={activeGuideStep === 2} onClick={() => setActiveGuideStep(2)}>
              <span className="lifecycle-stage-number">03</span>
              <span className="lifecycle-stage-title"><small>COORDINATION &amp; DECISION</small><strong>Verify, decide, relay</strong></span>
              <span className="lifecycle-status" data-state={decisionRecorded ? "confirmed" : expired ? "expired" : "pending"}>
                {snapshot ? currentStatus : "WAITING"}
              </span>
            </button>
            {activeGuideStep === 2 && (
              <div className="lifecycle-stage-content">
                {snapshot ? (
                  <>
                    <div className="coordination-flow">
                      <div className="coordination-node">
                        <small>RESERVATION EVENTS</small>
                        <strong>CRE observer</strong>
                        <span>{snapshot.lifecycle.paymentLock && snapshot.lifecycle.assetLock ? "Both lock receipts verified; workflow status is not exposed" : "Waiting for finalized lock receipts"}</span>
                        <LifecycleReceipt chainId={sepolia.id} receipt={snapshot.lifecycle.paymentLock} label="Chain A lock" />
                        <LifecycleReceipt chainId={baseSepolia.id} receipt={snapshot.lifecycle.assetLock} label="Chain B lock" />
                      </div>
                      <span className="coordination-connector" aria-hidden="true" />
                      <div className="coordination-node">
                        <small>SOURCE OF TRUTH · ETHEREUM SEPOLIA</small>
                        <strong>{["UNDECIDED", "COMMIT", "ABORT"][Number(snapshot.decision)] ?? "UNKNOWN"}</strong>
                        <span>{snapshot.decision === 0n && expired ? "Expiry reached at finalized block time" : snapshot.decision === 0n ? "Awaiting an on-chain decision" : "Decision read from finalized Chain A state"}</span>
                        <LifecycleReceipt chainId={sepolia.id} receipt={snapshot.lifecycle.sourceDecision} label="Decision receipt" />
                      </div>
                      <span className="coordination-connector" aria-hidden="true" />
                      <div className="coordination-node">
                        <small>DESTINATION · BASE SEPOLIA</small>
                        <strong>{snapshot.assetDecision === null ? "UNAVAILABLE" : ["NOT RECEIVED", "COMMIT RECEIVED", "ABORT RECEIVED"][Number(snapshot.assetDecision)] ?? "UNKNOWN"}</strong>
                        <span>{snapshot.assetStatus === null ? "Chain B state could not be read" : snapshot.decision === 2n && snapshot.assetStatus === 0n ? "No asset reservation; relay not required" : snapshot.lifecycle.destinationDecision ? "Authenticated report receipt verified on-chain" : "Waiting for authenticated decision report"}</span>
                        <LifecycleReceipt chainId={baseSepolia.id} receipt={snapshot.lifecycle.destinationDecision} label="DecisionReceived receipt" />
                      </div>
                    </div>
                    <div className="lifecycle-outcomes">
                      <div>
                        <small>CHAIN A · PAYMENT</small>
                        <strong>{["NOT LOCKED", "LOCKED", "PAID", "REFUNDED"][Number(snapshot.paymentStatus)] ?? "UNKNOWN"}</strong>
                        <LifecycleReceipt chainId={sepolia.id} receipt={snapshot.lifecycle.paymentOutcome} label="Payment outcome receipt" />
                      </div>
                      <div>
                        <small>CHAIN B · ASSET</small>
                        <strong>{snapshot.assetStatus === null ? "UNAVAILABLE" : ["NOT LOCKED", "LOCKED", "DELIVERED", "RELEASED"][Number(snapshot.assetStatus)] ?? "UNKNOWN"}</strong>
                        <LifecycleReceipt chainId={baseSepolia.id} receipt={snapshot.lifecycle.assetOutcome} label="Asset outcome receipt" />
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="lifecycle-empty">Decision and relay details are shown only after finalized chain state is loaded.</p>
                )}
                {snapshot?.lifecycleReadError && <p className="lifecycle-error">Receipt verification issue: {snapshot.lifecycleReadError}</p>}
              </div>
            )}
          </article>
        </div>
        <p className="lifecycle-footnote">Progress reflects finalized contract reads and verified event receipts. A source decision alone does not mean Chain B has settled.</p>
      </section>

      {configurationError && (
        <div className="notice error" role="alert">
          Contract configuration is incomplete: {configurationError}. Copy `apps/web/.env.example` to `.env.local` and set deployed addresses.
        </div>
      )}

      <section className="settlement-actions" aria-label="Settlement actions">
        <div className="settlement-actions-heading">
          <p className="eyebrow">Take action</p>
          <h2>Continue a settlement</h2>
          <p>Create a new agreement, register the prepared RaisinFi demo, or inspect an existing transaction.</p>
        </div>
        <div className="settlement-action-list">
          <button className="settlement-action-button create-action" type="button" onClick={() => setActiveActionPanel("create")}>
            <span className="settlement-action-symbol">+</span>
            <span><small>NEW AGREEMENT</small><strong>Create Transaction</strong><em>Agree terms and register on Ethereum Sepolia</em></span>
            <span className="settlement-action-arrow" aria-hidden="true">↗</span>
          </button>
          <button className="settlement-action-button create-action" type="button" onClick={() => setActiveActionPanel("prepared")}>
            <span className="settlement-action-symbol">✓</span>
            <span><small>PREPARED DEMO</small><strong>Register RaisinFi Demo</strong><em>Review Alice’s fixed Sepolia registration Terms</em></span>
            <span className="settlement-action-arrow" aria-hidden="true">↗</span>
          </button>
          <button className="settlement-action-button open-action" type="button" onClick={() => setActiveActionPanel("open")}>
            <span className="settlement-action-symbol">↗</span>
            <span><small>RESUME WORK</small><strong>Already in Progress?</strong><em>Load transaction state from both chains</em></span>
            <span className="settlement-action-arrow" aria-hidden="true">↗</span>
          </button>
        </div>
      </section>

      {activeActionPanel && (
        <dialog
          ref={actionDialogRef}
          className="action-dialog"
          aria-label={activeActionPanel === "create" ? "Create transaction" : activeActionPanel === "prepared" ? "Register prepared RaisinFi demo" : "Open an agreement"}
          onCancel={(event) => { event.preventDefault(); setActiveActionPanel(null); }}
          onClick={(event) => { if (event.target === event.currentTarget) setActiveActionPanel(null); }}
        >
          <div className="action-dialog-frame">
            <button className="dialog-close" type="button" data-dialog-autofocus onClick={() => setActiveActionPanel(null)} aria-label="Close dialog">×</button>
            {activeActionPanel === "create" && (
        <article
          className="card action-card create-card"
          data-state={busyAction === "create" ? "loading" : successMessage?.startsWith("Agreement registered") ? "success" : undefined}
          aria-busy={busyAction === "create"}
        >
          <div className="action-card-heading">
            <div className="card-art card-art-agreement" aria-hidden="true">
              <span className="art-orbit orbit-one" />
              <span className="art-orbit orbit-two" />
              <svg viewBox="0 0 88 88" fill="none">
                <path d="M25 17h27l13 13v42H25z" />
                <path d="M52 17v14h13M35 44h20M35 53h20M35 62h12" />
                <circle cx="62" cy="61" r="13" />
                <path d="m56 61 4 4 8-9" />
              </svg>
            </div>
            <div className="action-heading-copy">
              <p className="eyebrow">New agreement</p>
              <h2>Create transaction</h2>
              <p className="action-description">Define the terms before either side locks funds.</p>
            </div>
            <span className={`chain-pill ${chainId === sepolia.id ? "active" : ""}`}>Chain A</span>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); if (agreementPreview.draft) setAgreementDraft(agreementPreview.draft); }} className="form agreement-form">
            <div className="form-row">
              <label>
                Buyer wallet · connected account
                <span className="field-hint">This account must sign on Ethereum Sepolia</span>
                <input value={address ?? "Connect wallet to select buyer"} readOnly aria-label="Connected buyer wallet" />
              </label>
              <label>
                Seller wallet
                <span className="field-hint">Seller address on Base Sepolia</span>
                <input autoComplete="off" placeholder="0x…" value={sellerInput} onChange={(event) => setSellerInput(event.target.value)} required />
              </label>
            </div>
            <div className="form-row">
              <label>
                Payment chain ID
                <span className="field-hint">Configured settlement supports Sepolia only</span>
                <input inputMode="numeric" value={paymentChainInput} onChange={(event) => setPaymentChainInput(event.target.value)} required />
              </label>
              <label>
                Asset chain ID
                <span className="field-hint">Configured settlement supports Base Sepolia only</span>
                <input inputMode="numeric" value={assetChainInput} onChange={(event) => setAssetChainInput(event.target.value)} required />
              </label>
            </div>
            <label>
              Payment token address
              <span className="field-hint">Input and output tokens must match; swaps are disabled</span>
              <input autoComplete="off" placeholder="0x…" value={paymentInputToken} onChange={(event) => { setPaymentInputToken(event.target.value); setPaymentOutputToken(event.target.value); }} required />
            </label>
            <label>
              Asset token address
              <span className="field-hint">Token locked on Base Sepolia</span>
              <input autoComplete="off" placeholder="0x…" value={assetTokenInput} onChange={(event) => setAssetTokenInput(event.target.value)} required />
            </label>
            <div className="form-row">
              <label>
                Payment amount · decimals
                <span className="field-hint">Payment token precision (0–18)</span>
                <input inputMode="numeric" type="number" min="0" max="18" value={paymentTokenDecimals} onChange={(event) => setPaymentTokenDecimals(Number(event.target.value))} required />
              </label>
              <label>
                Asset amount · decimals
                <span className="field-hint">Asset token precision (0–18)</span>
                <input inputMode="numeric" type="number" min="0" max="18" value={assetTokenDecimals} onChange={(event) => setAssetTokenDecimals(Number(event.target.value))} required />
              </label>
            </div>
            <div className="form-row">
              <label>
                Payment amount
                <span className="field-hint">Human-readable token quantity</span>
                <input inputMode="decimal" value={paymentAmountInput} onChange={(event) => setPaymentAmountInput(event.target.value)} required />
              </label>
              <label>
                Asset quantity
                <span className="field-hint">Human-readable token quantity</span>
                <input inputMode="decimal" value={assetAmountInput} onChange={(event) => setAssetAmountInput(event.target.value)} required />
              </label>
            </div>
            <label>
              Expiry (minutes)
              <span className="field-hint">Agreement lifetime from preview · 1 to 1440 minutes</span>
              <input type="number" min="1" max="1440" value={expiryMinutesInput} onChange={(event) => setExpiryMinutesInput(event.target.value)} required />
            </label>
            <section className="agreement-preview" aria-label="Agreement preview">
              <div className="action-card-heading"><div><p className="eyebrow">Review before signing</p><h3>Terms preview</h3></div></div>
              {agreementPreview.error ? <p className="notice warning" role="status">{agreementPreview.error}</p> : agreementPreview.draft && (
                <div className="terms-grid">
                  <div><span>Buyer</span><code>{agreementPreview.draft.terms.buyer}</code></div>
                  <div><span>Seller</span><code>{agreementPreview.draft.terms.seller}</code></div>
                  <div><span>Networks</span><code>Sepolia ({agreementPreview.draft.terms.paymentChainId.toString()}) → Base Sepolia ({agreementPreview.draft.terms.assetChainId.toString()})</code></div>
                  <div><span>Payment</span><code>{formatUnits(agreementPreview.draft.terms.paymentAmount, agreementPreview.draft.paymentDecimals)} · {agreementPreview.draft.terms.paymentInputToken}</code></div>
                  <div><span>Asset</span><code>{formatUnits(agreementPreview.draft.terms.assetAmount, agreementPreview.draft.assetDecimals)} · {agreementPreview.draft.terms.assetToken}</code></div>
                  <div><span>Expires</span><code>{new Date(Number(agreementPreview.draft.terms.expiresAt) * 1000).toISOString()}</code></div>
                  <div><span>Transaction ID</span><code>{agreementPreview.draft.terms.transactionId}</code></div>
                  <div><span>Terms hash</span><code>{agreementPreview.draft.termsHash}</code></div>
                </div>
              )}
            </section>
            <p className="muted small">Preview is generated locally with the protocol's canonical Terms hash. Registering does not move funds. The wallet will request a separate manual signature after validation and simulation.</p>
            {agreementSubmission && (
              <div className={`notice ${agreementSubmission.status === "finalized" ? "success" : agreementSubmission.status === "failed" ? "error" : "warning"}`} role="status" aria-live="polite">
                <strong>{agreementSubmission.status === "finalized" ? "Agreement registered and finalized" : agreementSubmission.status === "included" ? "Registration included — finality is not yet confirmed" : agreementSubmission.status === "failed" ? "Registration failed before broadcast" : "Registration submitted — waiting for confirmation"}</strong>
                <p>Transaction ID: <code>{agreementSubmission.terms.transactionId}</code></p><p>Terms hash: <code>{agreementSubmission.termsHash}</code></p>
                {agreementSubmission.transactionHash && <p>Wallet transaction: <code>{agreementSubmission.transactionHash}</code></p>}
                {agreementSubmission.receipt && <p>Included in Sepolia block {agreementSubmission.receipt.blockNumber.toString()}.</p>}
                {agreementSubmission.error && <p>{agreementSubmission.error}</p>}
                {agreementSubmission.status === "included" && !agreementSubmission.error && <p>Waiting for the registration to reach finalized Sepolia state; this may take a while.</p>}
              </div>
            )}
            {agreementFormError && <p className="notice error" role="alert">{agreementFormError}</p>}
            <div className="form-actions">
              <button className="button secondary" type="button" onClick={() => setActiveActionPanel(null)}>Cancel</button>
              <button className="button secondary" type="button" onClick={() => { if (agreementPreview.draft) setAgreementDraft(agreementPreview.draft); }} disabled={!agreementPreview.draft}>Refresh preview</button>
              <button className={`button action-submit${busyAction === "create" ? " is-loading" : ""}`} type="button" onClick={(event) => { event.preventDefault(); if (!agreementPreview.draft) return; setAgreementDraft(agreementPreview.draft); setAgreementFormError(null); void createTransaction({ preventDefault() {} } as FormEvent<HTMLFormElement>, agreementPreview.draft); }} disabled={!isConnected || chainId !== sepolia.id || !addresses || !agreementPreview.draft || busyAction !== null}>
                {busyAction === "create" ? "Registering…" : "Confirm & register"}
              </button>
            </div>
          </form>
        </article>
            )}

            {activeActionPanel === "prepared" && (
              <article className="card action-card create-card prepared-card" aria-busy={busyAction === "prepared-demo" || preparedDemoCheckBusy}>
                <div className="action-card-heading">
                  <div className="card-art card-art-agreement" aria-hidden="true">
                    <span className="art-orbit orbit-one" />
                    <span className="art-orbit orbit-two" />
                    <svg viewBox="0 0 88 88" fill="none"><path d="M25 17h27l13 13v42H25z" /><path d="M52 17v14h13M35 44h20M35 53h20M35 62h12" /><circle cx="62" cy="61" r="13" /><path d="m56 61 4 4 8-9" /></svg>
                  </div>
                  <div className="action-heading-copy">
                    <p className="eyebrow">Prepared demo · no approvals or locks</p>
                    <h2>Register prepared agreement</h2>
                    <p className="action-description">Review the fixed Terms. Registration does not move tokens.</p>
                  </div>
                  <span className={`chain-pill ${chainId === sepolia.id ? "active" : ""}`}>Ethereum Sepolia</span>
                </div>
                <div className="terms-grid prepared-terms-grid">
                  <div><span>Transaction ID</span><code>{PREPARED_DEMO_TERMS.transactionId}</code></div>
                  <div><span>Expected termsHash</span><code>{PREPARED_DEMO_TERMS_HASH}</code></div>
                  <div><span>Buyer · Alice</span><code>{PREPARED_DEMO_TERMS.buyer}</code></div>
                  <div><span>Seller · Bob</span><code>{PREPARED_DEMO_TERMS.seller}</code></div>
                  <div><span>Networks</span><code>Ethereum Sepolia (11155111) → Base Sepolia (84532)</code></div>
                  <div><span>Payment</span><code>1,000 RDT · direct token on Ethereum Sepolia</code></div>
                  <div><span>Asset</span><code>100 RDT · Base Sepolia</code></div>
                  <div><span>Expiry (UTC)</span><code>{new Date(Number(PREPARED_DEMO_TERMS.expiresAt) * 1000).toISOString()}</code></div>
                </div>
                <p className="muted small">Payment contract: <code>{PREPARED_DEMO_TERMS.paymentContract}</code><br />Asset contract: <code>{PREPARED_DEMO_TERMS.assetSettlement}</code></p>
                <div className="prepared-readiness" role="status" aria-live="polite">
                  {preparedDemoCheckBusy ? (
                    <p className="notice">Checking account, expiry margin, Sepolia hash, registration state and read-only simulation…</p>
                  ) : preparedDemoReady ? (
                    <p className="notice success">Ready for Alice’s manual signature. On-chain termsHash and register simulation passed; transaction ID is unregistered.</p>
                  ) : (
                    <p className="notice warning">{preparedDemoCheckError ?? "Connect Alice’s Coinbase Wallet on Ethereum Sepolia to verify readiness."}</p>
                  )}
                  {preparedDemoVerification && (
                    <p className="muted small">Checked {new Date(preparedDemoVerification.checkedAt).toLocaleTimeString()} · Sepolia block {preparedDemoVerification.blockNumber.toString()} timestamp {new Date(Number(preparedDemoVerification.blockTimestamp) * 1000).toISOString()}</p>
                  )}
                </div>
                {isConnected && chainId !== sepolia.id && (
                  <button className="button secondary" type="button" onClick={() => void changeWalletChain(sepolia.id)} disabled={isSwitching}>
                    {isSwitching ? "Switching…" : "Switch to Ethereum Sepolia"}
                  </button>
                )}
                {preparedDemoSubmission && !registrationConfirmation && (
                  <div className={`notice ${preparedDemoSubmission.status === "success" ? "success" : preparedDemoSubmission.status === "failure" ? "error" : "warning"}`} role="status" aria-live="polite">
                    <strong>{preparedDemoSubmission.status === "success" ? "Registration finalized" : preparedDemoSubmission.status === "included" ? "Registration included — awaiting finality" : preparedDemoSubmission.status === "failure" ? "Registration reverted" : "Transaction submitted · waiting for receipt"}</strong>
                    <a href={`https://sepolia.etherscan.io/tx/${preparedDemoSubmission.hash}`} target="_blank" rel="noreferrer">View transaction {preparedDemoSubmission.hash} ↗</a>
                  </div>
                )}
                {(actionError || successMessage) && (
                  <div className="dialog-errors">
                    {actionError && <p className="notice error" role="alert">{actionError}</p>}
                    {successMessage && <p className="notice success" role="status">{successMessage}</p>}
                  </div>
                )}
                <div className="form-actions">
                  <button className="button secondary" type="button" onClick={() => setActiveActionPanel(null)}>Close</button>
                  <button
                    className={`button action-submit${busyAction === "prepared-demo" ? " is-loading" : ""}`}
                    type="button"
                    disabled={!preparedDemoReady || preparedDemoCheckBusy || busyAction !== null || preparedDemoSubmission?.status === "pending" || preparedDemoSubmission?.status === "included" || preparedDemoSubmission?.status === "success"}
                    onClick={() => void registerPreparedDemo()}
                  >
                    {busyAction === "prepared-demo" ? "Rechecking and waiting…" : preparedDemoSubmission?.status === "pending" ? "Waiting for receipt…" : preparedDemoSubmission?.status === "included" ? "Awaiting finality…" : preparedDemoSubmission?.status === "success" ? "Registration finalized" : "Verify and register prepared Terms"}
                  </button>
                </div>
              </article>
            )}

            {activeActionPanel === "open" && (
        <article
          className="card action-card load-card"
          data-state={busyAction === "read" ? "loading" : readError ? "error" : snapshot && snapshot.terms.transactionId.toLowerCase() === transactionIdInput.toLowerCase() ? "success" : undefined}
          aria-busy={busyAction === "read"}
        >
          <div className="action-card-heading">
            <div className="card-art card-art-lookup" aria-hidden="true">
              <span className="art-orbit orbit-one" />
              <span className="art-orbit orbit-two" />
              <svg viewBox="0 0 88 88" fill="none">
                <circle cx="39" cy="38" r="20" />
                <path d="m54 53 17 17" />
                <path d="M31 33h16M31 41h11" />
                <circle cx="66" cy="22" r="5" />
                <path d="M66 14v-4M66 34v-4M58 22h-4M78 22h-4" />
              </svg>
            </div>
            <div className="action-heading-copy">
              <p className="eyebrow">Already in progress?</p>
              <h2>Open an agreement</h2>
              <p className="action-description">Look up the shared transaction and follow both chain states.</p>
            </div>
            <span className="chain-pill">Read only</span>
          </div>
          <form onSubmit={loadTransaction} className="form">
            <label>
              Transaction ID
              <span className="field-hint">Paste the 32-byte ID shared by the participants</span>
              <input
                autoComplete="off"
                placeholder="0x + 64 hex characters"
                value={transactionIdInput}
                onChange={(event) => setTransactionIdInput(event.target.value)}
                required
              />
            </label>
            <div className="form-actions">
              <button className="button secondary" type="button" onClick={() => setActiveActionPanel(null)}>Close</button>
              <button className={`button secondary action-submit${busyAction === "read" ? " is-loading" : ""}`} disabled={!addresses || busyAction !== null}>
                {busyAction === "read" ? "Reading both chains…" : "Read both chains"}
              </button>
            </div>
          </form>
          <div className="separator" />
          <div className="chain-actions">
            <div className={`network-status${isConnected ? " connected" : ""}`} data-network={chainId === sepolia.id ? "ethereum" : chainId === baseSepolia.id ? "base" : "other"}>
              <strong>Connected chain</strong>
              <span>{chainId === sepolia.id ? "Ethereum Sepolia" : chainId === baseSepolia.id ? "Base Sepolia" : chainId ? `Unsupported (${chainId})` : "Not connected"}</span>
            </div>
            <div className="network-switches">
              {isConnected && chainId !== sepolia.id && (
                <button className="button secondary" onClick={() => void changeWalletChain(sepolia.id)} disabled={isSwitching}>
                  {isSwitching ? "Switching…" : "Switch to Ethereum"}
                </button>
              )}
              {isConnected && chainId !== baseSepolia.id && (
                <button className="button secondary" onClick={() => void changeWalletChain(baseSepolia.id)} disabled={isSwitching}>
                  {isSwitching ? "Switching…" : "Switch to Base"}
                </button>
              )}
            </div>
          </div>
        </article>
            )}
            {(actionError || readError || successMessage || registrationConfirmation) && (
              <div className="dialog-errors">
                {actionError && <p className="notice error" role="alert">{actionError}</p>}
                {activeActionPanel === "open" && readError && <p className="notice error" role="alert">{readError}</p>}
                {successMessage && <p className="notice success" role="status">{successMessage}</p>}
                {registrationConfirmation && <RegistrationConfirmationNotice confirmation={registrationConfirmation} />}
              </div>
            )}
          </div>
        </dialog>
      )}

      {!activeActionPanel && actionError && <div className="notice error" role="alert">{actionError}</div>}
      {!activeActionPanel && readError && <div className="notice error" role="alert">{readError}</div>}
      {!activeActionPanel && successMessage && <div className="notice success" role="status">{successMessage}</div>}
      {!activeActionPanel && registrationConfirmation && <RegistrationConfirmationNotice confirmation={registrationConfirmation} />}

      {snapshot && addresses && (
        <section className="card transaction">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Transaction details</p>
              <h2>{currentStatus}</h2>
            </div>
            <button
              className="button secondary"
              onClick={() => void refreshTransaction(snapshot.terms.transactionId)}
            >
              Refresh chain state
            </button>
          </div>

          <div className="terms-grid">
            <div><span>Transaction ID</span><code>{snapshot.terms.transactionId}</code></div>
            <div><span>Terms hash</span><code>{snapshot.termsHash}</code></div>
            <div><span>Buyer</span><code>{snapshot.terms.buyer}</code></div>
            <div><span>Seller</span><code>{snapshot.terms.seller}</code></div>
            <div><span>Payment</span><strong>{formatUnits(snapshot.terms.paymentAmount, 18)} test tokens · Ethereum Sepolia</strong></div>
            <div><span>Asset</span><strong>{formatUnits(snapshot.terms.assetAmount, 18)} test units · Base Sepolia</strong></div>
            <div><span>Expires</span><strong>{new Date(Number(snapshot.terms.expiresAt) * 1000).toLocaleString()}</strong></div>
          </div>

          <div className="obligations">
            <article className="obligation">
              <div className="section-heading">
                <div><span className="eyebrow">Chain A · Ethereum Sepolia</span><h3>Payment</h3></div>
                <span
                  className="status"
                  data-state={["NOT_LOCKED", "LOCKED", "PAID", "REFUNDED"][Number(snapshot.paymentStatus)] ?? "UNKNOWN"}
                >
                  {["NOT_LOCKED", "LOCKED", "PAID", "REFUNDED"][Number(snapshot.paymentStatus)] ?? "UNKNOWN"}
                </span>
              </div>
              <p>Decision: {["UNDECIDED", "COMMIT", "ABORT"][Number(snapshot.decision)] ?? "UNKNOWN"}</p>
              <button
                className="button"
                onClick={() => void lockPayment()}
                disabled={!isConnected || busyAction !== null || snapshot.paymentStatus !== 0n || snapshot.decision !== 0n}
              >
                {busyAction === "payment" ? "Locking payment…" : `Alice: approve ${formatUnits(snapshot.terms.paymentInputAmount, 18)} RDT and lock payment`}
              </button>
            </article>
            <article className="obligation">
              <div className="section-heading">
                <div><span className="eyebrow">Chain B · Base Sepolia</span><h3>Asset</h3></div>
                <span
                  className="status"
                  data-state={snapshot.assetStatus === null ? "UNAVAILABLE" : ["NOT_LOCKED", "LOCKED", "DELIVERED", "RELEASED"][Number(snapshot.assetStatus)] ?? "UNKNOWN"}
                >
                  {snapshot.assetStatus === null ? "UNAVAILABLE" : ["NOT_LOCKED", "LOCKED", "DELIVERED", "RELEASED"][Number(snapshot.assetStatus)] ?? "UNKNOWN"}
                </span>
              </div>
              <p>Relayed decision: {snapshot.assetDecision === null ? "Not received" : ["UNDECIDED", "COMMIT", "ABORT"][Number(snapshot.assetDecision)] ?? "UNKNOWN"}</p>
              <button
                className="button"
                onClick={() => void lockAsset()}
                disabled={!isConnected || busyAction !== null || snapshot.assetStatus !== 0n || snapshot.decision !== 0n}
              >
                {busyAction === "asset" ? "Locking asset…" : "Bob: approve and lock asset"}
              </button>
              {snapshot.assetReadError && <p className="muted small">Asset read detail: {snapshot.assetReadError}</p>}
            </article>
          </div>

          <div className="timeline">
            <h3>Progress timeline</h3>
            <ol>
              <li className={snapshot.paymentStatus > 0n ? "complete" : ""}>Agreement registered on Chain A</li>
              <li className={snapshot.paymentStatus > 0n ? "complete" : ""}>Alice payment reservation</li>
              <li className={snapshot.assetStatus !== null && snapshot.assetStatus > 0n ? "complete" : ""}>Bob asset reservation</li>
              <li className={snapshot.decision !== 0n ? "complete" : ""}>Authoritative Chain A decision</li>
              <li className={snapshot.assetStatus === 2n || snapshot.assetStatus === 3n ? "complete" : ""}>Chain B delivery or release</li>
            </ol>
          </div>

          {snapshot.decision === 0n && expired && (
            <div className="notice warning">
              Expiry only makes Chain A ABORT eligible. Chain B will not release locally.
              <button
                className="button danger"
                onClick={() => void abortTransaction()}
                disabled={!isConnected || busyAction !== null}
              >
                {busyAction === "abort" ? "Submitting abort…" : "Anyone: record expiry ABORT"}
              </button>
            </div>
          )}
        </section>
      )}

      <section className="independent-verification" aria-labelledby="independent-verification-title">
        <div className="verification-heading">
          <p className="eyebrow">On-chain discovery</p>
          <h2 id="independent-verification-title">Independent Verification</h2>
          <p>Inspect transaction states independently across Ethereum Sepolia and Base Sepolia.</p>
          <span>Transactions are discovered from registration events. Appearance in this list is not a verification claim; each displayed status comes from finalized contract reads.</span>
        </div>
        {!addresses ? (
          <p className="verification-empty">Transaction discovery requires a configured Chain A contract address.</p>
        ) : verificationBusy && verificationEntries.length === 0 ? (
          <p className="verification-empty" role="status">Scanning finalized registration events…</p>
        ) : verificationError && verificationEntries.length === 0 ? (
          <div className="verification-empty verification-error" role="alert">
            <strong>Transaction discovery unavailable</strong>
            <span>{verificationError}</span>
            <button type="button" className="button secondary" onClick={() => void retryVerificationScan()} disabled={verificationBusy}>Retry scan</button>
          </div>
        ) : verificationEntries.length === 0 ? (
          <p className="verification-empty">No finalized transaction registrations were found in the scanned block range.</p>
        ) : (
          <ul className="verification-list">
            {verificationEntries.slice(0, verificationVisibleCount).map((entry) => (
              <li key={entry.transactionId}>
                <button
                  type="button"
                  className="verification-link"
                  onClick={() => {
                    setTransactionIdInput(entry.transactionId);
                    setActiveActionPanel("open");
                  }}
                  title={`Inspect ${entry.transactionId}`}
                >
                  <code>{entry.transactionId.slice(0, 10)}…{entry.transactionId.slice(-8)}</code>
                  <span className="verification-row-status" data-state={entry.status.toLowerCase()}>{entry.status.replaceAll("_", " ")}</span>
                  <span className="verification-chain-status ethereum-status"><i />ETH {entry.paymentStatus}</span>
                  <span className="verification-chain-status base-status" title={entry.assetReadError ?? undefined}><i />BASE {entry.assetStatus}</span>
                  <span className="verification-inspect">Inspect ↗</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {verificationError && verificationEntries.length > 0 && <p className="verification-inline-error" role="alert">{verificationError}</p>}
        {(verificationEntries.length > verificationVisibleCount || verificationHasMore) && (
          <button
            type="button"
            className="button secondary verification-load-more"
            onClick={() => {
              setVerificationVisibleCount((count) => count + 2);
              void loadMoreVerification();
            }}
            disabled={verificationBusy}
          >
            {verificationBusy ? "Loading transactions…" : "Load more"}
          </button>
        )}
      </section>

      <section className="evidence-workspace" aria-labelledby="evidence-workspace-title">
        <div className="evidence-workspace-heading">
          <div>
            <p className="eyebrow">Transparency layer</p>
            <h2 id="evidence-workspace-title">Evidence and Retrieval</h2>
            <p>Inspect on-chain receipts and retrieve the associated Arkiv evidence record.</p>
          </div>
          <span className="evidence-heading-orbit" aria-hidden="true"><i /><i /><i /></span>
        </div>
        <div className="evidence-workspace-grid">
          <section className="evidence-record-status" aria-labelledby="record-status-title">
            <p className="eyebrow">01 · RECORD STATUS</p>
            <h3 id="record-status-title">Arkiv evidence</h3>
            <span className={`evidence-record-state${currentArkivResult ? " verified" : arkivBusy ? " pending" : arkivError ? " failed" : ""}`}>
              <span className="evidence-state-dot" />
              {currentArkivResult?.created ? "Record created and retrieved" : currentArkivResult ? "Record retrieved" : arkivBusy ? "Retrieving" : arkivError ? "Retrieval failed" : "Not retrieved"}
            </span>
            <div className="arkiv-record">
              <div className="evidence-data-row">
                <span>Record existence</span>
                <strong className="arkiv-retrieval-state" data-state={currentArkivResult ? "verified" : arkivBusy ? "pending" : arkivError ? "failed" : "idle"}>
                  {currentArkivResult ? "Available" : arkivBusy ? "Checking…" : arkivError ? "Not confirmed" : "Not checked"}
                </strong>
              </div>
              <div className="evidence-data-row">
                <span>Transaction ID</span>
                <span className="evidence-value">
                  {snapshot ? <><code title={snapshot.terms.transactionId}>{snapshot.terms.transactionId}</code><CopyButton value={snapshot.terms.transactionId} label="transaction ID" /></> : <span className="evidence-unavailable">Load a transaction first</span>}
                </span>
              </div>
              <div className="evidence-data-row">
                <span>Arkiv entity identifier</span>
                <span className="evidence-value">
                  {currentArkivResult ? <><code title={currentArkivResult.entityKey}>{currentArkivResult.entityKey}</code><CopyButton value={currentArkivResult.entityKey} label="Arkiv entity identifier" /></> : <span className="evidence-unavailable">Not available</span>}
                </span>
              </div>
              <div className="evidence-data-row">
                <span>Creation timestamp</span>
                <span className="evidence-timestamp">
                  {currentArkivResult?.createdAtTimestamp !== null && currentArkivResult?.createdAtTimestamp !== undefined
                    ? new Date(Number(currentArkivResult.createdAtTimestamp) * 1000).toLocaleString()
                    : "Not available"}
                  {currentArkivResult?.createdAtBlock !== null && currentArkivResult?.createdAtBlock !== undefined && (
                    <small>Arkiv block {currentArkivResult.createdAtBlock.toString()}</small>
                  )}
                </span>
              </div>
              <div className="evidence-data-row">
                <span>Retrieval status</span>
                <span className="evidence-unavailable">{currentArkivResult ? "Transaction ID and terms hash matched" : arkivError ? "Lookup failed" : "Awaiting lookup"}</span>
              </div>
            </div>
            {currentArkivResult && (
              <div className="arkiv-metadata">
                <span>Stored outcome metadata</span>
                <code>{currentArkivResult.status} · {currentArkivResult.decision}</code>
              </div>
            )}
            {arkivError && <p className="error-text" role="alert">{arkivError}</p>}
          </section>

          <section className="evidence-actions-panel" aria-labelledby="evidence-actions-title">
            <p className="eyebrow">02 · EVIDENCE ACTIONS</p>
            <h3 id="evidence-actions-title">Inspect and retrieve</h3>
            <div className="arkiv-disclaimer">
              <strong>Arkiv is evidence, not settlement authority</strong>
              <span>An Arkiv record does not prove payment or delivery. Confirm relevant outcomes using successful receipts from both chains.</span>
            </div>
            <div className="evidence-action-buttons">
              {isConnected && chainId !== arkivChain.id && (
                <button className="button secondary" onClick={() => void changeWalletChain(arkivChain.id)} disabled={isSwitching}>
                  {isSwitching ? "Switching…" : "Switch to Arkiv Rabdi"}
                </button>
              )}
              <button
                className="button evidence-primary"
                onClick={() => void publishArkivEvidence()}
                disabled={!snapshot || !isConnected || arkivBusy || (currentStatus !== "SETTLED" && currentStatus !== "RELEASED")}
              >
                {arkivBusy ? "Writing / reading…" : "Create or retrieve evidence"}
              </button>
              <button
                className="button secondary"
                onClick={() => void retrieveArkivEvidence()}
                disabled={!snapshot || arkivBusy}
              >
                {arkivBusy ? "Retrieving…" : "Retrieve by Transaction ID"}
              </button>
              <a className="arkiv-explorer-link" href={arkivChain.blockExplorers.default.url} target="_blank" rel="noreferrer">Open Arkiv Rabdi explorer ↗</a>
            </div>
          </section>
        </div>
        <section className="evidence-receipts" aria-labelledby="chain-receipts-title">
          <div className="evidence-receipts-heading">
            <div>
              <p className="eyebrow">03 · INDEPENDENT VERIFICATION</p>
              <h3 id="chain-receipts-title">Independent Chain Receipts</h3>
            </div>
            <span>{ethereumReceiptEntries.length + baseReceiptEntries.length} {ethereumReceiptEntries.length + baseReceiptEntries.length === 1 ? "receipt" : "receipts"}</span>
          </div>
          <p className="evidence-intro">Successful receipts are matched to finalized contract events; reverted attempts remain clearly marked.</p>
          <div className="chain-evidence-lanes">
            {([
              {
                chainId: sepolia.id,
                name: "Ethereum Sepolia",
                contract: snapshot?.terms.paymentContract ?? addresses?.payment ?? null,
                entries: ethereumReceiptEntries,
                explorer: "https://sepolia.etherscan.io",
                accent: "ethereum",
              },
              {
                chainId: baseSepolia.id,
                name: "Base Sepolia",
                contract: snapshot?.terms.assetSettlement ?? addresses?.asset ?? null,
                entries: baseReceiptEntries,
                explorer: "https://sepolia.basescan.org",
                accent: "base",
              },
            ]).map((lane) => (
              <section className={`chain-evidence-lane ${lane.accent}`} key={lane.chainId} aria-label={`${lane.name} receipts`}>
                <header className="chain-evidence-heading">
                  <span className="chain-evidence-dot" />
                  <strong>{lane.name}</strong>
                  <span className="evidence-lane-count">{lane.entries.length} {lane.entries.length === 1 ? "receipt" : "receipts"}</span>
                </header>
                <div className="contract-address-row">
                  <span>Settlement contract</span>
                  {lane.contract ? (
                    <span className="evidence-value">
                      <code title={lane.contract}>{lane.contract}</code>
                      <CopyButton value={lane.contract} label={`${lane.name} contract address`} />
                    </span>
                  ) : <span className="evidence-unavailable">Not configured</span>}
                </div>
                {lane.entries.length === 0 ? (
                  <div className="evidence-empty">
                    <span className="evidence-state-dot pending" />
                    <span>
                      {busyAction === "read"
                        ? "Reading finalized chain state and verifying receipts…"
                        : readError
                          ? `Receipt verification unavailable: ${readError}`
                          : snapshot?.lifecycleReadError
                            ? `Lifecycle receipt verification failed: ${snapshot.lifecycleReadError}`
                            : snapshot
                              ? "No verified receipts found for this transaction."
                              : "Load a transaction to inspect its chain receipts."}
                    </span>
                  </div>
                ) : (
                  <ul className="chain-receipt-list">
                    {lane.entries.map((entry) => (
                      <li className="chain-receipt-item" key={`${lane.chainId}-${entry.hash}`}>
                        <div className="receipt-item-top">
                          <span className="receipt-label">{entry.label}</span>
                          <span className="receipt-status" data-state={entry.status}>
                            <span className="evidence-state-dot" />
                            {entry.status === "reverted" ? "Failed · reverted" : entry.finalized ? "Verified · finalized" : "Mined · success"}
                          </span>
                        </div>
                        <div className="evidence-data-row">
                          <span>Transaction hash</span>
                          <span className="evidence-value">
                            <code title={entry.hash}>{entry.hash}</code>
                            <CopyButton value={entry.hash} label={`${entry.label} transaction hash`} />
                          </span>
                        </div>
                        <div className="evidence-data-row">
                          <span>Contract address</span>
                          <span className="evidence-value">
                            <code title={entry.contractAddress}>{entry.contractAddress}</code>
                            <CopyButton value={entry.contractAddress} label={`${entry.label} contract address`} />
                          </span>
                        </div>
                        <div className="receipt-item-bottom">
                          <span>Block <code>{entry.blockNumber.toString()}</code></span>
                          <a href={`${lane.explorer}/tx/${entry.hash}`} target="_blank" rel="noreferrer">View on explorer ↗</a>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </section>
      </section>

      <footer>
        UI .
      </footer>
    </main>
  );
}

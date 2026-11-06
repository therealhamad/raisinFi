"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
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
import { getContractAddresses, parseAddress } from "@/lib/contracts";
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

const paymentClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env.NEXT_PUBLIC_ETHEREUM_SEPOLIA_RPC_URL || undefined),
});
const assetClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || undefined),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected transaction error";
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
  const [transactionIdInput, setTransactionIdInput] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [activeGuideStep, setActiveGuideStep] = useState(0);
  const [activeActionPanel, setActiveActionPanel] = useState<"create" | "open" | null>(null);
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

  const refreshTransaction = useCallback(async (transactionId: Hex) => {
    if (!addresses) return;
    setReadError(null);
    try {
      const [paymentResult, finalizedBlock] = await Promise.all([
        paymentClient.readContract({
          address: addresses.payment,
          abi: decisionPaymentSettlementAbi,
          functionName: "getTransaction",
          args: [transactionId],
          blockTag: "finalized",
        }),
        paymentClient.getBlock({ blockTag: "finalized" }),
      ]);
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
        const registeredLogs = await paymentClient.getLogs({
          address: addresses.payment,
          event: parseAbiItem("event TransactionRegistered(bytes32 indexed transactionId, bytes32 termsHash, address buyer)"),
          args: { transactionId },
          fromBlock: paymentFromBlock,
          toBlock: "finalized",
        });
        const registeredLog = registeredLogs.find(
          (log) =>
            log.args.termsHash?.toLowerCase() === termsHash.toLowerCase() &&
            log.args.buyer?.toLowerCase() === terms.buyer.toLowerCase(),
        );
        if (!registeredLog) throw new Error("Matching finalized TransactionRegistered event was not found");
        lifecycle.agreement = await verifyEventReceipt(paymentClient, registeredLog, "TransactionRegistered");

        if (paymentStatus > 0n) {
          const logs = await paymentClient.getLogs({
            address: addresses.payment,
            event: parseAbiItem("event PaymentLocked(bytes32 indexed transactionId, bytes32 termsHash, address payer, uint256 amount)"),
            args: { transactionId },
            fromBlock: paymentFromBlock,
            toBlock: "finalized",
          });
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
          const logs = await paymentClient.getLogs({
            address: addresses.payment,
            event: parseAbiItem("event DecisionRecorded(bytes32 indexed transactionId, bytes32 termsHash, uint8 decision)"),
            args: { transactionId },
            fromBlock: paymentFromBlock,
            toBlock: "finalized",
          });
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
          const logs = await paymentClient.getLogs({
            address: addresses.payment,
            event,
            args: { transactionId },
            fromBlock: paymentFromBlock,
            toBlock: "finalized",
          });
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
      setTransactionIdInput(transactionId);
      if (assetReadError) {
        setReadError(`Chain A read succeeded; Chain B reservation read failed: ${assetReadError}`);
      } else if (lifecycleReadError) {
        setReadError(`Contract state was read, but lifecycle event verification failed: ${lifecycleReadError}`);
      }
    } catch (error) {
      setSnapshot(null);
      setReadError(`Could not read the Chain A transaction: ${errorMessage(error)}`);
    }
  }, [addresses]);

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
        const logs = await paymentClient.getLogs({
          address: addresses.payment,
          event: parseAbiItem("event TransactionRegistered(bytes32 indexed transactionId, bytes32 termsHash, address buyer)"),
          fromBlock,
          toBlock,
        });
        const discovered = logs
          .filter((log): log is typeof log & { args: { transactionId: Hex } } => Boolean(log.args.transactionId))
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

  useEffect(() => {
    if (!addresses) return;
    let cancelled = false;
    async function initializeVerification() {
      setVerificationBusy(true);
      setVerificationError(null);
      try {
        const [finalizedBlock, latestBlock] = await Promise.all([
          paymentClient.getBlock({ blockTag: "finalized" }),
          paymentClient.getBlockNumber(),
        ]);
        const deploymentBlock = process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK
          ? BigInt(process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK)
          : 0n;
        const endBlock = finalizedBlock.number ?? latestBlock;
        verificationFloorRef.current = deploymentBlock;
        verificationCursorRef.current = endBlock;
        verificationCandidatesRef.current = [];
        verificationHasMoreRef.current = endBlock >= deploymentBlock;
        setVerificationHasMore(endBlock >= deploymentBlock);
        if (!cancelled) {
          setVerificationEntries([]);
          await loadVerificationBatch(2);
        }
      } catch (error) {
        if (!cancelled) {
          setVerificationError(errorMessage(error));
          setVerificationBusy(false);
        }
      }
    }
    void initializeVerification();
    return () => { cancelled = true; };
  }, [addresses]);

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

  async function createTransaction(event: FormEvent<HTMLFormElement>) {
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
      const seller = parseAddress(sellerInput);
      if (seller.toLowerCase() === address.toLowerCase()) {
        throw new Error("Buyer and seller must be different wallet addresses");
      }
      const paymentAmount = parseUnits(paymentAmountInput, 18);
      const assetAmount = parseUnits(assetAmountInput, 18);
      const expiryMinutes = Number(expiryMinutesInput);
      if (paymentAmount <= 0n || assetAmount <= 0n) throw new Error("Amounts must be greater than zero");
      if (!Number.isSafeInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 1440) {
        throw new Error("Expiry must be between 1 and 1440 minutes");
      }

      const terms: Terms = {
        transactionId: createTransactionId(address),
        buyer: address,
        seller,
        paymentChainId: 11155111n,
        paymentContract: addresses.payment,
        paymentInputToken: addresses.paymentToken,
        paymentInputAmount: paymentAmount,
        paymentToken: addresses.paymentToken,
        paymentAmount,
        amountOutMin: 0n,
        assetChainId: 84532n,
        assetSettlement: addresses.asset,
        assetToken: addresses.assetToken,
        assetAmount,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + expiryMinutes * 60),
        schemaVersion: 1,
      };
      const termsHash = hashTerms(terms);
      const hash = await walletClient.writeContract({
        address: addresses.payment,
        abi: decisionPaymentSettlementAbi,
        functionName: "registerTransaction",
        args: [terms],
      });
      const receipt = await waitForSuccess(sepolia.id, hash, terms.transactionId, addresses.payment);
      recordReceipt(sepolia.id, terms.transactionId, addresses.payment, "Agreement registered", receipt);
      await refreshTransaction(terms.transactionId);
      window.history.replaceState(null, "", `/?id=${terms.transactionId}`);
      setSuccessMessage(`Agreement registered. Terms hash: ${termsHash}`);
    } catch (error) {
      setActionError(errorMessage(error));
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

      const walletClient = createTransactionWalletClient(getInjectedProvider(), address, sepolia.id);
      const approvalHash = await walletClient.writeContract({
        address: snapshot.terms.paymentInputToken,
        abi: mockErc20Abi,
        functionName: "approve",
        args: [addresses.payment, snapshot.terms.paymentInputAmount],
      });
      const approvalReceipt = await waitForSuccess(
        sepolia.id,
        approvalHash,
        snapshot.terms.transactionId,
        snapshot.terms.paymentInputToken,
      );
      recordReceipt(sepolia.id, snapshot.terms.transactionId, snapshot.terms.paymentInputToken, "Payment approval", approvalReceipt);

      const lockHash = await walletClient.writeContract({
        address: addresses.payment,
        abi: decisionPaymentSettlementAbi,
        functionName: "lockPayment",
        args: [snapshot.terms.transactionId, snapshot.termsHash],
      });
      const lockReceipt = await waitForSuccess(sepolia.id, lockHash, snapshot.terms.transactionId, addresses.payment);
      recordReceipt(sepolia.id, snapshot.terms.transactionId, addresses.payment, "Payment locked", lockReceipt);
      await refreshTransaction(snapshot.terms.transactionId);
      setSuccessMessage("Payment reservation confirmed on Ethereum Sepolia.");
    } catch (error) {
      setActionError(errorMessage(error));
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

      const [currentDecision, currentPayment, currentAsset] = await Promise.all([
        paymentClient.readContract({
          address: addresses.payment,
          abi: decisionPaymentSettlementAbi,
          functionName: "getDecision",
          args: [snapshot.terms.transactionId],
          blockTag: "finalized",
        }),
        paymentClient.readContract({
          address: addresses.payment,
          abi: decisionPaymentSettlementAbi,
          functionName: "getTransaction",
          args: [snapshot.terms.transactionId],
          blockTag: "finalized",
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
      const paymentLogs = await paymentClient.getLogs({
        address: addresses.payment,
        event: paymentEvent,
        args: { transactionId: snapshot.terms.transactionId },
        fromBlock: process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK
          ? BigInt(process.env.NEXT_PUBLIC_PAYMENT_DEPLOYMENT_BLOCK)
          : 0n,
        toBlock: "finalized",
      });
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
          <p>Start a new agreement or inspect an existing transaction. Either path can be used independently.</p>
        </div>
        <div className="settlement-action-list">
          <button className="settlement-action-button create-action" type="button" onClick={() => setActiveActionPanel("create")}>
            <span className="settlement-action-symbol">+</span>
            <span><small>NEW AGREEMENT</small><strong>Create Transaction</strong><em>Agree terms and register on Ethereum Sepolia</em></span>
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
          aria-label={activeActionPanel === "create" ? "Create transaction" : "Open an agreement"}
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
          <form onSubmit={createTransaction} className="form">
            <label>
              Seller wallet
              <span className="field-hint">Seller address on Base Sepolia</span>
              <input
                autoComplete="off"
                placeholder="0x…"
                value={sellerInput}
                onChange={(event) => setSellerInput(event.target.value)}
                required
              />
            </label>
            <div className="form-row">
              <label>
                Payment amount
                <span className="field-hint">Payment token amount · 18 decimals</span>
                <input
                  inputMode="decimal"
                  value={paymentAmountInput}
                  onChange={(event) => setPaymentAmountInput(event.target.value)}
                  required
                />
              </label>
              <label>
                Asset quantity
                <span className="field-hint">Asset token quantity · 18 decimals</span>
                <input
                  inputMode="decimal"
                  value={assetAmountInput}
                  onChange={(event) => setAssetAmountInput(event.target.value)}
                  required
                />
              </label>
            </div>
            <label>
              Expiry (minutes)
              <span className="field-hint">Agreement lifetime · 1 to 1440 minutes</span>
              <input
                type="number"
                min="1"
                max="1440"
                value={expiryMinutesInput}
                onChange={(event) => setExpiryMinutesInput(event.target.value)}
                required
              />
            </label>
            <p className="muted small">
              Amounts use 18 decimal places. Registering the agreement does not move funds; Alice and Bob submit their own locks.
            </p>
            <div className="form-actions">
              <button className="button secondary" type="button" onClick={() => setActiveActionPanel(null)}>Cancel</button>
              <button className={`button action-submit${busyAction === "create" ? " is-loading" : ""}`} disabled={!isConnected || !addresses || busyAction !== null}>
                {busyAction === "create" ? "Registering…" : "Create and register"}
              </button>
            </div>
          </form>
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
            {(actionError || readError || successMessage) && (
              <div className="dialog-errors">
                {actionError && <p className="notice error" role="alert">{actionError}</p>}
                {activeActionPanel === "open" && readError && <p className="notice error" role="alert">{readError}</p>}
                {successMessage && <p className="notice success" role="status">{successMessage}</p>}
              </div>
            )}
          </div>
        </dialog>
      )}

      {!activeActionPanel && actionError && <div className="notice error" role="alert">{actionError}</div>}
      {!activeActionPanel && readError && <div className="notice error" role="alert">{readError}</div>}
      {!activeActionPanel && successMessage && <div className="notice success" role="status">{successMessage}</div>}

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
                {busyAction === "payment" ? "Locking payment…" : "Alice: approve and lock payment"}
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
            <button type="button" className="button secondary" onClick={() => void loadVerificationBatch(2)} disabled={verificationBusy}>Retry scan</button>
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

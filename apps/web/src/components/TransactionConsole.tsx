"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
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
};

type TransactionReference = {
  chainId: number;
  hash: Hex;
  label: string;
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

export function TransactionConsole() {
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

  const refreshTransaction = useCallback(async (transactionId: Hex) => {
    if (!addresses) return;
    setReadError(null);
    try {
      const paymentResult = await paymentClient.readContract({
        address: addresses.payment,
        abi: decisionPaymentSettlementAbi,
        functionName: "getTransaction",
        args: [transactionId],
        blockTag: "finalized",
      });

      const terms = paymentResult[0];
      let assetStatus: bigint | null = null;
      let assetDecision: bigint | null = null;
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
      } catch (error) {
        assetReadError = errorMessage(error);
      }

      setSnapshot({
        terms,
        termsHash: paymentResult[1],
        decision: BigInt(paymentResult[2]),
        paymentStatus: BigInt(paymentResult[3]),
        assetStatus,
        assetDecision,
        assetReadError,
      });
      setTransactionIdInput(transactionId);
      if (assetReadError) {
        setReadError(`Chain A read succeeded; Chain B reservation read failed: ${assetReadError}`);
      }
    } catch (error) {
      setSnapshot(null);
      setReadError(`Could not read the Chain A transaction: ${errorMessage(error)}`);
    }
  }, [addresses]);

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

  async function waitForSuccess(chainIdToRead: number, hash: Hex) {
    const client = chainIdToRead === sepolia.id ? paymentClient : assetClient;
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
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
      await waitForSuccess(sepolia.id, hash);
      setReferences((current) => [...current, { chainId: sepolia.id, hash, label: "Agreement registered" }]);
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
      await waitForSuccess(sepolia.id, approvalHash);
      setReferences((current) => [...current, { chainId: sepolia.id, hash: approvalHash, label: "Payment approval" }]);

      const lockHash = await walletClient.writeContract({
        address: addresses.payment,
        abi: decisionPaymentSettlementAbi,
        functionName: "lockPayment",
        args: [snapshot.terms.transactionId, snapshot.termsHash],
      });
      await waitForSuccess(sepolia.id, lockHash);
      setReferences((current) => [...current, { chainId: sepolia.id, hash: lockHash, label: "Payment locked" }]);
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
      await waitForSuccess(baseSepolia.id, approvalHash);
      setReferences((current) => [...current, { chainId: baseSepolia.id, hash: approvalHash, label: "Asset approval" }]);

      const lockHash = await walletClient.writeContract({
        address: addresses.asset,
        abi: assetSettlementAbi,
        functionName: "lockAsset",
        args: [snapshot.terms, snapshot.termsHash],
      });
      await waitForSuccess(baseSepolia.id, lockHash);
      setReferences((current) => [...current, { chainId: baseSepolia.id, hash: lockHash, label: "Asset locked" }]);
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
      await waitForSuccess(sepolia.id, hash);
      setReferences((current) => [...current, { chainId: sepolia.id, hash, label: "Chain A abort" }]);
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
        setReferences((current) => [
          ...current,
          { chainId: arkivChain.id, hash: arkivTxHash, label: "Arkiv evidence" },
        ]);
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
    await refreshTransaction(transactionIdInput as Hex);
  }

  const expired = snapshot && BigInt(Math.floor(Date.now() / 1000)) >= snapshot.terms.expiresAt;
  const currentStatus = snapshot
    ? snapshot.decision === 0n && expired
      ? "EXPIRED_UNDECIDED"
      : statusLabel(snapshot.decision, snapshot.paymentStatus, snapshot.assetStatus)
    : null;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Ethereum Sepolia ↔ Base Sepolia</p>
          <h1>RaisinFi settlement workspace</h1>
          <p className="muted">One agreement. Two independently verified obligations.</p>
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
        </div>
      </header>

      {configurationError && (
        <div className="notice error" role="alert">
          Contract configuration is incomplete: {configurationError}. Copy `apps/web/.env.example` to `.env.local` and set deployed addresses.
        </div>
      )}

      <section className="grid">
        <article className="card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">New agreement</p>
              <h2>Create transaction</h2>
            </div>
            <span className={`chain-pill ${chainId === sepolia.id ? "active" : ""}`}>Ethereum Sepolia</span>
          </div>
          <form onSubmit={createTransaction} className="form">
            <label>
              Seller wallet
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
                <input
                  inputMode="decimal"
                  value={paymentAmountInput}
                  onChange={(event) => setPaymentAmountInput(event.target.value)}
                  required
                />
              </label>
              <label>
                Asset quantity
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
            <button className="button" disabled={!isConnected || !addresses || busyAction !== null}>
              {busyAction === "create" ? "Registering…" : "Create and register"}
            </button>
          </form>
        </article>

        <article className="card">
          <p className="eyebrow">Open transaction</p>
          <h2>Load agreement</h2>
          <form onSubmit={loadTransaction} className="form">
            <label>
              Transaction ID
              <input
                autoComplete="off"
                placeholder="0x + 64 hex characters"
                value={transactionIdInput}
                onChange={(event) => setTransactionIdInput(event.target.value)}
              />
            </label>
            <button className="button secondary" disabled={!addresses}>Read both chains</button>
          </form>
          <div className="separator" />
          <div className="chain-actions">
            <div>
              <strong>Connected chain</strong>
              <span>{chainId === sepolia.id ? "Ethereum Sepolia" : chainId === baseSepolia.id ? "Base Sepolia" : chainId ? `Unsupported (${chainId})` : "Not connected"}</span>
            </div>
            {isConnected && chainId !== sepolia.id && (
              <button className="button secondary" onClick={() => void changeWalletChain(sepolia.id)} disabled={isSwitching}>
                Switch to Ethereum
              </button>
            )}
            {isConnected && chainId !== baseSepolia.id && (
              <button className="button secondary" onClick={() => void changeWalletChain(baseSepolia.id)} disabled={isSwitching}>
                Switch to Base
              </button>
            )}
          </div>
        </article>
      </section>

      {actionError && <div className="notice error" role="alert">{actionError}</div>}
      {readError && <div className="notice error" role="alert">{readError}</div>}
      {successMessage && <div className="notice success" role="status">{successMessage}</div>}

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
                <span className="status">{["NOT_LOCKED", "LOCKED", "PAID", "REFUNDED"][Number(snapshot.paymentStatus)] ?? "UNKNOWN"}</span>
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
                <span className="status">
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

      <section className="grid lower-grid">
        <article className="card">
          <p className="eyebrow">Evidence</p>
          <h2>Chain receipts</h2>
          {references.length === 0 ? (
            <p className="muted">Transaction hashes from this browser session will appear here. Contract state remains the source of truth.</p>
          ) : (
            <ul className="reference-list">
              {references.map((reference) => (
                <li key={`${reference.chainId}-${reference.hash}`}>
                  <span>{reference.label}</span>
                  <a
                    href={`${reference.chainId === sepolia.id ? "https://sepolia.etherscan.io" : "https://sepolia.basescan.org"}/tx/${reference.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {reference.hash.slice(0, 12)}… ↗
                  </a>
                </li>
              ))}
            </ul>
          )}
        </article>
        <article className="card">
          <p className="eyebrow">Public record</p>
          <h2>Arkiv evidence</h2>
          <p className="muted">
            Creates a public, non-sensitive record on Rabdi after both chain outcomes are finalized. Writing requires Rabdi testnet tGLM. Arkiv is evidence, not settlement authority.
          </p>
          <div className="chain-actions">
            {isConnected && chainId !== arkivChain.id && (
              <button className="button secondary" onClick={() => void changeWalletChain(arkivChain.id)} disabled={isSwitching}>
                Switch to Arkiv Rabdi
              </button>
            )}
            <button
              className="button"
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
              Retrieve by transaction ID
            </button>
          </div>
          {arkivError && <p className="error-text" role="alert">{arkivError}</p>}
          {arkivResult && (
            <div className="evidence-result">
              <p><strong>{arkivResult.created ? "Created entity" : "Retrieved entity"}</strong></p>
              <code>{arkivResult.entityKey}</code>
              <p>Outcome: {arkivResult.status} · {arkivResult.decision}</p>
              <a href={arkivChain.blockExplorers.default.url} target="_blank" rel="noreferrer">Open Rabdi explorer ↗</a>
            </div>
          )}
          <div className="separator" />
          <p className="eyebrow">Optional conversion</p>
          <p className="muted small">
            Uniswap is not enabled. The direct payment path stays active until a real Sepolia router, pair, and liquidity spike succeeds.
          </p>
        </article>
      </section>

      <footer>
        UI status is reconciled from chain reads. A Chain A COMMIT does not mean Chain B has settled.
      </footer>
    </main>
  );
}

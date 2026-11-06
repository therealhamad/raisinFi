# CRE and settlement contract interfaces

Status: **Developer 2 implementation proposal; CRE workflow owner must confirm these ABI encodings before integration or deployment.**

The settlement contracts are implemented under `contracts/`. This file is the cross-developer integration contract; do not silently change field order, enum values, or event signatures.

## Chain IDs and decision values

| Network | Chain ID |
|---|---:|
| Ethereum Sepolia (Chain A) | `11155111` |
| Base Sepolia (Chain B) | `84532` |

`Decision` uses `UNDECIDED = 0`, `COMMIT = 1`, `ABORT = 2`. The payment and asset status enums are declared in `contracts/src/ProtocolTypes.sol`.

## Canonical terms

Both contracts receive the same static `Terms` tuple, in this order:

```solidity
struct Terms {
    bytes32 transactionId;
    address buyer;
    address seller;
    uint256 paymentChainId;
    address paymentContract;
    address paymentInputToken;
    uint256 paymentInputAmount;
    address paymentToken;
    uint256 paymentAmount;
    uint256 amountOutMin;
    uint256 assetChainId;
    address assetSettlement;
    address assetToken;
    uint256 assetAmount;
    uint256 expiresAt;
    uint32 schemaVersion;
}
```

Schema version `1` is supported. `termsHash` is:

```solidity
keccak256(abi.encode(TERMS_TYPEHASH, ...terms fields in the order above))
```

`TERMS_TYPEHASH` is the hash of:

```text
RaisinFiTerms(bytes32 transactionId,address buyer,address seller,uint256 paymentChainId,address paymentContract,address paymentInputToken,uint256 paymentInputAmount,address paymentToken,uint256 paymentAmount,uint256 amountOutMin,uint256 assetChainId,address assetSettlement,address assetToken,uint256 assetAmount,uint256 expiresAt,uint32 schemaVersion)
```

The current payment execution path is direct-token only: input token/amount must equal output token/amount, and `amountOutMin` must be zero. A swap path remains gated on a successful real Uniswap testnet spike.

## Contract calls and reads

### `DecisionPaymentSettlement` (Chain A)

```solidity
function registerTransaction(Terms calldata terms) external returns (bytes32 termsHash);
function lockPayment(bytes32 transactionId, bytes32 termsHash) external;
function abort(bytes32 transactionId) external;
function onReport(bytes calldata metadata, bytes calldata report) external;
function getTransaction(bytes32 transactionId)
    external view returns (Terms, bytes32 termsHash, Decision, PaymentStatus);
function getDecision(bytes32 transactionId)
    external view returns (
        Decision decision,
        bytes32 termsHash,
        uint256 sourceChainId,
        address sourceContract,
        bytes32 recordId,
        uint64 nonce,
        uint256 decisionBlockNumber
    );
```

The buyer first registers the immutable agreement, then authorizes `lockPayment` from their own wallet. This supports a permissionless post-expiry ABORT even when no payment was locked. COMMIT requires a valid Forwarder report, a locked payment, and an unexpired transaction; payment and the COMMIT write revert atomically on any token-transfer failure.

### `AssetSettlement` (Chain B)

```solidity
constructor(address trustedForwarder, uint256 paymentChainId, address paymentContract);
function lockAsset(Terms calldata terms, bytes32 expectedTermsHash) external;
function onReport(bytes calldata metadata, bytes calldata report) external;
function getAssetReservation(bytes32 transactionId)
    external view returns (
        Terms,
        bytes32 termsHash,
        AssetStatus,
        Decision,
        bytes32 decisionRecordId,
        uint64 decisionNonce
    );
```

Only the seller may lock the asset. A local timeout does not release it. Only a valid authenticated COMMIT/ABORT report can deliver or release the reservation.

## Events

These signatures match the existing CRE lock triggers:

```solidity
event PaymentLocked(bytes32 indexed transactionId, bytes32 termsHash, address payer, uint256 amount);
event AssetLocked(bytes32 indexed transactionId, bytes32 termsHash, address seller, uint256 amount);
```

Other settlement events:

```solidity
event TransactionRegistered(bytes32 indexed transactionId, bytes32 termsHash, address buyer);
event DecisionRecorded(bytes32 indexed transactionId, bytes32 termsHash, Decision decision);
event PaymentExecuted(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);
event PaymentReleased(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);
event DecisionReceived(bytes32 indexed transactionId, bytes32 termsHash, Decision decision, bytes32 decisionRecordId);
event AssetDelivered(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);
event AssetReleased(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);
```

## CRE receiver and report encoding proposal

Both contracts implement `IReceiver.onReport(bytes metadata, bytes report)`. Each checks `msg.sender` against its immutable, deployment-configured tenant Forwarder. Configure the actual Forwarder from authenticated `cre workflow supported-chains` output; do not use a simulator mock address in a testnet deployment.

Encode each report as one ABI-encoded static tuple matching the field order below (equivalent to Solidity `abi.encode(reportStruct)`). The receiver decodes the tuple using the corresponding `ProtocolTypes` struct.

### Chain A coordination report

```solidity
struct CoordinationReport {
    bytes32 transactionId;
    bytes32 termsHash;
    uint256 paymentChainId;
    address paymentContract;
    uint256 assetChainId;
    address assetSettlement;
    address buyer;
    address seller;
    address paymentInputToken;
    uint256 paymentInputAmount;
    address paymentToken;
    uint256 paymentAmount;
    address assetToken;
    uint256 assetAmount;
    uint256 expiresAt;
    bool paymentLocked;
    bool assetLocked;
}
```

The receiver compares every field with the registered Chain A terms, checks its local payment lock, and requires both report lock flags. The `assetLocked` assertion is trusted only because the report came through the configured CRE Forwarder; the CRE workflow must reread the Base reservation and fail closed on missing/mismatched reads.

### Chain B authoritative decision relay

```solidity
struct DecisionRelayReport {
    bytes32 transactionId;
    bytes32 termsHash;
    Decision decision;
    uint256 sourceChainId;
    address sourceContract;
    uint256 destinationChainId;
    address destinationContract;
    bytes32 assetObligationId;
    bytes32 decisionRecordId;
    uint64 decisionNonce;
    uint256 sourceDecisionBlockNumber;
    address buyer;
    address seller;
    address assetToken;
    uint256 assetAmount;
    uint256 expiresAt;
}
```

`decisionRecordId` is:

```text
keccak256(abi.encode(DECISION_RECORD_TYPEHASH, sourceChainId, sourceContract,
                     transactionId, termsHash, uint8(decision), decisionNonce))
```

`assetObligationId` is computed by `AssetSettlement.computeAssetObligationId(Terms)`. The current single-decision MVP uses nonce `1`. Chain B checks source chain/contract, destination chain/consumer, transaction/terms, obligation ID, decision reference, participants, token, amount and expiry before executing exactly once. `sourceDecisionBlockNumber` must be included from the Chain A decision read; finality remains a CRE read policy, not something proved by this block number alone.

## Deployment configuration and remaining integration

- Set the actual Forwarder separately for each network/tenant in deployment configuration.
- Deploy Chain A before Chain B because the asset consumer pins the Chain A address. Use the resulting addresses in the canonical terms.
- The CRE lock handlers currently use the exact lock event signatures above. The checked-in `my-workflow/workflow.ts` only decodes/logs those lock events; it does not yet read the settlement getters or submit either report. Update its report encoding and decision relay to this proposal only after the CRE workflow owner confirms it.
- The test fixture Forwarder is a local signer, not a CRE simulation or production Forwarder.
- `docs/CRE_SPIKE_RESULTS.md` records that DON deploy access is pending and no real EVM Write smoke test has run.

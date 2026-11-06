# CRE and settlement contract interfaces

Status: **Developer 2 implementation proposal; CRE workflow owner must confirm these ABI encodings before integration or deployment.**

The settlement contracts are implemented under `contracts/`. This file is the cross-developer integration contract; do not silently change field order, enum values, or event signatures.

## Chain IDs and decision values
## Tenant Forwarders

The user's tenant output provides `address` and `mockAddress` for each chain. Use the `address` value for the deployed receiver's Forwarder allowlist; retain `mockAddress` for the local simulator configuration only.

| Chain | Tenant Forwarder (`address`) | Simulation mock (`mockAddress`) |
|---|---|---|
| Ethereum Sepolia | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| Base Sepolia | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` |

## Proposed reservation read interface

The CRE workflow now compiles against the following proposed view functions. Developer 2 should confirm these names, output order, and enum values before implementing the contracts or deploying them:

```solidity
enum ReservationStatus { NONE, LOCKED, EXECUTED, RELEASED }
enum Decision { UNDECIDED, COMMIT, ABORT }

function getPaymentReservation(bytes32 transactionId) external view returns (
    bytes32 reservationTransactionId,
    bytes32 termsHash,
    bytes32 paymentObligationId,
    address buyer,
    address seller,
    address paymentToken,
    uint256 paymentAmount,
    uint256 expiresAt,
    uint8 status
);

function getAssetReservation(bytes32 transactionId) external view returns (
    bytes32 reservationTransactionId,
    bytes32 termsHash,
    bytes32 assetObligationId,
    address buyer,
    address seller,
    address assetToken,
    uint256 assetAmount,
    uint256 expiresAt,
    uint8 status
);

function getDecision(bytes32 transactionId) external view returns (
    bytes32 decisionTransactionId,
    bytes32 termsHash,
    bytes32 paymentObligationId,
    bytes32 assetObligationId,
    uint8 decision,
    bytes32 recordId
);
```

The proposed enum encoding is `ReservationStatus: NONE=0, LOCKED=1, EXECUTED=2, RELEASED=3` and `Decision: UNDECIDED=0, COMMIT=1, ABORT=2`. Missing reservations should return their requested transaction ID, zeroed terms/fields, and `NONE`; a missing decision should return the requested transaction ID, zeroed terms/record ID, and `UNDECIDED`. CRE compares both reads' transaction ID, terms hash, obligation IDs, buyer, seller, expiry, token, and amount fields; it requires both status values to be `LOCKED` and the deadline to remain open before marking COMMIT eligible.

The workflow's ABI constants currently implement this proposal for local typechecking. They must be changed to match the agreed/deployed ABI if Developer 2 chooses different getters or enum values.

## Chain A lock event

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
The proposed `getDecision` read also returns both obligation IDs. It must return transaction and terms binding, source contract identity, decision value, and a stable record ID/nonce. The exact record reference remains to be agreed.

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
The TypeScript currently encodes these proposed ABI tuples:

```solidity
// Chain A readiness report
(bytes32 transactionId, bytes32 termsHash,
 uint256 paymentChainId, address paymentContract,
 uint256 assetChainId, address assetContract,
 bytes32 paymentObligationId, bytes32 assetObligationId)

// Chain B decision relay report
(uint256 sourceChainId, address sourceContract,
 bytes32 transactionId, bytes32 termsHash,
 bytes32 paymentObligationId, bytes32 assetObligationId,
 uint8 decision, bytes32 recordId,
 uint256 sourceDecisionBlockNumber, bytes32 sourceDecisionBlockHash,
 uint256 destinationChainId, address destinationContract)
```

The Chain B consumer should implement the official CRE receiver pattern `onReport(bytes metadata, bytes report)` and authenticate the tenant Forwarder. The tuple layouts, consumer handling, and onchain binding checks remain proposals for contract-owner agreement. `enableWrites` is false by default; do not enable it until the receiver implementation and deployed addresses match this interface.

For the first write spike, the Chain A consumer's report must carry the agreed transaction and terms binding needed by its contract-side precondition checks. The proposed ABI encoding above still requires contract-owner review.

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

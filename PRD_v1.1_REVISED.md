# Product Requirements Document (PRD)
# Multi-Chain Transaction Coordination Platform

**Version:** 1.1  
**Status:** Revised implementation baseline — CRE network support verified; protocol and 24-hour scope frozen  
**Project type:** ETHGlobal Hackathon  
**Team size:** 2 developers  
**Target:** Functional end-to-end demonstration  
**Primary technologies:** Next.js + TypeScript, Solidity + Hardhat, Chainlink CRE (TypeScript SDK), Arkiv, Uniswap

---

# 1. Executive Summary

## 1.1 Product Overview

We are building a coordination platform for multi-chain financial transactions.

The platform enables participants to create, approve, coordinate, monitor and verify financial transactions whose individual obligations execute across independent blockchain networks.

A transaction may involve:
- Multiple participants.
- Multiple digital assets.
- Multiple blockchain networks.
- Different settlement obligations.
- Conditional execution requirements.

Rather than treating each payment or asset transfer as an independent operation, the platform represents the entire agreement as one transaction with a shared lifecycle.

The coordination engine manages the transaction lifecycle, evaluates settlement conditions, coordinates execution and maintains verifiable transaction evidence.

The platform integrates:

- **Chainlink CRE:** Event-driven, consensus-verified workflow orchestration.
- **Arkiv:** Queryable and tamper-evident transaction records.
- **Uniswap:** Optional token conversion and liquidity access.
- **Smart contracts:** Asset reservation, authorisation and settlement enforcement.

## 1.2 Product Vision

Make complex multi-chain financial transactions easier to initiate, coordinate, monitor and verify through one unified transaction experience.

## 1.3 Product Positioning

A coordination platform for financial transactions across independent blockchain networks.

We are not positioning the product primarily as a bridge, decentralised exchange, wallet or custody solution.

The central product concept is:

**One financial transaction. Multiple settlement obligations. One unified transaction experience.**

The MVP demonstrates EVM-to-EVM interoperability across two independent networks (Ethereum Sepolia and Base Sepolia). EVM compatibility does not make these networks one chain: they have separate chain IDs, state, balances, contracts and execution/finality. The architecture may later add heterogeneous networks such as Solana, but Solana is not part of this hackathon implementation.

---

# 2. Problem Statement

## 2.1 Background

Financial applications increasingly operate across multiple blockchain networks.

Tokenised securities, stablecoins, digital funds and other assets may exist on different networks, each with independent execution environments and transaction finality.

A financial agreement can involve operations on multiple networks that are economically connected but technically independent.

For example:

Alice purchases 100 tokenised Treasury fund units from Bob for 1,000 USDC.

- Alice's payment exists on Ethereum.
- Bob's tokenised asset exists on Base.
- Payment and asset transfer execute independently.
- Neither blockchain inherently maintains the complete financial transaction state.

This creates a coordination problem.

## 2.2 Core Problems

### P1. Fragmented transaction state

Each blockchain maintains its own state.

Participants must independently determine whether every obligation belonging to a financial transaction has been completed.

There is no shared application-level transaction lifecycle across these independent environments.

### P2. Coordination complexity

When multiple settlement obligations are involved, applications must coordinate:

- Participant authorisations.
- Asset availability.
- Reservation acknowledgements.
- Settlement conditions.
- Execution instructions.
- Transaction receipts.

This requires considerable application-specific orchestration.

### P3. Partial execution risk

One settlement operation may succeed while another fails.

For example:
- Payment succeeds.
- Asset transfer fails.

A transaction that is economically indivisible can therefore result in an incomplete outcome.

### P4. Limited transaction-level visibility

Participants often have to inspect separate blockchain explorers, contracts and transaction references to understand the overall outcome.

There is no unified view of the transaction's complete lifecycle and evidence.

## 2.3 Problem Statement

There is a need for a coordination platform that represents multi-chain financial agreements as unified transactions, coordinates their individual settlement obligations and provides participants with a verifiable view of their execution and outcome.

---

# 3. Goals and Non-Goals

## 3.1 Primary Goals

1. Provide one transaction workspace for a financial agreement whose obligations execute on independent chains.
2. Demonstrate cross-chain coordination between Ethereum Sepolia and Base Sepolia (EVM-to-EVM interoperability).
3. Represent the agreement as one parent transaction with two independently identifiable settlement obligations.
4. Require buyer and seller to authorise their own payment-side and asset-side reservations from their wallets.
5. Use Chainlink CRE EVM log triggers, cross-chain reads, consensus-backed workflow execution and EVM writes to coordinate the authoritative decision and its relay.
6. Enforce a write-once COMMIT/ABORT decision on Chain A and idempotent execution on Chain B.
7. Publish and retrieve an inspectable transaction/evidence record through Arkiv.
8. Integrate Uniswap into the Chain A payment execution path when the testnet deployment and liquidity spike succeeds.
9. Provide a clear transaction timeline showing decision outcome separately from each chain's execution progress.
10. Keep the implementation achievable by two developers within the remaining 24-hour hackathon window.

## 3.2 Hackathon Success Criteria

The demonstration must prove that:

- Alice and Bob agree to the same canonical transaction terms.
- Alice independently locks/authorises the payment input on Ethereum Sepolia.
- Bob independently locks the asset on Base Sepolia.
- CRE observes the lock events and reads both contracts using the required confidence level.
- CRE submits a report to the Chain A settlement contract only when both matching reservations are verified.
- Chain A records exactly one decision and executes payment atomically with COMMIT.
- CRE observes the finalized Chain A decision and relays it to Base Sepolia.
- Base executes the asset transfer once on COMMIT, or releases the reservation once on ABORT.
- A permissionless post-expiry abort works while the decision is still UNDECIDED.
- Arkiv evidence can be written and retrieved by transaction identifier.
- The user interface exposes pending/partial states honestly.

The demo must distinguish CRE local simulation from a workflow actually deployed and executed by a DON. If DON deployment access is unavailable, the limitation must be disclosed and no live DON-consensus claim may be made.

## 3.3 Non-Goals

The hackathon implementation will not attempt to build:

- A production securities marketplace.
- A regulated investment platform.
- Real Treasury fund issuance or transfer.
- Production-grade institutional identity/KYC infrastructure.
- A universal cross-chain messaging protocol.
- A production BFT consensus implementation outside CRE.
- A general-purpose liquidity aggregation platform.
- Arbitrary support for every blockchain.
- A guaranteed atomic settlement protocol across all heterogeneous networks.
- Institutional integrations such as CBDC, UPI or RTGS.

---

# 4. Primary Use Case

## 4.1 Tokenised Treasury Fund Purchase

The flagship demonstration represents a secondary-market purchase of tokenised Treasury fund units.

**Participants**

- Alice: Buyer.
- Bob: Seller.
- Coordination platform: Manages the transaction.
- Ethereum: Payment settlement environment.
- Base: Asset settlement environment.

**Transaction terms**

| Attribute | Value |
|---|---|
| Transaction type | Delivery-versus-payment |
| Buyer | Alice |
| Seller | Bob |
| Asset | Treasury Fund Token |
| Asset quantity | 100 units |
| Payment asset | USDC |
| Payment amount | 1,000 USDC |
| Payment network | Ethereum Sepolia |
| Asset network | Base Sepolia |
| Expiration | 15 minutes (configurable) |

The demonstration uses ordinary test ERC-20 tokens only. Do not implement simulated fund-transfer restrictions or imply that the token is an actual Treasury security. The Treasury purchase is a pitch narrative; the on-chain demo is a generic test-token delivery-versus-payment transaction. It does not represent an investment, regulated security transfer or legal change of ownership.

## 4.2 User Journey

### Stage 1: Create and accept the agreement

Alice creates the transaction with Bob as seller. The application calculates a canonical `termsHash` from a typed/deterministically encoded structure. Both participants review and authorise the same terms. Once signed, terms are immutable.

### Stage 2: Participant-owned reservations

- Alice submits her payment-side lock/authorisation transaction on Ethereum Sepolia.
- Bob submits his asset-side lock transaction on Base Sepolia.
- Both lock operations bind the same `transactionId` and `termsHash`.
- CRE cannot spend either participant's tokens or manufacture participant authorisation.

### Stage 3: CRE verifies readiness

A lock event on either chain triggers the CRE workflow. The workflow reads both chain contracts, verifies the transaction ID, terms hash, participants, amounts, reservation state and expiry, and only proceeds when both reservations match.

### Stage 4: Chain A records the authoritative decision

Ethereum Sepolia is Chain A and contains one `PaymentDecisionSettlement` contract. This same contract holds Alice's payment reservation and the write-once decision register. There is no separate decision-registry contract.

If both reservations are valid, CRE submits its authenticated report to Chain A. The contract atomically records COMMIT and executes the payment (including the configured Uniswap swap, if enabled) in the same EVM transaction. If payment execution or the swap reverts, the entire transaction reverts and the decision remains UNDECIDED.

If the deadline has passed while the decision remains UNDECIDED, any account may call `abort()`. The contract records ABORT once and releases Alice's payment reservation. No privileged participant or backend operator is required to unblock the transaction.

### Stage 5: CRE relays the decision to Chain B

CRE observes Chain A's decision and reads it at `FINALIZED` confidence before relaying it. The workflow submits the decision report to Base Sepolia's asset settlement consumer. The consumer verifies the report through the supported CRE Forwarder/receiver pattern and checks all transaction-specific fields.

- COMMIT: Base transfers Bob's reserved asset to Alice exactly once.
- ABORT: Base releases Bob's reservation back to Bob exactly once.

Base never decides independently and never refunds from its own local timer.

### Stage 6: Evidence and completion

The application verifies the relevant chain events and receipts, waits for the configured finality policy on each chain, writes a public non-sensitive transaction record to Arkiv, and demonstrates retrieving that record. The UI distinguishes the authoritative decision from per-chain execution progress.

---

# 5. Product Modules and Functional Requirements

## Module 1: Wallet and Participant Management

### Purpose

Identify transaction participants and obtain their authorisation.

### Requirements

**FR-001:** Users must be able to connect a compatible wallet.

**FR-002:** The platform must identify users by wallet address.

**FR-003:** The platform must support buyer and seller roles.

**FR-004:** Participants must be able to sign transaction-specific messages.

**FR-005:** The relevant smart contract must verify participant authorisation/signatures where the selected authorisation flow requires contract-side signature validation; the frontend must never be trusted as the authority.

**FR-006:** Transaction signatures must be bound to the canonical terms hash.

**FR-007:** Signatures must include replay protection through transaction identifiers, chain/domain information and expiry.

### Acceptance Criteria

- Wallet connection works.
- Buyer signature is verifiable.
- Seller signature is verifiable.
- Modified transaction terms invalidate the original signatures.
- A signature cannot be reused for another transaction.

---

## Module 2: Transaction Management

### Purpose

Represent the complete financial agreement as one parent transaction.

### Requirements

**FR-008:** Users can create a transaction proposal.

**FR-009:** Each transaction receives a unique identifier.

**FR-010:** A transaction must contain participant information, terms and settlement obligations.

**FR-011:** Each obligation must have an independent identifier.

**FR-012:** Participants can inspect the transaction.

**FR-013:** Sellers can accept or reject proposals.

**FR-014:** Transactions must have configurable expiry.

**FR-015:** Transaction terms become immutable after the required participants have signed them.

**FR-016:** The platform must prevent duplicate transaction creation from retried requests through idempotency keys.

### Parent Transaction Model

A transaction contains:

- Transaction ID.
- Transaction type.
- Buyer.
- Seller.
- Agreed terms.
- Terms hash.
- Payment obligation.
- Asset obligation.
- Participant signatures.
- Validator/CRE evidence references.
- Current state.
- Created timestamp.
- Expiration timestamp.
- Settlement references.

---

## Module 3: Transaction Lifecycle Engine

### Purpose

Maintain a unified application view without pretending that independent chains share native state or atomic execution.

### Authoritative decision state (Chain A)

The Chain A contract is the only decision authority. Its write-once state machine is:

`UNDECIDED → COMMIT`

or

`UNDECIDED → ABORT`

No transition is possible after either outcome is recorded. The first valid transaction included in canonical Chain A order wins. A later conflicting decision call reverts.

### Per-chain execution state

Track execution independently from the decision:

- `NOT_LOCKED`
- `LOCKED`
- `DECISION_RECEIVED`
- `EXECUTED`
- `RELEASED`

### Derived application states

| State | Description |
|---|---|
| `PROPOSED` | Agreement created |
| `ACCEPTED` | Required participants authorised the same terms |
| `RESERVING` | Participant lock transactions are pending |
| `READY` | Both matching reservations verified by CRE |
| `COMMIT_PENDING` | Chain A COMMIT is recorded; Chain B execution is pending |
| `ABORT_PENDING` | Chain A ABORT is recorded; Chain B release is pending |
| `SETTLED` | Both obligations have verified execution and required finality |
| `RELEASED` | Both reservations have been released after ABORT |
| `EXPIRED_UNDECIDED` | Deadline passed but no decision has yet been recorded |
| `REJECTED` | Proposal rejected before reservations |

Do not collapse COMMIT_PENDING and ABORT_PENDING into a generic FAILED state. A timeout does not itself release funds or assets.

### Requirements

**FR-017:** Invalid transitions must be rejected.

**FR-018:** Application status must be derived from verified chain state/events; any local projection is non-authoritative.

**FR-019:** Every transition must retain timestamp and evidence references.

**FR-020:** Duplicate and out-of-order events must be handled idempotently.

**FR-021:** The Chain A decision is write-once and cannot be changed after COMMIT or ABORT.

**FR-022:** `SETTLED` requires verified execution and configured finality on both chains.

**FR-023:** After expiry, any account may request ABORT on Chain A only while its decision remains UNDECIDED.

**FR-024:** Chain B cannot independently choose a decision or release from a local timeout. It acts only on an authenticated relayed Chain A decision.

**FR-025:** Post-COMMIT interruption remains `COMMIT_PENDING` until the Chain B leg is executed; retry/reconciliation must not repeat payment.

### Engineering Rule

Do not implement state transitions as arbitrary database updates or frontend actions. Use chain facts as authority and a small deterministic projection for the UI.

## Module 4: Settlement Obligation Management

### Purpose

Represent payment and asset transfer as separate operations inside one transaction.

### Payment Obligation

Contains:

- Obligation ID.
- Parent transaction ID.
- Payer.
- Payee.
- Token address.
- Amount.
- Chain ID.
- Reservation contract.
- Reservation reference.
- Execution reference.
- Status.

### Asset Obligation

Contains:

- Obligation ID.
- Parent transaction ID.
- Seller.
- Buyer.
- Token address.
- Quantity.
- Chain ID.
- Reservation contract.
- Reservation reference.
- Execution reference.
- Status.

### Requirements

**FR-025:** Every obligation must be independently identifiable.

**FR-026:** Obligations must remain associated with their parent transaction.

**FR-027:** Each obligation must maintain its own lifecycle status.

**FR-028:** Obligation status must be derived from verified settlement evidence, not frontend actions.

**FR-029:** The transaction must only reach `SETTLED` when all required obligations are settled.

---

## Module 5: Chainlink CRE Integration

### Purpose

Use Chainlink CRE as the cross-chain workflow coordinator: observe events, read independent EVM state, evaluate conditions under CRE's workflow execution model, and submit authenticated reports to the relevant contracts.

### Verified network support (official documentation checked 6 November 2026)

The official CRE Supported Networks page lists both required testnets:

| Network | CRE chain name | Minimum CLI | Minimum TypeScript SDK |
|---|---|---:|---:|
| Ethereum Sepolia | `ethereum-testnet-sepolia` | `v1.0.0+` | `v1.0.1+` |
| Base Sepolia | `ethereum-testnet-sepolia-base-1` | `v1.0.0+` | `v1.0.1+` |

Both networks are listed for CRE workflow support. CRE supports EVM-compatible chains and Solana. This confirms network-family and documented capability support; it does not guarantee that both chains are enabled for this specific team's tenant or that DON deployment is approved.

**Mandatory tenant check:** after `cre login`, run `cre workflow supported-chains` (or `--output json`) and confirm both networks and their Forwarder addresses are enabled for the team's account. The supported-networks documentation explicitly makes chain availability tenant-scoped. Use the latest compatible CLI/SDK rather than pinning to the minimum versions above.

Official network list: https://docs.chain.link/cre/supported-networks-ts

### Required CRE capabilities

- EVM Log Trigger on the payment contract's `PaymentLocked` event on Ethereum Sepolia.
- EVM Log Trigger on the asset contract's `AssetLocked` event on Base Sepolia.
- EVM Client reads against both chains.
- EVM Write/report submission to the Chain A consumer and Chain B consumer.
- `FINALIZED` confidence for critical source-chain decision reads and decision-event monitoring where supported.

The workflow may use two EVM log-trigger handlers that call shared coordination logic. Each trigger execution is stateless; the workflow must reread durable contract state rather than assume prior execution memory.

### Workflow A — verify reservations and commit on Chain A

1. Trigger from either lock event.
2. Decode and validate the emitting contract, event signature and chain.
3. Read the payment reservation on Ethereum Sepolia.
4. Read the asset reservation on Base Sepolia.
5. Verify matching `transactionId`, `termsHash`, buyer, seller, token addresses, amounts, chain IDs, contract addresses and unexpired reservation state.
6. If both locks match and the deadline has not passed, generate the CRE report and submit it to the Chain A payment/decision contract.
7. Chain A contract independently validates report authenticity and all transaction-specific bindings before committing.
8. The contract records COMMIT and executes payment in one transaction; a revert leaves the decision UNDECIDED.

### Workflow B — relay the authoritative decision to Chain B

1. Trigger from Chain A's `DecisionRecorded` event or a retryable scheduled/reconciliation trigger.
2. Read the decision register on Ethereum Sepolia using `FINALIZED` confidence.
3. Verify decision, transaction ID, terms hash, source chain ID, source contract, decision record reference and destination chain/consumer binding.
4. Submit a CRE-authenticated report to the Base Sepolia asset consumer.
5. Base verifies the report using the supported Forwarder/receiver integration and executes COMMIT delivery or ABORT release exactly once.
6. Observe and record the destination execution event.

### Abort workflow

After `expiresAt`, any account may call `abort()` on Chain A if the decision remains UNDECIDED. CRE then observes the finalized ABORT decision and relays it to Base. No local Base timeout may release the asset.

### CRE requirements

**FR-030:** CRE must trigger from relevant EVM lock and decision events, with retry/reconciliation for missed or delayed executions.

**FR-031:** CRE must read both settlement contracts and validate all transaction and obligation bindings.

**FR-032:** CRE must only submit a COMMIT report when both participant-authorised reservations are verified and valid.

**FR-033:** CRE must submit the Chain A report using the official EVM Write mechanism and the consumer interface supported by the selected SDK version.

**FR-034:** CRE must read Chain A's decision at `FINALIZED` confidence before relaying it to Chain B.

**FR-035:** CRE must relay COMMIT or ABORT to Chain B through the official report/Forwarder receiver path.

**FR-036:** Workflow retries must be idempotent; duplicate reports must not duplicate settlement or release.

**FR-037:** CRE workflow execution must not rely on in-memory state between invocations.

### Finality semantics and limitations

The official CRE finality guide lists native `finalized` tags for both Base Sepolia and Ethereum Sepolia. CRE supports `FINALIZED` for EVM reads and confidence levels for EVM log triggers. Configure critical source decision reads/triggers accordingly.

A successful CRE EVM Write response means the transaction was included in a block; it does **not** by itself mean the write is finalized. After a write, independently wait for and verify the destination chain's configured finality before treating the action as complete. Handle reorg/resubmission and transaction-hash changes.

If a finalized read is unavailable or errors, fail closed and retry; do not silently downgrade to `LATEST` for the commit decision. The documentation notes that finalized reads can periodically fail on some chains, although the listed problematic testnets do not include Ethereum Sepolia or Base Sepolia.

### Deployment and demo honesty

CRE simulation is available without DON deployment approval and can make real calls to public EVM chains, but local simulation is not DON consensus. Live workflow deployment requires Chainlink approval/access. Check `cre account access` / deployment access immediately. If access is not granted, demonstrate simulation and label it accurately; do not claim a live DON workflow.

Official references:
- https://docs.chain.link/cre/overview
- https://docs.chain.link/cre/supported-networks-ts
- https://docs.chain.link/cre/concepts/finality-ts
- https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory

## Module 6: Smart Contract Settlement System

### Purpose

Enforce participant-authorised reservations and one authoritative transaction decision across two independent EVM chains.

### Contract architecture

**Chain A — Ethereum Sepolia:** one `PaymentDecisionSettlement` contract. It both holds Alice's payment reservation and owns the write-once decision register. Do not deploy a separate decision registry for the MVP.

**Chain B — Base Sepolia:** one `AssetSettlement` contract that holds Bob's asset reservation and accepts only authenticated CRE-relayed decisions.

Test ERC-20 contracts may be deployed as needed. Use plain tokens; do not build simulated Treasury transfer restrictions.

### Chain A: PaymentDecisionSettlement

Responsibilities:
- Accept Alice's payment-side lock/authorisation from her wallet.
- Bind the lock to the canonical `transactionId` and `termsHash`.
- Hold the authorised payment input token amount.
- Store decision state `UNDECIDED`, `COMMIT` or `ABORT`.
- Accept a valid CRE report only after the workflow has verified both matching reservations.
- On COMMIT, write the decision and execute payment in the same EVM transaction.
- If Uniswap is enabled, execute the approved swap in this same transaction, enforce router/token allowlists, a non-zero `amountOutMinimum` and bounded deadline, then pay Bob.
- If any payment/swap step reverts, the entire transaction reverts, including the COMMIT write.
- Expose permissionless `abort()` after `expiresAt` only while decision is UNDECIDED; record ABORT and release Alice's payment reservation.
- Reject every later conflicting decision.

### Chain B: AssetSettlement

Responsibilities:
- Accept Bob's asset-side lock from his wallet.
- Bind the lock to the same `transactionId` and `termsHash`.
- Hold the reserved asset amount.
- Accept only a valid CRE report through the official Forwarder/receiver pattern.
- Validate source chain ID, Chain A contract, transaction ID, terms hash, decision, decision reference, destination chain ID and destination consumer.
- On COMMIT, transfer the asset to Alice exactly once.
- On ABORT, release the asset to Bob exactly once.
- Reject malformed, misbound, conflicting and duplicate reports.
- Never refund based solely on a local timer.

### Protocol invariants

1. Alice and Bob authorise their own lock operations; CRE and the application cannot spend their tokens.
2. Both reservations bind the exact same canonical terms hash.
3. Chain A is the sole write-once decision authority.
4. First valid canonical Chain A decision wins; no second decision is possible.
5. Chain B follows only the authenticated relayed decision.
6. Expiry only enables permissionless ABORT on Chain A; it never independently releases Chain B assets.
7. Chain A COMMIT and payment are atomic within one EVM transaction.
8. Repeated CRE reports and user retries cannot double execute or double release.
9. A post-COMMIT CRE outage can leave the Base asset locked while Alice's payment has completed. This is a safety-over-liveness/blocking limitation; show `COMMIT_PENDING` and support relay retry.
10. This design is coordinated settlement, not a guarantee of simultaneous atomic settlement across two chains.

### Canonical terms hash

Use EIP-712 typed data or deterministic ABI encoding, never arbitrary JSON serialization. Include at minimum:
- `transactionId`
- buyer and seller addresses
- payment chain ID and decision/payment contract address
- payment input token and input amount
- payment output token and required output amount
- `amountOutMinimum` when a swap is enabled
- asset chain ID, asset token and asset amount
- destination asset consumer address
- `expiresAt`
- protocol/schema version

Use integer base units only. Distinguish the shared terms commitment from chain-specific participant authorisations and EIP-712 domains. Do not reuse a chain-specific domain separator across chains.

### Required event concepts

- `PaymentLocked(transactionId, termsHash, payer, amount)`
- `AssetLocked(transactionId, termsHash, seller, amount)`
- `DecisionRecorded(transactionId, termsHash, decision)`
- `PaymentExecuted(transactionId, termsHash, recipient, amount)`
- `AssetDelivered(transactionId, termsHash, recipient, amount)`
- `AssetReleased(transactionId, termsHash, recipient, amount)`

Exact Solidity signatures and report payload must be frozen by both developers before parallel implementation.

## Module 7: Arkiv Integration

### Purpose

Maintain an externally inspectable transaction record and evidence trail.

### Integration Approach

Use Arkiv entities for public transaction information and evidence references.

For the 24-hour MVP, do not introduce PostgreSQL solely to mirror chain state. Chain state and receipts are authoritative; the frontend may maintain a lightweight read model. Add a database/indexer only if already implemented and genuinely needed.

### Proposed Entity

`transaction_record`

Suggested attributes:

- `schema`
- `transaction_id`
- `transaction_type`
- `terms_hash`
- `buyer`
- `seller`
- `status`
- `payment_chain`
- `asset_chain`
- `commitment_hash`
- `payment_tx_hash`
- `asset_tx_hash`
- `created_at`
- `updated_at`

### Requirements

**FR-046:** The platform must be able to create an Arkiv transaction entity.

**FR-047:** The platform must store the resulting entity reference.

**FR-048:** The platform must retrieve an entity using its transaction identifier.

**FR-049:** The platform must publish the final settlement evidence.

**FR-050:** Arkiv failures must be visible and retryable; they must not change or falsify on-chain settlement state.

**FR-051:** Arkiv writes must be retryable and idempotent at the application level.

### Important Constraints

Arkiv is public and wallet-owned. Anyone may read public entities, while only the owner can update, extend, transfer or delete them.

Entities have configurable expiration.

Therefore:

- Never store secrets or private keys.
- Do not publish sensitive investor information.
- Use project-specific schemas and owner verification.
- Keep the canonical agreement and settlement facts on-chain; any local cache is disposable and reconcilable.
- Use a lifetime appropriate to the demonstration.

Arkiv is an evidence and record layer, not a replacement for blockchain settlement receipts.

---

## Module 8: Uniswap Integration

### Purpose

Make Uniswap part of the Chain A payment execution path rather than a separate pre-settlement swap screen.

### Example

Alice has an input token (for example WETH) while Bob requires USDC. Alice authorises the payment contract to spend the exact input amount. When the Chain A COMMIT transaction executes, the payment contract calls the configured Uniswap router, enforces `amountOutMinimum` and a bounded deadline, and transfers the resulting USDC to Bob.

### Requirements

**FR-052:** The application must obtain/display a swap quote and show expected output, price impact, fees, slippage and quote expiry.

**FR-053:** Alice must explicitly authorise the input-token spend using the selected supported approval/Permit2 flow.

**FR-054:** The Chain A contract must enforce allowlisted router and token addresses, non-zero minimum output and bounded deadline.

**FR-055:** Swap and seller payment must execute inside the same Chain A COMMIT transaction.

**FR-056:** If swap execution fails or output is below the minimum, the complete transaction reverts and Chain A remains UNDECIDED.

**FR-057:** The team must verify an actual Uniswap deployment, router compatibility, token pair and usable testnet liquidity before making the swap path mandatory. A mock swap is not an acceptable substitute.

### 60-minute spike gate

If a real Uniswap swap cannot be demonstrated within the first 60 minutes, disable the swap path for the MVP and disclose that it was not completed. Keep the direct payment-token path working. Do not use a fake/mock swap and do not claim Uniswap execution.

## Module 9: Live Transaction Monitoring

### Purpose

Provide a unified view of the transaction lifecycle.

### Requirements

**FR-058:** Users can view transaction progress in real time.

**FR-059:** Each settlement obligation must have an independent status.

**FR-060:** The interface must display chain and transaction references.

**FR-061:** The interface must distinguish coordination state from native chain execution status.

**FR-062:** The interface must display errors and pending conditions.

**FR-063:** Users can inspect the evidence behind each transition.

### UI Components

- Transaction status card.
- Agreement summary.
- Participant information.
- Payment obligation card.
- Asset obligation card.
- Coordination timeline.
- Reservation status.
- Commit status.
- Settlement receipts.
- Evidence explorer.

The UI may poll or subscribe to chain events for responsiveness. Notifications are not evidence of settlement finality; the UI must reconcile against contract state and verified receipts.

---

# 6. Application Architecture

## 6.1 Architecture for the 24-hour MVP

Use the smallest architecture that demonstrates the protocol. Do not add infrastructure merely because it appears in a conventional production stack.

## 6.2 Components

### Frontend — Next.js + TypeScript

Responsibilities:
- Wallet connection and chain switching.
- Create/review the transaction agreement.
- Buyer and seller wallet-authorised lock actions.
- Display Chain A decision and each chain's execution state.
- Read contract state/events using viem.
- Display transaction/evidence references and chain explorers.
- Show Uniswap quote and user authorisation if the integration spike succeeds.
- Read and retrieve the Arkiv evidence record.

### Solidity contracts — Hardhat

- Chain A `PaymentDecisionSettlement` on Ethereum Sepolia.
- Chain B `AssetSettlement` on Base Sepolia.
- Test ERC-20 tokens if needed.
- Contract tests and deployment scripts.

### Chainlink CRE — TypeScript SDK

- EVM log triggers on both chains.
- Cross-chain EVM reads.
- Reservation/terms validation.
- Report generation and EVM writes.
- Finalized Chain A decision read and report relay to Base.
- Retry and reconciliation.

### Arkiv

- Create a public, non-sensitive transaction evidence entity.
- Retrieve it by transaction ID/entity reference.
- Publish final decision and settlement transaction references.

### Backend/database

FastAPI and PostgreSQL are **out of scope for the 24-hour MVP** unless already running and needed for a concrete blocker. The browser can read/write wallet-authorised contract operations, read chain events, and interact with Arkiv. Do not create a backend merely to proxy RPC calls or store a second, non-authoritative transaction state.

If an existing backend is retained, keep it optional and read-model-only: it must not hold participant keys, authorise transfers, decide COMMIT/ABORT, or override chain state.

# 7. Proposed Repository Structure

Use a monorepo with clear ownership boundaries.

```text
project-root/
│
├── apps/
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── features/
│       │   │   ├── transactions/
│       │   │   ├── participants/
│       │   │   ├── settlement/
│       │   │   ├── evidence/
│       │   │   └── wallet/
│       │   ├── components/
│       │   ├── hooks/
│       │   ├── lib/
│       │   └── types/
│       └── tests/

├── contracts/
│   ├── src/
│   ├── test/
│   ├── ignition/
│   └── hardhat.config.ts
│
├── cre/
│   ├── workflows/
│   │   └── transaction-coordinator/
│   ├── shared/
│   ├── config/
│   └── tests/
│
├── packages/
│   ├── shared-types/
│   ├── contract-abis/
│   └── protocol-schemas/
│
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── CONTRACT_INTERFACES.md
│   ├── STATE_MACHINE.md
│   └── DECISIONS/
│
├── scripts/
├── .github/
│   └── workflows/
├── .env.example
├── .gitignore
└── README.md
```

This is a logical target structure. Avoid creating empty directories or abstractions before they have a real purpose.

---

# 8. Code Quality and Engineering Standards

This is a core requirement, not an optional cleanup activity.

## 8.1 General Principles

### Single Responsibility Principle

Every module should have one clearly defined responsibility.

Examples:

- Transaction service manages transactions.
- Obligation service manages settlement obligations.
- State machine validates transitions.
- CRE adapter initiates and observes workflows.
- Arkiv adapter handles Arkiv operations.

Do not create one enormous service responsible for everything.

### Separation of Concerns

Keep business logic separate from:
- HTTP controllers.
- Database models.
- Blockchain RPC calls.
- External integrations.
- UI rendering.

### Dependency Inversion

Business modules should depend on defined interfaces rather than directly depending on specific infrastructure implementations.

For example, transaction logic should depend on a settlement interface, not directly on a Web3.py client.

### Explicit Contracts

Every module must have documented inputs, outputs, errors and side effects.

### Avoid Premature Abstraction

Do not build generic frameworks for functionality that is only used once.

Create reusable abstractions when there is an actual second use case or clear shared responsibility.

## 8.2 Backend Standards (Deferred)

A Python/FastAPI backend and PostgreSQL database are not part of the 24-hour MVP. Do not create them unless an existing implementation is already working and removes a concrete blocker.

If a backend is retained, it is an optional read-model/indexing service only. It may index verified chain events and serve cached transaction views, but it must never:
- Hold participant private keys.
- Authorise or execute participant transfers.
- Decide COMMIT or ABORT.
- Treat a mutable database status as settlement proof.
- Override contract state or CRE report verification.

Any future backend should use typed schemas, explicit errors, idempotent event processing, structured logging and tests. Do not spend hackathon time implementing generic repositories, migrations or CRUD endpoints.

## 8.3 Frontend Standards

- Next.js App Router.
- TypeScript strict mode.
- Feature-based organisation.
- Reusable components.
- Centralised wallet, contract and chain configuration.
- Centralised wallet and chain configuration.
- React Query or an equivalent server-state solution.
- Zod for runtime validation where appropriate.

### Frontend Rules

- Components should not contain extensive business logic.
- Avoid direct fetch calls scattered across components.
- Use feature-specific hooks.
- Use shared UI components only for genuinely reusable elements.
- Keep API response types separate from component-specific view models.
- Derive displayed state from verified contract reads/events; keep UI projection logic separate from contract authority.

## 8.4 Smart Contract Standards

- Solidity 0.8.x.
- OpenZeppelin libraries where appropriate.
- Explicit access-control boundaries.
- Checks-effects-interactions.
- Reentrancy protection where needed.
- Safe ERC-20 handling.
- Custom errors.
- Events for meaningful state transitions.
- Explicit expiry and replay protection.
- Unit tests for every critical transition.

Every externally callable state-changing function must be reviewed for authorisation, replay and double-execution risks.

## 8.5 CRE Standards

- Use the official CRE SDK.
- Keep workflow callbacks small and composable.
- Separate workflow business logic from capability clients.
- Use typed ABI bindings.
- Validate all external and on-chain inputs.
- Never store persistent transaction state in workflow memory.
- Treat each execution as independently retryable.
- Keep secrets out of source control.
- Include simulation configurations.
- Record workflow inputs and outputs for debugging.

## 8.6 Integration Standards

Every external integration must be behind a dedicated adapter or service boundary.

Examples:

```text
SettlementProvider
    ├── EthereumSettlementAdapter
    └── BaseSettlementAdapter

EvidenceProvider
    └── ArkivEvidenceAdapter

SwapProvider
    └── UniswapSwapAdapter

WorkflowProvider
    └── CREWorkflowAdapter
```

The domain layer should not care about the internal SDK details of these providers.

---

# 9. Two-Developer Collaboration Strategy

## 9.1 Ownership Model

To minimise merge conflicts, each developer owns separate application areas.

### Developer A — Frontend and Evidence Layer

Owns:

```text
apps/web/
packages/shared-types/
```

Responsibilities:
- Wallet connection and transaction UI.
- Agreement creation/review.
- Buyer/seller lock actions.
- Chain state/event reads.
- Transaction timeline and status projection.
- Arkiv create/retrieve UI integration.

### Developer B — Contracts and Workflow Layer

Owns:

```text
contracts/
cre/
packages/contract-abis/
packages/protocol-schemas/
```

Responsibilities:
- Solidity contracts and deployment.
- Reservation and settlement mechanics.
- CRE workflow triggers, reads, reports and relay.
- Forwarder/receiver verification.
- Uniswap integration spike and contract path.
- Contract and workflow tests.

### Shared Ownership

Both developers coordinate through:

```text
docs/
packages/protocol-schemas/
CONTRACT_INTERFACES.md
CRE_REPORT_SCHEMA.md
```

These shared files should be changed through small, agreed updates rather than simultaneous edits.

## 9.2 Integration Contract First

Before parallel implementation, agree on:

1. Canonical transaction terms and `termsHash` structure.
2. Payment and asset obligation fields.
3. Decision and per-chain execution status enums.
4. Contract function and event signatures.
5. CRE report payload and source/destination bindings.
6. Arkiv evidence record schema.

These definitions become the integration contract between the two developers.

Neither developer should independently invent or rename shared fields.

## 9.3 Branching Strategy

Use short-lived feature branches.

Examples:

```text
main
├── feat/transaction-api
├── feat/transaction-ui
├── feat/settlement-contracts
├── feat/cre-workflow
├── feat/arkiv-integration
└── feat/uniswap-integration
```

Rules:

- Never work directly on `main`.
- Keep feature branches small.
- Pull or rebase from `main` regularly.
- Merge through pull requests.
- Avoid long-lived branches.
- Do not commit generated build files unnecessarily.
- Do not commit secrets or local environment files.

## 9.4 Shared File Conflict Prevention

Avoid simultaneous ownership of:

- Root package configuration.
- Shared type definitions.
- Environment configuration.
- Shared protocol schema definitions.
- Contract ABIs.
- Deployment configuration.

Assign one owner to each shared file.

If a shared interface needs changing, notify the other developer before modifying it.

## 9.5 Pull Request Rules

Every pull request should include:

- Purpose of the change.
- Files/modules affected.
- Contract, event or CRE report schema changes.
- Tests performed.
- Any new environment variables.
- Integration impact.

A PR should not silently change another module's assumptions.

---

# 10. Frontend / Contract Interaction Design

There is no mandatory REST API in the 24-hour MVP. The browser uses the connected wallet for participant-authorised transactions and viem for reads, event queries and chain configuration.

## Core interactions

- Create/review agreement and calculate the canonical transaction terms hash.
- Submit Alice's payment lock on Ethereum Sepolia.
- Submit Bob's asset lock on Base Sepolia.
- Read both reservation states and the Chain A decision.
- Display per-chain execution state and explorer links.
- Call permissionless Chain A `abort()` after expiry when the decision is still UNDECIDED.
- Read and retrieve the Arkiv evidence entity.

The CRE workflow is triggered by on-chain events. The frontend does not make an authoritative decision or submit the CRE report itself.

## Recovery and refresh

The frontend must reconstruct the transaction view from contract state, chain events and Arkiv evidence after reload. Do not rely on local browser state or WebSocket delivery as proof of execution.

---

# 11. Data Model

## Transaction

```text
Transaction
-----------
id
type
status
buyer_address
seller_address
terms_hash
terms_json
expires_at
created_at
updated_at
version
```

## Obligation

```text
Obligation
----------
id
transaction_id
type
status
chain_id
token_address
amount
from_address
to_address
reservation_reference
execution_reference
created_at
updated_at
```

## Participant Signature

```text
ParticipantSignature
--------------------
id
transaction_id
participant_address
signature
terms_hash
signature_type
created_at
```

## Coordination Record

```text
CoordinationRecord
------------------
id
transaction_id
workflow_reference
commitment_hash
report_reference
status
created_at
updated_at
```

## Settlement Evidence

```text
SettlementEvidence
------------------
id
transaction_id
obligation_id
chain_id
contract_address
transaction_hash
block_number
block_hash
event_name
verification_status
created_at
```

## Transaction Event

```text
TransactionEvent
----------------
id
transaction_id
event_type
previous_state
new_state
source
event_reference
metadata
created_at
```

All financial amounts should use integer base units, never floating-point numbers.

---

# 12. Security and Reliability

## 12.1 Wallet Security

- Never request or store user private keys.
- Use wallet signatures for user authorisation.
- Verify chain IDs.
- Prevent signature replay.
- Bind signatures to transaction terms and expiry.

## 12.2 Backend Security

- Validate all inputs.
- Use parameterised queries.
- Enforce transaction ownership and participant permissions.
- Protect sensitive endpoints.
- Keep secrets in environment-specific secret management.
- Use idempotency for operations that can be retried.

## 12.3 Contract Security

- Verify participant authorisation.
- Prevent double execution.
- Prevent double reservation.
- Enforce expiry.
- Verify report origin and contents.
- Restrict sensitive contract operations.
- Use safe token transfer patterns.

## 12.4 CRE Security

- Validate report contents.
- Use the correct receiver and forwarder configuration.
- Keep deployment secrets out of source control.
- Do not treat local simulation as DON consensus.
- Verify all native chain execution results independently.

## 12.5 Reliability

The application must account for:

- Duplicate blockchain events.
- Out-of-order events.
- Missed WebSocket messages.
- RPC failures.
- CRE workflow retries.
- Arkiv write failures.
- Expired reservations.
- Partial post-commit execution.
- Duplicate API requests.

Use idempotent event handlers, persistent event records, retry policies and reconciliation.

---

# 13. Testing Strategy

Time is limited. Prioritise tests that protect the protocol's safety argument. Do not spend the hackathon building a broad test suite while the end-to-end path is incomplete.

## Required contract tests

1. Only the correct buyer can create the payment lock.
2. Only the correct seller can create the asset lock.
3. Wrong transaction ID or terms hash is rejected.
4. Duplicate locks are rejected.
5. COMMIT cannot occur without the required CRE-authenticated report.
6. Only one decision can be recorded.
7. ABORT after COMMIT reverts and COMMIT after ABORT reverts.
8. COMMIT and payment are atomic.
9. Swap revert/insufficient output leaves decision UNDECIDED.
10. Anyone can call ABORT after expiry while decision is UNDECIDED.
11. Chain B rejects unauthenticated or misbound reports.
12. Chain B cannot release from local expiry alone.
13. Repeated COMMIT/ABORT reports cannot transfer or release twice.

## Required CRE checks

- Both lock events can trigger the workflow.
- Both chains can be read using the selected CRE SDK version.
- A mismatched terms hash prevents COMMIT.
- Chain A decision is read with `FINALIZED` confidence before relay.
- EVM Write submits through the supported receiver/Forwarder pattern.
- A successful write response is not treated as finality; destination state is independently reread/verified.

## Minimum end-to-end tests

### Happy path

Create agreement → Alice locks payment → Bob locks asset → CRE verifies both → Chain A commits and pays → CRE reads finalized decision → CRE relays COMMIT → Base delivers asset → verify both chains → write and retrieve Arkiv evidence.

### Missing reservation / abort path

Only one participant locks → deadline expires → arbitrary account calls Chain A `abort()` → CRE reads finalized ABORT → CRE relays ABORT → Base releases the asset reservation → verify both releases.

### Post-commit interruption

Chain A commits and pays → relay to Base is delayed → UI shows `COMMIT_PENDING` → retry the relay → Base delivers once. Never refund the Base reservation locally.

Skip dedicated live-testnet race and reorg demonstrations if time is short. Cover the critical invariants in local contract tests and describe remaining liveness/reorg limitations honestly.

# 14. UI/UX Requirements

## 14.1 Application Pages

### Dashboard

Displays:
- Active transactions.
- Awaiting acceptance.
- Reserving.
- Commit pending.
- Settled.
- Failed/released.

### Create Transaction

Form for:
- Counterparty.
- Asset.
- Quantity.
- Payment token.
- Amount.
- Network selection.
- Expiry.

### Transaction Details

Sections:
- Agreement.
- Participants.
- Payment obligation.
- Asset obligation.
- Coordination status.
- Timeline.
- Evidence.

### Evidence Explorer

Displays:
- Transaction terms hash.
- Participant signatures.
- Commitment/report reference.
- Reservation references.
- Settlement transaction hashes.
- Block numbers.
- Verification results.
- Arkiv entity reference.

### Swap / Payment Authorisation

If the Uniswap spike succeeds, show the quote, token approval/Permit2 authorisation and expected minimum output. The swap itself executes inside Chain A's COMMIT/payment transaction; it is not a separate pre-settlement action.

## 14.2 UX Principles

- Transaction-first navigation.
- Clearly distinguish proposed, reserved, committed and settled states.
- Never use a generic success indicator when one settlement leg remains pending.
- Explain failures in understandable language.
- Expose technical evidence without overwhelming ordinary users.
- Provide expandable technical details for judges and developers.
- Show the chain associated with every operation.

---

# 15. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Maintainability | Modular, feature-oriented codebase |
| Reliability | Idempotent event and API processing |
| Security | Explicit participant and contract authorisation |
| Observability | Structured logs and traceable transaction events |
| Performance | Responsive transaction dashboard |
| Extensibility | Chain adapters and integration interfaces |
| Type safety | TypeScript strict mode and Python type hints |
| Testing | Unit and integration tests for critical paths |
| Documentation | API, contract and architecture documentation |
| Collaboration | Clear ownership and minimal shared-file conflicts |

---

# 16. 24-Hour Implementation Plan (Two Developers)

This schedule is deliberately narrow. The first 90 minutes are integration spikes; do not proceed on assumptions that a sponsor capability works.

| Time | Developer 1 — CRE / workflow | Developer 2 — contracts / Uniswap / Arkiv |
|---|---|---|
| 0–1.5h | CRE spike: log triggers, reads on both chains, report write to consumer | Test one real Uniswap swap on Sepolia; Arkiv create + retrieve spike |
| 1.5–2h | Freeze shared IDs, terms hash, event signatures and report payload | Same interface freeze; no new architecture after this point |
| 2–4h | Build workflow against deployed contract stubs | Deploy stubs; implement Chain A lock/decision/payment and Chain B lock/receiver |
| 4–10h | Implement two-chain reads, verification, report generation and relay | Finish contracts and critical safety tests; deploy to testnets |
| 10–16h | Integrate happy path and abort path; retry/reconciliation | Fix contract/integration bugs; Arkiv evidence write/retrieve |
| 16–20h | Support UI integration and transaction timeline | Support UI integration; verify finality and evidence references |
| 20–22h | Failure demo: missing lock, expiry, ABORT and release; record demo | Fix only critical bugs |
| 22–24h | README, submission and buffer | README, submission and buffer |

### Spike failure rules

- If CRE cannot write to Base Sepolia for the team's tenant, switch Chain B to another CRE-supported testnet only after confirming all required capabilities and contract deployment feasibility. Do not mock the report relay.
- If Uniswap is not working after 60 minutes, drop the swap integration for the MVP and disclose it. Never fake a swap.
- If Arkiv writes fail but retrieval works, show retrieval only and state the limitation; if neither works, cut the integration rather than inventing evidence.
- If live CRE DON deployment access is not granted, use local simulation for development and clearly label the final demonstration as simulation. Do not claim DON consensus.

### Scope cuts

- No FastAPI/PostgreSQL unless already implemented and immediately useful.
- No Solana implementation in this MVP.
- No multi-party/N-leg generalisation beyond the two-party/two-chain demonstration.
- No custom BFT, bridge, generic cross-chain messaging layer or token-liquidity aggregator.
- No live CRE outage demo; describe the blocking/retry limitation.
- No broad UI pages beyond transaction creation/detail/timeline/evidence.

# 17. Definition of Done

A feature is not complete simply because its UI or API works.

A feature is complete when:

1. Its requirements are implemented.
2. Its input validation exists.
3. Its failure cases are handled.
4. Its tests pass.
5. It respects module boundaries.
6. It is documented where necessary.
7. It does not break existing functionality.
8. It can be integrated with the other developer's work.

The overall project is complete when the flagship transaction can be demonstrated from creation through settlement, with a working permissionless post-expiry ABORT scenario, authenticated decision relay, and inspectable evidence.

---

# 18. Key Technical Decisions and Constraints

| Area | Working decision |
|---|---|
| Product positioning | Cross-chain financial transaction coordination engine |
| Interoperability scope | EVM-to-EVM: Ethereum Sepolia ↔ Base Sepolia |
| Future extension | Heterogeneous networks such as Solana are architectural direction only, not MVP scope |
| Primary use case | Test-token delivery-versus-payment, narrated as a tokenised Treasury purchase |
| Frontend | Next.js + TypeScript + viem |
| Backend/database | Out of scope for MVP unless already running and necessary |
| Smart contracts | Solidity + Hardhat; one Chain A payment/decision contract and one Chain B asset contract |
| Workflow orchestration | Chainlink CRE TypeScript SDK |
| Transaction evidence | Arkiv create + retrieve |
| Token conversion | Uniswap swap inside Chain A COMMIT/payment transaction, conditional on spike success |
| Demo networks | Ethereum Sepolia (Chain A) + Base Sepolia (Chain B) |
| Chain A decision | Write-once UNDECIDED → COMMIT or ABORT |
| Abort | Permissionless after expiry, only while UNDECIDED, on Chain A |
| Chain B release | Only after authenticated CRE-relayed ABORT; never local timeout refund |
| Finality | CRE `FINALIZED` read for Chain A decision; independently verify destination write finality |
| Failure handling | Post-COMMIT pending/retry; no claim of guaranteed cross-chain atomicity |
| Collaboration | Two developers; shared interface freeze after initial spikes |

## 18.1 CRE Support Verification (6 November 2026)

The current official CRE supported-networks documentation lists Ethereum Sepolia and Base Sepolia as supported testnets for CRE workflows. The documented minimums for both are CLI `v1.0.0+` and TypeScript SDK `v1.0.1+`. Use current compatible releases.

The supported-networks page states that chain enablement and Forwarder addresses are tenant-scoped. Before implementation, authenticate with the team's CRE account and run:

```bash
cre workflow supported-chains
# or
cre workflow supported-chains --output json
```

Confirm that both `ethereum-testnet-sepolia` and `ethereum-testnet-sepolia-base-1` appear with usable Forwarder addresses. This tenant check is mandatory; public documentation alone does not prove that the team's tenant is provisioned for both.

The official finality guide lists native `finalized` tags for both Ethereum Sepolia and Base Sepolia. Use `FINALIZED` for critical Chain A decision reads and configure EVM log triggers with the appropriate confidence level. A CRE write response confirms block inclusion, not finality; independently verify finality after writes.

Official sources:
- https://docs.chain.link/cre/supported-networks-ts
- https://docs.chain.link/cre/concepts/finality-ts
- https://docs.chain.link/cre/overview
- https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory

## 18.2 Explicit Assumptions and Spike Gates

- The team's CRE tenant has both Ethereum Sepolia and Base Sepolia enabled for the required trigger/read/write capabilities.
- Live DON deployment access is granted; otherwise only simulation can be demonstrated and must be labelled accurately.
- The selected Uniswap router deployment, token pair and liquidity are usable on the selected testnet; otherwise Uniswap is cut from the MVP.
- Arkiv supports the chosen write and retrieval path for the demo.
- The CRE receiver/Forwarder interfaces are implemented from the exact installed SDK/docs version; do not invent a receiver signature or report ABI.

## 18.3 Important Limitations

The project demonstrates coordinated execution across independent EVM chains. It does not guarantee simultaneous or mathematically atomic settlement across chains.

If Chain A commits and pays but CRE cannot relay the decision, Chain B's asset can remain locked. This is a safety-over-liveness limitation. The system must show `COMMIT_PENDING` and support retry/reconciliation.

CRE's report is trusted under CRE's workflow and report-verification model. It does not merge chain consensus or remove the need to verify each destination chain's own execution and finality.

The demo uses ordinary test ERC-20s. It does not establish legal ownership of Treasury securities or perform regulated asset transfer.

# 19. Final Product Definition

The platform provides a unified transaction workspace for financial agreements involving multiple blockchain networks.

Participants create and authorise a transaction on two independent EVM networks. The coordination engine manages the shared lifecycle, verifies both reservations through Chainlink CRE, records one authoritative decision on Ethereum Sepolia and relays that decision to Base Sepolia.

A single Chain A contract combines the payment reservation and write-once decision register; the Chain B contract enforces asset delivery or release from an authenticated CRE-relayed decision. Arkiv provides a retrievable evidence record. If the testnet spike succeeds, Uniswap conversion executes inside the Chain A payment transaction.

The result is a transaction-centric application that makes complex multi-chain financial operations easier to coordinate, monitor and verify.

**The product principle: One financial transaction. Multiple settlement obligations. One unified transaction experience.**

---

# 20. Official Technical References

- Chainlink CRE Overview: https://docs.chain.link/cre/overview
- CRE Supported Networks: https://docs.chain.link/cre/supported-networks-ts
- CRE Finality and Confidence Levels: https://docs.chain.link/cre/concepts/finality-ts
- CRE Getting Started: https://docs.chain.link/cre/getting-started/overview
- CRE Templates Repository: https://github.com/smartcontractkit/cre-templates
- Multi-Chain Token Manager: https://github.com/smartcontractkit/cre-templates/tree/main/starter-templates/multi-chain-token-manager
- CRE EVM Read and Write: https://docs.chain.link/cre/capabilities/evm-read-write
- Arkiv Introduction: https://docs.arkiv.network/start-here/introduction/
- Arkiv Entity Expiration: https://docs.arkiv.network/writing/expiration/
- Uniswap Universal Router: https://developers.uniswap.org/docs/protocols/universal-router/overview
- Uniswap Permit2: https://developers.uniswap.org/docs/trading/swapping-api/concepts/permit2

**Document status:** Version 1.1 is the revised implementation baseline. It supersedes conflicting v1.0 descriptions of local expiry refunds, separate decision registries, pre-settlement Uniswap swaps, mandatory FastAPI/PostgreSQL, and unverified CRE network assumptions. Coding-agent instructions should be derived from this version and the separate protocol design specification.
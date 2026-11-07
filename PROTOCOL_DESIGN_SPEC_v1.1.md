# Protocol Design Specification
## Decision-Anchored Multi-Chain Settlement (Hackathon MVP)

**Status:** Implementation baseline  
**Time constraint:** 24-hour hackathon build  
**Scope:** Ethereum Sepolia ↔ Base Sepolia; two participants; two settlement obligations; one authoritative decision register.

---

## 1. Build objective

Demonstrate one financial transaction whose obligations execute on two independent EVM chains under one authoritative outcome.

- Chain A: Ethereum Sepolia — authoritative decision register and payment execution.
- Chain B: Base Sepolia — asset reservation and delivery.
- Alice: buyer and payment authoriser.
- Bob: seller and asset-transfer authoriser.
- Chainlink CRE: observes reservation events, evaluates conditions and relays the authoritative decision to Chain B.
- Uniswap: performs the payment-token conversion inside Chain A's commit/payment transaction, if the testnet spike confirms a usable deployment and pool.
- Arkiv: stores a retrievable public transaction/evidence record.
- Optional FastAPI/PostgreSQL: use only if already useful; neither is required for the 24-hour vertical slice or authoritative for settlement decisions.

This is a hackathon demonstration using test tokens. It does not provide a legal securities transfer or a universal atomic-settlement guarantee.

## 2. Protocol invariants

These are non-negotiable implementation rules.

1. Both participant lock operations bind to the same `transactionId` and canonical `termsHash`.
2. Alice submits her own payment-side authorisation/transaction. Bob submits his own asset-side authorisation/transaction.
3. CRE cannot spend participant assets and cannot invent participant authorisation.
4. Chain A is the sole authoritative decision register. Its decision is write-once: `UNDECIDED -> COMMIT` or `UNDECIDED -> ABORT`.
5. Chain B never independently chooses COMMIT or ABORT. It executes only an authenticated decision report relayed from Chain A through the verified CRE report path.
6. A local timer never independently refunds a reservation. Expiry only makes an ABORT decision eligible to be requested on Chain A.
7. Once a chain has accepted COMMIT for a transaction, that obligation cannot be refunded; it can only complete the committed transfer.
8. Chain A's COMMIT decision and its payment execution occur in one EVM transaction. If payment execution (including the Uniswap swap, if enabled) reverts, the decision write reverts too.
9. `SETTLED` is shown only after both chains' required execution receipts/events satisfy the configured confirmation policy.
10. PostgreSQL status fields are projections, not proof. Verify chain state/evidence before displaying final settlement.
11. No code path may claim that two independent chains execute simultaneously or that CRE guarantees liveness.

## 3. Canonical transaction commitment

Use one deterministic encoding for the terms hash. Do not hash arbitrary JSON serialization.

For the MVP, define a typed EIP-712 structure (or an equally deterministic ABI-encoded structure) containing at minimum:

- `transactionId` (`bytes32`)
- `buyer` (`address`)
- `seller` (`address`)
- `paymentChainId` (`uint256`)
- `paymentToken` (`address`)
- `paymentInputToken` (`address`, if swap is enabled)
- `paymentInputAmount` (`uint256`, if swap is enabled)
- `paymentAmountOutMin` (`uint256`, if swap is enabled)
- `assetChainId` (`uint256`)
- `assetToken` (`address`)
- `assetAmount` (`uint256`)
- `decisionRegister` (`address`)
- `expiresAt` (`uint256`)
- protocol/schema version

Both lock calls must include this exact `termsHash`. The contracts must reject a lock whose transaction/terms binding does not match the configured transaction data.

Use integer base units only. Never use floating-point arithmetic for token amounts.

**Important:** The EIP-712 domain must be explicitly designed for the relevant signing purpose. Do not blindly use the same domain separator across chains if the signature is intended to be chain-specific. If signatures are verified on both chains, define how the shared terms commitment is separated from chain-specific authorisation.

## 4. Contract responsibilities

### 4.1 Chain A — `DecisionPaymentSettlement` (single MVP contract)

Do not split the payment lock and authoritative decision register into separate contracts for the MVP. The same Chain A contract owns Alice's payment-side reservation and the write-once decision register. This reduces cross-contract coordination and removes an unnecessary integration boundary.

Responsibilities:

- Accept Alice's payment-side authorisation.
- Record/verify the payment-side reservation or enforce an equivalent participant-funded commitment.
- Track transaction ID, terms hash, payer, payee, input token, required output token and amounts.
- Expose the write-once decision register.
- Permit COMMIT only after the contract can verify all Chain A preconditions and the CRE-authorised coordination result that both reservations were observed.
- Execute the payment in the same transaction as writing COMMIT.
- If Uniswap is enabled, execute the swap with a strict `amountOutMinimum`, deadline and approved router configuration, then pay Bob from the output.
- Permit any caller to trigger ABORT while the decision is `UNDECIDED` and `block.timestamp >= expiresAt`. Before expiry, any additional abort condition must be explicit and contract-enforced; do not rely on a backend flag.
- Emit decision and payment execution events.

**Atomicity requirement within Chain A:** write COMMIT and perform payment execution in one EVM transaction. A revert at any point must leave the decision `UNDECIDED` and must not transfer payment.

### 4.2 Chain B — `AssetSettlement`

Responsibilities:

- Accept Bob's asset-side authorisation.
- Lock the specified asset quantity for the transaction.
- Bind the lock to `transactionId` and `termsHash`.
- Accept only an authenticated CRE report carrying the Chain A decision, relayed after the configured source-read policy. The receiver must validate the actual CRE Forwarder and the report's source/destination/transaction binding.
- On COMMIT, transfer the asset to Alice exactly once.
- On ABORT, release the asset to Bob exactly once.
- Reject conflicting, duplicate, malformed or incorrectly bound decisions.
- Emit lock, decision-received, delivery and release events.

**No independent refund:** a local expiry may mark a reservation as eligible for an abort request, but it must not transfer the asset back to Bob without the authoritative ABORT decision.

### 4.3 CRE report receiver

Use the official CRE EVM Write mechanism and the exact receiver/Forwarder pattern supported by the pinned SDK/CLI version. EVM Write delivers a DON-signed report through a Chainlink-managed Keystone Forwarder to a consumer implementing `IReceiver.onReport(bytes metadata, bytes report)`. Prefer the official receiver template when it fits the installed SDK. Do not invent a custom signature scheme.

The Forwarder is tenant/network-specific. Obtain the exact address from the authenticated command:
```bash
cre workflow supported-chains
```
The address printed by the tenant's output is authoritative for that account/environment. Do not assume a generic public address or a simulation MockKeystoneForwarder is the production Forwarder.

For local simulation, distinguish the simulator's mock Forwarder from the production KeystoneForwarder. Keep separate configuration for simulation and deployed workflow environments.

The Chain B consumer must validate the authenticated report and bind it to:

- Source chain ID (Ethereum Sepolia).
- Decision register address on Chain A.
- Transaction ID.
- Terms hash.
- Decision value.
- Decision record identifier/nonce.
- Source decision block reference, where supported by the report design.
- Destination chain ID and destination consumer/contract.
- Expected obligation ID.

A report for one transaction, chain or destination must not be reusable for another.

The official CRE EVM Read capability documents reads at `finalized`, `latest`, or a specified block number. For the source decision read, request `finalized` where supported by the selected chain and SDK configuration. Confirm this with a real workflow simulation and the deployed capability behaviour. If the chosen read path cannot use `finalized`, explicitly fall back to a documented confirmation-depth policy and call it confirmations, not finality. A report that merely contains a block number is not, by itself, proof of source-chain finality.

---

## 5. Decision and execution lifecycle

Keep the decision outcome separate from per-chain execution progress.

### Decision register

```text
UNDECIDED -> COMMIT
UNDECIDED -> ABORT
```

No transition is permitted out of `COMMIT` or `ABORT`. The first valid write on Chain A wins.

### Per-chain execution state

```text
NOT_LOCKED
LOCKED
COMMIT_RECEIVED
ABORT_RECEIVED
EXECUTED
RELEASED
```

### Application-level derived status

| Status | Meaning |
|---|---|
| `PROPOSED` | Agreement created |
| `ACCEPTED` | Required participant authorisations verified |
| `RESERVING` | Participant lock transactions in progress |
| `READY` | Required locks observed and verified |
| `COMMIT_PENDING` | Chain A records COMMIT; Chain B has not completed |
| `ABORT_PENDING` | Chain A records ABORT; Chain B has not released |
| `SETTLED` | Both obligations have verified execution finality |
| `RELEASED` | All reservations have verified release |
| `EXPIRED_UNDECIDED` | Deadline passed, but no authoritative decision has been recorded |

Do not use a generic `FAILED` state to hide whether the authoritative decision is COMMIT or ABORT.

---

## 6. Protocol flow

### Happy path

1. Alice and Bob agree to the canonical terms and calculate the same `termsHash`.
2. Alice submits the payment-side lock/authorisation on Chain A.
3. Bob submits the asset lock on Chain B.
4. Both contracts emit transaction-specific lock events.
5. CRE is triggered by the relevant on-chain event(s), reads both chains and verifies both locks, including matching `transactionId` and `termsHash`.
6. CRE submits a DON-authenticated coordination report to Chain A's decision/payment contract through the supported CRE EVM Write / Keystone Forwarder receiver path. Chain A validates the report and local preconditions.
7. Chain A writes COMMIT and executes payment atomically in the same EVM transaction. If Uniswap is enabled, the swap and payment are part of this same transaction. A revert must leave the decision UNDECIDED.
8. CRE reads Chain A's decision using the `finalized` block tag where supported by the configured EVM Read capability, then relays the authenticated decision to Chain B through its configured CRE receiver.
9. Chain B verifies the report, records COMMIT and transfers the asset to Alice exactly once.
10. The application verifies both chain receipts/events and configured confirmations.
11. Arkiv receives a public transaction/evidence record. The UI shows `SETTLED` only after both legs are verified.

### Pre-commit abort path

1. A required reservation fails or the transaction deadline passes while the decision is still `UNDECIDED`.
2. Any account may submit the abort transaction to Chain A once `block.timestamp >= expiresAt`, provided the decision remains UNDECIDED. No seller/buyer/backend/CRE permission should be required merely to trigger this expiry abort.
3. Chain A enforces the expiry and UNDECIDED preconditions on-chain, then records ABORT if no decision has already been written. A missing participant must not be able to hold the counterparty's reservation indefinitely.
4. CRE observes the finalized ABORT decision.
5. CRE relays ABORT to Chain B through the authenticated report path.
6. Chain B releases Bob's asset.
7. The application verifies the release evidence and shows `RELEASED` only when all required reservations are released.

### Race: commit and abort arrive together

- Both operations target the same write-once decision register on Chain A.
- The first valid transaction included in the canonical chain order wins.
- If COMMIT wins, ABORT must revert; CRE relays COMMIT to Chain B.
- If ABORT wins, COMMIT must revert; CRE relays ABORT to Chain B.
- Chain B must never make a local timeout decision that contradicts Chain A.

### CRE outage after COMMIT

- Chain A may have paid Bob and recorded COMMIT.
- Chain B remains locked until it receives the authenticated COMMIT report.
- Chain B must not refund based on its local timer.
- The transaction remains `COMMIT_PENDING`.
- Retry/recovery must be able to relay the already-recorded decision without executing the Chain A payment again.
- This is a safety-over-liveness trade-off: prolonged CRE/relay unavailability can leave an obligation locked. Do not claim guaranteed completion.

### Source-chain reorganisation

The design depends on CRE relaying a decision only after the source decision meets the selected finality policy. Verify what CRE's source-chain observation/report mechanism guarantees. If the chosen capability cannot provide the required assurance, explicitly document the residual reorg risk and do not describe the report as proof of finality.

---

## 7. Required events and idempotency

Use transaction-specific events. Exact event signatures must be agreed in `CONTRACT_INTERFACES.md`.

Conceptual events:

```solidity
event PaymentLocked(bytes32 indexed transactionId, bytes32 termsHash, address payer, uint256 amount);
event AssetLocked(bytes32 indexed transactionId, bytes32 termsHash, address seller, uint256 amount);
event DecisionRecorded(bytes32 indexed transactionId, bytes32 termsHash, Decision decision);
event PaymentExecuted(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);
event AssetDelivered(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);
event AssetReleased(bytes32 indexed transactionId, bytes32 termsHash, address recipient, uint256 amount);
```

Requirements:

- Store processed source event references.
- Reject duplicate lock/execute/release operations.
- Use stable transaction and obligation identifiers.
- CRE retries must be safe.
- A repeated COMMIT relay must not transfer the asset twice.
- A repeated ABORT relay must not release the asset twice.
- The backend must tolerate duplicate and out-of-order events.

---

## 8. Arkiv and application backend

### Arkiv

Publish a public, non-sensitive record containing:

- Transaction ID.
- Terms hash.
- Public participant wallet addresses, if appropriate for the demo.
- Chain IDs and contract references.
- Decision and decision reference.
- Payment and asset transaction hashes.
- Evidence references and timestamps.

Demonstrate both entity creation and retrieval. Do not store private keys, secrets or sensitive personal information. Verify actual Arkiv ownership/update semantics before designing participant-specific access.

### FastAPI/PostgreSQL

Keep the backend thin. It may:

- Serve transaction and participant APIs.
- Store the proposal and canonical terms hash.
- Store participant signature references.
- Index verified chain events.
- Store CRE workflow/report references.
- Maintain a query-friendly projection.
- Publish WebSocket notifications.
- Publish/retrieve Arkiv records.

It must not:
- Decide COMMIT or ABORT from a mutable database flag.
- Mark an obligation executed without verified chain evidence.
- authorise token transfers using backend custody keys.
- Treat WebSocket delivery as proof.

The transaction detail screen must derive decision and settlement status from verified chain state/evidence (directly or through a projection that can be reconciled against chain state), not from an unverified mutable status field.

---

## 9. Uniswap execution boundary

Uniswap is part of Chain A's payment execution path, not a separate cross-chain obligation.

For the demo:

1. Alice authorises the input token spending through the agreed token/router permission mechanism.
2. The payment contract receives or can pull the authorised input amount.
3. During the Chain A COMMIT transaction, the contract executes the configured Uniswap swap.
4. Enforce a non-zero `amountOutMinimum`, bounded deadline and allowlisted router/token addresses.
5. Transfer the resulting payment token to Bob.
6. Only after successful payment execution does the same transaction complete the COMMIT write.

If the swap reverts or produces insufficient output, the entire Chain A transaction reverts and no COMMIT is recorded.

**Spike gate:** Verify the intended Uniswap deployment, router compatibility, token pair and usable liquidity on the selected network before making this path mandatory. A seeded pool is only a liquidity fallback; it does not solve missing protocol deployment or unsupported router compatibility.

---

## 10. Required tests before demo

### Contract unit tests

- Correct participant can lock.
- Wrong participant cannot lock.
- Wrong transaction ID or terms hash is rejected.
- Duplicate lock is rejected.
- COMMIT cannot be recorded before required conditions.
- ABORT cannot be recorded before the abort condition.
- Only one decision can be recorded.
- COMMIT and payment are atomic.
- Swap failure leaves decision `UNDECIDED`.
- ABORT after COMMIT reverts.
- COMMIT after ABORT reverts.
- Chain B rejects unauthenticated reports.
- Chain B rejects reports for the wrong source/destination/transaction/terms.
- Repeated decision relay does not execute twice.
- Chain B cannot refund from local expiry alone.

### Integration/failure tests

1. Happy path: both locks -> COMMIT -> both legs execute.
2. Missing asset lock -> expiry passes -> permissionless ABORT on Chain A -> CRE relay -> payment-side and asset-side reservations released.
3. Missing payment lock -> expiry passes -> permissionless ABORT on Chain A -> CRE relay -> any existing asset-side reservation released.
4. Commit/abort race -> exactly one Chain A decision wins.
5. CRE unavailable after COMMIT -> Chain A payment remains committed; Chain B remains locked; retry relays COMMIT.
6. Duplicate CRE execution -> no duplicate transfer.
7. Delayed report -> Chain B does not independently refund.
8. Reorg/finality assumption -> verify the chosen CRE source observation behaviour.
9. Uniswap swap revert -> no COMMIT and no payment.
10. Arkiv unavailable -> settlement remains correct; evidence publication retries later.

---

## 11. CRE setup and capability verification

Run the following commands in a local terminal (macOS Terminal/iTerm or the VS Code integrated terminal), not in a browser console or Hardhat console. Run project-specific workflow commands from the CRE project root containing `project.yaml`.

```bash
# Install the CLI first using the official installation guide if `cre` is not found.
cre update
cre login
cre whoami

# Check/request organization-level DON deployment permission.
cre account access

# This is the authoritative tenant-scoped chain and Forwarder list.
cre workflow supported-chains
cre workflow supported-chains --output json
```

Verify that the authenticated tenant output contains both:
- `ethereum-testnet-sepolia`
- `ethereum-testnet-sepolia-base-1`

Record the exact Forwarder addresses shown by this command. Public network documentation alone does not prove that both chains are enabled for this tenant.

Initialize a CRE project with `cre init` only if the repository does not already contain a valid CRE project. Do not create a second nested project. Then simulate the workflow using the actual path and target configured in `project.yaml`:

```bash
cre workflow simulate ./workflows/transaction-coordinator --target <target-name>
```

Replace `<target-name>` with the actual target key. Simulation is local and is not a DON execution. EVM writes are dry-run by default; only use `--broadcast` deliberately when testing a real testnet write with correct keys, gas, chain configuration and contract addresses. DON deployment requires approval; `cre account access` checks or requests it. Continue local simulation while approval is pending.

Never commit `~/.cre/cre.yaml`, `.env`, private keys, RPC credentials or other secrets.

Official references:
- CLI login: https://docs.chain.link/cre/guides/cli/cli-login
- CLI authentication: https://docs.chain.link/cre/guides/cli/managing-auth
- Tenant chain list and Forwarders: https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory
- EVM Read & Write: https://docs.chain.link/cre/capabilities/evm-read-write
- Deploy access: https://docs.chain.link/cre/guides/operations/deploy-access
- Workflow simulation: https://docs.chain.link/cre/guides/operations/simulating-workflows

## 12. 24-hour implementation order

### First 60–90 minutes: integration spikes

Do not build the dashboard first.

- CRE (Developer 1 / Hamad): authenticate, capture tenant chain/Forwarder list, verify both testnets are enabled, initialise or inspect the CRE project, prove EVM log trigger, EVM reads from both chains, `finalized` read of Chain A decision where supported, and EVM Write report delivery to a minimal consumer stub.
- Contracts (Developer 2): prove participant lock and Chain A payment/decision contract deployment shape; create the minimal consumer stub/interface against the official CRE receiver.
- Arkiv: prove entity create and query/retrieve.
- Uniswap: prove selected testnet deployment, router call and usable pool liquidity.
- Request DON deployment access early; do not wait until the workflow is complete.

Do not spend the first 90 minutes on UI polish.

If a sponsor integration cannot be proven, make an explicit scope decision immediately. Never present a mock as a live integration.

### Next: freeze interfaces

Agree and commit:

- `transactionId` and `termsHash` format.
- Decision enum and state transitions.
- Contract function signatures.
- Contract event signatures.
- CRE workflow input/output and report payload.
- Chain IDs, contract addresses and token addresses.

### Build the protocol vertical slice

1. Deploy test tokens and settlement contracts.
2. Implement and test participant-submitted locks.
3. Implement Chain A write-once decision plus atomic payment.
4. Implement Chain B authenticated decision receiver and execute/release paths.
5. Implement CRE event observation, reads, decision submission and relay.
6. Run happy path and commit/abort race tests.

### Build only the product surface needed

- Create/inspect transaction.
- Wallet authorisation and participant lock actions.
- Per-chain progress and decision display.
- Evidence view with chain links and Arkiv retrieval.
- One clear failure demonstration.

### Final validation

- Deploy fresh contracts and record addresses.
- Run the full happy path.
- Run one pre-commit abort.
- Run one delayed-CRE/commit-pending test if time permits.
- Capture transaction hashes and Arkiv entity reference.
- Rehearse a short demo with honest trust/liveness explanation.

---

## 13. Explicit assumptions and unresolved implementation checks

These are verification tasks, not permission to guess:

1. Confirm exact CRE trigger, report authentication, Forwarder/receiver and destination-chain write pattern for the installed SDK/version.
2. Confirm CRE supports the selected source and destination networks for the required capabilities.
3. Confirm how source finality is represented/guaranteed before CRE relays the decision.
4. Confirm Uniswap's actual deployment and router/pool availability on the payment network.
5. Confirm Arkiv network availability, SDK behaviour and entity ownership semantics.
6. Confirm whether the payment token and input token contracts are compatible with the chosen swap route.
7. Confirm whether the Chain A contract can execute the swap and payment in one transaction without violating router/token approval assumptions.

Do not write production-looking interfaces around an unverified SDK assumption. First compile and run the smallest real integration example.

---

## 14. Judge-facing explanation

> Each participant authorises and locks their own side of the transaction. CRE observes and verifies both locks, then coordinates a single write-once decision on the authoritative chain. The other chain accepts only an authenticated relay of that decision. If COMMIT wins, obligations can only move forward; if ABORT wins, reservations are released. This prioritises safety over liveness: if coordination is unavailable after COMMIT, an obligation may remain locked until the decision can be relayed.

Do not describe this as simultaneous execution, guaranteed liveness or universal atomic settlement.

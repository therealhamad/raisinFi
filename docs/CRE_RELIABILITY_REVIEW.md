# CRE Workflow Reliability and Reconciliation Review

Review date: 2026-11-06  
Scope: current CRE workflow, committed Solidity settlement contracts, contract artifacts/tests, local-simulation execution adapters and UI chain reads. Isolated Sepolia and Base Sepolia demo token/settlement deployments are now live; no CRE report broadcast or CRE DON execution was performed.

## Executive summary

The earlier CRE/Solidity ABI mismatch has been reconciled in the current worktree. The CRE workflow now reads the actual Chain A `getTransaction`, Chain B `getAssetReservation`, and Chain A `getDecision` outputs using ABI constants generated from compiled Hardhat artifacts. COMMIT and ABORT report payloads use the exact current `ProtocolTypes` field order. Fifteen Hardhat tests pass, including ABI identity, getter decoding, production encoder-to-receiver COMMIT/ABORT flows, and duplicate relay rejection.

Contract-side decision safety is now verified from source and tests: Chain A accepts COMMIT only while undecided, payment locked, and before expiry; permissionless ABORT accepts only after expiry and while undecided. State and token transfer revert atomically. Base accepts a decision only for a locked reservation and rejects subsequent reports after it has been delivered/released.

The full deployed execution path remains unproven. Isolated demo tokens and settlement receivers have been deployed to Sepolia and Base Sepolia, and each receiver's immutable `trustedForwarder` is the corresponding tenant mock Forwarder. The local workflow config points at these deployments while both write flags remain false. No CRE report broadcast or CRE DON execution has been performed. The CRE CLI v1.39.0 is installed, but tenant DON deployment access is unavailable.

CRE documentation describes callbacks as fresh, independent, stateless executions ([CRE overview](https://docs.chain.link/cre/overview)); EVM Write delivers reports through the configured Forwarder to `onReport(bytes,bytes)` ([EVM Read & Write](https://docs.chain.link/cre/capabilities/evm-read-write)). Durable idempotency therefore rests on contract state, not workflow memory.

## Resolved findings

| Finding | Current implementation and evidence |
|---|---|
| Incorrect Chain A reservation getter | **Resolved:** `readPaymentReservation` calls `DecisionPaymentSettlement.getTransaction(bytes32)` and decodes Terms, terms hash, decision, and payment status (`workflow.ts`, `contract-codec.ts`). Solidity source is `contracts/src/DecisionPaymentSettlement.sol::getTransaction`. |
| Incorrect Chain B reservation structure | **Resolved:** `readAssetReservation` decodes `(Terms, termsHash, AssetStatus, Decision, decisionRecordId, decisionNonce)` using the artifact-derived ABI (`contract-codec.ts`). Source is `contracts/src/AssetSettlement.sol::getAssetReservation`. Asset obligation is read through `computeAssetObligationId(Terms)`. |
| Incorrect decision getter layout | **Resolved:** decoder uses Solidity's seven results and binds the transaction ID to the `getDecision` argument (`contract-codec.ts::decodeChainADecision`). Source is `contracts/src/DecisionPaymentSettlement.sol::getDecision`. |
| Event signatures and indexed fields | **Resolved:** workflow event selectors and decoders use artifact-derived event ABI entries (`workflow.ts::initWorkflow`, `handleLockEvent`, `onDecisionRecorded`). Compatibility tests compare full CRE ABIs with artifacts, including event indexed flags. |
| Report tuple layouts | **Resolved and receiver-tested:** `report-encoding.ts` encodes all 17 fields in `ProtocolTypes.CoordinationReport` and all 17 fields in `ProtocolTypes.DecisionRelayReport`. The contract suite passes these production CRE payloads into the actual Chain A and Chain B `onReport` functions. |
| Terms consistency | **Resolved in workflow:** `evaluateLockState` compares all `Terms` fields across Chain A and Chain B and binds event tx ID/hash to Chain A registered terms before evaluating readiness (`workflow.ts::sameProtocolTerms`, `evaluateLockState`). Solidity computes and stores the canonical terms hash in both contracts. |
| Duplicate settlement | **Verified at contract boundary:** Chain A rejects decisions after the first and performs state/token transfer atomically (`DecisionPaymentSettlement.onReport`, `abort`). Base requires `LOCKED` and then changes to a terminal asset status before transfer (`AssetSettlement.onReport`). Hardhat tests verify duplicate reports do not transfer twice. Workflow also skips a relay when finalized Base state already has the same decision record (`onDecisionRecorded`). |

## Current safeguards

- Lock triggers are chain-specific, filtered by configured contract and artifact-derived event topic, and use `FINALIZED` confidence (`workflow.ts::initWorkflow`). Callbacks verify emitter/topic, deployment block and ignore removed logs (`handleLockEvent`, `onDecisionRecorded`).
- Unknown reservation/decision enum values throw. Solidity enum values match the numeric decoder: Decision `0/1/2`; payment and asset states `0/1/2/3`.
- COMMIT eligibility requires matching, locked, unexpired reservations and an undecided Chain A decision (`domain.ts::evaluateReservationReadiness`). Chain A revalidates local lock, expiry, and the full CoordinationReport at inclusion (`DecisionPaymentSettlement.onReport`).
- Workflow does not author ABORT. It relays the finalized Chain A decision only, after comparing the source decision block, transaction, terms, destination, and finalized Base reservation state (`workflow.ts::onDecisionRecorded`, `domain.ts::evaluateDecisionRelay`).
- Chain B checks source/destination bindings, terms, obligation ID, decision record ID/nonce, participants, asset, amount, and expiry in `_validateDecisionReport` (`AssetSettlement.sol`).
- `local-simulation` cannot select production CRE writes; local broadcast is separately opt-in and requires the configured test receiver's `trustedForwarder` to equal the chain-specific mock Forwarder. `production-cre` rejects local broadcast config. Production writes remain disabled.
- Reconciliation is manually triggered with an authorized HTTP trigger in production mode and a CLI-supplied HTTP payload in simulation; state and reports are reconstructed from finalized contract state and immutable Chain A decision records.
- A successful report receiver execution is followed by independent latest-state reads on both chains; this is a verification check, not a claim of finality. Finalized state must be checked again before declaring settlement complete.

## Outstanding failure scenarios

| Scenario | Current behavior and remaining risk | References |
|---|---|---|
| Duplicate lock callback | The workflow has no persistent event dedupe key and can submit repeated Chain A reports while a prior report is pending. Chain A write-once validation prevents a second payment/decision; the duplicate may revert and surface as a failed execution. | `workflow.ts::evaluateLockState`; `DecisionPaymentSettlement.sol::onReport` |
| Duplicate decision callback | `onDecisionRecorded` checks finalized Base state and returns `RELAY_ALREADY_APPLIED` for the same record. If an earlier Base report is not yet finalized, a repeated report may still be submitted; Base's status guard prevents a second transfer. | `workflow.ts::onDecisionRecorded`; `AssetSettlement.sol::onReport` |
| Missed event or transient read failure | Manual reconciliation now accepts a transaction ID, rereads finalized current state on both chains and either evaluates matching undecided locks or relays the immutable finalized Chain A decision. It is safe to repeat; automated discovery/backfill of unknown transaction IDs is not implemented. | `workflow.ts::onReconcile`, `onDecisionRecorded` |
| Permissionless ABORT races COMMIT | Workflow readiness and report submission are separate. Chain A resolves the race atomically at inclusion: COMMIT requires `block.timestamp < expiresAt`; ABORT requires `block.timestamp >= expiresAt`; both require UNDECIDED, so only the first valid decision wins. Existing tests cover boundary rejection and write-once behavior, not simultaneous mempool ordering. | `DecisionPaymentSettlement.sol::onReport`, `abort`; `settlement.test.ts` |
| Source finalized read unavailable | `.result()` failure propagates; workflow does not fall back to latest. This is fail-closed but there is no later reconciliation guarantee if the callback is not rerun. | `workflow.ts::readAuthoritativeDecision`, `onDecisionRecorded` |
| Destination write included but not finalized | Callbacks now fail on `UNKNOWN`/non-success receiver status and reread latest source and destination state after writes. Latest state is not a finality guarantee. Transaction hash and independent finalized reads are required before declaring settlement complete. | `report-write.ts::writeCreReport`; `workflow.ts::verifyCommitAfterWrite`, `verifyRelayAfterWrite` |
| Finalized lock event is reorganized | Removed logs are ignored; reads use finalized state and Chain A rechecks current conditions at inclusion. A prior callback is not compensated, but reconciliation re-reads authoritative state and contracts remain atomic/idempotent. Live deployed CRE behavior is not tested. | `workflow.ts::handleLockEvent`; `DecisionPaymentSettlement.sol::onReport` |

## Tests and validation

- Existing Hardhat suite: **15 passing** before this execution-mode adaptation; it covers generated ABI equality, getter decoding, matching terms hashes, production report encoders passed through actual receivers, and duplicate settlement rejection.
- CRE workflow: `bun run typecheck` passed after the adaptation.
- CRE workflow safety/reconciliation tests: `bun test` passed, **5 tests** (mode separation, invalid configuration, missed-event readiness, retry after failed relay, already-applied/conflicting destination decision).
- Contract compile/typecheck and full Hardhat suite are to be rerun after this change; results will be recorded below after execution.
- Frontend TypeScript/build have not been rerun in this adaptation. UI files were not changed.
- CLI v1.39.0 is installed and supports simulation `--broadcast`. Demo contract/token addresses are now configured, but no full workflow run against initialized, matching reservations and finalized lock events has been performed.

The unit/Hardhat checks and deployment verification do not prove CRE DON consensus or live settlement. Testnet deployments were performed, but no CRE report transaction was broadcast.

## Recommended next steps

1. Seed and fund demo participants, create matching reservations and finalized lock events, then run local simulation reads and dry-run reports.
2. Before any local `--broadcast`, replace the configured CRE signer: the current `CRE_ETH_PRIVATE_KEY` resolves to a publicly known demo account and must not be used or funded. Use a separately configured/funded test signer and verify receiver Forwarder bindings.
3. If test broadcast is explicitly desired, submit only to the isolated mock-Forwarder receivers and independently verify transaction hashes and finalized state.
4. Keep production writes disabled pending tenant DON deployment access.

## Contract implementation facts and remaining questions

Verified in current source/tests:

- Chain A decision is write-once; ABORT is permissionless after expiry, including when payment was never locked.
- Chain A COMMIT plus payment is atomic; a failed token transfer leaves the decision undecided.
- Chain B refuses to release an asset based only on local expiry and rejects duplicate decision processing.
- The current Chain B decision record nonce is `1`, and its record ID is derived from source chain/contract, transaction ID, terms hash, decision, and nonce.

Still requiring operational input or an explicit product decision:

- Buyer/seller demo wallet addresses, token funding, matching reservation/lock transactions, and a fresh local simulator signer before any test broadcast.
- CRE deployment access and an observed live receiver transaction.
- Automated discovery/backfill of unknown transaction IDs is not implemented; current reconciliation is manual per supplied ID.
- UI labels distinguishing local simulation/test-relayer from DON execution remain unimplemented because Dev 2's UI files were intentionally not changed.
- Arkiv access key for reliable evidence publication beyond rate-limited public endpoint use.

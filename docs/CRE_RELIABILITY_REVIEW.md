# CRE Workflow Reliability and Reconciliation Review

Review date: 2026-11-06  
Scope: current CRE TypeScript workflow and its checked-in configuration/tests. No implementation changes were made as part of this review.

## Executive summary

The workflow has useful fail-closed checks: it filters lock logs by configured address/topic, rejects removed logs, checks decoded participant/amount against current reservations, compares both reservation reads, decodes unknown enum values as errors, keeps writes disabled by default, and reads Chain A decision state at `LAST_FINALIZED_BLOCK_NUMBER` before relaying a finalized decision.

Those safeguards do not provide end-to-end exactly-once settlement or recovery. CRE callbacks are independent executions with no persistent callback state, and the current project has no periodic reconciliation handler, event cursor/backfill, workflow-side deduplication, destination-state confirmation, or application status persistence. This is a safe architecture only if the settlement contracts enforce atomic, write-once decisions and idempotent destination handling, and if another reliable path can recheck/reconcile decisions that were not relayed. Those contract properties are not verified because the settlement contracts and deployed ABIs are not in this repository.

The most important gaps are:

1. Duplicate lock/decision triggers can submit the same report more than once. The workflow has no delivery key or durable dedupe record.
2. A missed or failed event has no recovery path in this workflow. In particular, a delayed/lost Chain A decision event can leave Base locked after Chain A is decided.
3. A readiness read and subsequent Chain A COMMIT report are separate operations. Expiry ABORT can race the report; only an atomic Chain A contract check can safely choose the winner.
4. `writeCreReport` treats `receiverExecutionStatus=UNKNOWN` as a returnable result, and the business callbacks can return `SUBMIT_COMMIT`/`RELAY_COMMIT` without checking destination finalized state. These values mean a report path ran, not that settlement is complete.
5. The lock-event terms are checked for cross-chain consistency, but the workflow does not compare them to an independent agreed-terms source or recompute `termsHash`.

**Status labels used below:** **Verified** means visible in the checked-in code. **Assumption** means it depends on contract/runtime behavior not established by this repository. **Proposal** means a recommended change, not existing behavior.

## Current safeguards

| Safeguard | Status and evidence |
|---|---|
| Lock log address and topic filters | **Verified:** `initWorkflow` configures each EVM log trigger with one configured settlement address and the event topic (`workflow.ts:480-504`). `handleLockEvent` checks the emitting address and topic again (`workflow.ts:327-348`). The client/trigger pairing fixes the source chain to Sepolia or Base Sepolia. |
| Decision log finality | **Verified:** the `DecisionRecorded` trigger requests `FINALIZED` confidence (`workflow.ts:505-513`), and `onDecisionRecorded` rereads `getDecision` at `LAST_FINALIZED_BLOCK_NUMBER` (`workflow.ts:411-433`, `readAuthoritativeDecision` at `workflow.ts:212-250`). |
| Removed log handling | **Verified:** handlers return without action for `log.removed` (`workflow.ts:334-337`, `workflow.ts:411-415`). This does not reverse an earlier action if the earlier `SAFE` lock log is later reorganized. |
| Reservation identity and cross-chain comparison | **Verified with a scope limit:** `evaluateReservationReadiness` checks tx ID, terms hash, buyer/seller, configured chain/contract, token, amount, obligation IDs, expiry, and `LOCKED` status (`domain.ts:135-161`, `domain.ts:168-205`). The expected parties and terms fields passed by `evaluateLockState` are populated from the current reservation reads (`workflow.ts:252-296`), so this proves the two reads are mutually consistent, not that they match an independent user-agreed record. |
| Event participant and amount | **Verified:** `evaluateLockState` compares the triggering event's participant/amount to the corresponding current reservation before readiness evaluation (`workflow.ts:260-270`). |
| Unknown enum values | **Verified:** `decodeReservationStatus` and `decodeDecision` throw for unrecognized codes (`workflow.ts:78-104`). |
| COMMIT readiness | **Verified:** evaluator returns `SUBMIT_COMMIT` only when both reservations are present, matching, `LOCKED`, and unexpired, and the supplied Chain A decision is `UNDECIDED` (`domain.ts:168-205`). **Assumption:** the Chain A consumer independently checks the same conditions and expiry at execution time. |
| ABORT authority | **Verified in workflow logic:** expiry returns `WAIT_FOR_CHAIN_A_ABORT`; the workflow does not create an ABORT decision (`domain.ts:164-205`). ABORT relay is only selected after a non-UNDECIDED Chain A decision is read (`domain.ts:208-230`). |
| Existing decision observation | **Verified, but not atomic:** if the Chain A read returns a non-UNDECIDED decision, the readiness evaluator returns `DECISION_ALREADY_RECORDED` and does not construct another COMMIT report (`domain.ts:181-188`). A decision can still be written between that read and a COMMIT report submission. |
| Write toggle | **Verified:** `enableWrites` defaults to false in `configSchema` (`workflow.ts:65-72`) and the checked-in config sets it to false (`config.json:1-5`). This review does not enable it. |
| Receiver auth smoke | **Verified only for the isolated smoke receiver:** tests cover unauthorized caller rejection, accepted Forwarder caller, and empty report rejection (`cre-smoke/test/CREReportReceiverSmoke.test.cjs:13-40`). These are not settlement idempotency tests. |

CRE's official overview describes each trigger as starting a fresh independent execution and callbacks as stateless, with no persistent state between executions ([CRE overview](https://docs.chain.link/cre/overview)). The EVM Write documentation describes a signed report delivered through a Keystone Forwarder to the consumer's `onReport` entry point ([EVM Read & Write](https://docs.chain.link/cre/capabilities/evm-read-write)). The workflow must therefore rely on on-chain state for durable idempotency and settlement truth.

## Failure scenario matrix

| Scenario | Current behavior | Reliability impact | Status / code reference |
|---|---|---|---|
| Duplicate `PaymentLocked` or `AssetLocked` trigger | Each execution rereads both reservations and Chain A decision. If the read still says `UNDECIDED`, each execution may submit the same COMMIT report when writes are enabled. No `(chainId, txHash, logIndex)` or transaction-level dedupe is stored. | Duplicate report submissions are possible. Whether they can charge/settle twice depends on Chain A's atomic write-once guard and receiver behavior. | **Verified gap:** `handleLockEvent`, `evaluateLockState` (`workflow.ts:252-325`, `327-391`); no durable state in `domain.ts`. |
| Duplicate `DecisionRecorded` trigger / retried callback | Each execution rereads Chain A decision and constructs the relay report from that state. No local/remote relay marker is checked. | Same decision can be sent to Base repeatedly. Destination must handle duplicates idempotently by decision/transaction identity. | **Verified gap:** `onDecisionRecorded` (`workflow.ts:411-478`), `evaluateDecisionRelay` (`domain.ts:208-230`). |
| Lock event occurs before workflow activation, trigger delivery is missed, or callback fails | Only event triggers exist for locks and decisions. There is no timer, scan, cursor, retry queue, or reconciliation handler in `initWorkflow`. | No code path discovers the missed event or re-evaluates the transaction unless another relevant event is delivered. Whether the CRE trigger service replays any event range is not specified in this repository; do not treat replay as a guarantee. | **Verified gap:** `initWorkflow` registers only three log handlers (`workflow.ts:480-516`). |
| One lock callback runs before the other chain's reservation is visible | Both reads occur in one callback, but the chains are read independently at unspecified/latest heights. Missing reservation returns a wait action. There is no later poll if no further event fires. | Transaction can remain eligible but unprocessed after a temporary cross-chain visibility/read timing issue. | **Verified gap:** `evaluateLockState` reads both (`workflow.ts:252-262`); evaluator returns `WAIT_FOR_RESERVATIONS` (`domain.ts:196-198`); no reconciliation trigger. |
| SAFE lock log is reorganized after callback | `log.removed` is ignored when observed. Trigger confidence is `SAFE`, not `FINALIZED`; prior callback effects are not reverted or compensated by the removed-log handler. | A report may have been submitted using a reservation later reverted from the source chain. Chain A must validate actual reservation state atomically; otherwise there is reorg exposure. | **Verified:** confidence in `initWorkflow` (`workflow.ts:484-504`); removed-log handling (`workflow.ts:334-337`). Contract response is an **assumption**. |
| COMMIT report and permissionless expiry ABORT race | Evaluator checks runtime wall-clock seconds before building the report. Chain A report is a later EVM transaction. A permissionless abort may execute in between; there is no lock/lease in workflow. | Both attempts may be submitted. Correctness requires Chain A to atomically accept exactly one decision, check expiry and reservation states at inclusion, and make the loser harmless/revert without state change. | **Verified race window:** `evaluateLockState` (`workflow.ts:290-317`), expiry check (`domain.ts:190-205`). On-chain guarantee is **unverified**. |
| Chain A decision already exists when COMMIT readiness runs | A non-UNDECIDED read prevents the workflow from constructing a COMMIT report. | This avoids an intentional overwrite when the read sees the decision. It does not close the read/write race or prove the receiver cannot overwrite an existing decision. | **Verified guard:** `evaluateReservationReadiness` (`domain.ts:181-188`). **Assumption:** Chain A write-once state transition. |
| Chain A becomes COMMIT, but Base relay is delayed or never delivered | `DecisionRecorded` is the only relay trigger. It reads finalized state and writes once per callback; no retry/reconciliation schedule is configured. | Chain A can be committed while Base remains locked. The UI/application may stay inconsistent unless it independently reads both chains or a new trigger retries the relay. | **Verified gap:** `onDecisionRecorded` (`workflow.ts:411-478`), `initWorkflow` has no scheduled handler (`workflow.ts:480-516`). |
| `LAST_FINALIZED_BLOCK_NUMBER` cannot be read | `readAuthoritativeDecision(..., true).result()` propagates capability/read failure. No fallback to latest is used, which avoids making a relay decision from an unfinalized read. No explicit catch, retry policy, or later reconciliation exists here. | Safe stop for that execution, but liveness depends on CRE/runtime redelivery or another event. That behavior has not been verified in this project. | **Verified:** `readAuthoritativeDecision` (`workflow.ts:212-237`); **missing recovery:** `onDecisionRecorded` (`workflow.ts:430`). |
| Finalized event and state read differ | Handler checks event decision equals the finalized `getDecision` value, then checks transaction/terms and source/destination bindings (`workflow.ts:429-444`, `domain.ts:208-230`). | Mismatch throws or rejects and avoids relay. It does not check that returned obligation IDs match current reservations or that `recordId` corresponds to the specific event; the event ABI has no record ID. | **Verified limit:** `DECISION_RECORDED_ABI` (`workflow.ts:27-29`), `evaluateDecisionRelay` (`domain.ts:208-230`). Contract record semantics are **assumptions**. |
| EVM Write response has `UNKNOWN` receiver execution status | Adapter throws on non-success tx status or explicit receiver revert, but returns `UNKNOWN` otherwise (`report-write.ts:42-56`). Both main callbacks log that value and return their business action without requiring `SUCCESS` (`workflow.ts:312-324`, `466-478`). | Callback result can appear successful although receiver execution is unconfirmed. Even `SUCCESS` in the capability response is not followed by a destination finalized state read. | **Verified gap:** cited adapter/callbacks. |
| Destination transaction is included but later reorganized or consumer state is not as expected | Workflow logs tx hash and receiver execution response; it does not poll a destination receipt to finality or reread consumer state. | Inclusion/capability success is not destination finality or proof that settlement is complete. An application must not label the trade complete from this callback result alone. | **Verified gap:** `writeCreReport` (`report-write.ts:32-56`), `onDecisionRecorded` (`workflow.ts:449-478`). |
| Stored reservation fields agree with each other but differ from user-agreed terms | `termsHash` from the event is compared to the two reservation terms hashes. Buyer/seller/token/amount/obligation/expiry expected values are largely seeded from the reservations themselves. No canonical terms input or hash recomputation is present. | Cross-chain equality is checked, but the workflow alone does not prove the records encode the terms shown/accepted by the user. The contracts may guarantee this; not verified. | **Verified limit:** `evaluateLockState` (`workflow.ts:272-288`), `matchesTerms` (`domain.ts:135-161`). |
| Retry after uncertain write result | Callback may throw on explicit error or continue on unknown execution status. No transaction/report idempotency key or destination-state query is used to determine whether the earlier write took effect. | Blind retry can duplicate a report; not retrying can leave a decision unrelayed. Contract idempotency is mandatory. | **Verified gap:** `writeCreReport` (`report-write.ts:42-56`), no durable tracking in workflow. |

## Missed events, retries, and in-memory state

- **Duplicate delivery:** The workflow does not deduplicate trigger events. Repeated executions recompute from chain reads and can re-submit a report. Repeated report delivery is safe only if the receiver is idempotent.
- **Missed-event recovery:** None is implemented. There is no scheduled scan of undecided/reserved transactions or finalized Chain A decisions lacking Base completion, and no event-range cursor/backfill. CRE trigger delivery/replay guarantees were not established from the checked-in artifacts, so they remain an operational question rather than a safeguard.
- **Re-execution safety:** Callbacks are deterministic in the sense that they derive actions from current chain reads and configured addresses, but they are not exactly-once. Chain state can change between reads and writes. Re-execution is safe only with contract-enforced write-once decisions and duplicate-safe Base consumption.
- **Existing Chain A decision:** Workflow observation prevents it from intentionally submitting COMMIT after seeing an existing decision. It does not itself enforce write-once; the race between read and report submission remains. ABORT is never authored by this workflow.
- **Relay identity:** A retry reads `getDecision(transactionId)` and encodes the returned tx ID, terms hash, obligation IDs, decision, and record ID. The relay evaluator checks tx ID/terms/source/destination but not obligation IDs against independent reservation state. Stable retry identity depends on `getDecision` being immutable after the first decision and the `recordId` being stable.
- **Chain A COMMIT followed by delayed Base relay:** Chain A remains the authority. The Base relay can be retried from the same finalized decision if a trigger is redelivered, but there is no new periodic retry path. Until Base consumes the report, the two chains can show different states. App status must represent “Chain A decided; Base pending” rather than “settled.”
- **Source finality unavailable:** The handler errors on the finalized read and does not fall back to an unfinalized value. This preserves decision safety but does not ensure eventual relay; recovery is missing.
- **Inclusion vs finality:** `txHash` plus a successful adapter response is evidence about the write operation's reported outcome, not a destination-finalized settlement status. Current code does not await destination finality or verify an on-chain completion getter/event.
- **Workflow-only state:** There is no workflow memory state by design. Trigger payload and intermediate values are local variables only. Durable transaction/decision/relay status must come from the settlement contracts or an existing application-owned status source. No database or new infrastructure is recommended for the current scope.

## Missing safeguards

1. **No destination idempotency verification.** The workflow has no acknowledgement/state read to distinguish “not applied” from “applied, response lost.”
2. **No reconciliation trigger.** Event-only progression creates a liveness gap after missed events, temporary capability failures, or delayed Base execution.
3. **No canonical terms verification.** The two chain reads agree against values derived from the reads, but the workflow does not load/recompute the canonical user-approved terms hash.
4. **No chain-state pinning across reads.** Payment, asset, and decision reads use no common or recorded block references; they may reflect different heights. Contract-side validation must close state races.
5. **No finalized verification of reservation locks.** Lock triggers use `SAFE`, and the reservation reads are not pinned to finalized block numbers. A removed log is ignored, not compensated.
6. **No validation of decision obligation IDs against expected reservations before relay.** They are forwarded from Chain A decision state.
7. **Unknown receiver status is non-fatal in the main workflow.** The adapter exposes `UNKNOWN`, but commit and relay callbacks proceed to return their action.
8. **No status vocabulary separating report submission, destination execution, and final settlement.** Callback action strings can be mistaken for completed application state.
9. **No reliability tests for the pure evaluator or callbacks.** The only checked-in tests are for the isolated smoke receiver; no workflow/domain test suite is present. `config.json` contains zero-address placeholders and `enableWrites=false`, so no settlement workflow integration result is recorded.

## Recommended minimal changes

These are recommendations only; no changes were made in this review.

### Workflow

1. Add a lightweight scheduled reconciliation handler that reads authoritative on-chain state for configured/pending transaction IDs or a bounded event range, then re-evaluates and replays reports. Use only existing contract state/events and CRE capabilities; do not add a database. The exact enumeration mechanism depends on Dev 2's implemented contract interface. If the contract cannot enumerate pending transaction IDs or decision records, document how the application supplies a bounded set.
2. Treat workflow outputs as action states such as `COMMIT_REPORT_SUBMITTED` / `BASE_RELAY_SUBMITTED`, not as settlement completion. Keep “complete” dependent on finalized destination state readback.
3. Fail the execution or mark it explicitly pending when receiver execution is `UNKNOWN`; do not report relay success from an unknown response.
4. Where supported by the finalized read/trigger semantics, compare the `DecisionRecorded` event's block reference to the authoritative decision record or use a stable on-chain decision record ID included in the event/getter. Avoid inventing an event signature: agree it with Dev 2 first.
5. Before relay, verify that Chain A decision obligation IDs match the reservation/contract's authoritative obligation identifiers. Exact getters and available enumeration must come from Dev 2's contract implementation.
6. Bind expected buyer, seller, token, amount, expiry, and obligation IDs to a canonical terms source already used by the application, or have the contract prove that these fields hash to `termsHash`. Do not create a second terms encoding independently.
7. Keep finality failures fail-closed, but ensure the reconciliation path can retry them. Do not silently fall back from `LAST_FINALIZED_BLOCK_NUMBER` to latest.

### Settlement contracts

1. Chain A must enforce an atomic write-once decision transition: accept COMMIT only while undecided, before expiry, with both valid reservations; accept permissionless ABORT only while undecided and after expiry. The state transition and payment execution must be atomic as specified by the protocol.
2. Duplicate reports must be idempotent. A repeated report for the same transaction/decision/record ID should not repeat payment or asset transfer. Conflicting decisions or misbound reports must revert without changing settlement state.
3. Base must persist a consumed decision/record reference per transaction and make duplicate delivery a harmless no-op/rejection. It must validate source chain/contract, destination, transaction, terms, asset obligation, and decision before moving assets.
4. Expose enough authoritative state/event data for reconciliation to determine whether payment execution, asset delivery/release, and decision relay have completed. The review does not prescribe getter names or signatures.

## Tests needed

No tests were added or run for this review. Before enabling writes, add tests against the actual contract ABI and implementation for:

1. Duplicate delivery of identical Chain A COMMIT report causes at most one payment execution.
2. Duplicate Base COMMIT and ABORT reports cause at most one asset delivery/release.
3. Same transaction ID with different terms hash, decision record, source/destination binding, or obligation IDs is rejected.
4. COMMIT vs permissionless expiry ABORT race: whichever transaction is validly accepted first is write-once; the other cannot overwrite or execute settlement.
5. COMMIT just before expiry with report mined after expiry follows the contract's explicitly agreed inclusion-time rule.
6. Repeated and out-of-order `PaymentLocked`, `AssetLocked`, and `DecisionRecorded` deliveries converge to the same state.
7. A removed/reorged SAFE lock event cannot cause payment or asset settlement; finalized decision relay is only based on finalized Chain A state.
8. Finalized source read unavailable, callback error, unknown receiver status, explicit receiver revert, and lost/ambiguous write response are distinguishable and recoverable.
9. Delayed Base relay is eventually recovered by reconciliation, and the application continues to display Chain A decided / Base pending until Base finality is verified.
10. Workflow evaluator tests for mismatched tx ID/terms hash/participants/token/amount/obligation/expiry/status, existing COMMIT/ABORT, expiry boundary, missing reservations, and malformed enum values.
11. Report ABI encoding tests against Dev 2's published ABI, plus an EVM Write receiver test that exercises the actual settlement consumer and duplicate semantics (the current smoke receiver test does not cover these).

## Questions for Developer 2

1. Does Chain A atomically check `UNDECIDED`, reservation statuses, and `block.timestamp < expiresAt` before accepting COMMIT and executing payment? What is the exact race behavior if permissionless ABORT wins first?
2. Is decision state strictly write-once? How are repeated identical reports handled? What happens to a conflicting COMMIT/ABORT report?
3. Does the Chain A decision record have a stable ID/nonce and immutable tx ID, terms hash, obligation IDs, and decision? Can the `DecisionRecorded` event identify that same record?
4. Which chain timestamp defines expiry, and is the boundary `>= expiresAt` for ABORT and `< expiresAt` for COMMIT?
5. How does Chain B prevent duplicate asset transfer/release across repeated EVM Write callbacks? What durable consumed key does it record?
6. Which exact fields does the Base receiver validate, including source chain, source contract, destination chain/contract, terms hash, obligation ID, and record ID?
7. What on-chain read/event can prove payment executed and Base delivered/released assets, and are those states terminal/finalized?
8. Can the contracts enumerate unresolved reservations/decisions or emit enough indexed events for bounded reconciliation without off-chain storage?
9. Do reservation getters return missing/terminal states explicitly, and can their fields be trusted as the canonical terms hashed by the user-facing flow?
10. What is the final ABI and enum mapping for events, getters, and report payloads? `CONTRACT_INTERFACES.md` is currently marked proposal and must not be treated as implementation evidence.

## Review boundary

The repository contains the CRE coordinator proposal, the isolated smoke receiver, and its local receiver tests; it does not contain Dev 2's settlement contracts or deployed addresses. Consequently, this review verifies workflow-side behavior but cannot certify atomic settlement, contract idempotency, exact ABI compatibility, or eventual destination completion. Main settlement writes remain disabled in `raisinFi/my-workflow/config.json`.

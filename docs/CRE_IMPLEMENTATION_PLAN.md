# CRE implementation plan

## Ownership and scope

Developer 1 owns CRE account/project setup, workflow configuration, event triggers, cross-chain reads, workflow simulation, EVM Write integration, and the CRE-facing interface with the settlement contracts.

Developer 2 owns settlement contracts, the authenticated receiver implementation, frontend, Arkiv, and the optional Uniswap path. Shared event and report interfaces must be agreed before both sides harden their implementations.

## Build sequence

1. **Environment and tenant verification**
   - Install and record the CRE CLI version.
   - Authenticate and record `cre whoami` without recording credentials.
   - Check deployment access.
   - Record the tenant's supported chains and exact Forwarder addresses.
   - Confirm Ethereum Sepolia and Base Sepolia by their tenant chain names.
2. **Project setup**
   - Check for an existing CRE project before initializing one.
   - Initialize TypeScript only if no project exists.
   - Record the generated CLI/SDK versions and inspect `project.yaml` and workflow configuration.
   - Configure both RPCs through local/private settings; keep credentials out of Git.
3. **Reservation trigger and verifier**
   - Add lock-event triggers only after the generated SDK's EVM log API is confirmed.
   - Check source chain and emitter against configured contract references.
   - Decode `transactionId` and `termsHash` from the event.
   - Read both reservations and compare every agreed term, status, and expiry.
   - Keep the verification and decision evaluation code independent of SDK calls.
4. **Chain A decision submission**
   - Permit a COMMIT report only when both reservations match and remain valid.
   - Do not invent ABORT: wait for Chain A's permissionless post-expiry abort transaction.
   - Treat retries as independent executions and rely on contract idempotency/write-once checks.
5. **Chain B decision relay**
   - Trigger from Chain A's decision event or a retry/reconciliation trigger.
   - Read the authoritative decision at `finalized` confidence where the configured chain and SDK support it.
   - Bind the report to transaction, terms, source, destination, consumer, and decision reference.
   - Submit through CRE EVM Write and the exact SDK-supported Forwarder receiver pattern.
6. **Simulation and evidence**
   - Simulate locally before any broadcast.
   - Record exact commands, output, SDK/CLI versions, unresolved issues, and real transaction hashes only when a real write is performed.
   - Label local simulation separately from DON deployment/execution.

## Interface decisions required before contract integration

- Canonical `transactionId` and `termsHash` encoding.
- Exact lock and decision event signatures (the conceptual signatures in the protocol spec are the starting point).
- Reservation getter return fields and enum values.
- Decision getter return fields and stable decision record reference.
- CRE report tuple/ABI and source/destination binding fields.
- Exact receiver interface and tenant Forwarder addresses.
- Finality policy for the Chain A decision read.

## Current constraint

The generated TypeScript project is present under `raisinFi/`, and the user's tenant output confirms both required networks and their Forwarder entries. A DON deployment-access request was submitted and is pending review. Both lock-event triggers, proposed cross-chain reservation reads, readiness evaluation, a finalized Chain A decision trigger/read, proposed report payloads, and an SDK EVM Write adapter are now wired in TypeScript. Report writes default to disabled. The getter/report ABIs are review proposals, not frozen contract interfaces; deployed settlement addresses and a CRE simulation against the integration workflow remain pending. See [CONTRACT_INTERFACES.md](CONTRACT_INTERFACES.md) and [CRE_SPIKE_RESULTS.md](CRE_SPIKE_RESULTS.md).

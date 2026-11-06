# RaisinFi CRE workflow

This directory is the CRE TypeScript project root. The project was initialized from Chainlink's multi-chain token manager template; its sample APY rebalancing workflow has been replaced with the RaisinFi coordinator.

## Current workflow scope

- Watches `PaymentLocked` on `ethereum-testnet-sepolia`.
- Watches `AssetLocked` on `ethereum-testnet-sepolia-base-1`.
- Checks the emitting contract and event signature, decodes `transactionId` and `termsHash`, and verifies event participant/amount against the current reservation.
- Reads both proposed reservation getters and the Chain A decision getter, then evaluates matching terms, status, and expiry.
- Watches finalized `DecisionRecorded` events and rereads Chain A at `FINALIZED` confidence before evaluating a Base relay.
- Uses the CRE SDK's `EVMClient.logTrigger` and `logTriggerConfig` APIs.

The reservation getters, enum values, and report tuples are proposals and must be agreed with the contract owner. The EVM Write adapter is implemented, but writes are disabled by default until contracts implement the reviewed receiver interface.

## Configuration

1. Install dependencies from this directory with `bun install`.
2. Keep RPC credentials in local environment configuration, never in Git. `project.yaml` currently uses the public RPC endpoints shown there.
3. Replace both zero-address placeholders in `my-workflow/config.json` with the deployed `DecisionPaymentSettlement` and `AssetSettlement` addresses before simulating lock triggers.
4. Confirm the CRE tenant's enabled chains and Forwarder addresses with `cre workflow supported-chains --output json`; a successful local simulation does not prove tenant deployment access.

## Commands

From this directory:

```bash
bun run typecheck
cre workflow simulate my-workflow --target staging-settings
```

Simulation is local execution. A report write in simulation is not a DON execution or a real testnet transaction. Use `--broadcast` only after configuring a real target and intentionally approving a testnet write.

## Project notes

- `my-workflow/domain.ts` contains SDK-independent reservation and decision validation logic.
- `my-workflow/workflow.ts` contains CRE triggers, cross-chain reads, decision checks, and proposed report encoding.
- `my-workflow/report-write.ts` wraps the official CRE EVM Write capability.
- `contracts/evm` currently contains generated contracts from the starter template; these are not the RaisinFi settlement contracts.
- `docs/CRE_SPIKE_RESULTS.md` records observed setup and simulation results.

# RaisinFi CRE workflow

This directory is the CRE TypeScript project root. The project was initialized from Chainlink's multi-chain token manager template; its sample APY rebalancing workflow has been replaced with the first RaisinFi vertical slice: validated `PaymentLocked` and `AssetLocked` event triggers.

## Current workflow scope

- Watches `PaymentLocked` on `ethereum-testnet-sepolia`.
- Watches `AssetLocked` on `ethereum-testnet-sepolia-base-1`.
- Checks the emitting contract and event signature, decodes `transactionId` and `termsHash`, and logs the source chain and event reference.
- Uses the CRE SDK's `EVMClient.logTrigger` and `logTriggerConfig` APIs.

The lock callbacks do not read settlement state or submit a decision yet. The exact getter ABI and report schema must be agreed with the contract owner first; see `../docs/CONTRACT_INTERFACES.md` from the repository root.

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
- `my-workflow/workflow.ts` contains CRE trigger setup and event decoding.
- `contracts/evm` currently contains generated contracts from the starter template; these are not the RaisinFi settlement contracts.
- `docs/CRE_SPIKE_RESULTS.md` records observed setup and simulation results.

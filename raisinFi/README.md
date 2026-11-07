# RaisinFi CRE workflow

This directory is the CRE TypeScript project root. The project was initialized from Chainlink's multi-chain token manager template; its sample APY rebalancing workflow has been replaced with the RaisinFi coordinator.

## Current workflow scope

- Explicit `local-simulation` and gated `production-cre` execution modes use the same validation, decision, and report encoding logic.
- Watches finalized `PaymentLocked` and `AssetLocked` events and verifies source/receiver addresses, participant, amount, terms and deployment block.
- Reads actual settlement getters from Ethereum Sepolia and Base Sepolia using generated Hardhat ABIs.
- Watches finalized Chain A `DecisionRecorded` events and includes a manual HTTP reconciliation trigger to recover missed events or retry a delayed relay using finalized chain state.
- Local simulation prepares exact receiver report payloads without writing by default. Optional broadcast uses CRE's tenant-specific mock Forwarder and requires isolated receiver deployments trusting that mock Forwarder.
- Production CRE EVM Write remains disabled by default; no DON execution or settlement is claimed.

## Configuration

1. Keep RPC URLs in `project.yaml`; keep private keys and provider credentials outside Git.
2. The isolated Sepolia/Base Sepolia demo token and settlement addresses are recorded in `my-workflow/config.json`; these receivers use CRE tenant mock Forwarders and are for worthless test assets only. Create/fund demo reservations before running local simulation.
3. Keep `localBroadcastEnabled` and `productionWritesEnabled` false unless the corresponding path is explicitly approved and configured.
4. Re-check the tenant's production/mock Forwarders with `cre workflow supported-chains --output json` before use.
5. See [`docs/CRE_LOCAL_SIMULATION.md`](../docs/CRE_LOCAL_SIMULATION.md) for deployment, simulation, COMMIT/ABORT demo and manual reconciliation instructions.

## Commands

From `raisinFi/` (project root):

```bash
bun run --cwd my-workflow typecheck
bun run --cwd my-workflow test
cre workflow simulate my-workflow --target local-simulation
```

Simulation is a local execution process, not DON consensus. It can read real testnet state from configured RPCs. `--broadcast` sends a real testnet transaction through the mock Forwarder and a separately configured/funded local signer; only use isolated test receivers configured for that mock Forwarder. See the local simulation guide.

## Project notes

- `my-workflow/domain.ts` contains SDK-independent reservation and decision validation logic.
- `my-workflow/workflow.ts` contains CRE triggers, cross-chain reads, decision checks, and proposed report encoding.
- `my-workflow/report-write.ts` wraps the official CRE EVM Write capability.
- `contracts/evm` currently contains generated contracts from the starter template; these are not the RaisinFi settlement contracts.
- `docs/CRE_SPIKE_RESULTS.md` records observed setup and simulation results.

# CRE spike results

Last checked: 2026-11-06 (Asia/Kolkata)

This file records observed results only. A missing result means the corresponding command has not successfully run in this environment.

## Environment

| Check | Observed result |
|---|---|
| Repository branch | `feat/cre-workflow` |
| CRE CLI | `cre` is available at `/Users/therealdeal/.cre/bin/cre`; observed version `v1.39.0` |
| Node.js | Available at `/opt/homebrew/bin/node` |
| npm | Available at `/opt/homebrew/bin/npm` |
| pnpm | Available at `/opt/homebrew/bin/pnpm` |
| CRE CLI version | `v1.39.0` (verified with `cre version`) |
| CRE tenant command | `cre workflow supported-chains --output json` returned the tenant-scoped chain list |
| CRE account / `cre whoami` | Authenticated to organization `My Org`; deploy access reports `Not enabled` |
| Deployment access / `cre account access` | Access request submitted successfully; review pending |
| Chains in local simulation | Both `ethereum-testnet-sepolia` and `ethereum-testnet-sepolia-base-1` were read successfully by the user's sample workflow |
| Tenant chain enablement | Both required chains appear in the tenant output |
| Ethereum Sepolia | Selector `16015286601757825753`; `address`: `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`; `mockAddress`: `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| Base Sepolia | Selector `10344971235874465080`; `address`: `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`; `mockAddress`: `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` |
| Existing CRE project | Generated project is present at `raisinFi/`, with `project.yaml`, `my-workflow/`, generated starter contracts, and locked TypeScript SDK dependencies |
| TypeScript SDK | Installed and locked at `@chainlink/cre-sdk` `1.23.0` |
| Sample project simulation | Existing user-reported sample simulation read pool values on both testnets; this is separate from deployed RaisinFi settlement state |
| Sample EVM write | Simulation returned an all-zero transaction hash; this is not a real testnet transaction |
| RaisinFi workflow check | `bun run typecheck` and 5 workflow safety/reconciliation tests pass. Workflow now has explicit local-simulation/production-cre modes, local test broadcast guard, finalized reads, and manual reconciliation. Actual settlement simulation is blocked until contracts/tokens are deployed and addresses configured. |
| Local receiver compile | `bun run compile` in `raisinFi/cre-smoke` passed with solc `0.8.24` (Hardhat warned that installed Node.js `v25.9.0` is outside its supported versions) |
| Local receiver authorization tests | `bun run test` passed: rejects unauthorized callers, accepts and records a Forwarder report, rejects empty reports |
| CRE EVM Write smoke workflow | Added as a separate `cre-write-smoke` target; TypeScript typecheck passes. Production CRE DON deployment remains unavailable. The CLI supports local simulation `--broadcast` through the tenant mock Forwarder; current receivers trust only a constructor-configured forwarder, so isolated mock-forwarder receiver deployments are required. |
| EVM Write smoke transaction hash | None; no local broadcast or testnet transaction was run in this adaptation |

## Commands and results

The current agent shell checks returned: `command -v cre` -> `/Users/therealdeal/.cre/bin/cre`; `cre version` -> `v1.39.0`; `cre workflow simulate --help` documents `--broadcast` (default false), `--trigger-index` and `--http-payload`. `cre workflow supported-chains --output json` lists both required chains and their production/mock Forwarders, as shown above. Tenant identity and deployment access status were previously user-supplied: DON deployment access is not enabled. Personal email and organization ID are intentionally omitted from this repository record.

The user's starter-template simulation reportedly read both chains and returned a zeroed report transaction hash, so it was local simulation rather than a real testnet transaction. Current workflow CLI availability is verified in this shell as recorded above.

The CRE TypeScript project resolves `@chainlink/cre-sdk` to `1.23.0`. It reads generated artifact-based ABIs, handles finalized payment/asset locks and Chain A decisions, and encodes the receiver-tested report tuples. Explicit local-simulation and production-cre modes, local mock-forwarder checks, post-write verification, and manual finalized-state reconciliation have been added. Typecheck and 5 safety tests pass. The initial local simulation attempt failed during configuration validation because addresses were zero. Since then, demo tokens and settlement receivers have been deployed to Sepolia/Base Sepolia; deployment receipts, bytecode, token metadata, receiver mock Forwarders, and cross-chain binding were verified, and local config now uses these addresses. A full workflow simulation against initialized reservations/locks and any CRE report broadcast remain unrun.

For C4, an isolated `CREReportReceiverSmoke` contract stores a report hash/count and accepts calls only from its constructor-configured Forwarder. Its Hardhat tests passed locally. A separate CRE smoke target encodes a harmless `(string,uint64)` report and routes it through the official SDK EVM Write adapter; the receiver is undeployed and no write transaction has been observed.

## Remaining setup checks

Fund demo participants and create matching reservations/lock transactions before running a read-only local simulation. Do not use the current `CRE_ETH_PRIVATE_KEY` for any broadcast: it resolves to a publicly known demo account; replace it with a fresh test signer first. Any local test broadcast requires explicit approval and mock-Forwarder receiver checks. Wait for tenant deployment-access review before attempting DON deployment. Keep private keys and RPC credentials out of docs/configs/Git. See `docs/CRE_LOCAL_SIMULATION.md` for deployment records and safety conditions.

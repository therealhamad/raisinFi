# CRE spike results

Last checked: 2026-11-06 (Asia/Kolkata)

This file records observed results only. A missing result means the corresponding command has not successfully run in this environment.

## Environment

| Check | Observed result |
|---|---|
| Repository branch | `feat/cre-workflow` |
| CRE CLI | User reports successful CLI use; `cre` is not on this agent shell's PATH |
| Node.js | Available at `/opt/homebrew/bin/node` |
| npm | Available at `/opt/homebrew/bin/npm` |
| pnpm | Available at `/opt/homebrew/bin/pnpm` |
| CRE CLI version | `v1.39.0` (user provided `cre version` output) |
| CRE tenant command | `cre workflow supported-chains --output json` returned the tenant-scoped chain list |
| CRE account / `cre whoami` | Authenticated to organization `My Org`; deploy access reports `Not enabled` |
| Deployment access / `cre account access` | Access request submitted successfully; review pending |
| Chains in local simulation | Both `ethereum-testnet-sepolia` and `ethereum-testnet-sepolia-base-1` were read successfully by the user's sample workflow |
| Tenant chain enablement | Both required chains appear in the tenant output |
| Ethereum Sepolia | Selector `16015286601757825753`; `address`: `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`; `mockAddress`: `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| Base Sepolia | Selector `10344971235874465080`; `address`: `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`; `mockAddress`: `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` |
| Existing CRE project | Generated project is present at `raisinFi/`, with `project.yaml`, `my-workflow/`, generated starter contracts, and locked TypeScript SDK dependencies |
| TypeScript SDK | Installed and locked at `@chainlink/cre-sdk` `1.23.0` |
| Sample project simulation | User reports successful compile and local simulation; it read pool values on both chains |
| Sample EVM write | Simulation returned an all-zero transaction hash; this is not a real testnet transaction |
| RaisinFi event workflow build/simulation | TypeScript typecheck passed after replacing the sample workflow with two lock-event triggers; CRE simulation with actual settlement contracts remains pending |
| EVM Write smoke test / transaction hash | Pending; no real testnet write was performed |

## Commands and results

The following availability checks were run from the repository root:

```text
command -v cre   -> no output (not installed/on PATH)
command -v node  -> /opt/homebrew/bin/node
command -v npm   -> /opt/homebrew/bin/npm
command -v pnpm  -> /opt/homebrew/bin/pnpm
```

The user supplied `cre version` output (`CRE CLI version v1.39.0`), authenticated `cre whoami` output, a successful `cre account access` request, and the complete output of `cre workflow supported-chains --output json`. Both required chains are enabled for the tenant. Each entry provides an `address` and `mockAddress`; these are recorded exactly above, preserving the field names from the CLI output. DON deployment access is not enabled yet; the access request is pending review. Personal email and organization ID are intentionally omitted from this repository record.

The earlier agent-shell installation attempt is separate: the downloaded v1.39.0 macOS ARM64 archive matched the official release SHA-256 (`f0bfb90928cbdf3fccab6ec5420167681edb6ea566982b31016275bc77e09dfb`), but the extracted binary failed local Apple code-signature verification and was not installed or executed. The user's CLI works in their terminal. Their starter-template simulation read both chains and reported a zeroed report transaction hash, so it was local simulation rather than a real testnet transaction.

The CRE TypeScript project resolves `@chainlink/cre-sdk` to `1.23.0` in `my-workflow/node_modules` and `bun.lock`. The starter's pool/APY/rebalance workflow was replaced with the RaisinFi lock-event trigger workflow; no settlement-contract addresses were supplied, so the config currently contains zero-address placeholders.

## Remaining setup checks

The CLI version, authenticated organization status, supported chains, Forwarders, and submitted deployment-access request have been recorded. Wait for the organization's access review before DON deployment. The project is already initialized under `raisinFi/`; do not initialize another project. Keep account credentials, RPC secrets, and private keys out of this file and Git. Replace the zero-address placeholders with deployed settlement contract addresses before simulating the RaisinFi EVM log triggers.

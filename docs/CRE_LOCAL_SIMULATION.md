# RaisinFi CRE local simulation and testnet execution

Status: workflow/config adaptation implemented; isolated Sepolia and Base Sepolia demo token/settlement deployments are verified and recorded below. Both workflow write flags remain disabled, and no CRE report transaction has been broadcast.

## What local simulation does

`cre workflow simulate` compiles and runs the workflow locally (WASM), not across a Chainlink DON. CRE's EVM client uses the RPCs in `raisinFi/project.yaml`, so finalized state reads can query actual Ethereum Sepolia and Base Sepolia. The same workflow code validates both reservations, compares canonical terms/hash, uses Chain A's authoritative decision, and encodes the exact Solidity report tuples.

The CLI supports `--broadcast`. For local simulation broadcasts, CRE uses its tenant's **MockKeystoneForwarder**; the `CRE_ETH_PRIVATE_KEY` account is the transaction sender/gas payer. It does not impersonate the production Forwarder or create DON consensus. A receiver must have been deployed with the matching chain-specific mock Forwarder as its immutable `trustedForwarder`. The mock does not verify DON signatures and is permissionless; any caller can route arbitrary reports through it. Keep these receiver deployments throwaway and limited to worthless demo tokens. This preserves the receiver's configured-forwarder authentication but is **not** production-grade report authentication. See [CRE simulation](https://docs.chain.link/cre/guides/operations/simulating-workflows), [Forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts), and [onchain writes](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/writing-data-onchain).

The current tenant's addresses (confirmed with `cre workflow supported-chains --output json`, CLI v1.39.0):

| Chain | Production Forwarder | Local simulation Mock Forwarder |
|---|---|---|
| Ethereum Sepolia | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| Base Sepolia | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` |

These are tenant-specific; re-check them before deployment. The workflow also reads each configured contract's `trustedForwarder()` before it submits a report and fails closed on a mismatch.

## Execution modes and safeguards

- `local-simulation` is configured in `my-workflow/config.json`. It always prepares/logs the report with writes off by default. `localBroadcastEnabled` is a second explicit opt-in; actual testnet broadcast additionally requires the CLI `--broadcast` flag. The active contract addresses must be isolated demo deployments whose constructor forwarders equal the corresponding mock Forwarders. The workflow labels these as test receivers and logs the configured submitter's **public address**, never a private key.
- `production-cre` is configured separately in `my-workflow/config.production-cre.json`. It uses the authenticated CRE EVM Write capability and production Forwarder; `productionWritesEnabled` remains `false`. It rejects local-broadcast settings. Local simulation cannot prove DON consensus or production Forwarder acceptance.
- Do not point a local simulator write at a production receiver: its production Forwarder will reject the mock Forwarder caller. Do not change receiver authentication or use an unauthenticated direct `onReport` call.
- COMMIT is only requested after finalized matching, locked, unexpired reservations. This workflow never creates ABORT. Chain A's permissionless abort is authoritative; reconciliation relays only that recorded immutable decision.
- Reports already applied to finalized Base state are skipped. Failed or delayed relay can be retried by rerunning reconciliation; Chain B's terminal state prevents a second asset transfer.
- A latest-state post-write check is not finality. Confirm transaction hashes and then query both chains at finalized state before claiming completion.

## Configuration

1. Keep RPC URLs in `raisinFi/project.yaml`. Current public Sepolia and Base Sepolia URLs are configured; provider-specific URLs can be supplied there.
2. The isolated demo token and settlement instances below are deployed with the respective local mock Forwarders, not production Forwarders. Transfer enough worthless demo tokens to the demo buyer/seller wallets before creating reservations; no Solidity business logic/authentication changes were made.
3. `my-workflow/config.json` is populated with the demo Chain A/Chain B settlement/token addresses and settlement deployment blocks. Keep both mock Forwarder fields as given. Do not configure a broadcast submitter until a fresh, non-publicly-known simulator key is installed.
4. Keep `localBroadcastEnabled: false` for report-only simulation. For a testnet write, set it to `true` only after the demo receiver's `trustedForwarder()` has been independently checked, fund the signer on **both** chains, and pass `--broadcast`.
5. `config.production-cre.json` is a separate template. Set deployed production receiver/token addresses, deployment blocks, and `reconciliationAuthorizedAddress` before it can validate. Keep `productionWritesEnabled: false` until CRE DON access and all production configuration are explicitly approved.
6. Never put a private key, provider credential, or access token in either JSON config or Git. The CLI reads its private key from ignored local environment configuration (`CRE_ETH_PRIVATE_KEY`). `localSubmitterAddress` is informational and must be checked against that key out of band.

Isolated mock-Forwarder demo deployments have now been created and verified:

| Chain | Contract | Address | Deployment block | Transaction |
|---|---|---|---:|---|
| Sepolia | Demo RDT payment token | `0x94420ff404238419452Eb8f25Ddb002e7Aa2a7e5` | 12078069 | `0xa684f4874213c1a71e4197bd25d48b35832a9df4b5431715448c3bbf30d7e2bf` |
| Sepolia | DecisionPaymentSettlement | `0x46474063C039f76111d0a393B8266E377dF7b8e8` | 12078072 | `0x878f3acb12442f4a799bce1f4b3fd88ef24da87a7e36582fba65c650625c542e` |
| Base Sepolia | Demo RDT asset token | `0x5050Badc7279A059AFC0CDb04d1a63cEFfa0CAaF` | 55338131 | `0xb909e9b2e6d57cb996a40df302ab1dfc3ff1d68f893f1bf0d21f9d827ca78b06` |
| Base Sepolia | AssetSettlement | `0x9DbFA23d09deb3A66a7261de9E7e708A1b9bBc1A` | 55338217 | `0x5e0af106a1f8518fec016636783e81c6607974c5d5ad5fd376517be0d4f0185d` |

The Settlement receivers were independently checked for code, successful deployment receipt, mock `trustedForwarder`, and cross-chain contract binding; token names/symbols/supply/decimals were also read back. `my-workflow/config.json` now points to these test deployments, with both write flags still false. No CRE report transaction has been broadcast. These test receivers use permissionless mock Forwarders and must hold only worthless test tokens.

## Demo and reconciliation commands

The deployments are complete; the following commands are retained as reference only and must not be rerun casually, since they create additional testnet contracts and consume gas. RPC URLs and deployer keys are held in ignored `contracts/.env`. From `contracts/`, the isolated test deployments were created with:

```bash
# Deploy demo tokens; initial supply is in base units and goes to the deployer.
TEST_TOKEN_NAME='Raisin Demo Token' TEST_TOKEN_SYMBOL='RDT' TEST_TOKEN_INITIAL_SUPPLY='1000000000000000000000' \
  npx hardhat run scripts/deploy-test-token.ts --network sepolia
TEST_TOKEN_NAME='Raisin Demo Asset' TEST_TOKEN_SYMBOL='RDA' TEST_TOKEN_INITIAL_SUPPLY='1000000000000000000000' \
  npx hardhat run scripts/deploy-test-token.ts --network baseSepolia

# Deploy the settlement instances with the local mock Forwarders (not production Forwarders).
CRE_ETHEREUM_FORWARDER_ADDRESS='0x15fC6ae953E024d975e77382eEeC56A9101f9F88' \
  npx hardhat run scripts/deploy-chain-a.ts --network sepolia
CRE_BASE_FORWARDER_ADDRESS='0x82300bd7c3958625581cc2f77bc6464dcecdf3e5' \
PAYMENT_CONTRACT_ADDRESS='0x<deployed-chain-a-address>' \
  npx hardhat run scripts/deploy-chain-b.ts --network baseSepolia
```

Record each returned address, deployment block, and transaction hash. Transfer test tokens to the buyer and seller wallets; set the on-chain terms to the exact deployed settlement/token addresses. Then populate `my-workflow/config.json` as described above.

Run from `raisinFi/` (the directory containing `project.yaml`). Install workflow dependencies first if necessary with `bun install --cwd my-workflow`.

### Report-only local simulation

After the demo contracts/tokens are deployed and `config.json` is populated, create/register and lock both reservations using the app's normal buyer/seller wallet flow. Wait for both lock events to be finalized, then reconcile by transaction ID:

```bash
cre workflow simulate my-workflow \
  --target local-simulation --non-interactive --trigger-index 3 \
  --http-payload '{"transactionId":"0x<64-hex-transaction-id>"}'
```

Trigger index `3` is the manual HTTP reconciliation handler after the three EVM log handlers. With `localBroadcastEnabled: false` (default) this reads finalized testnet state, evaluates the shared protocol logic, encodes/logs the report payload, and does not submit a transaction. The workflow is local, not DON consensus.

### COMMIT test settlement

For an actual **test** broadcast, first configure `localBroadcastEnabled: true` and `localSubmitterAddress`, set `CRE_ETH_PRIVATE_KEY` to the funded test signer in local ignored environment config, and verify the settlement receivers trust the mock Forwarders. Then run the reconciliation command above with `--broadcast` appended. It submits the Chain A CoordinationReport through the mock Forwarder. Wait until Chain A is finalized, then run the same reconciliation again with `--broadcast`; it reads the immutable finalized COMMIT and relays its DecisionRelayReport to Base. Verify both transaction hashes and finalized Chain A payment/decision plus Base terminal reservation state.

### ABORT test settlement

Create and lock the test reservations, let `expiresAt` pass, and have a wallet call the existing Chain A `abort(transactionId)` function (the application exposes this action). The CRE workflow will **not** infer ABORT from expiry. After Chain A's ABORT is finalized, run the reconciliation command with `--broadcast`; it relays that original decision to the Base test receiver. Run it again if the relay failed or its state was not yet finalized. Already-applied Base state is skipped.

### Retry behavior

For a missed lock/decision event or failed Base relay, repeat the same HTTP reconciliation command with the same transaction ID. It has no dependency on in-memory state. While Base is still locked, it encodes the same source decision again; after Base has finalized that record, it returns `RELAY_ALREADY_APPLIED` without submitting another report. Chain A's write-once rule and Chain B's terminal-state guard remain the final duplicate-settlement protections.

## Current verification and limitations

- Installed CLI is v1.39.0; `cre workflow simulate --help` confirms `--broadcast`, and CLI supported-chain output lists both testnets and mock Forwarders. The official docs state simulations make calls to configured RPCs and require a funded `CRE_ETH_PRIVATE_KEY` for writes.
- Isolated test deployments are configured, but there are no initialized matching reservations or lock events yet, so a meaningful transaction-ID simulation and testnet COMMIT/ABORT have not been run.
- Deployment transaction hashes and contract/token state were independently verified above. No CRE report transaction hash or testnet settlement state exists.
- No automated discovery of every missed transaction is implemented. Reconciliation is manual and bounded to the supplied transaction ID.
- The existing UI was intentionally not modified (Dev 2's work is out of scope). Its presentation has not been updated to label local simulation/test-relayer execution versus DON execution; that UI-label requirement remains for Dev 2/product approval. Do not present the CLI local run as DON consensus.
- Production CRE deployment access is not enabled for this tenant. The production-CRE path is retained but not demonstrated.

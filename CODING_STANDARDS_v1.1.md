# Coding Standards & Engineering Instructions

**Project:** Cross-Chain Financial Transaction Coordination Engine\
**Status:** Revised implementation baseline — Ethereum Sepolia + Base Sepolia\
**Applies to:** Next.js, FastAPI, Solidity, Chainlink CRE workflows,
Arkiv, Uniswap and tests.

## 1. Purpose

These standards apply to all code, including AI-generated code. The
goals are maintainability, clear module ownership, low-conflict
collaboration, explicit failure handling and technically honest
behaviour.

## 2. Core principles

-   **Single responsibility:** Each module, class, function and
    component has one clear responsibility.
-   **Separation of concerns:** Keep domain rules, application services,
    HTTP handlers, persistence, external integrations and presentation
    separate.
-   **Dependency direction:** Domain logic must not depend on FastAPI,
    SQLAlchemy, Web3.py, Arkiv SDK or CRE SDK classes. Use interfaces at
    infrastructure boundaries.
-   **Explicitness:** Prefer descriptive names, visible side effects,
    typed inputs and outputs, and straightforward control flow.
-   **No premature abstraction:** Do not build generic frameworks for
    one use case. Abstract when there are multiple real implementations
    or a clear testing/ownership benefit.
-   **No silent failure:** Errors must be handled, logged safely and
    represented accurately to callers.
-   **No unsupported claims:** Code and UI must not imply settlement
    finality, atomicity or consensus that has not actually been
    verified.

## 3. Repository boundaries

``` text
apps/
  web/                 # Next.js frontend
  api/                 # FastAPI application
contracts/              # Solidity and Hardhat
cre/                    # Chainlink CRE workflows
packages/
  shared-types/
  contract-abis/
  protocol-schemas/
docs/
scripts/
```

Rules:

1.  Frontend code must not import backend implementation modules.
2.  Backend domain code must not import frontend code.
3.  CRE workflows must not import FastAPI internals.
4.  Contracts must not depend on backend or frontend code.
5.  Shared packages contain stable schemas, types or generated
    artifacts---not miscellaneous business logic.
6.  Keep module exports narrow. Do not reach into another module's
    private implementation.
7.  Do not manually edit generated ABIs if the build generates them.

## 4. Naming conventions

### Python

-   Modules/files, functions and variables: `snake_case`.
-   Classes and types: `PascalCase`.
-   Constants: `UPPER_SNAKE_CASE`.
-   Type hints on public functions and important boundaries.

### TypeScript

-   Variables/functions: `camelCase`.
-   Types/interfaces/classes and React components: `PascalCase`.
-   Hooks: `useCamelCase`.
-   Avoid `any`; validate unknown external data at the boundary.

### Solidity

-   Contracts, structs and events: `PascalCase`.
-   Functions and variables: `camelCase`.
-   Constants and immutables: `UPPER_SNAKE_CASE`.
-   Use descriptive custom errors.

Names must communicate intent. Avoid vague names such as `data`,
`manager`, `helper`, `process` or `handleThing` when a precise name is
available.

## 5. Backend standards --- Python and FastAPI

FastAPI/PostgreSQL are optional for the 24-hour MVP, not a prerequisite. Do not build or preserve backend infrastructure merely because it appears in an earlier architecture sketch. If already working and useful, keep it thin. Otherwise the frontend may read verified chain state and Arkiv directly. If a backend is retained, use the agreed Python runtime, FastAPI, Pydantic, SQLAlchemy 2.x, Alembic, Ruff and Pytest.

### Layer responsibilities

**API/router layer** - Validate HTTP input and access permissions. -
Call application services. - Map known application errors to HTTP
responses. - Do not implement complex business rules or direct
blockchain orchestration.

**Application/service layer** - Implement use cases and coordinate
domain operations. - Do not depend on FastAPI request objects.

**Domain layer** - Own transaction concepts, invariants, statuses and
transition rules. - Remain independent of database and external SDKs.

**Repository layer** - Own database queries and persistence. - Do not
put business policy in query methods.

**Infrastructure/adapters** - Encapsulate Web3.py, Arkiv, CRE and other
provider SDKs. - Translate provider-specific results into project-owned
types.

### Backend rules

-   Use Pydantic schemas for external input/output.
-   Do not expose ORM models directly as API responses.
-   Use timezone-aware UTC timestamps.
-   Represent token amounts as integer base units or validated decimal
    strings; never use floating-point numbers for money.
-   Use Alembic for schema changes.
-   Use database constraints for important invariants where practical.
-   Set explicit timeouts on external calls.
-   Retry only safe-to-retry operations, with bounded backoff.
-   Use idempotency keys for retried requests and side effects.
-   Do not block async handlers with synchronous network operations.
-   Do not swallow exceptions or return stack traces to clients.
-   Catch broad exceptions only at process boundaries, with safe logging
    and translation.

## 6. Frontend standards --- Next.js and TypeScript

-   Enable TypeScript strict mode.
-   Use feature-based organisation.
-   Keep components focused and reasonably small.
-   Keep business rules out of presentation components.
-   Centralise API configuration and request handling.
-   Separate server state from local UI state.
-   Handle loading, empty, error and stale states explicitly.
-   Treat WebSocket updates as notifications, not proof of on-chain
    execution.
-   Reconcile state through REST after reconnecting.
-   Validate forms on the client and again on the backend.
-   Prevent duplicate submissions while requests are in flight.
-   Use integer base units or decimal-safe libraries for token
    calculations.
-   Provide accessible labels, keyboard navigation and visible focus
    states.

Suggested feature structure:

``` text
src/
  app/
  features/
    transactions/
      components/
      hooks/
      api/
      types/
    participants/
    settlement/
    evidence/
    wallet/
  components/ui/
  lib/
  types/
```

Do not create global contexts or shared components without a genuine
reuse need.

## 7. Solidity standards

-   Use a consistent pinned Solidity compiler version.
-   Prefer established OpenZeppelin components where appropriate.
-   Use custom errors and meaningful events.
-   Keep external state-changing functions explicit and minimal.
-   Apply checks-effects-interactions and reentrancy protection where
    applicable.
-   Use safe ERC-20 transfer patterns.
-   Review every state-changing function for caller authorisation,
    participant consent, replay, duplicate execution, expiry, reentrancy
    and incorrect chain/contract references.
-   Prevent double reservation and double settlement.
-   Make expiry and pre-commit release rules enforceable on-chain.
-   Do not let the backend arbitrarily move participant assets.

Any coordination report accepted by a settlement contract must be bound
to the transaction ID, terms hash, obligation/leg, chain ID, target
contract, token, amount, recipients and relevant expiry/decision fields.
A report for one transaction must not be reusable for another.

Test valid and invalid reservations, wrong callers, wrong transaction
IDs, wrong terms hashes, expiry, duplicate operations, invalid reports,
valid settlement, release and access control.

## 8. Chainlink CRE workflow standards

-   Use the official CRE SDK and a pinned compatible version.
-   Inspect official templates before implementing capabilities from
    scratch.
-   Verify a template exists, its purpose, SDK version and network
    assumptions before adopting it.
-   Keep workflows focused and callbacks small.
-   Validate workflow inputs and outputs.
-   Separate business-condition evaluation from SDK capability calls
    where practical.
-   Do not store durable transaction state in workflow memory;
    executions must be independently retryable.
-   Define behaviour for failed reads, duplicate events, retries and
    unavailable chains.
-   Record workflow references and outcomes.
-   Distinguish local simulation from deployed DON execution. Never
    claim DON consensus from local simulation alone.

For this MVP, CRE has two distinct workflow responsibilities:
1. Observe a participant lock event, read both settlement contracts, and verify matching transaction ID, terms hash, participants, tokens, amounts, lock status and expiry.
2. Observe Chain A's authoritative decision after the configured source-read policy, then deliver the decision report to Chain B's receiver.

Do not assume one trigger watches multiple chains unless the selected SDK API and configuration explicitly support that. A safe initial design is a source-chain event trigger followed by explicit reads of both chains; use a separate source-decision trigger/workflow for relaying the decision if that is clearer and easier to retry.

Use the official `evm.Client` EVM Read and EVM Write capabilities. EVM Write delivers a DON-signed report through the configured Keystone Forwarder to the consumer's `onReport(bytes metadata, bytes report)` receiver. Prefer the official receiver template/interface for the pinned SDK version. The contract must authenticate the actual tenant/network Forwarder address and validate the report's transaction-specific payload. Never invent a custom CRE signature format.

CRE EVM Read supports `finalized`, `latest`, or a specific block number according to the current capability documentation. Use `finalized` for Chain A decision reads if the selected chain/capability configuration supports it. If the workflow cannot obtain a finalized read, do not silently substitute latest: explicitly adopt and document a confirmation-depth policy, and label it confirmations rather than finality.

`cre workflow supported-chains` is tenant-scoped. After login, use its output as the source of truth for chain names and Forwarder addresses. Public documentation or a generic supported-network list does not prove that a particular account/tenant has the networks enabled.

Local simulation is not DON execution. Simulation uses configured RPCs and local tooling; it does not prove DON consensus. Deploy access is separately approved. Contracts and chain state hold durable settlement facts; workflow executions are stateless and must be safely repeatable.

## 9. External integration standards

All providers must be isolated behind dedicated adapters.

### Blockchain

-   Use explicit chain configuration and validate chain IDs.
-   Set RPC timeouts and handle rate limits.
-   Verify receipts, emitting contract addresses, event signatures,
    transaction/obligation IDs, amounts and participants.
-   A submitted transaction is not a confirmed transaction.
-   Apply an explicit chain-specific confirmation/finality policy.

### Arkiv

-   Keep SDK calls inside an Arkiv adapter.
-   Validate entity schemas and persist entity references.
-   Never publish secrets or private participant information.
-   Handle entity expiry.
-   Make writes retryable and idempotent at the application level.
-   PostgreSQL, if used, is an operational projection only; verified on-chain state is authoritative for reservations, decisions and execution.

### Uniswap

-   Keep quote and swap operations in a dedicated integration module.
-   Validate chain and token support.
-   Display quote expiry, expected output and slippage assumptions.
-   Require explicit user authorisation.
-   Verify swap execution and resulting balances.
-   A quote is not an executed swap; a swap is not proof that the parent
    transaction settled.

## 10. API and shared schema standards

Use a versioned API prefix such as `/api/v1`, consistent response/error
structures and appropriate HTTP status codes.

Agree on these shared contracts before parallel implementation:

-   Transaction and participant schemas.
-   Obligation schema.
-   Transaction and obligation status enums.
-   Signature payload.
-   CRE workflow input/output.
-   Contract function and event signatures.
-   Evidence record schema.

Do not independently rename shared fields or enum values. For a shared
schema change: notify the other developer, agree on it, update the
canonical schema, update consumers and add tests.

Prefer additive API changes. Document breaking changes and keep
frontend/backend contracts synchronised.

## 11. Transaction state and event processing

-   Implement an explicit state transition map.
-   Validate transition preconditions.
-   Persist transition history.
-   Reject invalid transitions.
-   Use optimistic concurrency/version checks where appropriate.
-   Do not let late events move a transaction backwards.
-   Do not mark a transaction `SETTLED` based solely on a callback or
    WebSocket message.
-   Use stable idempotency keys/event references for retried operations.
-   Verify chain ID, emitting contract, event signature,
    transaction/obligation ID, expected participants, amounts, receipt
    status and finality before processing events.
-   Support reconciliation from persisted records and verified chain
    evidence.

WebSocket delivery is best-effort. Clients must be able to recover
through REST.

## 12. Testing and quality gates

### Backend

-   Domain/state-machine unit tests.
-   API/service tests.
-   Repository and migration tests.
-   Adapter tests with controlled provider responses.
-   Duplicate and retry tests.

### Frontend

-   Wallet connection.
-   Transaction creation and acceptance.
-   Loading/error states.
-   Live updates and reconnect recovery.
-   Evidence rendering.

### Contracts

-   All critical transitions.
-   Access control.
-   Report verification.
-   Expiry and release.
-   Replay and duplicate execution.
-   Token transfer failures.

### CRE

-   Trigger behaviour.
-   Contract reads.
-   Reservation validation.
-   Missing/expired reservation.
-   Valid and invalid report conditions.
-   Settlement event observation.
-   Retry and failure handling.
-   Local simulation.

Before merging, run the relevant formatters, linters, type checks, tests
and production/build checks. Do not merge unresolved compiler/type
errors or failing tests without an explicitly agreed exception.

## 13. Two-developer collaboration

### Suggested ownership

**Developer 1 (Hamad; starts immediately) — CRE integration lead**
- Own `cre/`, CRE CLI setup, project/workflow configuration, CRE workflow code and simulation.
- Own the CRE integration spike: event trigger, cross-chain EVM reads, finalized decision read, EVM Write report delivery and receiver compatibility.
- Establish the canonical workflow input/output and report payload with Developer 2 before either side hardens interfaces.
- Can create minimal Solidity receiver stubs only to unblock CRE testing; do not independently redesign the settlement contracts.
- Keep a running `docs/CRE_SPIKE_RESULTS.md` with exact CLI version, tenant chain list, Forwarder addresses, SDK versions, commands, successful outputs, errors and unresolved items.

**Developer 2 (joins later) — contracts and application**
- Own `contracts/`, token fixtures, settlement contract implementation and contract tests.
- Own the UI and any optional API/backend modules.
- Own Arkiv and Uniswap spikes/integrations unless the team explicitly reallocates them.
- Implement the Chain B receiver against the agreed official CRE receiver interface and report schema.

**Shared interface freeze (both developers, 20–30 minutes)**
- Agree transaction ID and terms hash encoding.
- Agree event names/fields, decision enum, chain IDs and contract addresses/config keys.
- Agree the report payload and its source/destination binding.
- Agree the exact source-read finality policy.
- Commit a single interface document before parallel implementation.

Do not let Developer 1 build the full settlement contracts while also trying to finish CRE. The priority is a working CRE vertical slice against minimal stubs, with contract ownership then handed to Developer 2. Shared interfaces must be agreed before parallel implementation. Assign one owner to shared configuration and schema files. Avoid both developers editing the same files concurrently.

### Git rules

-   Never work directly on `main`.
-   Use short-lived feature branches.
-   Keep pull requests focused.
-   Integrate frequently.
-   Do not commit secrets, local environment files or unnecessary build
    outputs.
-   Avoid unrelated formatting/refactoring in feature PRs.

Example branches:

``` text
feat/transaction-api
feat/transaction-ui
feat/settlement-contracts
feat/cre-workflow
feat/arkiv-integration
feat/uniswap-integration
```

### Pull request requirements

Every PR must state: - What changed and why. - Modules affected. - API,
contract or schema changes. - Tests performed. - New environment
variables. - Integration implications.

Notify the other developer before changing a shared interface. Do not
silently change another module's assumptions.

## 14. Documentation

Maintain:

-   `README.md` --- setup and run instructions.
-   `ARCHITECTURE.md` --- module boundaries and dependencies.
-   `API_CONTRACT.md` --- API schemas and endpoints.
-   `CONTRACT_INTERFACES.md` --- functions, events and errors.
-   `STATE_MACHINE.md` --- statuses, transitions and invariants.
-   `DECISIONS/` --- significant architecture decisions.

Comments should explain why a non-obvious choice exists, not repeat what
the code already says. Update documentation when behaviour or interfaces
change.

## 15. Environment and secrets

-   Maintain `.env.example` with safe placeholders.
-   Never commit real credentials or private keys.
-   Use separate local, simulation and testnet configurations.
-   Validate required configuration at startup.
-   Fail clearly when required configuration is missing.
-   Never log secrets.

Use explicit configuration names, for example:

``` text
DATABASE_URL
ETHEREUM_RPC_URL
BASE_RPC_URL
ARKIV_ENDPOINT
CRE_PROJECT_CONFIG
```

Finalise exact names in the repository configuration contract. Do not
put private keys in frontend environment variables.

## 16. Code review checklist

### Design

-   [ ] One clear responsibility.
-   [ ] Correct module boundary.
-   [ ] Dependencies point in the correct direction.
-   [ ] Abstraction is justified.

### Correctness

-   [ ] Inputs validated.
-   [ ] Errors handled explicitly.
-   [ ] State transitions valid.
-   [ ] Side effects visible.
-   [ ] Retries safe.
-   [ ] Duplicate processing handled.

### Security

-   [ ] Permissions checked.
-   [ ] Signatures/reports bound to the correct transaction.
-   [ ] Secrets protected.
-   [ ] Token amounts avoid floating-point arithmetic.
-   [ ] Replay and duplicate execution prevented.

### Quality and collaboration

-   [ ] Types explicit and names descriptive.
-   [ ] Relevant tests pass.
-   [ ] Documentation updated.
-   [ ] Shared interfaces unchanged or coordinated.
-   [ ] PR is focused and integration impact is clear.

## 17. Definition of Engineering Done

Code is ready to merge when:

1.  It implements the agreed requirement.
2.  It follows module boundaries.
3.  Relevant checks pass.
4.  Expected failure conditions are handled.
5.  Retries are safe where applicable.
6.  Shared interface changes are coordinated.
7.  Adequate tests exist.
8.  Necessary documentation is updated.
9.  The implementation does not claim guarantees it does not provide.

**Final principle: Prefer code another developer can understand, test,
modify and safely integrate over code that merely works once in a
demo.**


## 18. CRE CLI setup and first-run checklist (current project)

Run CRE commands in a terminal on the development machine, not in the browser console and not inside the Solidity/Hardhat console.

1. Install the CRE CLI using the official Chainlink installation instructions for your operating system.
2. Open a terminal (macOS Terminal/iTerm or VS Code integrated terminal).
3. Authenticate:
   ```bash
   cre login
   cre whoami
   ```
4. Request/check DON deployment access:
   ```bash
   cre account access
   ```
   You can build and simulate while approval is pending. Deployment is a separate permission.
5. Check the actual tenant-enabled chain list and Forwarders:
   ```bash
   cre workflow supported-chains
   cre workflow supported-chains --output json
   ```
   Confirm both `ethereum-testnet-sepolia` and `ethereum-testnet-sepolia-base-1` appear in the output. Record the exact Forwarder addresses from your tenant output. Do not copy a generic address from an example into a production deployment.
6. In the repository, run `cre init` only if the `cre/` project has not already been initialized. Do not initialise a second nested CRE project accidentally.
7. Run build/simulation from the CRE project root (the directory containing `project.yaml`) and pass the workflow folder/path:
   ```bash
   cre workflow simulate ./workflows/transaction-coordinator --target <target-name>
   ```
   Use the actual target name in `project.yaml`; this placeholder is not a literal command.
8. A simulation with on-chain writes is dry-run by default. Use `--broadcast` only when intentionally testing a real testnet write and after checking keys, gas, target and contract addresses.
9. Keep `~/.cre/cre.yaml` and all private keys out of the repository. Never commit `.env`, RPC credentials, or wallet secrets.

Official references:
- CLI login: https://docs.chain.link/cre/guides/cli/cli-login
- CLI authentication: https://docs.chain.link/cre/guides/cli/managing-auth
- Supported chains / Forwarder directory: https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory
- EVM Read & Write: https://docs.chain.link/cre/capabilities/evm-read-write
- Deploy access: https://docs.chain.link/cre/guides/operations/deploy-access
- Workflow simulation: https://docs.chain.link/cre/guides/operations/simulating-workflows

**Important:** `cre update` updates an installed CLI; it does not install the CLI from scratch. Follow the official CLI installation page if the `cre` command is not found.

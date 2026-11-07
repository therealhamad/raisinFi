# RaisinFi contracts

Hardhat 3/Solidity workspace for Chain A payment decisions, Chain B asset
settlement, test ERC-20s, and local safety tests. The CRE project remains
under `../raisinFi/`.

## Local setup

Requires Node.js 22.10 or newer and npm. From this directory:

```powershell
npm install
npm run compile
npm test
npm run typecheck
```

`npm test` runs the contracts on independent Hardhat simulated chains with
the Ethereum Sepolia and Base Sepolia chain IDs. No RPC URLs or private keys
are needed for local tests.

## Testnet deployment

Copy `.env.example` to `.env` and set the testnet RPC URLs, deployer keys,
and CRE Forwarder addresses. Use testnet-only wallets and never commit `.env`.
Deploy Chain A first:

```powershell
npx hardhat run scripts/deploy-chain-a.ts --network sepolia
```

Then set `PAYMENT_CONTRACT_ADDRESS` in `.env` to the Chain A deployment and
deploy Chain B:

```powershell
npx hardhat run scripts/deploy-chain-b.ts --network baseSepolia
```

To deploy test tokens, set `TEST_TOKEN_NAME`, `TEST_TOKEN_SYMBOL`, and
`TEST_TOKEN_INITIAL_SUPPLY` (base units) in `.env`, then run:

```powershell
npx hardhat run scripts/deploy-test-token.ts --network sepolia
npx hardhat run scripts/deploy-test-token.ts --network baseSepolia
```

The scripts write deployment addresses, transaction hashes, and block
numbers under `deployments/`. Update `apps/web/.env.local` with the deployed
addresses and block numbers; token balances must be available to each
participant before locking.

## Frontend ABIs

From this directory, compile and export the contract ABIs:

```powershell
npm run export-abis
```

The generated TypeScript ABI module is written to
`../apps/web/src/generated/contract-abis.ts` and is intentionally ignored by
Git. The web workspace's `typecheck`, `dev`, and `build` scripts compile and
export ABIs automatically.

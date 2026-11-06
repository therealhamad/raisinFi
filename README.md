# RaisinFi

RaisinFi coordinates one payment reservation on Ethereum Sepolia with one
asset reservation on Base Sepolia. Chain A records the authoritative,
write-once COMMIT or ABORT decision; Chain B settles only when it receives
an authenticated CRE report. Arkiv provides optional public evidence and is
not part of settlement authority. Uniswap conversion is deferred until a
testnet liquidity spike succeeds.

## Workspaces

- [`contracts/`](contracts/README.md): Hardhat 3, Solidity contracts, local
  safety tests, deployments, and frontend ABI export.
- [`apps/web/`](apps/web/): Next.js transaction console, injected wallet,
  chain status, explorer links, and Arkiv evidence.
- [`raisinFi/`](raisinFi/README.md): CRE project.
- [`docs/CONTRACT_INTERFACES.md`](docs/CONTRACT_INTERFACES.md): proposed CRE
  report and receiver interface.

## Local development

Use Node.js 22.10 or newer and npm.

```powershell
Set-Location contracts
npm install
npm test
npm run typecheck

Set-Location ..\apps\web
npm install
Copy-Item .env.example .env.local
npm run dev
```

The local contract tests use Hardhat simulated Ethereum Sepolia and Base
Sepolia chains. The web console needs deployed contract/token addresses in
`apps/web/.env.local`; without them it will show the setup warning.

## Testnet deployments

Configure RPC URLs, deployment keys, and the CRE Forwarder addresses in
`contracts/.env`. Deploy Chain A before Chain B because the Base contract
binds to the Chain A address. Use the deployer scripts documented in
[`contracts/README.md`](contracts/README.md). Never commit `.env` files or
use a wallet holding real funds.

After deployment, set contract/token addresses and deployment block numbers
in `apps/web/.env.local`. An Arkiv access key is optional but recommended for
the Rabdi public record feature; writes also require Rabdi testnet tGLM.

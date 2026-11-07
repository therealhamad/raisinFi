import {
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  numberToHex,
  type Address,
} from "viem";
import { baseSepolia, sepolia, type Chain } from "viem/chains";
import { rabdi } from "@arkiv-network/sdk/chains";

export const arkivChain = rabdi({
  accessKey: process.env.NEXT_PUBLIC_ARKIV_ACCESS_KEY ?? "",
});

export interface InjectedProvider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on(event: "accountsChanged", listener: (accounts: string[]) => void): void;
  on(event: "chainChanged", listener: (chainId: string) => void): void;
  removeListener(event: "accountsChanged", listener: (accounts: string[]) => void): void;
  removeListener(event: "chainChanged", listener: (chainId: string) => void): void;
}

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}

export function getInjectedProvider(): InjectedProvider {
  if (!window.ethereum) throw new Error("No injected wallet was found. Install or enable a browser wallet.");
  return window.ethereum;
}

export function getSupportedChain(chainId: number): Chain {
  if (chainId === sepolia.id) return sepolia;
  if (chainId === baseSepolia.id) return baseSepolia;
  if (chainId === arkivChain.id) return arkivChain;
  throw new Error(`Unsupported chain ${chainId}; use Ethereum Sepolia or Base Sepolia`);
}

export async function readWalletState(provider: InjectedProvider) {
  const [accountsResult, chainResult] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  if (!Array.isArray(accountsResult)) throw new Error("Wallet returned an invalid accounts response");
  if (typeof chainResult !== "string") throw new Error("Wallet returned an invalid chain ID");

  const firstAccount = accountsResult[0];
  if (firstAccount !== undefined && (typeof firstAccount !== "string" || !isAddress(firstAccount))) {
    throw new Error("Wallet returned an invalid account address");
  }
  return {
    address: firstAccount ? getAddress(firstAccount) : null,
    chainId: Number(BigInt(chainResult)),
  };
}

export async function switchWalletChain(provider: InjectedProvider, chainId: number) {
  const chain = getSupportedChain(chainId);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: numberToHex(chainId) }],
    });
  } catch (error) {
    if (getWalletErrorCode(error) !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: numberToHex(chain.id),
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [...chain.rpcUrls.default.http],
        ...(chain.blockExplorers?.default.url
          ? { blockExplorerUrls: [chain.blockExplorers.default.url] }
          : {}),
      }],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: numberToHex(chainId) }],
    });
  }
}

export function createTransactionWalletClient(provider: InjectedProvider, account: Address, chainId: number) {
  const chain = getSupportedChain(chainId);
  return createWalletClient({
    account,
    chain,
    transport: custom(provider),
  });
}

function getWalletErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

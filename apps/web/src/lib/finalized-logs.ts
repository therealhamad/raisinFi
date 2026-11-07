// Ethereum Sepolia providers may limit eth_getLogs to ten inclusive blocks.
export const SEPOLIA_LOG_CHUNK_SIZE = 10n;

type FinalizedLog = {
  blockHash: string | null;
  transactionHash: string | null;
  logIndex: number | null;
  address: string;
  data: string;
  topics: readonly string[];
};

export function deduplicateFinalizedLogs<T extends FinalizedLog>(logs: readonly T[]): T[] {
  const unique: T[] = [];
  const seen = new Map<string, T>();
  for (const log of logs) {
    // Keep incomplete entries so existing receipt verification can reject them.
    if (log.blockHash === null || log.logIndex === null) {
      unique.push(log);
      continue;
    }
    const key = `${log.blockHash.toLowerCase()}:${log.logIndex}`;
    const previous = seen.get(key);
    if (previous) {
      if (
        previous.transactionHash?.toLowerCase() !== log.transactionHash?.toLowerCase() ||
        previous.address.toLowerCase() !== log.address.toLowerCase() ||
        previous.data.toLowerCase() !== log.data.toLowerCase() ||
        previous.topics.length !== log.topics.length ||
        previous.topics.some((topic, index) => topic.toLowerCase() !== log.topics[index]?.toLowerCase())
      ) {
        throw new Error("Conflicting finalized logs share the same block hash and log index");
      }
      continue;
    }
    seen.set(key, log);
    unique.push(log);
  }
  return unique;
}

export async function scanSepoliaFinalizedLogs<T extends FinalizedLog>(
  fromBlock: bigint,
  finalizedBlock: bigint,
  readChunk: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
): Promise<T[]> {
  const logs: T[] = [];
  for (let cursor = fromBlock; cursor <= finalizedBlock; cursor += SEPOLIA_LOG_CHUNK_SIZE) {
    const chunkEnd = cursor + SEPOLIA_LOG_CHUNK_SIZE - 1n < finalizedBlock
      ? cursor + SEPOLIA_LOG_CHUNK_SIZE - 1n
      : finalizedBlock;
    logs.push(...await readChunk(cursor, chunkEnd));
  }
  return deduplicateFinalizedLogs(logs);
}

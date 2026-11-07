export type UiError = {
  message: string;
  technicalMessage: string;
  name?: string;
  code?: string | number;
  transactionHash?: string;
};

const messageByCategory = {
  rejected: "Signature cancelled",
  unavailable: "Network temporarily unavailable",
  pending: "Waiting for network confirmation",
  indexing: "Updating agreement status",
  wrongNetwork: "Switch to the required network",
  expired: "Agreement expired",
  complete: "This step is already complete",
  insufficientFunds: "Insufficient balance for this transaction",
  unknown: "Something went wrong. Please try again.",
} as const;

function errorFields(error: unknown): { message: string; name?: string; code?: string | number; transactionHash?: string } {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let message = typeof error === "string" ? error : "";
  let name: string | undefined;
  let code: string | number | undefined;
  let transactionHash: string | undefined;
  for (let depth = 0; depth < 7 && current && !seen.has(current); depth += 1) {
    if (typeof current === "string") {
      message ||= current;
      break;
    }
    if (typeof current !== "object") break;
    seen.add(current);
    const value = current as Record<string, unknown>;
    if (typeof value.message === "string") message ||= value.message;
    if (typeof value.shortMessage === "string") message ||= value.shortMessage;
    if (typeof value.name === "string") name ||= value.name;
    if (typeof value.code === "string" || typeof value.code === "number") code ??= value.code;
    for (const key of ["transactionHash", "hash", "txHash"]) {
      if (typeof value[key] === "string" && /^0x[0-9a-fA-F]{64}$/.test(value[key] as string)) {
        transactionHash ||= value[key] as string;
      }
    }
    current = value.cause;
  }
  return { message: message || "Unknown error", name, code, transactionHash };
}

export type UiErrorContext = "pending" | "indexing" | "wrongNetwork";

export function mapUiError(error: unknown, context?: UiErrorContext): UiError {
  const fields = errorFields(error);
  const text = `${fields.name ?? ""} ${fields.message}`.toLowerCase();
  const code = String(fields.code ?? "").toLowerCase();
  let category: keyof typeof messageByCategory = context ?? "unknown";
  if (context) {
    // Explicit lifecycle context takes precedence over the underlying provider message.
  } else if (code === "4001" || /user rejected|user denied|request rejected|action_rejected/.test(text)) category = "rejected";
  else if (/insufficient funds|insufficient balance|exceeds balance/.test(text) || code === "insufficient_funds") category = "insufficientFunds";
  else if (/wrong chain|chain id mismatch|unsupported chain|switch.*network|select.*network/.test(text)) category = "wrongNetwork";
  else if (/expired|transactionexpired/.test(text)) category = "expired";
  else if (/already registered|already locked|already processed|already completed|already exists|decisionalreadyrecorded|paymentalreadylocked|transactionalreadyregistered/.test(text)) category = "complete";
  else if (/not found|event.*(index|found)|indexing|logs?.*not found|matching finalized/.test(text)) category = "indexing";
  else if (/timeout|timed out|pending|receipt.*not found|wait.*confirmation/.test(text)) category = "pending";
  else if (/network|rpc|provider|fetch failed|failed to fetch|http request|connection|socket|rate.?limit|econn/.test(text) || /^5\d\d$/.test(code)) category = "unavailable";
  const technicalMessage = fields.message.replace(/https?:\/\/[^\s)]+/gi, "[RPC endpoint]");
  return {
    message: messageByCategory[category],
    technicalMessage,
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.code !== undefined ? { code: fields.code } : {}),
    ...(fields.transactionHash ? { transactionHash: fields.transactionHash } : {}),
  };
}

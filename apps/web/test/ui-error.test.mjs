import assert from "node:assert/strict";
import test from "node:test";
import { mapUiError } from "../src/lib/ui-error.ts";

test("maps common wallet, RPC, contract, and lifecycle errors to concise UI messages", () => {
  const cases = [
    [{ code: 4001, message: "User rejected request" }, "Signature cancelled"],
    [new Error("Failed to fetch RPC provider"), "Network temporarily unavailable"],
    [new Error("Transaction receipt timeout"), "Waiting for network confirmation"],
    [new Error("matching finalized TransactionRegistered event was not found"), "Updating agreement status"],
    [new Error("Wrong chain ID"), "Switch to the required network"],
    [new Error("TransactionExpired"), "Agreement expired"],
    [new Error("TransactionAlreadyRegistered"), "This step is already complete"],
    [new Error("insufficient funds for gas"), "Insufficient balance for this transaction"],
    [new Error("unrecognized condition"), "Something went wrong. Please try again."],
  ];
  for (const [error, expected] of cases) assert.equal(mapUiError(error).message, expected);
  assert.equal(mapUiError(new Error("provider down"), "indexing").message, "Updating agreement status");
});

test("retains technical message, code and transaction hash in diagnostics", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const error = Object.assign(new Error(`RPC failure https://secret.example/rpc ${hash}`), { code: 4900, transactionHash: hash });
  const mapped = mapUiError(error);
  assert.equal(mapped.message, "Network temporarily unavailable");
  assert.equal(mapped.code, 4900);
  assert.equal(mapped.transactionHash, hash);
  assert.match(mapped.technicalMessage, /\[RPC endpoint\]/);
  assert.doesNotMatch(mapped.technicalMessage, /secret\.example/);
});

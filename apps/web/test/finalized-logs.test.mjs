import test from "node:test";
import assert from "node:assert/strict";
import { scanSepoliaFinalizedLogs, deduplicateFinalizedLogs } from "../src/lib/finalized-logs.ts";

const log = (index, blockHash = "0xabc") => ({
  blockHash,
  transactionHash: "0xtx",
  logIndex: index,
  address: "0xaddress",
  data: "0x01",
  topics: ["0xtopic"],
});

test("scans inclusive numeric ranges of at most ten blocks and deduplicates logs", async () => {
  const ranges = [];
  const first = log(0);
  const last = log(1, "0xdef");
  const result = await scanSepoliaFinalizedLogs(101n, 125n, async (from, to) => {
    ranges.push([from, to]);
    assert.ok(to - from + 1n <= 10n);
    if (from === 101n) return [first];
    if (from === 111n) return [{ ...first }, last];
    return [];
  });
  assert.deepEqual(ranges, [[101n, 110n], [111n, 120n], [121n, 125n]]);
  assert.deepEqual(result, [first, last]);
});

test("covers one block and skips ranges above finality", async () => {
  const ranges = [];
  const read = async (from, to) => { ranges.push([from, to]); return []; };
  await scanSepoliaFinalizedLogs(9n, 9n, read);
  await scanSepoliaFinalizedLogs(10n, 9n, read);
  assert.deepEqual(ranges, [[9n, 9n]]);
});

test("propagates chunk failures without returning partial results", async () => {
  await assert.rejects(scanSepoliaFinalizedLogs(0n, 20n, async (from) => {
    if (from === 10n) throw new Error("RPC failure");
    return [log(0)];
  }), /RPC failure/);
});

test("preserves incomplete logs and rejects conflicting duplicate identities", () => {
  const incomplete = { ...log(0), blockHash: null };
  assert.equal(deduplicateFinalizedLogs([incomplete, incomplete]).length, 2);
  assert.throws(() => deduplicateFinalizedLogs([log(0), { ...log(0), data: "0x02" }]), /Conflicting finalized logs/);
});

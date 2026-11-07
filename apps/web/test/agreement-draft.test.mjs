import assert from "node:assert/strict";
import test from "node:test";
import { buildAgreementDraft } from "../src/lib/agreement-draft.ts";
import { hashTerms } from "../src/lib/protocol.ts";

const buyer = "0xAd60D772BC548Aa250468889C4D58a7D65cAec53";
const seller = "0x9d0a5005D7d22471750E18996bDeD66B2CaFe5f3";
const paymentContract = "0x46474063C039f76111d0a393B8266E377dF7b8e8";
const assetSettlement = "0x9DbFA23d09deb3A66a7261de9E7e708A1b9bBc1A";
const paymentToken = "0x94420ff404238419452Eb8f25Ddb002e7Aa2a7e5";
const assetToken = "0x5050Badc7279A059AFC0CDb04d1a63cEFfa0CAaF";
const transactionId = `0x${"12".repeat(32)}`;

function input(overrides = {}) {
  return {
    buyerInput: buyer,
    sellerInput: seller,
    paymentChainInput: "11155111",
    assetChainInput: "84532",
    paymentTokenInput: paymentToken,
    assetTokenInput: assetToken,
    paymentAmountInput: "1000.25",
    assetAmountInput: "100.5",
    expiryMinutesInput: "15",
    paymentDecimals: 18,
    assetDecimals: 18,
    paymentContract,
    assetSettlement,
    transactionId,
    nowMs: 1_800_000_000_000,
    ...overrides,
  };
}

test("builds canonical preview Terms, preserves defaults, and hashes with protocol utility", () => {
  const draft = buildAgreementDraft(input());
  assert.equal(draft.terms.transactionId, transactionId);
  assert.equal(draft.terms.buyer, buyer);
  assert.equal(draft.terms.seller, seller);
  assert.equal(draft.terms.paymentChainId, 11155111n);
  assert.equal(draft.terms.assetChainId, 84532n);
  assert.equal(draft.terms.paymentInputAmount, 1_000_250_000_000_000_000_000n);
  assert.equal(draft.terms.assetAmount, 100_500_000_000_000_000_000n);
  assert.equal(draft.terms.expiresAt, 1_800_000_900n);
  assert.equal(draft.termsHash, hashTerms(draft.terms));
});

test("rejects unsupported settlement chains rather than previewing incompatible Terms", () => {
  assert.throws(() => buildAgreementDraft(input({ paymentChainInput: "1" })), /supports Ethereum Sepolia only/);
  assert.throws(() => buildAgreementDraft(input({ assetChainInput: "8453" })), /supports Base Sepolia only/);
});

test("validates participant addresses and distinct participants", () => {
  assert.throws(() => buildAgreementDraft(input({ sellerInput: buyer })), /different addresses/);
  assert.throws(() => buildAgreementDraft(input({ sellerInput: "not an address" })), /address/i);
});

test("validates positive amounts, precision, and expiry limits", () => {
  assert.throws(() => buildAgreementDraft(input({ paymentAmountInput: "0" })), /greater than zero/);
  assert.throws(() => buildAgreementDraft(input({ paymentAmountInput: "1.001", paymentDecimals: 2 })), /exceeds the token's 2 decimals/);
  assert.throws(() => buildAgreementDraft(input({ expiryMinutesInput: "1441" })), /1 and 1440/);
});

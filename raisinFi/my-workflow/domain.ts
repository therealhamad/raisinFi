/** Pure validation and decision logic shared by CRE callbacks. */

export type Decision = "UNDECIDED" | "COMMIT" | "ABORT";
export type ReservationStatus = "NONE" | "LOCKED" | "EXECUTED" | "RELEASED";

export interface TriggerEnvelope {
  chainId: string;
  emittingContract: string;
  transactionId: string;
  termsHash: string;
}

export interface ExpectedTerms {
  transactionId: string;
  termsHash: string;
  buyer: string;
  seller: string;
  paymentChainId: string;
  paymentContract: string;
  paymentToken: string;
  paymentAmount: string;
  paymentObligationId: string;
  assetChainId: string;
  assetContract: string;
  assetToken: string;
  assetAmount: string;
  assetObligationId: string;
  expiresAt: string;
}

export interface PaymentReservation {
  transactionId: string;
  termsHash: string;
  buyer: string;
  seller: string;
  chainId: string;
  contract: string;
  token: string;
  amount: string;
  obligationId: string;
  expiresAt: string;
  status: ReservationStatus;
}

export interface AssetReservation {
  transactionId: string;
  termsHash: string;
  buyer: string;
  seller: string;
  chainId: string;
  contract: string;
  token: string;
  amount: string;
  obligationId: string;
  expiresAt: string;
  status: ReservationStatus;
}

export type Readiness =
  | { action: "WAIT_FOR_RESERVATIONS"; reason: string }
  | { action: "WAIT_FOR_CHAIN_A_ABORT"; reason: string }
  | { action: "DECISION_ALREADY_RECORDED"; decision: Decision }
  | { action: "SUBMIT_COMMIT" }
  | { action: "REJECT"; reason: string };

export interface AuthoritativeDecision {
  decision: Decision;
  transactionId: string;
  termsHash: string;
  paymentObligationId: string;
  assetObligationId: string;
  sourceChainId: string;
  sourceContract: string;
  destinationChainId: string;
  destinationContract: string;
  recordId: string;
}

export type DecisionBinding = Pick<
	ExpectedTerms,
	'transactionId' | 'termsHash' | 'paymentChainId' | 'paymentContract'
>

export type DecisionSnapshot = Pick<AuthoritativeDecision, "decision" | "transactionId" | "termsHash">;

export type RelayAction =
  | { action: "WAIT_FOR_DECISION" }
  | { action: "RELAY_COMMIT"; decision: AuthoritativeDecision }
  | { action: "RELAY_ABORT"; decision: AuthoritativeDecision }
  | { action: "REJECT"; reason: string };

const normalizeAddress = (value: string): string => value.toLowerCase();
const normalizeHex = (value: string): string => value.toLowerCase();

function isBytes32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isUnsignedInteger(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

/** Validate the trigger identity before using its event fields for reads. */
export function validateLockTrigger(
  trigger: TriggerEnvelope,
  expectedChainId: string,
  expectedEmitter: string,
  expectedTerms: Pick<ExpectedTerms, "transactionId" | "termsHash">,
): { valid: true } | { valid: false; reason: string } {
  if (!isBytes32(trigger.transactionId) || !isBytes32(trigger.termsHash)) {
    return { valid: false, reason: "Trigger identifiers must be bytes32 values" };
  }
  if (!isAddress(trigger.emittingContract) || !isAddress(expectedEmitter)) {
    return { valid: false, reason: "Trigger emitter must be an EVM address" };
  }
  if (trigger.chainId !== expectedChainId) {
    return { valid: false, reason: "Trigger came from an unexpected chain" };
  }
  if (normalizeAddress(trigger.emittingContract) !== normalizeAddress(expectedEmitter)) {
    return { valid: false, reason: "Trigger came from an unexpected contract" };
  }
  if (
    normalizeHex(trigger.transactionId) !== normalizeHex(expectedTerms.transactionId) ||
    normalizeHex(trigger.termsHash) !== normalizeHex(expectedTerms.termsHash)
  ) {
    return { valid: false, reason: "Trigger transaction binding does not match configured terms" };
  }
  return { valid: true };
}

function matchesTerms(
  payment: PaymentReservation,
  asset: AssetReservation,
  terms: ExpectedTerms,
): boolean {
  return (
    normalizeHex(payment.transactionId) === normalizeHex(terms.transactionId) &&
    normalizeHex(asset.transactionId) === normalizeHex(terms.transactionId) &&
    normalizeHex(payment.termsHash) === normalizeHex(terms.termsHash) &&
    normalizeHex(asset.termsHash) === normalizeHex(terms.termsHash) &&
    normalizeAddress(payment.buyer) === normalizeAddress(terms.buyer) &&
    normalizeAddress(asset.buyer) === normalizeAddress(terms.buyer) &&
    normalizeAddress(payment.seller) === normalizeAddress(terms.seller) &&
    normalizeAddress(asset.seller) === normalizeAddress(terms.seller) &&
    payment.chainId === terms.paymentChainId &&
    asset.chainId === terms.assetChainId &&
    normalizeAddress(payment.contract) === normalizeAddress(terms.paymentContract) &&
    normalizeAddress(asset.contract) === normalizeAddress(terms.assetContract) &&
    normalizeAddress(payment.token) === normalizeAddress(terms.paymentToken) &&
    normalizeAddress(asset.token) === normalizeAddress(terms.assetToken) &&
    payment.amount === terms.paymentAmount &&
    asset.amount === terms.assetAmount &&
    normalizeHex(payment.obligationId) === normalizeHex(terms.paymentObligationId) &&
    normalizeHex(asset.obligationId) === normalizeHex(terms.assetObligationId) &&
    payment.expiresAt === terms.expiresAt &&
    asset.expiresAt === terms.expiresAt
  );
}

/**
 * Decide whether Workflow A may request COMMIT. It never creates ABORT;
 * expiry only allows an external permissionless Chain A abort to be recorded.
 */
export function evaluateReservationReadiness(
  payment: PaymentReservation | null,
  asset: AssetReservation | null,
  terms: ExpectedTerms,
  nowSeconds: string,
  authoritativeDecision: DecisionSnapshot,
): Readiness {
  if (!isBytes32(terms.transactionId) || !isBytes32(terms.termsHash)) {
    return { action: "REJECT", reason: "Configured transaction identifiers are malformed" };
  }
  if (!isUnsignedInteger(nowSeconds) || !isUnsignedInteger(terms.expiresAt)) {
    return { action: "REJECT", reason: "Time values must be unsigned integer seconds" };
  }
  if (authoritativeDecision.decision !== "UNDECIDED") {
    if (
      normalizeHex(authoritativeDecision.transactionId) !== normalizeHex(terms.transactionId) ||
      normalizeHex(authoritativeDecision.termsHash) !== normalizeHex(terms.termsHash)
    ) {
      return { action: "REJECT", reason: "Existing Chain A decision is bound to different transaction terms" };
    }
    return { action: "DECISION_ALREADY_RECORDED", decision: authoritativeDecision.decision };
  }
  if (BigInt(nowSeconds) >= BigInt(terms.expiresAt)) {
    return {
      action: "WAIT_FOR_CHAIN_A_ABORT",
      reason: "Expired undecided transactions require Chain A's permissionless abort",
    };
  }
  if (!payment || !asset || payment.status === "NONE" || asset.status === "NONE") {
    return { action: "WAIT_FOR_RESERVATIONS", reason: "Both reservations are required" };
  }
  if (!matchesTerms(payment, asset, terms)) {
    return { action: "REJECT", reason: "Reservations do not match the agreed transaction terms" };
  }
  if (payment.status !== "LOCKED" || asset.status !== "LOCKED") {
    return { action: "REJECT", reason: "Both reservations must still be locked" };
  }
  return { action: "SUBMIT_COMMIT" };
}

/** Only relay a decision read from the authoritative Chain A contract. */
export function evaluateDecisionRelay(
  decision: AuthoritativeDecision,
	terms: DecisionBinding,
  destinationChainId: string,
  destinationContract: string,
): RelayAction {
  if (decision.decision === "UNDECIDED") return { action: "WAIT_FOR_DECISION" };
  if (!decision.recordId) return { action: "REJECT", reason: "Decision record reference is missing" };
  if (
    normalizeHex(decision.transactionId) !== normalizeHex(terms.transactionId) ||
    normalizeHex(decision.termsHash) !== normalizeHex(terms.termsHash) ||
    decision.sourceChainId !== terms.paymentChainId ||
    normalizeAddress(decision.sourceContract) !== normalizeAddress(terms.paymentContract) ||
    decision.destinationChainId !== destinationChainId ||
    normalizeAddress(decision.destinationContract) !== normalizeAddress(destinationContract)
  ) {
    return { action: "REJECT", reason: "Authoritative decision is bound to a different transaction or destination" };
  }
  return decision.decision === "COMMIT"
    ? { action: "RELAY_COMMIT", decision }
    : { action: "RELAY_ABORT", decision };
}

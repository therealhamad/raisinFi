import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem'

export interface CoordinationReport {
	transactionId: Hex
	termsHash: Hex
	paymentChainId: bigint
	paymentContract: Address
	assetChainId: bigint
	assetSettlement: Address
	buyer: Address
	seller: Address
	paymentInputToken: Address
	paymentInputAmount: bigint
	paymentToken: Address
	paymentAmount: bigint
	assetToken: Address
	assetAmount: bigint
	expiresAt: bigint
	paymentLocked: boolean
	assetLocked: boolean
}

export interface DecisionRelayReport {
	transactionId: Hex
	termsHash: Hex
	decision: 1 | 2
	sourceChainId: bigint
	sourceContract: Address
	destinationChainId: bigint
	destinationContract: Address
	assetObligationId: Hex
	decisionRecordId: Hex
	decisionNonce: bigint
	sourceDecisionBlockNumber: bigint
	buyer: Address
	seller: Address
	assetToken: Address
	assetAmount: bigint
	expiresAt: bigint
}

// ProtocolTypes.CoordinationReport is an internal struct, so it is not exposed
// as an ABI component by the public onReport(bytes,bytes) function. Keep this
// tuple in the same field order and verify it by calling the compiled receiver.
const COORDINATION_REPORT_PARAMETERS = parseAbiParameters(
	'(bytes32 transactionId, bytes32 termsHash, uint256 paymentChainId, address paymentContract, uint256 assetChainId, address assetSettlement, address buyer, address seller, address paymentInputToken, uint256 paymentInputAmount, address paymentToken, uint256 paymentAmount, address assetToken, uint256 assetAmount, uint256 expiresAt, bool paymentLocked, bool assetLocked)',
)

const DECISION_RELAY_REPORT_PARAMETERS = parseAbiParameters(
	'(bytes32 transactionId, bytes32 termsHash, uint8 decision, uint256 sourceChainId, address sourceContract, uint256 destinationChainId, address destinationContract, bytes32 assetObligationId, bytes32 decisionRecordId, uint64 decisionNonce, uint256 sourceDecisionBlockNumber, address buyer, address seller, address assetToken, uint256 assetAmount, uint256 expiresAt)',
)

export function encodeCoordinationReport(report: CoordinationReport): Hex {
	return encodeAbiParameters(COORDINATION_REPORT_PARAMETERS, [report])
}

export function encodeDecisionRelayReport(report: DecisionRelayReport): Hex {
	return encodeAbiParameters(DECISION_RELAY_REPORT_PARAMETERS, [report])
}

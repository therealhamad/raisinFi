import { decodeFunctionResult, type Address, type Hex } from 'viem'
import { assetSettlementAbi, decisionPaymentSettlementAbi } from './contract-abis.js'

export interface ProtocolTerms {
	transactionId: Hex
	buyer: Address
	seller: Address
	paymentChainId: bigint
	paymentContract: Address
	paymentInputToken: Address
	paymentInputAmount: bigint
	paymentToken: Address
	paymentAmount: bigint
	amountOutMin: bigint
	assetChainId: bigint
	assetSettlement: Address
	assetToken: Address
	assetAmount: bigint
	expiresAt: bigint
	schemaVersion: number
}

export function decodePaymentTransaction(data: Hex) {
	const [terms, termsHash, decision, paymentStatus] = decodeFunctionResult({
		abi: decisionPaymentSettlementAbi,
		functionName: 'getTransaction',
		data,
	})
	return {
		terms: terms as unknown as ProtocolTerms,
		termsHash,
		decision: Number(decision),
		paymentStatus: Number(paymentStatus),
	}
}

export function decodeAssetReservation(data: Hex) {
	const [terms, termsHash, status, decision, decisionRecordId, decisionNonce] = decodeFunctionResult({
		abi: assetSettlementAbi,
		functionName: 'getAssetReservation',
		data,
	})
	return {
		terms: terms as unknown as ProtocolTerms,
		termsHash,
		status: Number(status),
		decision: Number(decision),
		decisionRecordId,
		decisionNonce,
	}
}

export function decodeChainADecision(data: Hex, transactionId: Hex) {
	const [decision, termsHash, sourceChainId, sourceContract, recordId, nonce, decisionBlockNumber] =
		decodeFunctionResult({
			abi: decisionPaymentSettlementAbi,
			functionName: 'getDecision',
			data,
		})
	return {
		transactionId,
		decision: Number(decision),
		termsHash,
		sourceChainId,
		sourceContract,
		recordId,
		nonce,
		decisionBlockNumber,
	}
}

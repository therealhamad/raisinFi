import { describe, expect, test } from 'bun:test'
import { evaluateReservationReadiness, planDecisionRelay } from '../domain'
import { selectSubmissionPath } from '../execution-policy'
import { configSchema } from '../workflow'

const id = `0x${'11'.repeat(32)}`
const termsHash = `0x${'22'.repeat(32)}`
const recordId = `0x${'33'.repeat(32)}`
const buyer = '0x1111111111111111111111111111111111111111'
const seller = '0x2222222222222222222222222222222222222222'
const paymentContract = '0x3333333333333333333333333333333333333333'
const assetContract = '0x4444444444444444444444444444444444444444'
const token = '0x5555555555555555555555555555555555555555'
const obligationId = `0x${'66'.repeat(32)}`

const terms = {
	transactionId: id,
	termsHash,
	buyer,
	seller,
	paymentChainId: '11155111',
	paymentContract,
	paymentToken: token,
	paymentAmount: '100',
	assetChainId: '84532',
	assetContract,
	assetToken: token,
	assetAmount: '1',
	assetObligationId: obligationId,
	expiresAt: '2000000000',
}
const payment = {
	transactionId: id,
	termsHash,
	buyer,
	seller,
	chainId: '11155111',
	contract: paymentContract,
	token,
	amount: '100',
	expiresAt: '2000000000',
	status: 'LOCKED' as const,
}
const asset = {
	transactionId: id,
	termsHash,
	buyer,
	seller,
	chainId: '84532',
	contract: assetContract,
	token,
	amount: '1',
	obligationId,
	expiresAt: '2000000000',
	status: 'LOCKED' as const,
	decision: 'UNDECIDED' as const,
	decisionRecordId: `0x${'00'.repeat(32)}`,
	decisionNonce: '0',
}
const sourceDecision = {
	decision: 'COMMIT' as const,
	transactionId: id,
	termsHash,
	decisionNonce: '1',
	sourceDecisionBlockNumber: '123',
	sourceChainId: '11155111',
	sourceContract: paymentContract,
	destinationChainId: '84532',
	destinationContract: assetContract,
	recordId,
}

const baseConfig = {
	executionMode: 'local-simulation',
	paymentContractAddress: paymentContract,
	assetContractAddress: assetContract,
	paymentTokenAddress: token,
	assetTokenAddress: token,
	paymentDeploymentBlock: 1,
	assetDeploymentBlock: 2,
	paymentForwarderAddress: '0x15fC6ae953E024d975e77382eEeC56A9101f9F88',
	assetForwarderAddress: '0x82300bd7c3958625581cc2f77bc6464dcecdf3e5',
	localBroadcastEnabled: false,
	productionWritesEnabled: false,
}

describe('execution mode safety and reconciliation', () => {
	test('local simulation cannot select the production CRE write path', () => {
		expect(selectSubmissionPath({ executionMode: 'local-simulation', allowLocalBroadcast: false, enableProductionWrites: false })).toBe('disabled')
		expect(selectSubmissionPath({ executionMode: 'local-simulation', allowLocalBroadcast: true, enableProductionWrites: false })).toBe('local-mock-forwarder')
		expect(() => selectSubmissionPath({ executionMode: 'local-simulation', allowLocalBroadcast: true, enableProductionWrites: true })).toThrow()
	})

	test('production mode cannot select the local test adapter', () => {
		expect(selectSubmissionPath({ executionMode: 'production-cre', allowLocalBroadcast: false, enableProductionWrites: false })).toBe('disabled')
		expect(selectSubmissionPath({ executionMode: 'production-cre', allowLocalBroadcast: false, enableProductionWrites: true })).toBe('production-cre-forwarder')
		expect(() => selectSubmissionPath({ executionMode: 'production-cre', allowLocalBroadcast: true, enableProductionWrites: false })).toThrow()
	})

	test('configuration rejects missing/zero addresses and unsafe mode mixing', () => {
		expect(configSchema.safeParse(baseConfig).success).toBe(true)
		expect(configSchema.safeParse({ ...baseConfig, assetContractAddress: '0x0000000000000000000000000000000000000000' }).success).toBe(false)
		expect(configSchema.safeParse({ ...baseConfig, paymentForwarderAddress: '0xF8344CFd5c43616a4366C34E3EEE75af79a74482' }).success).toBe(false)
		expect(configSchema.safeParse({ ...baseConfig, productionWritesEnabled: true }).success).toBe(false)

		const productionConfig = {
			...baseConfig,
			executionMode: 'production-cre' as const,
			paymentForwarderAddress: '0xF8344CFd5c43616a4366C34E3EEE75af79a74482',
			assetForwarderAddress: '0xF8344CFd5c43616a4366C34E3EEE75af79a74482',
			reconciliationAuthorizedAddress: buyer,
		}
		expect(configSchema.safeParse(productionConfig).success).toBe(true)
		expect(configSchema.safeParse({ ...productionConfig, reconciliationAuthorizedAddress: undefined }).success).toBe(false)
		expect(configSchema.safeParse({ ...productionConfig, reconciliationAuthorizedAddress: '0x0000000000000000000000000000000000000000' }).success).toBe(false)
	})

	test('a repeated manual reconciliation can recover an eligible COMMIT after a missed lock event', () => {
		expect(evaluateReservationReadiness(payment, asset, terms, '1900000000', {
			decision: 'UNDECIDED', transactionId: id, termsHash,
		})).toEqual({ action: 'SUBMIT_COMMIT' })
		expect(evaluateReservationReadiness(payment, asset, terms, '2100000000', {
			decision: 'UNDECIDED', transactionId: id, termsHash,
		})).toMatchObject({ action: 'WAIT_FOR_CHAIN_A_ABORT' })
	})

	test('failed relay retries the same immutable source decision; applied destination skips', () => {
		const binding = { transactionId: id, termsHash, paymentChainId: '11155111', paymentContract }
		const failedRelayState = { ...asset, status: 'LOCKED' as const }
		const first = planDecisionRelay(sourceDecision, binding, '84532', assetContract, failedRelayState)
		const retry = planDecisionRelay(sourceDecision, binding, '84532', assetContract, failedRelayState)
		expect(first).toEqual(retry)
		expect(retry).toMatchObject({ action: 'RELAY_COMMIT' })

		const applied = { ...asset, status: 'EXECUTED' as const, decision: 'COMMIT' as const, decisionRecordId: recordId }
		expect(planDecisionRelay(sourceDecision, binding, '84532', assetContract, applied)).toMatchObject({ action: 'RELAY_ALREADY_APPLIED' })
		const conflicting = { ...applied, decision: 'ABORT' as const }
		expect(planDecisionRelay(sourceDecision, binding, '84532', assetContract, conflicting)).toMatchObject({ action: 'REJECT' })
	})
})

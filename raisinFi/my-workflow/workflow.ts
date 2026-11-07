import {
	bytesToHex,
	cre,
	decodeJson,
	encodeCallMsg,
	getNetwork,
	LAST_FINALIZED_BLOCK_NUMBER,
	logTriggerConfig,
	protoBigIntToBigint,
	type EVMLog,
	type HTTPPayload,
	type Runtime,
} from '@chainlink/cre-sdk'
import {
	decodeEventLog,
	decodeFunctionResult,
	encodeFunctionData,
	getAbiItem,
	toEventSelector,
	type Address,
	type Hex,
	zeroAddress,
} from 'viem'
import { z } from 'zod'
import {
	evaluateDecisionRelay,
	evaluateReservationReadiness,
	planDecisionRelay,
	type AssetReservation,
	type Decision,
	type ExpectedTerms,
	type PaymentReservation,
	type ReservationStatus,
} from './domain'
import { writeCreReport } from './report-write'
import { assetSettlementAbi, decisionPaymentSettlementAbi } from './contract-abis'
import {
	decodeAssetReservation,
	decodeChainADecision,
	decodePaymentTransaction,
	type ProtocolTerms,
} from './contract-codec'
import { encodeCoordinationReport, encodeDecisionRelayReport } from './report-encoding'
import { selectSubmissionPath } from './execution-policy'

const PAYMENT_LOCKED_ABI = [getAbiItem({ abi: decisionPaymentSettlementAbi, name: 'PaymentLocked' })] as const
const ASSET_LOCKED_ABI = [getAbiItem({ abi: assetSettlementAbi, name: 'AssetLocked' })] as const
const DECISION_RECORDED_ABI = [getAbiItem({ abi: decisionPaymentSettlementAbi, name: 'DecisionRecorded' })] as const
const PAYMENT_LOCKED_TOPIC = toEventSelector(PAYMENT_LOCKED_ABI[0])
const ASSET_LOCKED_TOPIC = toEventSelector(ASSET_LOCKED_ABI[0])
const DECISION_RECORDED_TOPIC = toEventSelector(DECISION_RECORDED_ABI[0])
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`
const PAYMENT_CHAIN_ID = '11155111'
const ASSET_CHAIN_ID = '84532'
const PRODUCTION_FORWARDER = '0xF8344CFd5c43616a4366C34E3EEE75af79a74482'
const PAYMENT_MOCK_FORWARDER = '0x15fC6ae953E024d975e77382eEeC56A9101f9F88'
const ASSET_MOCK_FORWARDER = '0x82300bd7c3958625581cc2f77bc6464dcecdf3e5'

const contractAddressSchema = z
	.string()
	.regex(ADDRESS_PATTERN)
	.refine((address) => address.toLowerCase() !== ZERO_ADDRESS, 'Settlement contract address is not configured')

export const configSchema = z.object({
	executionMode: z.enum(['local-simulation', 'production-cre']),
	paymentContractAddress: contractAddressSchema,
	assetContractAddress: contractAddressSchema,
	paymentTokenAddress: contractAddressSchema,
	assetTokenAddress: contractAddressSchema,
	paymentDeploymentBlock: z.number().int().nonnegative(),
	assetDeploymentBlock: z.number().int().nonnegative(),
	paymentForwarderAddress: contractAddressSchema,
	assetForwarderAddress: contractAddressSchema,
	localSubmitterAddress: contractAddressSchema.optional(),
	reconciliationAuthorizedAddress: contractAddressSchema.optional(),
	localBroadcastEnabled: z.boolean().default(false),
	productionWritesEnabled: z.boolean().default(false),
}).superRefine((config, ctx) => {
	const expectedPaymentForwarder = config.executionMode === 'local-simulation' ? PAYMENT_MOCK_FORWARDER : PRODUCTION_FORWARDER
	const expectedAssetForwarder = config.executionMode === 'local-simulation' ? ASSET_MOCK_FORWARDER : PRODUCTION_FORWARDER
	if (config.paymentForwarderAddress.toLowerCase() !== expectedPaymentForwarder.toLowerCase()) {
		ctx.addIssue({ code: 'custom', path: ['paymentForwarderAddress'], message: `Must be ${expectedPaymentForwarder} for ${config.executionMode}` })
	}
	if (config.assetForwarderAddress.toLowerCase() !== expectedAssetForwarder.toLowerCase()) {
		ctx.addIssue({ code: 'custom', path: ['assetForwarderAddress'], message: `Must be ${expectedAssetForwarder} for ${config.executionMode}` })
	}
	if (config.executionMode === 'local-simulation' && config.productionWritesEnabled) {
		ctx.addIssue({ code: 'custom', path: ['productionWritesEnabled'], message: 'Production writes cannot be enabled in local-simulation mode' })
	}
	if (config.executionMode === 'production-cre' && (config.localBroadcastEnabled || config.localSubmitterAddress)) {
		ctx.addIssue({ code: 'custom', path: ['localBroadcastEnabled'], message: 'Local test broadcast settings are unavailable in production-cre mode' })
	}
	if (config.executionMode === 'production-cre' && !config.reconciliationAuthorizedAddress) {
		ctx.addIssue({ code: 'custom', path: ['reconciliationAuthorizedAddress'], message: 'Production reconciliation requires an authorized EVM address' })
	}
	if (config.localBroadcastEnabled && !config.localSubmitterAddress) {
		ctx.addIssue({ code: 'custom', path: ['localSubmitterAddress'], message: 'Set the public address derived from CRE_ETH_PRIVATE_KEY before enabling test broadcast' })
	}
})

type Config = z.infer<typeof configSchema>

type LockEventName = 'PaymentLocked' | 'AssetLocked'

const getEvmClient = (chainName: string) => {
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: chainName,
		isTestnet: true,
	})
	if (!network) throw new Error(`CRE network is unavailable: ${chainName}`)

	return {
		client: new cre.capabilities.EVMClient(network.chainSelector.selector),
		chainSelector: network.chainSelector.selector.toString(),
	}
}

const decodeReservationStatus = (statusCode: bigint | number): ReservationStatus => {
	switch (BigInt(statusCode)) {
		case 0n:
			return 'NONE'
		case 1n:
			return 'LOCKED'
		case 2n:
			return 'EXECUTED'
		case 3n:
			return 'RELEASED'
		default:
			throw new Error(`Unknown reservation status code: ${statusCode}`)
	}
}

const decodeDecision = (decisionCode: bigint | number): Decision => {
	switch (BigInt(decisionCode)) {
		case 0n:
			return 'UNDECIDED'
		case 1n:
			return 'COMMIT'
		case 2n:
			return 'ABORT'
		default:
			throw new Error(`Unknown decision code: ${decisionCode}`)
	}
}

const sameProtocolTerms = (left: ProtocolTerms, right: ProtocolTerms): boolean =>
	left.transactionId.toLowerCase() === right.transactionId.toLowerCase() &&
	left.buyer.toLowerCase() === right.buyer.toLowerCase() &&
	left.seller.toLowerCase() === right.seller.toLowerCase() &&
	left.paymentChainId === right.paymentChainId &&
	left.paymentContract.toLowerCase() === right.paymentContract.toLowerCase() &&
	left.paymentInputToken.toLowerCase() === right.paymentInputToken.toLowerCase() &&
	left.paymentInputAmount === right.paymentInputAmount &&
	left.paymentToken.toLowerCase() === right.paymentToken.toLowerCase() &&
	left.paymentAmount === right.paymentAmount &&
	left.amountOutMin === right.amountOutMin &&
	left.assetChainId === right.assetChainId &&
	left.assetSettlement.toLowerCase() === right.assetSettlement.toLowerCase() &&
	left.assetToken.toLowerCase() === right.assetToken.toLowerCase() &&
	left.assetAmount === right.assetAmount &&
	left.expiresAt === right.expiresAt &&
	left.schemaVersion === right.schemaVersion

const assertReceiverForwarder = (runtime: Runtime<Config>, chainName: string, receiver: Address, expected: Address): void => {
	const isPaymentChain = chainName === 'ethereum-testnet-sepolia'
	const abi = isPaymentChain ? decisionPaymentSettlementAbi : assetSettlementAbi
	const { client } = getEvmClient(chainName)
	const response = client.callContract(runtime, {
		call: encodeCallMsg({
			from: zeroAddress,
			to: receiver,
			data: encodeFunctionData({ abi, functionName: 'trustedForwarder' }),
		}),
	}).result()
	const actual = decodeFunctionResult({
		abi,
		functionName: 'trustedForwarder',
		data: bytesToHex(response.data),
	})
	if (actual.toLowerCase() !== expected.toLowerCase()) {
		throw new Error(`Receiver ${receiver} trusts ${actual}, expected ${expected} for ${runtime.config.executionMode}`)
	}
}

const verifyCommitAfterWrite = (runtime: Runtime<Config>, transactionId: Hex, termsHash: Hex): void => {
	const paymentRead = readPaymentReservation(runtime, transactionId, false)
	const assetRead = readAssetReservation(runtime, transactionId, false)
	const decision = readAuthoritativeDecision(runtime, transactionId, false)
	if (decision.decision !== 'COMMIT' || decision.termsHash.toLowerCase() !== termsHash.toLowerCase() || paymentRead.reservation.status !== 'EXECUTED') {
		throw new Error('Chain A latest state does not verify the COMMIT report and payment execution')
	}
	if (assetRead.reservation.status !== 'LOCKED' &&
		(assetRead.reservation.decision !== 'COMMIT' || assetRead.reservation.decisionRecordId.toLowerCase() !== decision.recordId.toLowerCase())) {
		throw new Error('Chain B latest state is neither pending nor consistent with the source COMMIT')
	}
	runtime.log(`Independent post-COMMIT verification | sourceDecision=${decision.decision} | paymentStatus=${paymentRead.reservation.status} | assetStatus=${assetRead.reservation.status} | sourceFinality=not-yet-reconfirmed`)
}

const verifyRelayAfterWrite = (runtime: Runtime<Config>, transactionId: Hex, expectedDecision: Decision, expectedRecordId: Hex): void => {
	const source = readAuthoritativeDecision(runtime, transactionId, false)
	const payment = readPaymentReservation(runtime, transactionId, false).reservation
	const destination = readAssetReservation(runtime, transactionId, false).reservation
	const expectedStatus = expectedDecision === 'COMMIT' ? 'EXECUTED' : 'RELEASED'
	if (source.decision !== expectedDecision || source.recordId.toLowerCase() !== expectedRecordId.toLowerCase() || source.termsHash.toLowerCase() !== payment.termsHash.toLowerCase()) {
		throw new Error('Chain A source decision/reservation does not verify during destination relay')
	}
	if (expectedDecision === 'COMMIT' && payment.status !== 'EXECUTED') {
		throw new Error('Chain A payment was not executed for the relayed COMMIT')
	}
	if (expectedDecision === 'ABORT' && payment.status !== 'RELEASED' && payment.status !== 'NONE') {
		throw new Error('Chain A payment state is inconsistent with the relayed ABORT')
	}
	if (destination.status !== expectedStatus || destination.decision !== expectedDecision || destination.decisionRecordId.toLowerCase() !== expectedRecordId.toLowerCase()) {
		throw new Error('Chain B latest state does not verify the relayed decision record')
	}
	runtime.log(`Independent post-relay verification | sourceDecision=${source.decision} | sourceRecord=${source.recordId} | destinationStatus=${destination.status} | destinationRecord=${destination.decisionRecordId} | finality=not-yet-reconfirmed`)
}

const readPaymentReservation = (
	runtime: Runtime<Config>,
	transactionId: Hex,
	finalized = true,
): { terms: ProtocolTerms; reservation: PaymentReservation } => {
	const { client } = getEvmClient('ethereum-testnet-sepolia')
	const callData = encodeFunctionData({
		abi: decisionPaymentSettlementAbi,
		functionName: 'getTransaction',
		args: [transactionId],
	})
	const response = client
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: runtime.config.paymentContractAddress as Address,
				data: callData,
			}),
			...(finalized ? { blockNumber: LAST_FINALIZED_BLOCK_NUMBER } : {}),
		})
		.result()
	const decoded = decodePaymentTransaction(bytesToHex(response.data))
	return {
		terms: decoded.terms,
		reservation: {
			transactionId: decoded.terms.transactionId,
			termsHash: decoded.termsHash,
			buyer: decoded.terms.buyer,
			seller: decoded.terms.seller,
			chainId: PAYMENT_CHAIN_ID,
			contract: runtime.config.paymentContractAddress,
			token: decoded.terms.paymentToken,
			amount: decoded.terms.paymentAmount.toString(),
			expiresAt: decoded.terms.expiresAt.toString(),
			status: decodeReservationStatus(decoded.paymentStatus),
		},
	}
}

const readAssetReservation = (
	runtime: Runtime<Config>,
	transactionId: Hex,
	finalized = true,
): { terms: ProtocolTerms; reservation: AssetReservation } => {
	const { client } = getEvmClient('ethereum-testnet-sepolia-base-1')
	const callData = encodeFunctionData({
		abi: assetSettlementAbi,
		functionName: 'getAssetReservation',
		args: [transactionId],
	})
	const response = client
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: runtime.config.assetContractAddress as Address,
				data: callData,
			}),
			...(finalized ? { blockNumber: LAST_FINALIZED_BLOCK_NUMBER } : {}),
		})
		.result()
	const decoded = decodeAssetReservation(bytesToHex(response.data))
	const obligationCallData = encodeFunctionData({
		abi: assetSettlementAbi,
		functionName: 'computeAssetObligationId',
		args: [decoded.terms],
	})
	const obligationResponse = client
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: runtime.config.assetContractAddress as Address,
				data: obligationCallData,
			}),
			...(finalized ? { blockNumber: LAST_FINALIZED_BLOCK_NUMBER } : {}),
		})
		.result()
	const [obligationId] = decodeFunctionResult({
		abi: assetSettlementAbi,
		functionName: 'computeAssetObligationId',
		data: bytesToHex(obligationResponse.data),
	})
	return {
		terms: decoded.terms,
		reservation: {
			transactionId: decoded.terms.transactionId,
			termsHash: decoded.termsHash,
			buyer: decoded.terms.buyer,
			seller: decoded.terms.seller,
			chainId: ASSET_CHAIN_ID,
			contract: runtime.config.assetContractAddress,
			token: decoded.terms.assetToken,
			amount: decoded.terms.assetAmount.toString(),
			obligationId,
			expiresAt: decoded.terms.expiresAt.toString(),
			status: decodeReservationStatus(decoded.status),
			decision: decodeDecision(decoded.decision),
			decisionRecordId: decoded.decisionRecordId,
			decisionNonce: decoded.decisionNonce.toString(),
		},
	}
}

const readAuthoritativeDecision = (
	runtime: Runtime<Config>,
	transactionId: Hex,
	finalized = true,
) => {
	const { client } = getEvmClient('ethereum-testnet-sepolia')
	const callData = encodeFunctionData({
		abi: decisionPaymentSettlementAbi,
		functionName: 'getDecision',
		args: [transactionId],
	})
	const response = client
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: runtime.config.paymentContractAddress as Address,
				data: callData,
			}),
			...(finalized ? { blockNumber: LAST_FINALIZED_BLOCK_NUMBER } : {}),
		})
		.result()
	const decoded = decodeChainADecision(bytesToHex(response.data), transactionId)
	return {
		decision: decodeDecision(decoded.decision),
		transactionId: decoded.transactionId,
		termsHash: decoded.termsHash,
		sourceChainId: decoded.sourceChainId.toString(),
		sourceContract: decoded.sourceContract,
		destinationChainId: ASSET_CHAIN_ID,
		destinationContract: runtime.config.assetContractAddress,
		recordId: decoded.recordId,
		decisionNonce: decoded.nonce.toString(),
		sourceDecisionBlockNumber: decoded.decisionBlockNumber.toString(),
	}
}

const evaluateLockState = (
	runtime: Runtime<Config>,
	transactionId: Hex,
	termsHash: Hex,
	eventName?: LockEventName,
	eventParticipant?: Address,
	eventAmount?: bigint,
	sourceBlockNumber?: string,
): string => {
	const paymentRead = readPaymentReservation(runtime, transactionId)
	const assetRead = readAssetReservation(runtime, transactionId)
	const payment = paymentRead.reservation
	const asset = assetRead.reservation
	const decision = readAuthoritativeDecision(runtime, transactionId)
	if (
		paymentRead.terms.transactionId.toLowerCase() !== transactionId.toLowerCase() ||
		payment.termsHash.toLowerCase() !== termsHash.toLowerCase()
	) {
		runtime.log('Lock event transaction binding does not match Chain A registered terms')
		return 'REJECT'
	}
	if (eventName && eventParticipant && eventAmount !== undefined) {
		const expectedParticipant = eventName === 'PaymentLocked'
			? paymentRead.terms.buyer
			: assetRead.terms.seller
		const expectedAmount = eventName === 'PaymentLocked'
			? paymentRead.terms.paymentInputAmount
			: assetRead.terms.assetAmount
		if (
			eventParticipant.toLowerCase() !== expectedParticipant.toLowerCase() ||
			eventAmount.toString() !== expectedAmount.toString()
		) {
			runtime.log(`${eventName} event fields do not match the current reservation; refusing to evaluate COMMIT`)
			return 'REJECT'
		}
	}
	if (
		paymentRead.terms.paymentContract.toLowerCase() !== runtime.config.paymentContractAddress.toLowerCase() ||
		paymentRead.terms.paymentInputToken.toLowerCase() !== runtime.config.paymentTokenAddress.toLowerCase() ||
		paymentRead.terms.paymentToken.toLowerCase() !== runtime.config.paymentTokenAddress.toLowerCase() ||
		paymentRead.terms.assetToken.toLowerCase() !== runtime.config.assetTokenAddress.toLowerCase() ||
		paymentRead.terms.assetSettlement.toLowerCase() !== runtime.config.assetContractAddress.toLowerCase()
	) {
		runtime.log('Registered contract or token addresses do not match the active execution configuration')
		return 'REJECT'
	}
	if (
		asset.status !== 'NONE' &&
		(!sameProtocolTerms(paymentRead.terms, assetRead.terms) ||
			payment.termsHash.toLowerCase() !== asset.termsHash.toLowerCase())
	) {
		runtime.log('Chain A and Chain B registered terms do not match; refusing to evaluate COMMIT')
		return 'REJECT'
	}
	if (decision.decision !== 'UNDECIDED') {
		return onDecisionRecorded(runtime, null, transactionId)
	}
	const sourceTerms = paymentRead.terms
	const terms: ExpectedTerms = {
		transactionId: sourceTerms.transactionId,
		termsHash: payment.termsHash,
		buyer: sourceTerms.buyer,
		seller: sourceTerms.seller,
		paymentChainId: sourceTerms.paymentChainId.toString(),
		paymentContract: sourceTerms.paymentContract,
		paymentToken: sourceTerms.paymentToken,
		paymentAmount: sourceTerms.paymentAmount.toString(),
		assetChainId: sourceTerms.assetChainId.toString(),
		assetContract: sourceTerms.assetSettlement,
		assetToken: sourceTerms.assetToken,
		assetAmount: sourceTerms.assetAmount.toString(),
		assetObligationId: asset.obligationId,
		expiresAt: sourceTerms.expiresAt.toString(),
	}

	const readiness = evaluateReservationReadiness(
		payment,
		asset,
		terms,
		Math.floor(runtime.now().getTime() / 1000).toString(),
		decision,
	)
	runtime.log(`Reservation evaluation | transactionId=${transactionId} | action=${readiness.action}`)
	if ('reason' in readiness) runtime.log(`Reservation evaluation reason: ${readiness.reason}`)
	if (readiness.action === 'SUBMIT_COMMIT') {
		runtime.log('Both matching reservations are locked and unexpired; COMMIT is eligible for Chain A contract validation')
		const submissionPath = selectSubmissionPath({
			executionMode: runtime.config.executionMode,
			allowLocalBroadcast: runtime.config.localBroadcastEnabled,
			enableProductionWrites: runtime.config.productionWritesEnabled,
		})
		const reportPayload = encodeCoordinationReport({
				transactionId: sourceTerms.transactionId,
				termsHash: payment.termsHash as Hex,
				paymentChainId: sourceTerms.paymentChainId,
				paymentContract: sourceTerms.paymentContract,
				assetChainId: sourceTerms.assetChainId,
				assetSettlement: sourceTerms.assetSettlement,
				buyer: sourceTerms.buyer,
				seller: sourceTerms.seller,
				paymentInputToken: sourceTerms.paymentInputToken,
				paymentInputAmount: sourceTerms.paymentInputAmount,
				paymentToken: sourceTerms.paymentToken,
				paymentAmount: sourceTerms.paymentAmount,
				assetToken: sourceTerms.assetToken,
				assetAmount: sourceTerms.assetAmount,
				expiresAt: sourceTerms.expiresAt,
				paymentLocked: true,
				assetLocked: true,
			})
		runtime.log(`COMMIT report fields | transactionId=${transactionId} | termsHash=${payment.termsHash} | sourceBlock=${sourceBlockNumber ?? 'finalized-state (manual reconciliation)'} | paymentChainId=${sourceTerms.paymentChainId} | paymentContract=${sourceTerms.paymentContract} | assetChainId=${sourceTerms.assetChainId} | assetSettlement=${sourceTerms.assetSettlement} | buyer=${sourceTerms.buyer} | seller=${sourceTerms.seller} | paymentInputToken=${sourceTerms.paymentInputToken} | paymentInputAmount=${sourceTerms.paymentInputAmount} | paymentToken=${sourceTerms.paymentToken} | paymentAmount=${sourceTerms.paymentAmount} | assetToken=${sourceTerms.assetToken} | assetAmount=${sourceTerms.assetAmount} | expiresAt=${sourceTerms.expiresAt} | paymentLocked=true | assetLocked=true | payload=${reportPayload}`)
		if (submissionPath === 'production-cre-forwarder') {
			assertReceiverForwarder(runtime, 'ethereum-testnet-sepolia', terms.paymentContract as Address, runtime.config.paymentForwarderAddress as Address)
			const result = writeCreReport(runtime, 'ethereum-testnet-sepolia', terms.paymentContract as Address, reportPayload)
			if (result.receiverExecution !== 'SUCCESS') throw new Error(`Chain A receiver execution was ${result.receiverExecution}`)
			verifyCommitAfterWrite(runtime, transactionId, payment.termsHash as Hex)
			runtime.log(`Chain A production CRE report | receiver=${terms.paymentContract} | txHash=${result.txHash ?? 'unavailable'}`)
		} else if (submissionPath === 'local-mock-forwarder') {
			assertReceiverForwarder(runtime, 'ethereum-testnet-sepolia', terms.paymentContract as Address, runtime.config.paymentForwarderAddress as Address)
			runtime.log(`LOCAL SIMULATION EVM WRITE | configuredSubmitter=${runtime.config.localSubmitterAddress} | mockForwarder=${runtime.config.paymentForwarderAddress} | testReceiver=${terms.paymentContract} | CLI --broadcast required for a real transaction`)
			const result = writeCreReport(runtime, 'ethereum-testnet-sepolia', terms.paymentContract as Address, reportPayload)
			if (result.receiverExecution !== 'SUCCESS') throw new Error(`Local Chain A receiver execution was ${result.receiverExecution}`)
			verifyCommitAfterWrite(runtime, transactionId, payment.termsHash as Hex)
			runtime.log(`Local Chain A simulation write result | txHash=${result.txHash ?? 'unavailable'} | receiverExecution=${result.receiverExecution} | verify explorer and state before claiming broadcast`)
		} else {
			runtime.log(`Report prepared; submission disabled | executionMode=${runtime.config.executionMode} | receiver=${terms.paymentContract} | payload=${reportPayload}`)
		}
	}

	return readiness.action
}

const handleLockEvent = (
	eventName: LockEventName,
	chainName: string,
	expectedContract: string,
	runtime: Runtime<Config>,
	log: EVMLog,
): string => {
	if (log.removed) {
		runtime.log(`Ignoring removed ${eventName} log from ${chainName}`)
		return 'ignored-reorg-removed-log'
	}

	const emittingContract = bytesToHex(log.address)
	if (emittingContract.toLowerCase() !== expectedContract.toLowerCase()) {
		throw new Error(`${eventName} trigger came from an unexpected contract on ${chainName}`)
	}

	const topics = log.topics.map((topic) => bytesToHex(topic))
	const eventTopic = eventName === 'PaymentLocked' ? PAYMENT_LOCKED_TOPIC : ASSET_LOCKED_TOPIC
	if (topics[0]?.toLowerCase() !== eventTopic.toLowerCase()) {
		throw new Error(`${eventName} trigger has an unexpected event signature`)
	}

	let transactionId: Hex
	let termsHash: Hex
	let eventParticipant: Address
	let eventAmount: bigint
	if (eventName === 'PaymentLocked') {
		const decoded = decodeEventLog({
			abi: PAYMENT_LOCKED_ABI,
			data: bytesToHex(log.data),
			topics: topics as [Hex, ...Hex[]],
		})
		transactionId = decoded.args.transactionId
		termsHash = decoded.args.termsHash
		eventParticipant = decoded.args.payer
		eventAmount = decoded.args.amount
	} else {
		const decoded = decodeEventLog({
			abi: ASSET_LOCKED_ABI,
			data: bytesToHex(log.data),
			topics: topics as [Hex, ...Hex[]],
		})
		transactionId = decoded.args.transactionId
		termsHash = decoded.args.termsHash
		eventParticipant = decoded.args.seller
		eventAmount = decoded.args.amount
	}
	if (!transactionId || !termsHash) {
		throw new Error(`${eventName} log is missing transaction binding fields`)
	}

	if (!log.blockNumber) throw new Error(`${eventName} trigger is missing its source block number`)
	const sourceBlockNumber = protoBigIntToBigint(log.blockNumber).toString()
	const deploymentBlock = eventName === 'PaymentLocked' ? runtime.config.paymentDeploymentBlock : runtime.config.assetDeploymentBlock
	if (BigInt(sourceBlockNumber) < BigInt(deploymentBlock)) throw new Error(`${eventName} source block predates configured deployment block`)
	const { chainSelector } = getEvmClient(chainName)
	runtime.log(
		`${eventName} observed | source=${chainName} | chainSelector=${chainSelector} | contract=${emittingContract} | transactionId=${transactionId} | termsHash=${termsHash} | txHash=${bytesToHex(log.txHash)} | block=${sourceBlockNumber}`,
	)
	return evaluateLockState(
		runtime,
		transactionId,
		termsHash,
		eventName,
		eventParticipant,
		eventAmount,
		sourceBlockNumber,
	)
}

const onPaymentLocked = (runtime: Runtime<Config>, log: EVMLog): string =>
	handleLockEvent(
		'PaymentLocked',
		'ethereum-testnet-sepolia',
		runtime.config.paymentContractAddress,
		runtime,
		log,
	)

const onAssetLocked = (runtime: Runtime<Config>, log: EVMLog): string =>
	handleLockEvent(
		'AssetLocked',
		'ethereum-testnet-sepolia-base-1',
		runtime.config.assetContractAddress,
		runtime,
		log,
	)

const onDecisionRecorded = (runtime: Runtime<Config>, log: EVMLog | null, reconcileId?: Hex): string => {
	let transactionId: Hex
	let termsHash: Hex
	let eventDecision: number | undefined
	if (log) {
		if (log.removed) {
			runtime.log('Ignoring removed DecisionRecorded log on Ethereum Sepolia')
			return 'ignored-reorg-removed-log'
		}
		const emittingContract = bytesToHex(log.address)
		if (emittingContract.toLowerCase() !== runtime.config.paymentContractAddress.toLowerCase()) {
			throw new Error('DecisionRecorded trigger came from an unexpected Chain A contract')
		}
		const topics = log.topics.map((topic) => bytesToHex(topic))
		if (topics[0]?.toLowerCase() !== DECISION_RECORDED_TOPIC.toLowerCase()) {
			throw new Error('DecisionRecorded trigger has an unexpected event signature')
		}
		const decoded = decodeEventLog({
			abi: DECISION_RECORDED_ABI,
			data: bytesToHex(log.data),
			topics: topics as [Hex, ...Hex[]],
		})
		transactionId = decoded.args.transactionId
		termsHash = decoded.args.termsHash
		eventDecision = decoded.args.decision
	} else {
		if (!reconcileId) throw new Error('Reconciliation requires a transactionId')
		transactionId = reconcileId
		termsHash = readAuthoritativeDecision(runtime, transactionId, true).termsHash
	}
	const decision = readAuthoritativeDecision(runtime, transactionId, true)
	if (eventDecision !== undefined && decision.decision !== decodeDecision(eventDecision)) {
		throw new Error('Finalized decision state does not match the DecisionRecorded event')
	}
	const binding = {
		transactionId,
		termsHash,
		paymentChainId: PAYMENT_CHAIN_ID,
		paymentContract: runtime.config.paymentContractAddress,
	}
	const relay = evaluateDecisionRelay(decision, binding, ASSET_CHAIN_ID, runtime.config.assetContractAddress)
	if (relay.action === 'REJECT') throw new Error(relay.reason)
	if (relay.action === 'WAIT_FOR_DECISION') return relay.action
	if (
		log && (!log.blockNumber || protoBigIntToBigint(log.blockNumber).toString() !== decision.sourceDecisionBlockNumber)
	) {
		throw new Error('Finalized decision getter does not identify the triggering event block')
	}
	if (decision.decisionNonce !== '1' || decision.recordId.toLowerCase() === ZERO_BYTES32) {
		throw new Error('Finalized decision record has an invalid nonce or record ID')
	}
	const paymentRead = readPaymentReservation(runtime, transactionId, true)
	const assetRead = readAssetReservation(runtime, transactionId, true)
	if (
		paymentRead.terms.transactionId.toLowerCase() !== transactionId.toLowerCase() ||
		paymentRead.reservation.termsHash.toLowerCase() !== termsHash.toLowerCase()
	) {
		throw new Error('Finalized Chain A transaction does not match the DecisionRecorded event')
	}
	if (assetRead.reservation.status === 'NONE' && decision.decision === 'ABORT') {
		runtime.log('No Chain B asset reservation exists; there is no asset report to relay')
		return 'NO_ASSET_RESERVATION'
	}
	if (
		paymentRead.terms.paymentContract.toLowerCase() !== runtime.config.paymentContractAddress.toLowerCase() ||
		paymentRead.terms.paymentInputToken.toLowerCase() !== runtime.config.paymentTokenAddress.toLowerCase() ||
		paymentRead.terms.paymentToken.toLowerCase() !== runtime.config.paymentTokenAddress.toLowerCase() ||
		paymentRead.terms.assetSettlement.toLowerCase() !== runtime.config.assetContractAddress.toLowerCase() ||
		paymentRead.terms.assetToken.toLowerCase() !== runtime.config.assetTokenAddress.toLowerCase()
	) {
		throw new Error('Finalized Chain A terms do not match configured contracts or tokens')
	}
	if (
		assetRead.reservation.status !== 'NONE' &&
		(!sameProtocolTerms(paymentRead.terms, assetRead.terms) ||
			paymentRead.reservation.termsHash.toLowerCase() !== assetRead.reservation.termsHash.toLowerCase() ||
			assetRead.reservation.termsHash.toLowerCase() !== termsHash.toLowerCase())
	) {
		throw new Error('Finalized cross-chain terms do not match the authoritative Chain A decision')
	}
	const relayPlan = planDecisionRelay(decision, binding, ASSET_CHAIN_ID, runtime.config.assetContractAddress, assetRead.reservation)
	if (relayPlan.action === 'REJECT') throw new Error(relayPlan.reason)
	if (relayPlan.action === 'NO_ASSET_RESERVATION') return relayPlan.action
	if (relayPlan.action === 'RELAY_ALREADY_APPLIED') {
		runtime.log('Chain B already contains this finalized decision record; skipping duplicate report')
		return relayPlan.action
	}
	runtime.log(`Finalized Chain A decision observed | source=${log ? 'DecisionRecorded event' : 'manual reconciliation'} | transactionId=${transactionId} | termsHash=${termsHash} | decision=${decision.decision} | sourceBlock=${decision.sourceDecisionBlockNumber} | relay=${relay.action} | txHash=${log ? bytesToHex(log.txHash) : 'n/a'}`)
	if ('reason' in relay) runtime.log(`Decision relay reason: ${relay.reason}`)
	if (relayPlan.action === 'RELAY_COMMIT' || relayPlan.action === 'RELAY_ABORT') {
		const submissionPath = selectSubmissionPath({
			executionMode: runtime.config.executionMode,
			allowLocalBroadcast: runtime.config.localBroadcastEnabled,
			enableProductionWrites: runtime.config.productionWritesEnabled,
		})
		const sourceTerms = assetRead.terms
		const reportPayload = encodeDecisionRelayReport({
				transactionId: decision.transactionId as Hex,
				termsHash: decision.termsHash as Hex,
				decision: decision.decision === 'COMMIT' ? 1 : 2,
				sourceChainId: BigInt(decision.sourceChainId),
				sourceContract: decision.sourceContract as Address,
				destinationChainId: BigInt(decision.destinationChainId),
				destinationContract: decision.destinationContract as Address,
				assetObligationId: assetRead.reservation.obligationId as Hex,
				decisionRecordId: decision.recordId as Hex,
				decisionNonce: BigInt(decision.decisionNonce),
				sourceDecisionBlockNumber: BigInt(decision.sourceDecisionBlockNumber),
				buyer: sourceTerms.buyer,
				seller: sourceTerms.seller,
				assetToken: sourceTerms.assetToken,
				assetAmount: sourceTerms.assetAmount,
				expiresAt: sourceTerms.expiresAt,
			})
		runtime.log(`${decision.decision} relay report fields | transactionId=${transactionId} | termsHash=${termsHash} | decision=${decision.decision} | sourceChainId=${decision.sourceChainId} | sourceContract=${decision.sourceContract} | destinationChainId=${decision.destinationChainId} | destinationContract=${decision.destinationContract} | assetObligationId=${assetRead.reservation.obligationId} | decisionRecordId=${decision.recordId} | decisionNonce=${decision.decisionNonce} | sourceDecisionBlock=${decision.sourceDecisionBlockNumber} | buyer=${sourceTerms.buyer} | seller=${sourceTerms.seller} | assetToken=${sourceTerms.assetToken} | assetAmount=${sourceTerms.assetAmount} | expiresAt=${sourceTerms.expiresAt} | payload=${reportPayload}`)
		if (submissionPath === 'production-cre-forwarder') {
			assertReceiverForwarder(runtime, 'ethereum-testnet-sepolia-base-1', decision.destinationContract as Address, runtime.config.assetForwarderAddress as Address)
			const result = writeCreReport(runtime, 'ethereum-testnet-sepolia-base-1', decision.destinationContract as Address, reportPayload)
			if (result.receiverExecution !== 'SUCCESS') throw new Error(`Chain B receiver execution was ${result.receiverExecution}`)
			verifyRelayAfterWrite(runtime, transactionId, decision.decision, decision.recordId as Hex)
			runtime.log(`Chain B production CRE report | receiver=${decision.destinationContract} | txHash=${result.txHash ?? 'unavailable'}`)
		} else if (submissionPath === 'local-mock-forwarder') {
			assertReceiverForwarder(runtime, 'ethereum-testnet-sepolia-base-1', decision.destinationContract as Address, runtime.config.assetForwarderAddress as Address)
			runtime.log(`LOCAL SIMULATION EVM WRITE | configuredSubmitter=${runtime.config.localSubmitterAddress} | mockForwarder=${runtime.config.assetForwarderAddress} | testReceiver=${decision.destinationContract} | CLI --broadcast required for a real transaction`)
			const result = writeCreReport(runtime, 'ethereum-testnet-sepolia-base-1', decision.destinationContract as Address, reportPayload)
			if (result.receiverExecution !== 'SUCCESS') throw new Error(`Local Chain B receiver execution was ${result.receiverExecution}`)
			verifyRelayAfterWrite(runtime, transactionId, decision.decision, decision.recordId as Hex)
			runtime.log(`Local Chain B simulation write result | txHash=${result.txHash ?? 'unavailable'} | receiverExecution=${result.receiverExecution} | verify explorer and state before claiming broadcast`)
		} else {
			runtime.log(`Relay report prepared; submission disabled | executionMode=${runtime.config.executionMode} | receiver=${decision.destinationContract} | payload=${reportPayload}`)
		}
	}
	return relay.action
}

const reconciliationInputSchema = z.object({
	transactionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'transactionId must be bytes32'),
})

const onReconcile = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	const { transactionId } = reconciliationInputSchema.parse(decodeJson(payload.input))
	const id = transactionId as Hex
	const paymentRead = readPaymentReservation(runtime, id, true)
	const assetRead = readAssetReservation(runtime, id, true)
	const decision = readAuthoritativeDecision(runtime, id, true)
	if (paymentRead.terms.transactionId.toLowerCase() !== id.toLowerCase() ||
		paymentRead.terms.paymentContract.toLowerCase() !== runtime.config.paymentContractAddress.toLowerCase() ||
		paymentRead.terms.paymentToken.toLowerCase() !== runtime.config.paymentTokenAddress.toLowerCase() ||
		paymentRead.terms.assetSettlement.toLowerCase() !== runtime.config.assetContractAddress.toLowerCase() ||
		paymentRead.terms.assetToken.toLowerCase() !== runtime.config.assetTokenAddress.toLowerCase()) {
		throw new Error('Reconciliation source reservation differs from configured chain contracts or tokens')
	}
	if (assetRead.reservation.status !== 'NONE' &&
		(!sameProtocolTerms(paymentRead.terms, assetRead.terms) ||
			paymentRead.reservation.termsHash.toLowerCase() !== assetRead.reservation.termsHash.toLowerCase())) {
		throw new Error('Reconciliation found mismatched terms or terms hashes across chains')
	}
	if (assetRead.reservation.status !== 'NONE' &&
		(BigInt(assetRead.reservation.obligationId) === 0n || assetRead.terms.assetToken.toLowerCase() !== runtime.config.assetTokenAddress.toLowerCase())) {
		throw new Error('Reconciliation found a malformed asset obligation or token binding')
	}
	runtime.log(`Manual reconciliation | transactionId=${id} | termsHash=${paymentRead.reservation.termsHash} | sourceDecision=${decision.decision} | sourceBlock=${decision.sourceDecisionBlockNumber} | paymentDeploymentBlock=${runtime.config.paymentDeploymentBlock} | assetDeploymentBlock=${runtime.config.assetDeploymentBlock}`)
	if (decision.decision !== 'UNDECIDED') {
		return onDecisionRecorded(runtime, null, id)
	}
	return evaluateLockState(runtime, id, paymentRead.reservation.termsHash as Hex)
}

export function initWorkflow(config: Config) {
	const paymentEvm = getEvmClient('ethereum-testnet-sepolia').client
	const assetEvm = getEvmClient('ethereum-testnet-sepolia-base-1').client
	const http = new cre.capabilities.HTTPCapability()

	return [
		cre.handler(
			paymentEvm.logTrigger(
				logTriggerConfig({
					addresses: [config.paymentContractAddress as Address],
					topics: [[PAYMENT_LOCKED_TOPIC]],
					confidence: 'FINALIZED',
				}),
			),
			onPaymentLocked,
		),
		cre.handler(
			assetEvm.logTrigger(
				logTriggerConfig({
					addresses: [config.assetContractAddress as Address],
					topics: [[ASSET_LOCKED_TOPIC]],
					confidence: 'FINALIZED',
				}),
			),
			onAssetLocked,
		),
		cre.handler(
			paymentEvm.logTrigger(
				logTriggerConfig({
					addresses: [config.paymentContractAddress as Address],
					topics: [[DECISION_RECORDED_TOPIC]],
					confidence: 'FINALIZED',
				}),
			),
			onDecisionRecorded,
		),
		cre.handler(
			http.trigger({
				authorizedKeys: config.executionMode === 'production-cre'
					? [{ type: 'KEY_TYPE_ECDSA_EVM', publicKey: config.reconciliationAuthorizedAddress! }]
					: [],
			}),
			onReconcile,
		),
	]
}

export { writeCreReport } from './report-write'
